/**
 * agent 之间的消息首行（纯函数，无 I/O，便于测试）。
 *
 * 消息经 hc 的 `terminal.send` 打进对方终端的输入框，对端 pi 收到的是普通用户输入。
 * hc 自己会给「发给 agent 的消息」套一层 `<hc from="t4m">…</hc>`（`notes = false` 时才不套），
 * 所以解析时先剥这层，再看首行。
 *
 * 首行告诉接收方这条消息是哪个 agent 发的；正文末尾再挂一个 `<reply to="id">…</reply>`
 * 元素，说明“你的输出不会自动回到发送方，要回就用 agent_job send”。模型的注意力在
 * 结尾，这句话放在这里比塞进首行有效；回不回仍由模型自己决定。
 *
 *   <agent a7k2 "reviewer">
 *   正文
 *   <reply to="a7k2">Your output is not sent back automatically. Use agent_job send to reply.</reply>
 *
 * 发送方地址不写在首行：按术语表的「寻址一律用 id」，发送时用 id 反查终端。
 */

/** 解析出来的信封。 */
export interface AgentEnvelope {
	/** 发送方的 agent id。 */
	from: string;
	/** 发送方的显示名（可缺省）。 */
	name?: string;
	/** 首行之后的正文（末尾的 `<reply>` 提示已经剥掉）。 */
	body: string;
}

export interface AgentEnvelopeInput {
	from: string;
	name?: string;
	body: string;
}

const ENVELOPE_PATTERN = /^<agent\s+([^\s>"]+)(?:\s+"([^"]*)")?>[ \t]*\r?\n?/;
/** 末尾的回信提示；由本扩展固定生成，解析时剥掉。 */
const REPLY_TAIL_PATTERN = /\n*<reply to="[^"]*">[^<]*<\/reply>[ \t]*\r?\n?$/;;
/** hc 给消息套的运输层标签；先剥掉才能看到我们自己的首行。 */
const HC_OPEN_PATTERN = /^<hc\s+[^>\r\n]*>[ \t]*\r?\n?/;
const HC_CLOSE_PATTERN = /<\/hc>\s*$/;

/** 引号与尖括号会破坏首行；id/name 都来自受控取值，这里只做防御性清理。 */
function clean(value: string): string {
	return value.replace(/["<>\r\n]/g, "");
}

/** 消息首行；扩展拼出来、模型也能看到的那一行。 */
export function agentSourceLine(id: string, name?: string): string {
	const head = name ? `${clean(id)} "${clean(name)}"` : clean(id);
	return `<agent ${head}>`;
}

/** 末尾的回信提示元素：`to` 是回给谁。 */
export function agentReplyRequest(to: string): string {
	return `<reply to="${clean(to)}">Your output is not sent back automatically. Use agent_job send to reply.</reply>`;
}

export function formatAgentEnvelope(envelope: AgentEnvelopeInput): string {
	const body = `${envelope.body}\n\n${agentReplyRequest(envelope.from)}`;
	return `${agentSourceLine(envelope.from, envelope.name)}\n${body}`;
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

	let body = unwrapped.slice(match[0].length);
	const tail = REPLY_TAIL_PATTERN.exec(body);
	if (tail) body = body.slice(0, tail.index).replace(/[ \t]+\r?\n$/, "");

	return {
		from: match[1],
		name: match[2] || undefined,
		body,
	};
}

/** hc 终端名规则：1–32 位 `[a-z0-9._-]`。 */
export const AGENT_NAME_PATTERN = /^[a-z0-9._-]{1,32}$/;

/** 合法返回 undefined，否则返回给模型看的英文说明。 */
export function validateAgentName(name: string): string | undefined {
	if (AGENT_NAME_PATTERN.test(name)) return undefined;
	return "name must be 1-32 characters of a-z, 0-9, '.', '_' or '-' (herdr-core terminal name rule)";
}
