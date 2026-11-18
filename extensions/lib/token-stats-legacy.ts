/**
 * 临时：把旧版 `token-stats.json` 静默导入 SQLite。
 *
 * 下个版本删除本文件，以及 `pi-token-stats.ts` 里 import 与调用 `importLegacyCache` 的那几行。
 * 迁移只在数据库第一次打开时跑一次：`meta.legacy_json_imported` 已存在就跳过；
 * 旧 JSON 保持原样，不删除也不改写。整个过程不提示、不报错——失败就下次启动再试。
 */

import { existsSync, readFileSync } from "node:fs";
import type { SessionRecord } from "./session-usage.ts";
import type { TokenStatsStore } from "./token-stats-db.ts";

const LEGACY_IMPORTED_KEY = "legacy_json_imported";

interface LegacyUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
}

interface LegacyDay {
	models?: Record<string, LegacyUsage>;
}

interface LegacySession extends LegacyUsage {
	name?: string;
	firstActiveAt?: number;
	lastActiveAt?: number;
	turns?: number;
	timedOutput?: number;
	timedMs?: number;
	firstTokenMs?: number;
	firstTokenSamples?: number;
}

interface LegacyCache {
	byDate?: Record<string, LegacyDay>;
	sessions?: Record<string, LegacySession>;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeSession(raw: LegacySession): SessionRecord {
	// 老文件没有会话段时不会走到这里；字段缺失按 0 处理，时间缺失按迁移时刻算
	const lastActiveAt = count(raw.lastActiveAt) || Date.now();
	return {
		...(raw.name?.trim() ? { name: raw.name.trim() } : {}),
		firstActiveAt: count(raw.firstActiveAt) || lastActiveAt,
		lastActiveAt,
		turns: count(raw.turns),
		usage: {
			input: count(raw.input),
			output: count(raw.output),
			cacheRead: count(raw.cacheRead),
			cacheWrite: count(raw.cacheWrite),
			cost: count(raw.cost),
		},
		timedOutput: count(raw.timedOutput),
		timedMs: count(raw.timedMs),
		firstTokenMs: count(raw.firstTokenMs),
		firstTokenSamples: count(raw.firstTokenSamples),
	};
}

/**
 * 把旧 JSON 的按天汇总与会话汇总搬进 SQLite，并打上已迁移标记。
 * 在事务内再查一次标记：多个进程同时首次打开时，只有先拿到写锁的那个会真正导入。
 */
export function importLegacyCache(store: TokenStatsStore, legacyPath: string): void {
	if (store.hasMeta(LEGACY_IMPORTED_KEY) || !existsSync(legacyPath)) return;
	let legacy: LegacyCache;
	try {
		legacy = JSON.parse(readFileSync(legacyPath, "utf-8")) as LegacyCache;
	} catch {
		return;
	}
	try {
		store.transaction(() => {
			if (store.hasMeta(LEGACY_IMPORTED_KEY)) return;
			for (const [date, day] of Object.entries(legacy.byDate ?? {})) {
				for (const [model, usage] of Object.entries(day.models ?? {})) {
					store.importDayModel({
						date,
						model,
						input: count(usage.input),
						output: count(usage.output),
						cacheRead: count(usage.cacheRead),
						cacheWrite: count(usage.cacheWrite),
						cost: count(usage.cost),
					});
				}
			}
			for (const [id, raw] of Object.entries(legacy.sessions ?? {})) {
				store.importSession(id, normalizeSession(raw));
			}
			store.setMeta(LEGACY_IMPORTED_KEY, "1");
		});
	} catch {
		/* 静默：迁移失败不影响新数据，下次打开数据库再试 */
	}
}
