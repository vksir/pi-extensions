import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
	const client = openTokenStatsClient({ dbPath: dbPath(dir) });
	try {
		const started = Date.now();
		for (let i = 0; i < 50; i += 1) client.recordTurn(turn(100));
		// 50 次投递应当远快于 50 次 SQLite 插入：主线程只 postMessage
		assert.ok(Date.now() - started < 1_000, `recordTurn 阻塞了 ${Date.now() - started}ms`);

		const rows = await client.windowRows(0);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.turns, 50);
		assert.equal(rows[0]?.output, 5_000);
		assert.equal(rows[0]?.firstTokenSamples, 50);
	} finally {
		await client.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("client：关闭后的写请求静默丢弃，查询报错", async () => {
	const dir = tempDir();
	const client = openTokenStatsClient({ dbPath: dbPath(dir) });
	await client.close();
	assert.doesNotThrow(() => client.recordTurn(turn(100)));
	await assert.rejects(client.windowRows(0), /closed/);
	rmSync(dir, { recursive: true, force: true });
});
