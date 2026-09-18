/**
 * pi-context —— 系统提示词 + 当前工具定义 + 一次性真实请求体捕获
 *
 * 命令：
 *   /context — 将系统提示词写入 ~/.pi/pi-context/system-prompt.md，
 *              将当前会传入 LLM 的工具定义写入 ~/.pi/pi-context/tools.md，
 *              并挂起一次性钩子：下次请求 LLM 时把真实请求体写入 ~/.pi/pi-context/last-request.json
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PI_DIR = join(homedir(), ".pi");
const OUT_DIR = join(PI_DIR, "pi-context");
const SYSTEM_PROMPT_FILE = join(OUT_DIR, "system-prompt.md");
const TOOLS_FILE = join(OUT_DIR, "tools.md");
const REQUEST_FILE = join(OUT_DIR, "last-request.json");
/** 工具定义的最大记录字符数，超出部分截断 */
const MAX_FIELD_CHARS = 200_000;

function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		const json = JSON.stringify(value, null, 2);
		return json === undefined ? String(value) : json;
	} catch {
		return String(value);
	}
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）`;
}

function timestamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default function (pi: ExtensionAPI) {
	// /context 执行后挂起，仅在下一次请求时捕获，随后失效
	let captureNextRequest = false;

	pi.registerCommand("context", {
		description: "写入系统提示词与工具定义，并挂起一次性真实请求体捕获",
		handler: async (_args, ctx) => {
			try {
				// 1. 系统提示词
				const prompt = ctx.getSystemPrompt();
				mkdirSync(OUT_DIR, { recursive: true });
				writeFileSync(SYSTEM_PROMPT_FILE, prompt, "utf-8");

				// 2. 当前会传入 LLM 的工具（激活工具 + 完整定义）
				const activeNames = new Set(pi.getActiveTools());
				const tools = pi.getAllTools().filter((t) => activeNames.has(t.name));
				const toolList = tools.map(({ name, description, parameters }) => ({
					name,
					description,
					parameters,
				}));

				const content = [
					"# 当前会传入 LLM 的工具",
					"",
					`- 记录时间：${timestamp()}`,
					`- 工具数量：${tools.length}`,
					"",
					"## 工具列表",
					"",
					tools
						.map((t) => `- \`${t.name}\` — ${t.description?.split("\n")[0] ?? ""}`)
						.join("\n") || "（无工具）",
					"",
					"## 完整工具定义",
					"",
					"```json",
					truncate(stringify(toolList), MAX_FIELD_CHARS),
					"```",
					"",
				].join("\n");
				writeFileSync(TOOLS_FILE, content, "utf-8");

				// 3. 挂起一次性捕获：下次请求时写入真实请求体
				captureNextRequest = true;

				ctx.ui.notify(
					`系统提示词 → ${SYSTEM_PROMPT_FILE}\n工具定义 → ${TOOLS_FILE}\n真实请求体将在下次请求时写入 ${REQUEST_FILE}`,
					"info",
				);
			} catch (e) {
				ctx.ui.notify(`[context] ${(e as Error).message}`, "error");
			}
		},
	});

	// 仅当 /context 挂起时生效，捕获一次后失效
	pi.on("before_provider_request", (event) => {
		if (!captureNextRequest) return;
		captureNextRequest = false;
		try {
			mkdirSync(OUT_DIR, { recursive: true });
			writeFileSync(REQUEST_FILE, stringify(event.payload), "utf-8");
		} catch {
			// 记录失败不影响请求
		}
	});
}
