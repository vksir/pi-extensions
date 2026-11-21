/**
 * token-stats 的异步客户端：写和读都交给 lib/token-stats-worker.ts。
 *
 * `recordTurn` 只是 postMessage，立即返回，不碰 SQLite，也不占主线程。
 * 查询返回 Promise；worker 按消息顺序处理，所以查询前投递的 turn 一定已经提交。
 */

import { Worker } from "node:worker_threads";
import type { TurnInput, WindowModelRow } from "./token-stats-db.ts";
import type { WorkerReply, WorkerRequest, WorkerStartData } from "./token-stats-worker.ts";

export interface TokenStatsClient {
	/** 投递一轮响应；worker 未就绪或已失败时静默丢弃。 */
	recordTurn(turn: TurnInput): void;
	/** 时间窗内单个模型的聚合；scope 为 DB 里的 `provider/model`，没有记录时 undefined。 */
	windowRow(since: number, model: string): Promise<WindowModelRow | undefined>;
	/** 时间窗内最近一次响应用的模型名；没有记录时 undefined。 */
	latestModel(since: number): Promise<string | undefined>;
	/** 等 worker 处理完已投递的消息并关闭数据库 */
	close(): Promise<void>;
}

interface Waiter {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

export interface TokenStatsClientOptions extends WorkerStartData {}

export function openTokenStatsClient(options: TokenStatsClientOptions): TokenStatsClient {
	const worker = new Worker(new URL("./token-stats-worker.ts", import.meta.url), {
		workerData: options,
		// Node 22/23 的 node:sqlite 会打 ExperimentalWarning，pi 会把它画到 TUI 里。
		// 只传这一个 flag：显式 execArgv 会绕过 worker 对父进程 V8 flag 的过滤
		// （node --test 下 process.execArgv 里就有 worker 不收的 flag）。
		execArgv: ["--disable-warning=ExperimentalWarning"],
	});
	const waiters = new Map<number, Waiter>();
	let nextId = 1;
	let failure: Error | undefined;
	let closed = false;

	function fail(error: Error): void {
		failure ??= error;
		for (const waiter of waiters.values()) waiter.reject(error);
		waiters.clear();
	}

	worker.on("message", (message: WorkerReply) => {
		if (message.type === "failed") {
			fail(new Error(message.message));
			return;
		}
		if (message.type === "ready") return;
		const waiter = waiters.get(message.id);
		if (!waiter) return;
		waiters.delete(message.id);
		if (message.type === "error") waiter.reject(new Error(message.message));
		else waiter.resolve(message.value);
	});
	worker.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
	worker.on("exit", (code) => {
		if (!closed) fail(new Error(`token-stats worker exited with ${code}`));
	});

	type QueryRequest = { type: "window"; since: number; model: string } | { type: "latest"; since: number };

	function request<T>(message: QueryRequest): Promise<T> {
		if (failure) return Promise.reject(failure);
		if (closed) return Promise.reject(new Error("token-stats client is closed"));
		const id = nextId++;
		return new Promise<T>((resolve, reject) => {
			waiters.set(id, { resolve: resolve as (value: unknown) => void, reject });
			worker.postMessage({ ...message, id } satisfies WorkerRequest);
		});
	}

	return {
		recordTurn(turn: TurnInput): void {
			if (failure || closed) return;
			try {
				worker.postMessage({ type: "turn", turn } satisfies WorkerRequest);
			} catch {
				/* worker 已退出：与查询失败同样处理，丢这一轮 */
			}
		},
		windowRow(since: number, model: string): Promise<WindowModelRow | undefined> {
			return request<WindowModelRow | null>({ type: "window", since, model }).then((value) => value ?? undefined);
		},
		latestModel(since: number): Promise<string | undefined> {
			return request<string | null>({ type: "latest", since }).then((value) => value ?? undefined);
		},
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			fail(new Error("token-stats client is closed"));
			try {
				worker.postMessage({ type: "close" } satisfies WorkerRequest);
			} catch {
				/* 已经退出 */
			}
			await new Promise<void>((resolve) => {
				let settled = false;
				const finish = (): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve();
				};
				// worker 卡死时别把进程一起拖住
				const timer = setTimeout(() => {
					void worker.terminate().then(finish, finish);
				}, 2_000);
				worker.once("exit", finish);
			});
		},
	};
}
