/**
 * Agent 数据目录下的 JSON 持久化：读取失败退回默认值，写入走临时文件 + rename。
 *
 * 两个诉求与 pi 的扩展生命周期一致：读取必须容忍半成品或手改坏的文件，
 * 写入必须是原子替换，避免进程中途退出留下半截 JSON。
 *
 * 原子替换只保证文件不撕裂，不保证不丢更新：多个 pi 进程（各自一个会话）同时
 * 记录增量时，A 读到旧快照、B 写完、A 再写就把 B 的增量覆盖掉。因此整文件的
 * 读-改-写走 `updateJsonFile`：先拿同名 `.lock`，同一时刻只有一个进程在改。
 */

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";

/** 读取并解析 JSON 文件；文件不存在或内容不合法时返回 fallback。 */
export function readJsonFile<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return fallback;
	}
}

/** 原子写入 JSON 文件：先写同目录临时文件，再 rename 覆盖目标。 */
export function writeJsonFileAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp.${process.pid}`;
	writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
	renameSync(tmp, path);
}

/** 持有者崩溃留下的锁超过这个时间就回收；正常持锁只有毫秒级。 */
const LOCK_STALE_MS = 10_000;
/** 等锁上限；超过就放弃这次写入（正常竞争远到不了这里）。 */
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 20;

/** 同步睡眠：turn_end 是同步 handler，等锁时不能靠 await。 */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 拿排它锁，返回锁的 token（释放时用来确认锁还是自己的）。
 * 锁文件内容是本进程写的一行 token；mtime 用来判断持有者是否已经崩溃。
 */
function acquireLock(lockPath: string): string {
	mkdirSync(dirname(lockPath), { recursive: true });
	const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			const fd = openSync(lockPath, "wx");
			try {
				writeSync(fd, token);
			} finally {
				closeSync(fd);
			}
			return token;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}

		// 锁在：持有者崩了（mtime 过老）就回收；刚被释放（stat 失败）就直接重试。
		let stale = false;
		try {
			stale = Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
		} catch {
			continue;
		}
		if (stale) {
			try {
				unlinkSync(lockPath);
			} catch {
				/* 别的进程先回收了 */
			}
			continue;
		}
		if (Date.now() >= deadline) throw new Error(`timed out waiting for lock: ${lockPath}`);
		sleepSync(LOCK_RETRY_MS);
	}
}

/** 只删自己的锁：锁被当成过期回收后，不能把新持有者的锁删掉。 */
function releaseLock(lockPath: string, token: string): void {
	try {
		if (readFileSync(lockPath, "utf-8") !== token) return;
		rmSync(lockPath, { force: true });
	} catch {
		/* 锁已经不在了 */
	}
}

/**
 * 在锁内完成整个读-改-写：多进程各自记录增量时不会互相覆盖。
 * `update` 必须返回完整的下一个状态；抛错时文件保持原样，锁照样释放。
 */
export function updateJsonFile<T>(path: string, fallback: T, update: (current: T) => T): T {
	const lockPath = `${path}.lock`;
	const token = acquireLock(lockPath);
	try {
		const next = update(readJsonFile(path, fallback));
		writeJsonFileAtomic(path, next);
		return next;
	} finally {
		releaseLock(lockPath, token);
	}
}
