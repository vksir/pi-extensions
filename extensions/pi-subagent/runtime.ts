/**
 * 运行态：主会话／实例名 → 本扩展拥有的 Herdr 运行位置。
 *
 * 这张表挂在固定的 globalThis Symbol 上，而不是扩展模块的局部变量：pi 在 `/reload` 时
 * 会重新导入扩展模块（jiti, moduleCache: false），模块级变量必然丢失（ADR-0001）。
 * 表中只登记运行资源；丢失它不等于丢失逻辑实例、名称绑定或对话历史。
 */
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

interface RuntimeStore {
	instances: Map<string, SubagentRuntime>;
}

function store(): RuntimeStore {
	const holder = globalThis as unknown as Record<symbol, RuntimeStore | undefined>;
	let value = holder[STORE_KEY];
	if (!value) {
		value = { instances: new Map() };
		holder[STORE_KEY] = value;
	}
	return value;
}

export function runtimeKey(ownerKey: string, name: string): string {
	return `${ownerKey}\u0000${name}`;
}

export function getRuntime(ownerKey: string, name: string): SubagentRuntime | undefined {
	return store().instances.get(runtimeKey(ownerKey, name));
}

export function setRuntime(entry: SubagentRuntime): void {
	store().instances.set(runtimeKey(entry.ownerKey, entry.name), entry);
}
