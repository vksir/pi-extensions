import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openTokenStatsClient } from "../extensions/lib/token-stats-client.ts";
import type { TurnInput } from "../extensions/lib/token-stats-db.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-token-stats-client-"));
}

function dbPath(dir: string): string {
	return join(dir, "pi-token-stats", "token-stats.db");
}

function turn(output: number): TurnInput {
	return {
		date: "2026-11-18",
		at: Date.now(),
		sessionId: "session-1",
		sessionName: "会话一",
		provider: "deepseek",
		model: "deepseek/deepseek-chat",
		usage: { input: 10, output, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
		durationMs: 1_000,
		firstTokenMs: 500,
	};
}

test("client：写请求立即返回，查询按投递顺序看到已提交数据", async () => {
	const dir = tempDir();
	const client = openTokenStatsClient({ dbPath: dbPath(dir), legacyPath: join(dir, "token-stats.json") });
	try {
		const started = Date.now();
		for (let i = 0; i < 50; i += 1) client.recordTurn(turn(100));
		// 50 次投递应当远快于 50 次 SQLite 事务：主线程只 postMessage
		assert.ok(Date.now() - started < 1_000, `recordTurn 阻塞了 ${Date.now() - started}ms`);

		const rows = await client.dayRows();
		assert.equal(rows.length, 1);
		assert.equal(rows[0].output, 5_000);
		const session = await client.sessionRecord("session-1");
		assert.ok(session);
		assert.equal(session.turns, 50);
		assert.equal(session.firstTokenSamples, 50);
		// 速率按模型分组：一个模型一行，lastAt 取时间窗内最近一次响应
		const [rate] = await client.rateRows(0);
		assert.ok(rate);
		assert.equal(rate.model, "deepseek/deepseek-chat");
		assert.ok(rate.lastAt >= started);
		assert.equal(rate.turns, 50);
		assert.equal(rate.timedOutput, 5_000);
		assert.equal(rate.timedMs, 50_000);
		assert.equal(rate.firstTokenMs, 25_000);
		assert.equal(rate.firstTokenSamples, 50);
	} finally {
		await client.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("client：worker 里跑静默迁移，旧 JSON 先备份且保持原样", async () => {
	const dir = tempDir();
	const legacyPath = join(dir, "token-stats.json");
	const legacyText = JSON.stringify({
		version: 2,
		byDate: {
			"2026-11-18": {
				models: { "deepseek/deepseek-chat": { input: 100, output: 123, cacheRead: 900, cacheWrite: 0, cost: 0.01 } },
			},
		},
		sessions: {},
	});
	writeFileSync(legacyPath, legacyText);

	const client = openTokenStatsClient({ dbPath: dbPath(dir), legacyPath });
	try {
		const rows = await client.dayRows();
		assert.equal(rows.length, 1);
		assert.equal(rows[0].output, 123);
		// 迁移前先备份，旧文件本身不改写
		assert.ok(existsSync(`${legacyPath}.bak`));
		assert.equal(readFileSync(`${legacyPath}.bak`, "utf-8"), legacyText);
		assert.equal(readFileSync(legacyPath, "utf-8"), legacyText);
	} finally {
		await client.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("client：关闭后的写请求静默丢弃，查询报错", async () => {
	const dir = tempDir();
	const client = openTokenStatsClient({ dbPath: dbPath(dir), legacyPath: join(dir, "token-stats.json") });
	await client.close();
	assert.doesNotThrow(() => client.recordTurn(turn(100)));
	await assert.rejects(client.dayRows(), /closed/);
	await assert.rejects(client.rateRows(0), /closed/);
	rmSync(dir, { recursive: true, force: true });
});
