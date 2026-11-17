/**
 * pi-bg 的文本装配：把状态算成 `3.2s` / `done · exit 0 · 12.4s` 这类片段，
 * 再交给 `extensions/prompt/pi-bg.ts` 拼成模型可见文案。
 *
 * 这里只留「格式」与「TUI 专用」的文本；所有模型可见的句子都在 prompt/ 里。
 */

import { ERROR_PREFIX, piBgPrompt } from "../../prompt/pi-bg.ts";
import { type BgJob, type BgStatus, originLabel } from "./jobs.ts";

/** 完成消息的空输出占位，对齐内置 bash 的 `(no output)`。 */
const EMPTY_OUTPUT = piBgPrompt.results.noOutput();

/** 毫秒 → `3.2s` / `42s` / `1m03s`。 */
export function elapsedText(ms: number): string {
	const secs = Math.max(0, ms) / 1000;
	if (secs < 10) return `${secs.toFixed(1)}s`;
	const total = Math.round(secs);
	if (total < 60) return `${total}s`;
	return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

export function statusLabel(status: BgStatus): string {
	return status === "done" ? "done" : status;
}

/** 等待预算的人类可读形式：`5 minutes` / `90 seconds`。 */
export function budgetText(seconds: number): string {
	if (seconds < 60) return `${Math.round(seconds)} seconds`;
	const minutes = seconds / 60;
	return Number.isInteger(minutes) ? `${minutes} minutes` : `${Math.round(seconds)} seconds`;
}

/**
 * 任务在文本里的正式称呼：**永远**带 `bg_job` 前缀。
 * 裸 8 位十六进制 id 与子 Agent 的 id 同形，模型会误调 `get_subagent_result`。
 */
export function jobRef(job: BgJob): string {
	return `bg_job ${job.id}`;
}

/** `running · 3.2s` / `done · exit 0 · 12.4s` / `failed · exit 1 · 12.4s` / `killed · 3.2s`。 */
export function statusText(job: BgJob): string {
	const parts: string[] = [statusLabel(job.status)];
	if (job.status !== "running" && job.exitCode !== undefined) parts.push(`exit ${job.exitCode}`);
	if (job.status === "running") parts.push(elapsedText(Date.now() - job.startedAt));
	else if (job.durationMs !== undefined) parts.push(elapsedText(job.durationMs));
	return parts.join(" · ");
}

/** 错误结果正文：`Error: ` + 小写子句。 */
export function errorText(clause: string): string {
	return `${ERROR_PREFIX}${clause}`;
}

// ─── 模型可见文本 ───

/** 启动成功的工具返回。 */
export function startText(job: BgJob): string {
	return piBgPrompt.results.started(job.id);
}

/** 晋升结果的 tool result 正文。 */
export function promoteText(job: BgJob, ran: string, activity: string): string {
	return job.kind === "bash"
		? piBgPrompt.results.promotedBash(job.id, ran, activity)
		: piBgPrompt.results.promotedCodemode(job.id, ran, activity);
}

/** `wait` 超时的返回：任务还在跑，结果仍会作为消息回传。 */
export function waitTimeoutText(jobs: readonly BgJob[], waited: string): string {
	return piBgPrompt.results.waitTimedOut(waited, jobs.map(jobRef).join(", "));
}

/** 完成消息的正文：头行 + 内置工具的原样输出。 */
export function deliveryContent(job: BgJob): string {
	const head = piBgPrompt.messages.deliveryHead(job.id, originLabel(job), job.label, statusText(job));
	const body = job.output && job.output.trim().length > 0 ? job.output : EMPTY_OUTPUT;
	return `${head}\n\n${body}`;
}

/** 完成消息的头行之外的部分，供 TUI 渲染器拆出来单独排版。 */
export function splitDelivery(content: string): { head: string; body: string } {
	const index = content.indexOf("\n\n");
	if (index < 0) return { head: content, body: "" };
	return { head: content.slice(0, index), body: content.slice(index + 2) };
}

/** 表格型的一行：`bg_job <id> — bash · running · 3.2s · npm test`。 */
export function listRow(job: BgJob): string {
	return piBgPrompt.results.listRow(jobRef(job), job.kind, statusText(job), job.label);
}

/** `bg_job list` 与 `/bg` 共用的行序：在跑在前（启动序），已完成在后（新到旧）。 */
export function orderedJobs(jobs: readonly BgJob[]): BgJob[] {
	const running = jobs.filter((job) => job.status === "running");
	const finished = jobs.filter((job) => job.status !== "running").reverse();
	return [...running, ...finished];
}

/** 模型可见的 `bg_job list` 正文。 */
export function listText(jobs: readonly BgJob[]): string {
	if (jobs.length === 0) return piBgPrompt.results.listEmpty();
	const running = jobs.filter((job) => job.status === "running").length;
	const finished = jobs.length - running;
	return [piBgPrompt.results.listSummary(running, finished), "", ...orderedJobs(jobs).map(listRow)].join("\n");
}

// ─── TUI 专用（人类可读，中文） ───

/** `/bg` 命令的列表正文：中文表头 + 与工具共用的行。 */
export function bgCommandLines(jobs: readonly BgJob[]): string[] {
	if (jobs.length === 0) return ["没有后台任务。"];
	const running = jobs.filter((job) => job.status === "running").length;
	const finished = jobs.length - running;
	return [`共 ${running} 个在跑 / ${finished} 条已完成`, "", ...orderedJobs(jobs).map(listRow)];
}
