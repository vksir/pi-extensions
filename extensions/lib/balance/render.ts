/**
 * /balance 的结果渲染：金额表格、额度窗口与免费模型列表。
 *
 * 只把 providers 层返回的结构化数据排成文本行，不发起请求，也不依赖 TUI。
 */

import type { BalanceResult, CodexUsageWindow, FreeModel } from "./providers.ts";

// ─── 余额 / 额度 ───

export function renderBalance(results: BalanceResult[]): string[] {
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

		const windows: Array<{ label: string; window: CodexUsageWindow }> =
			quota.windows ??
			[
				...(quota.primary ? [{ label: "Primary", window: quota.primary }] : []),
				...(quota.secondary ? [{ label: "Secondary", window: quota.secondary }] : []),
			];

		for (const { label, window } of windows) {
			const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
			const percentage = `${formatPercent(remaining)}% 剩余`;
			const windowLabel = formatWindowLabel(window, label);
			// 已用/总额度（如 GLM 积分窗口），Codex 无此信息时留空
			const credits =
				window.used !== undefined && window.total !== undefined
					? `  ${Math.round(window.used)}/${Math.round(window.total)} 积分`
					: "";
			const reset = formatQuotaReset(window);
			lines.push(`  ${windowLabel.padEnd(10)} ${percentage.padStart(10)}${credits}${reset ? `  ${reset}` : ""}`);
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

// ─── Provider 列表 ───

/** 一个 Provider 在 /balance 参数里的命令词：优先用首个别名，否则用名称。 */
export function providerCommand(checker: { name: string; aliases?: string[] }): string {
	return (checker.aliases?.[0] ?? checker.name).toLowerCase();
}

/** /balance 不带参数时展示的 Provider 清单（不发请求）。 */
export function renderProviders(checkers: ReadonlyArray<{ name: string; aliases?: string[] }>): string[] {
	const lines: string[] = [];
	lines.push(`  支持的 Provider（${checkers.length}）`);
	lines.push(`  ─────────────────────────────`);

	for (const checker of checkers) {
		lines.push(`  ${checker.name.padEnd(14)} ${providerCommand(checker)}`);
	}

	lines.push(`  ─────────────────────────────`);
	lines.push(`  ${"all".padEnd(14)} 查询全部已配置 Provider`);
	lines.push(`  ${"free".padEnd(14)} OpenRouter 免费模型`);
	lines.push("");
	lines.push("  /balance <命令> 查单个；/balance all 查全部");
	return lines;
}

// ─── 免费模型 ───

function formatLatency(ms: number): string {
	if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.round(ms)}ms`;
}

function formatThroughput(tps: number): string {
	if (tps >= 1000) return `${(tps / 1000).toFixed(1)}K t/s`;
	return `${Math.round(tps)} t/s`;
}

export function renderFreeModels(models: FreeModel[], error?: string): string[] {
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
