/**
 * 会话快照：给「agent 忙碌时」的 `/btw` 提供一份可安全 fork 的会话副本。
 *
 * 会话文件是 append-only 的，一条消息只在 `message_end` 时才落盘
 * （pi 的 agent-session 在 message_end 里 appendMessage）。所以 agent 正在
 * 跑 turn 时，文件末尾必然是半截状态：本轮的 user 消息已落盘但还没有回答，
 * 或一条带 `toolCall` 的 assistant 消息还没有对应的 `toolResult`。而
 * `pi --fork` 是逐行原样复制（SessionManager.forkFrom 不做任何修整），
 * 拿半截文件 fork 出的新会话就会把别人未完成的 turn 当成自己的完整过去，
 * 上下文从第一句话起就是错的。
 *
 * 这里的做法：从文件最后一条 entry（pi 加载时把它当 leaf）沿 parentId
 * 回溯出当前分支，砍掉分支尾部直到最近一条「收尾的 assistant」——content
 * 里没有 toolCall 的 assistant 消息，就是一轮完整的结束。砍掉的都是本次
 * 未完成的 turn（或 steer 插话），fork 后的新 pi 看到的是上一轮结束时的
 * 干净状态，再接着处理 /btw 的消息。
 *
 * 只输出 header + 当前分支的前缀链：别分支、旁支 label、模型切换等
 * 挂在不保留位置上的 entry 都一并舍弃，保证输出文件的 parentId 链自洽。
 * 写入系统临时目录（不删：fork 进程何时复制完不可知，文件很小），
 * 由调用方把路径交给 `pi --fork`。源文件只读。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { basename } from "./text.ts";

/** 宽松的 entry 形状：只关心判定边界与链所需的字段，其余原样透传。 */
type Entry = Record<string, unknown> & { type?: unknown; id?: unknown; parentId?: unknown };

/** 快照结果。 */
export interface ForkSnapshot {
	/** 已截断到完整 turn 边界的会话文件，可直接交给 `pi --fork`。 */
	file: string;
	/** 为回到完整边界而丢弃的条目数（不含 header）。 */
	droppedEntries: number;
}

/** 快照选项；测试可注入输出目录。 */
export interface SnapshotOptions {
	/** 快照目录，缺省为系统临时目录下的 pi-btw-fork/。 */
	dir?: string;
}

/** assistant 消息的 content 里是否有工具调用。 */
function hasToolCall(message: Record<string, unknown>): boolean {
	const content = message.content;
	if (!Array.isArray(content)) return false;
	return content.some(
		(block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "toolCall",
	);
}

/**
 * 是否是 turn 的收尾边界：一条不含工具调用的 assistant 消息。带 toolCall 的
 * assistant 只是 turn 中途的一步（它的 toolResult 还可能在写盘路上），不能当
 * 边界。
 */
function isTurnBoundary(entry: Entry): boolean {
	if (entry.type !== "message") return false;
	const message = entry.message;
	if (typeof message !== "object" || message === null) return false;
	const record = message as Record<string, unknown>;
	return record.role === "assistant" && !hasToolCall(record);
}

/**
 * 从最后一条 entry（pi 加载时视作 leaf）沿 parentId 回溯出当前分支，
 * 顺序为根 → 叶。parentId 断链或成环时在此停下，不猜。
 */
function activeBranch(body: Entry[]): Entry[] {
	const byId = new Map<string, Entry>();
	for (const entry of body) {
		if (typeof entry.id === "string") byId.set(entry.id, entry);
	}
	const branch: Entry[] = [];
	const seen = new Set<Entry>();
	let current: Entry | undefined = body[body.length - 1];
	while (current && !seen.has(current)) {
		seen.add(current);
		branch.push(current);
		const parentId: unknown = current.parentId;
		current = typeof parentId === "string" ? byId.get(parentId) : undefined;
	}
	return branch.reverse();
}

/**
 * 把 entries 截到当前分支最后一个 turn 边界；已是边界且没有旁支时原样返回
 * 同一数组（调用方据此判断无需快照）。header 永远保留，其余非当前分支的
 * entry 一律丢弃。
 */
export function retainToTurnBoundary(entries: Entry[]): Entry[] {
	const header = entries.find((entry) => entry.type === "session");
	if (!header) return entries;
	const body = entries.filter((entry) => entry !== header);
	const branch = activeBranch(body);
	let boundary = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (isTurnBoundary(branch[i]!)) {
			boundary = i;
			break;
		}
	}
	const kept = boundary >= 0 ? branch.slice(0, boundary + 1) : [];
	if (kept.length === body.length) return entries;
	return [header, ...kept];
}

/** 逐行解析 JSONL；空行与解析失败的行跳过（写盘竞争可能留下半截行）。 */
function parseEntries(raw: string): Entry[] {
	const entries: Entry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof parsed === "object" && parsed !== null) entries.push(parsed as Entry);
	}
	return entries;
}

/** 快照文件名：沿用源会话名，加进程号与随机后缀，保证多次分派互不覆盖。 */
function snapshotFileName(sessionFile: string): string {
	const stem = basename(sessionFile).replace(/\.jsonl$/i, "");
	return `${stem}-${process.pid}-${randomUUID().slice(0, 8)}.jsonl`;
}

/**
 * 给当前会话做一份「停在最后一个完整 turn」的快照，供 agent 忙碌时 fork。
 * 会话已停在完整边界（或文件还没有 header）时返回 undefined，调用方直接
 * fork 原文件即可。读取失败原样抛出，由调用方提示用户。
 */
export function snapshotAtTurnBoundary(sessionFile: string, options: SnapshotOptions = {}): ForkSnapshot | undefined {
	const entries = parseEntries(readFileSync(sessionFile, "utf-8"));
	if (!entries.some((entry) => entry.type === "session")) return undefined;
	const retained = retainToTurnBoundary(entries);
	if (retained === entries) return undefined;

	const dir = options.dir ?? join(tmpdir(), "pi-btw-fork");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, snapshotFileName(sessionFile));
	writeFileSync(file, retained.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf-8");

	return { file, droppedEntries: entries.length - retained.length };
}
