/**
 * pi-context —— 立即导出系统提示词；下次请求刷新提示词与工具定义。
 *
 * 输出到 Pi agent dir 下的 pi-context/，工具文件附激活列表与实际写入时间。
 */

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = join(getAgentDir(), "pi-context");
const SYSTEM_PROMPT_FILE = join(OUT_DIR, "system-prompt.md");
const TOOLS_FILE = join(OUT_DIR, "tools.md");

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

/** 保留 provider 原生声明，包括 codemode 动态描述与 freeform grammar。 */
function requestTools(root: Record<string, unknown>): unknown[] {
	const tools = root.tools ?? asRecord(root.config)?.tools;
	if (Array.isArray(tools)) return tools;
	if (tools === undefined && (
		Array.isArray(root.messages) || Array.isArray(root.input) || typeof root.input === "string" ||
		Array.isArray(root.contents) || "instructions" in root || "system" in root
	)) return [];
	throw new Error("无法识别请求中的工具定义");
}

function systemText(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(systemText).filter(Boolean).join("\n\n");
	const block = asRecord(value);
	if (typeof block?.text === "string") return block.text;
	if (Array.isArray(block?.parts)) return systemText(block.parts);
	throw new Error("无法识别请求中的系统提示词");
}

/** 包含初始提示词与后续 system/developer 指令，不导出用户或助手消息。 */
function requestSystemPrompt(root: Record<string, unknown>): string {
	const config = asRecord(root.config);
	const parts = [
		root.instructions,
		root.system,
		root.systemInstruction ?? root.system_instruction,
		config?.systemInstruction ?? config?.system_instruction,
	];
	for (const messages of [root.messages, root.input]) {
		if (!Array.isArray(messages)) continue;
		for (const value of messages) {
			const message = asRecord(value);
			if (message?.role === "system" || message?.role === "developer") parts.push(message.content);
		}
	}
	return parts.map(systemText).filter(Boolean).join("\n\n");
}

function toolsMarkdown(activeTools: string[], tools: unknown[]): string {
	return [
		"# 工具",
		"",
		`- 写入时间：${new Date().toISOString()}`,
		"",
		"## 激活工具",
		"",
		"激活不等于独立顶层可见；LLM 实际收到的定义见下方。",
		"",
		activeTools.map((name) => `- \`${name}\``).join("\n") || "（无工具）",
		"",
		"## 对 LLM 展示的工具定义",
		"",
		"~~~json",
		JSON.stringify(tools, null, 2),
		"~~~",
		"",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	let captureNextRequest = false;

	pi.registerCommand("context", {
		description: "立即写入系统提示词，下次请求刷新提示词并捕获实际工具定义",
		handler: async (_args, ctx) => {
			try {
				const prompt = ctx.getSystemPrompt();
				mkdirSync(OUT_DIR, { recursive: true });
				writeFileSync(SYSTEM_PROMPT_FILE, prompt, "utf-8");
				captureNextRequest = true;
				ctx.ui.notify(
					`系统提示词已写入 → ${SYSTEM_PROMPT_FILE}\n下次请求将刷新系统提示词并写入工具定义 → ${TOOLS_FILE}`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`[context] ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!captureNextRequest) return;
		captureNextRequest = false;
		try {
			const root = asRecord(event.payload);
			if (!root) throw new Error("无法识别请求格式");
			const tools = requestTools(root);
			const prompt = requestSystemPrompt(root);
			const toolContent = toolsMarkdown(pi.getActiveTools(), tools);
			mkdirSync(OUT_DIR, { recursive: true });
			writeFileSync(SYSTEM_PROMPT_FILE, prompt, "utf-8");
			writeFileSync(TOOLS_FILE, toolContent, "utf-8");
		} catch (error) {
			// 导出失败只通知，不修改或阻断模型请求。
			ctx.ui.notify(`[context] ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});
}
