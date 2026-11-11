import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type ExtensionContext, type ReadonlyFooterDataProvider, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { createRateFooter, formatRate, insertRate, outputRate, shrinkPadding } from "../extensions/lib/footer-rate.ts";

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

test("insertRate 落在用量段与缓存命中率之间", () => {	assert.equal(
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

test("createRateFooter：内置状态行里多一段速率", () => {
	const { ctx, footerData, calls } = fakeContext([assistant(2000, 2000)]);
	const footer = createRateFooter(ctx, footerData, { isAutoCompactEnabled: () => true });
	const lines = footer.render(120);

	assert.equal(lines.length, 2);
	assert.match(lines[0], /pi-extensions \(main\)/);
	assert.match(lines[1], /R[\d.]+k? 1000t\/s CH/);
	// 内置 footer 的其它段原样保留
	assert.match(lines[1], /CH\d+(?:\.\d+)?%/);
	assert.match(lines[1], /deepseek-flash/);
	assert.match(lines[1], /\(auto\)/);

	// 条目数不变时不重复扫描会话内容：每帧只取一次条目列表用于比对
	const before = calls.entries;
	footer.render(120);
	assert.equal(calls.entries, before + 1);
});

test("createRateFooter：拿不到速率时保留内置状态行", () => {
	const { ctx, footerData } = fakeContext([userEntry]);
	const lines = createRateFooter(ctx, footerData, { isAutoCompactEnabled: () => false }).render(120);
	assert.doesNotMatch(lines[1], /t\/s/);
	assert.match(lines[1], /deepseek-flash/);
	// 自动压缩关闭时没有 (auto)
	assert.doesNotMatch(lines[1], /\(auto\)/);
});
