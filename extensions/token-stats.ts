/**
 * Token Stats Extension
 *
 * 全局 Token 用量统计。每次 turn_end 从事件中提取 usage，
 * 增量写入 ~/.pi/token-stats.json。不做任何 session 文件扫描。
 *
 * 命令：
 *   /tokens             — 全局累计统计 + Input 柱状图
 *   /tokens 7d          — 近 7 天
 *   /tokens 30d         — 近 30 天
 *   /tokens Out[put]    — 显示 Output 柱状图（可与天数组合，如 /tokens 7d Out）
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
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

// ─── 查询 ───

function computeTotalsByModel(cache: GlobalCache): Map<string, ModelUsage> {
	const byModel = new Map<string, ModelUsage>();
	for (const day of Object.values(cache.byDate)) {
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
	if (cutoff) cutoff.setDate(cutoff.getDate() - days);
	const filtered = cutoff ? sortedDates.filter((d) => d >= shortDate(cutoff)) : sortedDates;

	if (filtered.length === 0) {
		lines.push("  （暂无数据）");
		return lines;
	}

	const dateModelData: Array<{ date: string; model: string; input: number; output: number }> = [];
	let maxIn = 0, maxOut = 0;
	for (const d of filtered) {
		const day = cache.byDate[d];
		for (const [model, u] of Object.entries(day.models)) {
			const inp = u.input + u.cacheRead + u.cacheWrite;
			const out = u.output;
			if (inp > maxIn) maxIn = inp;
			if (out > maxOut) maxOut = out;
			dateModelData.push({ date: d, model, input: inp, output: out });
		}
	}
	if (maxIn === 0) maxIn = 1;
	if (maxOut === 0) maxOut = 1;

	const bw = barWidth((process.stdout as { columns?: number })?.columns ?? 80);

	function drawChart(title: string, getVal: (d: typeof dateModelData[0]) => number, maxVal: number): void {
		lines.push(`  ${title}`);
		let prevDate = "";
		for (const d of dateModelData) {
			const val = getVal(d);
			const dateLabel = d.date === prevDate ? "     " : d.date.slice(5);
			if (d.date !== prevDate && prevDate !== "") {
				lines.push("");
			}
			prevDate = d.date;
			const bar = renderBar(val, maxVal, bw);
			lines.push(`  ${dateLabel} ${bar}  ${fmt(val).padStart(8)}  ${d.model}`);
		}
		lines.push("");
	}

	if (showOutput) {
		drawChart("Tokens per Day (Output)", (d) => d.output, maxOut);
	} else {
		drawChart("Tokens per Day (Input)", (d) => d.input, maxIn);
	}

	// 模型汇总
	const byModel = computeTotalsByModel(cache);
	const total = sumUsage(byModel);
	const totalInput = total.input + total.cacheRead + total.cacheWrite;

	const modelList = [...byModel.entries()]
		.map(([key, u]) => ({ key, input: u.input + u.cacheRead + u.cacheWrite, output: u.output, cost: u.cost }))
		.sort((a, b) => b.input - a.input);

	for (const m of modelList) {
		const pct = totalInput > 0 ? ((m.input / totalInput) * 100).toFixed(1) : "0.0";
		lines.push(`  ● ${m.key} (${pct}%)`);
		lines.push(`    In: ${fmt(m.input)} · Out: ${fmt(m.output)} · ${fmtCost(m.cost)}`);
	}
	lines.push("");
	lines.push(`  Input: ${fmt(totalInput)} · Output: ${fmt(total.output)} · ${fmtCost(total.cost)}`);
	lines.push("");

	return lines;
}

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
			if (!event.message?.usage) return;
			const u = event.message.usage;
			const msg = event.message as AssistantMessage;
			const model = msg?.provider && msg?.model
				? `${msg.provider}/${msg.model}`
				: msg?.model || "unknown";
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
		description: "Token 用量统计。参数: 7d / 30d / Output / Out",
		handler: async (args, ctx) => {
			try {
				const parts = args.trim().split(/\s+/);
				let days = 0;
				let showOutput = false;
				for (const part of parts) {
					const p = part.toLowerCase();
					if (p === "7d") days = 7;
					else if (p === "30d") days = 30;
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
