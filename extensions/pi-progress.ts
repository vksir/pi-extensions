/**
 * Pi Progress Extension
 *
 * 长任务里让模型用一句话报告当前阶段，显示在 footer 状态行（`ctx.ui.setStatus`）。
 * 每次新的轮次（`agent_start`）开始时清空，所以它描述的是本次轮次正在做什么，
 * 不是历史日志；轮次结束后仍保留最后一条，方便人回看这次跑到了哪里。
 *
 * 会话切换与退出时也清空：footer 的扩展状态行在会话之间共享，不清就会把上一个
 * 会话的进展带到新会话。没有 UI 的模式（print）只返回确认，不写状态。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { inSubAgentProcess } from "./lib/herdr.ts";
import { renderProgressCall } from "./lib/tui/progress.ts";
import { ERROR_PREFIX, piProgressPrompt } from "./prompt/pi-progress.ts";

/** footer 状态行的 key；pi 按 key 排序拼接多个扩展状态。 */
const STATUS_KEY = "pi-progress";
/** 状态行前缀，和别的扩展状态区分开。 */
const STATUS_PREFIX = "▸ ";
/** 参数上限：一句话，不是阶段日志。 */
const MAX_CHARS = 120;

interface ProgressDetails {
	text: string;
	error?: string;
}

/** 清掉 footer 状态；shutdown 期间 UI 可能已拆，失败不影响退出。 */
function clearStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	} catch {
		// UI 已经不可用，任务结束；没有需要保留的状态。
	}
}

/** 失败结果：模型看到前缀 + 小写实体开头，UI 拿 details.error。 */
function failure(message: string) {
	return {
		content: [{ type: "text" as const, text: `${ERROR_PREFIX}${message}` }],
		details: { text: "", error: message } as ProgressDetails,
		isError: true,
	};
}

export default function progressExtension(pi: ExtensionAPI): void {
	// pi-herdr-agent 拉起的子 agent 注入 PI_AGENT_ID：它有自己的终端，但用户看的是
	// 父 agent 的 transcript；子 agent 报告进展只会写进没人盯着的状态行。
	if (inSubAgentProcess()) return;

	// 新一轮开始：上一轮的进展已经过时。
	pi.on("agent_start", (_event, ctx) => clearStatus(ctx));
	// 状态行跨会话共享，换会话/退出时也要清。
	pi.on("session_start", (_event, ctx) => clearStatus(ctx));
	pi.on("session_shutdown", (_event, ctx) => clearStatus(ctx));

	pi.registerTool({
		name: "progress",
		label: "Progress",
		description: piProgressPrompt.declarations.progress.description,
		promptSnippet: piProgressPrompt.system.snippets.progress,
		parameters: Type.Object({
			text: Type.String({
				description: piProgressPrompt.declarations.progress.parameters.text,
				maxLength: MAX_CHARS,
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// footer 和工具行都只放一行；多余空白压成单空格，防止状态行被换行撑开。
			const text = params.text.replace(/\s+/g, " ").trim();
			if (!text) return failure(piProgressPrompt.results.errors.empty());
			if (text.length > MAX_CHARS) return failure(piProgressPrompt.results.errors.tooLong(MAX_CHARS));

			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `${STATUS_PREFIX}${text}`);
			return {
				content: [{ type: "text" as const, text: piProgressPrompt.results.shown() }],
				details: { text } as ProgressDetails,
			};
		},

		renderCall: renderProgressCall,
	});
}
