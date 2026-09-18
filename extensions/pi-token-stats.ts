/**
 * Token Stats Extension
 *
 * 全局 Token 用量统计。每次 turn_end 从事件中提取 usage，
 * 增量写入 ~/.pi/token-stats.json。不做任何 session 文件扫描。
 *
 * 命令：
 *   /tokens             — 近 7 天统计 + Input 柱状图（默认）
 *   /tokens all         — 全部历史统计（/tokens 0d 亦可）
 *   /tokens 3d          — 近 3 天（Nd 任意天数）
 *   /tokens out    — 显示 Output 柱状图（可与天数组合，如 /tokens 7d Out）
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
	return join(homedir(), ".pi", "token-stats.json");
}

function loadCache(): GlobalCache {
	const p = cachePath();
	if (!existsSync(p)) return { version: 1, byDate: {} };
	try { return JSON.parse(readFileSync(p, "utf-8")) as GlobalCache; }
	catch { return { version: 1, byDate: {} }; }
}

function saveCache(cache: GlobalCache): void {
	const p = cachePath();
	const dir = join(homedir(), ".pi");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmp = p + ".tmp." + process.pid;
	writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf-8");
	renameSync(tmp, p);
}

function addUsage(cache: GlobalCache, date: string, model: string, u: ModelUsage): void {
	if (!cache.byDate[date]) cache.byDate[date] = { models: {}, totalTokens: 0, totalCost: 0 };
	const day = cache.byDate[date];
	if (!day.models[model]) day.models[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	const m = day.models[model];
	m.input += u.input;
	m.output += u.output;
	m.cacheRead += u.cacheRead;
	m.cacheWrite += u.cacheWrite;
	m.cost += u.cost;
	day.totalTokens += u.input + u.output + u.cacheRead + u.cacheWrite;
	day.totalCost += u.cost;
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

// ─── 查询 ───

function computeTotalsByModel(cache: GlobalCache, dates?: string[]): Map<string, ModelUsage> {
	const byModel = new Map<string, ModelUsage>();
	const dateKeys = dates && dates.length > 0 ? dates : Object.keys(cache.byDate);
	for (const d of dateKeys) {
		const day = cache.byDate[d];
		if (!day) continue;
		for (const [key, u] of Object.entries(day.models)) {
			let acc = byModel.get(key);
			if (!acc) {
				acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
				byModel.set(key, acc);
			}
			acc.input += u.input;
			acc.output += u.output;
			acc.cacheRead += u.cacheRead;
			acc.cacheWrite += u.cacheWrite;
			acc.cost += u.cost;
		}
	}
	return byModel;
}

function sumUsage(byModel: Map<string, ModelUsage>): ModelUsage {
	const total: ModelUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const u of byModel.values()) {
		total.input += u.input;
		total.output += u.output;
		total.cacheRead += u.cacheRead;
		total.cacheWrite += u.cacheWrite;
		total.cost += u.cost;
	}
	return total;
}

// ─── 柱状图渲染 ───

function barWidth(termWidth: number): number {
	return Math.min(termWidth - 26, 80);
}

function renderBar(value: number, max: number, width: number): string {
	if (max === 0) return " ".repeat(width);
	return "█".repeat(Math.max(1, Math.round((value / max) * width)));
}

function renderStats(cache: GlobalCache, days: number, showOutput = false): string[] {
	const lines: string[] = [];
	const label = days === 0 ? "全部" : `近 ${days} 天`;
	lines.push(`  📊 Token 用量趋势 (${label})`);
	lines.push("");

	const sortedDates = Object.keys(cache.byDate).sort();
	const cutoff = days > 0 ? new Date() : null;
	// "近 N 天" = 含今天往前数 N 天：从 today-(N-1) 开始过滤，避免 d >= today-N 多出 1 天
	if (cutoff) cutoff.setDate(cutoff.getDate() - days + 1);
	const filtered = cutoff ? sortedDates.filter((d) => d >= shortDate(cutoff)) : sortedDates;

	if (filtered.length === 0) {
		lines.push("  （暂无数据）");
		return lines;
	}

	const dateModelData: Array<{ date: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number }> = [];
	let maxIn = 0, maxOut = 0;
	for (const d of filtered) {
		const day = cache.byDate[d];
		for (const [model, u] of Object.entries(day.models)) {
			const inp = u.input + u.cacheRead + u.cacheWrite;
			const out = u.output;
			if (inp > maxIn) maxIn = inp;
			if (out > maxOut) maxOut = out;
			dateModelData.push({ date: d, model, input: inp, output: out, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite });
		}
	}
	if (maxIn === 0) maxIn = 1;
	if (maxOut === 0) maxOut = 1;

	const bw = barWidth((process.stdout as { columns?: number })?.columns ?? 80);

	function drawChart(title: string, getVal: (d: typeof dateModelData[0]) => number, maxVal: number, showHit: boolean): void {
		lines.push(`  ${title}`);
		let prevDate = "";
		for (const d of dateModelData) {
			const val = getVal(d);
			const dateLabel = d.date === prevDate ? "     " : d.date.slice(5);
			if (d.date !== prevDate && prevDate !== "") {
				lines.push("");
			}
			prevDate = d.date;
			// bar 区域固定宽度（padEnd），使数值+命中率列在所有行落在同一纵列
			const bar = renderBar(val, maxVal, bw).padEnd(bw);
			// 值右对齐固定列；命中率用括号括起，格式: 184.7k (CH93.78%)
			const hitPart = showHit ? ` (${hitRate(d.cacheRead, d.input).padStart(8)})` : "";
			lines.push(`  ${dateLabel} ${bar}  ${fmt(val).padStart(8)}${hitPart}  ${d.model}`);
		}
		lines.push("");
	}

	if (showOutput) {
		drawChart("Tokens per Day (Output)", (d) => d.output, maxOut, false);
	} else {
		drawChart("Tokens per Day (Input)", (d) => d.input, maxIn, true);
	}

	// 模型汇总（按天数过滤后的日期，与柱状图一致）
	const byModel = computeTotalsByModel(cache, filtered);
	const total = sumUsage(byModel);
	const totalInput = total.input + total.cacheRead + total.cacheWrite;

	const modelList = [...byModel.entries()]
		.map(([key, u]) => ({ key, input: u.input + u.cacheRead + u.cacheWrite, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, output: u.output, cost: u.cost }))
		.sort((a, b) => b.input - a.input);

	for (const m of modelList) {
		const pct = totalInput > 0 ? ((m.input / totalInput) * 100).toFixed(1) : "0.0";
		lines.push(`  ● ${m.key} (${pct}%)`);
		// In 显示总输入（未命中+命中），括号内为缓存命中率
		lines.push(`    In: ${fmt(m.input)} (${hitRate(m.cacheRead, m.input)}) · Out: ${fmt(m.output)} · ${fmtCost(m.cost)}`);
	}
	lines.push("");
	// Input 显示总输入（未命中+命中）
	lines.push(`  Input: ${fmt(totalInput)} (${hitRate(total.cacheRead, totalInput)}) · Output: ${fmt(total.output)} · ${fmtCost(total.cost)}`);
	lines.push("");

	return lines;
}

/** /tokens 的参数候选。可多写（如 `/tokens 7d Out`），补全时排除已写过的 */
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
	pi.registerEntryRenderer<TokenStatsEntry>("token-stats", (entry, _options, theme) => {
		const data = entry.data ?? { lines: ["(no data)"] };
		const box = new Box(1, 1);
		for (const line of data.lines) box.addChild(new Text(theme.fg("dim", line), 0, 0));
		return box;
	});

	// turn_end: 从事件中直接取 usage，锁保护写缓存
	pi.on("turn_end", (event, _ctx) => {
		try {
			// event.message 是所有消息的联合类型，只有 assistant 消息带 usage
			const msg = event.message as AssistantMessage | undefined;
			if (!msg?.usage) return;
			const u = msg.usage;
			const model = msg.provider && msg.model ? `${msg.provider}/${msg.model}` : msg.model || "unknown";
			const cache = loadCache();
			addUsage(cache, shortDate(), model, {
				input: u.input ?? 0,
				output: u.output ?? 0,
				cacheRead: u.cacheRead ?? 0,
				cacheWrite: u.cacheWrite ?? 0,
				cost: u.cost?.total ?? 0,
			});
			saveCache(cache);
		} catch { /* ignore */ }
	});

	// ─── 命令 ───

	pi.registerCommand("tokens", {
		description: "Token 用量统计。默认近7天。参数: all/Nd(天数) / Output / Out",
		getArgumentCompletions: (prefix) => {
			// 多参数命令：只补正在输入的最后一个 token，并排除已写过的
			const parts = prefix.split(/\s+/);
			const current = (parts.pop() ?? "").toLowerCase();
			const used = new Set(parts.map((p) => p.toLowerCase()));
			const items = TOKEN_ARGS.filter(
				(i) => !used.has(i.value.toLowerCase()) && i.value.toLowerCase().startsWith(current),
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
					const p = part.toLowerCase();
					const m = p.match(/^(\d+)d$/);
					if (m) days = parseInt(m[1], 10);
					else if (p === "all") days = 0;
					else if (p === "output" || p === "out") showOutput = true;
				}

				const cache = loadCache();
				const lines = renderStats(cache, days, showOutput);
				pi.appendEntry<TokenStatsEntry>("token-stats", { lines });
			} catch (e) {
				ctx.ui.notify(`[error] ${(e as Error).message}`, "error");
			}
		},
	});
}
