/**
 * Provider 余额/额度查询：auth.json 读取、鉴权、请求与响应归一化。
 *
 * 这一层只产出结构化结果，不负责 TUI 渲染；错误以字符串放在结果里，
 * 由调用方决定如何展示（/balance 命令当前统一渲染成结果块）。
 */

import { join } from "node:path";
import { getAgentDir, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { responseError } from "../http.ts";
import { readJsonFile } from "../json.ts";

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

export interface CodexUsageWindow {
	usedPercent: number;
	limitWindowSeconds?: number;
	resetAfterSeconds?: number;
	resetAt?: number;
	/** 已用额度（GLM 积分窗口使用，与 total 成对出现） */
	used?: number;
	/** 窗口内总额度 */
	total?: number;
}

interface CodexQuota {
	planType?: string;
	allowed?: boolean;
	limitReached?: boolean;
	primary?: CodexUsageWindow;
	secondary?: CodexUsageWindow;
	/** 多窗口额度（如 OpenCode Go 的 5h/周/月），存在时优先于 primary/secondary */
	windows?: Array<{ label: string; window: CodexUsageWindow }>;
	credits?: {
		hasCredits?: boolean;
		unlimited?: boolean;
		balance?: string | number | null;
	};
}

export interface BalanceResult {
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

/** 智谱 Coding Plan 额度接口的单个限额窗口 */
interface GlmLimitPayload {
	/** 固定为 CREDIT_LIMIT 的才有效 */
	type: string;
	/** 窗口单位：3 = 小时，6 = 周 */
	unit: number;
	/** 窗口大小（配合 unit，如 5h / 1w） */
	number: number;
	/** 窗口内总积分 */
	usage: number;
	/** 已用积分 */
	currentValue: number;
	remaining: number;
	/** 已用百分比（0-100 整数） */
	percentage: number;
	/** 重置时间（毫秒时间戳） */
	nextResetTime: number;
}

/** OpenCode Go 额度接口里的单个用量窗口 */
interface OpenCodeGoMeterPayload {
	/** ok = 正常，rate-limited = 该窗口已用尽 */
	status?: string;
	/** 已用百分比（0-100） */
	percent?: number | string;
	/** 重置时间（ISO 8601 字符串） */
	resetsAt?: string;
}

interface OpenCodeGoUsagePayload {
	usage?: {
		/** 5 小时滚动窗口 */
		rolling?: OpenCodeGoMeterPayload;
		/** 周窗口 */
		weekly?: OpenCodeGoMeterPayload;
		/** 月度窗口 */
		monthly?: OpenCodeGoMeterPayload;
	};
}

interface GlmQuotaPayload {
	code?: number;
	msg?: string;
	success?: boolean;
	data?: {
		limits?: GlmLimitPayload[];
		/** 套餐档位，如 lite / pro / max */
		level?: string;
	};
}

export interface FreeModel {
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
	return join(getAgentDir(), "auth.json");
}

function loadAuth(): AuthStore {
	return readJsonFile<AuthStore>(authPath(), {});
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

/** 余额查询的 Provider 清单；/balance 的参数补全、Provider 列表与筛选也以此为准。 */
export const checkers: ProviderChecker[] = [
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

			if (!res.ok) return { balances: [], error: await responseError(res) };

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

			if (!res.ok) return { balances: [], error: await responseError(res) };

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

			if (!res.ok) return { balances: [], error: await responseError(res) };

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

			if (!res.ok) return { balances: [], error: await responseError(res) };

			const data = (await res.json()) as CodexUsagePayload;
			const quota = normalizeCodexQuota(data);
			if (!quota) {
				return { balances: [], error: "未返回 Codex 额度数据" };
			}

			return { balances: [], quota };
		},
	},
	{
		name: "OpenCode Go",
		authId: "opencode-go",
		aliases: ["opencode", "go"],
		// 与 Console 同源的推理 API：Bearer API Key 即可，带 x-opencode-org-id 时按 workspace 计
		apiUrl: "https://opencode.ai/zen/go/v1/usage",
		async check(key: string) {
			const res = await fetch(this.apiUrl, {
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${key}`,
				},
			});

			if (!res.ok) return { balances: [], error: await responseError(res) };

			const data = (await res.json()) as OpenCodeGoUsagePayload;
			const quota = normalizeOpenCodeGoQuota(data);
			if (!quota) {
				return { balances: [], error: "未返回 OpenCode Go 额度数据（当前账号可能未订阅 Go）" };
			}

			return { balances: [], quota };
		},
	},
	{
		name: "GLM",
		authId: "zai-coding-cn",
		aliases: ["glm", "zai", "zhipu"],
		apiUrl: "https://bigmodel.cn/api/monitor/usage/quota/limit?type=1",
		async check(key: string) {
			// 注意：智谱要求 Authorization 为原始 key，不带 Bearer 前缀
			// type=1 个人套餐；团队套餐为 type=2 且需携带
			// bigmodel-organization / bigmodel-project 请求头（控制台 DevTools 抓取）
			const res = await fetch(this.apiUrl, {
				headers: {
					Accept: "application/json",
					Authorization: key,
				},
			});

			if (!res.ok) return { balances: [], error: await responseError(res) };

			const data = (await res.json()) as GlmQuotaPayload;
			if (!data.success || !data.data) {
				return { balances: [], error: `API 返回异常 code=${data.code}${data.msg ? `: ${data.msg}` : ""}` };
			}

			const quota = normalizeGlmQuota(data.data);
			if (!quota) {
				return {
					balances: [],
					error: "未返回 GLM 额度数据（当前账号可能无 Coding Plan，或团队套餐需改用 type=2 并携带组织/项目头）",
				};
			}

			return { balances: [], quota };
		},
	},
];

// ─── 响应归一化 ───

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

/**
 * 把智谱 Coding Plan 的限额窗口归一化为与 Codex 相同的 quota 结构：
 * 小时窗口（unit=3，如 5h）→ primary，周窗口（unit=6，如 1w）→ secondary。
 */
function normalizeGlmQuota(data: NonNullable<GlmQuotaPayload["data"]>): CodexQuota | undefined {
	const limits = (data.limits ?? []).filter((l) => l.type === "CREDIT_LIMIT");
	if (limits.length === 0) return undefined;

	const toWindow = (l: GlmLimitPayload): CodexUsageWindow => ({
		usedPercent: l.percentage,
		limitWindowSeconds: l.unit === 3 ? l.number * 3_600 : l.unit === 6 ? l.number * 7 * 86_400 : undefined,
		// 智谱 nextResetTime 为毫秒时间戳，Codex 侧统一为秒
		resetAt: l.nextResetTime / 1000,
		used: l.currentValue,
		total: l.usage,
	});

	const primary = limits.find((l) => l.unit === 3) ?? limits[0];
	const secondary = limits.find((l) => l.unit === 6);

	return {
		planType: data.level,
		primary: toWindow(primary),
		secondary: secondary ? toWindow(secondary) : undefined,
	};
}

/**
 * 把 OpenCode Go 的三个用量窗口归一化为 quota.windows：
 * rolling → 5h、weekly → 周、monthly → 月。
 */
function normalizeOpenCodeGoQuota(data: OpenCodeGoUsagePayload): CodexQuota | undefined {
	const usage = data.usage;
	if (!usage) return undefined;

	const meters: Array<{ label: string; meter?: OpenCodeGoMeterPayload }> = [
		{ label: "5h", meter: usage.rolling },
		{ label: "Week", meter: usage.weekly },
		{ label: "Month", meter: usage.monthly },
	];
	const windows: NonNullable<CodexQuota["windows"]> = [];
	let limitReached = false;

	for (const { label, meter } of meters) {
		const usedPercent = toNumber(meter?.percent);
		if (!meter || usedPercent === undefined) continue;

		const resetAt = meter.resetsAt ? Date.parse(meter.resetsAt) / 1000 : undefined;
		windows.push({
			label,
			window: {
				usedPercent,
				// 接口给的是毫秒级 ISO 时间，Codex 侧统一为秒
				resetAt: resetAt !== undefined && Number.isFinite(resetAt) ? resetAt : undefined,
			},
		});
		if (meter.status === "rate-limited") limitReached = true;
	}

	if (windows.length === 0) return undefined;
	return { windows, limitReached };
}

// ─── 免费模型 ───

/** 兼容数字或百分位对象 {p50,...}，返回 p50 中位数 */
function toP50(v: { p50?: number } | number | null | undefined): number | null {
	if (typeof v === "number") return v;
	if (v && typeof v.p50 === "number") return v.p50;
	return null;
}

export async function queryFreeModels(): Promise<{ models: FreeModel[]; error?: string }> {
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
		if (!res.ok) return { models: [], error: await responseError(res) };

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

// ─── 查询逻辑 ───

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

export async function queryBalances(target?: string, ctx?: ExtensionCommandContext): Promise<BalanceResult[]> {
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
