/**
 * token-stats 的 SQLite 存储。
 *
 * 一次响应（turn）写三处，同一个事务里完成：
 * - `turn`：原始明细，一轮一行，供以后做更细的查询；
 * - `day_model`：按天 × 模型的累计，柱状图与模型汇总读它；
 * - `session`：按会话的累计，当前会话的平均首字/平均速率读它。
 *
 * `/token rate` 直接聚合 `turn` 的时间窗，不需要额外表。
 *
 * 迁移约束：任何改变表结构或删数据的迁移，必须先备份旧数据库
 * （`VACUUM INTO 'token-stats.db.before-migrate-<timestamp>'`），
 * 迁移失败时从备份恢复。当前版本没有 schema 迁移。
 *
 * 多个 pi 进程共用同一个库：连接开 `busy_timeout`，建库时一次性切到 WAL，
 * 每个 turn 用 `BEGIN IMMEDIATE` 事务，后写的事务排队等前一个提交，不会丢增量。
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { recordSessionTurn, type SessionRecord, type SessionUsageTotals } from "./session-usage.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS day_model (
	date TEXT NOT NULL,
	model TEXT NOT NULL,
	input INTEGER NOT NULL DEFAULT 0,
	output INTEGER NOT NULL DEFAULT 0,
	cache_read INTEGER NOT NULL DEFAULT 0,
	cache_write INTEGER NOT NULL DEFAULT 0,
	cost REAL NOT NULL DEFAULT 0,
	PRIMARY KEY (date, model)
);
CREATE TABLE IF NOT EXISTS session (
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
CREATE INDEX IF NOT EXISTS turn_session ON turn(session_id);
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`;

/** 按天 × 模型的汇总行；input 是不含缓存的输入。 */
export interface DayModelRow {
	date: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/** `/token rate` 的时间窗聚合；速率样本数与首字样本数可能少于 turns。 */
export interface RateRow {
	turns: number;
	timedOutput: number;
	timedMs: number;
	firstTokenMs: number;
	firstTokenSamples: number;
}

/** `/token rate` 的一行：一个模型在时间窗内的聚合；lastAt 用于把最近用过的排前面。 */
export interface RateModelRow extends RateRow {
	model: string;
	lastAt: number;
}

/** 记录一轮响应需要的全部信息。 */
export interface TurnInput {
	/** 本地日期 YYYY-MM-DD，与按天汇总的 key 一致 */
	date: string;
	at: number;
	sessionId: string;
	sessionName?: string;
	provider: string;
	model: string;
	usage: SessionUsageTotals;
	durationMs?: number;
	firstTokenMs?: number;
}

export interface TokenStatsStore {
	recordTurn(turn: TurnInput): void;
	/** from 为空表示全部历史 */
	dayRows(from?: string): DayModelRow[];
	sessionRecord(id: string): SessionRecord | undefined;
	/** 时间窗内按模型分组的速率样本，最近用过的在前；窗口内没有记录时返回空数组 */
	rateRows(since: number): RateModelRow[];
	/** 迁移专用：已存在同日同模型时保留现有值，不重复累加 */
	importDayModel(row: DayModelRow): void;
	/** 迁移专用：已存在同 id 会话时保留现有值 */
	importSession(id: string, record: SessionRecord): void;
	hasMeta(key: string): boolean;
	setMeta(key: string, value: string): void;
	/** 开一个 BEGIN IMMEDIATE 事务；回调抛错则回滚 */
	transaction(fn: () => void): void;
	close(): void;
}

interface SessionRow {
	name: string | null;
	first_active_at: number;
	last_active_at: number;
	turns: number;
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	cost: number;
	timed_output: number;
	timed_ms: number;
	first_token_ms: number;
	first_token_samples: number;
}

interface RateQueryRow {
	model: string;
	last_at: number;
	turns: number;
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
	// busy_timeout 先开，后面所有写事务都靠它排队
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec("PRAGMA synchronous = NORMAL");
	ensureWal(db);
}

function toRecord(row: SessionRow): SessionRecord {
	return {
		...(row.name ? { name: row.name } : {}),
		firstActiveAt: row.first_active_at,
		lastActiveAt: row.last_active_at,
		turns: row.turns,
		usage: {
			input: row.input,
			output: row.output,
			cacheRead: row.cache_read,
			cacheWrite: row.cache_write,
			cost: row.cost,
		},
		timedOutput: row.timed_output,
		timedMs: row.timed_ms,
		firstTokenMs: row.first_token_ms,
		firstTokenSamples: row.first_token_samples,
	};
}

class SqliteStore implements TokenStatsStore {
	private readonly db: DatabaseSync;
	private readonly insertTurn: StatementSync;
	private readonly upsertDayModel: StatementSync;
	private readonly selectDayFrom: StatementSync;
	private readonly selectDayAll: StatementSync;
	private readonly selectSession: StatementSync;
	private readonly selectRates: StatementSync;
	private readonly upsertSession: StatementSync;
	private readonly insertDayIfAbsent: StatementSync;
	private readonly insertSessionIfAbsent: StatementSync;
	private readonly selectMeta: StatementSync;
	private readonly upsertMeta: StatementSync;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		configure(this.db);
		this.db.exec(SCHEMA);

		this.insertTurn = this.db.prepare(
			"INSERT INTO turn(at, session_id, session_name, provider, model, input, output, cache_read, cache_write, cost, duration_ms, first_token_ms) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		this.upsertDayModel = this.db.prepare(
			"INSERT INTO day_model(date, model, input, output, cache_read, cache_write, cost) VALUES (?, ?, ?, ?, ?, ?, ?) " +
				"ON CONFLICT(date, model) DO UPDATE SET " +
				"input = input + excluded.input, output = output + excluded.output, " +
				"cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write, " +
				"cost = cost + excluded.cost",
		);
		this.selectDayFrom = this.db.prepare(
			"SELECT date, model, input, output, cache_read, cache_write, cost FROM day_model WHERE date >= ? ORDER BY date, model",
		);
		this.selectDayAll = this.db.prepare(
			"SELECT date, model, input, output, cache_read, cache_write, cost FROM day_model ORDER BY date, model",
		);
		this.selectSession = this.db.prepare(
			"SELECT name, first_active_at, last_active_at, turns, input, output, cache_read, cache_write, cost, " +
				"timed_output, timed_ms, first_token_ms, first_token_samples FROM session WHERE id = ?",
		);
		this.selectRates = this.db.prepare(
			"SELECT model, MAX(at) AS last_at, COUNT(*) AS turns, " +
				"COALESCE(SUM(CASE WHEN output > 0 AND duration_ms > 0 THEN output ELSE 0 END), 0) AS timed_output, " +
				"COALESCE(SUM(CASE WHEN output > 0 AND duration_ms > 0 THEN duration_ms ELSE 0 END), 0) AS timed_ms, " +
				"COALESCE(SUM(CASE WHEN first_token_ms IS NOT NULL THEN first_token_ms ELSE 0 END), 0) AS first_token_ms, " +
				"COALESCE(SUM(CASE WHEN first_token_ms IS NOT NULL THEN 1 ELSE 0 END), 0) AS first_token_samples " +
				"FROM turn WHERE at >= ? AND model IS NOT NULL GROUP BY model ORDER BY last_at DESC",
		);
		this.upsertSession = this.db.prepare(
			"INSERT INTO session(id, name, first_active_at, last_active_at, turns, input, output, cache_read, cache_write, cost, " +
				"timed_output, timed_ms, first_token_ms, first_token_samples) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
				"ON CONFLICT(id) DO UPDATE SET " +
				"name = excluded.name, first_active_at = excluded.first_active_at, last_active_at = excluded.last_active_at, " +
				"turns = excluded.turns, input = excluded.input, output = excluded.output, " +
				"cache_read = excluded.cache_read, cache_write = excluded.cache_write, cost = excluded.cost, " +
				"timed_output = excluded.timed_output, timed_ms = excluded.timed_ms, " +
				"first_token_ms = excluded.first_token_ms, first_token_samples = excluded.first_token_samples",
		);
		this.insertDayIfAbsent = this.db.prepare(
			"INSERT INTO day_model(date, model, input, output, cache_read, cache_write, cost) VALUES (?, ?, ?, ?, ?, ?, ?) " +
				"ON CONFLICT(date, model) DO NOTHING",
		);
		this.insertSessionIfAbsent = this.db.prepare(
			"INSERT INTO session(id, name, first_active_at, last_active_at, turns, input, output, cache_read, cache_write, cost, " +
				"timed_output, timed_ms, first_token_ms, first_token_samples) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
		);
		this.selectMeta = this.db.prepare("SELECT value FROM meta WHERE key = ?");
		this.upsertMeta = this.db.prepare(
			"INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		);
	}

	recordTurn(turn: TurnInput): void {
		const { usage } = turn;
		this.transaction(() => {
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
			this.upsertDayModel.run(
				turn.date,
				turn.model,
				usage.input,
				usage.output,
				usage.cacheRead,
				usage.cacheWrite,
				usage.cost,
			);
			const next = recordSessionTurn(this.sessionRecord(turn.sessionId), {
				at: turn.at,
				name: turn.sessionName,
				usage,
				durationMs: turn.durationMs,
				firstTokenMs: turn.firstTokenMs,
			});
			this.writeSession(turn.sessionId, next);
		});
	}

	dayRows(from?: string): DayModelRow[] {
		const rows = (from === undefined ? this.selectDayAll.all() : this.selectDayFrom.all(from)) as Array<{
			date: string;
			model: string;
			input: number;
			output: number;
			cache_read: number;
			cache_write: number;
			cost: number;
		}>;
		return rows.map((row) => ({
			date: row.date,
			model: row.model,
			input: row.input,
			output: row.output,
			cacheRead: row.cache_read,
			cacheWrite: row.cache_write,
			cost: row.cost,
		}));
	}

	sessionRecord(id: string): SessionRecord | undefined {
		const row = this.selectSession.get(id) as SessionRow | undefined;
		return row ? toRecord(row) : undefined;
	}

	rateRows(since: number): RateModelRow[] {
		const rows = this.selectRates.all(since) as unknown as RateQueryRow[];
		return rows.map((row) => ({
			model: row.model,
			lastAt: row.last_at,
			turns: row.turns,
			timedOutput: row.timed_output,
			timedMs: row.timed_ms,
			firstTokenMs: row.first_token_ms,
			firstTokenSamples: row.first_token_samples,
		}));
	}

	importDayModel(row: DayModelRow): void {
		this.insertDayIfAbsent.run(row.date, row.model, row.input, row.output, row.cacheRead, row.cacheWrite, row.cost);
	}

	importSession(id: string, record: SessionRecord): void {
		this.insertSessionIfAbsent.run(
			id,
			record.name ?? null,
			record.firstActiveAt,
			record.lastActiveAt,
			record.turns,
			record.usage.input,
			record.usage.output,
			record.usage.cacheRead,
			record.usage.cacheWrite,
			record.usage.cost,
			record.timedOutput,
			record.timedMs,
			record.firstTokenMs,
			record.firstTokenSamples,
		);
	}

	hasMeta(key: string): boolean {
		return this.selectMeta.get(key) !== undefined;
	}

	setMeta(key: string, value: string): void {
		this.upsertMeta.run(key, value);
	}

	transaction(fn: () => void): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			fn();
			this.db.exec("COMMIT");
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				/* 事务可能已经被 SQLite 回滚 */
			}
			throw error;
		}
	}

	close(): void {
		this.db.close();
	}

	private writeSession(id: string, record: SessionRecord): void {
		this.upsertSession.run(
			id,
			record.name ?? null,
			record.firstActiveAt,
			record.lastActiveAt,
			record.turns,
			record.usage.input,
			record.usage.output,
			record.usage.cacheRead,
			record.usage.cacheWrite,
			record.usage.cost,
			record.timedOutput,
			record.timedMs,
			record.firstTokenMs,
			record.firstTokenSamples,
		);
	}
}

/** 打开（必要时建库建表）token-stats 数据库；调用方负责 close。 */
export function openTokenStatsStore(path: string): TokenStatsStore {
	return new SqliteStore(path);
}
