/**
 * pi-btw —— 顺带分派
 *
 * 仅在 herdr / herdr app 环境注册 `/btw <消息>`：新开一个标签，fork 当前
 * 会话启动一个新的 pi，把消息作为它的首条消息逐字递交；当前会话不受影响。
 * 新标签不命名，沿用 herdr 的默认编号。
 *
 * 会话语义：新 pi 以 `pi --fork <会话文件>` 启动，带全量上下文；fork
 * 的是敲 /btw 时刻之前的会话（/btw 是命令，不进会话）。拿不到会话文件
 * （如 --no-session）直接报错，不降级成全新会话——那会静默丢上下文。
 *
 * 本轮还在跑时（`ctx.isIdle()` 为假），会话文件末尾是半截状态：本轮的 user
 * 消息已落盘但尚无回答，或带 toolCall 的 assistant 还没有 toolResult。此时
 * 先用 lib/session-snapshot.ts 把会话截到最后一个完整 turn 的边界再 fork，
 * 避免新会话把别人未完成的 turn 当成自己的过去。
 *
 * 标签与首条消息的代际编排（herdr app 的一条 tab.new 带 argv；旧 herdr 的
 * tab create + pane run + 就绪轮询 + send-text）下沉在 lib/herdr.ts，这里
 * 只做命令注册、参数校验、fork 源的安全裁剪与结果反馈。
 *
 * 非 herdr 环境下本扩展不注册任何命令，零 footprint。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "./lib/errors.ts";
import { createTabLauncher, inHerdrEnv } from "./lib/herdr.ts";
import { snapshotAtTurnBoundary } from "./lib/session-snapshot.ts";

export default function (pi: ExtensionAPI) {
	if (!inHerdrEnv()) return;
	const launcher = createTabLauncher((command, args) => pi.exec(command, args));
	if (!launcher) return; // 防御：inHerdrEnv 为真时 launcher 必在
	pi.registerCommand("btw", {
		description: "顺带分派：新开标签 fork 当前会话启动 pi 并递交消息。/btw <消息>",
		handler: async (args, ctx) => {
			const message = args.trim();
			if (!message) {
				ctx.ui.notify("用法：/btw <消息> —— 新开一个标签，fork 当前会话启动 pi 并递交该消息", "warning");
				return;
			}
			const forkSession = ctx.sessionManager.getSessionFile();
			if (!forkSession) {
				ctx.ui.notify("✗ 当前会话没有 session 文件（如以 --no-session 启动），无法 fork", "error");
				return;
			}
			// 忙碌时文件末尾是半截 turn，先截到上一个完整边界再 fork。
			let forkTarget = forkSession;
			let boundaryNote = "";
			if (!ctx.isIdle()) {
				let snapshot;
				try {
					snapshot = snapshotAtTurnBoundary(forkSession);
				} catch (error) {
					ctx.ui.notify(`✗ /btw 失败：无法读取当前会话做安全快照：${errorMessage(error)}`, "error");
					return;
				}
				if (snapshot) {
					forkTarget = snapshot.file;
					boundaryNote = `（本轮尚未结束，已回退到上一个完整轮次，丢弃 ${snapshot.droppedEntries} 条未完成记录）`;
				}
			}
			try {
				await launcher.launch({ message, forkSession: forkTarget, cwd: process.cwd() });
				ctx.ui.notify(`✓ 已在新标签 fork 当前会话启动 pi${boundaryNote}`, "info");
			} catch (error) {
				ctx.ui.notify(`✗ /btw 失败：${errorMessage(error)}`, "error");
			}
		},
	});
}
