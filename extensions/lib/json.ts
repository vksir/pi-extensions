/**
 * Agent 数据目录下的 JSON 持久化：读取失败退回默认值，写入走临时文件 + rename。
 *
 * 两个诉求与 pi 的扩展生命周期一致：读取必须容忍半成品或手改坏的文件，
 * 写入必须是原子替换，避免进程中途退出留下半截 JSON。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
