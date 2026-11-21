/**
 * agent 之间的消息首行与结果整形（纯函数，无 I/O，便于测试）。
 *
 * 消息经 hc 的 `terminal.send` 打进对方终端的输入框，对端 pi 收到的是普通用户输入。
 * hc 自己会给「发给 agent 的消息」套一层 `<hc from="t4m">…</hc>`（`notes = false` 时才不套），
 * 所以解析时先剥这层，再看首行。
 *
 * 首行同时承担两个职责，所以只保留一个格式：
 * - 给接收方扩展读：谁发的、是不是自动回发
 * - 给模型看：这条活是哪个 agent 派的
 *
 *   <agent a7k2 "reviewer">           派活 / 普通消息
 *   <agent a7k2 "reviewer" result>    自动回发
 *
 * `result` 为真的消息不会被再次回发（否则 A 与 C 会无限来回），也不排队。
 * 发送方地址不写在首行：按术语表的「寻址一律用 id」，回发时用 id 反查终端。
 *
 * 正文超过 bash 工具同款上限（2000 行 / 50 KB）时按尾部截断，全文另存临时文件。
 */

/** 解析出来的首行。 */
export interface AgentEnvelope {
	/** 发送方的 agent id。 */
	from: string;
	/** 发送方的显示名（可缺省）。 */
	name?: string;
	/** true 表示这是自动回发，接收方不回发、不排队。 */
	result: boolean;
	/** 首行之后的正文。 */
	body: string;
}

export interface AgentEnvelopeInput {
	from: string;
	name?: string;
	result?: boolean;
	body: string;
}

const ENVELOPE_PATTERN = /^<agent\s+([^\s>"]+)(?:\s+"([^"]*)")?(?:\s+(result))?>[ \t]*\r?\n?/;
/** hc 给消息套的运输层标签；先剥掉才能看到我们自己的首行。 */
const HC_OPEN_PATTERN = /^<hc\s+[^>\r\n]*>[ \t]*\r?\n?/;
const HC_CLOSE_PATTERN = /<\/hc>\s*$/;

/** 引号与尖括号会破坏首行；id/name 都来自受控取值，这里只做防御性清理。 */
function clean(value: string): string {
	return value.replace(/["<>\r\n]/g, "");
}

/** 消息首行；扩展拼出来、模型也能看到的那一行。 */
export function agentSourceLine(id: string, name?: string, result = false): string {
	const head = name ? `${clean(id)} "${clean(name)}"` : clean(id);
	return result ? `<agent ${head} result>` : `<agent ${head}>`;
}

export function formatAgentEnvelope(envelope: AgentEnvelopeInput): string {
	return `${agentSourceLine(envelope.from, envelope.name, envelope.result)}\n${envelope.body}`;
}

/** 剥掉 hc CLI 的运输层包装，保留我们自己的首行。 */
export function stripHcTransport(text: string): string {
	return text.replace(HC_OPEN_PATTERN, "").replace(HC_CLOSE_PATTERN, "");
}

/**
 * 解析首行。不是信封（人打字、别的扩展消息）返回 undefined，调用方原样放行。
 * 宁可让模型看到一行怪文本，也不吞消息。
 */
export function parseAgentEnvelope(text: string): AgentEnvelope | undefined {
	// hc 的运输层包装（from 是发送终端地址；若 notes 被关掉则不存在）。
	const unwrapped = stripHcTransport(text);

	const match = ENVELOPE_PATTERN.exec(unwrapped);
	if (!match) return undefined;

	return {
		from: match[1],
		name: match[2] || undefined,
		result: Boolean(match[3]),
		body: unwrapped.slice(match[0].length),
	};
}

/** hc 终端名规则：1–32 位 `[a-z0-9._-]`。 */
export const AGENT_NAME_PATTERN = /^[a-z0-9._-]{1,32}$/;

/** 合法返回 undefined，否则返回给模型看的英文说明。 */
export function validateAgentName(name: string): string | undefined {
	if (AGENT_NAME_PATTERN.test(name)) return undefined;
	return "name must be 1-32 characters of a-z, 0-9, '.', '_' or '-' (herdr-core terminal name rule)";
}

/** 与 bash 工具一致：2000 行 / 50 KB，先到者生效。 */
export const RESULT_MAX_LINES = 2000;
export const RESULT_MAX_BYTES = 50 * 1024;

export interface TailTruncation {
	text: string;
	truncated: boolean;
}

function lineCount(text: string): number {
	if (text.length === 0) return 0;
	const lines = text.split("\n");
	return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

/** 按字节从尾部截一段，用于单行就超过上限的极端情况。 */
function tailByBytes(line: string, maxBytes: number): string {
	let start = line.length;
	let bytes = 0;
	while (start > 0) {
		const code = line.codePointAt(start - 1);
		if (code === undefined) break;
		const width = code > 0xffff ? 2 : 1;
		const char = line.slice(start - width, start);
		const size = Buffer.byteLength(char, "utf8");
		if (bytes + size > maxBytes) break;
		bytes += size;
		start -= width;
	}
	return line.slice(start);
}

/**
 * 尾部截断：保留最后 maxLines 行、且总字节不超过 maxBytes 的完整行。
 * 单行本身超限时退化为该行的字节尾巴（与 pi 的 `truncateTail` 行为一致）。
 */
export function truncateTail(
	text: string,
	maxLines = RESULT_MAX_LINES,
	maxBytes = RESULT_MAX_BYTES,
): TailTruncation {
	if (lineCount(text) <= maxLines && Buffer.byteLength(text, "utf8") <= maxBytes) {
		return { text, truncated: false };
	}

	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();

	const kept: string[] = [];
	let bytes = 0;
	for (let index = lines.length - 1; index >= 0 && kept.length < maxLines; index--) {
		const size = Buffer.byteLength(lines[index], "utf8") + (kept.length > 0 ? 1 : 0);
		if (bytes + size > maxBytes) break;
		kept.unshift(lines[index]);
		bytes += size;
	}

	if (kept.length === 0 && lines.length > 0) {
		return { text: tailByBytes(lines[lines.length - 1], maxBytes), truncated: true };
	}
	return { text: kept.join("\n"), truncated: true };
}
