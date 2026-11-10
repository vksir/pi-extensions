/**
 * 进程内子 agent 的存活探测。
 *
 * @tintinweb/pi-subagents 在 globalThis 上以 Symbol.for("pi-subagents:manager")
 * 暴露 manager 注册表（其 src/index.ts 的 MANAGER_KEY / registryEntry），
 * 成员 hasRunning() 覆盖 running 与 queued 两种状态。注册表由首个 activation
 * 声明，子会话不会覆盖，shutdown 时只在声明者处释放。
 *
 * 该符号没有版本号，也没有可用性事件：未安装、被 `extensions:` 过滤掉、以及
 * 注册表形状变化都表现为取不到，一律按「没有子 agent 在跑」处理。
 *
 * 无进程级状态，每次调用即读即判；仅供扩展以相对路径导入。
 */

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

/** 注册表中本模块用到的成员；其余成员（spawn、getRecord、waitForAll）不用。 */
interface ManagerRegistry {
	hasRunning?: () => boolean;
}

/** 是否仍有子 agent 在运行或排队。取不到注册表、形状不符或调用抛错都返回 false。 */
export function hasRunningSubagents(): boolean {
	const registry = (globalThis as unknown as Record<symbol, unknown>)[MANAGER_KEY] as ManagerRegistry | undefined;
	if (typeof registry?.hasRunning !== "function") return false;
	try {
		return registry.hasRunning() === true;
	} catch {
		return false;
	}
}
