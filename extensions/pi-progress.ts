/**
 * Pi Progress Extension
 *
 * 长任务里让模型用一句话报告当前阶段，显示在输入框上方的 widget（`ctx.ui.setWidget`）。
 * widget 显示当前轮次最近 8 条；每次新的轮次（`agent_start`）开始时清空，所以它描述
 * 的是本次轮次正在做什么，不是完整日志。轮次结束后仍保留最后一批，方便人回看。
 *
 * 每条进展同时以 custom entry 写进会话（`pi.appendEntry`），`/progress` 从会话读回
 * 全部记录（含历史轮次）追加成一张卡片。记录不进模型上下文，resume / fork 后仍在。
 *
 * 会话切换与退出时清空 widget：widget 由扩展自己持有，不清就会把上一个会话的进展
 * 带到新会话。没有 UI 的模式（print）只返回确认，不写 widget。
 *
 * pi-herdr-agent 拉起的子 agent（注入 PI_AGENT_ID）不注册任何东西：它有自己的终端，
 * 但用户看的是父 agent 的 transcript。
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { inSubAgentProcess } from "./lib/herdr.ts";
import { renderProgressCall } from "./lib/tui/progress.ts";
import {
	PROGRESS_INFO_ENTRY,
	progressInfoEntryRenderer,
	type ProgressInfoEntry,
} from "./lib/tui/progress-history.ts";
import { renderProgressWidget } from "./lib/tui/progress-widget.ts";
import type { EntryLine } from "./lib/render.ts";
import { ERROR_PREFIX, piProgressPrompt } from "./prompt/pi-progress.ts";

/** widget 的 key；同一 key 重复设置即覆盖。 */
const WIDGET_KEY = "pi-progress";
/** 每条进展写进会话的 customType。 */
const ENTRY_TYPE = "pi-progress:entry";
/** 参数上限：一句话，不是阶段日志。 */
const MAX_CHARS = 120;

/** 一条进展：文本、所属轮次（从 1 开始）、写入时间。 */
export interface ProgressRecord {
	text: string;
	round: number;
	at: number;
}

interface ProgressDetails {
	text: string;
	error?: string;
}

/** 当前轮次、当前轮次的进展；widget 只读这两个。 */
let round = 0;
let current: ProgressRecord[] = [];

function clock(at: number): string {
	const date = new Date(at);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 从会话里读回全部进展；坏记录跳过，老数据不会让 `/progress` 崩。 */
function readRecords(ctx: ExtensionContext): ProgressRecord[] {
	const records: ProgressRecord[] = [];
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const data = entry.data as Partial<ProgressRecord> | undefined;
		if (!data || typeof data.text !== "string" || typeof data.at !== "number" || typeof data.round !== "number") {
			continue;
		}
		records.push({ text: data.text, round: data.round, at: data.at });
	}
	return records;
}

/** 会话里出现过的最大轮次；切换会话后从这里接着数，避免新轮次和历史轮次混号。 */
function maxRound(records: readonly ProgressRecord[]): number {
	return records.reduce((max, record) => Math.max(max, record.round), 0);
}

/** 把全部进展拼成 `/progress` 卡片的行；按轮次分组，组内保持写入顺序。 */
export function progressLines(records: readonly ProgressRecord[]): EntryLine[] {
	if (records.length === 0) return [{ text: "progress · 还没有记录", tone: "dim" }];

	const ordered: ProgressRecord[][] = [];
	const byRound = new Map<number, ProgressRecord[]>();
	for (const record of records) {
		const bucket = byRound.get(record.round);
		if (bucket) {
			bucket.push(record);
		} else {
			const created = [record];
			byRound.set(record.round, created);
			ordered.push(created);
		}
	}

	const lines: EntryLine[] = [
		{ text: `progress · 共 ${records.length} 条 · ${ordered.length} 轮` },
		{ text: "" },
	];
	for (const bucket of ordered) {
		lines.push({ text: `第 ${bucket[0].round} 轮 · ${clock(bucket[0].at)}`, tone: "accent" });
		for (const record of bucket) {
			lines.push({ text: `  ${clock(record.at)}  ▸ ${record.text}`, tone: "muted" });
		}
	}
	return lines;
}

/** 清掉进展行；shutdown 期间 UI 可能已拆，失败不影响退出。 */
function clearWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	} catch {
		// UI 已经不可用，任务结束；没有需要保留的进展。
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
	if (inSubAgentProcess()) return;

	// 新一轮开始：上一轮的进展从 widget 上退场，但记录已经写进会话，`/progress` 还能看到。
	pi.on("agent_start", (_event, ctx) => {
		round += 1;
		current = [];
		clearWidget(ctx);
	});

	// widget 跟着会话走；轮次编号接着会话里已有的最大轮次数。
	pi.on("session_start", (_event, ctx) => {
		current = [];
		round = maxRound(readRecords(ctx));
		clearWidget(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		current = [];
		clearWidget(ctx);
	});

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
			// widget 和工具行都只放一行；多余空白压成单空格，防止进展行被换行撑开。
			const text = params.text.replace(/\s+/g, " ").trim();
			if (!text) return failure(piProgressPrompt.results.errors.empty());
			if (text.length > MAX_CHARS) return failure(piProgressPrompt.results.errors.tooLong(MAX_CHARS));

			const record: ProgressRecord = { text, round: Math.max(round, 1), at: Date.now() };
			current = [...current, record];
			pi.appendEntry<ProgressRecord>(ENTRY_TYPE, record);
			if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => renderProgressWidget(current, theme));

			return {
				content: [{ type: "text" as const, text: piProgressPrompt.results.shown() }],
				details: { text } as ProgressDetails,
			};
		},

		renderCall: renderProgressCall,
	});

	pi.registerCommand("progress", {
		description: "显示所有进展，含历史轮次",
		handler: async (_rawArgs, ctx) => {
			pi.appendEntry<ProgressInfoEntry>(PROGRESS_INFO_ENTRY, { lines: progressLines(readRecords(ctx)) });
		},
	});

	pi.registerEntryRenderer<ProgressInfoEntry>(PROGRESS_INFO_ENTRY, progressInfoEntryRenderer);
}
