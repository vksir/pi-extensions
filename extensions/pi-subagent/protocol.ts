/**
 * 子 Agent 与主 Agent 之间的基础本地 IPC 消息。
 *
 * 不设计确认接收、重连、去重或可靠投递：每条消息一个连接、一行 JSON、发完即关。
 */
/** 子 session 中记录工作轮次计数器的 entry 类型（appendEntry，不进入 LLM 上下文）。 */
export const ROUND_ENTRY_TYPE = "pi-subagent-round";
/** 子 session 中记录实例绑定的 entry 类型（appendEntry，不进入 LLM 上下文）。 */
export const BINDING_ENTRY_TYPE = "pi-subagent-binding";

export type ResultStatus = "completed" | "aborted" | "error";

/** 实例绑定：子 session 的持久身份，用于拒绝回收后拿同名实例悄悄换角色。 */
export interface SubagentBinding {
	ownerKey: string;
	name: string;
	type: string;
}

/** 子 Agent 启动握手：报告身份，以及该子 session 中已保存的绑定。 */
export interface BindingMessage extends SubagentBinding {
	kind: "binding";
	/** 已保存的绑定；首次启动的子 session 没有。 */
	bound?: SubagentBinding;
}

export interface ResultMessage {
	kind: "result";
	ownerKey: string;
	name: string;
	type: string;
	/** 工作轮次编号，自子 session 起算 */
	round: number;
	status: ResultStatus;
	/** 最终回复原文，完整回传，不截断、不摘要 */
	reply: string;
	sessionId: string;
	sessionFile: string | undefined;
}

export type ChildMessage = BindingMessage | ResultMessage;

export function encodeMessage(message: ChildMessage): string {
	return `${JSON.stringify(message)}\n`;
}

function asBinding(value: unknown): SubagentBinding | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.ownerKey !== "string" || typeof record.name !== "string" || typeof record.type !== "string") return undefined;
	return { ownerKey: record.ownerKey, name: record.name, type: record.type };
}

/** 宽容解析：结构不符或非 JSON 一律返回 undefined，由调用方忽略。 */
export function parseMessage(text: string): ChildMessage | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const identity = asBinding(record);
	if (!identity) return undefined;

	// 不携带 kind 的消息按工作轮次结果处理，兼容更新扩展时仍在运行的子进程。
	if (record.kind === "binding") {
		return { kind: "binding", ...identity, bound: asBinding(record.bound) };
	}
	if (record.kind !== undefined && record.kind !== "result") return undefined;

	const { round, status, reply } = record;
	if (typeof round !== "number" || typeof reply !== "string") return undefined;
	if (status !== "completed" && status !== "aborted" && status !== "error") return undefined;
	return {
		kind: "result",
		...identity,
		round,
		status,
		reply,
		sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
		sessionFile: typeof record.sessionFile === "string" ? record.sessionFile : undefined,
	};
}
