/**
 * cron 表达式与间隔的纯计算：解析、求下一次触发、间隔 → cron。
 *
 * 这一层不读进程状态、不碰 TUI，供扩展的调度器、命令与工具共用。
 */

// ─── cron 表达式 ───

/** 各字段的取值范围：分、时、日、月、周（0=周日，7 亦接受为周日） */
const FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 6],
];

export interface CronFields {
	minute: number[];
	hour: number[];
	dayOfMonth: number[];
	month: number[];
	dayOfWeek: number[];
}

/** 展开单个字段：支持 `*`、`*​/N`、`N`、`N-M`、`N-M/S`、逗号列表。非法返回 null */
export function expandField(field: string, min: number, max: number): number[] | null {
	const isDow = min === 0 && max === 6;
	const limit = isDow ? 7 : max;
	const out = new Set<number>();

	for (const part of field.split(",")) {
		if (part === "") return null;

		const star = part.match(/^\*(?:\/(\d+))?$/);
		if (star) {
			const step = star[1] ? Number(star[1]) : 1;
			if (step < 1) return null;
			for (let i = min; i <= max; i += step) out.add(i);
			continue;
		}

		const range = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
		if (range) {
			const lo = Number(range[1]);
			const hi = Number(range[2]);
			const step = range[3] ? Number(range[3]) : 1;
			if (step < 1 || lo > hi || lo < min || hi > limit) return null;
			for (let i = lo; i <= hi; i += step) out.add(isDow && i === 7 ? 0 : i);
			continue;
		}

		const single = part.match(/^\d+$/);
		if (single) {
			let n = Number(part);
			if (isDow && n === 7) n = 0;
			if (n < min || n > max) return null;
			out.add(n);
			continue;
		}

		return null;
	}

	return out.size === 0 ? null : [...out].sort((a, b) => a - b);
}

export function parseCron(expr: string): CronFields | null {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return null;

	const expanded: number[][] = [];
	for (let i = 0; i < 5; i++) {
		const [min, max] = FIELD_RANGES[i]!;
		const values = expandField(parts[i]!, min, max);
		if (!values) return null;
		expanded.push(values);
	}

	return {
		minute: expanded[0]!,
		hour: expanded[1]!,
		dayOfMonth: expanded[2]!,
		month: expanded[3]!,
		dayOfWeek: expanded[4]!,
	};
}

/**
 * 求严格晚于 `from` 的下一个匹配时刻，按本地时区解释。
 * 标准 cron 语义：日与周同时受限（都不为全范围）时取 OR。
 * 逐分钟前进，靠「跳月/跳日/跳时」剪枝；366 天内无匹配返回 null。
 */
export function nextCronRun(fields: CronFields, from: Date): Date | null {
	const minutes = new Set(fields.minute);
	const hours = new Set(fields.hour);
	const days = new Set(fields.dayOfMonth);
	const months = new Set(fields.month);
	const dows = new Set(fields.dayOfWeek);

	const domWild = fields.dayOfMonth.length === 31;
	const dowWild = fields.dayOfWeek.length === 7;

	const t = new Date(from.getTime());
	t.setSeconds(0, 0);
	t.setMinutes(t.getMinutes() + 1);

	const maxIter = 366 * 24 * 60;
	for (let i = 0; i < maxIter; i++) {
		if (!months.has(t.getMonth() + 1)) {
			t.setMonth(t.getMonth() + 1, 1);
			t.setHours(0, 0, 0, 0);
			continue;
		}

		const dayMatches = domWild
			? dowWild || dows.has(t.getDay())
			: dowWild
				? days.has(t.getDate())
				: days.has(t.getDate()) || dows.has(t.getDay());
		if (!dayMatches) {
			t.setDate(t.getDate() + 1);
			t.setHours(0, 0, 0, 0);
			continue;
		}

		if (!hours.has(t.getHours())) {
			t.setHours(t.getHours() + 1, 0, 0, 0);
			continue;
		}

		if (!minutes.has(t.getMinutes())) {
			t.setMinutes(t.getMinutes() + 1);
			continue;
		}

		return t;
	}

	return null;
}

// ─── 间隔 → cron ───

const MINUTE_MS = 60_000;
const UNIT_MS: Record<string, number> = { s: 1_000, m: MINUTE_MS, h: 3_600_000, d: 86_400_000 };

/** 解析 `5m` / `2h` / `1d` / `30s` / 复合 `1h30m`，返回毫秒；非法返回 null */
export function parseInterval(text: string): number | null {
	const flat = text.trim().toLowerCase();
	if (!/^(?:\d+[smhd])+$/.test(flat)) return null;
	let ms = 0;
	for (const part of flat.matchAll(/(\d+)([smhd])/g)) {
		ms += Number(part[1]) * UNIT_MS[part[2]!]!;
	}
	return ms > 0 ? ms : null;
}

export interface CronConversion {
	cron: string;
	/** 间隔无法被 cron 精确表达时的取整说明 */
	note?: string;
}

/**
 * 间隔 → 循环 cron 表达式。cron 最小粒度是分钟，秒级向上取整；
 * 无法精确表达时取最近的干净粒度并在 note 里回报（对应 GLOSSARY.md 的「规范化」）。
 */
export function intervalToCron(ms: number): CronConversion {
	const minutes = Math.max(1, Math.ceil(ms / MINUTE_MS));
	if (minutes <= 59) {
		return {
			cron: `*/${minutes} * * * *`,
			note: minutes * MINUTE_MS !== ms ? "不足 1 分钟，已按每分钟计" : undefined,
		};
	}

	const hours = minutes / 60;
	if (hours < 24) {
		const h = Math.max(1, Math.round(hours));
		return { cron: `0 */${h} * * *`, note: h * 60 !== minutes ? `已取整为 ${h} 小时` : undefined };
	}

	const days = hours / 24;
	if (days <= 31) {
		const d = Math.max(1, Math.round(days));
		return { cron: `0 0 */${d} * *`, note: d * 24 !== hours ? `已取整为 ${d} 天` : undefined };
	}

	const months = Math.max(1, Math.round(days / 30));
	return { cron: `0 0 1 */${months} *`, note: `已取整为每 ${months} 个月` };
}

/** `once`：把「从现在起 <间隔> 之后」换算成一次性 cron 表达式（本地时区） */
export function oneShotCron(ms: number, from: Date): { cron: string; at: Date } {
	const at = new Date(from.getTime() + ms);
	at.setSeconds(0, 0);
	if (at.getTime() <= from.getTime()) at.setMinutes(at.getMinutes() + 1);
	return { cron: `${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *`, at };
}
