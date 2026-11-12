/**
 * pi-bg —— 后台运行的 bash 与 codemode
 *
 * 三个工具 + 一个人工入口，全部与内置工具的启用状态联动：
 *   bash-bg {command, timeout?}           bash 的后台版本
 *   codemode-bg {code}                    codemode 的后台版本
 *   bg {action: list | kill | wait, id?}  查看 / 终止 / 等候
 *   /bg [kill <id>]                       人工入口，0 常驻
 *
 * 两个后台工具都是**薄壳**，执行一律委托内置实现（ADR-0006）：
 *   - bash-bg 走 `ctx.executeTool("bash", ...)`；
 *   - codemode-bg 走 `createCodemodeExtension()` 造出的工具定义——`codemode` 的暴露是
 *     `model-only`，`ctx.executeTool` 根本调不到它（只认 direct / codemode / deferred），
 *     而 pi 只导出工厂、不导出沙箱，所以用一个吞掉 `registerTool` 的 shim 把真定义接住。
 *
 * 启用联动：三个工具都在 `session_start` 里注册，注册前读 `getActiveTools()`——bash /
 * codemode 未启用就根本不注册；schema 直接复用 `getAllTools()` 里内置工具的那一份，所以
 * pi 给内置工具加参数时这里不用跟。`prepareLoadout` 只兜「会话中途被 setActiveTools 关掉」
 * 这条 `session_start` 快照覆盖不到的路径。
 *
 * 完成回传走 `pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })`，
 * 与 Agent 后台模式同一通道：当前 turn 的工具跑完、下次 LLM 调用前投递；agent 空闲时立刻起一轮。
 * 绝不把工具入参的 signal 传给后台任务——父轮 Esc 会连坐。`bg wait` 接过结果时不再回传，
 * 避免同一份输出出现两次。
 *
 * 存续域与会话绑定：`/new`、`/reload`、`/resume`、`/fork`、退出都会触发 `session_shutdown`，
 * 一律 abort 在跑任务；`/new` 与 `/reload` 还会重建扩展实例，任务表随之清空。唯一不伴随
 * shutdown 的 `session_start` 来自 `rebindCurrentSession`（同一会话内重绑定），那里保留在跑
 * 任务才是对的。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import {
	createCodemodeExtension,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionToolContext,
	type Theme,
	type ToolDefinition,
	type ToolLoadout,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type BgJob,
	type BgKind,
	KEEP_FINISHED,
	MAX_RUNNING,
	findJob,
	newJobId,
	pruneFinished,
	runningJobs,
	summarizeLabel,
} from "./lib/bg/jobs.ts";
import {
	deliveryContent,
	formatListLines,
	splitDelivery,
	startText,
	statusText,
} from "./lib/bg/format.ts";
import { renderLineBox, type EntryLine } from "./lib/render.ts";
import { truncate } from "./lib/text.ts";

const CUSTOM_TYPE = "pi-bg";
const INFO_TYPE = "pi-bg-info";

type ToolOutcome = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;

/** 后台执行的最小结果契约；两种后端（executeTool / 接住的内置定义）都归一到这里。 */
interface JobOutcome {
	result: ToolOutcome["result"];
	isError: boolean;
}

/** 在跑任务额外握着中止句柄与等待者；`bg kill`、`session_shutdown`、`bg wait` 都走它们。 */
interface LiveJob extends BgJob {
	controller: AbortController;
	/** 等这个任务结束的回调；非空时不回传，由等待方直接取结果。 */
	waiters: Array<() => void>;
	/** 结果是否已经交给模型（作为自定义消息回传，或被 `bg wait` 接过）；避免同一份输出出现两次。 */
	delivered: boolean;
}

interface BgMessageDetails {
	id: string;
	kind: BgKind;
	label: string;
	status: BgJob["status"];
	text: string;
}

type BgJobSnapshot = { id: string; kind: BgKind; label: string; status: BgJob["status"]; text: string };

interface BgToolDetails {
	action: "list" | "kill" | "wait";
	error?: string;
	jobs?: BgJobSnapshot[];
}

interface BgInfoEntry {
	lines: EntryLine[];
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

export function registerPiBg(pi: ExtensionAPI, codemode: ToolDefinition | null): void {
	const jobs: LiveJob[] = [];
	/** 会话已关闭：此后不再回传（任务本身在此期间被 kill） */
	let closed = false;
	/** 工具是否已经注册过；`bindExtensions()` 可在同一 runner 上二次触发 session_start。 */
	let registered = false;

	pi.on("session_start", () => {
		closed = false;
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

	function kill(job: LiveJob, reason: "killed"): void {
		if (job.status !== "running") return;
		job.status = reason;
		job.controller.abort();
	}

	function deliver(job: LiveJob): void {
		if (closed) return;
		job.delivered = true;
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

	/**
	 * 等一个任务结束。只受传入的 signal 约束，**不会**中止任务本身：
	 * 父轮 Esc 取消的是「等」这个动作，后台任务照跑，结果仍会回传。
	 */
	function waitFor(job: LiveJob, signal: AbortSignal | undefined): Promise<void> {
		if (job.status !== "running") return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const onFinished = (): void => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				const index = job.waiters.indexOf(onFinished);
				if (index >= 0) job.waiters.splice(index, 1);
				resolve();
			};
			const onAbort = (): void => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				const index = job.waiters.indexOf(onFinished);
				if (index >= 0) job.waiters.splice(index, 1);
				reject(new Error("wait aborted"));
			};
			job.waiters.push(onFinished);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/**
	 * 起一个后台任务并立刻返回。`run` 只受我们自己的 controller 约束，
	 * 与发起它的 tool call 的生命周期无关（父轮 Esc 不会连坐）。
	 */
	function start(
		kind: BgKind,
		label: string,
		run: (signal: AbortSignal) => Promise<JobOutcome>,
	): LiveJob | null {
		if (runningJobs(jobs).length >= MAX_RUNNING) return null;

		const controller = new AbortController();
		const job: LiveJob = {
			id: newJobId((id) => jobs.some((candidate) => candidate.id === id)),
			kind,
			label,
			startedAt: Date.now(),
			status: "running",
			controller,
			waiters: [],
			delivered: false,
		};
		jobs.push(job);
		pruneFinished(jobs, KEEP_FINISHED);

		const startedAt = Date.now();
		void (async () => {
			try {
				const outcome = await run(controller.signal);
				job.output = resultText(outcome.result);
				job.exitCode = exitCodeOf(outcome.result);
				if (job.status === "killed") return;
				job.status = outcome.isError ? "failed" : "done";
			} catch (error) {
				if (job.status === "killed") return;
				job.status = "failed";
				job.output = errorText(error);
			} finally {
				job.durationMs = Date.now() - startedAt;
				const waiters = job.waiters.splice(0);
				if (waiters.length > 0) {
					// `bg wait` 正在等：结果由它的 tool result 交付，不再回传一遍
					for (const resolve of waiters) resolve();
				} else if (job.status === "done" || job.status === "failed") {
					// 被 kill 的任务不回传：动手的人已经拿到 bg kill 的结果
					deliver(job);
				}
			}
		})();

		return job;
	}

	const fail = (action: BgToolDetails["action"], message: string) => ({
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: { action, error: message } as BgToolDetails,
	});

	const limited = () =>
		fail(
			"list",
			`too many background jobs (max ${MAX_RUNNING}). Wait for one to finish or stop one with bg kill.`,
		);

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

		if (bash) {
			pi.registerTool({
				name: "bash-bg",
				label: "Bash (background)",
				description:
					"Run a bash command in the background. Returns immediately; the command's output arrives as a message when it finishes.",
				promptSnippet: "Run a bash command in the background",
				// 直接复用内置工具的 schema：pi 给 bash 加参数时这里自动跟上
				parameters: bash.parameters,
				prepareLoadout: hideWhenUnavailable("bash", "bash-bg"),

				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					const input = params as { command: string; timeout?: number };
					const job = start("bash", summarizeLabel(input.command), async (signal) => {
						const outcome = await ctx.executeTool("bash", input, { signal });
						return { result: outcome.result, isError: outcome.isError };
					});
					if (!job) return limited();
					return startedReply(job);
				},

				renderCall(args, theme) {
					const input = args as { command?: string };
					return new Text(
						theme.fg("toolTitle", theme.bold("bash-bg ")) + theme.fg("muted", truncate(input.command ?? "", 60)),
						0,
						0,
					);
				},

				renderResult: renderStarted,
			});
		}

		if (codemodeBackend) {
			pi.registerTool({
				name: "codemode-bg",
				label: "Codemode (background)",
				description:
					"Run a codemode script in the background. Returns immediately; the script's result arrives as a message when it finishes.",
				promptSnippet: "Run a codemode script in the background",
				parameters: codemodeBackend.parameters,
				prepareLoadout: hideWhenUnavailable("codemode", "codemode-bg"),

				async execute(toolCallId, params, _signal, _onUpdate, ctx) {
					const input = params as { code: string };
					const job = start("codemode", summarizeLabel(input.code), async (signal) => {
						const result = await codemodeBackend.execute(toolCallId, input, signal, undefined, ctx);
						return { result, isError: result.isError === true };
					});
					if (!job) return limited();
					return startedReply(job);
				},

				renderCall(args, theme) {
					const input = args as { code?: string };
					return new Text(
						theme.fg("toolTitle", theme.bold("codemode-bg ")) + theme.fg("muted", truncate(input.code ?? "", 60)),
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
			name: "bg",
			label: "Background jobs",
			description: "List, stop, or wait for background jobs started by bash-bg and codemode-bg.",
			promptSnippet: "List, stop, or wait for background jobs",
			parameters: Type.Object({
				action: StringEnum(["list", "kill", "wait"] as const, {
					description:
						"list: show background jobs. kill: stop a running job by id. wait: block until a job finishes and return its output.",
				}),
				id: Type.Optional(
					Type.String({ description: "Background job id. Required for kill; optional for wait (default: all running jobs)." }),
				),
			}),
			prepareLoadout: hideWhenUnavailable(["bash", "codemode"], "bg", "any"),

			async execute(_toolCallId, params, signal) {
				if (params.action === "kill") {
					if (!params.id) return fail("kill", "id is required for kill.");
					const job = findJob(jobs, params.id);
					if (!job) return fail("kill", `no background job with id '${params.id}'.`);
					if (job.status !== "running") {
						return {
							content: [
								{ type: "text" as const, text: `Background job ${job.id} had already finished (${statusText(job)}).` },
							],
							details: { action: "kill" as const },
						};
					}
					kill(job, "killed");
					return {
						content: [{ type: "text" as const, text: `Killed background job ${job.id}.` }],
						details: { action: "kill" as const },
					};
				}

				if (params.action === "wait") {
					const targets: LiveJob[] = [];
					if (params.id) {
						const job = findJob(jobs, params.id);
						if (!job) return fail("wait", `no background job with id '${params.id}'.`);
						targets.push(job);
					} else {
						targets.push(...runningJobs(jobs));
						if (targets.length === 0) {
							return {
								content: [{ type: "text" as const, text: "No background job is running." }],
								details: { action: "wait" as const },
							};
						}
					}

					try {
						await Promise.all(targets.map((job) => waitFor(job, signal)));
					} catch {
						// 只有父轮 Esc 会走到这里；任务本身不受影响，结果仍会作为消息到达
						return fail(
							"wait",
							"wait aborted. The background job keeps running; its output still arrives as a message when it finishes.",
						);
					}

					// 已经回传过的任务不再输出一遍：模型必须先拿到 id 才能 wait，两次调用必然跨轮，
					// 任务往往在那之前就完成了，重复输出只会浪费上下文。
					const text = targets
						.map((job) => {
							if (job.delivered) {
								return `[${job.kind}-bg ${job.id}] ${job.label} — ${statusText(job)}\n\nThe output was delivered as a separate message; read it there instead of repeating it here.`;
							}
							job.delivered = true;
							return deliveryContent(job);
						})
						.join("\n\n");

					return {
						content: [{ type: "text" as const, text }],
						details: { action: "wait" as const, jobs: targets.map(snapshot) },
					};
				}

				return {
					content: [{ type: "text" as const, text: formatListLines(jobs).join("\n") }],
					details: { action: "list" as const, jobs: jobs.map(snapshot) },
				};
			},

			renderCall(args, theme) {
				let text = theme.fg("toolTitle", theme.bold("bg ")) + theme.fg("muted", args.action);
				if (args.id) text += ` ${theme.fg("accent", args.id)}`;
				return new Text(text, 0, 0);
			},

			renderResult(result, { expanded }, theme) {
				const details = result.details as BgToolDetails | undefined;
				if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
				const first = result.content[0];
				const text = first?.type === "text" ? first.text : "";

				if (details?.action === "list" && (details.jobs?.length ?? 0) > 0 && !expanded) {
					const shown = details.jobs!.slice(0, 5);
					const head = theme.fg("muted", `${details.jobs!.length} background job(s):`);
					const rows = shown.map(
						(job) =>
							`${theme.fg("accent", job.id)} ${theme.fg("muted", job.kind)} ${theme.fg("dim", job.text)} ${theme.fg("muted", truncate(job.label, 40))}`,
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

	// ─── /bg 命令（人工入口） ───

	const info = (lines: EntryLine[]): void => pi.appendEntry<BgInfoEntry>(INFO_TYPE, { lines });

	pi.registerEntryRenderer<BgInfoEntry>(INFO_TYPE, (entry, _options, theme) =>
		renderLineBox(theme, entry.data?.lines ?? []),
	);

	pi.registerCommand("bg", {
		description: "后台任务：/bg | /bg kill <id>",
		getArgumentCompletions: (prefix) => {
			if (prefix.trim().includes(" ")) return null;
			const typed = prefix.trim();
			const options = ["kill", ...runningJobs(jobs).map((job) => job.id)];
			const items = options.filter((option) => option.startsWith(typed)).map((option) => ({ value: option, label: option }));
			return items.length > 0 ? items : null;
		},
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim();

			if (!args) {
				info(
					jobs.length === 0
						? [{ text: "没有后台任务。", tone: "muted" }]
						: [
								...formatListLines(jobs).map((text, index) => ({ text, tone: index < 2 ? "text" : "dim" }) as EntryLine),
								{ text: "", tone: "dim" },
								{ text: "终止：/bg kill <id>", tone: "dim" },
							],
				);
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

			info([{ text: `✗ 无法识别的参数「${args}」`, tone: "error" }, { text: "用法：/bg | /bg kill <id>", tone: "dim" }]);
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
		// 头行由 details 重排：正文里的头行只给模型看，TUI 不重复渲染状态
		const headline = details
			? theme.fg("customMessageText", `${details.kind}-bg ${details.id} · ${details.label}`) +
				theme.fg(tone, ` — ${details.text}`)
			: theme.fg(tone, head);

		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("customMessageLabel", "\x1b[1m[bg]\x1b[22m ") + headline, 0, 0));
		if (body) box.addChild(new Text(body, 0, 0));
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

function snapshot(job: BgJob): BgJobSnapshot {
	return { id: job.id, kind: job.kind, label: job.label, status: job.status, text: statusText(job) };
}

/** bash-bg / codemode-bg 共用的结果渲染：只显示 id，正文在完成消息里。 */
function renderStarted(
	result: AgentToolResult<BgToolDetails | undefined>,
	_options: ToolRenderResultOptions,
	theme: Theme,
): Text {
	const details = result.details;
	if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
	const job = details?.jobs?.[0];
	const first = result.content[0];
	const text = first?.type === "text" ? first.text : "";
	return new Text(
		job ? `${theme.fg("accent", job.id)} ${theme.fg("muted", "started in background")}` : theme.fg("muted", text),
		0,
		0,
	);
}

function resultText(result: ToolOutcome["result"]): string {
	const parts = (result.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => (block as { text: string }).text);
	return parts.join("\n").trim();
}

function exitCodeOf(result: ToolOutcome["result"]): number | undefined {
	const structured = result.structuredContent;
	if (!structured || typeof structured !== "object") return undefined;
	const value = (structured as { exit_code?: unknown }).exit_code;
	return typeof value === "number" ? value : undefined;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
