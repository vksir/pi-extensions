/**
 * Token Stats Extension
 *
 * 全局 Token 用量与耗时统计。每次 turn_end 从事件中提取 usage，写进 agent dir 下的
 * SQLite 库；不做任何 session 文件扫描。
 *
 * `/token` 默认看过去 1 小时，也可以 `/token 3h`、`/token 30m`、`/token 7d`、`/token all`。
 * 所有会话、所有进程的记录都在同一个库里，但报告只统计**当前模型**，同时列出 token
 * 用量（Turns / Input / Output / Cost）与速度（Avg TTFT / Avg Rate）。
 *
 * footer 状态行里插入最近一次响应的首字时间与输出速率（如 `R1.5M 0.9s 42t/s CH97.1%`），
 * 由 lib/footer-rate.ts 包一层内置 footer 实现。
 *
 * 数据库在 `~/.pi/agent/pi-token-stats/token-stats.db`，只保留 `turn` 明细；schema v3
 * 打开时删除旧的 `day_model` / `session` 汇总表，见 lib/token-stats-db.ts。读写都交给
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
 * 解析 `/token` 参数：空 = 过去 1 小时；`3h` / `30m` / `7d`；可连写（`1h30m` 或
 * `1h 30m`）；`all` = 全部历史。旧的 `7d` 仍按「最近 7 天」解释。
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

// 缓存命中率 = cacheRead / 总输入(含缓存)，与旧版用量报告同口径。
function hitRate(cacheRead: number, totalInput: number): string {
	if (totalInput === 0) return "-";
	return `CH${((cacheRead / totalInput) * 100).toFixed(2)}%`;
}

// ─── 表格渲染 ───

const INDENT = "  ";
const GAP = "   ";
const METRIC_WIDTH = 9;

/** 模型列显示 `provider/model`；模型名已经带 provider 前缀时不重复。 */
function modelLabel(row: WindowModelRow): string {
	const provider = row.provider.trim();
	const model = row.model.trim() || "unknown";
	if (!provider || model === provider || model.startsWith(`${provider}/`)) return model;
	return `${provider}/${model}`;
}

function averageTtft(row: WindowModelRow): number | undefined {
	if (row.firstTokenSamples <= 0) return undefined;
	return row.firstTokenMs / row.firstTokenSamples;
}

/** 按 token 加权：输出之和 ÷ 耗时之和，不是逐次速率的算术平均。 */
function averageRate(row: WindowModelRow): number | undefined {
	if (row.timedMs <= 0) return undefined;
	return row.timedOutput / (row.timedMs / 1000);
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

function renderMetric(metric: string, value: string, valueWidth: number): string {
	return `${INDENT}${padCell(metric, METRIC_WIDTH)}${GAP}${padCell(clipCell(value, valueWidth), valueWidth, "right")}`;
}

function metricRule(valueWidth: number): string {
	return `${INDENT}${"─".repeat(METRIC_WIDTH)}${GAP}${"─".repeat(valueWidth)}`;
}

/**
 * 只负责排版：当前模型的用量与速率由 worker 查好，这里保持纯函数，方便单测。
 * model 用于没有数据时说明是哪个模型。
 */
export function renderStats(
	row: WindowModelRow | undefined,
	model: string,
	window: TokenWindow,
	width = 80,
): string[] {
	const title =
		window.label === "all" ? "📊 Token Usage & Speed · All time" : `📊 Token Usage & Speed · Last ${window.label}`;
	const lines: string[] = [`${INDENT}${title}`, ""];

	if (!row) {
		lines.push(`${INDENT}No data for ${model}.`, "");
		return lines;
	}

	const label = modelLabel(row);
	const totalInput = row.input + row.cacheRead + row.cacheWrite;
	const ttft = averageTtft(row);
	const rate = averageRate(row);
	const usageRows: Array<[string, string]> = [
		["Turns", String(row.turns)],
		["Input", `${fmt(totalInput)} (${hitRate(row.cacheRead, totalInput)})`],
		["Output", fmt(row.output)],
		["Cost", fmtCost(row.cost)],
	];
	const speedRows: Array<[string, string]> = [
		["Avg TTFT", ttft === undefined ? "-" : formatFirstToken(ttft)],
		["Avg Rate", rate === undefined ? "-" : formatRate(rate)],
	];
	const values = [...usageRows, ...speedRows].map(([, value]) => value);
	const maxValueWidth = Math.max(8, width - INDENT.length - GAP.length - METRIC_WIDTH);
	const valueWidth = Math.min(Math.max(visibleWidth("Value"), ...values.map(visibleWidth)), maxValueWidth);

	lines.push(`${INDENT}${clipCell(label, Math.max(4, width - INDENT.length))}`);
	lines.push("");
	lines.push(renderMetric("Metric", "Value", valueWidth));
	lines.push(metricRule(valueWidth));
	for (const [metric, value] of usageRows) lines.push(renderMetric(metric, value, valueWidth));
	lines.push(metricRule(valueWidth));
	for (const [metric, value] of speedRows) lines.push(renderMetric(metric, value, valueWidth));
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
	{ value: "7d", label: "7d", description: "过去 7 天（旧默认）" },
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
		description: "过去 1 小时的 Token 速率。参数: 3h / 30m / 7d / all",
		getArgumentCompletions: (prefix) => tokenArgumentCompletions(prefix),
		handler: async (args, ctx) => {
			try {
				const window = parseTokenWindow(args);
				const stats = statsClient();
				// 当前模型与落盘时的 `provider/model` 同形；拿不到时退回窗口内最近一次的模型
				const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
				const model = current ?? (await stats.latestModel(window.since));
				const row = model ? await stats.windowRow(window.since, model) : undefined;
				// entry 外层 Box 左右各留 1 格，表格按可用内容宽度排版
				const columns = (process.stdout as { columns?: number })?.columns || 80;
				const width = Math.max(20, columns - 2);
				pi.appendEntry<TokenStatsEntry>("token-stats", {
					lines: renderStats(row, model ?? "unknown", window, width),
				});
			} catch (e) {
				ctx.ui.notify(`[error] ${(e as Error).message}`, "error");
			}
		},
	});
}
