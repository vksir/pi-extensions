import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { initTheme, type ExtensionContext, type ReadonlyFooterDataProvider, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { createFirstTokenTimer, createRateFooter, formatFirstToken, formatRate, insertRate, outputRate, shrinkPadding } from "../extensions/lib/footer-rate.ts";
import { averageFirstTokenMs, averageOutputRate, recordSessionTurn, type SessionRecord, type SessionTurn } from "../extensions/lib/session-usage.ts";
import { renderStats, tokenArgumentCompletions } from "../extensions/pi-token-stats.ts";

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

function turn(at: number, output: number, durationMs?: number, firstTokenMs?: number): SessionTurn {
	return {
		at,
		name: "会话 A",
		usage: { input: 100, output, cacheRead: 900, cacheWrite: 0, cost: 0.01 },
		durationMs,
		firstTokenMs,
	};
}

test("recordSessionTurn：首次见到会话时建记录，累计用量与轮次", () => {
	const first = recordSessionTurn(undefined, turn(1_000, 100, 2_000, 800));
	assert.equal(first.firstActiveAt, 1_000);
	assert.equal(first.lastActiveAt, 1_000);
	assert.equal(first.turns, 1);
	assert.deepEqual(first.usage, { input: 100, output: 100, cacheRead: 900, cacheWrite: 0, cost: 0.01 });

	const second = recordSessionTurn(first, turn(5_000, 300, 1_000, 400));
	assert.equal(second.firstActiveAt, 1_000);
	assert.equal(second.lastActiveAt, 5_000);
	assert.equal(second.turns, 2);
	assert.deepEqual(second.usage, { input: 200, output: 400, cacheRead: 1800, cacheWrite: 0, cost: 0.02 });
	// 纯函数：不改上一条记录
	assert.equal(first.turns, 1);
});

test("recordSessionTurn：会话名跟着最新一次记录更新", () => {
	const record = recordSessionTurn(undefined, turn(1_000, 100));
	assert.equal(record.name, "会话 A");
	// 拿不到名字（未命名 / 续聊）时保留已记录的名字
	assert.equal(recordSessionTurn(record, { ...turn(2_000, 100), name: undefined }).name, "会话 A");
	assert.equal(recordSessionTurn(record, { ...turn(2_000, 100), name: "改名了" }).name, "改名了");
});

test("averageOutputRate：按 token 加权，不是逐次速率的平均", () => {
	const record = recordSessionTurn(
		recordSessionTurn(undefined, turn(1_000, 100, 2_000)), // 50 t/s
		turn(2_000, 900, 1_000), // 900 t/s
	);
	// 逐次平均会得到 475 t/s；加权 = 1000 token / 3s
	assert.equal(averageOutputRate(record), 1000 / 3);
	assert.equal(record.timedOutput, 1_000);
	assert.equal(record.timedMs, 3_000);

	// 没有耗时或没有输出的响应不进样本
	const noTiming = recordSessionTurn(undefined, turn(1_000, 500, undefined));
	assert.equal(averageOutputRate(noTiming), undefined);
	assert.equal(averageOutputRate(recordSessionTurn(undefined, turn(1_000, 0, 1_000))), undefined);
});

test("averageFirstTokenMs：只平均测到的样本", () => {
	const record = recordSessionTurn(
		recordSessionTurn(undefined, turn(1_000, 100, 1_000, 800)),
		turn(2_000, 100, 1_000), // 没测到首字
	);
	assert.equal(record.firstTokenSamples, 1);
	assert.equal(averageFirstTokenMs(record), 800);
	// 首字为 0（立即返回）也是有效样本
	assert.equal(averageFirstTokenMs(recordSessionTurn(undefined, turn(1_000, 100, 1_000, 0))), 0);
	assert.equal(averageFirstTokenMs(recordSessionTurn(undefined, turn(1_000, 100, 1_000))), undefined);
});

const DAY_MS = 24 * 60 * 60 * 1000;

function localDate(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 报告只负责排版：会话记录在这里直接构造，落库/查询由 token-stats-db 的测试覆盖。 */
function statsSession(at: number, output: number, durationMs?: number, firstTokenMs?: number): SessionRecord {
	return recordSessionTurn(undefined, {
		at,
		name: "当前会话",
		usage: { input: 100, output, cacheRead: 900, cacheWrite: 0, cost: 0.01 },
		durationMs,
		firstTokenMs,
	});
}

test("renderStats：会话速率只显示当前会话，与天数参数无关", () => {
	const old = new Date(Date.now() - 40 * DAY_MS);
	const session = statsSession(old.getTime(), 600, 12_000, 1_200);

	const text = renderStats([], session, 7).join("\n");
	assert.match(text, /当前会话/);
	assert.match(text, /1 轮 · Out 600 · 平均首字 1\.2s · 平均速率 50t\/s/);
	// 近 7 天没有按天数据，会话区块照样显示自己的平均
	assert.match(text, /Token 用量趋势 \(近 7 天\)/);
	assert.match(text, /（暂无数据）/);

	const dayRows = [
		{ date: localDate(old), model: "deepseek/deepseek-chat", input: 100, output: 600, cacheRead: 900, cacheWrite: 0, cost: 0.01 },
	];
	const all = renderStats(dayRows, session, 0).join("\n");
	assert.match(all, /Tokens per Day \(Input\)/);
	assert.match(all, /1 轮 · Out 600/);
	// 没有会话记录时明说暂无
	assert.match(renderStats(dayRows, undefined, 7).join("\n"), /本会话暂无记录/);
});

test("renderStats：当前会话没测到首字时显示占位", () => {
	const session = statsSession(Date.now(), 100, 1_000);
	const text = renderStats([], session, 7).join("\n");
	assert.match(text, /平均首字 -/);
	assert.match(text, /平均速率 100t\/s/);
});

test("tokenArgumentCompletions：补全保留已写好的参数", () => {
	const values = (prefix: string) => (tokenArgumentCompletions(prefix) ?? []).map((item) => item.value);

	// 空参数：全部候选，没有已删除的 Sessions
	assert.ok(values("").includes("7d"));
	assert.ok(!values("").includes("Sessions"));
	// 单个参数：按前缀过滤
	assert.deepEqual(values("o"), ["Out"]);
	// 多参数：补全项带上前面的参数（pi 补全会整段替换参数文本）
	assert.deepEqual(values("all o"), ["all Out"]);
	assert.deepEqual(values("7d out"), ["7d Out"]);
	// 已写过的参数不再出现在下一条候选里
	assert.ok(!values("all ").includes("all"));
	// 没有候选
	assert.equal(tokenArgumentCompletions("zzz"), null);
});
