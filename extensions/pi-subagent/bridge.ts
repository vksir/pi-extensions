/**
 * pi-subagent 桥接：运行在子 Agent 进程内。
 *
 * 父 Agent 用 `-ne -e <bridge.ts>` 启动子进程，因此子 Agent 只加载这份桥接能力，
 * 不会获得本扩展的委派工具，也不继承其他扩展行为。
 *
 * 工作轮次以 `agent_settled` 为边界（`agent_end` 可能早于自动恢复或后续工作）；
 * 轮次计数用 appendEntry 落在子 session 中，不进入 LLM 上下文。
 */
import { connect } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { encodeMessage, ROUND_ENTRY_TYPE, type ResultStatus, type SubagentResultMessage } from "./protocol.ts";

const OWNER_KEY_ENV = "PI_SUBAGENT_OWNER_KEY";
const NAME_ENV = "PI_SUBAGENT_NAME";
const TYPE_ENV = "PI_SUBAGENT_TYPE";
const PIPE_ENV = "PI_SUBAGENT_PIPE";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (part === null || typeof part !== "object") return "";
			const record = part as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

/** 取本轮最后一次自动工作留下的助手回复；没有则空串。 */
function lastAssistantText(messages: readonly unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message === null || typeof message !== "object") continue;
		const record = message as Record<string, unknown>;
		if (record.role === "assistant") return textOf(record.content);
	}
	return "";
}

function countRounds(ctx: ExtensionContext): number {
	const entries = ctx.sessionManager.getEntries();
	let count = 0;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === ROUND_ENTRY_TYPE) count += 1;
	}
	return count;
}

function send(pipe: string, message: SubagentResultMessage, ctx: ExtensionContext): void {
	const socket = connect(pipe);
	socket.on("error", (error) => {
		// 失败只报告，不重试、不降级、不写结果文件。
		ctx.ui.notify(`[pi-subagent] could not deliver the work round result: ${error.message}`, "error");
	});
	socket.on("connect", () => {
		socket.end(encodeMessage(message));
	});
}

export default function (pi: ExtensionAPI) {
	const ownerKey = process.env[OWNER_KEY_ENV];
	const name = process.env[NAME_ENV];
	const type = process.env[TYPE_ENV];
	const pipe = process.env[PIPE_ENV];
	// 不是子 Agent 进程（例如人工直接加载该文件）时不注册任何行为。
	if (!ownerKey || !name || !type || !pipe) return;

	let round = 0;
	let reply: string | undefined;
	let outcome: ResultStatus | undefined;

	pi.on("session_start", (_event, ctx) => {
		round = countRounds(ctx);
	});

	pi.on("agent_end", (event) => {
		reply = lastAssistantText(event.messages);
	});

	pi.on("agent_before_settle", (event) => {
		outcome = event.outcome;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (reply === undefined && outcome === undefined) return;
		round += 1;
		pi.appendEntry(ROUND_ENTRY_TYPE, { round });
		send(
			pipe,
			{
				ownerKey,
				name,
				type,
				round,
				status: outcome ?? "completed",
				reply: reply ?? "",
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile(),
			},
			ctx,
		);
		reply = undefined;
		outcome = undefined;
	});
}
