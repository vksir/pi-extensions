/**
 * pi-context —— 导出下一次模型请求的系统提示词与工具声明。
 *
 * 来源分工：
 * - 系统提示词：请求时 transcript 的 system 消息，用 pi-ai 的 getCurrentSystemMessage 还原。
 *   provider 适配器读提示词走的是同一条路径，所以正文就是模型收到的文本。
 * - 工具声明：provider 请求体的 tools 字段。每个声明一节：\`## 描述\` 放原文（按 Markdown
 *   渲染，不套代码块），\`## 定义\` 放 JSON，长文本位置留占位。
 *
 * 两份文件都用 YAML 抬头（`---` 包住键值）与正文分开。
 */

import { getCurrentSystemMessage, getCurrentTools, getSystemMessageText } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = join(getAgentDir(), "pi-context");
const PROMPT_FILE = join(OUT_DIR, "system-prompt.md");
const TOOLS_FILE = join(OUT_DIR, "tools.md");

/** 触发空转的自定义消息：/context 用它让 pi 真的发一次请求。 */
const TRIGGER_TYPE = "pi-context";
const TRIGGER_TEXT = "[pi-context] 导出上下文快照。不要调用工具，只回复 ok。";

/** 超过这个长度或含换行的字符串从 JSON 移出，按原文渲染。 */
const LONG_TEXT_CHARS = 200;

/** 移出 JSON 的文本块：标题是它的 JSON 路径，工具描述固定叫「描述」。 */
interface TextBlock {
	title: string;
	text: string;
}

/** 只读 transcript；replay 助手只读 role === "system" 的消息。 */
type TranscriptMessages = readonly { role: string }[];

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

/** 触发用的空转消息：捕获完成后不再进入上下文。 */
function isTrigger(message: unknown): boolean {
	const record = asRecord(message);
	return record?.role === "custom" && record.customType === TRIGGER_TYPE;
}

/** 工具声明只有两个位置：顶层（OpenAI、Anthropic）与 config 内（Google SDK）。 */
function requestTools(payload: unknown): unknown[] | undefined {
	const root = asRecord(payload);
	const tools = root?.tools ?? asRecord(root?.config)?.tools;
	return Array.isArray(tools) ? tools : undefined;
}

/** YAML 抬头：`---` 包住键值，正文从下一个空行开始。 */
function frontmatter(lines: string[]): string {
	return ["---", ...lines, "---", ""].join("\n");
}

function metaLines(ctx: ExtensionContext, capturedAt: string, source: string): string[] {
	const model = ctx.model;
	return [
		`捕获时间: ${capturedAt}`,
		`模型: ${model ? `${model.provider}/${model.id}（${model.api}）` : "未知"}`,
		`来源: ${source}`,
	];
}

/** YAML 键按需加引号，避免分段名里的特殊字符破坏抬头。 */
function yamlKey(name: string): string {
	return /^[A-Za-z0-9_.-]+$/.test(name) ? name : JSON.stringify(name);
}

/** JSON 块；文本里出现同款围栏时自动加长，避免被截断。 */
function fence(language: string, text: string): string[] {
	let marker = "~~~";
	while (text.includes(marker)) marker += "~";
	return [`${marker}${language}`, text, marker];
}

function promptMarkdown(messages: TranscriptMessages | undefined, ctx: ExtensionContext, capturedAt: string): string {
	const system = messages ? getCurrentSystemMessage(messages) : undefined;
	if (!system) return frontmatter(metaLines(ctx, capturedAt, "本次请求没有系统提示词"));
	const lines = metaLines(ctx, capturedAt, "本次请求 transcript 的 system 消息（provider 读取提示词的同一路径）");
	const sections = Object.entries(system.sections ?? {}).flatMap(([name, text]) => (text === null ? [] : [[name, text] as const]));
	if (sections.length > 0) {
		lines.push("分段字符数:");
		for (const [name, text] of sections) lines.push(`  ${yamlKey(name)}: ${text.length}`);
	}
	return `${frontmatter(lines)}\n${getSystemMessageText(system)}\n`;
}

/** 工具描述始终成节；其他长文本按 JSON 路径成节，重名加序号。 */
function textBlock(value: string, path: string, blocks: TextBlock[]): TextBlock | undefined {
	const isDescription = path.endsWith("description") && path.split(".").length <= 2;
	if (!isDescription && !value.includes("\n") && value.length <= LONG_TEXT_CHARS) return undefined;
	const base = isDescription ? "描述" : path;
	const taken = blocks.filter((block) => block.title === base || block.title.startsWith(`${base} (`)).length;
	return { title: taken === 0 ? base : `${base} (${taken + 1})`, text: value };
}

/**
 * 把不宜塞进 JSON 的字符串换成占位符，其余字段保持原样。占位符按节标题指路，
 * 读的人不用数序号。走任意深度，因此不需要知道 API 形状。
 */
function pullTextBlocks(value: unknown, blocks: TextBlock[], path = ""): unknown {
	if (typeof value === "string") {
		const block = textBlock(value, path, blocks);
		if (!block) return value;
		blocks.push(block);
		return `<见「${block.title}」>`;
	}
	if (Array.isArray(value)) return value.map((item, index) => pullTextBlocks(item, blocks, `${path}[${index}]`));
	const record = asRecord(value);
	if (!record) return value;
	return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, pullTextBlocks(child, blocks, path === "" ? key : `${path}.${key}`)]));
}

/** 工具名：任意深度第一个字符串型 `name`，同样不按 API 形状分支。 */
function findName(value: unknown): string | undefined {
	if (Array.isArray(value)) {
		for (const item of value) {
			const name = findName(item);
			if (name !== undefined) return name;
		}
		return undefined;
	}
	const record = asRecord(value);
	if (!record) return undefined;
	if (typeof record.name === "string") return record.name;
	for (const child of Object.values(record)) {
		const name = findName(child);
		if (name !== undefined) return name;
	}
	return undefined;
}

/**
 * 每个声明一节：\`# 工具名\` → \`## 描述\` → \`## 定义\`。
 * 描述按 Markdown 原样渲染，不套代码块——它自带标题与围栏，套上就没法识别了。
 */
function toolSections(tools: unknown[]): string[] {
	return tools.map((tool, index) => {
		const blocks: TextBlock[] = [];
		const declaration = pullTextBlocks(tool, blocks);
		const lines = [`# ${findName(tool) ?? `工具 ${index + 1}`}`, ""];
		for (const block of blocks) lines.push(`## ${block.title}`, "", block.text, "");
		lines.push("## 定义", "", ...fence("json", JSON.stringify(declaration, null, 2)), "");
		return lines.join("\n");
	});
}

function toolsMarkdown(payload: unknown, messages: TranscriptMessages | undefined, ctx: ExtensionContext, capturedAt: string): string {
	const tools = requestTools(payload);
	if (!tools) {
		const declared = messages ? getCurrentTools(messages).length : undefined;
		const source = declared === undefined ? "未捕获到 transcript，无法判断工具声明"
			: declared === 0 ? "本次请求没有工具声明"
			: `无法从该 API 的请求体读取工具声明（transcript 声明了 ${declared} 个）`;
		return frontmatter(metaLines(ctx, capturedAt, source));
	}
	const json = JSON.stringify(tools, null, 2);
	const lines = [
		...metaLines(ctx, capturedAt, "provider 请求体的 tools 字段；描述与长文本移出 JSON，见各工具小节"),
		`数量: ${tools.length}`,
		`JSON 字符数: ${json.length}`,
	];
	return `${frontmatter(lines)}\n${toolSections(tools).join("\n")}`;
}

export default function (pi: ExtensionAPI) {
	let pending = false;
	// 最近一次请求的 transcript：provider 从它的 system 消息读提示词与工具声明。
	let transcript: TranscriptMessages | undefined;

	pi.registerCommand("context", {
		description: "导出系统提示词与工具声明的快照",
		handler: async (_args, ctx) => {
			pending = true;
			if (!ctx.isIdle()) {
				// 正在跑的一轮里，下一次请求就会写出快照，不用再触发。
				ctx.ui.notify(`Agent 运行中：快照将在本轮下一请求时写出\n${PROMPT_FILE}\n${TOOLS_FILE}`, "info");
				return;
			}
			// 空转一轮，让 pi 真的发一次请求：要写的就是这次请求。
			pi.sendMessage({ customType: TRIGGER_TYPE, content: TRIGGER_TEXT, display: false }, { triggerTurn: true });
			ctx.ui.notify(`已触发一次请求：快照将写入\n${PROMPT_FILE}\n${TOOLS_FILE}`, "info");
		},
	});

	/**
	 * 空转消息只在捕获那一次请求里保留，之后的请求把它去掉，
	 * 免得快照工具自己长期占用上下文。
	 */
	pi.on("context", (event) => {
		if (pending) return;
		const messages = event.messages.filter((message) => !isTrigger(message));
		if (messages.length === event.messages.length) return;
		return { messages };
	});

	/** 只做快照，不修改消息，也不替换 handler 的输出。 */
	pi.on("context_with_system", (event) => {
		transcript = event.messages;
	});

	/** 请求体成型后落盘：两份文件来自同一次请求。 */
	pi.on("before_provider_request", (event, ctx) => {
		if (!pending) return;
		pending = false;
		try {
			// 两份文件来自同一次请求，共用一个捕获时间。
			const capturedAt = new Date().toISOString();
			mkdirSync(OUT_DIR, { recursive: true });
			writeFileSync(PROMPT_FILE, promptMarkdown(transcript, ctx, capturedAt), "utf-8");
			writeFileSync(TOOLS_FILE, toolsMarkdown(event.payload, transcript, ctx, capturedAt), "utf-8");
			ctx.ui.notify(`上下文快照已写入\n${PROMPT_FILE}\n${TOOLS_FILE}`, "info");
		} catch (error) {
			// 导出失败只通知，不修改或阻断模型请求。
			ctx.ui.notify(`[context] ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});
}
