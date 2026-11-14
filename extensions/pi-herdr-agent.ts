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
 * - 根 agent（人直接启动的 pi）没有 env 注入，id 就是它的 hc 地址（如 `t4m`）。
 * - `name` 是 hc 终端名（herdr-app 侧边栏显示的那个），创建时固定，只作显示；寻址一律用 id。
 * - 拉起时注入 `PI_AGENT_ID` / `PI_AGENT_NAME` / `PI_AGENT_PARENT` / `PI_AGENT_ROOT` /
 *   `PI_AGENT_DEPTH`，子进程的扩展据此知道自己是谁、在树里的哪一层。
 *
 * 消息：
 * - `ask` 只发给 idle（或 done）的 agent，忙则报错；`steer` 只发给 working 的 agent。
 * - 谁 ask 谁收结果：拉起时的那条 prompt 也算一次 ask。子 agent settle 时把最终答复
 *   发给**当轮 asker**；没有 asker 的轮（人直接打字、收到 result、单纯 steer）不回发。
 * - 消息经 `terminal.send` 打进对方输入框，首行 `<pi-agent ... kind="ask|steer|result">`
 *   由接收方扩展在 `input` 事件里剥掉；`kind=result` 不设 asker，避免回环。
 * - 结果正文超过 2000 行 / 50 KB 时按 bash 工具同款方式尾部截断，全文落临时文件。
 * - 拉起时 `no_notify: true`：hc 自己的 note 不参与语义，消息只有 ask / steer 与结果回发。
 *
 * 生命周期：`session_shutdown(reason=quit)` 时杀掉自己的直接子 agent（递归由各自的
 * shutdown 完成）。子终端的程序就是 pi 本身，所以子进程硬死时 hc 原生级联会接管；
 * 只有 root 那层（前台是 shell）需要显式处理。
 *
 * 状态：pi 内置 reporter 在 settle 时硬写 OSC 7501 `state=done`；子 agent 在 stdout 层
 * 把这条报告改写成 `state=idle`，所以 hc 只看到 working → idle，不会留下 done。
 * 根 agent（没有 `PI_AGENT_ID`）保持 pi 原生行为。
 *
 * 人工入口：`/agent list` 把当前 hc session 的 agent 树渲染成卡片式森林（● 自己、
 * ↑ 父 agent、失联单独标注）。
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
import { Box, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	agentSourceLine,
	formatAgentEnvelope,
	parseAgentEnvelope,
	truncateTail,
	validateAgentName,
} from "./lib/agent-protocol.ts";
import { errorMessage } from "./lib/errors.ts";
import {
	createHcClient,
	HcError,
	inHcEnv,
	type HcClient,
	type HcTerminal,
	type HcWaitResult,
} from "./lib/hc.ts";
import { writeOutputFile } from "./lib/output-file.ts";

// ─── 常量 ───

/** 树深上限：root(0) → 子(1) → 孙(2)，共三层。深度 2 的 agent 不再注册 `agent`。 */
const MAX_DEPTH = 2;

/** 子 pi 就绪等待：一轮 60s，最多两轮。 */
const READY_TIMEOUT_S = 60;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 可以向它发 ask 的状态：idle 与 done（「结束但还没被看」）都表示可以接活。 */
const ASKABLE = new Set(["idle", "done"]);

// ─── 类型 ───

/** 当轮提问者；只活在内存里，settle 后即清空。 */
interface Asker {
	id: string;
	/** 发送方的 hc 终端地址，结果直接回发到这里。 */
	addr: string;
	name?: string;
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
}

interface AgentJobParams {
	action: "list" | "wait" | "kill" | "ask" | "steer";
	id?: string;
	message?: string;
	timeout?: number;
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
	action?: "start" | "resume" | "list" | "wait" | "kill" | "ask" | "steer";
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
	const myId = env.PI_AGENT_ID?.trim() || self;
	const myRoot = env.PI_AGENT_ROOT?.trim() || myId;
	const myDepth = Number.parseInt(env.PI_AGENT_DEPTH ?? "0", 10) || 0;

	// 每轮的状态：asker 只在内存里（label 不承担可变语义），settle 后清空。
	let pendingAsker: Asker | undefined;
	let lastAnswer: string | undefined;
	let blockedNotified = false;

	/** 显示名：子 agent 用注入的 env，根用会话名。只用于消息来源行。 */
	const displayName = (ctx?: ExtensionContext): string | undefined => {
		const fromEnv = env.PI_AGENT_NAME?.trim();
		if (fromEnv) return fromEnv;
		return ctx?.sessionManager.getSessionName()?.trim() || undefined;
	};

	const sendReport = async (target: { addr: string }, ctx: ExtensionContext, body: string): Promise<void> => {
		try {
			await hc.send({
				terminal: target.addr,
				caller: self,
				text: formatAgentEnvelope({
					kind: "result",
					from: myId,
					addr: self,
					name: displayName(ctx),
					body,
				}),
			});
		} catch {
			// asker 已经不在了（终端被关/agent 退出）：结果留在自己终端里，静默丢弃这条回发。
		}
	};

	// ─── 入站消息 ───

	pi.on("input", (event, ctx) => {
		const envelope = parseAgentEnvelope(event.text);
		if (!envelope) return;

		if (envelope.kind === "ask") {
			if (pendingAsker) {
				// 并发的第二个 ask 抢在对方进入 working 之前到达：第一个 asker 拥有这一轮，
				// 第二个只能收到一句忙。消息正文仍会交给模型，但结果不会回给它。
				const busy = `${agentSourceLine(myId, displayName(ctx))} Busy: another request is already pending. Try again when this agent is idle.`;
				void sendReport(envelope, ctx, busy);
			} else {
				pendingAsker = { id: envelope.from, addr: envelope.addr, name: envelope.name };
				lastAnswer = undefined;
			}
		}

		// 机器头剥掉，模型只看正文；kind=result 不改 asker，避免 A→B→A 回环。
		return { action: "transform" as const, text: envelope.body };
	});

	// ─── 出站结果 ───

	pi.on("agent_end", (event) => {
		const text = lastAssistantText(event.messages);
		if (text !== undefined) lastAnswer = text;
	});

	pi.on("agent_settled", async (event, ctx) => {
		const asker = pendingAsker;
		pendingAsker = undefined;
		blockedNotified = false;
		const answer = lastAnswer;
		lastAnswer = undefined;
		if (!asker) return;

		const body = event.aborted
			? `${agentSourceLine(myId, displayName(ctx))}\nRun aborted.`
			: await resultBody(answer, ctx);
		await sendReport(asker, ctx, body);
	});

	pi.on("ui_prompt_start", async (event, ctx) => {
		if (!pendingAsker || blockedNotified) return;
		blockedNotified = true;
		const detail = event.title ? ` (${event.title})` : "";
		await sendReport(
			pendingAsker,
			ctx,
			`${agentSourceLine(myId, displayName(ctx))} Blocked waiting for human input${detail}.`,
		);
	});

	pi.on("ui_prompt_end", () => {
		blockedNotified = false;
	});

	pi.on("session_shutdown", async (event) => {
		// 只有真正退出（quit）才收尸；/reload、/new、/resume、/fork 不动子 agent。
		if (event.reason !== "quit") return;
		try {
			const terminals = await hc.list();
			const children = terminals.filter((terminal) => terminal.parent === self);
			await Promise.allSettled(children.map((terminal) => hc.kill(terminal.address)));
		} catch {
			// 退出路径尽力而为：清理失败不能盖住正常退出。
		}
	});

	// ─── 结果整形 ───

	const resultBody = async (answer: string | undefined, ctx: ExtensionContext): Promise<string> => {
		const source = agentSourceLine(myId, displayName(ctx));
		const text = answer?.trim();
		if (!text) return `${source}\nNo text output this turn.`;

		const truncation = truncateTail(text);
		if (!truncation.truncated) return `${source}\n${text}`;

		try {
			const path = options.spill ? await options.spill(text) : await writeOutputFile("pi-herdr-agent", ".log", text);
			return `${source}\n${truncation.text}\n\n[Output truncated. Full output: ${path}]`;
		} catch (error) {
			return `${source}\n${truncation.text}\n\n[Output truncated: ${errorMessage(error)}]`;
		}
	};

	// ─── 工具：agent ───

	const registerAgentTool = (): void => {
		pi.registerTool({
			name: "agent",
			label: "Agent",
			description:
				"Start a sub-agent in its own terminal; it runs a separate pi session and sends its final answer back as a message. name: 1-32 chars of a-z 0-9 . _ -, unique among running agents. model and thinking default to yours. resume continues an exited agent by id.",
			promptSnippet: "Start a sub-agent that reports back by message",
			parameters: Type.Object({
				prompt: Type.String({ description: "The task for the sub-agent." }),
				name: Type.Optional(
					Type.String({
						description:
							"Sidebar name: 1-32 chars of a-z, 0-9, '.', '_' or '-', unique among running agents. Defaults to the agent id.",
					}),
				),
				model: Type.Optional(
					Type.String({
						description: "Model as provider/id or a fuzzy name. Defaults to your current model.",
					}),
				),
				thinking: Type.Optional(
					StringEnum(THINKING_LEVELS, { description: "Thinking level. Defaults to yours." }),
				),
				resume: Type.Optional(
					Type.String({
						description:
							"Agent id whose exited session to continue instead of starting a new one. Model and thinking must match the session.",
					}),
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
		if (!id) return fail("could not allocate an unused agent id.", "start");

		const name = params.name ?? id;
		const invalidName = validateAgentName(name);
		if (invalidName) return fail(`invalid name '${name}': ${invalidName}`, "start", id);

		const model = params.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
		const thinking = params.thinking ?? ctx.thinkingLevel;

		await launch({ id, name, cwd: ctx.cwd || process.cwd(), model, thinking, prompt: params.prompt, ctx });
		return ok(`Started agent ${id} as '${name}'. Its final answer will arrive as a message.`, {
			action: "start",
			id,
			name,
		});
	};

	const resumeAgent = async (params: AgentParams, ctx: ExtensionContext) => {
		const id = params.resume!;
		const terminals = await hc.list();
		if (terminals.some((terminal) => agentIdOf(terminal) === id && terminal.state === "live")) {
			return fail(`agent '${id}' is still running; use agent_job ask or agent_job steer.`, "resume", id);
		}

		const session = await findSession(`pi-${id}`, options.sessionDir);
		if (!session) return fail(`no session for agent '${id}'.`, "resume", id);

		const facts = readSessionFacts(session.path);
		if (!facts?.cwd) return fail(`session for agent '${id}' has no working directory.`, "resume", id);

		// resume 不允许换脑：缓存未命中的代价太大（见 ADR）。
		if (params.model) {
			const resolved = resolveModel(ctx, params.model);
			if (!resolved) return fail(`unknown model '${params.model}'. Pass provider/id.`, "resume", id);
			if (resolved.provider !== facts.provider || resolved.id !== facts.modelId) {
				return fail(
					`agent '${id}' runs ${facts.provider ?? "?"}/${facts.modelId ?? "?"}; resume cannot switch models.`,
					"resume",
					id,
				);
			}
		}
		if (params.thinking) {
			if (!facts.thinking) return fail(`agent '${id}' has no recorded thinking level; resume cannot verify it.`, "resume", id);
			if (params.thinking !== facts.thinking) {
				return fail(
					`agent '${id}' uses thinking '${facts.thinking}'; resume cannot switch thinking levels.`,
					"resume",
					id,
				);
			}
		}

		const name = params.name ?? facts.name ?? id;
		const invalidName = validateAgentName(name);
		if (invalidName) return fail(`invalid name '${name}': ${invalidName}`, "resume", id);

		await launch({
			id,
			name,
			cwd: facts.cwd,
			// 不给就不传：pi 打开会话时沿用会话里记录的模型与思考级别。
			model: params.model,
			thinking: params.thinking,
			prompt: params.prompt,
			ctx,
		});
		return ok(`Resumed agent ${id} as '${name}'. Its final answer will arrive as a message.`, {
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
	}

	const launch = async (launchOptions: LaunchOptions): Promise<void> => {
		const { id, name, cwd, model, thinking, prompt, ctx } = launchOptions;
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
				text: formatAgentEnvelope({
					kind: "ask",
					from: myId,
					addr: self,
					name: displayName(ctx),
					body: prompt,
				}),
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
			description:
				"Manage sub-agents: list, wait, kill, ask, steer. ask works only when the target is idle (busy is an error); steer only while it is working. Only your own descendants can be killed.",
			promptSnippet: "List, wait on, stop, ask, or steer sub-agents",
			parameters: Type.Object({
				action: StringEnum(["list", "wait", "kill", "ask", "steer"] as const, {
					description:
						"list: running agents. wait: block until one stops working. kill: end one of your descendants. ask: send a request to an idle agent; its answer arrives as a message. steer: insert a message into a working agent.",
				}),
				id: Type.Optional(Type.String({ description: "Agent id. Required for wait, kill, ask and steer." })),
				message: Type.Optional(Type.String({ description: "Message for ask and steer." })),
				timeout: Type.Optional(
					Type.Number({
						description: "wait only: max seconds before returning. A timeout is a check-in, not a failure.",
					}),
				),
			}),

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const typed = params as AgentJobParams;
				try {
					switch (typed.action) {
						case "list": {
							const terminals = await hc.list();
							const rows = buildRows(terminals, myId, self);
							return ok(formatRows(rows), { action: "list", agents: rows });
						}
						case "wait":
							return await waitJob(typed, ctx);
						case "kill":
							return await killJob(typed);
						case "ask":
							return await askJob(typed, ctx);
						case "steer":
							return await steerJob(typed, ctx);
					}
				} catch (error) {
					return fail(humanError(error, typed.id), typed.action);
				}
			},
		});
	};

	const waitJob = async (params: AgentJobParams, _ctx: ExtensionContext) => {
		if (!params.id) return fail("id is required for wait.", "wait");
		if (params.id === myId) return fail("an agent cannot wait on itself.", "wait", params.id);
		const target = await requireTarget(params.id);
		const timeout =
			params.timeout !== undefined && Number.isFinite(params.timeout)
				? Math.max(0, params.timeout)
				: undefined;
		const wait = await hc.wait({ terminal: target.terminal.address, timeout, caller: self });
		const label = `${target.row.id} (${target.row.name})`;

		if (!wait.ended) {
			return ok(`${label}: still running (${wait.status ?? "unknown"}, turn ${wait.turn}).`, {
				action: "wait",
				id: target.row.id,
			});
		}
		if (wait.reason === "exit") {
			return ok(`${label}: exited (code ${wait.exit_code ?? "?"}).`, { action: "wait", id: target.row.id });
		}
		return ok(`${label}: ${wait.status ?? wait.reason} (turn ${wait.turn}).`, {
			action: "wait",
			id: target.row.id,
		});
	};

	const killJob = async (params: AgentJobParams) => {
		if (!params.id) return fail("id is required for kill.", "kill");
		const terminals = await hc.list();
		const target = terminals.find((terminal) => agentIdOf(terminal) === params.id && terminal.state === "live");
		if (!target) return fail(`agent '${params.id}' is not running.`, "kill", params.id);
		if (target.address === self) return fail("an agent cannot kill itself.", "kill", params.id);
		if (!isDescendant(target, terminals, self)) {
			return fail(`agent '${params.id}' is not your descendant; only your own subtree can be killed.`, "kill", params.id);
		}
		await hc.kill(target.address).catch((error: unknown) => {
			// `rm: true` 的终端在 kill 成功后会被立刻删除，core 有时把这次删除回成 not_found /
			// finished；目标刚刚还在，所以这仍然是「已杀掉」，不是失败。
			if (error instanceof HcError && (error.kind === "not_found" || error.kind === "finished")) return;
			throw error;
		});
		return ok(`Killed agent ${params.id}.`, { action: "kill", id: params.id });
	};

	const askJob = async (params: AgentJobParams, ctx: ExtensionContext) => {
		if (!params.id) return fail("id is required for ask.", "ask");
		if (!params.message?.trim()) return fail("message is required for ask.", "ask", params.id);
		const target = await requireTarget(params.id);
		if (target.row.id === myId) return fail("an agent cannot ask itself.", "ask", params.id);
		const status = target.terminal.status?.state;
		if (!status || !ASKABLE.has(status)) {
			return fail(`agent '${params.id}' is ${status ?? "not ready"}; ask works only when it is idle.`, "ask", params.id);
		}

		const sent = await hc.send({
			terminal: target.terminal.address,
			caller: self,
			text: formatAgentEnvelope({
				kind: "ask",
				from: myId,
				addr: self,
				name: displayName(ctx),
				body: params.message,
			}),
			// done 是「结束但还没被看」，hc 的 if 只认 idle/working，所以那一档不带 if。
			if: status === "idle" ? "idle" : undefined,
		});
		const pending = sent.started === false ? " It has not started working yet." : "";
		return ok(`Asked ${target.row.id} (${target.row.name}). Its answer will arrive as a message when the turn ends.${pending}`, {
			action: "ask",
			id: target.row.id,
		});
	};

	const steerJob = async (params: AgentJobParams, ctx: ExtensionContext) => {
		if (!params.id) return fail("id is required for steer.", "steer");
		if (!params.message?.trim()) return fail("message is required for steer.", "steer", params.id);
		const target = await requireTarget(params.id);
		if (target.row.id === myId) return fail("an agent cannot steer itself.", "steer", params.id);
		const status = target.terminal.status?.state;
		if (status !== "working") {
			return fail(
				`agent '${params.id}' is ${status ?? "not working"}; steer works only while it is running. Use ask when it is idle.`,
				"steer",
				params.id,
			);
		}

		await hc.send({
			terminal: target.terminal.address,
			caller: self,
			text: formatAgentEnvelope({
				kind: "steer",
				from: myId,
				addr: self,
				name: displayName(ctx),
				body: params.message,
			}),
			if: "working",
		});
		return ok(`Steered ${target.row.id} (${target.row.name}).`, { action: "steer", id: target.row.id });
	};

	const requireTarget = async (id: string): Promise<{ terminal: HcTerminal; row: AgentRow }> => {
		const terminals = await hc.list();
		const terminal = terminals.find((candidate) => agentIdOf(candidate) === id && candidate.state === "live");
		if (!terminal) throw new Error(`agent '${id}' is not running.`);
		const row = buildRows(terminals, myId, self).find((candidate) => candidate.id === id);
		if (!row) throw new Error(`agent '${id}' is not running.`);
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
		description: "子 agent：/agent list 显示 agent 树",
		getArgumentCompletions: (prefix) => {
			if (prefix.trim().includes(" ")) return null;
			return "list".startsWith(prefix.trim()) ? [{ value: "list", label: "list" }] : null;
		},
		handler: async (rawArgs) => {
			const args = rawArgs.trim();
			if (args && args !== "list") {
				pi.appendEntry<TreeEntry>(TREE_ENTRY, {
					lines: [{ left: [{ text: "用法：/agent list", tone: "muted" }], right: [] }],
				});
				return;
			}

			try {
				const rows = buildRows(await hc.list(), myId, self);
				pi.appendEntry<TreeEntry>(TREE_ENTRY, { lines: formatAgentTree(rows) });
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

/** 根的显示名：优先 hc 终端名；否则从 pi 标题（`π - <会话名> - <cwd>`）里取会话名，不把 cwd 露出来。 */
function rootLabel(terminal: HcTerminal): string {
	const title = terminal.title?.trim() ?? "";
	const prefixed = /^π\s*-\s*/.test(title);
	const stripped = title.replace(/^π\s*-\s*/, "").trim();
	if (!prefixed) return stripped || "(root)";
	// 标题一定有「会话名 - cwd」两段；没有会话名时只剩 cwd 一段，就不显示 cwd。
	const parts = stripped.split(" - ");
	return parts.length >= 2 ? parts.slice(0, -1).join(" - ") : "(root)";
}

/** 子 agent 的 id 由 label 给出；根 agent 没有 label，id 就是终端地址。 */
function agentIdOf(terminal: HcTerminal): string | undefined {
	const labeled = terminal.labels["pi.agent"]?.trim();
	if (labeled) return labeled;
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
			if (id === selfId) relation = "self";
			else if (selfParentAddr && terminal.address === selfParentAddr) relation = "parent";
			else if (terminal.parent === selfAddr) relation = "child";
			else if (selfParentAddr && terminal.parent === selfParentAddr) relation = "sibling";

			const name = terminal.name?.trim() || (terminal.labels["pi.agent"] ? id : rootLabel(terminal));
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
 * 把扁平行渲染成卡片式森林（`/agent list`）：每棵独立的树一块，根用 `▌` 引导，
 * 子层用 ├─ / └─；名字在前、id 在后，状态右对齐。
 */
export function formatAgentTree(rows: AgentRow[]): TreeLine[] {
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
		{ left: [{ text: `agent 树 · ${rows.length} 个 agent`, tone: "muted" }], right: [] },
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
	if (rows.length === 0) return "No agents are running.";
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
				return id ? `agent '${id}' is not running.` : "terminal not found.";
			case "finished":
				return id ? `agent '${id}' has exited.` : "terminal has exited.";
			case "blocked":
				return id
					? `agent '${id}' is blocked on a dialog; answer it in its terminal first.`
					: "terminal is blocked on a dialog.";
			case "status_mismatch":
				return id ? `agent '${id}' changed state; the action needs the documented state.` : "status mismatch.";
			case "name_taken":
				return "name is already used by a running agent.";
			case "spawn_failed":
				return `could not start pi in a new terminal: ${error.message}`;
			default:
				return `herdr-core ${error.kind}: ${error.message}`;
		}
	}
	return errorMessage(error);
}

const fail = (message: string, action?: AgentToolDetails["action"], id?: string) => ({
	content: [{ type: "text" as const, text: `Error: ${message}` }],
	details: { action, id, error: message } as AgentToolDetails,
});

const ok = (text: string, details: AgentToolDetails) => ({
	content: [{ type: "text" as const, text }],
	details,
});
