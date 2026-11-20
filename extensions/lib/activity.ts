/**
 * 进程级「忙」探测登记表。
 *
 * pi-herdr-agent 的空闲销毁要避开「进程里还有活干」的 agent：后台任务（pi-bg）与 cron
 * job（pi-cron）都活在本进程里，销毁进程等于把它们一起扔掉。两边的任务表都是私有状态
 * （pi-bg 在扩展闭包里，pi-cron 在 globalThis 上），所以在这里开一个极小的出口：谁有活
 * 谁注册一个探测函数，需要判定的一方汇总读取。
 *
 * 载体必须是 globalThis 上的符号：pi 的 loader 在 `/reload` 时会重新导入扩展模块
 * （moduleCache: false），模块级变量必丢，globalThis 是唯一能跨 reload 存活又不跨进程的
 * 载体（与 pi-cron 的 job 表同一理由）。
 *
 * 探测不到（扩展没加载、符号没声明、形状变了、函数抛错）一律按「不忙」处理——和
 * `lib/subagents.ts` 的口径一致。注册按名字覆盖，reload 后同名探测留在表里。
 */

const ACTIVITY_KEY = Symbol.for("vksir.pi-activity");

interface ActivityRegistry {
	probes: Map<string, () => boolean>;
}

function registry(): ActivityRegistry {
	const g = globalThis as unknown as Record<symbol, ActivityRegistry | undefined>;
	const current = g[ACTIVITY_KEY];
	if (current && current.probes instanceof Map) return current;
	const created: ActivityRegistry = { probes: new Map() };
	g[ACTIVITY_KEY] = created;
	return created;
}

/** 注册（或覆盖）一个忙探测：`name` 用扩展名，reload 后同名覆盖。 */
export function registerBusyProbe(name: string, probe: () => boolean): void {
	registry().probes.set(name, probe);
}

/** 是否有任何已注册的探测报告「忙」。 */
export function hasBusyActivity(): boolean {
	const probes = (globalThis as unknown as Record<symbol, ActivityRegistry | undefined>)[ACTIVITY_KEY]?.probes;
	if (!(probes instanceof Map)) return false;
	for (const probe of probes.values()) {
		try {
			if (probe() === true) return true;
		} catch {
			// 探测方自己的状态炸了不该拖住别人：跳过它，继续看下一个。
		}
	}
	return false;
}
