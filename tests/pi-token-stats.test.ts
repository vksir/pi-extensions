import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { initTheme, type ExtensionContext, type ReadonlyFooterDataProvider, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createFirstTokenTimer, createRateFooter, formatFirstToken, formatRate, insertRate, outputRate, shrinkPadding } from "../extensions/lib/footer-rate.ts";
import { parseTokenWindow, renderStats, tokenArgumentCompletions } from "../extensions/pi-token-stats.ts";
import type { WindowModelRow } from "../extensions/lib/token-stats-db.ts";

// 内置 FooterComponent 渲染时会取当前主题的颜色。
initTheme("dark");

function assistant(output: number, durationMs: number | undefined): SessionEntry {
	return {
		type: "message",
		id: `m${output}`,
		parentId: null,
		timestamp: 0,
		message: {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "deepseek",
			model: "deepseek-flash",
			usage: {
				input: 1000,
				output,
				cacheRead: 9000,
				cacheWrite: 0,
				totalTokens: 1000 + output + 9000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.09 },
			},
			stopReason: "stop",
			timestamp: 0,
			durationMs,
		},
	} as unknown as SessionEntry;
}

const userEntry = { type: "message", id: "u", parentId: null, timestamp: 0, message: { role: "user", content: "hi", timestamp: 0 } } as unknown as SessionEntry;

test("outputRate 取最近一次有耗时的 assistant 响应", () => {
	assert.equal(outputRate([]), undefined);
	assert.equal(outputRate([userEntry]), undefined);
	// 2000 token / 2s = 1000 t/s
	assert.equal(outputRate([assistant(100, 1000), assistant(2000, 2000)]), 1000);
	// 没有 durationMs 的老消息跳过，继续往前找
	assert.equal(outputRate([assistant(500, 1000), assistant(800, undefined)]), 500);
	// 空输出不算速率
	assert.equal(outputRate([assistant(0, 1000)]), undefined);
});

test("formatRate：两位数取整，个位数保留一位小数", () => {
	assert.equal(formatRate(42.4), "42t/s");
	assert.equal(formatRate(3.44), "3.4t/s");
});

test("formatFirstToken：一秒以内用毫秒，再长用秒", () => {
	assert.equal(formatFirstToken(850), "850ms");
	assert.equal(formatFirstToken(1234), "1.2s");
});

test("createFirstTokenTimer：从请求开始到第一个内容块", () => {
	let now = 1_000;
	const timer = createFirstTokenTimer(() => now);
	const message = { timestamp: 400 } as AssistantMessage;

	// 响应头（start）到达还不算首字
	timer.record(message, { type: "start" });
	assert.equal(timer.firstTokenMs(400), undefined);

	now = 1_150;
	timer.record(message, { type: "thinking_start" });
	assert.equal(timer.firstTokenMs(400), 750);

	// 同一个响应的后续事件不覆盖第一次测量
	now = 9_999;
	timer.record(message, { type: "text_delta" });
	assert.equal(timer.firstTokenMs(400), 750);

	// 时间戳对不上的消息（老会话、别的会话）不显示，免得张冠李戴
	assert.equal(timer.firstTokenMs(999), undefined);

	// 下一次请求重新计时
	now = 2_000;
	timer.record({ timestamp: 1_900 } as AssistantMessage, { type: "text_start" });
	assert.equal(timer.firstTokenMs(1_900), 100);
	assert.equal(timer.firstTokenMs(400), undefined);
});

test("insertRate 落在用量段与缓存命中率之间", () => {
	assert.equal(
		insertRate("↑225k ↓42k R1.5M CH97.1% $0.090 7.1%/1.0M (auto)", "42t/s"),
		"↑225k ↓42k R1.5M 42t/s CH97.1% $0.090 7.1%/1.0M (auto)",
	);
	// 没有命中率时接在最后一个用量段之后
	assert.equal(insertRate("↑225k ↓42k R1.5M $0.090", "42t/s"), "↑225k ↓42k R1.5M 42t/s $0.090");
	assert.equal(insertRate("↑225k ↓42k R1.5M", "42t/s"), "↑225k ↓42k R1.5M 42t/s");
	// 一个用量段都没有时原样返回
	assert.equal(insertRate("", "42t/s"), "");
});

test("shrinkPadding 从最宽的空档里扣宽度", () => {
	assert.equal(shrinkPadding("↑1k CH90%        model", 7), "↑1k CH90% model");
	// 空档不够扣时扣到只剩一个空格
	assert.equal(shrinkPadding("↑1k CH90%  model", 4), "↑1k CH90% model");
	assert.equal(shrinkPadding("↑1k CH90%  model", 0), "↑1k CH90%  model");
});

/** FooterComponent 读到的会话视图：只补它真正调用到的成员。 */
function fakeContext(entries: SessionEntry[]) {
	const calls = { entries: 0 };
	const sessionManager = {
		getCwd: () => "D:/Code/MyProject/pi-extensions",
		getSessionName: () => undefined,
		getEntries: () => {
			calls.entries += 1;
			return entries;
		},
		getEntryCount: () => entries.length,
		getSessionId: () => "session-1",
		getLeafId: () => "leaf-1",
	};
	const ctx = {
		mode: "tui",
		model: { provider: "deepseek", id: "deepseek-flash", contextWindow: 128000, reasoning: false },
		thinkingLevel: "off",
		sessionManager,
		getContextUsage: () => ({ contextWindow: 128000, percent: 7.1 }),
	} as unknown as ExtensionContext;
	const footerData: ReadonlyFooterDataProvider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
	return { ctx, footerData, calls };
}

test("createRateFooter：内置状态行里多一段首字时间与速率", () => {
	const { ctx, footerData, calls } = fakeContext([assistant(2000, 2000)]);
	const footer = createRateFooter(ctx, footerData, {
		isAutoCompactEnabled: () => true,
		firstTokenMs: () => 850,
	});
	const lines = footer.render(120);

	assert.equal(lines.length, 2);
	assert.match(lines[0], /pi-extensions \(main\)/);
	assert.match(lines[1], /R[\d.]+k? 850ms 1000t\/s CH/);
	// 内置 footer 的其它段原样保留
	assert.match(lines[1], /CH\d+(?:\.\d+)?%/);
	assert.match(lines[1], /deepseek-flash/);
	assert.match(lines[1], /\(auto\)/);

	// 条目数不变时不重复扫描会话内容：每帧只取一次条目列表用于比对
	const before = calls.entries;
	footer.render(120);
	assert.equal(calls.entries, before + 1);
});

test("createRateFooter：没测到首字时间时只显示速率", () => {
	const { ctx, footerData } = fakeContext([assistant(2000, 2000)]);
	const footer = createRateFooter(ctx, footerData, { isAutoCompactEnabled: () => true });
	const line = footer.render(120)[1];
	assert.match(line, / 1000t\/s CH/);
	assert.doesNotMatch(line, /\b\d+ms\b|\b\d+\.\ds\b/);
});

test("createRateFooter：拿不到速率时保留内置状态行", () => {
	const { ctx, footerData } = fakeContext([userEntry]);
	const lines = createRateFooter(ctx, footerData, { isAutoCompactEnabled: () => false }).render(120);
	assert.doesNotMatch(lines[1], /t\/s/);
	assert.match(lines[1], /deepseek-flash/);
	// 自动压缩关闭时没有 (auto)
	assert.doesNotMatch(lines[1], /\(auto\)/);
});

function windowRow(overrides: Partial<WindowModelRow> = {}): WindowModelRow {
	return {
		provider: "deepseek",
		model: "deepseek/deepseek-chat",
		turns: 2,
		output: 1_000,
		timedOutput: 1_000,
		timedMs: 10_000,
		firstTokenMs: 1_600,
		firstTokenSamples: 2,
		...overrides,
	};
}

test("renderStats：按模型列出平均首字与平均速率，并给出总计", () => {
	const rows = [
		windowRow(),
		windowRow({
			provider: "openai",
			model: "gpt-5",
			turns: 1,
			output: 500,
			timedOutput: 500,
			timedMs: 2_000,
			firstTokenMs: 1_200,
			firstTokenSamples: 1,
		}),
	];
	const text = renderStats(rows, { since: 0, label: "1h" }, 120).join("\n");

	assert.match(text, /Token Speed · Last 1h/);
	assert.match(text, /Model\s+Turns\s+TTFT\s+Rate/);
	// provider 已经在模型名里，不重复拼前缀
	assert.doesNotMatch(text, /deepseek\/deepseek\/deepseek-chat/);
	assert.match(text, /deepseek\/deepseek-chat\s+2\s+800ms\s+100t\/s/);
	assert.match(text, /openai\/gpt-5\s+1\s+1\.2s\s+250t\/s/);
	// 总计按 token 加权：1500 token / 12s = 125 t/s；首字是 2800ms / 3
	assert.match(text, /All models\s+3\s+933ms\s+125t\/s/);
	assert.match(text, /TTFT = average time to first token/);
	assert.match(text, /Rate = output tokens ÷ full request time/);
});

test("renderStats：没有计时样本的行显示占位", () => {
	const text = renderStats(
		[windowRow({ turns: 1, output: 100, timedOutput: 0, timedMs: 0, firstTokenMs: 0, firstTokenSamples: 0 })],
		{ since: 0, label: "3h" },
		80,
	).join("\n");
	assert.match(text, /deepseek\/deepseek-chat\s+1\s+-\s+-/);
});

test("renderStats：空窗口与 all 的文案", () => {
	const empty = renderStats([], { since: 0, label: "1h" }, 80).join("\n");
	assert.match(empty, /Token Speed · Last 1h/);
	assert.match(empty, /No turns in the last 1h\./);

	const all = renderStats([], { since: 0, label: "all" }, 80).join("\n");
	assert.match(all, /Token Speed · All time/);
	assert.match(all, /No turns recorded yet\./);
});

test("renderStats：窄终端里截断模型名，不超出宽度", () => {
	const rows = [
		windowRow({ provider: "very-long-provider", model: "very-long-provider/a-very-long-model-name-here" }),
	];
	const lines = renderStats(rows, { since: 0, label: "1h" }, 60);
	assert.ok(lines.every((line) => visibleWidth(line) <= 60), lines.join("\n"));
	assert.match(lines.join("\n"), /…/);
});

test("parseTokenWindow：默认 1 小时，支持 m/h/d/all", () => {
	const now = 1_000_000_000;
	assert.deepEqual(parseTokenWindow("", now), { since: now - 3_600_000, label: "1h" });
	assert.deepEqual(parseTokenWindow("3h", now), { since: now - 3 * 3_600_000, label: "3h" });
	assert.deepEqual(parseTokenWindow("30m", now), { since: now - 1_800_000, label: "30m" });
	assert.deepEqual(parseTokenWindow("1d", now), { since: now - 86_400_000, label: "1d" });
	assert.deepEqual(parseTokenWindow("90m", now), { since: now - 5_400_000, label: "1h30m" });
	assert.deepEqual(parseTokenWindow("1h 30m", now), { since: now - 5_400_000, label: "1h30m" });
	assert.deepEqual(parseTokenWindow("all", now), { since: 0, label: "all" });
	assert.throws(() => parseTokenWindow("7d?"), /unknown argument/);
	assert.throws(() => parseTokenWindow("0h"), /greater than 0/);
});

test("tokenArgumentCompletions：补全保留已写好的参数", () => {
	const values = (prefix: string) => (tokenArgumentCompletions(prefix) ?? []).map((item) => item.value);

	// 空参数：列出候选，不再有旧的 7d / Out
	assert.ok(values("").includes("1h"));
	assert.ok(values("").includes("3h"));
	assert.ok(values("").includes("all"));
	assert.ok(!values("").includes("7d"));
	assert.ok(!values("").includes("Out"));
	// 单个参数：按前缀过滤
	assert.deepEqual(values("3"), ["3h"]);
	// 已写过的参数不再出现在下一条候选里，补全项带上前面的参数
	assert.deepEqual(values("1h "), ["1h 3h", "1h 6h", "1h 12h", "1h 24h", "1h all"]);
	// 多参数：补全项带上前面的参数（pi 补全会整段替换参数文本）
	assert.deepEqual(values("1h a"), ["1h all"]);
	// 没有候选
	assert.equal(tokenArgumentCompletions("zzz"), null);
});
