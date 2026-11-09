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
 * 子会话：进程内子 agent（如 @tintinweb/pi-subagents）会在同一进程里为子会话
 * 重新加载本扩展，并触发各自的 agent 与更名事件；其 ctx.mode 不是 "tui"。
 * 全部 handler 据此忽略子会话，标题与标签只由主 TUI 会话管理。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTabRenamer, inHerdrEnv } from "./lib/herdr.ts";
import { basename } from "./lib/text.ts";

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

// ─── 扩展入口 ───

export default function (pi: ExtensionAPI) {
	// herdr 环境下不注册动画事件，避免修改窗口标题（旧 herdr 或 herdr app 任一即算）。
	if (inHerdrEnv()) {
		// 两代 herdr 都支持更名（寻址差异见 lib/herdr.ts）；两套 env 都缺失时
		// renamer 为空，/name 更名静默空转，窗口标题照旧不动。
		const renamer = createTabRenamer((command, args) => pi.exec(command, args));
		// /name 可能连续执行，串行排队，保证最后一次重命名最终胜出。
		let renameQueue: Promise<void> = Promise.resolve();
		pi.on("session_info_changed", (event, ctx) => {
			// 子会话更名（子 agent 派生时的 setSessionName）不得触碰主 tab：
			// 标签寻址 env（HERDR_TAB_ID / HC_TERMINAL_ID）是进程级的，指向主 pi。
			if (ctx.mode !== "tui") return;
			const label = event.name?.trim() ?? ""; // /name 清除会话名时同步清空标签
			// label 在入队前捕获：连续 /name 各自带走当时的会话名，队尾者最终胜出。
			renameQueue = renameQueue
				.then(() => renamer?.rename(label))
				.catch(() => undefined); // 失败场景静默放弃
		});
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
