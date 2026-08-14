/**
 * pi-context —— 将当前系统提示词写入 ~/.pi/system-prompt.md
 *
 * 命令：
 *   /context   — 调用 ctx.getSystemPrompt() 获取系统提示词并写入文件
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: "将当前系统提示词写入 ~/.pi/system-prompt.md",
		handler: async (_args, ctx) => {
			try {
				const prompt = ctx.getSystemPrompt();
				const dir = join(homedir(), ".pi");
				mkdirSync(dir, { recursive: true });
				const file = join(dir, "system-prompt.md");
				writeFileSync(file, prompt, "utf-8");
				ctx.ui.notify(`系统提示词已写入 ${file}`, "info");
			} catch (e) {
				ctx.ui.notify(`[context] ${(e as Error).message}`, "error");
			}
		},
	});
}
