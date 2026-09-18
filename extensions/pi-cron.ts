/**
 * pi-cron —— 进程级 cron job
 *
 * 两个入口：
 *   /cron <间隔> [once] <prompt> | /cron list | /cron delete [id]   人工，间隔由代码解析
 *   cron(action: create | list | delete)                            模型，自行构造 cron 表达式
 *
 * 存续域为「进程级」：
 *   - cron job 表挂在 globalThis 上，因此活过 `/reload` 与 `/resume`。扩展在 reload
 *     时会被真正重新导入（pi loader 用 jiti 且 moduleCache: false），模块级变量
 *     必丢，globalThis 是唯一能跨 reload 存活又不跨进程的载体。
 *   - 进程退出时 globalThis 随之消失，无需任何清理代码。
 *
 * 常驻上下文只有 `cron` 工具的 description + 参数 schema（≈192 tokens）；人工命令不占
 * 常驻；行为约定（立即执行、回执、进程级说明）写在工具返回文本里，调用后付费。
 */

import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─── 常量 ───

const MAX_JOBS = 50;
/** setTimeout 的安全分块：2^31-1 ms ≈ 24.8 天，取 6 小时留足余量 */
const TICK_CHUNK_MS = 6 * 60 * 60 * 1000;
const STORE_KEY = Symbol.for("vkzha.pi-cron.jobs");
const CUSTOM_TYPE = "pi-cron";
const INFO_TYPE = "pi-cron-info";
const PROMPT_PREVIEW = 80;

// ─── 类型 ───

interface CronJob {
	id: string;
	cron: string;
	prompt: string;
	recurring: boolean;
	createdAt: number;
	/** 下一次触发的绝对时间；Infinity 表示「正在等待 agent 空闲」 */
	nextFireAt: number;
	fireCount: number;
	/** 欠跑计数：agent 忙碌期间到期的次数（合并后至多补一次触发） */
	backlog: number;
}

interface CronStore {
	jobs: CronJob[];
}

interface CronMessageDetails {
	id: string;
	cron: string;
	fireCount: number;
	catchUp: boolean;
}

interface CronToolDetails {
	action: "create" | "list" | "delete";
	jobs?: Array<{
		id: string;
		cron: string;
		human: string;
		prompt: string;
		recurring: boolean;
		fireCount: number;
		nextFireAt: number | null;
	}>;
	error?: string;
}

type CronInfoTone = "success" | "error" | "warning" | "text" | "muted" | "dim";

interface CronInfoLine {
	text: string;
	tone?: CronInfoTone;
}

interface CronInfoEntry {
	lines: CronInfoLine[];
}

/** createJob 的结果：错误以代码回报，由调用方渲染各自语言的文案 */
type CreateResult =
	| { ok: true; job: CronJob; next: Date }
	| { ok: false; code: "invalid-cron" | "no-match" | "too-many" };

// ─── 进程级 cron job 表 ───

function store(): CronStore {
	const g = globalThis as unknown as Record<symbol, CronStore | undefined>;
	let s = g[STORE_KEY];
	if (!s) {
		s = { jobs: [] };
		g[STORE_KEY] = s;
	}
	return s;
}

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

// ─── 人类可读排期 ───

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatClock(minute: number, hour: number): string {
	// 固定用 1 月 1 日，避开夏令时跳变日
	return new Date(2000, 0, 1, hour, minute).toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "2-digit",
	});
}

/** 只覆盖常见形态；认不出来就原样返回表达式（与工具返回文本共用，故用英文） */
export function cronToHuman(expr: string): string {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return expr;
	const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];

	const everyMin = minute.match(/^\*\/(\d+)$/);
	if (minute === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") return "Every minute";
	if (everyMin && hour === "*" && dom === "*" && month === "*" && dow === "*") {
		const n = Number(everyMin[1]);
		return n === 1 ? "Every minute" : `Every ${n} minutes`;
	}

	if (/^\d+$/.test(minute) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
		const m = Number(minute);
		return m === 0 ? "Every hour" : `Every hour at :${String(m).padStart(2, "0")}`;
	}

	const everyHour = hour.match(/^\*\/(\d+)$/);
	if (/^\d+$/.test(minute) && everyHour && dom === "*" && month === "*" && dow === "*") {
		const n = Number(everyHour[1]);
		const m = Number(minute);
		const suffix = m === 0 ? "" : ` at :${String(m).padStart(2, "0")}`;
		return n === 1 ? `Every hour${suffix}` : `Every ${n} hours${suffix}`;
	}

	// 每 N 天（dom 步进；与下面的「具体日期」互斥）
	const everyDayEn = dom.match(/^\*\/(\d+)$/);
	if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && everyDayEn && month === "*" && dow === "*") {
		const n = Number(everyDayEn[1]);
		const time = formatClock(Number(minute), Number(hour));
		return n === 1 ? `Every day at ${time}` : `Every ${n} days at ${time}`;
	}

	if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && /^\d+$/.test(month) && dow === "*") {
		const date = new Date(2000, Number(month) - 1, Number(dom));
		const label = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
		return `On ${label} at ${formatClock(Number(minute), Number(hour))}`;
	}

	if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === "*" && month === "*") {
		const m = Number(minute);
		const h = Number(hour);
		if (dow === "*") return `Every day at ${formatClock(m, h)}`;
		if (dow === "1-5") return `Weekdays at ${formatClock(m, h)}`;
		if (/^\d$/.test(dow)) {
			const name = DAY_NAMES[Number(dow) % 7];
			if (name) return `Every ${name} at ${formatClock(m, h)}`;
		}
	}

	return expr;
}

// ─── 小工具 ───

function relative(ms: number): string {
	if (ms <= 0) return "0s";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	if (h < 24) return rm ? `${h}h${rm}m` : `${h}h`;
	const d = Math.floor(h / 24);
	const rh = h % 24;
	return rh ? `${d}d${rh}h` : `${d}d`;
}

function formatClockZh(minute: number, hour: number): string {
	return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const DAY_NAMES_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 人类可读排期的中文版。命令面向用户（英文版 cronToHuman 服务工具返回文本） */
export function cronToHumanZh(expr: string): string {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return expr;
	const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];

	if (minute === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") return "每分钟";

	const everyMin = minute.match(/^\*\/(\d+)$/);
	if (everyMin && hour === "*" && dom === "*" && month === "*" && dow === "*") {
		const n = Number(everyMin[1]);
		return n === 1 ? "每分钟" : `每 ${n} 分钟`;
	}

	if (/^\d+$/.test(minute) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
		const m = Number(minute);
		return m === 0 ? "每小时" : `每小时的第 ${m} 分`;
	}

	const everyHour = hour.match(/^\*\/(\d+)$/);
	if (/^\d+$/.test(minute) && everyHour && dom === "*" && month === "*" && dow === "*") {
		const h = Number(everyHour[1]);
		const m = Number(minute);
		const base = h === 1 ? "每小时" : `每 ${h} 小时`;
		return m === 0 ? base : `${base}的第 ${m} 分`;
	}

	// 每 N 天（dom 步进；与下面的「具体日期」互斥）
	const everyDayZh = dom.match(/^\*\/(\d+)$/);
	if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && everyDayZh && month === "*" && dow === "*") {
		const n = Number(everyDayZh[1]);
		const time = formatClockZh(Number(minute), Number(hour));
		return n === 1 ? `每天 ${time}` : `每 ${n} 天 ${time}`;
	}

	// 具体日期：一次性任务的典型形态
	if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && /^\d+$/.test(month) && dow === "*") {
		return `${Number(month)} 月 ${Number(dom)} 日 ${formatClockZh(Number(minute), Number(hour))}`;
	}

	if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === "*" && month === "*") {
		const time = formatClockZh(Number(minute), Number(hour));
		if (dow === "*") return `每天 ${time}`;
		if (dow === "1-5") return `工作日 ${time}`;
		if (/^\d$/.test(dow)) return `${DAY_NAMES_ZH[Number(dow) % 7]} ${time}`;
	}

	return expr;
}

/** 相对时长的中文单值近似（命令回执用）。只给一个量级，不堆「X 小时 Y 分」这种碎数字 */
function relativeZh(ms: number): string {
	if (ms < 60_000) return "不到 1 分钟";
	const m = Math.round(ms / 60_000);
	if (m < 60) return `${m} 分钟`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h} 小时`;
	return `${Math.round(h / 24)} 天`;
}

/** 触发时刻：当天只显示 HH:MM，跨天补上月/日，括号里给相对时间 */
function formatWhen(at: number, now: number): string {
	const d = new Date(at);
	const clock = formatClockZh(d.getMinutes(), d.getHours());
	const sameDay = new Date(now).toDateString() === d.toDateString();
	const stamp = sameDay ? clock : `${d.getMonth() + 1}/${d.getDate()} ${clock}`;
	return `${stamp}（${relativeZh(at - now)}后）`;
}

function truncate(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

// ─── 间隔 → cron（/cron 命令用代码解析；模型路径自行构造表达式，两条路互不依赖） ───

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
 * 无法精确表达时取最近的干净粒度并在 note 里回报（对应 CONTEXT.md 的「规范化」）。
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

/**
 * 触发时交给模型的最小包装：只补两件模型不可能自己知道的事——这条消息从哪来、
 * 以及这个 job 的 id（供它自行取消）。逐字措辞都是调过的，改动前先看测试断言：
 *   - 用第三人称陈述来源，不用否定句去否认消息自身的 role（那会与 role=user 矛盾）；
 *   - 明确写出「该执行下面的内容」，不让模型猜该不该动手；
 *   - 一次性不提「已被移除」——那会暗示无事可做，与要执行的任务直接冲突；
 *   - 头行不标 recurring/one-shot；不写「怎么调工具」；不提 catch-up；不写过期策略。
 * prompt 本体逐字不变，只在前面加一行；渲染时由 unframePrompt 剥掉。
 */
export function framePrompt(job: CronJob): string {
	const head = `[cron-job ${job.id} · ${job.cron} · fire ${job.fireCount}]`;
	const note = job.recurring
		? "Delivered by a scheduled cron job. Run the prompt below, and cancel this job once its purpose is fulfilled."
		: "Delivered by a scheduled cron job. Run the prompt below.";
	return `${head} ${note}\n\n${job.prompt}`;
}

/** 渲染时剥掉上面的包装（与 pi 处理 <skill> 块的做法一致），TUI 只显示 prompt 原貌 */
export function unframePrompt(text: string): string {
	if (!text.startsWith("[cron-job ")) return text;
	const sep = text.indexOf("\n\n");
	return sep < 0 ? text : text.slice(sep + 2);
}

// ─── 扩展 ───

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setTimeout> | null = null;
	/** 最近一次的 ctx，用于查询 agent 是否空闲；session_start 时刷新 */
	let currentCtx: ExtensionContext | undefined;

	const jobs = (): CronJob[] => store().jobs;

	function nextRun(job: CronJob, from: number): number {
		const fields = parseCron(job.cron);
		if (!fields) return Number.POSITIVE_INFINITY;
		const next = nextCronRun(fields, new Date(from));
		return next ? next.getTime() : Number.POSITIVE_INFINITY;
	}

	function removeJob(id: string): boolean {
		const list = jobs();
		const i = list.findIndex((t) => t.id === id);
		if (i < 0) return false;
		list.splice(i, 1);
		return true;
	}

	function earliestFire(): number | null {
		let min: number | null = null;
		for (const t of jobs()) {
			if (!Number.isFinite(t.nextFireAt)) continue;
			if (min === null || t.nextFireAt < min) min = t.nextFireAt;
		}
		return min;
	}

	/** 单一定时器指向最近的 deadline；变更或触发后重算 */
	function arm(): void {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		const next = earliestFire();
		if (next === null) return;

		const delay = Math.max(0, next - Date.now());
		const long = delay > TICK_CHUNK_MS;
		timer = setTimeout(
			() => {
				timer = null;
				if (long) arm();
				else tick();
			},
			Math.min(delay, TICK_CHUNK_MS),
		);
		timer.unref?.();
	}

	/** 校验、限量、入表并重新武装定时器；工具与 /cron 命令共用 */
	function createJob(rawCron: string, prompt: string, recurring: boolean): CreateResult {
		const expr = rawCron.trim().replace(/\s+/g, " ");
		const fields = parseCron(expr);
		if (!fields) return { ok: false, code: "invalid-cron" };

		const next = nextCronRun(fields, new Date());
		if (!next) return { ok: false, code: "no-match" };

		if (jobs().length >= MAX_JOBS) return { ok: false, code: "too-many" };

		const job: CronJob = {
			id: randomUUID().slice(0, 8),
			cron: expr,
			prompt,
			recurring,
			createdAt: Date.now(),
			nextFireAt: next.getTime(),
			fireCount: 0,
			backlog: 0,
		};
		jobs().push(job);
		arm();
		return { ok: true, job, next };
	}

	function inject(job: CronJob, catchUp: boolean): void {
		pi.sendMessage(
			{
				customType: CUSTOM_TYPE,
				content: framePrompt(job),
				display: true,
				details: {
					id: job.id,
					cron: job.cron,
					fireCount: job.fireCount,
					catchUp,
				} as CronMessageDetails,
			},
			{ triggerTurn: true },
		);
	}

	function deliver(job: CronJob): void {
		const catchUp = job.backlog > 0;
		job.fireCount += 1;
		job.backlog = 0;

		if (job.recurring) job.nextFireAt = nextRun(job, Date.now());
		else removeJob(job.id);

		inject(job, catchUp);
	}

	/** 创建后的首次执行（D6：创建即执行，仅循环任务） */
	function runImmediately(job: CronJob): void {
		job.fireCount += 1;
		inject(job, false);
	}

	function tick(): void {
		const now = Date.now();
		const due = jobs().filter((t) => t.nextFireAt <= now);
		if (due.length === 0) {
			arm();
			return;
		}

		// agent 忙：只记欠跑并推进排期，等空闲后补一次
		if (!currentCtx || !currentCtx.isIdle()) {
			for (const t of due) {
				t.backlog += 1;
				t.nextFireAt = t.recurring ? nextRun(t, now) : Number.POSITIVE_INFINITY;
			}
			arm();
			return;
		}

		due.sort((a, b) => a.nextFireAt - b.nextFireAt);
		const first = due[0]!;
		// 同批其余 cron job 记为欠跑，等 agent 空闲后逐个补（serialize 触发，避免并发注入）
		for (const t of due) {
			if (t === first) continue;
			t.backlog += 1;
			t.nextFireAt = t.recurring ? nextRun(t, now) : Number.POSITIVE_INFINITY;
		}
		deliver(first);
		arm();
	}

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		arm();
	});

	pi.on("session_shutdown", () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	});

	// 空闲后补跑欠下的 cron job；一次补一个，触发的新一轮结束后会再次 settle
	pi.on("agent_settled", (_event, ctx) => {
		currentCtx = ctx;
		const waiting = jobs().filter((t) => t.backlog > 0);
		if (waiting.length > 0) {
			waiting.sort((a, b) => a.createdAt - b.createdAt);
			deliver(waiting[0]!);
		}
		arm();
	});

	// 触发时注入的消息。头行让 TUI 一眼认出是 cron job（带 id，便于对应 /cron list）；
	// 正文用 unframePrompt 剥掉给模型看的包装，只显示 prompt 原貌。
	// 展示形式对齐 pi 自己的 [skill] 加载块：Box(1,1) 上下各留一空行 + customMessageBg
	// 底色 + \x1b[1m[..]\x1b[22m 加粗方括号标签。不做折叠——正文总是可见。
	pi.registerMessageRenderer<CronMessageDetails>(CUSTOM_TYPE, (message, _options, theme) => {
		const d = message.details;
		const schedule = d ? cronToHuman(d.cron) : "cron job";
		const id = d?.id ? `${d.id} · ` : "";
		const meta = d ? ` · 第 ${d.fireCount} 次触发${d.catchUp ? " · 补跑" : ""}` : "";
		const raw =
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("");
		const body = unframePrompt(raw);

		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(
			new Text(
				theme.fg("customMessageLabel", "\x1b[1m[cron]\x1b[22m ") +
					theme.fg("customMessageText", id + schedule) +
					theme.fg("dim", meta),
				0,
				0,
			),
		);
		box.addChild(new Text(body, 0, 0));
		return box;
	});

	// ─── /cron 命令（人工入口，间隔由代码解析，不经过 LLM） ───

	const USAGE_LINES: CronInfoLine[] = [
		{ text: "用法：", tone: "text" },
		{ text: "/cron <间隔> [once] <prompt>   创建定时任务", tone: "dim" },
		{ text: "/cron list                     列出当前任务", tone: "dim" },
		{ text: "/cron delete [id]              删除任务（省略 id 则弹出选择）", tone: "dim" },
		{ text: "", tone: "dim" },
		{ text: "间隔：Ns / Nm / Nh / Nd，可复合（如 1h30m）；cron 最小粒度 1 分钟，秒级向上取整", tone: "dim" },
		{ text: "once：只触发一次（从现在算起 <间隔> 之后），触发后自动删除", tone: "dim" },
		{ text: "不加 once：循环触发，且创建后立即执行一次", tone: "dim" },
	];

	const info = (lines: CronInfoLine[]): void => pi.appendEntry<CronInfoEntry>(INFO_TYPE, { lines });

	function jobLines(job: CronJob, now: number): CronInfoLine[] {
		const when = Number.isFinite(job.nextFireAt) ? `${relativeZh(job.nextFireAt - now)}后` : "等待空闲";
		const fired = job.fireCount > 0 ? ` · 已触发 ${job.fireCount} 次` : "";
		const missed = job.backlog > 0 ? ` · 漏跑 ${job.backlog} 次` : "";
		const kind = job.recurring ? "" : " · 一次性";
		return [
			{ text: `${job.id} · ${cronToHumanZh(job.cron)} (${job.cron}) · ${when}${fired}${missed}${kind}`, tone: "text" },
			{ text: `↳ ${truncate(job.prompt, PROMPT_PREVIEW)}`, tone: "dim" },
		];
	}

	pi.registerEntryRenderer<CronInfoEntry>(INFO_TYPE, (entry, _options, theme) => {
		const box = new Box(1, 1);
		for (const line of entry.data?.lines ?? []) {
			box.addChild(new Text(line.tone ? theme.fg(line.tone, line.text) : line.text, 0, 0));
		}
		return box;
	});

	pi.registerCommand("cron", {
		description: "定时任务：/cron <间隔> [once] <prompt> | /cron list | /cron delete [id]",
		getArgumentCompletions: (prefix) => {
			if (prefix.trim().includes(" ")) return null;
			const typed = prefix.trim();
			const options = ["list", "delete", "1m", "5m", "15m", "30m", "1h", "6h", "1d"];
			const items = options.filter((o) => o.startsWith(typed)).map((o) => ({ value: o, label: o }));
			return items.length > 0 ? items : null;
		},
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim();
			if (!args) {
				info(USAGE_LINES);
				return;
			}

			const [head, ...rest] = args.split(/\s+/);

			if (head === "list") {
				const list = jobs();
				if (list.length === 0) {
					info([{ text: "当前没有定时任务。", tone: "muted" }]);
					return;
				}
				const now = Date.now();
				info([
					{ text: `共 ${list.length} 个定时任务`, tone: "text" },
					{ text: "", tone: "dim" },
					...list.flatMap((job) => jobLines(job, now)),
				]);
				return;
			}

			if (head === "delete") {
				const id = rest[0];
				if (id) {
					if (!removeJob(id)) {
						info([{ text: `✗ 没有 id 为 ${id} 的定时任务，用 /cron list 查看`, tone: "error" }]);
						return;
					}
					arm();
					info([{ text: `✓ 已删除定时任务 ${id}`, tone: "success" }]);
					return;
				}

				const list = jobs();
				if (list.length === 0) {
					info([{ text: "当前没有定时任务。", tone: "muted" }]);
					return;
				}
				if (ctx.mode !== "tui") {
					info([{ text: "✗ 非交互模式需要显式指定 id：/cron delete <id>", tone: "error" }]);
					return;
				}
				const labels = list.map((job) => `${job.id} · ${cronToHumanZh(job.cron)} · ${truncate(job.prompt, 40)}`);
				const chosen = await ctx.ui.select("删除哪个定时任务？", labels);
				if (!chosen) return;
				const target = list[labels.indexOf(chosen)];
				if (!target) return;
				removeJob(target.id);
				arm();
				info([{ text: `✓ 已删除定时任务 ${target.id}`, tone: "success" }]);
				return;
			}

			const interval = parseInterval(head);
			if (interval === null) {
				info([{ text: `✗ 无法识别的间隔「${head}」`, tone: "error" }, { text: "", tone: "dim" }, ...USAGE_LINES]);
				return;
			}

			const once = rest[0]?.toLowerCase() === "once";
			const prompt = (once ? rest.slice(1) : rest).join(" ").trim();
			if (!prompt) {
				info([{ text: "✗ 缺少 prompt", tone: "error" }, { text: "", tone: "dim" }, ...USAGE_LINES]);
				return;
			}

			const conversion = intervalToCron(interval);
			const result = once
				? createJob(oneShotCron(interval, new Date()).cron, prompt, false)
				: createJob(conversion.cron, prompt, true);

			if (!result.ok) {
				const reason =
					result.code === "too-many"
						? `定时任务数已达上限 ${MAX_JOBS}，请先用 /cron delete 删掉一个`
						: result.code === "invalid-cron"
							? "内部错误：生成了非法的 cron 表达式"
							: "内部错误：该排期在未来一年内没有匹配时刻";
				info([{ text: `✗ 创建失败：${reason}`, tone: "error" }]);
				return;
			}

			const { job, next } = result;
			const now = Date.now();
			const confirmation: CronInfoLine[] = [
				{ text: `✓ 已创建${once ? "一次性" : "循环"}定时任务 ${job.id}`, tone: "success" },
				{
					text: once
						? `触发时刻 ${formatWhen(next.getTime(), now)}`
						: `${cronToHumanZh(job.cron)} · 下次触发 ${formatWhen(next.getTime(), now)}`,
					tone: "text",
				},
			];
			if (!once && conversion.note) confirmation.push({ text: `⚠ ${conversion.note}`, tone: "warning" });
			if (!once) confirmation.push({ text: `取消：/cron delete ${job.id}`, tone: "dim" });
			info(confirmation);

			// D6：循环任务创建后立即执行一次；一次性任务等它唯一的触发时刻
			if (!once) runImmediately(job);
		},
	});

	// ─── 工具 ───

	const fail = (action: CronToolDetails["action"], message: string) => ({
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: { action, error: message } as CronToolDetails,
	});

	pi.registerTool({
		name: "cron",
		label: "Cron",
		description: "Create, list, or delete cron jobs; a cron job delivers a prompt to you on a cron schedule.",
		parameters: Type.Object({
			action: StringEnum(["create", "list", "delete"] as const, {
				description: "create: schedule a cron job. list: show cron jobs. delete: cancel a cron job by id.",
			}),
			cron: Type.Optional(
				Type.String({
					description:
						"5-field cron (minute hour day-of-month month day-of-week), local time. Required for create.",
				}),
			),
			prompt: Type.Optional(
				Type.String({ description: "Prompt delivered verbatim on every fire. Required for create." }),
			),
			recurring: Type.Optional(
				Type.Boolean({ description: "Default true. false = fire once, then delete the cron job." }),
			),
			id: Type.Optional(Type.String({ description: "Cron job id. Required for delete." })),
		}),

		async execute(_toolCallId, params) {
			switch (params.action) {
				case "create": {
					if (!params.cron || !params.prompt) return fail("create", "create requires both cron and prompt.");

					const result = createJob(params.cron, params.prompt, params.recurring !== false);
					if (!result.ok) {
						if (result.code === "invalid-cron") {
							return fail(
								"create",
								`invalid cron expression '${params.cron}'. Expected 5 fields: minute hour day-of-month month day-of-week.`,
							);
						}
						if (result.code === "no-match") {
							return fail(
								"create",
								`cron expression '${params.cron}' does not match any calendar date in the next year.`,
							);
						}
						return fail("create", `too many cron jobs (max ${MAX_JOBS}). Delete one first.`);
					}

					const { job, next } = result;
					const when = next.toLocaleString();
					const tail = "Cron jobs are process-scoped and are cleared when pi exits.";
					return {
						content: [
							{
								type: "text" as const,
								text: job.recurring
									? `Created recurring cron job ${job.id} (${cronToHuman(job.cron)}). Next fire ${when}. Run its prompt now as the first iteration instead of waiting for the first fire. ${tail}`
									: `Created one-shot cron job ${job.id} (${cronToHuman(job.cron)}). It fires once at ${when}, then deletes itself. ${tail}`,
							},
						],
						details: { action: "create" } as CronToolDetails,
					};
				}

				case "list": {
					const list = jobs();
					if (list.length === 0) {
						return {
							content: [{ type: "text" as const, text: "No cron jobs." }],
							details: { action: "list", jobs: [] } as CronToolDetails,
						};
					}

					const lines = list.map((t) => {
						const next = Number.isFinite(t.nextFireAt)
							? `next in ${relative(t.nextFireAt - Date.now())}`
							: "waiting for idle";
						const fired = t.fireCount > 0 ? ` · fired ${t.fireCount}x` : "";
						const missed = t.backlog > 0 ? ` · ${t.backlog} missed` : "";
						const kind = t.recurring ? "" : " · one-shot";
						return `${t.id} — ${cronToHuman(t.cron)} (${t.cron}) · ${next}${fired}${missed}${kind}: ${truncate(t.prompt, PROMPT_PREVIEW)}`;
					});

					return {
						content: [{ type: "text" as const, text: lines.join("\n") }],
						details: {
							action: "list",
							jobs: list.map((t) => ({
								id: t.id,
								cron: t.cron,
								human: cronToHuman(t.cron),
								prompt: t.prompt,
								recurring: t.recurring,
								fireCount: t.fireCount,
								nextFireAt: Number.isFinite(t.nextFireAt) ? t.nextFireAt : null,
							})),
						} as CronToolDetails,
					};
				}

				case "delete": {
					if (!params.id) return fail("delete", "id is required for delete.");
					if (!removeJob(params.id)) return fail("delete", `no cron job with id '${params.id}'.`);
					arm();
					return {
						content: [{ type: "text" as const, text: `Deleted cron job ${params.id}.` }],
						details: { action: "delete" } as CronToolDetails,
					};
				}

				default:
					return fail("list", `unknown action '${String(params.action)}'.`);
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("cron ")) + theme.fg("muted", args.action);
			if (args.cron) text += ` ${theme.fg("dim", args.cron)}`;
			if (args.id) text += ` ${theme.fg("accent", args.id)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as CronToolDetails | undefined;
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);

			const first = result.content[0];
			const text = first?.type === "text" ? first.text : "";
			if (details?.action === "list" && (details.jobs?.length ?? 0) > 0 && !expanded) {
				const shown = details.jobs!.slice(0, 5);
				const head = theme.fg("muted", `${details.jobs!.length} cron job(s):`);
				const rows = shown.map(
					(t) =>
						`${theme.fg("accent", t.id)} ${theme.fg("muted", t.human)} ${theme.fg("dim", `(${t.cron})`)} ${theme.fg("muted", truncate(t.prompt, 40))}`,
				);
				const more = details.jobs!.length > shown.length
					? `\n${theme.fg("dim", `... ${details.jobs!.length - shown.length} more`)}`
					: "";
				return new Text([head, ...rows].join("\n") + more, 0, 0);
			}
			return new Text(theme.fg("muted", text), 0, 0);
		},
	});
}
