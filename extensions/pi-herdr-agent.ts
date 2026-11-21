/**
 * pi-herdr-agent —— 用 herdr-core（hc）的终端树跑子 agent
 *
 * 每个 agent 都是 headless hc 终端里的一个交互式 pi：树由 hc 的 `parent` 表达，
 * herdr-app 会把它挂在父 tab 下面当 sub-agent 显示（`agent.focus` 可临时给它一个 pane）。
 * 终端以 `rm: true` 启动：pi 一退出（正常退出 / kill / 崩溃），hc 立刻把终端删掉。
 *
 * 身份：
 * - 子 agent 的 id 是拉起时生成的 6 位十六进制短码（如 `a7k2f9`），跨 resume 不变；pi 会话 id 由它
 *   **推导**成 `pi-a7k2f9`（`--session-id`），resume 时按 id 找 `_pi-a7k2f9.jsonl` 重新拉起，
 *   不需要任何登记表。
 * - 根 agent（人直接启动的 pi）没有 env 注入：id 取自己会话 id 末尾的 6 位（uuidv7 尾段的随机 hex），
 *   并写进自己终端的 `pi.agent.root` label 供其它 agent 在 `terminal.list` 里认出来；
 *   `/new`、`/resume`、`/fork` 后会话 id 变了就重写 label。label 写不进去时退回 hc 地址。
 * - `name` 是 hc 终端名（herdr-app 侧边栏显示的那个），创建时固定，只作显示；寻址一律用 id。
 * - 拉起时注入 `PI_AGENT_ID` / `PI_AGENT_NAME` / `PI_AGENT_PARENT` / `PI_AGENT_ROOT` /
 *   `PI_AGENT_DEPTH`，子进程的扩展据此知道自己是谁、在树里的哪一层；另外注入
 *   `PI_AGENT_DESTROY_AFTER`（空闲销毁秒数，0 = 不销毁）。
 *
 * 消息（派发规则）：
 * - `agent_job ask` 不检查对方状态：忙就排队或插入，闲就起一轮。
 * - 一轮（round）只有一个「派活人」= 叫醒它的那条消息的发送方。收到消息时：
 *   - 我空闲：开一轮，派活人 = 发送方。
 *   - 我忙、发送方就是派活人：直接插进当前轮（pi 原生 steer）。
 *   - 我忙、发送方是别人：吞掉，不进上下文，按发送方排队。
 *   - 收到自动回发（首行带 result）：不排队、不回发，直接投递。
 * - 收工时扩展自动把本轮最后一段回答发回给派活人，不依赖模型调工具。
 *   只有 `ask` 起的轮次回发；回发本身、人打字、被中止的轮次都不回发。
 * - 队列按发送方聚合：同一个发送方最多一条，新消息并进他那条，位置不变。
 * - 首行 `<agent id "name">` / `<agent id "name" result>` 由扩展生成，模型可见。
 * - 结果正文超过 2000 行 / 50 KB 时按 bash 工具同款方式尾部截断，全文落临时文件。
 * - 拉起时 `no_notify: true`：hc 自己的 note 不参与语义。
 *
 * 生命周期：`session_shutdown(reason=quit)` 时杀掉自己的直接子 agent（递归由各自的
 * shutdown 完成）。子终端的程序就是 pi 本身，所以子进程硬死时 hc 原生级联会接管；
 * 只有 root 那层（前台是 shell）需要显式处理。
 *
 * 空闲销毁：子 agent 在 settle 之后进入倒计时（`destroyAfterSeconds`，默认 180 秒，
 * 0 = 永不），满钟后自己 `ctx.shutdown()`，pi 退出即由 hc 删掉终端；会话文件仍在磁盘上，
 * 可以按 id resume 回来。倒计时只在「安静」时走：还有活的子终端、后台任务、进程内
 * 子 agent 或 cron job 就不计时（后两者经 lib/activity.ts 的忙探测登记表汇总），任何新
 * 入站都立即清零。30 秒一拍检查，销毁最多迟到一拍。
 *
 * 状态：pi 内置 reporter 在 settle 时硬写 OSC 7501 `state=done`；子 agent 在 stdout 层
 * 把这条报告改写成 `state=idle`，所以 hc 只看到 working → idle，不会留下 done。
 * 根 agent（没有 `PI_AGENT_ID`）保持 pi 原生行为。
 *
 * 人工入口：`/agent list` 把当前 agent 树渲染成卡片式森林（● 自己、↑ 父 agent、
 * 失联单独标注）；`/agent list-all` 连同当前 hc session 里其它独立的树一起显示。
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	formatAgentEnvelope,
	parseAgentEnvelope,
	stripHcTransport,
	truncateTail,
	validateAgentName,
	type AgentEnvelope,
} from "./lib/agent-protocol.ts";
import { hasBusyActivity } from "./lib/activity.ts";
import { errorMessage } from "./lib/errors.ts";
import { ERROR_PREFIX, piHerdrAgentPrompt } from "./prompt/pi-herdr-agent.ts";
import {
	createHcClient,
	HcError,
	inHcEnv,
	type HcClient,
	type HcTerminal,
	type HcWaitResult,
} from "./lib/hc.ts";
import { writeOutputFile } from "./lib/output-file.ts";
import { hasRunningSubagents } from "./lib/subagents.ts";
import { basename } from "./lib/text.ts";

// ─── 常量 ───

/** 树深上限：root(0) → 子(1) → 孙(2)，共三层。深度 2 的 agent 不再注册 `agent`。 */
const MAX_DEPTH = 2;

/** 子 pi 就绪等待：一轮 60s，最多两轮。 */
const READY_TIMEOUT_S = 60;

/** 空闲销毁的默认时长（秒）。 */
const DEFAULT_DESTROY_AFTER_S = 180;

/** 空闲销毁的检查节拍（秒）：销毁最多迟到一拍。 */
const DESTROY_TICK_S = 30;

/** `stop` 先请对方自己退出，每次按键宽限这么多秒；不走再硬杀。 */
const STOP_GRACE_S = 5;

/** `stop` 等对方退出的轮询间隔。 */
const STOP_POLL_MS = 250;

/** 子进程从 env 读自己的空闲销毁秒数；0 或缺省表示不销毁。 */
const DESTROY_ENV = "PI_AGENT_DESTROY_AFTER";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// ─── 类型 ───

/** 对端 agent：发送方与派活人都用它。 */
interface Peer {
	id: string;
	name?: string;
}

/** 排队里的一条：同一个发送方只有一条，`parts` 按到达顺序拼接。 */
interface QueuedMessage {
	peer: Peer;
	parts: string[];
}

export interface AgentRow {
	id: string;
	name: string;
	relation: "self" | "parent" | "child" | "sibling" | "other";
	status: string;
	parent: string | null;
	depth: number;
	cwd: string;
	orphan: boolean;
}

/** 树的一行分两段：左侧树内容与右侧右对齐的状态。 */
export interface TreeSegment {
	text: string;
	tone?: ThemeColor;
}

export interface TreeLine {
	left: TreeSegment[];
	right: TreeSegment[];
}

interface AgentParams {
	prompt: string;
	name?: string;
	model?: string;
	thinking?: (typeof THINKING_LEVELS)[number];
	resume?: string;
	destroyAfterSeconds?: number;
}

interface AgentJobParams {
	action: "list" | "ask" | "stop";
	id?: string;
	message?: string;
}

interface SessionFacts {
	cwd: string;
	name?: string;
	provider?: string;
	modelId?: string;
	thinking?: string;
}

/** 结构化 details 只记动作与结果，方便 UI 与测试断言。 */
interface AgentToolDetails {
	action?: "start" | "resume" | "list" | "stop" | "ask";
	id?: string;
	name?: string;
	error?: string;
	agents?: AgentRow[];
}

/** 测试注入点：真扩展由 pi 用单个参数调用，额外参数只给测试用。 */
export interface HerdrAgentOptions {
	hc?: HcClient;
	env?: NodeJS.ProcessEnv;
	/** 会话目录覆盖（测试用）。 */
	sessionDir?: string;
	/** 超长结果全文落地（测试可替换）；默认写系统临时目录。 */
	spill?: (text: string) => Promise<string>;
	/** 空闲销毁的时钟（测试可替换）；默认 Date.now。 */
	now?: () => number;
	/** `stop` 每次按键的宽限（毫秒，测试可缩短）；默认 STOP_GRACE_S 秒。 */
	stopGraceMs?: number;
	/** 空闲销毁的调度：每 ms 毫秒回调一次、返回取消函数；默认 setInterval。 */
	schedule?: (tick: () => void, ms: number) => () => void;
}

// ─── 扩展入口 ───

export default function piHerdrAgent(pi: ExtensionAPI, options: HerdrAgentOptions = {}): void {
	const env = options.env ?? process.env;
	// 只工作在 herdr app + hc 环境：地址与 socket 都由 hc 注入，缺一不注册。
	if (!inHcEnv(env)) return;

	// 子 agent 的 done 状态在 stdout 层改写成 idle（pi 没有给扩展留 settle 状态钩子）。
	patchSettledStatus(env);

	const self = env.HC_TERMINAL_ID!.trim();
	const hc = options.hc ?? createHcClient(env.HC_TERMINAL_SOCKET!.trim());
	// 根 agent 的 id 要等 session_start 读到会话 id 才能定（见 syncRootId），先拿地址兑底。
	const injectedId = env.PI_AGENT_ID?.trim();
	let myId = injectedId || self;
	let myRoot = env.PI_AGENT_ROOT?.trim() || myId;
	const myDepth = Number.parseInt(env.PI_AGENT_DEPTH ?? "0", 10) || 0;
	// 空闲销毁：根 agent 没有这个 env（0 = 不销毁），子 agent 的秒数由拉起者按参数注入。
	const destroyAfterSeconds = parseDestroyAfter(env[DESTROY_ENV]);
	const now = options.now ?? (() => Date.now());
	const schedule = options.schedule ?? defaultSchedule;
	/** `stop` 每次按键后的宽限；测试可缩短。 */
	const stopGraceMs = options.stopGraceMs ?? STOP_GRACE_S * 1000;

	/**
	 * 根 agent 的短 id：会话 id 末尾 6 位字母数字（uuidv7 的尾段就是随机 hex；
	 * 自定义 `--session-id` 里的 `-` `_` `.` 先压掉）。
	 */
	const syncRootId = async (ctx: ExtensionContext): Promise<void> => {
		if (injectedId) return;
		const id = rootIdOf(ctx.sessionManager.getSessionId());
		if (!id || id === myId) return;
		// 先写 label 再切 id：写不进去就继续用 hc 地址，保持“树里能看到的就是我的 id”。
		try {
			await hc.label({ terminal: self, labels: { "pi.agent.root": id } });
			myId = id;
			myRoot = id;
		} catch {
			// 旧 core / 权限问题：维持地址式 id，不打断会话。
		}
	};

	/**
	 * 队列模式非 all 时，派活人的插话与自动回发会被 pi 逐条延后；只在本次进程启动时提醒一次。
	 * 设置项在 /settings 里叫 Steering mode 与 Follow-up mode；`all` 是当前扩展期望的值。
	 * 未设置（undefined）不提醒：那是 pi 的默认值，提醒会变成每次启动都喷。
	 */
	let queueModesChecked = false;
	const warnIfQueueModesAreNotAll = (ctx: ExtensionContext): void => {
		if (queueModesChecked) return;
		queueModesChecked = true;

		let settings: { steeringMode?: string; followUpMode?: string };
		try {
			settings = pi.getSettings();
		} catch {
			return; // 旧 pi 没有 getSettings：不打断启动。
		}
		const oneAtATime = [
			settings.steeringMode === "one-at-a-time" ? "steeringMode" : undefined,
			settings.followUpMode === "one-at-a-time" ? "followUpMode" : undefined,
		].filter((name): name is string => Boolean(name));
		if (oneAtATime.length === 0) return;

		ctx.ui.notify(
			`${oneAtATime.join(" / ")} 当前为 one-at-a-time，需改为 all；否则派活人的插话与自动回发会被逐条延后。可以在 /settings 里修改。`,
			"warning",
		);
	};

	pi.on("session_start", async (_event, ctx) => {
		await syncRootId(ctx);
		warnIfQueueModesAreNotAll(ctx);
	});

	// 每轮的状态：派活人与队列只在内存里（label 不承担可变语义）。
	/** 本轮派活人；收工时清空，新的普通消息重新指定。 */
	let owner: Peer | undefined;
	/** 是否有轮次正在跑。`streamingBehavior` 只作交叉校验，这里才是准的。 */
	let busy = false;
	/** 收工处理进行中（里面有 await）；这段时间也算忙。 */
	let settling = false;
	let lastAnswer: string | undefined;
	let blockedNotified = false;

	/**
	 * 排队：key = 发送方 id，Map 的插入顺序就是队列顺序。
	 * 同一个发送方最多一条 —— 已有 key 再 set 不改变位置，正好对上「合并但保留原位」。
	 */
	const queue = new Map<string, QueuedMessage>();

	/** 显示名：子 agent 用注入的 env，根用会话名。只用于消息首行。 */
	const displayName = (ctx?: ExtensionContext): string | undefined => {
		const fromEnv = env.PI_AGENT_NAME?.trim();
		if (fromEnv) return fromEnv;
		return ctx?.sessionManager.getSessionName()?.trim() || undefined;
	};

	// ─── 界面记录（TUI 可见，不进模型上下文） ───

	const NOTE_ENTRY = "pi-herdr-agent:note";
	const QUEUE_ENTRY = "pi-herdr-agent:queued";

	pi.registerEntryRenderer<{ text: string }>(NOTE_ENTRY, (entry, _options, theme) => {
		const box = new Box(0, 1);
		box.addChild(new Text(theme.fg("muted", entry.data?.text ?? ""), 0, 0));
		return box;
	});

	pi.registerEntryRenderer<{ from: string; name?: string; body: string }>(QUEUE_ENTRY, (entry, _options, theme) => {
		const box = new Box(0, 1);
		const who = entry.data?.name ? `${entry.data.from} "${entry.data.name}"` : entry.data?.from;
		const head = theme.fg("warning", `⏸ ${who ?? "?"} · queued`);
		const first = (entry.data?.body ?? "").split("\n")[0].slice(0, 80);
		box.addChild(new Text(first ? `${head}  ${theme.fg("dim", first)}` : head, 0, 0));
		return box;
	});

	/** 界面记一行。失败不影响主流程。 */
	const appendNote = (text: string): void => {
		try {
			pi.appendEntry(NOTE_ENTRY, { text });
		} catch {
			// 界面记录是尽力而为。
		}
	};

	const enqueue = (envelope: AgentEnvelope): void => {
		const existing = queue.get(envelope.from);
		if (existing) {
			existing.parts.push(envelope.body);
		} else {
			queue.set(envelope.from, { peer: { id: envelope.from, name: envelope.name }, parts: [envelope.body] });
		}
		try {
			pi.appendEntry(QUEUE_ENTRY, { from: envelope.from, name: envelope.name, body: envelope.body });
		} catch {
			// 同上。
		}
	};

	/** 取队首；取出来的同时从队列里移除。 */
	const takeNext = (): { id: string; peer: Peer; parts: string[] } | undefined => {
		const first = queue.entries().next();
		if (first.done) return undefined;
		const [id, entry] = first.value;
		queue.delete(id);
		return { id, peer: entry.peer, parts: entry.parts };
	};

	/** 起队首失败时放回队首，位置不丢。 */
	const putBackFront = (id: string, peer: Peer, parts: string[]): void => {
		const rest = [...queue.entries()];
		queue.clear();
		queue.set(id, { peer, parts });
		for (const [key, value] of rest) queue.set(key, value);
	};

	/** 派活人 id → 当前终端地址；已经不在的返回 undefined。 */
	const addressOf = async (id: string): Promise<string | undefined> => {
		try {
			const terminals = await hc.list();
			return terminals.find((terminal) => agentIdOf(terminal) === id && terminal.state === "live")?.address;
		} catch {
			return undefined;
		}
	};

	/**
	 * 自动回发一条结果。对方已经不在时静默丢弃，并在自己界面上记一行：
	 * 重试没有意义，那是死信箱。
	 */
	const sendReport = async (target: Peer, ctx: ExtensionContext, body: string): Promise<void> => {
		const address = await addressOf(target.id);
		if (!address) {
			appendNote(`replay to ${target.id} failed: it is gone.`);
			return;
		}

		try {
			await hc.send({
				terminal: address,
				caller: self,
				text: formatAgentEnvelope({ result: true, from: myId, name: displayName(ctx), body }),
			});
		} catch {
			appendNote(`replay to ${target.id} failed: it disappeared.`);
		}
	};

	// ─── 入站消息 ───

	// 有新活就不销毁：不管是 agent 消息还是人直接打字，都发生在 agent_start 之前。
	pi.on("input", (event) => {
		stopDestroyCountdown();

		const envelope = parseAgentEnvelope(event.text);
		if (!envelope) return;

		// 自动回发只是一条答案：空闲就起一轮读它（不回发），忙就直接插进去。
		// 首行留给模型看，只剥掉 hc CLI 的运输层包装。
		if (envelope.result) return { action: "transform" as const, text: stripHcTransport(event.text) };

		const running = busy || settling || event.streamingBehavior !== undefined;

		if (!running) {
			// 空闲：开一轮，派活人 = 发送方。首行留给模型看。
			owner = { id: envelope.from, name: envelope.name };
			lastAnswer = undefined;
			return { action: "transform" as const, text: stripHcTransport(event.text) };
		}

		// 派活人插话：直接插进当前轮（pi 原生 steer）。
		if (owner?.id === envelope.from) {
			return { action: "transform" as const, text: stripHcTransport(event.text) };
		}

		// 别人：吞掉，不进上下文，按发送方排队。
		enqueue(envelope);
		return { action: "handled" as const };
	});

	// ─── 出站结果 ───

	pi.on("agent_end", (event) => {
		const text = lastAssistantText(event.messages);
		if (text !== undefined) lastAnswer = text;
	});

	pi.on("agent_settled", async (event, ctx) => {
		busy = false;
		// 收工处理里有 await（回发要查地址）。这段时间里进来的消息也按「忙」处理，
		// 否则它会把自己当成新一轮的派活人，和下面要起的队首撞车。
		settling = true;
		blockedNotified = false;

		const current = owner;
		owner = undefined;
		const answer = lastAnswer;
		lastAnswer = undefined;

		try {
			// 被中止：只回一句，不附半截回答；队列不动，也不自动开工。
			if (current) {
				const body = event.aborted ? piHerdrAgentPrompt.reports.runAborted() : await resultBody(answer);
				await sendReport(current, ctx, body);
			}

			if (event.aborted) {
				// 队列里还有活就不倒计时：那些任务不能跟着一起消失。
				if (queue.size === 0) await armDestroyCountdown(ctx);
				return;
			}

			const next = takeNext();
			if (next) {
				owner = next.peer;
				lastAnswer = undefined;
				try {
					pi.sendUserMessage(
						formatAgentEnvelope({ from: next.peer.id, name: next.peer.name, body: next.parts.join("\n\n") }),
					);
				} catch (error) {
					putBackFront(next.id, next.peer, next.parts);
					owner = undefined;
					appendNote(`queued message from ${next.id} could not start: ${errorMessage(error)}`);
					return; // 还有活没干成：不进入空闲销毁。
				}
				return; // 新一轮已开始，倒计时由那一轮收工时再武装。
			}

			await armDestroyCountdown(ctx);
		} finally {
			settling = false;
		}
	});

	// 不论因为什么起了一轮（cron 投递、人打字、ask），倒计时都作废。
	pi.on("agent_start", () => {
		busy = true;
		stopDestroyCountdown();
	});

	pi.on("ui_prompt_start", async (event, ctx) => {
		// 弹窗等人回答：这一轮还没结束，先把倒计时停掉（settle 后会重新武装）。
		stopDestroyCountdown();
		if (!owner || blockedNotified) return;
		blockedNotified = true;
		const detail = event.title ? ` (${event.title})` : "";
		await sendReport(owner, ctx, piHerdrAgentPrompt.reports.blocked(detail));
	});

	pi.on("ui_prompt_end", () => {
		blockedNotified = false;
	});

	pi.on("session_shutdown", async (event, ctx) => {
		stopDestroyCountdown();
		// 只有真正退出（quit）才收尸；/reload、/new、/resume、/fork 不动子 agent。
		if (event.reason !== "quit") return;

		// 退出前把「没做完」交代清楚：派活人一条，排队里每人一条。
		const current = owner;
		const queued = [...queue.values()];
		owner = undefined;
		queue.clear();
		if (current) await sendReport(current, ctx, piHerdrAgentPrompt.reports.exitedBeforeAnswering(myId));
		await Promise.allSettled(
			queued.map((entry) =>
				sendReport(entry.peer, ctx, piHerdrAgentPrompt.reports.exitedTaskNotProcessed(myId)),
			),
		);
		try {
			const terminals = await hc.list();
			const children = terminals.filter((terminal) => terminal.parent === self);
			await Promise.allSettled(children.map((terminal) => hc.kill(terminal.address)));
		} catch {
			// 退出路径尽力而为：清理失败不能盖住正常退出。
		}
	});

	// ─── 空闲销毁 ───

	/** 倒计时代数：取消与重开都 +1，让在飞的检查作废。 */
	let destroyGeneration = 0;
	let destroyTimer: (() => void) | undefined;
	let destroyQuietSince: number | undefined;
	let destroyChecking = false;

	/**
	 * 安静 = 本 agent 空闲 + 进程内没有后台任务 / cron job / 进程内子 agent + 没有活的子
	 * 终端。子终端也算：销毁会级联杀掉子 agent，它有活就先让着它（它自己也有同一套规则）。
	 * `hc.list` 失败时不知道有没有子 agent，按「忙」处理。
	 */
	const isQuiet = async (ctx: ExtensionContext): Promise<boolean> => {
		if (!ctx.isIdle()) return false;
		if (queue.size > 0) return false; // 还有排着的话，销毁就等于把它们一起埋了。
		if (hasBusyActivity() || hasRunningSubagents()) return false;
		try {
			const terminals = await hc.list();
			return !terminals.some((terminal) => terminal.parent === self && terminal.state === "live");
		} catch {
			return false;
		}
	};

	const stopDestroyCountdown = (): void => {
		destroyGeneration += 1;
		destroyTimer?.();
		destroyTimer = undefined;
		destroyQuietSince = undefined;
	};

	const checkDestroy = async (generation: number, ctx: ExtensionContext): Promise<void> => {
		if (generation !== destroyGeneration || destroyChecking) return;
		destroyChecking = true;
		try {
			const quiet = await isQuiet(ctx);
			if (generation !== destroyGeneration) return;
			if (!quiet) {
				// 从「忙」回到「安静」的开始时刻才起算：子树 / 任务刚结束还要再等满一整钟。
				destroyQuietSince = undefined;
				return;
			}

			const stamp = now();
			if (destroyQuietSince === undefined) destroyQuietSince = stamp;
			if (stamp - destroyQuietSince < destroyAfterSeconds * 1000) return;

			stopDestroyCountdown();
			ctx.shutdown();
		} finally {
			destroyChecking = false;
		}
	};

	/** settle 之后武装倒计时；根 agent（env 缺省）与 `0` 都不做任何事。 */
	const armDestroyCountdown = async (ctx: ExtensionContext): Promise<void> => {
		if (destroyAfterSeconds <= 0) return;
		stopDestroyCountdown();
		const generation = destroyGeneration;
		destroyQuietSince = (await isQuiet(ctx)) ? now() : undefined;
		// await 期间又 settle / 来了新输入：这一代已经作废。
		if (generation !== destroyGeneration) return;
		destroyTimer = schedule(() => void checkDestroy(generation, ctx), DESTROY_TICK_S * 1000);
	};

	// ─── 结果整形 ───

	const resultBody = async (answer: string | undefined): Promise<string> => {
		const text = answer?.trim();
		if (!text) return piHerdrAgentPrompt.reports.noText();

		const truncation = truncateTail(text);
		if (!truncation.truncated) return text;

		try {
			const path = options.spill ? await options.spill(text) : await writeOutputFile("pi-herdr-agent", ".log", text);
			return `${truncation.text}\n\n${piHerdrAgentPrompt.reports.truncatedWithPath(path)}`;
		} catch (error) {
			return `${truncation.text}\n\n${piHerdrAgentPrompt.reports.truncated(errorMessage(error))}`;
		}
	};

	// ─── 工具：agent ───

	const registerAgentTool = (): void => {
		pi.registerTool({
			name: "agent",
			label: "Agent",
			description: piHerdrAgentPrompt.declarations.agent.description,
			promptSnippet: piHerdrAgentPrompt.system.snippets.agent,
			parameters: Type.Object({
				prompt: Type.String({ description: piHerdrAgentPrompt.declarations.agent.parameters.prompt }),
				name: Type.Optional(Type.String({ description: piHerdrAgentPrompt.declarations.agent.parameters.name })),
				model: Type.Optional(Type.String({ description: piHerdrAgentPrompt.declarations.agent.parameters.model })),
				thinking: Type.Optional(
					StringEnum(THINKING_LEVELS, { description: piHerdrAgentPrompt.declarations.agent.parameters.thinking }),
				),
				resume: Type.Optional(
					Type.String({ description: piHerdrAgentPrompt.declarations.agent.parameters.resume }),
				),
				destroyAfterSeconds: Type.Optional(
					Type.Number({ description: piHerdrAgentPrompt.declarations.agent.parameters.destroyAfterSeconds }),
				),
			}),

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const typed = params as AgentParams;
				try {
					if (typed.resume) return await resumeAgent(typed, ctx);
					return await startAgent(typed, ctx);
				} catch (error) {
					return fail(errorMessage(error), typed.resume ? "resume" : "start", typed.resume);
				}
			},
		});
	};

	const startAgent = async (params: AgentParams, ctx: ExtensionContext) => {
		const terminals = await hc.list();
		const taken = new Set(
			terminals
				.filter((terminal) => terminal.state === "live")
				.map(agentIdOf)
				.filter((id): id is string => Boolean(id)),
		);
		const id = newAgentId(ctx.cwd, taken);
		if (!id) return fail(piHerdrAgentPrompt.results.errors.noId(), "start");

		const name = params.name ?? id;
		const invalidName = validateAgentName(name);
		if (invalidName) return fail(piHerdrAgentPrompt.results.errors.invalidName(name, invalidName), "start", id);

		const model = params.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
		const thinking = params.thinking ?? ctx.thinkingLevel;

		await launch({
			id,
			name,
			cwd: ctx.cwd || process.cwd(),
			model,
			thinking,
			prompt: params.prompt,
			ctx,
			destroyAfterSeconds: normalizeDestroyAfter(params.destroyAfterSeconds),
		});
		return ok(piHerdrAgentPrompt.results.startedAgent(id, name), {
			action: "start",
			id,
			name,
		});
	};

	const resumeAgent = async (params: AgentParams, ctx: ExtensionContext) => {
		const id = params.resume!;
		const terminals = await hc.list();
		if (terminals.some((terminal) => agentIdOf(terminal) === id && terminal.state === "live")) {
			return fail(piHerdrAgentPrompt.results.errors.stillRunning(id), "resume", id);
		}

		const session = await findSession(`pi-${id}`, options.sessionDir);
		if (!session) return fail(piHerdrAgentPrompt.results.errors.noSession(id), "resume", id);

		const facts = readSessionFacts(session.path);
		if (!facts?.cwd) return fail(piHerdrAgentPrompt.results.errors.noSessionCwd(id), "resume", id);

		// resume 不允许换脑：缓存未命中的代价太大（见 ADR）。
		if (params.model) {
			const resolved = resolveModel(ctx, params.model);
			if (!resolved) return fail(piHerdrAgentPrompt.results.errors.unknownModel(params.model), "resume", id);
			if (resolved.provider !== facts.provider || resolved.id !== facts.modelId) {
				return fail(
					piHerdrAgentPrompt.results.errors.resumeModelMismatch(id, facts.provider ?? "?", facts.modelId ?? "?"),
					"resume",
					id,
				);
			}
		}
		if (params.thinking) {
			if (!facts.thinking)
				return fail(piHerdrAgentPrompt.results.errors.resumeThinkingMissing(id), "resume", id);
			if (params.thinking !== facts.thinking) {
				return fail(
					piHerdrAgentPrompt.results.errors.resumeThinkingMismatch(id, facts.thinking),
					"resume",
					id,
				);
			}
		}

		const name = params.name ?? facts.name ?? id;
		const invalidName = validateAgentName(name);
		if (invalidName) return fail(piHerdrAgentPrompt.results.errors.invalidName(name, invalidName), "resume", id);

		await launch({
			id,
			name,
			cwd: facts.cwd,
			// 不给就不传：pi 打开会话时沿用会话里记录的模型与思考级别。
			model: params.model,
			thinking: params.thinking,
			prompt: params.prompt,
			ctx,
			destroyAfterSeconds: normalizeDestroyAfter(params.destroyAfterSeconds),
		});
		return ok(piHerdrAgentPrompt.results.resumedAgent(id, name), {
			action: "resume",
			id,
			name,
		});
	};

	interface LaunchOptions {
		id: string;
		name: string;
		cwd: string;
		model?: string;
		thinking?: string;
		prompt: string;
		ctx: ExtensionContext;
		/** 空闲销毁秒数；0 = 永不。 */
		destroyAfterSeconds: number;
	}

	const launch = async (launchOptions: LaunchOptions): Promise<void> => {
		const { id, name, cwd, model, thinking, prompt, ctx, destroyAfterSeconds } = launchOptions;
		const argv = ["pi", "--session-id", `pi-${id}`, "--name", name];
		if (model) argv.push("--model", model);
		if (thinking) argv.push("--thinking", thinking);

		let run: Awaited<ReturnType<HcClient["run"]>>;
		try {
			run = await hc.run({
				argv,
				cwd,
				name,
				parent: self,
				labels: { "pi.agent": id },
				env: {
					PI_AGENT_ID: id,
					PI_AGENT_NAME: name,
					PI_AGENT_PARENT: myId,
					PI_AGENT_ROOT: myRoot,
					PI_AGENT_DEPTH: String(myDepth + 1),
					[DESTROY_ENV]: String(destroyAfterSeconds),
				},
				no_notify: true,
				rm: true,
				wait: true,
				timeout: READY_TIMEOUT_S,
			});
		} catch (error) {
			if (error instanceof HcError && error.kind === "name_taken") {
				throw new Error(`name '${name}' is already used by a running agent.`);
			}
			throw error;
		}

		const ready = await waitForReady(run.address, run.wait, run.output, run.state);
		if (!ready.ok) {
			await hc.kill(run.address).catch(() => undefined);
			throw new Error(ready.reason);
		}

		try {
			await hc.send({
				terminal: run.address,
				caller: self,
				text: formatAgentEnvelope({ from: myId, name: displayName(ctx), body: prompt }),
			});
		} catch (error) {
			await hc.kill(run.address).catch(() => undefined);
			throw error;
		}
	};

	/**
	 * 等子 pi 就绪：`terminal.run(wait: true)` 已经等过一轮；超时（还在启动）再等一轮。
	 * 退出/卡在弹窗/一直不 ready 都算失败，返回给人看的原因（附屏幕尾部）。
	 */
	const waitForReady = async (
		address: string,
		first: HcWaitResult | null,
		output: string | null,
		state: string,
	): Promise<{ ok: true } | { ok: false; reason: string }> => {
		let wait = first;
		if (!wait || wait.reason === "timeout") {
			try {
				wait = await hc.wait({ terminal: address, timeout: READY_TIMEOUT_S, caller: self });
			} catch (error) {
				return { ok: false, reason: `could not confirm startup: ${errorMessage(error)}` };
			}
		}

		if (state !== "live" || wait.reason === "exit") {
			return { ok: false, reason: `pi exited before it was ready${excerpt(output)}` };
		}
		if (!wait.ended || wait.reason === "timeout") {
			return { ok: false, reason: `pi did not become ready within ${READY_TIMEOUT_S * 2}s${excerpt(output)}` };
		}
		if (wait.status !== "idle" && wait.status !== "done") {
			return { ok: false, reason: `pi is '${wait.status ?? "unknown"}' at startup${excerpt(output)}` };
		}
		return { ok: true };
	};

	// ─── 工具：agent_job ───

	const registerJobTool = (): void => {
		pi.registerTool({
			name: "agent_job",
			label: "Agent jobs",
			description: piHerdrAgentPrompt.declarations.agentJob.description,
			promptSnippet: piHerdrAgentPrompt.system.snippets.agentJob,
			// 守则挂在 agent_job 上：它全深度都有，而 agent 在最深一层不注册。
			promptGuidelines: [piHerdrAgentPrompt.system.guidelines.agentJob],
			parameters: Type.Object({
				action: StringEnum(["list", "ask", "stop"] as const, {
					description: piHerdrAgentPrompt.declarations.agentJob.parameters.action,
				}),
				id: Type.Optional(Type.String({ description: piHerdrAgentPrompt.declarations.agentJob.parameters.id })),
				message: Type.Optional(
					Type.String({ description: piHerdrAgentPrompt.declarations.agentJob.parameters.message }),
				),
			}),

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const typed = params as AgentJobParams;
				try {
					switch (typed.action) {
						case "list": {
							const terminals = await hc.list();
							// 只看自己、一级父、一级子、兄弟；爷爷、侄子、别的树都看不到。
							const rows = buildRows(terminals, myId, self).filter((row) => row.relation !== "other");
							return ok(formatRows(rows), { action: "list", agents: rows });
						}
						case "stop":
							return await stopJob(typed);
						case "ask":
							return await askJob(typed, ctx);
					}
				} catch (error) {
					return fail(humanError(error, typed.id), typed.action);
				}
			},
		});
	};

	const stopJob = async (params: AgentJobParams) => {
		if (!params.id) return fail(piHerdrAgentPrompt.results.errors.idRequired("stop"), "stop");
		const terminals = await hc.list();
		const target = terminals.find((terminal) => agentIdOf(terminal) === params.id && terminal.state === "live");
		if (!target) return fail(piHerdrAgentPrompt.results.errors.notRunning(params.id), "stop", params.id);
		if (target.address === self)
			return fail(piHerdrAgentPrompt.results.errors.cannotActOnSelf("stop"), "stop", params.id);
		if (!isDescendant(target, terminals, self)) {
			return fail(piHerdrAgentPrompt.results.errors.notDescendant(params.id), "stop", params.id);
		}
		await requestQuit(target.address);
		return ok(piHerdrAgentPrompt.results.stopped(params.id), { action: "stop", id: params.id });
	};

	/**
	 * 先请对方自己退出：只有优雅退出才会跑到 `session_shutdown`，
	 * 把「没来得及回答」与「队列里的活没做」交代给派活人和排队的人。
	 * `hc.kill` 是硬杀，进程来不及做任何事；宽限期内没走才用它兜底。
	 */
	const requestQuit = async (address: string): Promise<void> => {
		// 工作状态下第一下 ctrl+d 是「中止」，停下来的第二下才是「退出」；
		// 两次各给一段宽限，还不走就硬杀。
		for (const attempt of [1, 2]) {
			try {
				await hc.keys({ terminal: address, keys: ["ctrl+d"] });
			} catch {
				break; // 旧 core 没有 terminal.keys：直接去硬杀。
			}

			const finished = await waitUntilGone(address, stopGraceMs / 1000);
			if (finished) return;
			if (attempt === 2) break;
		}

		await hc.kill(address).catch((error: unknown) => {
			// `rm: true` 的终端在 kill 成功后会被立刻删除，core 有时把这次删除回成 not_found /
			// finished；目标刚刚还在，所以这仍然是「已结束」，不是失败。
			if (error instanceof HcError && (error.kind === "not_found" || error.kind === "finished")) return;
			throw error;
		});
	};

	/**
	 * 轮询到终端消失或超时。不用 `terminal.wait`：它等的是「下一次停」，
	 * 对一个已经停下来的终端会一直等到超时，分不清「退出了」和「只是闲置」。
	 */
	const waitUntilGone = async (address: string, seconds: number): Promise<boolean> => {
		const deadline = now() + seconds * 1000;
		while (now() < deadline) {
			try {
				const terminal = await hc.get(address);
				if (terminal.state === "finished") return true;
			} catch (error) {
				if (error instanceof HcError && (error.kind === "not_found" || error.kind === "finished")) return true;
			}
			await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
		}
		return false;
	};

	/**
	 * 发一条消息。不检查对方状态：忙就由对方插进当前轮或排队，闲就起一轮。
	 * 对方收工时会把这一轮的最后回答自动发回来。
	 */
	const askJob = async (params: AgentJobParams, ctx: ExtensionContext) => {
		if (!params.id) return fail(piHerdrAgentPrompt.results.errors.idRequired("ask"), "ask");
		if (!params.message?.trim()) return fail(piHerdrAgentPrompt.results.errors.messageRequired("ask"), "ask", params.id);
		const target = await requireTarget(params.id);
		if (target.row.id === myId) return fail(piHerdrAgentPrompt.results.errors.cannotActOnSelf("ask"), "ask", params.id);

		await hc.send({
			terminal: target.terminal.address,
			caller: self,
			text: formatAgentEnvelope({ from: myId, name: displayName(ctx), body: params.message }),
		});
		return ok(piHerdrAgentPrompt.results.asked(target.row.id, target.row.name), {
			action: "ask",
			id: target.row.id,
		});
	};

	const requireTarget = async (id: string): Promise<{ terminal: HcTerminal; row: AgentRow }> => {
		const terminals = await hc.list();
		const terminal = terminals.find((candidate) => agentIdOf(candidate) === id && candidate.state === "live");
		if (!terminal) throw new Error(piHerdrAgentPrompt.results.errors.notRunning(id));
		const row = buildRows(terminals, myId, self).find((candidate) => candidate.id === id);
		if (!row) throw new Error(piHerdrAgentPrompt.results.errors.notRunning(id));
		return { terminal, row };
	};

	// ─── 命令：/agent list ───

	const TREE_ENTRY = "pi-herdr-agent:tree";

	interface TreeEntry {
		lines: TreeLine[];
	}

	pi.registerEntryRenderer<TreeEntry>(TREE_ENTRY, (entry, _options, theme) => {
		const box = new Box(1, 1);
		box.addChild(new TreeView(entry.data?.lines ?? [], theme));
		return box;
	});

	pi.registerCommand("agent", {
		description: "子 agent：/agent list 显示当前 agent 树，/agent list-all 显示全部 agent 树",
		getArgumentCompletions: (prefix) => {
			if (prefix.trim().includes(" ")) return null;
			const wanted = prefix.trim();
			const items = [
				{ value: "list", label: "list" },
				{ value: "list-all", label: "list-all" },
			].filter((item) => item.value.startsWith(wanted));
			return items.length > 0 ? items : null;
		},
		handler: async (rawArgs) => {
			const args = rawArgs.trim();
			if (args && args !== "list" && args !== "list-all") {
				pi.appendEntry<TreeEntry>(TREE_ENTRY, {
					lines: [{ left: [{ text: "用法：/agent list | /agent list-all", tone: "muted" }], right: [] }],
				});
				return;
			}

			// 默认只看自己所在的树；list-all 才跨树。
			const all = args === "list-all";
			try {
				const rows = buildRows(await hc.list(), myId, self);
				pi.appendEntry<TreeEntry>(TREE_ENTRY, {
					lines: all ? formatAgentTree(rows, "全部 agent 树") : formatAgentTree(currentTree(rows, myId)),
				});
			} catch (error) {
				pi.appendEntry<TreeEntry>(TREE_ENTRY, {
					lines: [{ left: [{ text: `✗ 读取 agent 树失败：${errorMessage(error)}`, tone: "error" }], right: [] }],
				});
			}
		},
	});

	// ─── 注册 ───

	// 深度 2（第三层）不再提供 agent：树深上限三层。
	if (myDepth < MAX_DEPTH) registerAgentTool();
	registerJobTool();
}

// ─── 纯函数 ───

/**
 * 工具参数 → 实际秒数：小数向下取整，非法值 / 负数回到默认；`0` 保留为「永不销毁」。
 */
export function normalizeDestroyAfter(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value) || value < 0) return DEFAULT_DESTROY_AFTER_S;
	return Math.floor(value);
}

/** 子 agent 从 env 读自己的空闲销毁秒数；缺省 / 非法 / `<= 0` 都是 `0`（不销毁）。 */
export function parseDestroyAfter(raw: string | undefined): number {
	if (raw === undefined) return 0;
	const value = Number.parseInt(raw.trim(), 10);
	return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 默认调度器：`setInterval`，返回取消函数。 */
function defaultSchedule(tick: () => void, ms: number): () => void {
	const handle = setInterval(tick, ms);
	return () => clearInterval(handle);
}

const DONE_STATUS_PREFIX = "\x1b]7501;state=done";
const STDOUT_PATCHED = Symbol.for("pi-herdr-agent:done-to-idle");

/** pi 在 settle 时写 `state=done`；子 agent 要把这一条改成 `state=idle`。 */
export function rewriteDoneStatus(text: string): string {
	return text.startsWith(DONE_STATUS_PREFIX) ? text.replace("state=done", "state=idle") : text;
}

/**
 * 在 stdout 上把子 agent 的 done 报告改写成 idle。pi 没有给扩展留「settle 状态」钩子，
 * 而内置 reporter 的 done 也走 `process.stdout.write`，所以做一层透明包装：只动
 * `OSC 7501;state=done` 开头的字符串，其余写入原样透传。用 Symbol 防 /reload 重复包装。
 */
function patchSettledStatus(env: NodeJS.ProcessEnv): void {
	if (!env.PI_AGENT_ID?.trim()) return;

	type PatchedWrite = typeof process.stdout.write & { [STDOUT_PATCHED]?: boolean };
	const current = process.stdout.write as PatchedWrite;
	if (current[STDOUT_PATCHED]) return;

	const original = current as (...args: unknown[]) => boolean;
	const patched = function (chunk: unknown, ...rest: unknown[]): boolean {
		const text = typeof chunk === "string" ? rewriteDoneStatus(chunk) : chunk;
		return original.call(process.stdout, text, ...rest);
	} as PatchedWrite;
	patched[STDOUT_PATCHED] = true;
	process.stdout.write = patched;
}

/**
 * 根的显示名：跟 pi 的终端标题走（交互模式启动/`/name` 时由 pi 写入）。
 * - 命名会话的标题是 `π - <会话名> - <cwd>`，只取会话名；
 * - 未命名会话的标题是 `π - <cwd>`，原样显示这句默认终端名；
 * - 标题缺失或被别的程序改写时，退回 hc 终端名。
 */
function rootLabel(terminal: HcTerminal): string {
	const fallback = terminal.name?.trim() || "(root)";
	const title = terminal.title?.trim() ?? "";
	const stripped = title.replace(/^π\s*-\s*/, "").trim();
	if (!stripped || stripped === title) return fallback;

	// 用终端 cwd 的末段判断标题里有没有会话名：`<会话名> - <cwd>` 还是只有 `<cwd>`。
	const cwdName = basename(terminal.cwd ?? "");
	if (!cwdName) return stripped.replace(/\s+-\s*$/, "") || fallback;
	if (stripped === cwdName) return title;
	const suffix = ` - ${cwdName}`;
	if (stripped.endsWith(suffix)) return stripped.slice(0, -suffix.length).trim() || fallback;
	// cwd 与标题对不上（目录被挪动等）：照原样显示，别把信息丢掉。
	return stripped;
}

/** 子 agent 的 id 由 `pi.agent` label 给出；根用自己写的 `pi.agent.root`；
 * 都没有时退回终端地址（旧版本 / label 写入失败的兑底）*/
function agentIdOf(terminal: HcTerminal): string | undefined {
	const labeled = terminal.labels["pi.agent"]?.trim();
	if (labeled) return labeled;
	const rootLabeled = terminal.labels["pi.agent.root"]?.trim();
	// 只在它仍是 pi 时算数：pi 退出后留在 keep 终端上的旧 label 不当 agent。
	if (rootLabeled && terminal.status?.app === "pi") return rootLabeled;
	if (terminal.status?.app === "pi") return terminal.address;
	return undefined;
}

/** 6 位十六进制；与活着的 id、同 cwd 里已存在的会话 id 都查重。 */
function newAgentId(cwd: string, taken: Set<string>): string | undefined {
	for (let attempt = 0; attempt < 32; attempt++) {
		const id = randomBytes(3).toString("hex");
		if (taken.has(id)) continue;
		if (SessionManager.findById(cwd, `pi-${id}`)) continue;
		return id;
	}
	return undefined;
}

/** 根 agent 的短 id：会话 id 末尾 6 位字母数字（uuidv7 的尾段就是随机 hex）。 */
export function rootIdOf(sessionId: string): string {
	return sessionId.replace(/[^A-Za-z0-9]/g, "").slice(-6).toLowerCase();
}

/**
 * 生成 list 行：发现规则是「有 `pi.agent` label 的终端」加上「上报自己是 pi 的终端」
 * （后者是没有 label 的根）。父/深度沿 hc 的 parent 链推导。
 */
export function buildRows(terminals: HcTerminal[], selfId: string, selfAddr: string): AgentRow[] {
	const agents = terminals
		.map((terminal) => ({ terminal, id: agentIdOf(terminal) }))
		.filter((entry): entry is { terminal: HcTerminal; id: string } => Boolean(entry.id));
	const byAddress = new Map(agents.map((entry) => [entry.terminal.address, entry]));
	const selfParentAddr = byAddress.get(selfAddr)?.terminal.parent ?? null;

	const depthCache = new Map<string, number>();
	const visiting = new Set<string>();
	// 深度只数「扩展拉起的 agent」（带 pi.agent label）：根（没有 label）无论挂在谁下面都是 0，
	// 这样 list 的 depth 与子进程的 PI_AGENT_DEPTH 同口径（验收时发现过两者不一致）。
	const depthOf = (address: string): number => {
		const cached = depthCache.get(address);
		if (cached !== undefined) return cached;
		if (visiting.has(address)) return 0; // 防御：parent 链成环
		visiting.add(address);

		const entry = byAddress.get(address);
		let depth = 0;
		if (entry?.terminal.labels["pi.agent"]) {
			const parent = entry.terminal.parent ? byAddress.get(entry.terminal.parent) : undefined;
			depth = parent ? 1 + depthOf(parent.terminal.address) : 1;
		}

		visiting.delete(address);
		depthCache.set(address, depth);
		return depth;
	};

	return agents
		.map(({ terminal, id }) => {
			const parentAddr = terminal.parent;
			const parent = parentAddr ? byAddress.get(parentAddr)?.id ?? null : null;
			let relation: AgentRow["relation"] = "other";
			// 根的 pi.agent.root label 可能写失败（或还没写完）：再认一次本终端地址。
			if (id === selfId || terminal.address === selfAddr) relation = "self";
			else if (selfParentAddr && terminal.address === selfParentAddr) relation = "parent";
			else if (terminal.parent === selfAddr) relation = "child";
			else if (selfParentAddr && terminal.parent === selfParentAddr) relation = "sibling";

			// 子 agent 的 name 就是拉起时给 hc 的终端名；根没有自己的 name，从 pi 标题推导。
			const name = terminal.labels["pi.agent"]
				? terminal.name?.trim() || id
				: rootLabel(terminal);
			return {
				id,
				name,
				relation,
				status: terminal.state === "finished" ? "finished" : terminal.status?.state ?? "starting",
				parent,
				depth: depthOf(terminal.address),
				cwd: terminal.cwd,
				orphan: parentAddr !== null && !byAddress.has(parentAddr),
			};
		})
		.sort((left, right) => left.depth - right.depth || left.id.localeCompare(right.id));
}

/**
 * 当前树：`self` 所在的连通树——沿 parent 链爬到最上层（父不在列表里就停在 `self`），
 * 再收该节点下的整棵子树。列表里找不到 self 时退回全部行（宁可多显示，不可报错）。
 */
export function currentTree(rows: AgentRow[], selfId: string): AgentRow[] {
	const byId = new Map(rows.map((row) => [row.id, row]));
	const self = byId.get(selfId) ?? rows.find((row) => row.relation === "self");
	if (!self) return rows;

	let rootId = self.id;
	const climbed = new Set<string>([rootId]);
	while (true) {
		const parent = byId.get(rootId)?.parent;
		if (!parent || !byId.has(parent) || climbed.has(parent)) break;
		climbed.add(parent);
		rootId = parent;
	}

	const children = new Map<string, string[]>();
	for (const row of rows) {
		if (!row.parent || !byId.has(row.parent)) continue;
		children.set(row.parent, [...(children.get(row.parent) ?? []), row.id]);
	}

	const inTree = new Set<string>();
	const stack = [rootId];
	while (stack.length > 0) {
		const id = stack.pop()!;
		if (inTree.has(id)) continue;
		inTree.add(id);
		for (const kid of children.get(id) ?? []) stack.push(kid);
	}
	return rows.filter((row) => inTree.has(row.id));
}

/**
 * 把扁平行渲染成卡片式森林（`/agent list`）：每棵独立的树一块，根用 `▌` 引导，
 * 子层用 ├─ / └─；名字在前、id 在后，状态右对齐。
 */
export function formatAgentTree(rows: AgentRow[], title = "agent 树"): TreeLine[] {
	if (rows.length === 0) {
		return [{ left: [{ text: "没有正在运行的 agent。", tone: "muted" }], right: [] }];
	}

	const byId = new Map(rows.map((row) => [row.id, row]));
	const children = new Map<string, AgentRow[]>();
	const roots: AgentRow[] = [];

	for (const row of rows) {
		const parent = row.parent && byId.has(row.parent) ? row.parent : null;
		if (parent) children.set(parent, [...(children.get(parent) ?? []), row]);
		else roots.push(row);
	}

	const self = rows.find((row) => row.relation === "self");
	const lines: TreeLine[] = [
		{ left: [{ text: `${title} · ${rows.length} 个 agent`, tone: "muted" }], right: [] },
		{ left: [], right: [] },
	];

	const markerOf = (row: AgentRow): TreeSegment | undefined => {
		if (row.relation === "self") return { text: "● ", tone: "accent" };
		if (self?.parent === row.id) return { text: "↑ ", tone: "muted" };
		return undefined;
	};

	const statusOf = (row: AgentRow): TreeSegment[] => {
		const segments: TreeSegment[] = [{ text: row.status, tone: statusTone(row.status) }];
		if (row.orphan) segments.push({ text: " · 失联", tone: "warning" });
		return segments;
	};

	const push = (row: AgentRow, prefix: string, glyph: string, isRoot: boolean): void => {
		const left: TreeSegment[] = isRoot
			? [{ text: "▌ ", tone: "borderAccent" }]
			: [
					{ text: prefix, tone: "borderMuted" },
					{ text: glyph, tone: "borderMuted" },
				];

		const marker = markerOf(row);
		if (marker) left.push(marker);
		left.push({ text: row.name, tone: row.relation === "self" ? "accent" : "text" });
		if (row.name !== row.id) {
			left.push({ text: "  ·  ", tone: "dim" }, { text: row.id, tone: "dim" });
		}
		lines.push({ left, right: statusOf(row) });
	};

	const walk = (row: AgentRow, prefix: string, isLast: boolean, isRoot: boolean): void => {
		push(row, prefix, isRoot ? "" : isLast ? "└─ " : "├─ ", isRoot);
		const kids = children.get(row.id) ?? [];
		const childPrefix = isRoot ? "  " : `${prefix}${isLast ? "   " : "│  "}`;
		kids.forEach((kid, index) => walk(kid, childPrefix, index === kids.length - 1, false));
	};

	roots.forEach((root, index) => {
		if (index > 0) lines.push({ left: [], right: [] });
		walk(root, "", index === roots.length - 1, true);
	});

	lines.push({ left: [], right: [] });
	const hasOrphan = rows.some((row) => row.orphan);
	lines.push({
		left: [
			{
				text: hasOrphan ? "● 自己   ↑ 父 agent   失联 = 父终端已消失" : "● 自己   ↑ 父 agent",
				tone: "dim",
			},
		],
		right: [],
	});
	return lines;
}

function statusTone(status: string): ThemeColor {
	switch (status) {
		case "working":
			return "accent";
		case "done":
			return "success";
		case "blocked":
			return "warning";
		case "error":
			return "error";
		case "starting":
			return "muted";
		case "idle":
		case "finished":
			return "dim";
		default:
			return "text";
	}
}

/** `/agent list` 的渲染组件：左侧树内容 + 右对齐状态。 */
class TreeView implements Component {
	private readonly lines: TreeLine[];
	private readonly theme: Theme;

	constructor(lines: TreeLine[], theme: Theme) {
		this.lines = lines;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const target = treeWidth(this.theme, this.lines, width);
		return this.lines.map((line) => renderTreeLine(this.theme, line, target));
	}
}

function renderTreeLine(theme: Theme, line: TreeLine, width: number): string {
	const left = paintSegments(theme, line.left);
	const right = paintSegments(theme, line.right);
	if (!right) return truncateToWidth(left, width, "…");

	const rightWidth = visibleWidth(right);
	if (rightWidth + 2 >= width) return truncateToWidth(`${left}  ${right}`, width, "…");

	const available = width - rightWidth - 1;
	const cut = visibleWidth(left) > available ? truncateToWidth(left, available, "…") : left;
	const gap = Math.max(1, width - visibleWidth(cut) - rightWidth);
	return `${cut}${" ".repeat(gap)}${right}`;
}

function paintSegments(theme: Theme, segments: TreeSegment[]): string {
	return segments.map((segment) => (segment.tone ? theme.fg(segment.tone, segment.text) : segment.text)).join("");
}

/** 卡片的目标宽度：内容自然宽度与 64 取大，但不超过终端宽度。 */
const TREE_MIN_WIDTH = 64;

function treeWidth(theme: Theme, lines: TreeLine[], width: number): number {
	let natural = 0;
	for (const line of lines) {
		const left = visibleWidth(paintSegments(theme, line.left));
		const right = line.right.length > 0 ? 2 + visibleWidth(paintSegments(theme, line.right)) : 0;
		natural = Math.max(natural, left + right);
	}
	return Math.min(width, Math.max(TREE_MIN_WIDTH, natural));
}

/** 表格化 list；孤儿在 status 后面标出来，免得只看到 parent 为空。 */
export function formatRows(rows: AgentRow[]): string {
	if (rows.length === 0) return piHerdrAgentPrompt.results.listEmpty();
	const header = ["id", "name", "relation", "status", "depth"];
	const cells = rows.map((row) => [
		row.id,
		row.name,
		row.relation,
		row.orphan ? `${row.status} (orphan)` : row.status,
		String(row.depth),
	]);
	const widths = header.map((title, index) =>
		Math.max(title.length, ...cells.map((row) => row[index].length)),
	);
	const line = (row: string[]): string =>
		row.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd();
	return [line(header), ...cells.map(line)].join("\n");
}

/** 目标是不是本终端的后代：沿 parent 链往上走，遇到自己就算。 */
export function isDescendant(target: HcTerminal, terminals: HcTerminal[], self: string): boolean {
	const byAddress = new Map(terminals.map((terminal) => [terminal.address, terminal]));
	let cursor = target.parent;
	const seen = new Set<string>();
	while (cursor && !seen.has(cursor)) {
		if (cursor === self) return true;
		seen.add(cursor);
		cursor = byAddress.get(cursor)?.parent ?? null;
	}
	return false;
}

/** 从 pi 的 agent_end 消息里取最后一条有文本的 assistant 消息。 */
export function lastAssistantText(messages: readonly { role?: string; content?: unknown }[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const text = contentText(message.content).trim();
		if (text) return text;
	}
	return undefined;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Array<{ type?: string; text?: string }>)
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

/** 失败原因里附屏幕尾部：pi 启动失败的原因通常就在最后几行。 */
function excerpt(output: string | null | undefined, max = 600): string {
	const text = output?.trim();
	if (!text) return "";
	const lines = text.split("\n").filter((line) => line.trim());
	return `: ${lines.slice(-12).join("\n").slice(-max)}`;
}

/** 找某个 pi 会话（`pi-<agentId>`），跨 cwd 的所有会话目录。 */
async function findSession(sessionId: string, sessionDir?: string) {
	const sessions = await SessionManager.listAll(sessionDir);
	return sessions.find((session) => session.id === sessionId);
}

/** 读会话文件的头与最后的状态变更；用于 resume 的 cwd / 名称 / 模型 / 思考级别。 */
export function readSessionFacts(path: string): SessionFacts | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}

	let facts: SessionFacts | undefined;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: {
			type?: string;
			cwd?: string;
			name?: string;
			provider?: string;
			modelId?: string;
			thinkingLevel?: string;
		};
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry.type === "session") {
			facts = { cwd: String(entry.cwd ?? "") };
			continue;
		}
		if (!facts) continue;
		if (entry.type === "model_change") {
			facts.provider = entry.provider;
			facts.modelId = entry.modelId;
		} else if (entry.type === "thinking_level_change") {
			facts.thinking = entry.thinkingLevel;
		} else if (entry.type === "session_info") {
			facts.name = entry.name || undefined;
		}
	}
	return facts;
}

/** 把调用方给的经验模型引用解析成具体模型；解析不了返回 undefined。 */
function resolveModel(ctx: ExtensionContext, reference: string): { provider: string; id: string } | undefined {
	const models = ctx.modelRegistry.getAll();
	const wanted = reference.toLowerCase();
	const exact = models.filter(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === wanted || model.id.toLowerCase() === wanted,
	);
	const named = exact.length > 0 ? exact : models.filter((model) => (model.name ?? "").toLowerCase() === wanted);
	if (named.length === 1) return { provider: named[0].provider, id: named[0].id };
	if (named.length > 1) return undefined;
	const fuzzy = models.filter(
		(model) =>
			model.id.toLowerCase().includes(wanted) || (model.name ?? "").toLowerCase().includes(wanted),
	);
	return fuzzy.length === 1 ? { provider: fuzzy[0].provider, id: fuzzy[0].id } : undefined;
}

/** core 错误码翻成人话。 */
function humanError(error: unknown, id?: string): string {
	if (error instanceof HcError) {
		switch (error.kind) {
			case "not_found":
				return id ? piHerdrAgentPrompt.results.errors.notRunning(id) : piHerdrAgentPrompt.results.errors.terminalNotFound();
			case "finished":
				return id ? piHerdrAgentPrompt.results.errors.agentExited(id) : piHerdrAgentPrompt.results.errors.terminalExited();
			case "blocked":
				return id ? piHerdrAgentPrompt.results.errors.agentBlocked(id) : piHerdrAgentPrompt.results.errors.terminalBlocked();
			case "status_mismatch":
				return id
					? piHerdrAgentPrompt.results.errors.agentStatusMismatch(id)
					: piHerdrAgentPrompt.results.errors.terminalStatusMismatch();
			case "name_taken":
				return piHerdrAgentPrompt.results.errors.nameTaken();
			case "spawn_failed":
				return piHerdrAgentPrompt.results.errors.spawnFailed(error.message);
			default:
				return piHerdrAgentPrompt.results.errors.coreError(error.kind, error.message);
		}
	}
	return errorMessage(error);
}

const fail = (message: string, action?: AgentToolDetails["action"], id?: string) => ({
	content: [{ type: "text" as const, text: `${ERROR_PREFIX}${message}` }],
	details: { action, id, error: message } as AgentToolDetails,
});

const ok = (text: string, details: AgentToolDetails) => ({
	content: [{ type: "text" as const, text }],
	details,
});
