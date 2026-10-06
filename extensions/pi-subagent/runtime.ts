/**
 * 运行态：主会话／实例名 → 本扩展拥有的 Herdr 运行位置，以及结果接收端。
 *
 * 这张表挂在固定的 globalThis Symbol 上，而不是扩展模块的局部变量：pi 在 `/reload` 时
 * 会重新导入扩展模块（jiti, moduleCache: false），模块级变量必然丢失（ADR-0001）。
 * 表中只登记运行资源；丢失它不等于丢失逻辑实例、名称绑定或对话历史。
 */
import type { Server } from "node:net";
import type { BindingMessage, ResultMessage } from "./protocol.ts";

const STORE_KEY = Symbol.for("vkzha.pi-subagent.runtime");

export interface SubagentRuntime {
	ownerKey: string;
	name: string;
	type: string;
	/** Herdr pane ID：实例身份与操作的唯一目标，不用 Herdr 显示名或当前焦点 */
	paneId: string;
	tabId: string;
	/** 展示用 Herdr agent 名（含短哈希，避免跨主会话同名冲突） */
	agentName: string;
	startedAt: number;
}

export interface ResultServerHandle {
	path: string;
	server: Server;
}

export interface RuntimeStore {
	instances: Map<string, SubagentRuntime>;
	servers: Map<string, ResultServerHandle>;
	/** 当前主会话的 ownerKey，由 session_start 刷新；旧主会话的迟到结果据此拒绝 */
	ownerKey?: string;
	/** 当前扩展实例的结果接收函数；/reload 后由新实例接管，不复用旧 runtime */
	sink?: (message: BindingMessage | ResultMessage) => void;
}

export function runtimeStore(): RuntimeStore {
	const holder = globalThis as unknown as Record<symbol, RuntimeStore | undefined>;
	let value = holder[STORE_KEY];
	if (!value) {
		value = { instances: new Map(), servers: new Map() };
		holder[STORE_KEY] = value;
	}
	return value;
}

export function runtimeKey(ownerKey: string, name: string): string {
	return `${ownerKey}\u0000${name}`;
}

export function getRuntime(ownerKey: string, name: string): SubagentRuntime | undefined {
	return runtimeStore().instances.get(runtimeKey(ownerKey, name));
}

export function setRuntime(entry: SubagentRuntime): void {
	runtimeStore().instances.set(runtimeKey(entry.ownerKey, entry.name), entry);
}

export function removeRuntime(ownerKey: string, name: string): void {
	runtimeStore().instances.delete(runtimeKey(ownerKey, name));
}
