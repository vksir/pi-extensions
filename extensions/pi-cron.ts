/**
 * pi-cron —— 进程级 cron job
 *
 * 两个入口：
 *   /cron <间隔> [once] <prompt> | /cron list | /cron delete [id]   人工，间隔由代码解析
 *   cron(action: create | list | delete)                            模型，自行构造 cron 表达式
 *
 * 存续域为「进程级」：
 *   - cron job 表挂在 globalThis 上，因此活过 `/reload` 与 `/resume`。扩展在 reload
 *     时会被真正重新导入（pi loader 用 jiti 且 moduleCache: false），模块级变量
 *     必丢，globalThis 是唯一能跨 reload 存活又不跨进程的载体。
 *   - 进程退出时 globalThis 随之消失，无需任何清理代码。
 *
 * 常驻上下文只有 `cron` 工具的 description + 参数 schema（≈192 tokens）；人工命令不占
 * 常驻；行为约定（立即执行、回执、进程级说明）写在工具返回文本里，调用后付费。
 */

import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	cronToHuman,
	cronToHumanZh,
	formatWhen,
	framePrompt,
	relative,
	relativeZh,
	unframePrompt,
} from "./lib/cron/presentation.ts";
import {
	expandField,
	intervalToCron,
	nextCronRun,
	oneShotCron,
	parseCron,
	parseInterval,
} from "./lib/cron/schedule.ts";
import { renderLineBox, type EntryLine } from "./lib/render.ts";
import { truncate } from "./lib/text.ts";

// 纯逻辑拆到 lib/，仍从本模块转出，保持既有导入路径可用。
export {
	cronToHuman,
	cronToHumanZh,
	expandField,
	framePrompt,
	intervalToCron,
	nextCronRun,
	oneShotCron,
	parseCron,
	parseInterval,
	unframePrompt,
};
export type { CronConversion, CronFields } from "./lib/cron/schedule.ts";

// ─── 常量 ───

const MAX_JOBS = 64;
/** setTimeout 的安全分块：2^31-1 ms ≈ 24.8 天，取 6 小时留足余量 */
const TICK_CHUNK_MS = 6 * 60 * 60 * 1000;
const STORE_KEY = Symbol.for("vkzha.pi-cron.jobs");
const CUSTOM_TYPE = "pi-cron";
const INFO_TYPE = "pi-cron-info";
const PROMPT_PREVIEW = 80;

// ─── 类型 ───

interface CronJob {
	id: string;
	cron: string;
	prompt: string;
	recurring: boolean;
	createdAt: number;
	/** 下一次触发的绝对时间；Infinity 表示「正在等待 agent 空闲」 */
	nextFireAt: number;
	fireCount: number;
	/** 欠跑计数：agent 忙碌期间到期的次数（合并后至多补一次触发） */
	backlog: number;
}

interface CronStore {
	jobs: CronJob[];
}

interface CronMessageDetails {
	id: string;
	cron: string;
	fireCount: number;
	catchUp: boolean;
}

interface CronToolDetails {
	action: "create" | "list" | "delete";
	jobs?: Array<{
		id: string;
		cron: string;
		human: string;
		prompt: string;
		recurring: boolean;
		fireCount: number;
		nextFireAt: number | null;
	}>;
	error?: string;
}

/** 命令结果行：tone 由 registerEntryRenderer 映射到 theme 颜色。 */
type CronInfoLine = EntryLine;

interface CronInfoEntry {
	lines: CronInfoLine[];
}

/** createJob 的结果：错误以代码回报，由调用方渲染各自语言的文案 */
type CreateResult =
	| { ok: true; job: CronJob; next: Date }
	| { ok: false; code: "invalid-cron" | "no-match" | "too-many" };

// ─── 进程级 cron job 表 ───

function store(): CronStore {
	const g = globalThis as unknown as Record<symbol, CronStore | undefined>;
	let s = g[STORE_KEY];
	if (!s) {
		s = { jobs: [] };
		g[STORE_KEY] = s;
	}
	return s;
}

// ─── /cron 命令文案 ───

const USAGE_LINES: CronInfoLine[] = [
	{ text: "用法：", tone: "text" },
	{ text: "/cron <间隔> [once] <prompt>   创建定时任务", tone: "dim" },
	{ text: "/cron list                     列出当前任务", tone: "dim" },
	{ text: "/cron delete [id]              删除任务（省略 id 则弹出选择）", tone: "dim" },
	{ text: "", tone: "dim" },
	{ text: "间隔：Ns / Nm / Nh / Nd，可复合（如 1h30m）；cron 最小粒度 1 分钟，秒级向上取整", tone: "dim" },
	{ text: "once：只触发一次（从现在算起 <间隔> 之后），触发后自动删除", tone: "dim" },
	{ text: "不加 once：循环触发，且创建后立即执行一次", tone: "dim" },
];

function jobLines(job: CronJob, now: number): CronInfoLine[] {
	const when = Number.isFinite(job.nextFireAt) ? `${relativeZh(job.nextFireAt - now)}后` : "等待空闲";
	const fired = job.fireCount > 0 ? ` · 已触发 ${job.fireCount} 次` : "";
	const missed = job.backlog > 0 ? ` · 漏跑 ${job.backlog} 次` : "";
	const kind = job.recurring ? "" : " · 一次性";
	return [
		{ text: `${job.id} · ${cronToHumanZh(job.cron)} (${job.cron}) · ${when}${fired}${missed}${kind}`, tone: "text" },
		{ text: `↳ ${truncate(job.prompt, PROMPT_PREVIEW)}`, tone: "dim" },
	];
}

// ─── 扩展 ───

export default function (pi: ExtensionAPI) {
	// ─── 调度器 ───

	let timer: ReturnType<typeof setTimeout> | null = null;
	/** 最近一次的 ctx，用于查询 agent 是否空闲；session_start 时刷新 */
	let currentCtx: ExtensionContext | undefined;

	const jobs = (): CronJob[] => store().jobs;

	function nextRun(job: CronJob, from: number): number {
		const fields = parseCron(job.cron);
		if (!fields) return Number.POSITIVE_INFINITY;
		const next = nextCronRun(fields, new Date(from));
		return next ? next.getTime() : Number.POSITIVE_INFINITY;
	}

	function removeJob(id: string): boolean {
		const list = jobs();
		const i = list.findIndex((t) => t.id === id);
		if (i < 0) return false;
		list.splice(i, 1);
		return true;
	}

	function earliestFire(): number | null {
		let min: number | null = null;
		for (const t of jobs()) {
			if (!Number.isFinite(t.nextFireAt)) continue;
			if (min === null || t.nextFireAt < min) min = t.nextFireAt;
		}
		return min;
	}

	/** 单一定时器指向最近的 deadline；变更或触发后重算 */
	function arm(): void {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		const next = earliestFire();
		if (next === null) return;

		const delay = Math.max(0, next - Date.now());
		const long = delay > TICK_CHUNK_MS;
		timer = setTimeout(
			() => {
				timer = null;
				if (long) arm();
				else tick();
			},
			Math.min(delay, TICK_CHUNK_MS),
		);
		timer.unref?.();
	}

	/** 校验、限量、入表并重新武装定时器；工具与 /cron 命令共用 */
	function createJob(rawCron: string, prompt: string, recurring: boolean): CreateResult {
		const expr = rawCron.trim().replace(/\s+/g, " ");
		const fields = parseCron(expr);
		if (!fields) return { ok: false, code: "invalid-cron" };

		const next = nextCronRun(fields, new Date());
		if (!next) return { ok: false, code: "no-match" };

		if (jobs().length >= MAX_JOBS) return { ok: false, code: "too-many" };

		const job: CronJob = {
			id: randomUUID().slice(0, 8),
			cron: expr,
			prompt,
			recurring,
			createdAt: Date.now(),
			nextFireAt: next.getTime(),
			fireCount: 0,
			backlog: 0,
		};
		jobs().push(job);
		arm();
		return { ok: true, job, next };
	}

	function inject(job: CronJob, catchUp: boolean): void {
		pi.sendMessage(
			{
				customType: CUSTOM_TYPE,
				content: framePrompt(job),
				display: true,
				details: {
					id: job.id,
					cron: job.cron,
					fireCount: job.fireCount,
					catchUp,
				} as CronMessageDetails,
			},
			{ triggerTurn: true },
		);
	}

	function deliver(job: CronJob): void {
		const catchUp = job.backlog > 0;
		job.fireCount += 1;
		job.backlog = 0;

		if (job.recurring) job.nextFireAt = nextRun(job, Date.now());
		else removeJob(job.id);

		inject(job, catchUp);
	}

	/**
	 * 作废欠跑（D51：手动打断不补跑）。
	 * 一次性 job 的唯一那次已过期（nextFireAt 已推成 Infinity），留着只会变成永不触发的僵尸，
	 * 一并删除；循环 job 的排期在 tick 里已推进到未来，删掉欠跑即可照常继续。
	 */
	function discardBacklog(job: CronJob): void {
		if (job.backlog === 0) return;
		job.backlog = 0;
		if (!job.recurring && !Number.isFinite(job.nextFireAt)) removeJob(job.id);
	}

	/**
	 * 创建后的首次执行（D6：创建即执行，仅循环任务）。
	 * 与定期触发同一通道：空闲才注入；忙碌（含 ctx 未知）时记欠跑，agent_settled 后补跑，
	 * 绝不 steer 打断进行中的会话。idle 分支复用 deliver，保证两条路径行为逐字一致。
	 */
	function runImmediately(job: CronJob): void {
		if (currentCtx && currentCtx.isIdle()) {
			deliver(job);
			return;
		}
		job.backlog += 1;
	}

	function tick(): void {
		const now = Date.now();
		const due = jobs().filter((t) => t.nextFireAt <= now);
		if (due.length === 0) {
			arm();
			return;
		}

		// agent 忙：只记欠跑并推进排期，等空闲后补一次
		if (!currentCtx || !currentCtx.isIdle()) {
			for (const t of due) {
				t.backlog += 1;
				t.nextFireAt = t.recurring ? nextRun(t, now) : Number.POSITIVE_INFINITY;
			}
			arm();
			return;
		}

		due.sort((a, b) => a.nextFireAt - b.nextFireAt);
		const first = due[0]!;
		// 同批其余 cron job 记为欠跑，等 agent 空闲后逐个补（serialize 触发，避免并发注入）
		for (const t of due) {
			if (t === first) continue;
			t.backlog += 1;
			t.nextFireAt = t.recurring ? nextRun(t, now) : Number.POSITIVE_INFINITY;
		}
		deliver(first);
		arm();
	}

	// ─── 事件绑定 ───

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		arm();
	});

	pi.on("session_shutdown", () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	});

	// 空闲后补跑欠下的 cron job；一次补一个，触发的新一轮结束后会再次 settle
	pi.on("agent_settled", (event, ctx) => {
		currentCtx = ctx;
		// 手动打断（Esc）：不补跑。用户按 Esc 是要「停」，此刻再注一条延迟的触发等于无视打断，
		// 且会立刻起一轮新会话；到期的欠跑直接作废（D51）。
		if (event.aborted) {
			for (const t of [...jobs()]) discardBacklog(t);
			arm();
			return;
		}
		const waiting = jobs().filter((t) => t.backlog > 0);
		if (waiting.length > 0) {
			waiting.sort((a, b) => a.createdAt - b.createdAt);
			deliver(waiting[0]!);
		}
		arm();
	});

	// ─── 触发消息渲染器 ───

	// 触发时注入的消息。头行让 TUI 一眼认出是 cron job（带 id，便于对应 /cron list）；
	// 正文用 unframePrompt 剥掉给模型看的包装，只显示 prompt 原貌。
	// 展示形式对齐 pi 自己的 [skill] 加载块：Box(1,1) 上下各留一空行 + customMessageBg
	// 底色 + \x1b[1m[..]\x1b[22m 加粗方括号标签。不做折叠——正文总是可见。
	pi.registerMessageRenderer<CronMessageDetails>(CUSTOM_TYPE, (message, _options, theme) => {
		const d = message.details;
		const schedule = d ? cronToHuman(d.cron) : "cron job";
		const id = d?.id ? `${d.id} · ` : "";
		const meta = d ? ` · 第 ${d.fireCount} 次触发${d.catchUp ? " · 补跑" : ""}` : "";
		const raw =
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("");
		const body = unframePrompt(raw);

		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(
			new Text(
				theme.fg("customMessageLabel", "\x1b[1m[cron]\x1b[22m ") +
					theme.fg("customMessageText", id + schedule) +
					theme.fg("dim", meta),
				0,
				0,
			),
		);
		box.addChild(new Text(body, 0, 0));
		return box;
	});

	// ─── /cron 命令（人工入口，间隔由代码解析，不经过 LLM） ───

	const info = (lines: CronInfoLine[]): void => pi.appendEntry<CronInfoEntry>(INFO_TYPE, { lines });

	pi.registerEntryRenderer<CronInfoEntry>(INFO_TYPE, (entry, _options, theme) =>
		renderLineBox(theme, entry.data?.lines ?? []),
	);

	pi.registerCommand("cron", {
		description: "定时任务：/cron <间隔> [once] <prompt> | /cron list | /cron delete [id]",
		getArgumentCompletions: (prefix) => {
			if (prefix.trim().includes(" ")) return null;
			const typed = prefix.trim();
			const options = ["list", "delete", "1m", "5m", "15m", "30m", "1h", "6h", "1d"];
			const items = options.filter((o) => o.startsWith(typed)).map((o) => ({ value: o, label: o }));
			return items.length > 0 ? items : null;
		},
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim();
			if (!args) {
				info(USAGE_LINES);
				return;
			}

			const [head, ...rest] = args.split(/\s+/);

			if (head === "list") {
				const list = jobs();
				if (list.length === 0) {
					info([{ text: "当前没有定时任务。", tone: "muted" }]);
					return;
				}
				const now = Date.now();
				info([
					{ text: `共 ${list.length} 个定时任务`, tone: "text" },
					{ text: "", tone: "dim" },
					...list.flatMap((job) => jobLines(job, now)),
				]);
				return;
			}

			if (head === "delete") {
				const id = rest[0];
				if (id) {
					if (!removeJob(id)) {
						info([{ text: `✗ 没有 id 为 ${id} 的定时任务，用 /cron list 查看`, tone: "error" }]);
						return;
					}
					arm();
					info([{ text: `✓ 已删除定时任务 ${id}`, tone: "success" }]);
					return;
				}

				const list = jobs();
				if (list.length === 0) {
					info([{ text: "当前没有定时任务。", tone: "muted" }]);
					return;
				}
				if (ctx.mode !== "tui") {
					info([{ text: "✗ 非交互模式需要显式指定 id：/cron delete <id>", tone: "error" }]);
					return;
				}
				const labels = list.map((job) => `${job.id} · ${cronToHumanZh(job.cron)} · ${truncate(job.prompt, 40)}`);
				const chosen = await ctx.ui.select("删除哪个定时任务？", labels);
				if (!chosen) return;
				const target = list[labels.indexOf(chosen)];
				if (!target) return;
				removeJob(target.id);
				arm();
				info([{ text: `✓ 已删除定时任务 ${target.id}`, tone: "success" }]);
				return;
			}

			const interval = parseInterval(head);
			if (interval === null) {
				info([{ text: `✗ 无法识别的间隔「${head}」`, tone: "error" }, { text: "", tone: "dim" }, ...USAGE_LINES]);
				return;
			}

			const once = rest[0]?.toLowerCase() === "once";
			const prompt = (once ? rest.slice(1) : rest).join(" ").trim();
			if (!prompt) {
				info([{ text: "✗ 缺少 prompt", tone: "error" }, { text: "", tone: "dim" }, ...USAGE_LINES]);
				return;
			}

			const conversion = intervalToCron(interval);
			const result = once
				? createJob(oneShotCron(interval, new Date()).cron, prompt, false)
				: createJob(conversion.cron, prompt, true);

			if (!result.ok) {
				const reason =
					result.code === "too-many"
						? `定时任务数已达上限 ${MAX_JOBS}，请先用 /cron delete 删掉一个`
						: result.code === "invalid-cron"
							? "内部错误：生成了非法的 cron 表达式"
							: "内部错误：该排期在未来一年内没有匹配时刻";
				info([{ text: `✗ 创建失败：${reason}`, tone: "error" }]);
				return;
			}

			const { job, next } = result;
			const now = Date.now();
			const confirmation: CronInfoLine[] = [
				{ text: `✓ 已创建${once ? "一次性" : "循环"}定时任务 ${job.id}`, tone: "success" },
				{
					text: once
						? `触发时刻 ${formatWhen(next.getTime(), now)}`
						: `${cronToHumanZh(job.cron)} · 下次触发 ${formatWhen(next.getTime(), now)}`,
					tone: "text",
				},
			];
			if (!once && conversion.note) confirmation.push({ text: `⚠ ${conversion.note}`, tone: "warning" });
			if (!once) confirmation.push({ text: `取消：/cron delete ${job.id}`, tone: "dim" });
			info(confirmation);

			// D6：循环任务创建后立即执行一次；一次性任务等它唯一的触发时刻
			if (!once) runImmediately(job);
		},
	});

	// ─── 工具 ───

	const fail = (action: CronToolDetails["action"], message: string) => ({
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: { action, error: message } as CronToolDetails,
	});

	pi.registerTool({
		name: "cron",
		label: "Cron",
		description: "Create, list, or delete cron jobs; a cron job delivers a prompt to you on a cron schedule.",
		parameters: Type.Object({
			action: StringEnum(["create", "list", "delete"] as const, {
				description: "create: schedule a cron job. list: show cron jobs. delete: cancel a cron job by id.",
			}),
			cron: Type.Optional(
				Type.String({
					description:
						"5-field cron (minute hour day-of-month month day-of-week), local time. Required for create.",
				}),
			),
			prompt: Type.Optional(
				Type.String({ description: "Prompt delivered verbatim on every fire. Required for create." }),
			),
			recurring: Type.Optional(
				Type.Boolean({ description: "Default true. false = fire once, then delete the cron job." }),
			),
			id: Type.Optional(Type.String({ description: "Cron job id. Required for delete." })),
		}),

		async execute(_toolCallId, params) {
			switch (params.action) {
				case "create": {
					if (!params.cron || !params.prompt) return fail("create", "create requires both cron and prompt.");

					const result = createJob(params.cron, params.prompt, params.recurring !== false);
					if (!result.ok) {
						if (result.code === "invalid-cron") {
							return fail(
								"create",
								`invalid cron expression '${params.cron}'. Expected 5 fields: minute hour day-of-month month day-of-week.`,
							);
						}
						if (result.code === "no-match") {
							return fail(
								"create",
								`cron expression '${params.cron}' does not match any calendar date in the next year.`,
							);
						}
						return fail("create", `too many cron jobs (max ${MAX_JOBS}). Delete one first.`);
					}

					const { job, next } = result;
					const when = next.toLocaleString();
					const tail = "Cron jobs are process-scoped and are cleared when pi exits.";
					return {
						content: [
							{
								type: "text" as const,
								text: job.recurring
									? `Created recurring cron job ${job.id} (${cronToHuman(job.cron)}). Next fire ${when}. Run its prompt now as the first iteration instead of waiting for the first fire. ${tail}`
									: `Created one-shot cron job ${job.id} (${cronToHuman(job.cron)}). It fires once at ${when}, then deletes itself. ${tail}`,
							},
						],
						details: { action: "create" } as CronToolDetails,
					};
				}

				case "list": {
					const list = jobs();
					if (list.length === 0) {
						return {
							content: [{ type: "text" as const, text: "No cron jobs." }],
							details: { action: "list", jobs: [] } as CronToolDetails,
						};
					}

					const lines = list.map((t) => {
						const next = Number.isFinite(t.nextFireAt)
							? `next in ${relative(t.nextFireAt - Date.now())}`
							: "waiting for idle";
						const fired = t.fireCount > 0 ? ` · fired ${t.fireCount}x` : "";
						const missed = t.backlog > 0 ? ` · ${t.backlog} missed` : "";
						const kind = t.recurring ? "" : " · one-shot";
						return `${t.id} — ${cronToHuman(t.cron)} (${t.cron}) · ${next}${fired}${missed}${kind}: ${truncate(t.prompt, PROMPT_PREVIEW)}`;
					});

					return {
						content: [{ type: "text" as const, text: lines.join("\n") }],
						details: {
							action: "list",
							jobs: list.map((t) => ({
								id: t.id,
								cron: t.cron,
								human: cronToHuman(t.cron),
								prompt: t.prompt,
								recurring: t.recurring,
								fireCount: t.fireCount,
								nextFireAt: Number.isFinite(t.nextFireAt) ? t.nextFireAt : null,
							})),
						} as CronToolDetails,
					};
				}

				case "delete": {
					if (!params.id) return fail("delete", "id is required for delete.");
					if (!removeJob(params.id)) return fail("delete", `no cron job with id '${params.id}'.`);
					arm();
					return {
						content: [{ type: "text" as const, text: `Deleted cron job ${params.id}.` }],
						details: { action: "delete" } as CronToolDetails,
					};
				}

				default:
					return fail("list", `unknown action '${String(params.action)}'.`);
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("cron ")) + theme.fg("muted", args.action);
			if (args.cron) text += ` ${theme.fg("dim", args.cron)}`;
			if (args.id) text += ` ${theme.fg("accent", args.id)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as CronToolDetails | undefined;
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);

			const first = result.content[0];
			const text = first?.type === "text" ? first.text : "";
			if (details?.action === "list" && (details.jobs?.length ?? 0) > 0 && !expanded) {
				const shown = details.jobs!.slice(0, 5);
				const head = theme.fg("muted", `${details.jobs!.length} cron job(s):`);
				const rows = shown.map(
					(t) =>
						`${theme.fg("accent", t.id)} ${theme.fg("muted", t.human)} ${theme.fg("dim", `(${t.cron})`)} ${theme.fg("muted", truncate(t.prompt, 40))}`,
				);
				const more = details.jobs!.length > shown.length
					? `\n${theme.fg("dim", `... ${details.jobs!.length - shown.length} more`)}`
					: "";
				return new Text([head, ...rows].join("\n") + more, 0, 0);
			}
			return new Text(theme.fg("muted", text), 0, 0);
		},
	});
}
