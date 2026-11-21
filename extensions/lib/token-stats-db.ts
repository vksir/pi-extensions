/**
 * token-stats 的 SQLite 存储。
 *
 * 只保留 `turn` 明细：一轮 assistant 响应一行，带时间、模型、用量、耗时与首字。
 * `/token` 的时间窗汇总（过去 1 小时等）直接聚合它，不再维护按天/按会话的汇总表：
 * 滚动窗口的边界不固定，预聚合反而会失真。
 *
 * 多个 pi 进程共用同一个库：连接开 `busy_timeout`，建库时一次性切到 WAL，
 * 每轮一条 INSERT，后写的语句排队等前一个提交，不会丢增量。
 *
 * 旧版的 `day_model` / `session` 汇总（以及 v2 一度改名保留的 archive 表）在
 * schema v3 迁移时直接删除，只留 `turn` 明细。版本记在 `meta.schema_version`。
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

const SCHEMA_VERSION = 3;
const SCHEMA_VERSION_KEY = "schema_version";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS turn (
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
CREATE INDEX IF NOT EXISTS turn_at ON turn(at);
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`;

/** 一轮响应的用量；与 pi 的 usage 同形。 */
export interface TurnUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/** 记录一轮响应需要的全部信息。 */
export interface TurnInput {
	/** 本轮结束时刻（epoch ms），时间窗按它切 */
	at: number;
	sessionId: string;
	sessionName?: string;
	provider: string;
	model: string;
	usage: TurnUsage;
	durationMs?: number;
	firstTokenMs?: number;
}

/** 时间窗内单个模型的聚合；速率样本与首字样本可以少于响应数。 */
export interface WindowModelRow {
	provider: string;
	model: string;
	/** 窗口内的响应数（含没有计时样本的响应） */
	turns: number;
	/** 窗口内的输出 token 总数 */
	output: number;
	/** 有耗时的响应的输出之和与耗时之和（ms），平均速率由两者相除得到 */
	timedOutput: number;
	timedMs: number;
	/** 测到首字的样本之和（ms）与样本数 */
	firstTokenMs: number;
	firstTokenSamples: number;
}

export interface TokenStatsStore {
	recordTurn(turn: TurnInput): void;
	/** 时间窗内单个模型的一行；该模型没有记录时返回 undefined */
	windowRow(since: number, model: string): WindowModelRow | undefined;
	/** 时间窗内最近一次响应用的模型名；没有记录时返回 undefined */
	latestModel(since: number): string | undefined;
	close(): void;
}

interface WindowRow {
	provider: string | null;
	model: string | null;
	turns: number;
	output: number;
	timed_output: number;
	timed_ms: number;
	first_token_ms: number;
	first_token_samples: number;
}

/** 同步睡眠：建库抢 WAL 时用，等待很短，不值得为它上异步。 */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sqliteErrorCode(error: unknown): number | undefined {
	const code = (error as { errcode?: unknown }).errcode;
	return typeof code === "number" ? code : undefined;
}

/** 锁冲突：SQLITE_BUSY(5) / SQLITE_LOCKED(6)。 */
function isLocked(error: unknown): boolean {
	const code = sqliteErrorCode(error);
	return code === 5 || code === 6;
}

/**
 * WAL 模式写在库头里、只需要成功设置一次；但多个进程同时首次打开时，
 * 这个 PRAGMA 要短暂独占，`busy_timeout` 并不总对它生效，所以自己重试。
 * 始终抢不到就退回默认日志模式：慢一些，但功能不受影响。
 */
function ensureWal(db: DatabaseSync): void {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
			if (row?.journal_mode === "wal") return;
			db.exec("PRAGMA journal_mode = WAL");
			return;
		} catch (error) {
			if (!isLocked(error)) return;
			sleepSync(50);
		}
	}
}

function configure(db: DatabaseSync): void {
	// busy_timeout 先开，后面所有写语句都靠它排队
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec("PRAGMA synchronous = NORMAL");
	ensureWal(db);
}

function readSchemaVersion(db: DatabaseSync): number {
	const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(SCHEMA_VERSION_KEY) as
		| { value: string }
		| undefined;
	const version = row ? Number(row.value) : 0;
	return Number.isFinite(version) ? version : 0;
}

function writeSchemaVersion(db: DatabaseSync): void {
	db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
		SCHEMA_VERSION_KEY,
		String(SCHEMA_VERSION),
	);
}

/**
 * v1/v2 → v3：旧汇总表与 v2 的归档表都不再保留，直接删除；只留 `turn` 明细。
 * 版本号在事务内复查，多个进程同时首次打开时只有先拿到写锁的那个会真正迁移。
 */
function migrate(db: DatabaseSync): void {
	db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	if (readSchemaVersion(db) >= SCHEMA_VERSION) return;
	db.exec("BEGIN IMMEDIATE");
	try {
		if (readSchemaVersion(db) < SCHEMA_VERSION) {
			db.exec(`
				DROP TABLE IF EXISTS day_model;
				DROP TABLE IF EXISTS session;
				DROP TABLE IF EXISTS archive_day_model;
				DROP TABLE IF EXISTS archive_session;
			`);
			db.exec(SCHEMA);
			// v1 为按会话查明细建过索引；现在只按时间窗查
			db.exec("DROP INDEX IF EXISTS turn_session");
			// 旧 JSON 导入标记随导入代码一起删除
			db.exec("DELETE FROM meta WHERE key = 'legacy_json_imported'");
			writeSchemaVersion(db);
		}
		db.exec("COMMIT");
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			/* 事务可能已经被 SQLite 回滚 */
		}
		throw error;
	}
}

class SqliteStore implements TokenStatsStore {
	private readonly db: DatabaseSync;
	private readonly insertTurn: StatementSync;
	private readonly selectModelWindow: StatementSync;
	private readonly selectLatestModel: StatementSync;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		configure(this.db);
		migrate(this.db);

		this.insertTurn = this.db.prepare(
			"INSERT INTO turn(at, session_id, session_name, provider, model, input, output, cache_read, cache_write, cost, duration_ms, first_token_ms) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		this.selectModelWindow = this.db.prepare(
			"SELECT COALESCE(provider, '') AS provider, COALESCE(model, 'unknown') AS model, COUNT(*) AS turns, " +
				"COALESCE(SUM(output), 0) AS output, " +
				"COALESCE(SUM(CASE WHEN output > 0 AND duration_ms > 0 THEN output ELSE 0 END), 0) AS timed_output, " +
				"COALESCE(SUM(CASE WHEN output > 0 AND duration_ms > 0 THEN duration_ms ELSE 0 END), 0) AS timed_ms, " +
				"COALESCE(SUM(CASE WHEN first_token_ms IS NOT NULL THEN first_token_ms ELSE 0 END), 0) AS first_token_ms, " +
				"COALESCE(SUM(CASE WHEN first_token_ms IS NOT NULL THEN 1 ELSE 0 END), 0) AS first_token_samples " +
				"FROM turn WHERE at >= ? AND model = ?",
		);
		this.selectLatestModel = this.db.prepare(
			"SELECT model FROM turn WHERE model IS NOT NULL AND at >= ? ORDER BY at DESC, id DESC LIMIT 1",
		);
	}

	recordTurn(turn: TurnInput): void {
		const { usage } = turn;
		// 单条 INSERT 本身就是原子的；多进程并发写靠 busy_timeout 排队。
		this.insertTurn.run(
			turn.at,
			turn.sessionId,
			turn.sessionName ?? null,
			turn.provider,
			turn.model,
			usage.input,
			usage.output,
			usage.cacheRead,
			usage.cacheWrite,
			usage.cost,
			turn.durationMs ?? null,
			turn.firstTokenMs ?? null,
		);
	}

	windowRow(since: number, model: string): WindowModelRow | undefined {
		const row = this.selectModelWindow.get(since, model) as unknown as WindowRow;
		if (row.turns === 0) return undefined;
		return {
			provider: row.provider ?? "",
			model: row.model ?? "unknown",
			turns: row.turns,
			output: row.output,
			timedOutput: row.timed_output,
			timedMs: row.timed_ms,
			firstTokenMs: row.first_token_ms,
			firstTokenSamples: row.first_token_samples,
		};
	}

	latestModel(since: number): string | undefined {
		const row = this.selectLatestModel.get(since) as { model: string } | undefined;
		return row?.model ?? undefined;
	}

	close(): void {
		this.db.close();
	}
}

/** 打开（必要时建库、迁移）token-stats 数据库；调用方负责 close。 */
export function openTokenStatsStore(path: string): TokenStatsStore {
	return new SqliteStore(path);
}
