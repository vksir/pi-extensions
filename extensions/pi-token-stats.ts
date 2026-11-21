/**
 * Token Stats Extension
 *
 * 全局 Token 用量与耗时统计。每次 turn_end 从事件中提取 usage，写进 agent dir 下的
 * SQLite 库；不做任何 session 文件扫描。
 *
 * `/token` 默认看过去 1 小时，也可以 `/token 3h`、`/token 30m`、`/token all`。
 * 所有会话、所有进程的记录都在同一个库里，按模型汇总成一张表，只列平均首字与
 * 平均输出速率。
 *
 * footer 状态行里插入最近一次响应的首字时间与输出速率（如 `R1.5M 0.9s 42t/s CH97.1%`），
 * 由 lib/footer-rate.ts 包一层内置 footer 实现。
 *
 * 数据库在 `~/.pi/agent/pi-token-stats/token-stats.db`，只保留 `turn` 明细；schema v2
 * 打开时把旧的 `day_model` / `session` 汇总改名归档，见 lib/token-stats-db.ts。读写都交给
 * lib/token-stats-worker.ts 的 worker 线程，主线程只收发消息，不碰 SQLite。entry 渲染在
 * lib/render.ts。
 */

import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type AutocompleteItem } from "@earendil-works/pi-tui";
import { createFirstTokenTimer, createRateFooter, formatFirstToken, formatRate } from "./lib/footer-rate.ts";
import { renderDimLines } from "./lib/render.ts";
import { openTokenStatsClient, type TokenStatsClient } from "./lib/token-stats-client.ts";
import type { WindowModelRow } from "./lib/token-stats-db.ts";

// ─── 存储 ───

function tokenStatsDir(): string {
	return join(getAgentDir(), "pi-token-stats");
}

let client: TokenStatsClient | undefined;

/**
 * 懒启动写线程：建库、迁移、写入、查询都在 worker 里排队，
 * 主线程只收发消息，不碰 SQLite。
 */
function statsClient(): TokenStatsClient {
	if (!client) {
		client = openTokenStatsClient({ dbPath: join(tokenStatsDir(), "token-stats.db") });
	}
	return client;
}

interface TokenStatsEntry {
	lines: string[];
}

// ─── 时间窗 ───

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DEFAULT_WINDOW_MS = HOUR_MS;
const UNIT_MS: Record<string, number> = { m: MINUTE_MS, h: HOUR_MS, d: 86_400_000 };

export interface TokenWindow {
	/** 窗口起点（epoch ms，含）；0 表示全部历史 */
	since: number;
	/** 显示用标签：1h / 30m / 1d / 1h30m / all */
	label: string;
}

/**
 * 解析 `/token` 参数：空 = 过去 1 小时；`3h` / `30m` / `1d`；可连写（`1h30m` 或
 * `1h 30m`）；`all` = 全部历史。非法参数抛错，由命令处理成通知。
 */
export function parseTokenWindow(args: string, now: number = Date.now()): TokenWindow {
	const text = args.trim().toLowerCase();
	if (!text) return { since: now - DEFAULT_WINDOW_MS, label: "1h" };
	if (text === "all") return { since: 0, label: "all" };

	let ms = 0;
	for (const part of text.split(/\s+/)) {
		if (!/^(?:\d+[mhd])+$/.test(part)) throw new Error(`unknown argument '${part}'`);
		for (const match of part.matchAll(/(\d+)([mhd])/g)) {
			ms += Number(match[1]) * UNIT_MS[match[2]!]!;
		}
	}
	if (ms <= 0) throw new Error("window must be greater than 0");
	return { since: now - ms, label: formatWindowLabel(ms) };
}

/** 把毫秒写成紧凑标签：`30m`、`3h`、`1d`、`1h30m`。 */
export function formatWindowLabel(ms: number): string {
	const totalMinutes = Math.round(ms / MINUTE_MS);
	if (totalMinutes < 60) return `${totalMinutes}m`;
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	return `${days > 0 ? `${days}d` : ""}${hours > 0 ? `${hours}h` : ""}${minutes > 0 ? `${minutes}m` : ""}`;
}

// ─── 表格渲染 ───

interface ModelStats {
	label: string;
	turns: number;
	timedOutput: number;
	timedMs: number;
	firstTokenMs: number;
	firstTokenSamples: number;
}

const INDENT = "  ";
const GAP = "   ";
const TURNS_WIDTH = 5;
const TTFT_WIDTH = 6;
const RATE_WIDTH = 7;

/** 模型列显示 `provider/model`；模型名已经带 provider 前缀时不重复。 */
function modelLabel(row: WindowModelRow): string {
	const provider = row.provider.trim();
	const model = row.model.trim() || "unknown";
	if (!provider || model === provider || model.startsWith(`${provider}/`)) return model;
	return `${provider}/${model}`;
}

function toStats(row: WindowModelRow): ModelStats {
	return {
		label: modelLabel(row),
		turns: row.turns,
		timedOutput: row.timedOutput,
		timedMs: row.timedMs,
		firstTokenMs: row.firstTokenMs,
		firstTokenSamples: row.firstTokenSamples,
	};
}

function totalStats(rows: ModelStats[]): ModelStats {
	return {
		label: "All models",
		turns: rows.reduce((sum, row) => sum + row.turns, 0),
		timedOutput: rows.reduce((sum, row) => sum + row.timedOutput, 0),
		timedMs: rows.reduce((sum, row) => sum + row.timedMs, 0),
		firstTokenMs: rows.reduce((sum, row) => sum + row.firstTokenMs, 0),
		firstTokenSamples: rows.reduce((sum, row) => sum + row.firstTokenSamples, 0),
	};
}

function averageTtft(stats: ModelStats): number | undefined {
	if (stats.firstTokenSamples <= 0) return undefined;
	return stats.firstTokenMs / stats.firstTokenSamples;
}

/** 按 token 加权：输出之和 ÷ 耗时之和，不是逐次速率的算术平均。 */
function averageRate(stats: ModelStats): number | undefined {
	if (stats.timedMs <= 0) return undefined;
	return stats.timedOutput / (stats.timedMs / 1000);
}

function padCell(text: string, width: number, align: "left" | "right" = "left"): string {
	const pad = " ".repeat(Math.max(0, width - visibleWidth(text)));
	return align === "right" ? pad + text : text + pad;
}

/** 截断到指定宽度并补省略号；不用 pi-tui 的 truncateToWidth，避免它插入 ANSI 重置打断 dim 色。 */
function clipCell(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	if (width <= 1) return "…";
	let out = "";
	let used = 0;
	for (const char of text) {
		const w = visibleWidth(char);
		if (used + w > width - 1) break;
		out += char;
		used += w;
	}
	return `${out}…`;
}

function renderCells(cells: [string, string, string, string], modelWidth: number): string {
	return (
		INDENT +
		padCell(clipCell(cells[0], modelWidth), modelWidth) +
		GAP +
		padCell(cells[1], TURNS_WIDTH, "right") +
		GAP +
		padCell(cells[2], TTFT_WIDTH, "right") +
		GAP +
		padCell(cells[3], RATE_WIDTH, "right")
	);
}

function renderStatsRow(stats: ModelStats, modelWidth: number): string {
	const ttft = averageTtft(stats);
	const rate = averageRate(stats);
	return renderCells(
		[
			stats.label,
			String(stats.turns),
			ttft === undefined ? "-" : formatFirstToken(ttft),
			rate === undefined ? "-" : formatRate(rate),
		],
		modelWidth,
	);
}

function tableRule(modelWidth: number): string {
	return (
		INDENT +
		"─".repeat(modelWidth) +
		GAP +
		"─".repeat(TURNS_WIDTH) +
		GAP +
		"─".repeat(TTFT_WIDTH) +
		GAP +
		"─".repeat(RATE_WIDTH)
	);
}

/**
 * 只负责排版：按模型聚合的行由 worker 查好，这里保持纯函数，方便单测。
 */
export function renderStats(rows: WindowModelRow[], window: TokenWindow, width = 80): string[] {
	const title = window.label === "all" ? "📊 Token Speed · All time" : `📊 Token Speed · Last ${window.label}`;
	const lines: string[] = [`${INDENT}${title}`, ""];

	if (rows.length === 0) {
		lines.push(
			INDENT + (window.label === "all" ? "No turns recorded yet." : `No turns in the last ${window.label}.`),
			"",
		);
		return lines;
	}

	const stats = rows.map(toStats).sort((a, b) => b.turns - a.turns || a.label.localeCompare(b.label));
	const all = totalStats(stats);
	const longest = Math.max(...stats.map((row) => visibleWidth(row.label)), visibleWidth("Model"));
	const available =
		width - INDENT.length - GAP.length * 3 - TURNS_WIDTH - TTFT_WIDTH - RATE_WIDTH;
	const modelWidth = Math.max(4, Math.min(longest, available));

	lines.push(renderCells(["Model", "Turns", "TTFT", "Rate"], modelWidth));
	lines.push(tableRule(modelWidth));
	for (const row of stats) lines.push(renderStatsRow(row, modelWidth));
	lines.push(tableRule(modelWidth));
	lines.push(renderStatsRow(all, modelWidth));
	lines.push("");
	lines.push(`${INDENT}TTFT = average time to first token`);
	lines.push(`${INDENT}Rate = output tokens ÷ full request time`);
	lines.push("");
	return lines;
}

/** /token 的参数候选。可多写（如 `/token 1h 30m`），补全时排除已写过的 */
const TOKEN_ARGS: AutocompleteItem[] = [
	{ value: "1h", label: "1h", description: "过去 1 小时（默认）" },
	{ value: "3h", label: "3h", description: "过去 3 小时" },
	{ value: "6h", label: "6h", description: "过去 6 小时" },
	{ value: "12h", label: "12h", description: "过去 12 小时" },
	{ value: "24h", label: "24h", description: "过去 24 小时" },
	{ value: "all", label: "all", description: "全部历史" },
];

/**
 * 只补正在输入的最后一个参数，并排除已写过的。补全项的 `value` 带上前面已写好的参数：
 * pi 的参数补全会整段替换参数文本，不带上的话 `/token all 3` 补完会变成 `/token 3h`，
 * 前一个参数被吃掉。
 */
export function tokenArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	// 不 trim：末尾的空格表示上一个参数已写完，此时该补下一个
	const parts = prefix.split(/\s+/);
	const current = (parts.pop() ?? "").toLowerCase();
	const done = parts.filter(Boolean);
	const used = new Set(done.map((part) => part.toLowerCase()));
	const items = TOKEN_ARGS.filter(
		(item) => !used.has(item.value.toLowerCase()) && item.value.toLowerCase().startsWith(current),
	);
	if (items.length === 0) return null;
	const lead = done.length > 0 ? `${done.join(" ")} ` : "";
	return items.map((item) => ({ ...item, value: `${lead}${item.value}` }));
}

// ─── 扩展 ───

export default function (pi: ExtensionAPI) {
	// 首字时间只能在流式过程中测：消息落盘后只剩耗时（durationMs），没有首字点。
	const firstToken = createFirstTokenTimer();

	pi.registerEntryRenderer<TokenStatsEntry>("token-stats", (entry, _options, theme) =>
		renderDimLines(theme, entry.data?.lines ?? ["(no data)"]),
	);

	// footer 只在交互模式下可换：默认 footer 原样保留，多一段首字时间与输出速率。
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((_tui, _theme, footerData) =>
			createRateFooter(ctx, footerData, {
				isAutoCompactEnabled: () => pi.getSettings().compaction?.enabled ?? true,
				firstTokenMs: (requestTimestamp) => firstToken.firstTokenMs(requestTimestamp),
			}),
		);
	});

	// 第一个内容块到达即为首字，用 assistant 消息的 timestamp（请求开始时刻）作起点。
	pi.on("message_update", (event, _ctx) => {
		if (event.message.role !== "assistant") return;
		firstToken.record(event.message, event.assistantMessageEvent);
	});

	// turn_end: 从事件中直接取 usage，写一轮明细
	pi.on("turn_end", (event, ctx) => {
		try {
			// event.message 是所有消息的联合类型，只有 assistant 消息带 usage
			const msg = event.message as AssistantMessage | undefined;
			if (!msg?.usage) return;
			const usage = msg.usage;
			const model = msg.provider && msg.model ? `${msg.provider}/${msg.model}` : msg.model || "unknown";
			// 首字时间只在流式过程中测得到，必须当场落盘，否则重启后无从补算。
			statsClient().recordTurn({
				at: Date.now(),
				sessionId: ctx.sessionManager.getSessionId(),
				sessionName: ctx.sessionManager.getSessionName(),
				provider: msg.provider ?? "unknown",
				model,
				usage: {
					input: usage.input ?? 0,
					output: usage.output ?? 0,
					cacheRead: usage.cacheRead ?? 0,
					cacheWrite: usage.cacheWrite ?? 0,
					cost: usage.cost?.total ?? 0,
				},
				durationMs: msg.durationMs,
				firstTokenMs: firstToken.firstTokenMs(msg.timestamp),
			});
		} catch {
			/* ignore */
		}
	});

	pi.registerCommand("token", {
		description: "过去 1 小时的 Token 速率。参数: 3h / 30m / 24h / all",
		getArgumentCompletions: (prefix) => tokenArgumentCompletions(prefix),
		handler: async (args, ctx) => {
			try {
				const window = parseTokenWindow(args);
				// 查询走写线程：按 FIFO 一定看得到之前所有已提交的 turn，主线程不被 SQLite 阻塞
				const rows = await statsClient().windowRows(window.since);
				// entry 外层 Box 左右各留 1 格，表格按可用内容宽度排版
				const columns = (process.stdout as { columns?: number })?.columns || 80;
				const width = Math.max(20, columns - 2);
				pi.appendEntry<TokenStatsEntry>("token-stats", { lines: renderStats(rows, window, width) });
			} catch (e) {
				ctx.ui.notify(`[error] ${(e as Error).message}`, "error");
			}
		},
	});
}
