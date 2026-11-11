/**
 * Provider 余额查询扩展
 *
 * 从 Pi agent dir 下的 auth.json 读取 API Key/OAuth 凭据，查询各 Provider 的账户余额或额度。
 * 当前支持:
 *   - DeepSeek
 *   - Moonshot
 *   - OpenRouter
 *   - OpenAI Codex（ChatGPT Plus/Pro 额度）
 *   - OpenCode Go（Go/Go Plus/Go Teams 的 5h/周/月额度）
 *   - Zhipu GLM（智谱 Coding Plan 积分额度）
 *
 * 命令：
 *   /balance            — 列出支持的 Provider（不查询额度）
 *   /balance all        — 查询所有已配置 Provider 的余额/额度
 *   /balance <provider> — 只查某个 Provider（如 /balance opencode）
 *   /balance free       — 列出 OpenRouter 免费模型 Top 20（按 coding_index 排序，含 Latency/Throughput）
 *
 * 查询与渲染分别在 lib/balance/providers.ts 与 lib/balance/render.ts；
 * 本模块只负责命令注册、参数解析与结果落 entry。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { checkers, queryBalances, queryFreeModels } from "./lib/balance/providers.ts";
import { renderBalance, renderFreeModels, renderProviders, providerCommand } from "./lib/balance/render.ts";
import { renderDimLines } from "./lib/render.ts";

interface BalanceEntry {
	lines: string[];
}

/** /balance 的参数候选：all + free + 各 provider。value 用别名优先，与 matchesProvider 的匹配口径一致 */
function balanceTargets(): AutocompleteItem[] {
	const items: AutocompleteItem[] = [
		{ value: "all", label: "all", description: "查询所有已配置 Provider" },
		{ value: "free", label: "free", description: "列出 OpenRouter 免费模型" },
	];
	for (const c of checkers) {
		const value = providerCommand(c);
		items.push({ value, label: value, description: c.name });
	}
	return items;
}

export default function (pi: ExtensionAPI) {
	// 注册 entry renderer，使 /balance 结果在 TUI 中漂亮渲染
	pi.registerEntryRenderer<BalanceEntry>("balance", (entry, _options, theme) =>
		renderDimLines(theme, entry.data?.lines ?? ["(no data)"]),
	);

	pi.registerCommand("balance", {
		description: "查询 Provider 余额/额度。用法: /balance（列支持的 Provider），/balance all，/balance opencode，/balance free",
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

				// /balance — 只列支持的 Provider，不查询额度
				if (!arg) {
					pi.appendEntry<BalanceEntry>("balance", { lines: renderProviders(checkers) });
					return;
				}

				// /balance free — 列出 OpenRouter 免费模型
				if (arg === "free") {
					const { models, error } = await queryFreeModels();
					pi.appendEntry<BalanceEntry>("balance", { lines: renderFreeModels(models, error) });
					return;
				}

				// /balance all — 查全部；/balance <provider> — 查单个
				const target = arg === "all" ? undefined : arg;
				const results = await queryBalances(target, ctx);

				if (target && results.length === 0) {
					ctx.ui.notify(`未找到 Provider: ${target}`, "warning");
					return;
				}

				// 如果没有配置任何凭据且指定了 all，提示用户
				if (results.length === 0) {
					ctx.ui.notify("auth.json 中未找到任何已配置的 API Key 或 OAuth 凭据", "info");
					return;
				}

				pi.appendEntry<BalanceEntry>("balance", { lines: renderBalance(results) });
			} catch (e) {
				ctx.ui.notify(`[error] ${(e as Error).message}`, "error");
			}
		},
	});
}
