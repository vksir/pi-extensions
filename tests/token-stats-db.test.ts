import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openTokenStatsStore, type TurnInput } from "../extensions/lib/token-stats-db.ts";

const DB_URL = new URL("../extensions/lib/token-stats-db.ts", import.meta.url).href;

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-token-stats-db-"));
}

function dbPath(dir: string): string {
	return join(dir, "pi-token-stats", "token-stats.db");
}

function turn(overrides: Partial<TurnInput> = {}): TurnInput {
	return {
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

test("recordTurn：明细落库，windowRow 只聚合指定模型并按窗口过滤", () => {
	const dir = tempDir();
	const store = openTokenStatsStore(dbPath(dir));
	try {
		store.recordTurn(turn());
		store.recordTurn(
			turn({
				at: 2_000,
				usage: { input: 20, output: 300, cacheRead: 1800, cacheWrite: 0, cost: 0.02 },
				durationMs: 3_000,
				firstTokenMs: 600,
			}),
		);
		store.recordTurn(
			turn({
				at: 3_000,
				provider: "openai",
				model: "openai/gpt-5",
				usage: { input: 10, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
				durationMs: 2_000,
				firstTokenMs: 400,
			}),
		);

		assert.deepEqual(store.windowRow(0, "deepseek/deepseek-chat"), {
			provider: "deepseek",
			model: "deepseek/deepseek-chat",
			turns: 2,
			output: 400,
			timedOutput: 400,
			timedMs: 4_000,
			firstTokenMs: 1_400,
			firstTokenSamples: 2,
		});
		assert.equal(store.windowRow(0, "openai/gpt-5")?.output, 200);
		// 只返回指定模型，其他模型不会混进来
		assert.equal(store.windowRow(0, "missing"), undefined);

		// 含窗口起点，排除更早的
		assert.equal(store.windowRow(2_000, "deepseek/deepseek-chat")?.turns, 1);
		assert.equal(store.windowRow(2_001, "deepseek/deepseek-chat"), undefined);

		// 最近一次响应用的模型，供拿不到 ctx.model 时退回
		assert.equal(store.latestModel(0), "openai/gpt-5");
		assert.equal(store.latestModel(3_001), undefined);

		// 原始明细一轮一行
		const raw = new DatabaseSync(dbPath(dir), { readOnly: true });
		try {
			assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM turn").get() as { n: number }).n, 3);
		} finally {
			raw.close();
		}
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("recordTurn：没有耗时或没有输出的响应不进速率样本", () => {
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
		const row = store.windowRow(0, "deepseek/deepseek-chat");
		assert.ok(row);
		assert.equal(row.turns, 2);
		assert.equal(row.output, 100);
		assert.equal(row.timedOutput, 0);
		assert.equal(row.timedMs, 0);
		assert.equal(row.firstTokenSamples, 1);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

/** v1 的旧 schema：带 day_model / session 两张汇总表与 turn_session 索引。 */
const V1_SCHEMA = `
CREATE TABLE day_model (
	date TEXT NOT NULL,
	model TEXT NOT NULL,
	input INTEGER NOT NULL DEFAULT 0,
	output INTEGER NOT NULL DEFAULT 0,
	cache_read INTEGER NOT NULL DEFAULT 0,
	cache_write INTEGER NOT NULL DEFAULT 0,
	cost REAL NOT NULL DEFAULT 0,
	PRIMARY KEY (date, model)
);
CREATE TABLE session (
	id TEXT PRIMARY KEY,
	name TEXT,
	first_active_at INTEGER NOT NULL,
	last_active_at INTEGER NOT NULL,
	turns INTEGER NOT NULL,
	input INTEGER NOT NULL DEFAULT 0,
	output INTEGER NOT NULL DEFAULT 0,
	cache_read INTEGER NOT NULL DEFAULT 0,
	cache_write INTEGER NOT NULL DEFAULT 0,
	cost REAL NOT NULL DEFAULT 0,
	timed_output INTEGER NOT NULL DEFAULT 0,
	timed_ms INTEGER NOT NULL DEFAULT 0,
	first_token_ms INTEGER NOT NULL DEFAULT 0,
	first_token_samples INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE turn (
	id INTEGER PRIMARY KEY,
	at INTEGER NOT NULL,
	session_id TEXT NOT NULL,
	session_name TEXT,
	provider TEXT,
	model TEXT,
	input INTEGER NOT NULL DEFAULT 0,
	output INTEGER NOT NULL DEFAULT 0,
	cache_read INTEGER NOT NULL DEFAULT 0,
	cache_write INTEGER NOT NULL DEFAULT 0,
	cost REAL NOT NULL DEFAULT 0,
	duration_ms INTEGER,
	first_token_ms INTEGER
);
CREATE INDEX turn_at ON turn(at);
CREATE INDEX turn_session ON turn(session_id);
CREATE TABLE meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`;

function tableNames(path: string): string[] {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
			name: string;
		}>).map((row) => row.name);
	} finally {
		db.close();
	}
}

function metaValue(path: string, key: string): string | undefined {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
	} finally {
		db.close();
	}
}

test("migrate：v1 的 day_model / session 直接删除，turn 明细保留", () => {
	const dir = tempDir();
	const path = dbPath(dir);
	mkdirSync(join(dir, "pi-token-stats"), { recursive: true });
	const v1 = new DatabaseSync(path);
	try {
		v1.exec(V1_SCHEMA);
		v1.prepare("INSERT INTO day_model(date, model, output) VALUES (?, ?, ?)").run("2026-11-18", "deepseek/deepseek-chat", 4_200);
		v1.prepare(
			"INSERT INTO session(id, first_active_at, last_active_at, turns, output) VALUES (?, ?, ?, ?, ?)",
		).run("legacy", 1, 2, 4, 4_200);
		v1.prepare(
			"INSERT INTO turn(at, session_id, provider, model, output, duration_ms, first_token_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(5_000, "legacy", "deepseek", "deepseek/deepseek-chat", 700, 2_000, 500);
		v1.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run("legacy_json_imported", "1");
	} finally {
		v1.close();
	}

	const store = openTokenStatsStore(path);
	try {
		const row = store.windowRow(0, "deepseek/deepseek-chat");
		assert.equal(row?.output, 700);
		assert.equal(row?.timedMs, 2_000);
		assert.equal(row?.firstTokenSamples, 1);
	} finally {
		store.close();
	}

	assert.deepEqual(tableNames(path), ["meta", "turn"]);
	assert.equal(metaValue(path, "schema_version"), "3");
	// 旧 JSON 导入标记随导入代码一起删除
	assert.equal(metaValue(path, "legacy_json_imported"), undefined);

	// 再次打开不重复迁移，明细照常可查
	const reopened = openTokenStatsStore(path);
	try {
		assert.equal(reopened.windowRow(0, "deepseek/deepseek-chat")?.turns, 1);
	} finally {
		reopened.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("migrate：v2 的 archive 表也直接删除", () => {
	const dir = tempDir();
	const path = dbPath(dir);
	mkdirSync(join(dir, "pi-token-stats"), { recursive: true });
	const v2 = new DatabaseSync(path);
	try {
		v2.exec(`
			CREATE TABLE turn (
				id INTEGER PRIMARY KEY,
				at INTEGER NOT NULL,
				session_id TEXT NOT NULL,
				session_name TEXT,
				provider TEXT,
				model TEXT,
				input INTEGER NOT NULL DEFAULT 0,
				output INTEGER NOT NULL DEFAULT 0,
				cache_read INTEGER NOT NULL DEFAULT 0,
				cache_write INTEGER NOT NULL DEFAULT 0,
				cost REAL NOT NULL DEFAULT 0,
				duration_ms INTEGER,
				first_token_ms INTEGER
			);
			CREATE INDEX turn_at ON turn(at);
			CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE archive_day_model (date TEXT, model TEXT, output INTEGER);
			CREATE TABLE archive_session (id TEXT, turns INTEGER);
		`);
		v2.prepare("INSERT INTO turn(at, session_id, provider, model, output, duration_ms, first_token_ms) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
			5_000,
			"legacy",
			"deepseek",
			"deepseek/deepseek-chat",
			700,
			2_000,
			500,
		);
		v2.prepare("INSERT INTO archive_day_model(date, model, output) VALUES (?, ?, ?)").run("2026-11-18", "deepseek/deepseek-chat", 4_200);
		v2.prepare("INSERT INTO archive_session(id, turns) VALUES (?, ?)").run("legacy", 4);
		v2.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run("schema_version", "2");
		v2.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run("legacy_json_imported", "1");
	} finally {
		v2.close();
	}

	const store = openTokenStatsStore(path);
	try {
		assert.equal(store.windowRow(0, "deepseek/deepseek-chat")?.output, 700);
	} finally {
		store.close();
	}

	assert.deepEqual(tableNames(path), ["meta", "turn"]);
	assert.equal(metaValue(path, "schema_version"), "3");
	assert.equal(metaValue(path, "legacy_json_imported"), undefined);
	rmSync(dir, { recursive: true, force: true });
});

/** 子进程里跑 N 次 recordTurn，制造真实的跨进程写竞争。 */
function recordInChild(path: string, times: number): Promise<void> {
	const script = `
		const { openTokenStatsStore } = await import(${JSON.stringify(DB_URL)});
		const store = openTokenStatsStore(process.env.DB_PATH);
		for (let i = 0; i < ${times}; i += 1) {
			store.recordTurn({
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
			const row = store.windowRow(0, "deepseek/deepseek-chat");
			assert.equal(row?.turns, 75);
			assert.equal(row?.output, 7_500);
			assert.equal(row?.timedMs, 75_000);
			assert.equal(row?.firstTokenSamples, 75);
			assert.equal(store.latestModel(0), "deepseek/deepseek-chat");
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
