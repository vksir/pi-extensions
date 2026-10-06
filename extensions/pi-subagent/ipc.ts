/**
 * 主 Agent 一侧的结果接收端：每个主会话命名空间一个本地 IPC 端点。
 *
 * 端点由 ownerKey 确定，子 Agent 通过环境变量得到它的路径；消息处理始终交给
 * runtime 中当前扩展实例的 sink，因此 /reload 后仍由新实例接收（不复用旧 runtime）。
 */
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMessage } from "./protocol.ts";
import { runtimeStore } from "./runtime.ts";

export interface ResultServer {
	path: string;
	server: Server;
}

/**
 * 端点名只在本进程内需要唯一，并包含进程号，避免同一主会话被两个 pi 进程打开
 * （或并行测试）时互相争用同一条命名管道。子 Agent 通过环境变量拿到实际路径。
 */
export function resultPipePath(ownerKey: string): string {
	const stem = `pi-subagent-${process.pid}-${ownerKey.slice(0, 16)}`;
	return process.platform === "win32" ? `\\\\.\\pipe\\\\${stem}` : join(tmpdir(), `${stem}.sock`);
}

/** 同一扩展实例内的并发保护；跨 reload 时由 runtime 里已有的端点复用。 */
const starting = new Map<string, Promise<ResultServer>>();

export function ensureResultServer(ownerKey: string): Promise<ResultServer> {
	const store = runtimeStore();
	const existing = store.servers.get(ownerKey);
	if (existing) return Promise.resolve(existing);
	const inFlight = starting.get(ownerKey);
	if (inFlight) return inFlight;

	const path = resultPipePath(ownerKey);
	// POSIX 上崩溃遗留的 socket 文件会挡住重新监听；Windows 命名管道随进程消失，无需处理。
	if (process.platform !== "win32") rmSync(path, { force: true });
	const created = new Promise<ResultServer>((resolve, reject) => {
		const server = createServer((socket) => {
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk) => {
				buffer += chunk;
			});
			socket.on("error", () => {});
			socket.on("end", () => {
				const message = parseMessage(buffer.trim());
				if (message) store.sink?.(message);
			});
		});
		server.once("error", reject);
		server.listen(path, () => {
			server.unref();
			resolve({ path, server });
		});
	});

	const pending = created
		.then((handle) => {
			store.servers.set(ownerKey, handle);
			return handle;
		})
		.finally(() => {
			starting.delete(ownerKey);
		});
	starting.set(ownerKey, pending);
	return pending;
}

export function closeResultServer(ownerKey: string): void {
	const store = runtimeStore();
	const handle = store.servers.get(ownerKey);
	if (!handle) return;
	store.servers.delete(ownerKey);
	handle.server.close();
}

/** 主会话切换时用：只保留当前主会话的端点，旧主会话的迟到结果无法再投递。 */
export function closeOtherResultServers(ownerKey: string): void {
	const store = runtimeStore();
	for (const key of [...store.servers.keys()]) {
		if (key !== ownerKey) closeResultServer(key);
	}
}

export function closeResultServers(): void {
	const store = runtimeStore();
	for (const key of [...store.servers.keys()]) closeResultServer(key);
}
