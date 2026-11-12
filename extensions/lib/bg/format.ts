/**
 * pi-bg 的全部面向人的文本：工具返回、完成消息、`/bg` 列表。
 *
 * 行为约定按 ADR-0002 放在**工具返回文本**里，工具 description 只留参数语义。
 */

import type { BgJob, BgStatus } from "./jobs.ts";

/** 完成消息的空输出占位，对齐内置 bash 的 `(no output)`。 */
const EMPTY_OUTPUT = "(no output)";

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

/** `running · 3.2s` / `done · exit 0 · 12.4s` / `failed · exit 1 · 12.4s` / `killed · 3.2s`。 */
export function statusText(job: BgJob): string {
	const parts: string[] = [statusLabel(job.status)];
	if (job.status !== "running" && job.exitCode !== undefined) parts.push(`exit ${job.exitCode}`);
	if (job.status === "running") parts.push(elapsedText(Date.now() - job.startedAt));
	else if (job.durationMs !== undefined) parts.push(elapsedText(job.durationMs));
	return parts.join(" · ");
}

/** 启动成功的工具返回：告知 id、结果回传方式与会话绑定的存续域。 */
export function startText(job: BgJob): string {
	const what = job.label ? ` (${job.label})` : "";
	return `Started background job ${job.id}${what}. Its output arrives as a message when it finishes; use \`bg wait ${job.id}\` to block for it, \`bg list\` to inspect, or \`bg kill\` to stop it. Background jobs end with the session: /new, /reload, and exit stop them.`;
}

/** 完成消息的正文：头行 + 内置工具的原样输出。 */
export function deliveryContent(job: BgJob): string {
	const head = `[${job.kind}-bg ${job.id}] ${job.label} — ${statusText(job)}`;
	const body = job.output && job.output.trim().length > 0 ? job.output : EMPTY_OUTPUT;
	return `${head}\n\n${body}`;
}

/** 完成消息的头行之外的部分，供 TUI 渲染器拆出来单独排版。 */
export function splitDelivery(content: string): { head: string; body: string } {
	const index = content.indexOf("\n\n");
	if (index < 0) return { head: content, body: "" };
	return { head: content.slice(0, index), body: content.slice(index + 2) };
}

/** `bg list` 与 `/bg` 共用的列表行：在跑在前（启动序），已完成在后（新到旧）。 */
export function formatListLines(jobs: readonly BgJob[]): string[] {
	if (jobs.length === 0) return ["没有后台任务。"];
	const running = jobs.filter((job) => job.status === "running");
	const finished = jobs.filter((job) => job.status !== "running").reverse();
	const lines = [...running, ...finished].map(
		(job) => `${job.id} — ${job.kind} · ${statusText(job)} · ${job.label}`,
	);
	return [`共 ${running.length} 个在跑 / ${finished.length} 条已完成`, "", ...lines];
}
