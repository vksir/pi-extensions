/**
 * pi-bg —— 后台运行的 bash 与 codemode
 *
 * 三个工具 + 一个人工入口，全部与内置工具的启用状态联动：
 *   bash_bg {command, timeout?}                    bash 的后台版本
 *   codemode_bg {code}                             codemode 的后台版本
 *   bg_job {action: list | show | kill, id?}           查看 / 终止
 *   /bg [kill <id>]                                人工入口，0 常驻
 *
 * 任务 id 在一切文本里都写成 `bg_job <id>`（`jobRef`）：裸 8 位十六进制 id 与子 Agent 的
 * id 同形，模型会误调 `get_subagent_result`。模型可见文案统一在 `extensions/prompt/pi-bg.ts`。
 *
 * 两个后台工具都是**薄壳**，执行一律委托内置实现（ADR-0006）：
 *   - bash_bg 走 `ctx.executeTool("bash", ...)`；
 *   - codemode_bg 走 `createCodemodeExtension()` 造出的工具定义——`codemode` 的暴露是
 *     `model-only`，`ctx.executeTool` 根本调不到它（只认 direct / codemode / deferred），
 *     而 pi 只导出工厂、不导出沙箱，所以用一个吞掉 `registerTool` 的 shim 把真定义接住。
 *
 * 前台 bash / codemode 有**等待预算**（`pi-bg.promoteAfterSeconds`，默认 180 秒，<= 0 关闭）：
 * 到点还没结束就把执行中的命令/脚本转成后台任务，立刻把控制权交还模型，进程/沙箱不重启
 * （ADR-0010）。实现方式是用同名注册覆盖内置工具，只换 `execute` 与 `renderResult`：
 *   - 传给它的是**自己的** AbortController，晋升前把父轮 Esc 转发下去，晋升时摘掉监听；
 *   - 晋升只发生在**模型直接调用**的那一层：嵌套调用（脚本里的 `tools.bash`、
 *     `bash_bg` 的委托）用 `tool_call` 事件的 `parentToolCallId` 与 id 形状判定，一律直通。
 *
 * 启用联动：三个工具都在 `session_start` 里注册，注册前读 `getActiveTools()`——bash /
 * codemode 未启用就根本不注册；schema 直接复用 `getAllTools()` 里内置工具的那一份，所以
 * pi 给内置工具加参数时这里不用跟。`prepareLoadout` 只兜「会话中途被 setActiveTools 关掉」
 * 这条 `session_start` 快照覆盖不到的路径。
 *
 * 完成回传走 `pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })`，
 * 与 Agent 后台模式同一通道：当前 turn 的工具跑完、下次 LLM 调用前投递；agent 空闲时立刻起一轮。
 * 绝不把工具入参的 signal 传给后台任务——父轮 Esc 会连坐。结果只有一条出口：
 * 结束后作为 `pi-bg` 消息回传；`bg_job` 不再兼任「等」。
 *
 * 存续域与会话绑定：`/new`、`/reload`、`/resume`、`/fork`、退出都会触发 `session_shutdown`，
 * 一律 abort 在跑任务；`/new` 与 `/reload` 还会重建扩展实例，任务表随之清空。唯一不伴随
 * shutdown 的 `session_start` 来自 `rebindCurrentSession`（同一会话内重绑定），那里保留在跑
 * 任务才是对的。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import {
	createBashToolDefinition,
	createCodemodeExtension,
	keyHint,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type ExtensionAPI,
	type ExtensionToolContext,
	type Theme,
	type ToolDefinition,
	type ToolLoadout,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerBusyProbe } from "./lib/activity.ts";
import { ERROR_PREFIX, piBgPrompt } from "./prompt/pi-bg.ts";
import {
	type BgJob,
	type BgKind,
	type BgOrigin,
	KEEP_FINISHED,
	MAX_RUNNING,
	findJob,
	newJobId,
	originLabel,
	pruneFinished,
	runningJobs,
	summarizeLabel,
} from "./lib/bg/jobs.ts";
import {
	bgCommandLines,
	budgetText,
	deliveryContent,
	elapsedText,
	errorText,
	listText,
	promoteText,
	splitDelivery,
	startText,
	statusText,
} from "./lib/bg/format.ts";
import { renderLineBox, type EntryLine } from "./lib/render.ts";
import { readExtensionSettings } from "./lib/settings.ts";
import { truncate } from "./lib/text.ts";

const CUSTOM_TYPE = "pi-bg";
const INFO_TYPE = "pi-bg-info";
const SETTINGS_KEY = "pi-bg";
/** 不配置时前台工具的等待预算：3 分钟。 */
const DEFAULT_PROMOTE_SECONDS = 180;
/** 嵌套调用的 toolCallId 形状：`<调用方 id>/<n>`。 */
const NESTED_ID = /\//;

interface PiBgSettings {
	promoteAfterSeconds?: number;
}

/** 后台执行的最小结果契约；两种后端（executeTool / 接住的内置定义）都归一到这里。 */
interface JobOutcome {
	result: ToolOutcome["result"];
	isError: boolean;
}

type ToolOutcome = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;

/** 在跑任务额外握着中止句柄；`bg_job kill` 与 `session_shutdown` 都走它。 */
interface LiveJob extends BgJob {
	controller: AbortController;
}

interface BgMessageDetails {
	id: string;
	kind: BgKind;
	label: string;
	status: BgJob["status"];
	text: string;
}

type BgJobSnapshot = {
	id: string;
	kind: BgKind;
	origin: BgOrigin;
	label: string;
	status: BgJob["status"];
	text: string;
};

interface BgToolDetails {
	action: "list" | "show" | "kill";
	error?: string;
	jobs?: BgJobSnapshot[];
}

interface BgInfoEntry {
	lines: EntryLine[];
}

/** 测试缝：让单测替换内置 bash 的构造，不真的起进程。 */
export interface RegisterPiBgOptions {
	createBash?: (cwd: string) => ToolDefinition;
}

export default function piBg(pi: ExtensionAPI): void {
	registerPiBg(pi, captureCodemodeTool(pi));
}

/**
 * 造一个用完就丢的 codemode 扩展实例，只为接住它注册的工具定义。
 * 只依赖根导出 `createCodemodeExtension`（SDK 用户本来就用它自己加 codemode），
 * 其余 PI 方法原样转给真实实例，因此接住的定义与内置逐字一致。
 */
export function captureCodemodeTool(pi: ExtensionAPI): ToolDefinition | null {
	try {
		let captured: ToolDefinition | undefined;
		const shim = new Proxy(pi, {
			get(target, property) {
				if (property === "registerTool") {
					return (definition: ToolDefinition) => {
						captured = definition;
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		createCodemodeExtension()(shim);
		return captured?.name === "codemode" ? captured : null;
	} catch {
		return null;
	}
}

export function registerPiBg(pi: ExtensionAPI, codemode: ToolDefinition | null, options: RegisterPiBgOptions = {}): void {
	const jobs: LiveJob[] = [];
	/** 会话已关闭：此后不再回传（任务本身在此期间被 kill） */
	let closed = false;
	/** 工具是否已经注册过；`bindExtensions()` 可在同一 runner 上二次触发 session_start。 */
	let registered = false;
	/** 前台工具的等待预算（毫秒）；0 表示关闭，不注册覆盖版。 */
	let budgetMs = 0;
	/** 当前会话的工作目录；重建内置 bash 时用它绑定 cwd。 */
	let sessionCwd = process.cwd();
	/** 嵌套调用的 toolCallId：脚本或其它工具发起的调用永不晋升。 */
	const nestedCalls = new Set<string>();
	/** 晋升那一行的原始 partial 结果，只给 TUI 渲染用，不进 transcript。 */
	const promotedRows = new Map<string, AgentToolResult<any>>();

	// 让 pi-herdr-agent 的空闲销毁看到本进程还有在跑的后台任务：销毁进程等于把它们一起扔掉。
	registerBusyProbe("pi-bg", () => runningJobs(jobs).length > 0);

	// 嵌套判定：`tool_call` 的 parentToolCallId 是权威来源，id 形状是兜底。
	pi.on("tool_call", (event) => {
		if (event.parentToolCallId) nestedCalls.add(event.toolCallId);
	});
	pi.on("tool_execution_end", (event) => {
		nestedCalls.delete(event.toolCallId);
	});

	pi.on("session_start", (_event, ctx) => {
		closed = false;
		sessionCwd = ctx.cwd || process.cwd();
		budgetMs = readBudgetMs();
		// 只在「不伴随 session_shutdown 的重绑定」路径上有意义（rebindCurrentSession）：
		// 真正的会话切换会重建扩展实例，任务表本来就是空的。
		for (let index = jobs.length - 1; index >= 0; index -= 1) {
			if (jobs[index]!.status !== "running") jobs.splice(index, 1);
		}
		if (registered) return;
		registered = true;
		registerTools();
	});

	// 五种 reason 都是「离开这个会话」：/new、/reload、/resume、/fork、quit。
	// 一律尽力中止在跑任务（Windows 上 MSYS 子里程可能残留，与前台 bash 按 Esc 同一行为）。
	pi.on("session_shutdown", () => {
		closed = true;
		for (const job of jobs) {
			if (job.status !== "running") continue;
			job.status = "killed";
			job.controller.abort();
		}
	});

	function readBudgetMs(): number {
		const settings = readExtensionSettings<PiBgSettings>(pi, SETTINGS_KEY);
		const seconds = settings.promoteAfterSeconds;
		if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
			return typeof seconds === "number" && seconds <= 0 ? 0 : DEFAULT_PROMOTE_SECONDS * 1000;
		}
		return seconds * 1000;
	}

	function kill(job: LiveJob, reason: "killed"): void {
		if (job.status !== "running") return;
		job.status = reason;
		job.controller.abort();
	}

	function deliver(job: LiveJob): void {
		if (closed) return;
		pi.sendMessage<BgMessageDetails>(
			{
				customType: CUSTOM_TYPE,
				content: deliveryContent(job),
				display: true,
				details: {
					id: job.id,
					kind: job.kind,
					label: job.label,
					status: job.status,
					text: statusText(job),
				},
			},
			// 与 Agent 后台模式一致：不打断当前 LLM 调用，工具跑完、下次调用前投递；空闲则立刻起一轮
			{ deliverAs: "steer", triggerTurn: true },
		);
	}

	function newJob(
		kind: BgKind,
		origin: BgOrigin,
		label: string,
		input: Record<string, unknown>,
		startedAt: number,
		controller: AbortController = new AbortController(),
	): LiveJob {
		const job: LiveJob = {
			id: newJobId((id) => jobs.some((candidate) => candidate.id === id)),
			kind,
			origin,
			label,
			input,
			startedAt,
			status: "running",
			controller,
		};
		jobs.push(job);
		pruneFinished(jobs, KEEP_FINISHED);
		return job;
	}

	/** 把一次执行挂到任务上：结束时落状态、叫醒等待者或回传。 */
	function launch(job: LiveJob, run: () => Promise<JobOutcome>): LiveJob {
		void (async () => {
			try {
				const outcome = await run();
				if (job.status === "killed") return;
				job.output = resultText(outcome.result) || job.output;
				job.exitCode = exitCodeOf(outcome.result);
				job.fullOutputPath = job.fullOutputPath ?? fullOutputPathOf(outcome.result);
				job.status = outcome.isError ? "failed" : "done";
			} catch (error) {
				if (job.status === "killed") return;
				job.status = "failed";
				job.output = errorMessage(error);
			} finally {
				job.durationMs = Date.now() - job.startedAt;
				// 被 kill 的任务不回传：动手的人已经拿到 bg_job kill 的结果
				if (job.status === "done" || job.status === "failed") deliver(job);
			}
		})();
		return job;
	}

	/**
	 * 起一个后台任务并立刻返回。`run` 只受我们自己的 controller 约束，
	 * 与发起它的 tool call 的生命周期无关（父轮 Esc 不会连坐）。
	 */
	function start(kind: BgKind, label: string, input: Record<string, unknown>, run: (signal: AbortSignal) => Promise<JobOutcome>): LiveJob | null {
		if (runningJobs(jobs).length >= MAX_RUNNING) return null;
		const job = newJob(kind, "start", label, input, Date.now());
		return launch(job, () => run(job.controller.signal));
	}

	/**
	 * 前台执行：先等到点，到点就转后台。
	 *
	 * 传给自己 controller 的信号与父轮解耦，晋升时摘掉父轮的 Esc 转发，
	 * 于是「转后台」之后这一轮怎么结束都不再连坐。
	 */
	async function watch(spec: {
		kind: BgKind;
		label: string;
		input: Record<string, unknown>;
		toolCallId: string;
		signal: AbortSignal | undefined;
		onUpdate: AgentToolUpdateCallback<any> | undefined;
		run: (signal: AbortSignal, onUpdate: AgentToolUpdateCallback<any>) => Promise<AgentToolResult<any>>;
	}): Promise<AgentToolResult<any>> {
		const startedAt = Date.now();
		const controller = new AbortController();
		const forwardAbort = (): void => controller.abort();
		if (spec.signal?.aborted) controller.abort();
		else spec.signal?.addEventListener("abort", forwardAbort, { once: true });

		let partial: AgentToolResult<any> | undefined;
		let lastOutputAt: number | undefined;
		let callCount = 0;
		let currentCall: { key: number; name: string; since: number } | undefined;

		const onUpdate = (update: AgentToolResult<any>): void => {
			partial = update;
			const now = Date.now();
			const text = resultText(update);
			if (text.trim().length > 0) lastOutputAt = now;
			const calls = Array.isArray((update.details as { calls?: unknown } | undefined)?.calls)
				? ((update.details as { calls: Array<{ name: string; status: string }> }).calls ?? [])
				: undefined;
			if (calls) {
				callCount = calls.length;
				const index = calls.findIndex((call) => call.status === "running");
				if (index < 0) currentCall = undefined;
				else if (currentCall?.key !== index) currentCall = { key: index, name: calls[index]!.name, since: now };
			}
			spec.onUpdate?.(update);
		};

		let settled: { outcome: JobOutcome } | { error: unknown } | undefined;
		const runPromise = spec.run(controller.signal, onUpdate).then(
			(result) => {
				settled = { outcome: { result, isError: result.isError === true } };
				return settled;
			},
			(error: unknown) => {
				settled = { error };
				return settled;
			},
		);

		const budget = budgetMs > 0 ? budgetMs : 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const budgetHit = new Promise<"budget">((resolve) => {
			if (budget <= 0) return;
			timer = setTimeout(() => resolve("budget"), budget);
		});

		const first = await Promise.race([runPromise, budgetHit]);
		if (first !== "budget") return finishDirect(first);
		// 定时器先到：再看一眼是否刚好已经结束（避免把已完成的结果说成「还在跑」）。
		const already = settled;
		if (already) return finishDirect(already);
		return promote();

		function finishDirect(value: { outcome: JobOutcome } | { error: unknown }): AgentToolResult<any> {
			if (timer !== undefined) clearTimeout(timer);
			spec.signal?.removeEventListener("abort", forwardAbort);
			if ("error" in value) throw value.error;
			return value.outcome.result;
		}

		function promote(): AgentToolResult<any> {
			if (timer !== undefined) clearTimeout(timer);
			// 晋升即与父轮解绑：之后 Esc 不再杀这条命令
			spec.signal?.removeEventListener("abort", forwardAbort);

			const job = newJob(spec.kind, "promote", spec.label, spec.input, startedAt, controller);
			job.output = resultText(partial) || undefined;
			launch(job, async () => {
				const value = await runPromise;
				if ("error" in value) throw value.error;
				return value.outcome;
			});

			const ran = elapsedText(Date.now() - startedAt);
			const activity =
				spec.kind === "bash"
					? lastOutputAt === undefined
						? piBgPrompt.results.activityNoOutput()
						: piBgPrompt.results.activityLastOutput(elapsedText(Date.now() - lastOutputAt))
					: piBgPrompt.results.activityCalls(
							callCount,
							currentCall ? `${currentCall.name} (${elapsedText(Date.now() - currentCall.since)})` : undefined,
						);

			if (partial) {
				promotedRows.set(spec.toolCallId, partial);
				// 只为渲染保留最近几次晋升的画面，避免长会话里累积大输出
				while (promotedRows.size > 16) {
					const oldest = promotedRows.keys().next().value;
					if (oldest === undefined) break;
					promotedRows.delete(oldest);
				}
			}
			return {
				content: [{ type: "text" as const, text: promoteText(job, ran, activity) }],
				details: { promoted: job.id },
			};
		}
	}

	const fail = (action: BgToolDetails["action"], clause: string) => ({
		content: [{ type: "text" as const, text: errorText(clause) }],
		details: { action, error: clause } as BgToolDetails,
	});

	const limited = () => fail("list", piBgPrompt.results.tooMany(MAX_RUNNING));

	const startedReply = (job: LiveJob) => ({
		content: [{ type: "text" as const, text: startText(job) }],
		details: { action: "list" as const, jobs: [snapshot(job)] },
	});

	// ─── 工具注册（session_start，跟着启用状态走） ───

	function registerTools(): void {
		const all = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
		const active = new Set(pi.getActiveTools());

		// bash 的 schema 与执行都来自注册表；codemode 的 execute 只有 shim 有，所以 schema
		// 也用 shim 那份，保证同源（`ctx.executeTool` 调不到 model-only 的 codemode）。
		const bash = active.has("bash") ? all.get("bash") : undefined;
		const codemodeBackend = active.has("codemode") ? codemode : undefined;

		// 等待预算只作用于模型直接调用的那一层；关闭时（<= 0）连覆盖都不注册。
		if (budgetMs > 0) {
			if (bash) registerPromotingBash();
			if (codemodeBackend) registerPromotingCodemode(codemodeBackend);
		}

		// 规则里的阈值取预算；关闭时退回默认值——「长命令用后台工具」这条建议不依赖兜底是否开启。
		const guidelineThreshold = budgetText((budgetMs > 0 ? budgetMs : DEFAULT_PROMOTE_SECONDS * 1000) / 1000);

		if (bash) {
			pi.registerTool({
				name: "bash_bg",
				label: "Bash (background)",
				description: piBgPrompt.declarations.bashBg.description,
				promptSnippet: piBgPrompt.system.snippets.bashBg,
				promptGuidelines: [
					piBgPrompt.system.guidelines.bashBg(guidelineThreshold),
					piBgPrompt.system.guidelines.bashBgDone,
				],
				// 直接复用内置工具的 schema：pi 给 bash 加参数时这里自动跟上
				parameters: bash.parameters,
				prepareLoadout: hideWhenUnavailable("bash", "bash_bg"),

				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					const input = params as { command: string; timeout?: number };
					const job = start("bash", summarizeLabel(input.command), { ...input }, async (signal) => {
						const outcome = await ctx.executeTool("bash", input, { signal });
						return { result: outcome.result, isError: outcome.isError };
					});
					if (!job) return limited();
					return startedReply(job);
				},

				renderCall(args, theme, context) {
					const input = args as { command?: string };
					return new Text(
						theme.fg("toolTitle", theme.bold("bash_bg ")) +
							theme.fg("muted", previewArg(input.command ?? "", context.expanded, theme)),
						0,
						0,
					);
				},

				renderResult: renderStarted,
			});
		}

		if (codemodeBackend) {
			pi.registerTool({
				name: "codemode_bg",
				label: "Codemode (background)",
				description: piBgPrompt.declarations.codemodeBg.description,
				promptSnippet: piBgPrompt.system.snippets.codemodeBg,
				promptGuidelines: [
					piBgPrompt.system.guidelines.codemodeBg(guidelineThreshold),
					piBgPrompt.system.guidelines.codemodeBgDone,
				],
				parameters: codemodeBackend.parameters,
				prepareLoadout: hideWhenUnavailable("codemode", "codemode_bg"),

				async execute(toolCallId, params, _signal, _onUpdate, ctx) {
					const input = params as { code: string };
					const job = start("codemode", summarizeLabel(input.code), { ...input }, async (signal) => {
						const result = await codemodeBackend.execute(toolCallId, input, signal, undefined, ctx);
						return { result, isError: result.isError === true };
					});
					if (!job) return limited();
					return startedReply(job);
				},

				renderCall(args, theme, context) {
					const input = args as { code?: string };
					return new Text(
						theme.fg("toolTitle", theme.bold("codemode_bg ")) +
							theme.fg("muted", previewArg(input.code ?? "", context.expanded, theme)),
						0,
						0,
					);
				},

				renderResult: renderStarted,
			});
		}

		// 没有任何后端可用时它毫无意义，所以一起联动。
		if (!bash && !codemodeBackend) return;

		pi.registerTool({
			name: "bg_job",
			label: "Background jobs",
			description: piBgPrompt.declarations.bgJob.description,
			promptSnippet: piBgPrompt.system.snippets.bgJob,
			parameters: Type.Object({
				action: StringEnum(["list", "show", "kill"] as const, {
					description: piBgPrompt.declarations.bgJob.parameters.action,
				}),
				id: Type.Optional(Type.String({ description: piBgPrompt.declarations.bgJob.parameters.id })),
			}),
			prepareLoadout: hideWhenUnavailable(["bash", "codemode"], "bg_job", "any"),

			async execute(_toolCallId, params, _signal) {
				if (params.action === "show") {
					if (!params.id) return fail("show", piBgPrompt.results.idRequired("show"));
					const job = findJob(jobs, params.id);
					if (!job) return fail("show", piBgPrompt.results.unknownJob(params.id));
					return {
						content: [{ type: "text" as const, text: showText(job) }],
						details: { action: "show" as const, jobs: [snapshot(job)] },
					};
				}

				if (params.action === "kill") {
					if (!params.id) return fail("kill", piBgPrompt.results.idRequired("kill"));
					const job = findJob(jobs, params.id);
					if (!job) return fail("kill", piBgPrompt.results.unknownJob(params.id));
					if (job.status !== "running") {
						return {
							content: [
								{
									type: "text" as const,
									text: piBgPrompt.results.alreadyFinished(
										job.id,
										job.exitCode,
										job.durationMs === undefined ? undefined : elapsedText(job.durationMs),
									),
								},
							],
							details: { action: "kill" as const },
						};
					}
					kill(job, "killed");
					return {
						content: [{ type: "text" as const, text: piBgPrompt.results.killed(job.id) }],
						details: { action: "kill" as const },
					};
				}

				return {
					content: [{ type: "text" as const, text: listText(jobs) }],
					details: { action: "list" as const, jobs: jobs.map(snapshot) },
				};
			},

			renderCall(args, theme) {
				const head = `${theme.fg("toolTitle", theme.bold("bg_job"))} ${theme.fg("muted", args.action)}`;
				return new Text(args.id ? `${head} ${theme.fg("muted", args.id)}` : head, 0, 0);
			},

			renderResult(result, { expanded }, theme) {
				const details = result.details as BgToolDetails | undefined;
				if (details?.error) return new Text(theme.fg("error", `${ERROR_PREFIX}${details.error}`), 0, 0);
				const first = result.content[0];
				const text = first?.type === "text" ? first.text : "";

				if (details?.action === "list" && (details.jobs?.length ?? 0) > 0 && !expanded) {
					const shown = details.jobs!.slice(0, 5);
					const head = theme.fg("muted", `${details.jobs!.length} background job(s):`);
					const rows = shown.map(
						(job) =>
							`${theme.fg("accent", `bg_job ${job.id}`)} ${theme.fg("muted", job.kind)} ${theme.fg("dim", job.text)} ${theme.fg("muted", truncate(job.label, 40))}`,
					);
					const more =
						details.jobs!.length > shown.length
							? `\n${theme.fg("dim", `... ${details.jobs!.length - shown.length} more`)}`
							: "";
					return new Text([head, ...rows].join("\n") + more, 0, 0);
				}

				return new Text(theme.fg("muted", text), 0, 0);
			},
		});
	}

	/**
	 * 覆盖内置 `bash`：只换 `execute` 与 `renderResult`，其余字段（description、参数 schema、
	 * outputSchema、renderCall）全部来自内置定义的同一个构造函数，因此随 pi 自动跟。
	 *
	 * 重建用的 `shellPath` / `commandPrefix` 与 pi core 取自同一对设置项（ADR-0010 记了这条
	 * 同源风险，`tests/pi-bg.test.ts` 有金样断言，pi 升级改了 bash 时会在测试里立刻炸出来）。
	 */
	function registerPromotingBash(): void {
		const settings = pi.getSettings() as { shellPath?: string; shellCommandPrefix?: string };
		const base: ToolDefinition<any, any, any> =
			options.createBash?.(sessionCwd) ??
			createBashToolDefinition(sessionCwd, {
				shellPath: settings.shellPath,
				commandPrefix: settings.shellCommandPrefix,
			});

		pi.registerTool({
			...base,
			execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
				const input = params as { command: string; timeout?: number };
				// 嵌套调用不晋升。显式 timeout 仍然照转：timeout 一路透传给内置实现，
				// 到点照样失败，只是不再让整轮陪着它一起卡住（E2E 发现模型常自己加 timeout，
				// 一旦因此跳过晋升，兜底就等于不存在）。
				if (isNested(toolCallId)) {
					return base.execute(toolCallId, params, signal, onUpdate, ctx);
				}
				return watch({
					kind: "bash",
					label: summarizeLabel(input.command),
					input: { ...input },
					toolCallId,
					signal,
					onUpdate,
					run: (inner, forward) => base.execute(toolCallId, params, inner, forward, ctx),
				});
			},
			renderResult: promotingRenderResult(base, "bash"),
		});
	}

	/** 覆盖内置 `codemode`：`model-only` 工具，永远在顶层调用，不存在嵌套分支。 */
	function registerPromotingCodemode(backend: ToolDefinition<any, any, any>): void {
		pi.registerTool({
			...backend,
			execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
				const input = params as { code: string };
				return watch({
					kind: "codemode",
					label: summarizeLabel(input.code),
					input: { ...input },
					toolCallId,
					signal,
					onUpdate,
					run: (inner, forward) => backend.execute(toolCallId, params, inner, forward, ctx),
				});
			},
			renderResult: promotingRenderResult(backend, "codemode"),
		});
	}

	/** 非晋升分支完全委托内置渲染；晋升分支保留晋升瞬间的画面并追加一行标记。 */
	function promotingRenderResult(base: ToolDefinition<any, any, any>, kind: BgKind) {
		return (result: AgentToolResult<any>, options: ToolRenderResultOptions, theme: Theme, context: any) => {
			const promoted = (result.details as { promoted?: string } | undefined)?.promoted;
			if (!promoted) {
				const component = base.renderResult?.(result, options, theme, context);
				if (component) return component;
				const text = result.content[0];
				return new Text(theme.fg("muted", text?.type === "text" ? text.text : ""), 0, 0);
			}

			const box = new Container();
			const partial = promotedRows.get(context.toolCallId);
			const inner = partial ? base.renderResult?.(partial, { ...options, isPartial: false }, theme, context) : undefined;
			if (inner) box.addChild(inner);
			else if (kind === "codemode") box.addChild(new Text(theme.fg("muted", "script still running"), 0, 0));
			box.addChild(new Text(promotedMarker(theme, promoted), 0, 0));
			return box;
		};
	}

	/**
	 * 嵌套调用（脚本里的 `tools.bash`、`bash_bg` 的委托）永不晋升：
	 * `tool_call` 的 parentToolCallId 是权威来源，id 形状是兜底。
	 */
	function isNested(toolCallId: string): boolean {
		return nestedCalls.has(toolCallId) || NESTED_ID.test(toolCallId);
	}

	/** `bg_job show` 的正文：头行、输入字段、可选的全量输出路径、输出。 */
	function showText(job: LiveJob): string {
		const field = job.kind === "bash" ? "command" : "script";
		const lines = [piBgPrompt.results.showHead(job.id, originLabel(job), statusText(job))];
		// 入参的键名是工具自己的（bash 用 command，codemode 用 code），显示的字段名另算
		const input = job.kind === "bash" ? job.input?.command : job.input?.code;
		if (typeof input === "string") lines.push(piBgPrompt.results.showInput(field, input));
		if (job.fullOutputPath) lines.push(piBgPrompt.results.showFullOutput(job.fullOutputPath));
		lines.push("");
		const output = job.output && job.output.trim().length > 0 ? job.output : undefined;
		if (job.status === "running" && output) lines.push(piBgPrompt.results.showOutputSoFar());
		lines.push(
			output ??
				(job.status === "running" ? piBgPrompt.results.showNoOutputYet() : piBgPrompt.results.noOutput()),
		);
		return lines.join("\n");
	}

	// ─── /bg 命令（人工入口） ───

	const info = (lines: EntryLine[]): void => pi.appendEntry<BgInfoEntry>(INFO_TYPE, { lines });

	pi.registerEntryRenderer<BgInfoEntry>(INFO_TYPE, (entry, _options, theme) =>
		renderLineBox(theme, entry.data?.lines ?? []),
	);

	pi.registerCommand("bg", {
		description: "后台任务：/bg | /bg show <id> | /bg kill <id>",
		getArgumentCompletions: (prefix) => {
			if (prefix.trim().includes(" ")) return null;
			const typed = prefix.trim();
			const options = ["kill", "show", ...runningJobs(jobs).map((job) => job.id)];
			const items = options.filter((option) => option.startsWith(typed)).map((option) => ({ value: option, label: option }));
			return items.length > 0 ? items : null;
		},
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim();

			if (!args) {
				const status = budgetMs > 0 ? `转后台：${budgetLabel(budgetMs)}` : "转后台：关闭";
				info([
					{ text: status, tone: "muted" },
					{ text: "", tone: "dim" },
					...bgCommandLines(jobs).map(
						(text, index) => ({ text, tone: index < 2 ? "text" : "dim" }) as EntryLine,
					),
					{ text: "", tone: "dim" },
					{ text: "查看：/bg show <id>　终止：/bg kill <id>", tone: "dim" },
				]);
				return;
			}

			if (args === "show" || args.startsWith("show ")) {
				const target = args.slice(4).trim();
				if (!target) {
					info([{ text: "✗ 需要任务 id：/bg show <id>", tone: "error" }]);
					return;
				}
				const job = findJob(jobs, target);
				if (!job) {
					info([{ text: `✗ 没有 id 为 ${target} 的任务，用 /bg 查看`, tone: "error" }]);
					return;
				}
				info(showText(job).split("\n").map((text) => ({ text, tone: "text" }) as EntryLine));
				return;
			}

			if (args === "kill" || args.startsWith("kill ")) {
				const target = args.slice(4).trim();
				const running = runningJobs(jobs);
				if (running.length === 0) {
					info([{ text: "没有在跑的后台任务。", tone: "muted" }]);
					return;
				}

				if (!target) {
					if (ctx.mode !== "tui") {
						info([{ text: "✗ 非交互模式需要显式指定 id：/bg kill <id>", tone: "error" }]);
						return;
					}
					const labels = running.map((job) => `${job.id} · ${job.kind} · ${truncate(job.label, 40)}`);
					const chosen = await ctx.ui.select("终止哪个后台任务？", labels);
					if (!chosen) return;
					const picked = running[labels.indexOf(chosen)];
					if (!picked) return;
					kill(picked, "killed");
					info([{ text: `✓ 已终止后台任务 ${picked.id}`, tone: "success" }]);
					return;
				}

				const job = findJob(jobs, target);
				if (!job) {
					info([{ text: `✗ 没有 id 为 ${target} 的任务，用 /bg 查看`, tone: "error" }]);
					return;
				}
				if (job.status !== "running") {
					info([{ text: `后台任务 ${job.id} 已经结束（${statusText(job)}）`, tone: "warning" }]);
					return;
				}
				kill(job, "killed");
				info([{ text: `✓ 已终止后台任务 ${job.id}`, tone: "success" }]);
				return;
			}

			info([{ text: `✗ 无法识别的参数「${args}」`, tone: "error" }, { text: "用法：/bg | /bg show <id> | /bg kill <id>", tone: "dim" }]);
		},
	});

	// ─── 完成消息渲染器 ───

	pi.registerMessageRenderer<BgMessageDetails>(CUSTOM_TYPE, (message, _options, theme) => {
		const details = message.details;
		const raw =
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("");
		const { head, body } = splitDelivery(raw);

		const tone = details?.status === "failed" ? "error" : details?.status === "done" ? "success" : "warning";
		// 头行由 details 重排：正文里的头行只给模型看，TUI 不重复渲染状态。
		// 风格与 agent 消息卡片一致：紫色标签，id / 种类 / 标签用灰色，只有状态带颜色。
		const headline = details
			? `${theme.bold(theme.fg("customMessageLabel", "bg_job"))} ${theme.fg("muted", details.id)}` +
				theme.fg("dim", ` · ${details.kind}_bg · ${details.label}`) +
				theme.fg(tone, ` — ${details.text}`)
			: theme.fg(tone, head);

		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(headline, 0, 0));
		if (body) box.addChild(new Text(body.split("\n").map((line) => theme.fg("muted", line)).join("\n"), 0, 0));
		return box;
	});
}

// ─── 启用联动 ───

/**
 * 内置工具离开 active 集合时，把本工具从请求的声明里移除。
 *
 * 只是「模型看不见」，工具仍然 active、仍能被 `ctx.executeTool` 与 codemode 脚本调到——
 * 这正好覆盖 `session_start` 快照管不到的那条路径（会话中途被 `setActiveTools` 关掉）。
 * `any` 表示任意一个名字在 declared 里就保留。
 */
function hideWhenUnavailable(
	source: string | readonly string[],
	self: string,
	mode: "all" | "any" = "all",
): (loadout: ToolLoadout) => { hiddenDeclarations: string[] } | undefined {
	const names = typeof source === "string" ? [source] : source;
	return (loadout) => {
		const declared = new Set(loadout.declared.map((tool) => tool.name));
		const available =
			mode === "any" ? names.some((name) => declared.has(name)) : names.every((name) => declared.has(name));
		return available ? undefined : { hiddenDeclarations: [self] };
	};
}

// ─── 结果解析 ───

/** 折叠时最多显示的命令行数，以及每行的字符上限。 */
const ARG_PREVIEW_LINES = 3;
const ARG_PREVIEW_CHARS = 100;

/**
 * 命令 / 脚本的折叠预览：最多 3 行、每行 100 字符，截断就提示 ctrl+o。
 * 展开时原样返回，换行交给 Text 处理（与内置 codemode 的 renderCall 同一思路）。
 */
function previewArg(text: string, expanded: boolean, theme: Theme): string {
	const normalized = text.replace(/\r/g, "").trimEnd();
	if (expanded) return normalized;
	const allLines = normalized.split("\n");
	const shown = allLines.slice(0, ARG_PREVIEW_LINES).map((line) => clipLine(line, ARG_PREVIEW_CHARS));
	const hiddenLines = allLines.length - shown.length;
	const clipped = hiddenLines > 0 || shown.some((line, index) => line !== allLines[index]);
	if (!clipped) return shown.join("\n");
	const detail = hiddenLines > 0 ? `${hiddenLines} more line${hiddenLines === 1 ? "" : "s"}` : "truncated";
	return `${shown.join("\n")}\n${theme.fg("dim", `… (${detail}, `)}${keyHint("app.tools.expand", "to expand")}${theme.fg("dim", ")")}`;
}

/** 按字符截断单行，不压缩空白（命令里的缩进有意义）。 */
function clipLine(line: string, max: number): string {
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function snapshot(job: BgJob): BgJobSnapshot {
	return { id: job.id, kind: job.kind, origin: job.origin, label: job.label, status: job.status, text: statusText(job) };
}

/** 晋升那一行的末行标记，TUI 专用文案。 */
function promotedMarker(theme: Theme, id: string): string {
	return `${theme.fg("muted", "→ ")}${theme.fg("accent", `bg_job ${id}`)}${theme.fg("muted", " in background")}`;
}

/** `/bg` 表头里的预算，人类可读的中文。 */
function budgetLabel(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds} 秒`;
	const minutes = seconds / 60;
	return Number.isInteger(minutes) ? `${minutes} 分钟` : `${seconds} 秒`;
}

/** bash_bg / codemode_bg 共用的结果渲染：只显示 id，正文在完成消息里。 */
function renderStarted(
	result: AgentToolResult<BgToolDetails | undefined>,
	_options: ToolRenderResultOptions,
	theme: Theme,
): Text {
	const details = result.details;
	if (details?.error) return new Text(theme.fg("error", `${ERROR_PREFIX}${details.error}`), 0, 0);
	const job = details?.jobs?.[0];
	const first = result.content[0];
	const text = first?.type === "text" ? first.text : "";
	return new Text(
		job
			? `${theme.fg("accent", `bg_job ${job.id}`)} ${theme.fg("muted", "started in background")}`
			: theme.fg("muted", text),
		0,
		0,
	);
}

function resultText(result: AgentToolResult<any> | undefined): string {
	if (!result) return "";
	const parts = (result.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => (block as { text: string }).text);
	return parts.join("\n").trim();
}

function exitCodeOf(result: AgentToolResult<any>): number | undefined {
	const structured = result.structuredContent;
	if (!structured || typeof structured !== "object") return undefined;
	const value = (structured as { exit_code?: unknown }).exit_code;
	return typeof value === "number" ? value : undefined;
}

function fullOutputPathOf(result: AgentToolResult<any>): string | undefined {
	const details = result.details as { fullOutputPath?: unknown } | undefined;
	return typeof details?.fullOutputPath === "string" ? details.fullOutputPath : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
