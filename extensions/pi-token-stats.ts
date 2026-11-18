/**
 * Token Stats Extension
 *
 * 全局 Token 用量统计。每次 turn_end 从事件中提取 usage，写进 agent dir 下的
 * SQLite 库；不做任何 session 文件扫描。
 *
 * 一次响应写三处（见 lib/token-stats-db.ts）：原始明细 `turn`、按天 × 模型的
 * `day_model`、按会话的 `session`。报告末尾只列**当前会话**的平均首字与平均输出速率
 * （按 token 加权），历史会话留在库里，不参与展示。
 *
 * 命令：
 *   /token             — 近 7 天统计 + Input 柱状图 + 当前会话速率（默认）
 *   /token all         — 全部历史统计（/token 0d 亦可）
 *   /token 3d          — 近 3 天（Nd 任意天数）
 *   /token out         — 显示 Output 柱状图（可与天数组合，如 /token 7d Out）
 *
 * footer 状态行里插入最近一次响应的首字时间与输出速率（如 `R1.5M 0.9s 42t/s CH97.1%`），
 * 由 lib/footer-rate.ts 包一层内置 footer 实现。
 *
 * 数据库在 `~/.pi/agent/pi-token-stats/token-stats.db`；旧 JSON 的静默迁移是临时代码，
 * 见 lib/token-stats-legacy.ts，下个版本删除。entry 渲染在 lib/render.ts。
 */

import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createFirstTokenTimer, createRateFooter, formatFirstToken, formatRate } from "./lib/footer-rate.ts";
import { renderDimLines } from "./lib/render.ts";
import { averageFirstTokenMs, averageOutputRate, type SessionRecord, type SessionUsageTotals } from "./lib/session-usage.ts";
import { openTokenStatsStore, type DayModelRow, type TokenStatsStore } from "./lib/token-stats-db.ts";
import { importLegacyCache } from "./lib/token-stats-legacy.ts";

// ─── 存储 ───

/** 下个版本删掉这一行与 importLegacyCache 的 import：旧 JSON 迁移是临时的。 */
const LEGACY_CACHE_FILE = "token-stats.json";

function tokenStatsDir(): string {
	return join(getAgentDir(), "pi-token-stats");
}

let store: TokenStatsStore | undefined;

/** 懒开库：首次用到时才建目录、建库、跑一次静默迁移。 */
function statsStore(): TokenStatsStore {
	if (!store) {
		store = openTokenStatsStore(join(tokenStatsDir(), "token-stats.db"));
		// 临时：把旧版 token-stats.json 静默导入，下个版本删除本行
		importLegacyCache(store, join(getAgentDir(), LEGACY_CACHE_FILE));
	}
	return store;
}

// ─── usage 聚合 ───

type ModelUsage = SessionUsageTotals;

interface TokenStatsEntry {
	lines: string[];
}

function emptyUsage(): ModelUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsage(target: ModelUsage, usage: ModelUsage): void {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.cost += usage.cost;
}

function computeTotalsByModel(rows: DayModelRow[]): Map<string, ModelUsage> {
	const byModel = new Map<string, ModelUsage>();
	for (const row of rows) {
		let acc = byModel.get(row.model);
		if (!acc) {
			acc = emptyUsage();
			byModel.set(row.model, acc);
		}
		addUsage(acc, row);
	}
	return byModel;
}

function sumUsage(byModel: Map<string, ModelUsage>): ModelUsage {
	const total = emptyUsage();
	for (const usage of byModel.values()) addUsage(total, usage);
	return total;
}

// ─── 格式化 ───

function fmt(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

function fmtCost(n: number): string {
	if (n >= 1) return `$${n.toFixed(2)}`;
	if (n >= 0.01) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(4)}`;
}

function shortDate(date?: Date): string {
	const d = date ?? new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 缓存命中率 = cacheRead / 总输入(含缓存)。不用 cacheRead/(cacheRead+cacheWrite)：
// DeepSeek 等 OpenAI 兼容 provider 不报告 cache_write_tokens（pi 映射后 cacheWrite 恒 0，
// 未命中 token 被计入 input），旧口径会恒显示 100%。
// 新口径在 DeepSeek 下等价于 hit/(hit+miss)，在 Anthropic 下度量"输入中缓存命中占比"。
function hitRate(cacheRead: number, totalInput: number): string {
	if (totalInput === 0) return "-";
	return `CH${((cacheRead / totalInput) * 100).toFixed(2)}%`;
}

// ─── 柱状图渲染 ───

interface DailyRow {
	date: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface ChartData {
	rows: DailyRow[];
	maxInput: number;
	maxOutput: number;
}

function barWidth(termWidth: number): number {
	return Math.min(termWidth - 26, 80);
}

function renderBar(value: number, max: number, width: number): string {
	if (max === 0) return " ".repeat(width);
	return "█".repeat(Math.max(1, Math.round((value / max) * width)));
}

/** 近 N 天 = 含今天往前数 N 天；days = 0 表示全部历史（没有起点）。 */
function cutoffDate(days: number): string | undefined {
	if (days === 0) return undefined;
	const cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - days + 1);
	return shortDate(cutoff);
}

function collectChartData(dayRows: DayModelRow[]): ChartData {
	const rows: DailyRow[] = [];
	let maxInput = 0;
	let maxOutput = 0;
	for (const day of dayRows) {
		const input = day.input + day.cacheRead + day.cacheWrite;
		const output = day.output;
		if (input > maxInput) maxInput = input;
		if (output > maxOutput) maxOutput = output;
		rows.push({
			date: day.date,
			model: day.model,
			input,
			output,
			cacheRead: day.cacheRead,
			cacheWrite: day.cacheWrite,
		});
	}
	return { rows, maxInput: maxInput || 1, maxOutput: maxOutput || 1 };
}

function appendChart(
	lines: string[],
	rows: DailyRow[],
	title: string,
	valueOf: (row: DailyRow) => number,
	maxValue: number,
	width: number,
	showHit: boolean,
): void {
	lines.push(`  ${title}`);
	let prevDate = "";
	for (const row of rows) {
		const value = valueOf(row);
		const dateLabel = row.date === prevDate ? "     " : row.date.slice(5);
		if (row.date !== prevDate && prevDate !== "") lines.push("");
		prevDate = row.date;
		// bar 区域固定宽度（padEnd），使数值+命中率列在所有行落在同一纵列
		const bar = renderBar(value, maxValue, width).padEnd(width);
		// 值右对齐固定列；命中率用括号括起，格式: 184.7k (CH93.78%)
		const hitPart = showHit ? ` (${hitRate(row.cacheRead, row.input).padStart(8)})` : "";
		lines.push(`  ${dateLabel} ${bar}  ${fmt(value).padStart(8)}${hitPart}  ${row.model}`);
	}
	lines.push("");
}

function appendModelSummary(lines: string[], dayRows: DayModelRow[]): void {
	const byModel = computeTotalsByModel(dayRows);
	const total = sumUsage(byModel);
	const totalInput = total.input + total.cacheRead + total.cacheWrite;

	// 汇总按模型名称排序，便于在多次查看间定位同一模型
	const modelList = [...byModel.entries()]
		.map(([key, usage]) => ({
			key,
			input: usage.input + usage.cacheRead + usage.cacheWrite,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			output: usage.output,
			cost: usage.cost,
		}))
		.sort((a, b) => a.key.localeCompare(b.key));

	for (const model of modelList) {
		const pct = totalInput > 0 ? ((model.input / totalInput) * 100).toFixed(1) : "0.0";
		lines.push(`  ● ${model.key} (${pct}%)`);
		// In 显示总输入（未命中+命中），括号内为缓存命中率
		lines.push(`    In: ${fmt(model.input)} (${hitRate(model.cacheRead, model.input)}) · Out: ${fmt(model.output)} · ${fmtCost(model.cost)}`);
	}
	lines.push("");
	// Input 显示总输入（未命中+命中）
	lines.push(`  Input: ${fmt(totalInput)} (${hitRate(total.cacheRead, totalInput)}) · Output: ${fmt(total.output)} · ${fmtCost(total.cost)}`);
	lines.push("");
}

// ─── 当前会话 ───

/** 只列当前会话：历史会话的记录保留在库里，不参与展示。 */
function appendCurrentSession(lines: string[], record: SessionRecord | undefined): void {
	lines.push("  当前会话");
	if (!record) {
		lines.push("  （本会话暂无记录）", "");
		return;
	}
	const rate = averageOutputRate(record);
	const first = averageFirstTokenMs(record);
	const rateText = rate === undefined ? "-" : formatRate(rate);
	const firstText = first === undefined ? "-" : formatFirstToken(first);
	lines.push(`  ${record.turns} 轮 · Out ${fmt(record.usage.output)} · 平均首字 ${firstText} · 平均速率 ${rateText}`);
	lines.push("  平均首字只统计流式中测到的响应；平均速率 = 有耗时响应的输出 token ÷ 耗时之和");
	lines.push("");
}

/** 会话速率永远只针对当前会话，与天数参数无关：会话记录没有按天的拆分。 */
export function renderStats(
	store: TokenStatsStore,
	days: number,
	showOutput = false,
	currentSessionId?: string,
): string[] {
	const label = days === 0 ? "全部" : `近 ${days} 天`;
	const lines: string[] = [`  📊 Token 用量趋势 (${label})`, ""];
	const dayRows = store.dayRows(cutoffDate(days));
	if (dayRows.length === 0) {
		lines.push("  （暂无数据）", "");
	} else {
		const { rows, maxInput, maxOutput } = collectChartData(dayRows);
		const width = barWidth((process.stdout as { columns?: number })?.columns ?? 80);

		if (showOutput) {
			appendChart(lines, rows, "Tokens per Day (Output)", (row) => row.output, maxOutput, width, false);
		} else {
			appendChart(lines, rows, "Tokens per Day (Input)", (row) => row.input, maxInput, width, true);
		}

		appendModelSummary(lines, dayRows);
	}

	appendCurrentSession(lines, currentSessionId === undefined ? undefined : store.sessionRecord(currentSessionId));
	return lines;
}

/** /token 的参数候选。可多写（如 `/token 7d Out`），补全时排除已写过的 */
const TOKEN_ARGS: AutocompleteItem[] = [
	{ value: "7d", label: "7d", description: "近 7 天（默认）" },
	{ value: "1d", label: "1d", description: "近 1 天" },
	{ value: "3d", label: "3d", description: "近 3 天" },
	{ value: "14d", label: "14d", description: "近 14 天" },
	{ value: "30d", label: "30d", description: "近 30 天" },
	{ value: "90d", label: "90d", description: "近 90 天" },
	{ value: "all", label: "all", description: "全部历史" },
	{ value: "Out", label: "Out", description: "改看 Output 柱状图" },
];

/**
 * 只补正在输入的最后一个参数，并排除已写过的。补全项的 `value` 带上前面已写好的参数：
 * pi 的参数补全会整段替换参数文本，不带上的话 `/token all o` 补完会变成 `/token Out`，
 * 天数被吃掉。
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

	// turn_end: 从事件中直接取 usage，一次事务写 turn / day_model / session
	pi.on("turn_end", (event, ctx) => {
		try {
			// event.message 是所有消息的联合类型，只有 assistant 消息带 usage
			const msg = event.message as AssistantMessage | undefined;
			if (!msg?.usage) return;
			const usage = msg.usage;
			const model = msg.provider && msg.model ? `${msg.provider}/${msg.model}` : msg.model || "unknown";
			// 首字时间只在流式过程中测得到，必须当场落盘，否则重启后无从补算。
			statsStore().recordTurn({
				date: shortDate(),
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
		description: "Token 用量统计。默认近7天。参数: all/Nd(天数) / Output|Out",
		getArgumentCompletions: (prefix) => tokenArgumentCompletions(prefix),
		handler: async (args, ctx) => {
			try {
				const parts = args.trim().split(/\s+/);
				// 默认近 7 天；all / 0d 表示全部历史
				let days = 7;
				let showOutput = false;
				for (const part of parts) {
					const token = part.toLowerCase();
					const match = token.match(/^(\d+)d$/);
					if (match) days = parseInt(match[1], 10);
					else if (token === "all") days = 0;
					else if (token === "output" || token === "out") showOutput = true;
				}

				pi.appendEntry<TokenStatsEntry>("token-stats", {
					lines: renderStats(statsStore(), days, showOutput, ctx.sessionManager.getSessionId()),
				});
			} catch (e) {
				ctx.ui.notify(`[error] ${(e as Error).message}`, "error");
			}
		},
	});
}
