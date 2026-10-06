/**
 * 子 Agent 与主 Agent 之间的基础本地 IPC 消息。
 *
 * 不设计确认接收、重连、去重或可靠投递：每条消息一个连接、一行 JSON、发完即关。
 */
/** 子 session 中记录工作轮次计数器的 entry 类型（appendEntry，不进入 LLM 上下文）。 */
export const ROUND_ENTRY_TYPE = "pi-subagent-round";

export type ResultStatus = "completed" | "aborted" | "error";

export interface SubagentResultMessage {
	ownerKey: string;
	/** 实例名 */
	name: string;
	/** Agent 定义类型名 */
	type: string;
	/** 工作轮次编号，自子 session 起算 */
	round: number;
	status: ResultStatus;
	/** 最终回复原文，完整回传，不截断、不摘要 */
	reply: string;
	sessionId: string;
	sessionFile: string | undefined;
}

export function encodeMessage(message: SubagentResultMessage): string {
	return `${JSON.stringify(message)}\n`;
}

/** 宽容解析：结构不符或非 JSON 一律返回 undefined，由调用方忽略。 */
export function parseMessage(text: string): SubagentResultMessage | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const { ownerKey, name, type, round, status, reply } = record;
	if (typeof ownerKey !== "string" || typeof name !== "string" || typeof type !== "string") return undefined;
	if (typeof round !== "number" || typeof reply !== "string") return undefined;
	if (status !== "completed" && status !== "aborted" && status !== "error") return undefined;
	return {
		ownerKey,
		name,
		type,
		round,
		status,
		reply,
		sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
		sessionFile: typeof record.sessionFile === "string" ? record.sessionFile : undefined,
	};
}
