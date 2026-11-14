/**
 * agent 之间的消息信封与结果整形（纯函数，无 I/O，便于测试）。
 *
 * 消息经 hc 的 `terminal.send` 打进对方终端的输入框，对端 pi 收到的是普通用户输入。
 * hc 自己会给“发给 agent 的消息”套一层 `<hc from="t4m">…</hc>`（`notes = false` 时
 * 才不套），所以解析时先剥这层，再看信封。为了既让接收方的扩展知道「谁发的、是什么」，
 * 又不把这层机器信息喂给模型，信封是**首行一行标签**，接收方在 `input` 事件里剥掉它，
 * 只把正文交下去：
 *
 *   <pi-agent from="a7k2" addr="t7" name="reviewer" kind="ask">
 *   ...正文...
 *
 * `kind` 三种：
 * - `ask`    提问（拉起时的那条 prompt 也算）。接收方把它记成当轮 asker，settle 时回发结果。
 * - `steer`  插话。不改 asker。
 * - `result` 结果回发。不设 asker，避免 A→B→A 的回环。
 *
 * 结果正文前保留一行可见来源（`[agent a7k2 · reviewer]`），让模型知道是谁交的活。
 * 正文超过 bash 工具同款上限（2000 行 / 50 KB）时按尾部截断，全文另存临时文件，由
 * asker 自己去读。
 */

/** 信封种类；`result` 同时承载「卡住（blocked）」「忙（busy）」这类非提问回报。 */
export type AgentEnvelopeKind = "ask" | "steer" | "result";

export interface AgentEnvelope {
	kind: AgentEnvelopeKind;
	/** 发送方的 agent id。 */
	from: string;
	/** 发送方的 hc 终端地址；结果直接回发到这里，省一次寻址。 */
	addr: string;
	/** 发送方的显示名（可缺省）。 */
	name?: string;
	/** 剥掉信封首行后的正文。 */
	body: string;
}

export interface AgentEnvelopeInput {
	kind: AgentEnvelopeKind;
	from: string;
	addr: string;
	name?: string;
	body: string;
}

const ENVELOPE_PATTERN = /^<pi-agent\s+([^>\r\n]*)>[ \t]*\r?\n?/;
const ATTRIBUTE_PATTERN = /([A-Za-z][A-Za-z0-9_-]*)="([^"]*)"/g;
/** hc 给消息套的运输层标签；先剥掉才能看到我们自己的信封。 */
const HC_OPEN_PATTERN = /^<hc\s+[^>\r\n]*>[ \t]*\r?\n?/;
const HC_CLOSE_PATTERN = /<\/hc>\s*$/;

/** 引号与尖括号会破坏信封；id/addr/name 都来自受控取值，这里只做防御性清理。 */
function attribute(value: string): string {
	return value.replace(/["<>\r\n]/g, "");
}

export function formatAgentEnvelope(envelope: AgentEnvelopeInput): string {
	const attributes = [
		`from="${attribute(envelope.from)}"`,
		`addr="${attribute(envelope.addr)}"`,
	];
	if (envelope.name) attributes.push(`name="${attribute(envelope.name)}"`);
	attributes.push(`kind="${envelope.kind}"`);
	return `<pi-agent ${attributes.join(" ")}>\n${envelope.body}`;
}

/**
 * 解析首行信封。不是信封（普通人打字、别的扩展消息）返回 undefined，调用方原样放行。
 * 属性不全或 kind 不认识也按「不是信封」处理——宁可让模型看到一行怪文本，也不吞消息。
 */
export function parseAgentEnvelope(text: string): AgentEnvelope | undefined {
	// hc 的运输层包装（from 是发送终端地址；若 notes 被关掉则不存在）。
	const unwrapped = text.replace(HC_OPEN_PATTERN, "");

	const match = ENVELOPE_PATTERN.exec(unwrapped);
	if (!match) return undefined;

	const attributes: Record<string, string> = {};
	for (const attributeMatch of match[1].matchAll(ATTRIBUTE_PATTERN)) {
		attributes[attributeMatch[1]] = attributeMatch[2];
	}

	const kind = attributes.kind;
	if (kind !== "ask" && kind !== "steer" && kind !== "result") return undefined;
	if (!attributes.from || !attributes.addr) return undefined;

	return {
		kind,
		from: attributes.from,
		addr: attributes.addr,
		name: attributes.name || undefined,
		body: unwrapped.slice(match[0].length).replace(HC_CLOSE_PATTERN, ""),
	};
}

/** hc 终端名规则：1–32 位 `[a-z0-9._-]`。 */
export const AGENT_NAME_PATTERN = /^[a-z0-9._-]{1,32}$/;

/** 合法返回 undefined，否则返回给模型看的英文说明。 */
export function validateAgentName(name: string): string | undefined {
	if (AGENT_NAME_PATTERN.test(name)) return undefined;
	return "name must be 1-32 characters of a-z, 0-9, '.', '_' or '-' (herdr-core terminal name rule)";
}

/** 结果正文前的可见来源行。 */
export function agentSourceLine(id: string, name?: string): string {
	return name ? `[agent ${id} · ${name}]` : `[agent ${id}]`;
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
