/**
 * pi-btw —— 顺带分派
 *
 * 仅在 herdr / herdr app 环境注册 `/btw <消息>`：新开一个标签，fork 当前
 * 会话启动一个新的 pi，把消息作为它的首条消息逐字递交；当前会话不受影响。
 * 新标签不命名，沿用 herdr 的默认编号。
 *
 * 会话语义：新 pi 以 `pi --fork <当前会话文件>` 启动，带全量上下文；fork
 * 的是敲 /btw 时刻之前的会话（/btw 是命令，不进会话）。拿不到会话文件
 * （如 --no-session）直接报错，不降级成全新会话——那会静默丢上下文。
 *
 * 标签与首条消息的代际编排（herdr app 的 tab.new --task、旧 herdr 的
 * tab create + agent start + agent prompt）下沉在 lib/herdr.ts，这里只做
 * 命令注册、参数校验与结果反馈。
 *
 * 非 herdr 环境下本扩展不注册任何命令，零 footprint。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTabLauncher, inHerdrEnv } from "./lib/herdr.ts";

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
			try {
				await launcher.launch({ message, forkSession, cwd: process.cwd() });
				ctx.ui.notify("✓ 已在新标签 fork 当前会话启动 pi", "info");
			} catch (error) {
				ctx.ui.notify(`✗ /btw 失败：${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
