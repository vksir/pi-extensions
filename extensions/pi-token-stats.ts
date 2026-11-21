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
 *   /token rate [1h]   — 当前模型的时间窗速率（默认 1h，可写 3h / 7d / all）
 *
 * footer 状态行里插入最近一次响应的首字时间与输出速率（如 `R1.5M 0.9s 42t/s CH97.1%`），
 * 由 lib/footer-rate.ts 包一层内置 footer 实现。
 *
 * 数据库在 `~/.pi/agent/pi-token-stats/token-stats.db`；读写都交给 lib/token-stats-worker.ts
 * 的 worker 线程，主线程只收发消息，不碰 SQLite。旧 JSON 的静默迁移是临时代码，
 * 见 lib/token-stats-legacy.ts，下个版本删除。entry 渲染在 lib/render.ts。
 */

import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createFirstTokenTimer, createRateFooter, formatFirstToken, formatRate } from "./lib/footer-rate.ts";
import { renderDimLines } from "./lib/render.ts";
import { averageFirstTokenMs, averageOutputRate, type SessionRecord, type SessionUsageTotals } from "./lib/session-usage.ts";
import { openTokenStatsClient, type TokenStatsClient } from "./lib/token-stats-client.ts";
import type { DayModelRow, RateRow } from "./lib/token-stats-db.ts";

// ─── 存储 ───

/** 下个版本删掉这一行与 importLegacyCache 的 import：旧 JSON 迁移是临时的。 */
const LEGACY_CACHE_FILE = "token-stats.json";

function tokenStatsDir(): string {
	return join(getAgentDir(), "pi-token-stats");
}

let client: TokenStatsClient | undefined;

/**
 * 懒启动写线程：建库、静默迁移、写入、查询都在 worker 里排队，
 * 主线程只收发消息，不碰 SQLite。
 */
function statsClient(): TokenStatsClient {
	if (!client) {
		client = openTokenStatsClient({
			dbPath: join(tokenStatsDir(), "token-stats.db"),
			// 临时：旧版 JSON 的静默迁移，下个版本连同 lib/token-stats-legacy.ts 一起删除
			legacyPath: join(getAgentDir(), LEGACY_CACHE_FILE),
		});
	}
	return client;
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

// ─── 速率视图 ───

const RATE_DEFAULT_MS = 3_600_000;
const RATE_UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export interface RateWindow {
	/** 窗口起点（epoch ms，含）；0 表示全部历史 */
	since: number;
	/** 显示用标签：1h / 3h / 7d / 1h30m / all */
	label: string;
}

/** `/token rate` 的窗口参数：空 = 过去 1 小时；支持 m/h/d、可连写，或 all。 */
export function parseRateWindow(args: string, now: number = Date.now()): RateWindow {
	const text = args.trim().toLowerCase();
	if (!text) return { since: now - RATE_DEFAULT_MS, label: "1h" };
	if (text === "all") return { since: 0, label: "all" };

	let ms = 0;
	for (const part of text.split(/\s+/)) {
		if (!/^(?:\d+[mhd])+$/.test(part)) throw new Error(`unknown rate window '${part}'`);
		for (const match of part.matchAll(/(\d+)([mhd])/g)) {
			ms += Number(match[1]) * RATE_UNIT_MS[match[2]!]!;
		}
	}
	if (ms <= 0) throw new Error("rate window must be greater than 0");
	return { since: now - ms, label: formatRateWindowLabel(ms) };
}

/** 把毫秒写成紧凑标签：`30m`、`3h`、`1d`、`1h30m`。 */
export function formatRateWindowLabel(ms: number): string {
	const totalMinutes = Math.round(ms / 60_000);
	if (totalMinutes < 60) return `${totalMinutes}m`;
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	return `${days > 0 ? `${days}d` : ""}${hours > 0 ? `${hours}h` : ""}${minutes > 0 ? `${minutes}m` : ""}`;
}

const RATE_METRIC_WIDTH = 10;
const RATE_VALUE_WIDTH = 8;

/** `/token rate` 的排版：当前模型的时间窗平均首字与平均输出速率。 */
export function renderRate(row: RateRow | undefined, model: string, window: RateWindow): string[] {
	const title = window.label === "all" ? "📊 Token Rate · All time" : `📊 Token Rate · Last ${window.label}`;
	const lines: string[] = [`  ${title}`, "", `  ${model}`, ""];
	if (!row) {
		lines.push(`  No data for ${model}.`, "");
		return lines;
	}

	const ttft = row.firstTokenSamples > 0 ? row.firstTokenMs / row.firstTokenSamples : undefined;
	const rate = row.timedMs > 0 ? row.timedOutput / (row.timedMs / 1000) : undefined;
	const metric = (label: string, value: string): string =>
		`  ${label.padEnd(RATE_METRIC_WIDTH)}  ${value.padStart(RATE_VALUE_WIDTH)}`;
	lines.push(metric("Metric", "Value"));
	lines.push(`  ${"─".repeat(RATE_METRIC_WIDTH)}  ${"─".repeat(RATE_VALUE_WIDTH)}`);
	lines.push(metric("Avg TTFT", ttft === undefined ? "-" : formatFirstToken(ttft)));
	lines.push(metric("Avg Rate", rate === undefined ? "-" : formatRate(rate)));
	lines.push("");
	return lines;
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

/**
 * 只负责排版：按天数据已按天数过滤好，会话记录永远是当前会话。
 * 查询在 worker 里做，这里保持纯函数，方便单测。
 */
export function renderStats(
	dayRows: DayModelRow[],
	session: SessionRecord | undefined,
	days: number,
	showOutput = false,
): string[] {
	const label = days === 0 ? "全部" : `近 ${days} 天`;
	const lines: string[] = [`  📊 Token 用量趋势 (${label})`, ""];
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

	appendCurrentSession(lines, session);
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

const RATE_COMMAND: AutocompleteItem = { value: "rate", label: "rate", description: "当前模型速率（默认 1h）" };

/** `/token rate` 的窗口候选。 */
const RATE_ARGS: AutocompleteItem[] = [
	{ value: "1h", label: "1h", description: "过去 1 小时（默认）" },
	{ value: "3h", label: "3h", description: "过去 3 小时" },
	{ value: "6h", label: "6h", description: "过去 6 小时" },
	{ value: "12h", label: "12h", description: "过去 12 小时" },
	{ value: "24h", label: "24h", description: "过去 24 小时" },
	{ value: "7d", label: "7d", description: "过去 7 天" },
	{ value: "all", label: "all", description: "全部历史" },
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

	// `/token rate <窗口>`：只补一个窗口，补完就停
	if (done[0]?.toLowerCase() === "rate") {
		if (done.length > 1) return null;
		const items = RATE_ARGS.filter((item) => item.value.toLowerCase().startsWith(current));
		if (items.length === 0) return null;
		return items.map((item) => ({ ...item, value: `rate ${item.value}` }));
	}

	const used = new Set(done.map((part) => part.toLowerCase()));
	const candidates = done.length === 0 ? [RATE_COMMAND, ...TOKEN_ARGS] : TOKEN_ARGS;
	const items = candidates.filter(
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
			statsClient().recordTurn({
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
		description: "Token 用量统计。默认近7天。参数: rate [1h|3h|...], all/Nd, Output|Out",
		getArgumentCompletions: (prefix) => tokenArgumentCompletions(prefix),
		handler: async (args, ctx) => {
			try {
				const tokens = args.trim().split(/\s+/).filter(Boolean);
				if (tokens[0]?.toLowerCase() === "rate") {
					const window = parseRateWindow(tokens.slice(1).join(" "));
					const stats = statsClient();
					// 当前模型与落盘时的 `provider/model` 同形；拿不到时退回窗口内最近一次的模型
					const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
					const model = current ?? (await stats.latestModel(window.since));
					const row = model ? await stats.rateRow(window.since, model) : undefined;
					pi.appendEntry<TokenStatsEntry>("token-stats", {
						lines: renderRate(row, model ?? "unknown", window),
					});
					return;
				}

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

				// 查询走写线程：按 FIFO 一定看得到之前所有已提交的 turn，主线程不被 SQLite 阻塞
				const [dayRows, session] = await Promise.all([
					statsClient().dayRows(cutoffDate(days)),
					statsClient().sessionRecord(ctx.sessionManager.getSessionId()),
				]);
				pi.appendEntry<TokenStatsEntry>("token-stats", { lines: renderStats(dayRows, session, days, showOutput) });
			} catch (e) {
				ctx.ui.notify(`[error] ${(e as Error).message}`, "error");
			}
		},
	});
}
