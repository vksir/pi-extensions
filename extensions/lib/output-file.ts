/**
 * 把过长的工具输出落成临时文件，路径回给模型自己去读。
 *
 * 与 pi 内置的 output-files 同一套约定：`<tmpdir>/<prefix>-<8 字节随机 hex><扩展名>`，
 * 文件权限 0600、以 `wx` 打开（不跟随别人预置的链接）。放在这里而不是 import pi 的
 * 内部模块：那些工具没有从包入口导出，扩展只能依赖公开面。
 */

import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 写入新文件并返回绝对路径；目录不可写时原样抛给调用方。 */
export async function writeOutputFile(prefix: string, extension: string, data: string): Promise<string> {
	const path = join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}${extension}`);
	await writeFile(path, data, { mode: 0o600, flag: "wx" });
	return path;
}
