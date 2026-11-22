/**
 * Pi Title Extension
 *
 * 普通终端：在 Pi agent 运行时，为终端窗口标题添加旋转动画，
 * 指示 agent 正在活跃处理中。agent 结束后恢复原标题。
 *
 * herdr 环境：不改窗口标题；两代 herdr 下 `/name` 更名会话时，同步重命名 pi 所在
 * 标签（env 探测与更名命令在 lib/herdr.ts）：旧 herdr 的 HERDR_TAB_ID 直接寻址，
 * herdr app 经 herdr-app CLI 先 ls 寻址再改名。窗口未开等失败静默放弃。
 *
 * herdr app 额外做 tab 自动命名（默认关闭，要显式打开）：新建会话的第一条
 * 人类消息交给短标题模型起名（2-4 词，按 20 列硬截 = 中文 ≤ 10 字 / 英文
 * ≤ 20 字符），写进 tab 名。会话一旦有名字（`/name`、`--name`）就让位；
 * resume / fork 出来的会话不做回溯命名；同一触发内最多尝试三次。自动标题
 * 只用于显示，不进会话名、不写会话文件（见 ADR-0012）。
 *
 * 会话启动（resume、/reload、切换会话）后 pi 会把终端标题重写成
 * `π - <会话名> - <cwd>`，而 herdr 在标签未命名时就显示这个标题，于是恢复出来的
 * 命名会话会变成 `π - abc - <cwd>`。因此会话名存在时，启动后把标签重新对齐到它。
 *
 * 子会话：进程内子 agent（如 @tintinweb/pi-subagents）会在同一进程里为子会话
 * 重新加载本扩展，并触发各自的 agent 与更名事件；其 ctx.mode 不是 "tui"。
 * 全部 handler 据此忽略子会话，标题与标签只由主 TUI 会话管理。
 *
 * herdr-agent 拉起的子 agent 是独立进程、ctx.mode 也是 "tui"，靠注入的
 * PI_AGENT_ID 认出：它们的 tab 名由拉起方的 `--name` 决定，不参与自动命名。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fitTitle, runAutoName, sanitizeTitle } from "./lib/auto-name.ts";
import { createTabRenamer, inHerdrApp, inHerdrEnv } from "./lib/herdr.ts";
import { readExtensionSettings } from "./lib/settings.ts";
import { basename } from "./lib/text.ts";
import { piTitlePrompt } from "./prompt/pi-title.ts";

const FRAMES = ["⠂", "⠐"];
const INTERVAL_MS = 960;

type SessionKey = ExtensionContext["sessionManager"];

// ─── 标题动画 ───

// 活跃 session → 其 ctx。主 session 先插入，Map 迭代按插入序，主优先。
const activeSessions = new Map<SessionKey, ExtensionContext>();
let timer: ReturnType<typeof setInterval> | null = null;
let frame = 0;

function getTitle(ctx: ExtensionContext): string {
	const session = ctx.sessionManager.getSessionName();
	const cwdName = basename(process.cwd());
	return session ? `π - ${session} - ${cwdName}` : `π - ${cwdName}`;
}

function pickCtx(): ExtensionContext | undefined {
	for (const ctx of activeSessions.values()) return ctx;
	return undefined;
}

function tick(): void {
	const ctx = pickCtx();
	if (!ctx) return;
	try {
		ctx.ui.setTitle(FRAMES[frame++ % FRAMES.length]);
	} catch {
		// ctx 可能已 stale（session 正在 shutdown），忽略本次写入。
	}
}

function start(ctx: ExtensionContext): void {
	const session = ctx.sessionManager;
	if (!activeSessions.has(session)) activeSessions.set(session, ctx);
	if (timer !== null) return;

	frame = 0;
	tick();
	timer = setInterval(tick, INTERVAL_MS);
}

function stop(ctx: ExtensionContext, title: string): void {
	activeSessions.delete(ctx.sessionManager);
	if (activeSessions.size > 0) return;

	if (timer !== null) {
		clearInterval(timer);
		timer = null;
	}
	frame = 0;
	ctx.ui.setTitle(title);
}

function cleanup(ctx: ExtensionContext): void {
	activeSessions.delete(ctx.sessionManager);
	if (activeSessions.size > 0 || timer === null) return;

	clearInterval(timer);
	timer = null;
	frame = 0;
}

// ─── 自动标签名（仅 herdr app） ───

const SETTINGS_KEY = "pi-title";
/** 标题模型的输出上限：20 列的标题远用不到这么多，留出 OpenAI 系轻量推理的余量。 */
const AUTO_NAME_MAX_TOKENS = 1024;

interface PiTitleSettings {
	/** herdr app 里按首条消息自动命名 tab；默认关闭，必须显式设为 true。 */
	autoName?: boolean;
	/** 生成标题用的模型 `provider/id`；缺失或解析失败时用当前会话模型。 */
	autoNameModel?: string;
}

/**
 * 是否为 herdr-agent 拉起的子 agent（拉起时注入 `PI_AGENT_ID`）。子 agent 的 tab 名
 * 由拉起方的 `--name` 决定，自动命名只会跟它抢名字；根 agent 没有这个变量。
 * 进程内子 agent（pi-subagents）走另一条判据：它们的 `ctx.mode` 不是 "tui"。
 */
function inSubAgentSession(): boolean {
	return Boolean(process.env.PI_AGENT_ID?.trim());
}

/**
 * 会话里是否已有真人消息。判断「新会话」不能只看 `session_start` 的 reason：
 * `pi -c` 在进程启动时加载旧会话，发出的事件也是 "startup"（session 在扩展
 * 加载之前就打开了，见 agent-session.js 的默认 sessionStartEvent）。
 */
function hasUserMessages(ctx: ExtensionContext): boolean {
	return ctx.sessionManager
		.getEntries()
		.some((entry) => entry.type === "message" && entry.message.role === "user");
}

/** 标题用哪个模型：配置的能解析就用，否则回落当前会话模型。 */
function resolveAutoNameModel(ctx: ExtensionContext, settings: PiTitleSettings): ExtensionContext["model"] {
	const reference = settings.autoNameModel?.trim();
	if (reference) {
		// `provider/id`：模型 id 自身可能带斜杠（如 openrouter 的 meta/…），只切第一个。
		const slash = reference.indexOf("/");
		if (slash > 0) {
			const configured = ctx.modelRegistry.find(reference.slice(0, slash), reference.slice(slash + 1));
			if (configured) return configured;
		}
		// 写错（模型不存在、provider 未配置）就回落，而不是把功能关掉。
	}
	return ctx.model;
}

/**
 * 让短标题模型给首条消息起个标题。不传任何推理选项：pi-ai 的 Anthropic
 * 适配器在 thinkingEnabled 未设置时根本不在请求里带 thinking（等同 Claude Code
 * 的 thinking disabled），OpenAI 兼容适配器则用 provider 默认。
 */
async function generateAutoName(
	ctx: ExtensionContext,
	settings: PiTitleSettings,
	prompt: string,
): Promise<string | undefined> {
	const model = resolveAutoNameModel(ctx, settings);
	if (!model) return undefined;

	const response = await ctx.modelRegistry.complete(
		model,
		{
			systemPrompt: piTitlePrompt.autoName.system,
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
		},
		{ maxTokens: AUTO_NAME_MAX_TOKENS, cacheRetention: "none" },
	);
	const text = response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	// 提示词只是软约束（实测会超长），再按 tab 宽度硬截一次：中文 ≤ 10 字 / 英文 ≤ 20 字符。
	const title = sanitizeTitle(text);
	return title ? fitTitle(title) : undefined;
}

// ─── 扩展入口 ───

export default function (pi: ExtensionAPI) {
	// herdr 环境下不注册动画事件，避免修改窗口标题（旧 herdr 或 herdr app 任一即算）。
	if (inHerdrEnv()) {
		// 两代 herdr 都支持更名（寻址差异见 lib/herdr.ts）；两套 env 都缺失时
		// renamer 为空，/name 更名静默空转，窗口标题照旧不动。
		const renamer = createTabRenamer((command, args) => pi.exec(command, args));
		// 更名可能连续发生（/name、启动对齐），串行排队，保证最后一次重命名最终胜出。
		let renameQueue: Promise<void> = Promise.resolve();
		// label 在入队前捕获：连续 /name 各自带走当时的会话名，队尾者最终胜出。
		const align = (label: string): void => {
			renameQueue = renameQueue
				.then(() => renamer?.rename(label))
				.catch(() => undefined); // 失败场景静默放弃
		};
		pi.on("session_info_changed", (event, ctx) => {
			// 子会话更名（子 agent 派生时的 setSessionName）不得触碰主 tab：
			// 标签寻址 env（HERDR_TAB_ID / HC_TERMINAL_ID）是进程级的，指向主 pi。
			if (ctx.mode !== "tui") return;
			align(event.name?.trim() ?? ""); // /name 清除会话名时同步清空标签
		});

		// 自动命名只对全新会话的第一条人类消息生效：已经有对话的会话（含 `pi -c`
		// resume、`--fork` 带进来的历史）一律不回溯命名，fork 出来的新会话也不参与
		// （见 ADR-0012）。
		let autoNamePending = false;
		// 当前主会话的 sessionManager。自动命名的模型调用是 fire-and-forget，
		// 期间切了会话（/new、/resume）就不能再拿旧会话的结果去改新会话的 tab。
		let activeSession: ExtensionContext["sessionManager"] | undefined;

		pi.on("session_start", (event, ctx) => {
			if (ctx.mode !== "tui") return;
			activeSession = ctx.sessionManager;
			autoNamePending = event.reason !== "fork" && !inSubAgentSession() && !hasUserMessages(ctx);

			// resume / /reload / 切换会话后，pi 的内置标题会变回 `π - <会话名> - <cwd>`；
			// 标签未命名时 herdr 显示的就是这个标题。会话名存在就把标签对齐回去，
			// herdr 里只留下会话名。无名会话不动标签：既不洗掉人为改的名，也不凭空
			// 把上一会话的名字留在新会话的标签上。
			const name = ctx.sessionManager.getSessionName()?.trim() ?? "";
			if (name) align(name);
		});

		if (inHerdrApp()) {
			pi.on("input", (event, ctx) => {
				if (ctx.mode !== "tui" || !autoNamePending) return;
				// 扩展投递的消息（pi-cron、herdr-agent 的 peer 消息）不是人说的第一句。
				if (event.source === "extension") return;
				// 斜杠命令在 skill / 模板展开之前就到这里；没有自然语言可起名，
				// 保留资格等下一条。
				const prompt = event.text.trim();
				if (!prompt || prompt.startsWith("/")) return;
				// 已有会话名：自动名永远让位。
				if (ctx.sessionManager.getSessionName()?.trim()) return;

				const settings = readExtensionSettings<PiTitleSettings>(pi, SETTINGS_KEY);
				if (settings.autoName !== true) return; // 默认关闭，要显式打开

				autoNamePending = false; // 一次性：同一会话无论成败都不再触发
				const session = ctx.sessionManager;
				void runAutoName({
					attempt: () => generateAutoName(ctx, settings, prompt),
					// 会话切走、或生成期间被 /name 抢先，都丢弃这轮结果。
					isNamed: () => session !== activeSession || Boolean(session.getSessionName()?.trim()),
					apply: align,
				}).catch(() => undefined); // 自动命名是锦上添花，任何意外都不往外抛
			});
		}
		return;
	}

	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		start(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		stop(ctx, getTitle(ctx));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		cleanup(ctx);
	});
}
