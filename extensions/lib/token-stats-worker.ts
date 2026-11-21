/**
 * token-stats 的写线程。
 *
 * SQLite 的 Node 接口只有同步版（`DatabaseSync`），在 turn_end 里直接写会卡住
 * TUI 的事件循环；多进程抢写时 `busy_timeout` 还可能拖到几秒。所以主线程只把
 * 一轮响应 `postMessage` 过来，真正的建库、迁移、INSERT 都在这个 worker 里排队执行。
 *
 * `/token` 的时间窗查询也走这里：消息按投递顺序处理，查询自然看得到之前所有已提交的 turn，
 * 不需要额外的 flush 握手，也不用在主线程再开一个数据库连接。
 */

import { parentPort, workerData } from "node:worker_threads";
import { openTokenStatsStore, type TokenStatsStore, type TurnInput, type WindowModelRow } from "./token-stats-db.ts";

export interface WorkerStartData {
	dbPath: string;
}

export type WorkerRequest =
	| { type: "turn"; turn: TurnInput }
	| { type: "window"; id: number; since: number }
	| { type: "close" };

export type WorkerReply =
	| { type: "ready" }
	| { type: "failed"; message: string }
	| { type: "result"; id: number; value: WindowModelRow[] }
	| { type: "error"; id: number; message: string };

const port = parentPort;
if (!port) throw new Error("token-stats worker requires a parent port");

const { dbPath } = workerData as WorkerStartData;
let store: TokenStatsStore | undefined;
let failure: string | undefined;
try {
	store = openTokenStatsStore(dbPath);
} catch (error) {
	failure = error instanceof Error ? error.message : String(error);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

port.on("message", (message: WorkerRequest) => {
	if (message.type === "close") {
		store?.close();
		store = undefined;
		port.close();
		return;
	}
	if (!store) {
		if ("id" in message) port.postMessage({ type: "error", id: message.id, message: failure ?? "store unavailable" });
		return;
	}
	try {
		if (message.type === "turn") {
			store.recordTurn(message.turn);
		} else {
			port.postMessage({ type: "result", id: message.id, value: store.windowRows(message.since) });
		}
	} catch (error) {
		if ("id" in message) port.postMessage({ type: "error", id: message.id, message: errorMessage(error) });
	}
});

port.postMessage(failure ? { type: "failed", message: failure } : { type: "ready" });
