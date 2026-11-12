/**
 * pi-bg 的任务表：纯数据与纯函数。
 *
 * 这里不碰 pi、不碰进程、不碰时钟之外的东西，便于直接跑 node --test。
 * 任务表本身是扩展模块级变量：`session_shutdown`（含 `/reload` 的 reason:"reload"）
 * 会 kill 掉全部在跑任务，因此不需要 globalThis 那个跨 reload 载体（对比 ADR-0001）。
 */

export type BgKind = "bash" | "codemode";

export type BgStatus = "running" | "done" | "failed" | "killed";

export interface BgJob {
	id: string;
	kind: BgKind;
	/** 单行摘要：命令或脚本首行，用于列表与回传头行 */
	label: string;
	startedAt: number;
	status: BgStatus;
	exitCode?: number;
	durationMs?: number;
	/** 内置工具返回的正文，原样保留（截断由内置工具自己做） */
	output?: string;
}

/** 同时在跑的任务上限；超出直接拒绝启动 */
export const MAX_RUNNING = 64;

/** 已完成任务的保留条数，超出按完成顺序淘汰最旧的 */
export const KEEP_FINISHED = 20;

export function runningJobs<T extends BgJob>(jobs: readonly T[]): T[] {
	return jobs.filter((job) => job.status === "running");
}

export function finishedJobs<T extends BgJob>(jobs: readonly T[]): T[] {
	return jobs.filter((job) => job.status !== "running");
}

export function runningCount(jobs: readonly BgJob[]): number {
	return runningJobs(jobs).length;
}

export function findJob<T extends BgJob>(jobs: readonly T[], id: string): T | undefined {
	return jobs.find((job) => job.id === id);
}

/** 8 位十六进制任务 id，与 pi-cron 的 job id 同一形状；撞号时重摇。 */
export function newJobId(taken: (id: string) => boolean, random: () => string = defaultRandom): string {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const id = random().replace(/-/g, "").slice(0, 8);
		if (!taken(id)) return id;
	}
	throw new Error("could not allocate a unique background job id");
}

/** 把 label 压成单行并截断；取第一条非空行，纯空内容返回空串。 */
export function summarizeLabel(text: string, max = 80): string {
	const firstLine = text.split("\n").find((line) => line.trim() !== "") ?? "";
	const oneLine = firstLine.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	return `${oneLine.slice(0, max - 1)}…`;
}

/**
 * 淘汰最旧的已完成任务，只在总数超出 keep 时动手；
 * 在跑任务永不被淘汰（它们的 promise 还握着 job 对象）。
 */
export function pruneFinished(jobs: BgJob[], keep: number = KEEP_FINISHED): BgJob[] {
	const finished = jobs.filter((job) => job.status !== "running");
	const excess = finished.length - keep;
	if (excess <= 0) return [];
	const dropped = new Set(finished.slice(0, excess));
	for (let index = jobs.length - 1; index >= 0; index -= 1) {
		const job = jobs[index]!;
		if (dropped.has(job)) jobs.splice(index, 1);
	}
	return [...dropped];
}

function defaultRandom(): string {
	return globalThis.crypto.randomUUID();
}
