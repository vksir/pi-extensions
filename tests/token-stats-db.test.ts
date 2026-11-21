import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { averageFirstTokenMs, averageOutputRate } from "../extensions/lib/session-usage.ts";
import { openTokenStatsStore, type TurnInput } from "../extensions/lib/token-stats-db.ts";
import { importLegacyCache } from "../extensions/lib/token-stats-legacy.ts";

const DB_URL = new URL("../extensions/lib/token-stats-db.ts", import.meta.url).href;

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-token-stats-db-"));
}

function dbPath(dir: string): string {
	return join(dir, "pi-token-stats", "token-stats.db");
}

function turn(overrides: Partial<TurnInput> = {}): TurnInput {
	return {
		date: "2026-11-18",
		at: 1_000,
		sessionId: "session-1",
		sessionName: "会话一",
		provider: "deepseek",
		model: "deepseek/deepseek-chat",
		usage: { input: 10, output: 100, cacheRead: 900, cacheWrite: 0, cost: 0.01 },
		durationMs: 1_000,
		firstTokenMs: 800,
		...overrides,
	};
}

test("recordTurn：一轮同时写明细、按天汇总与会话汇总", () => {
	const dir = tempDir();
	const store = openTokenStatsStore(dbPath(dir));
	try {
		store.recordTurn(turn());
		store.recordTurn(turn({ date: "2026-11-19", at: 2_000, usage: { input: 20, output: 300, cacheRead: 1800, cacheWrite: 0, cost: 0.02 }, durationMs: 3_000, firstTokenMs: 600 }));

		const rows = store.dayRows();
		assert.equal(rows.length, 2);
		assert.deepEqual(rows[0], {
			date: "2026-11-18",
			model: "deepseek/deepseek-chat",
			input: 10,
			output: 100,
			cacheRead: 900,
			cacheWrite: 0,
			cost: 0.01,
		});
		// 按天过滤：from 为空才是全部
		assert.deepEqual(store.dayRows("2026-11-19").map((row) => row.date), ["2026-11-19"]);

		const session = store.sessionRecord("session-1");
		assert.ok(session);
		assert.equal(session.turns, 2);
		assert.equal(session.usage.output, 400);
		assert.equal(session.timedOutput, 400);
		assert.equal(session.timedMs, 4_000);
		assert.equal(session.firstTokenMs, 1_400);
		assert.equal(session.firstTokenSamples, 2);
		assert.equal(averageOutputRate(session), 100);
		assert.equal(averageFirstTokenMs(session), 700);

		// 速率视图只看 turn 明细的时间窗，不受 day_model 影响
		assert.deepEqual(store.rateRow(0, "deepseek/deepseek-chat"), {
			turns: 2,
			timedOutput: 400,
			timedMs: 4_000,
			firstTokenMs: 1_400,
			firstTokenSamples: 2,
		});
		assert.equal(store.rateRow(0, "missing"), undefined);
		assert.equal(store.latestModel(0), "deepseek/deepseek-chat");
		assert.equal(store.latestModel(2_001), undefined);

		// 原始明细一轮一行
		const raw = new DatabaseSync(dbPath(dir), { readOnly: true });
		try {
			assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM turn").get() as { n: number }).n, 2);
		} finally {
			raw.close();
		}
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("rateRow：没有耗时或没有输出的响应不进速率样本", () => {
	const dir = tempDir();
	const store = openTokenStatsStore(dbPath(dir));
	try {
		store.recordTurn(turn({ at: 1_000, durationMs: undefined, firstTokenMs: undefined }));
		store.recordTurn(
			turn({
				at: 2_000,
				usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
				durationMs: 2_000,
				firstTokenMs: 500,
			}),
		);
		assert.deepEqual(store.rateRow(0, "deepseek/deepseek-chat"), {
			turns: 2,
			timedOutput: 0,
			timedMs: 0,
			firstTokenMs: 500,
			firstTokenSamples: 1,
		});
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("importLegacyCache：v2 旧 JSON 静默导入，重复打开不重复累加", () => {
	const dir = tempDir();
	const legacyPath = join(dir, "token-stats.json");
	const legacyText = JSON.stringify({
		version: 2,
			byDate: {
				"2026-11-18": {
					models: {
						"deepseek/deepseek-chat": { input: 5000, output: 4200, cacheRead: 95000, cacheWrite: 0, cost: 0.09 },
					},
				},
			},
			sessions: {
				"legacy-session": {
					name: "旧会话",
					firstActiveAt: 1_700_000_000_000,
					lastActiveAt: 1_700_000_100_000,
					turns: 4,
					usage: { input: 5000, output: 4200, cacheRead: 95000, cacheWrite: 0, cost: 0.09 },
					timedOutput: 4200,
					timedMs: 120_000,
					firstTokenMs: 3_600,
					firstTokenSamples: 4,
				},
			},
		},
	);
	writeFileSync(legacyPath, legacyText);

	const store = openTokenStatsStore(dbPath(dir));
	try {
		importLegacyCache(store, legacyPath);
		assert.equal(store.hasMeta("legacy_json_imported"), true);
		// 迁移前先备份，旧文件本身保持原样
		assert.equal(readFileSync(`${legacyPath}.bak`, "utf-8"), legacyText);
		assert.equal(readFileSync(legacyPath, "utf-8"), legacyText);
		assert.deepEqual(store.dayRows(), [
			{ date: "2026-11-18", model: "deepseek/deepseek-chat", input: 5000, output: 4200, cacheRead: 95000, cacheWrite: 0, cost: 0.09 },
		]);
		const session = store.sessionRecord("legacy-session");
		assert.ok(session);
		assert.equal(session.name, "旧会话");
		assert.equal(session.turns, 4);
		assert.equal(averageOutputRate(session), 35);
		assert.equal(averageFirstTokenMs(session), 900);

		// 再调一次：meta 已在，不重复累加
		importLegacyCache(store, legacyPath);
		assert.equal(store.dayRows()[0].output, 4200);
	} finally {
		store.close();
	}

	// 换进程（重新开库）也认这个标记
	const reopened = openTokenStatsStore(dbPath(dir));
	try {
		importLegacyCache(reopened, legacyPath);
		assert.equal(reopened.dayRows()[0].output, 4200);
		assert.equal(reopened.sessionRecord("legacy-session")?.turns, 4);
	} finally {
		reopened.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("importLegacyCache：v1 旧 JSON（没有 sessions）只导入按天数据", () => {
	const dir = tempDir();
	const legacyPath = join(dir, "token-stats.json");
	writeFileSync(
		legacyPath,
		JSON.stringify({
			version: 1,
			byDate: {
				"2026-11-17": {
					models: { "deepseek/deepseek-chat": { input: 1000, output: 500, cacheRead: 9000, cacheWrite: 0, cost: 0.02 } },
				},
			},
		}),
	);
	const store = openTokenStatsStore(dbPath(dir));
	try {
		importLegacyCache(store, legacyPath);
		assert.equal(store.dayRows()[0].output, 500);
		assert.equal(store.sessionRecord("legacy-session"), undefined);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

/** 子进程里跑 N 次 recordTurn，制造真实的跨进程写竞争。 */
function recordInChild(path: string, times: number): Promise<void> {
	const script = `
		const { openTokenStatsStore } = await import(${JSON.stringify(DB_URL)});
		const store = openTokenStatsStore(process.env.DB_PATH);
		for (let i = 0; i < ${times}; i += 1) {
			store.recordTurn({
				date: "2026-11-18",
				at: Date.now() + i,
				sessionId: "shared-session",
				sessionName: "并发会话",
				provider: "deepseek",
				model: "deepseek/deepseek-chat",
				usage: { input: 10, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
				durationMs: 1000,
				firstTokenMs: 500,
			});
		}
		store.close();
	`;
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
			env: { ...process.env, DB_PATH: path },
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("exit", (code) =>
			code === 0 ? resolve() : reject(new Error(`child exited with ${code}: ${stderr}`)),
		);
	});
}

test("recordTurn：多个进程同时写同一个库不丢增量", { timeout: 60_000 }, async () => {
	const dir = tempDir();
	const path = dbPath(dir);
	try {
		// 不先建库：让三个进程同时首次打开，顺便验证建表与 WAL 抢占
		await Promise.all([recordInChild(path, 25), recordInChild(path, 25), recordInChild(path, 25)]);

		const store = openTokenStatsStore(path);
		try {
			const rows = store.dayRows();
			assert.equal(rows.length, 1);
			assert.equal(rows[0].output, 7_500);
			const session = store.sessionRecord("shared-session");
			assert.ok(session);
			assert.equal(session.turns, 75);
			assert.equal(session.usage.output, 7_500);
			assert.equal(session.firstTokenSamples, 75);
		} finally {
			store.close();
		}

		const raw = new DatabaseSync(path, { readOnly: true });
		try {
			assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM turn").get() as { n: number }).n, 75);
		} finally {
			raw.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
