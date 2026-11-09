/**
 * Token Stats Extension
 *
 * 全局 Token 用量统计。每次 turn_end 从事件中提取 usage，
 * 增量写入 Pi agent dir 下的 token-stats.json。不做任何 session 文件扫描。
 *
 * 命令：
 *   /token             — 近 7 天统计 + Input 柱状图（默认）
 *   /token all         — 全部历史统计（/token 0d 亦可）
 *   /token 3d          — 近 3 天（Nd 任意天数）
 *   /token out         — 显示 Output 柱状图（可与天数组合，如 /token 7d Out）
 *
 * 持久化在 lib/json.ts，entry 渲染在 lib/render.ts；本模块负责采集、聚合与命令。
 */

import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { readJsonFile, writeJsonFileAtomic } from "./lib/json.ts";
import { renderDimLines } from "./lib/render.ts";

// ─── 类型 ───

interface ModelUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface DailyRecord {
	models: Record<string, ModelUsage>;
	totalTokens: number;
	totalCost: number;
}

interface GlobalCache {
	version: number;
	byDate: Record<string, DailyRecord>;
}

interface TokenStatsEntry {
	lines: string[];
}

// ─── 缓存 I/O ───

function cachePath(): string {
	return join(getAgentDir(), "token-stats.json");
}

function loadCache(): GlobalCache {
	return readJsonFile<GlobalCache>(cachePath(), { version: 1, byDate: {} });
}

function saveCache(cache: GlobalCache): void {
	writeJsonFileAtomic(cachePath(), cache);
}

// ─── usage 聚合 ───

function emptyUsage(): ModelUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function emptyDay(): DailyRecord {
	return { models: {}, totalTokens: 0, totalCost: 0 };
}

function totalTokens(usage: ModelUsage): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function addUsage(target: ModelUsage, usage: ModelUsage): void {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.cost += usage.cost;
}

function addDailyUsage(cache: GlobalCache, date: string, model: string, usage: ModelUsage): void {
	const day = (cache.byDate[date] ??= emptyDay());
	const target = (day.models[model] ??= emptyUsage());
	addUsage(target, usage);
	day.totalTokens += totalTokens(usage);
	day.totalCost += usage.cost;
}

function computeTotalsByModel(cache: GlobalCache, dates?: string[]): Map<string, ModelUsage> {
	const byModel = new Map<string, ModelUsage>();
	const dateKeys = dates && dates.length > 0 ? dates : Object.keys(cache.byDate);
	for (const date of dateKeys) {
		const day = cache.byDate[date];
		if (!day) continue;
		for (const [model, usage] of Object.entries(day.models)) {
			let acc = byModel.get(model);
			if (!acc) {
				acc = emptyUsage();
				byModel.set(model, acc);
			}
			addUsage(acc, usage);
		}
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

/** 近 N 天 = 含今天往前数 N 天；days = 0 表示全部历史。 */
function datesInRange(cache: GlobalCache, days: number): string[] {
	const sortedDates = Object.keys(cache.byDate).sort();
	if (days === 0) return sortedDates;
	const cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - days + 1);
	const from = shortDate(cutoff);
	return sortedDates.filter((date) => date >= from);
}

function collectChartData(cache: GlobalCache, dates: string[]): ChartData {
	const rows: DailyRow[] = [];
	let maxInput = 0;
	let maxOutput = 0;
	for (const date of dates) {
		const day = cache.byDate[date];
		for (const [model, usage] of Object.entries(day.models)) {
			const input = usage.input + usage.cacheRead + usage.cacheWrite;
			const output = usage.output;
			if (input > maxInput) maxInput = input;
			if (output > maxOutput) maxOutput = output;
			rows.push({ date, model, input, output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite });
		}
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

function appendModelSummary(lines: string[], cache: GlobalCache, dates: string[]): void {
	const byModel = computeTotalsByModel(cache, dates);
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

function renderStats(cache: GlobalCache, days: number, showOutput = false): string[] {
	const label = days === 0 ? "全部" : `近 ${days} 天`;
	const lines: string[] = [`  📊 Token 用量趋势 (${label})`, ""];

	const dates = datesInRange(cache, days);
	if (dates.length === 0) {
		lines.push("  （暂无数据）");
		return lines;
	}

	const { rows, maxInput, maxOutput } = collectChartData(cache, dates);
	const width = barWidth((process.stdout as { columns?: number })?.columns ?? 80);

	if (showOutput) {
		appendChart(lines, rows, "Tokens per Day (Output)", (row) => row.output, maxOutput, width, false);
	} else {
		appendChart(lines, rows, "Tokens per Day (Input)", (row) => row.input, maxInput, width, true);
	}

	appendModelSummary(lines, cache, dates);
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

// ─── 扩展 ───

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<TokenStatsEntry>("token-stats", (entry, _options, theme) =>
		renderDimLines(theme, entry.data?.lines ?? ["(no data)"]),
	);

	// turn_end: 从事件中直接取 usage，锁保护写缓存
	pi.on("turn_end", (event, _ctx) => {
		try {
			// event.message 是所有消息的联合类型，只有 assistant 消息带 usage
			const msg = event.message as AssistantMessage | undefined;
			if (!msg?.usage) return;
			const usage = msg.usage;
			const model = msg.provider && msg.model ? `${msg.provider}/${msg.model}` : msg.model || "unknown";
			const cache = loadCache();
			addDailyUsage(cache, shortDate(), model, {
				input: usage.input ?? 0,
				output: usage.output ?? 0,
				cacheRead: usage.cacheRead ?? 0,
				cacheWrite: usage.cacheWrite ?? 0,
				cost: usage.cost?.total ?? 0,
			});
			saveCache(cache);
		} catch {
			/* ignore */
		}
	});

	pi.registerCommand("token", {
		description: "Token 用量统计。默认近7天。参数: all/Nd(天数) / Output / Out",
		getArgumentCompletions: (prefix) => {
			// 多参数命令：只补正在输入的最后一个 token，并排除已写过的
			const parts = prefix.split(/\s+/);
			const current = (parts.pop() ?? "").toLowerCase();
			const used = new Set(parts.map((part) => part.toLowerCase()));
			const items = TOKEN_ARGS.filter(
				(item) => !used.has(item.value.toLowerCase()) && item.value.toLowerCase().startsWith(current),
			);
			return items.length > 0 ? items : null;
		},
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

				pi.appendEntry<TokenStatsEntry>("token-stats", { lines: renderStats(loadCache(), days, showOutput) });
			} catch (e) {
				ctx.ui.notify(`[error] ${(e as Error).message}`, "error");
			}
		},
	});
}
