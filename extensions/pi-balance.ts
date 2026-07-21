/**
 * Provider 余额查询扩展
 *
 * 从 ~/.pi/agent/auth.json 读取 API Key，查询各 Provider 的账户余额。
 * 当前支持:
 *   - DeepSeek
 *
 * 命令：
 *   /balance        — 查询所有已配置 Provider 的余额
 *   /balance deepseek — 只查某个 Provider
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── 类型 ───

interface AuthStore {
	[key: string]: { type: string; key: string };
}

interface BalanceResult {
	provider: string;
	/** 每个币种一条 */
	balances: Array<{
		currency: string;
		total: string;
	}>;
	error?: string;
}

interface BalanceEntry {
	lines: string[];
}

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
	/** 余额 API URL */
	apiUrl: string;
	check(key: string): Promise<Omit<BalanceResult, "provider">>;
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
];

// ─── 格式化 ───

function formatBalance(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
	if (value >= 1) return value.toFixed(2);
	if (value >= 0.01) return value.toFixed(4);
	return value.toFixed(6);
}

function fmtBar(value: number, max: number, width: number): string {
	if (max <= 0 || value <= 0) return "░".repeat(width);
	const filled = Math.max(1, Math.round((value / max) * width));
	return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

// ─── 渲染 ───

function renderBalance(results: BalanceResult[]): string[] {
	const lines: string[] = [];

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

	for (const r of results) {
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

	const curWidth = 3;
	lines.push(`  Provider       ${"Balance".padStart(maxNumLen)}`);
	lines.push(`  ─────────────────────────────`);

	if (rows.length === 0) {
		lines.push("  （没有已配置的 Provider）");
		return lines;
	}

	for (const row of rows) {
		const label = row.isFirst ? row.provider.padEnd(14) : "".padEnd(14);
		if (row.type === "error") {
			lines.push(`  ${label} ${row.text}`);
		} else {
			lines.push(`  ${label} ${row.num.padStart(maxNumLen)} ${row.currency.padStart(curWidth)}`);
		}
	}

	return lines;
}

// ─── 查询逻辑 ───

async function queryBalances(target?: string): Promise<BalanceResult[]> {
	const auth = loadAuth();

	const active = target
		? checkers.filter((c) => c.name.toLowerCase() === target.toLowerCase())
		: checkers;

	const promises = active.map(async (c) => {
		const entry = auth[c.authId];
		const key = entry?.type === "api_key" ? entry.key : undefined;

		if (!key && target) {
			return {
				provider: c.name,
				balances: [] as BalanceResult["balances"],
				error: `auth.json 中未找到 ${c.authId} 的 API Key`,
			} satisfies BalanceResult;
		}
		if (!key) return null; // 未指定目标时跳过

		try {
			const r = await c.check(key);
			return { provider: c.name, balances: r.balances, error: r.error } satisfies BalanceResult;
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
		description: "查询 Provider 余额。可指定名称过滤，如 /balance deepseek",
		handler: async (args, ctx) => {
			try {
				const arg = args.trim().toLowerCase();
				const target = arg || undefined;
				const results = await queryBalances(target);

				if (target && results.length === 0) {
					ctx.ui.notify(`未找到 Provider: ${target}`, "warning");
					return;
				}

				// 如果没有配置任何 Key 且未指定目标，提示用户
				if (results.length === 0) {
					ctx.ui.notify("auth.json 中未找到任何已配置的 API Key", "info");
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
