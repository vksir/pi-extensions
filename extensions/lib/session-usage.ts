/**
 * 会话粒度的用量与耗时聚合。
 *
 * token-stats 在 `turn_end` 把每次 assistant 响应记进所属会话；`/token` 报告据此算出
 * 每个会话的平均首字与平均输出速率。全是纯函数，聚合口径可以脱离 pi 运行时单测。
 *
 * 两个平均都带样本口径：
 * - 平均输出速率 = 有耗时的响应输出 token 之和 ÷ 这些响应的耗时之和。按 token 加权，
 *   不是逐次速率的算术平均：短响应里排一次队就能把算术平均拉垮，加权更接近真实吞吐。
 * - 平均首字 = 测到首字的响应之和 ÷ 样本数。首字只能在流式过程中测，续聊、重启、
 *   老会话里的响应没有样本，因此样本数可能少于响应数。
 */

/** 一次响应的用量；与 token-stats 的按模型聚合同形。 */
export interface SessionUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/** 一个会话的累计记录，存在 SQLite 的 `session` 表里。 */
export interface SessionRecord {
	/** 会话名；改过名就跟着最近一次响应更新，没名字时缺省 */
	name?: string;
	/** 第一次与最近一次记录的时刻（epoch ms） */
	firstActiveAt: number;
	lastActiveAt: number;
	/** 记录到的 assistant 响应数 */
	turns: number;
	usage: SessionUsageTotals;
	/** 有耗时的响应的输出之和与耗时之和（ms），平均速率由此算出 */
	timedOutput: number;
	timedMs: number;
	/** 测到首字的样本之和（ms）与样本数 */
	firstTokenMs: number;
	firstTokenSamples: number;
}

/** 并入会话记录的一次响应。 */
export interface SessionTurn {
	/** 记录时刻（epoch ms） */
	at: number;
	name?: string;
	usage: SessionUsageTotals;
	/** 响应耗时；没有耗时（老会话、异常中断）时不进速率样本 */
	durationMs?: number;
	/** 该次响应测到的首字时间；没测到时不计入样本 */
	firstTokenMs?: number;
}

function zeroUsage(): SessionUsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsage(target: SessionUsageTotals, usage: SessionUsageTotals): SessionUsageTotals {
	return {
		input: target.input + usage.input,
		output: target.output + usage.output,
		cacheRead: target.cacheRead + usage.cacheRead,
		cacheWrite: target.cacheWrite + usage.cacheWrite,
		cost: target.cost + usage.cost,
	};
}

/** 把一次 assistant 响应并入会话记录；首次见到的会话传 undefined。 */
export function recordSessionTurn(previous: SessionRecord | undefined, turn: SessionTurn): SessionRecord {
	const base: SessionRecord = previous ?? {
		firstActiveAt: turn.at,
		lastActiveAt: turn.at,
		turns: 0,
		usage: zeroUsage(),
		timedOutput: 0,
		timedMs: 0,
		firstTokenMs: 0,
		firstTokenSamples: 0,
	};
	const name = turn.name?.trim() || base.name;
	// 与 footer 的「最近一次速率」同口径：有耗时、有输出才算样本。
	const timed = turn.usage.output > 0 && (turn.durationMs ?? 0) > 0;
	return {
		...(name ? { name } : {}),
		firstActiveAt: base.firstActiveAt,
		lastActiveAt: turn.at,
		turns: base.turns + 1,
		usage: addUsage(base.usage, turn.usage),
		timedOutput: base.timedOutput + (timed ? turn.usage.output : 0),
		timedMs: base.timedMs + (timed ? (turn.durationMs ?? 0) : 0),
		firstTokenMs: base.firstTokenMs + (turn.firstTokenMs ?? 0),
		firstTokenSamples: base.firstTokenSamples + (turn.firstTokenMs === undefined ? 0 : 1),
	};
}

/** 会话的平均输出速率（token/秒）；没有带耗时的响应时返回 undefined。 */
export function averageOutputRate(record: SessionRecord): number | undefined {
	if (record.timedMs <= 0) return undefined;
	return record.timedOutput / (record.timedMs / 1000);
}

/** 会话的平均首字时间（ms）；本进程没测到过首字时返回 undefined。 */
export function averageFirstTokenMs(record: SessionRecord): number | undefined {
	if (record.firstTokenSamples <= 0) return undefined;
	return record.firstTokenMs / record.firstTokenSamples;
}
