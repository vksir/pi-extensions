/**
 * agent 之间的消息格式（纯函数，无 I/O，便于测试）。
 *
 * 消息经 hc 的 `terminal.send` 打进对方终端的输入框，对端 pi 收到的是普通用户输入。
 * hc 自己会给「发给 agent 的消息」套一层 `<hc from="t4m">…</hc>`（`notes = false` 时才不套），
 * 所以解析时先剥这层。
 *
 *   <agent_message from="a7k2" name="reviewer" type="task">
 *     <content>
 *       正文
 *     </content>
 *     <note>
 *       Your output is not returned automatically. Use agent_job send with type="reply" to reply.
 *     </note>
 *   </agent_message>
 *
 * type：task（派活）/ reply（回信）/ notice（扩展通知）。`<note>` 只在 task 带。
 * 正文统一缩进 4 格，解析时剥回；首尾由扩展生成，模型只写 content。
 *
 * 发送方地址就是 `from`：寻址一律用 id，发送时用 id 反查终端。
 */

import { piHerdrAgentPrompt } from "../prompt/pi-herdr-agent.ts";

/** 消息类型：派活、回信、扩展通知。 */
export type AgentMessageType = "task" | "reply" | "notice";

/** 解析出来的信封。 */
export interface AgentEnvelope {
	/** 发送方的 agent id。 */
	from: string;
	/** 发送方的显示名（可缺省）。 */
	name?: string;
	/** task / reply / notice。 */
	type: AgentMessageType;
	/** `<content>` 里的正文，缩进已剥掉。 */
	body: string;
}

export interface AgentEnvelopeInput {
	from: string;
	name?: string;
	/** 缺省按 task 处理。 */
	type?: AgentMessageType;
	body: string;
}

const HEADER_PATTERN =
	/^<agent_message\s+from="([^"]+)"(?:\s+name="([^"]*)")?\s+type="(task|reply|notice)">[ \t]*\r?\n?/;
const CONTENT_OPEN = "<content>";
const CONTENT_CLOSE = "</content>";
/** 正文缩进：格式化时加、解析时剥。 */
const INDENT = "    ";

/** hc 给消息套的运输层标签；先剥掉才能看到我们自己的首行。 */
const HC_OPEN_PATTERN = /^<hc\s+[^>\r\n]*>[ \t]*\r?\n?/;
const HC_CLOSE_PATTERN = /<\/hc>\s*$/;

/** 引号与尖括号会破坏属性；id/name 都来自受控取值，这里只做防御性清理。 */
function clean(value: string): string {
	return value.replace(/["<>\r\n]/g, "");
}

/** 每行非空加 4 格缩进；空行保持空行。 */
function indentBody(body: string): string {
	return body
		.split("\n")
		.map((line) => (line ? `${INDENT}${line}` : line))
		.join("\n");
}

/** 剥掉 `</content>` 两侧的换行与 4 格缩进。 */
function dedentBody(raw: string): string {
	const body = raw
		.replace(/^\r?\n/, "")
		.replace(/\r?\n[ \t]*$/, "")
		.split("\n")
		.map((line) => line.replace(/^ {4}/, ""))
		.join("\n");
	return body.trim() ? body : "";
}

/** 拼一条完整消息：根元素 + content（+ task 的 note）。 */
export function formatAgentEnvelope(envelope: AgentEnvelopeInput): string {
	const type = envelope.type ?? "task";
	const name = envelope.name ? ` name="${clean(envelope.name)}"` : "";
	const lines = [`<agent_message from="${clean(envelope.from)}"${name} type="${type}">`, `  ${CONTENT_OPEN}`];
	if (envelope.body) lines.push(indentBody(envelope.body));
	lines.push(`  ${CONTENT_CLOSE}`);
	if (type === "task") {
		lines.push("  <note>", `${INDENT}${piHerdrAgentPrompt.protocol.note}`, "  </note>");
	}
	lines.push("</agent_message>");
	return lines.join("\n");
}

/** 剥掉 hc CLI 的运输层包装，保留我们自己的消息。 */
export function stripHcTransport(text: string): string {
	return text.replace(HC_OPEN_PATTERN, "").replace(HC_CLOSE_PATTERN, "");
}

/**
 * 解析消息。不是信封（人打字、别的扩展消息）返回 undefined，调用方原样放行。
 * 宁可让模型看到一段怪文本，也不吞消息。
 */
export function parseAgentEnvelope(text: string): AgentEnvelope | undefined {
	// hc 的运输层包装（from 是发送终端地址；若 notes 被关掉则不存在）。
	const unwrapped = stripHcTransport(text);

	const header = HEADER_PATTERN.exec(unwrapped);
	if (!header) return undefined;

	const rest = unwrapped.slice(header[0].length);
	const open = rest.indexOf(CONTENT_OPEN);
	const close = rest.indexOf(CONTENT_CLOSE, open + CONTENT_OPEN.length);
	if (open < 0 || close < 0) return undefined;

	return {
		from: header[1],
		name: header[2] || undefined,
		type: header[3] as AgentMessageType,
		body: dedentBody(rest.slice(open + CONTENT_OPEN.length, close)),
	};
}

/** hc 终端名规则：1–32 位 `[a-z0-9._-]`。 */
export const AGENT_NAME_PATTERN = /^[a-z0-9._-]{1,32}$/;

/** 合法返回 undefined，否则返回给模型看的英文说明。 */
export function validateAgentName(name: string): string | undefined {
	if (AGENT_NAME_PATTERN.test(name)) return undefined;
	return "name must be 1-32 characters of a-z, 0-9, '.', '_' or '-' (herdr-core terminal name rule)";
}
