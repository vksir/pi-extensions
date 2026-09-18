/**
 * Provider 余额查询扩展
 *
 * 从 ~/.pi/agent/auth.json 读取 API Key/OAuth 凭据，查询各 Provider 的账户余额或额度。
 * 当前支持:
 *   - DeepSeek
 *   - Moonshot
 *   - OpenRouter
 *   - OpenAI Codex（ChatGPT Plus/Pro 额度）
 *
 * 命令：
 *   /balance            — 查询所有已配置 Provider 的余额/额度
 *   /balance deepseek   — 只查某个 Provider
 *   /balance free       — 列出 OpenRouter 免费模型 Top 20（按 coding_index 排序，含 Latency/Throughput）
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── 类型 ───

interface AuthEntry {
	type: string;
	key?: string;
	/** OAuth access token（Codex 凭据使用此字段） */
	access?: string;
	refresh?: string;
	expires?: number;
	accountId?: string;
}

interface AuthStore {
	[key: string]: AuthEntry;
}

interface CodexUsageWindow {
	usedPercent: number;
	limitWindowSeconds?: number;
	resetAfterSeconds?: number;
	resetAt?: number;
}

interface CodexQuota {
	planType?: string;
	allowed?: boolean;
	limitReached?: boolean;
	primary?: CodexUsageWindow;
	secondary?: CodexUsageWindow;
	credits?: {
		hasCredits?: boolean;
		unlimited?: boolean;
		balance?: string | number | null;
	};
}

interface BalanceResult {
	provider: string;
	/** 每个币种一条 */
	balances: Array<{
		currency: string;
		total: string;
	}>;
	/** 非金钱余额（例如 Codex 的时间窗口额度） */
	quota?: CodexQuota;
	error?: string;
}

interface BalanceEntry {
	lines: string[];
}

interface CodexUsagePayload {
	plan_type?: string;
	rate_limit?: {
		allowed?: boolean;
		limit_reached?: boolean;
		primary_window?: CodexUsageWindowPayload | null;
		secondary_window?: CodexUsageWindowPayload | null;
	} | null;
	credits?: {
		has_credits?: boolean;
		unlimited?: boolean;
		balance?: string | number | null;
	} | null;
}

interface CodexUsageWindowPayload {
	used_percent?: number | string;
	limit_window_seconds?: number | string;
	reset_after_seconds?: number | string;
	reset_at?: number | string;
}

interface FreeModel {
	id: string;
	/** benchmarks.artificial_analysis.coding_index，null 表示无评测数据 */
	codingIndex: number | null;
	/** 最快 endpoint 的延迟（ms），null 表示无数据 */
	latency: number | null;
	/** 最快 endpoint 的吞吐（tokens/s），null 表示无数据 */
	throughput: number | null;
}

/** 免费模型最多展示数量 */
const FREE_TOP_N = 20;
/** 拉取 endpoints 时的并发数 */
const ENDPOINTS_CONCURRENCY = 6;

// ─── auth.json 读取 ───

function authPath(): string {
	return join(homedir(), ".pi", "agent", "auth.json");
}

function loadAuth(): AuthStore {
	const p = authPath();
	if (!existsSync(p)) return {};
	try {
		return JSON.parse(readFileSync(p, "utf-8")) as AuthStore;
	} catch {
		return {};
	}
}

// ─── Provider 查询器 ───

interface ProviderChecker {
	name: string;
	/** 在 auth.json 中对应的键名 */
	authId: string;
	/** 可用于命令参数匹配的别名 */
	aliases?: string[];
	/** 余额 API URL */
	apiUrl: string;
	check(key: string, accountId?: string): Promise<Omit<BalanceResult, "provider">>;
}

const checkers: ProviderChecker[] = [
	{
		name: "DeepSeek",
		authId: "deepseek",
		apiUrl: "https://api.deepseek.com/user/balance",
		async check(key: string) {
			const res = await fetch(this.apiUrl, {
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${key}`,
				},
			});

			if (!res.ok) {
				const body = await res.text().catch(() => "");
				return { balances: [], error: `HTTP ${res.status}${body ? `: ${body}` : ""}` };
			}

			const data = (await res.json()) as {
				balance_infos?: Array<{
					total_balance: string;
					topped_up_balance: string;
					granted_balance: string;
					currency: string;
				}>;
				is_available?: boolean;
			};

			if (!data.balance_infos || data.balance_infos.length === 0) {
				return { balances: [], error: "未返回余额信息" };
			}

			const balances = data.balance_infos.map((info) => ({
				currency: info.currency.toUpperCase(),
				total: formatBalance(parseFloat(info.total_balance)),
			}));

			return { balances };
		},
	},
	{
		name: "Moonshot",
		authId: "moonshotai-cn",
		apiUrl: "https://api.moonshot.cn/v1/users/me/balance",
		async check(key: string) {
			const res = await fetch(this.apiUrl, {
				headers: {
					Authorization: `Bearer ${key}`,
				},
			});

			if (!res.ok) {
				const body = await res.text().catch(() => "");
				return { balances: [], error: `HTTP ${res.status}${body ? `: ${body}` : ""}` };
			}

			const data = (await res.json()) as {
				code?: number;
				data?: {
					available_balance: number;
					cash_balance: number;
					voucher_balance: number;
				};
			};

			if (data.code !== 0 || !data.data) {
				return { balances: [], error: `API 返回异常 code=${data.code}` };
			}

			return {
				balances: [
					{
						currency: "CNY",
						total: formatBalance(data.data.available_balance),
					},
				],
			};
		},
	},
	{
		name: "OpenRouter",
		authId: "openrouter",
		apiUrl: "https://openrouter.ai/api/v1/credits",
		async check(key: string) {
			const res = await fetch(this.apiUrl, {
				headers: {
					Authorization: `Bearer ${key}`,
				},
			});

			if (!res.ok) {
				const body = await res.text().catch(() => "");
				return { balances: [], error: `HTTP ${res.status}${body ? `: ${body}` : ""}` };
			}

			const data = (await res.json()) as {
				data?: {
					total_credits: number;
					total_usage: number;
				};
			};

			if (!data.data) {
				return { balances: [], error: "未返回余额数据" };
			}

			const remaining = data.data.total_credits - data.data.total_usage;

			return {
				balances: [
					{
						currency: "USD",
						total: formatBalance(remaining),
					},
				],
			};
		},
	},
	{
		name: "Codex",
		authId: "openai-codex",
		aliases: ["codex"],
		apiUrl: "https://chatgpt.com/backend-api/wham/usage",
		async check(accessToken: string, accountId?: string) {
			const resolvedAccountId = accountId ?? getCodexAccountId(accessToken);
			if (!resolvedAccountId) {
				return { balances: [], error: "无法从 Codex OAuth Token 中解析 ChatGPT Account ID" };
			}

			const res = await fetch(this.apiUrl, {
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${accessToken}`,
					"ChatGPT-Account-Id": resolvedAccountId,
					Originator: "pi",
					"User-Agent": "pi",
				},
			});

			if (!res.ok) {
				const body = await res.text().catch(() => "");
				return { balances: [], error: `HTTP ${res.status}${body ? `: ${body}` : ""}` };
			}

			const data = (await res.json()) as CodexUsagePayload;
			const quota = normalizeCodexQuota(data);
			if (!quota) {
				return { balances: [], error: "未返回 Codex 额度数据" };
			}

			return { balances: [], quota };
		},
	},
];

// ─── 格式化 ───

function formatBalance(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
	if (value >= 1) return value.toFixed(2);
	if (value >= 0.01) return value.toFixed(4);
	return value.toFixed(6);
}

function getCodexAccountId(accessToken: string): string | undefined {
	try {
		const payloadPart = accessToken.split(".")[1];
		if (!payloadPart) return undefined;

		const payload = JSON.parse(
			Buffer.from(payloadPart.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"),
		) as Record<string, unknown>;
		const auth = payload["https://api.openai.com/auth"];
		if (!auth || typeof auth !== "object") return undefined;

		const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function toNumber(value: number | string | undefined): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeCodexWindow(window: CodexUsageWindowPayload | null | undefined): CodexUsageWindow | undefined {
	if (!window) return undefined;
	const usedPercent = toNumber(window.used_percent);
	if (usedPercent === undefined) return undefined;

	return {
		usedPercent,
		limitWindowSeconds: toNumber(window.limit_window_seconds),
		resetAfterSeconds: toNumber(window.reset_after_seconds),
		resetAt: toNumber(window.reset_at),
	};
}

function normalizeCodexQuota(data: CodexUsagePayload): CodexQuota | undefined {
	if (!data || typeof data !== "object") return undefined;

	const rateLimit = data.rate_limit;
	const primary = normalizeCodexWindow(rateLimit?.primary_window);
	const secondary = normalizeCodexWindow(rateLimit?.secondary_window);
	const hasCredits = data.credits !== undefined && data.credits !== null;
	if (!rateLimit && !hasCredits && !data.plan_type) return undefined;

	return {
		planType: data.plan_type,
		allowed: rateLimit?.allowed,
		limitReached: rateLimit?.limit_reached,
		primary,
		secondary,
		credits: hasCredits
			? {
					hasCredits: data.credits?.has_credits,
					unlimited: data.credits?.unlimited,
					balance: data.credits?.balance,
				}
			: undefined,
	};
}

function fmtBar(value: number, max: number, width: number): string {
	if (max <= 0 || value <= 0) return "░".repeat(width);
	const filled = Math.max(1, Math.round((value / max) * width));
	return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

// ─── 渲染 ───

function renderBalance(results: BalanceResult[]): string[] {
	const lines: string[] = [];
	const balanceResults = results.filter((r) => !r.quota);
	const quotaResults = results.filter((r) => r.quota);

	// 收集行数据，分别计算数字和货币的对齐宽度
	interface Row {
		provider: string;
		isFirst: boolean;
		type: "balance" | "error";
		num: string;
		currency: string;
		text: string;
	}
	const rows: Row[] = [];
	let maxNumLen = 0;

	for (const r of balanceResults) {
		if (r.error) {
			rows.push({ provider: r.provider, isFirst: true, type: "error", num: "", currency: "", text: `⚠ ${r.error}` });
		} else if (r.balances.length === 0) {
			rows.push({ provider: r.provider, isFirst: true, type: "error", num: "", currency: "", text: "（无余额数据）" });
		} else {
			for (let i = 0; i < r.balances.length; i++) {
				const b = r.balances[i];
				if (b.total.length > maxNumLen) maxNumLen = b.total.length;
				rows.push({ provider: r.provider, isFirst: i === 0, type: "balance", num: b.total, currency: b.currency, text: "" });
			}
		}
	}

	if (balanceResults.length > 0) {
		const curWidth = 3;
		lines.push(`  Provider       ${"Balance".padStart(maxNumLen)}`);
		lines.push(`  ─────────────────────────────`);

		if (rows.length === 0) {
			lines.push("  （没有已配置的 Provider）");
		} else {
			for (const row of rows) {
				const label = row.isFirst ? row.provider.padEnd(14) : "".padEnd(14);
				if (row.type === "error") {
					lines.push(`  ${label} ${row.text}`);
				} else {
					lines.push(`  ${label} ${row.num.padStart(maxNumLen)} ${row.currency.padStart(curWidth)}`);
				}
			}
		}
	}

	for (const result of quotaResults) {
		const quota = result.quota;
		if (!quota) continue;

		if (lines.length > 0) lines.push("");
		const plan = quota.planType ? `（${formatPlanType(quota.planType)}）` : "";
		lines.push(`  ${result.provider} 额度${plan}`);
		lines.push(`  ─────────────────────────────`);

		const windows: Array<{ label: string; window: CodexUsageWindow }> = [];
		if (quota.primary) windows.push({ label: "Primary", window: quota.primary });
		if (quota.secondary) windows.push({ label: "Secondary", window: quota.secondary });

		for (const { label, window } of windows) {
			const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
			const percentage = `${formatPercent(remaining)}% 剩余`;
			const windowLabel = formatWindowLabel(window, label);
			const reset = formatQuotaReset(window);
			lines.push(`  ${windowLabel.padEnd(10)} ${percentage.padStart(10)}${reset ? `  ${reset}` : ""}`);
		}

		if (windows.length === 0) {
			lines.push("  （没有可用的额度窗口）");
		}

		if (quota.limitReached === true) lines.push("  ⚠ 已达到额度限制");
		if (quota.credits) {
			let credits = "无";
			if (quota.credits.unlimited) credits = "无限";
			else if (quota.credits.balance !== undefined && quota.credits.balance !== null) credits = String(quota.credits.balance);
			else if (quota.credits.hasCredits) credits = "可用";
			lines.push(`  ${"Credits".padEnd(10)} ${credits}`);
		}
	}

	if (lines.length === 0) lines.push("  （没有已配置的 Provider）");
	return lines;
}

function formatPlanType(planType: string): string {
	return planType
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatPercent(value: number): string {
	const rounded = Math.round(value * 10) / 10;
	return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatWindowLabel(window: CodexUsageWindow, fallback: string): string {
	const seconds = window.limitWindowSeconds;
	if (!seconds || seconds <= 0) return fallback;
	if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
	if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${Math.round(seconds)}s`;
}

function formatQuotaReset(window: CodexUsageWindow): string {
	let seconds = window.resetAfterSeconds;
	if (seconds === undefined && window.resetAt !== undefined) {
		seconds = Math.max(0, window.resetAt - Date.now() / 1000);
	}
	if (seconds === undefined || !Number.isFinite(seconds)) return "";
	if (seconds < 60) return "重置 <1m";

	const totalMinutes = Math.ceil(seconds / 60);
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const minutes = totalMinutes % 60;
	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0 && days === 0) parts.push(`${minutes}m`);
	return `重置 ${parts.join(" ")}后`;
}

// ─── 查询逻辑 ───

async function queryFreeModels(): Promise<{ models: FreeModel[]; error?: string }> {
	const auth = loadAuth();
	const entry = auth["openrouter"];
	const key = entry?.type === "api_key" ? entry.key : undefined;

	if (!key) {
		return { models: [], error: "auth.json 中未找到 openrouter 的 API Key" };
	}

	const headers: Record<string, string> = {
		Accept: "application/json",
		Authorization: `Bearer ${key}`,
	};

	try {
		// 服务端过滤 + 排序：q 搜索 free 变体，sort 按 coding_index 降序（无评分的模型排最后）
		const url = `https://openrouter.ai/api/v1/models?q=:free&sort=coding-high-to-low`;
		const res = await fetch(url, { headers });
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			return { models: [], error: `HTTP ${res.status}${body ? `: ${body}` : ""}` };
		}

		const data = (await res.json()) as {
			data?: Array<{
				id: string;
				benchmarks?: {
					artificial_analysis?: { coding_index?: number | null };
				};
			}>;
		};
		if (!data.data) return { models: [], error: "未返回模型数据" };

		// 过滤掉无 coding_index 评分的模型
		const models = data.data
			.filter((m) => m.benchmarks?.artificial_analysis?.coding_index != null)
			.map((m): FreeModel => ({
				id: m.id,
				codingIndex: m.benchmarks?.artificial_analysis?.coding_index ?? null,
				latency: null,
				throughput: null,
			}))
			.slice(0, FREE_TOP_N);

		// 逐模型拉取 endpoints，填充 Latency / Throughput（单个失败不影响整体）
		for (let i = 0; i < models.length; i += ENDPOINTS_CONCURRENCY) {
			await Promise.all(
				models.slice(i, i + ENDPOINTS_CONCURRENCY).map(async (m) => {
					try {
						const er = await fetch(`https://openrouter.ai/api/v1/models/${m.id}/endpoints`, { headers });
						if (!er.ok) return;
						const ed = (await er.json()) as {
							data?: {
								endpoints?: Array<{
									/** 认证请求返回百分位对象 {p50,p75,p90,p99}，未认证为 null */
									latency_last_30m?: { p50?: number } | number | null;
									throughput_last_30m?: { p50?: number } | number | null;
								}>;
							};
						};
						const eps = ed.data?.endpoints ?? [];
						const lats = eps
							.map((e) => toP50(e.latency_last_30m))
							.filter((v): v is number => v !== null);
						const thrs = eps
							.map((e) => toP50(e.throughput_last_30m))
							.filter((v): v is number => v !== null);
						m.latency = lats.length > 0 ? Math.min(...lats) : null;
						m.throughput = thrs.length > 0 ? Math.max(...thrs) : null;
					} catch {
						/* 忽略单个模型的 endpoints 错误 */
					}
				}),
			);
		}

		return { models };
	} catch (e) {
		return { models: [], error: (e as Error).message };
	}
}

/** 兼容数字或百分位对象 {p50,...}，返回 p50 中位数 */
function toP50(v: { p50?: number } | number | null | undefined): number | null {
	if (typeof v === "number") return v;
	if (v && typeof v.p50 === "number") return v.p50;
	return null;
}

function formatLatency(ms: number): string {
	if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.round(ms)}ms`;
}

function formatThroughput(tps: number): string {
	if (tps >= 1000) return `${(tps / 1000).toFixed(1)}K t/s`;
	return `${Math.round(tps)} t/s`;
}

function renderFreeModels(models: FreeModel[], error?: string): string[] {
	const lines: string[] = [];
	lines.push(`  OpenRouter 免费模型（Top ${models.length}，按 Coding 排序）`);
	lines.push(`  ─────────────────────────────`);

	if (error) {
		lines.push(`  ⚠ ${error}`);
		return lines;
	}
	if (models.length === 0) {
		lines.push("  （没有找到匹配的免费模型）");
		return lines;
	}

	const maxLen = Math.max(...models.map((m) => m.id.length));
	lines.push(`  Coding  ${"Model".padEnd(maxLen)}  Latency  Throughput`);
	for (const m of models) {
		const coding = m.codingIndex === null ? "—" : m.codingIndex.toFixed(1);
		const latency = m.latency === null ? "—" : formatLatency(m.latency);
		const throughput = m.throughput === null ? "—" : formatThroughput(m.throughput);
		lines.push(
			`  ${coding.padStart(6)}  ${m.id.padEnd(maxLen)}  ${latency.padStart(7)}  ${throughput.padStart(9)}`,
		);
	}

	return lines;
}

function matchesProvider(c: ProviderChecker, target: string): boolean {
	const normalized = target.toLowerCase();
	return [c.name, c.authId, ...(c.aliases ?? [])].some((value) => value.toLowerCase() === normalized);
}

async function resolveProviderCredential(
	checker: ProviderChecker,
	entry: AuthEntry | undefined,
	ctx?: ExtensionCommandContext,
): Promise<{ key?: string; accountId?: string }> {
	if (checker.authId !== "openai-codex") {
		return { key: entry?.type === "api_key" ? entry.key : undefined };
	}

	// 通过 ModelRegistry 获取凭据，可复用 pi 对 OAuth token 的自动刷新逻辑。
	const resolvedKey = await ctx?.modelRegistry.getApiKeyForProvider("openai-codex");
	return {
		key: resolvedKey ?? (entry?.type === "oauth" ? entry.access : undefined),
		accountId: entry?.accountId,
	};
}

async function queryBalances(target?: string, ctx?: ExtensionCommandContext): Promise<BalanceResult[]> {
	const auth = loadAuth();

	const active = target ? checkers.filter((c) => matchesProvider(c, target)) : checkers;

	const promises = active.map(async (c) => {
		try {
			const entry = auth[c.authId];
			const { key, accountId } = await resolveProviderCredential(c, entry, ctx);

			if (!key && target) {
				const credentialType = c.authId === "openai-codex" ? "OAuth 凭据" : "API Key";
				return {
					provider: c.name,
					balances: [] as BalanceResult["balances"],
					error: `auth.json 中未找到 ${c.authId} 的 ${credentialType}`,
				} satisfies BalanceResult;
			}
			if (!key) return null; // 未指定目标时跳过

			const r = await c.check(key, accountId);
			return { provider: c.name, ...r } satisfies BalanceResult;
		} catch (e) {
			return {
				provider: c.name,
				balances: [] as BalanceResult["balances"],
				error: (e as Error).message,
			} satisfies BalanceResult;
		}
	});

	const results = (await Promise.all(promises)).filter((r) => r !== null) as BalanceResult[];
	return results;
}

/** /balance 的参数候选：free + 各 provider。value 用别名优先，与 matchesProvider 的匹配口径一致 */
function balanceTargets(): AutocompleteItem[] {
	const items: AutocompleteItem[] = [
		{ value: "free", label: "free", description: "列出 OpenRouter 免费模型" },
	];
	for (const c of checkers) {
		const value = (c.aliases?.[0] ?? c.name).toLowerCase();
		items.push({ value, label: value, description: c.name });
	}
	return items;
}

// ─── 扩展入口 ───

export default function (pi: ExtensionAPI) {
	// 注册 entry renderer，使 /balance 结果在 TUI 中漂亮渲染
	pi.registerEntryRenderer<BalanceEntry>("balance", (entry, _options, theme) => {
		const data = entry.data ?? { lines: ["(no data)"] };
		const box = new Box(1, 1);
		for (const line of data.lines) box.addChild(new Text(theme.fg("dim", line), 0, 0));
		return box;
	});

	// ─── 命令 ───

	pi.registerCommand("balance", {
		description: "查询 Provider 余额/Codex 额度，或列出 OpenRouter 免费模型。用法: /balance，/balance codex，/balance free",
		getArgumentCompletions: (prefix) => {
			// 只补第一个参数；已输入空格后交由用户自由输入
			if (prefix.trim().includes(" ")) return null;
			const typed = prefix.trim().toLowerCase();
			const items = balanceTargets().filter((i) => i.value.startsWith(typed));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			try {
				const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
				const arg = tokens[0] ?? "";

				// /balance free — 列出 OpenRouter 免费模型
				if (arg === "free") {
					const { models, error } = await queryFreeModels();
					pi.appendEntry<BalanceEntry>("balance", { lines: renderFreeModels(models, error) });
					return;
				}

				const target = arg || undefined;
				const results = await queryBalances(target, ctx);

				if (target && results.length === 0) {
					ctx.ui.notify(`未找到 Provider: ${target}`, "warning");
					return;
				}

				// 如果没有配置任何凭据且未指定目标，提示用户
				if (results.length === 0) {
					ctx.ui.notify("auth.json 中未找到任何已配置的 API Key 或 OAuth 凭据", "info");
					return;
				}

				const lines = renderBalance(results);
				pi.appendEntry<BalanceEntry>("balance", { lines });
			} catch (e) {
				ctx.ui.notify(`[error] ${(e as Error).message}`, "error");
			}
		},
	});
}
