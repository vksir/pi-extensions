/**
 * herdr / herdr-app 集成：环境探测，以及 pi 所在标签的更名。
 *
 * 两代 herdr 都通过注入的环境变量声明自己：
 * - 旧 herdr：HERDR_ENV=1 标记环境，HERDR_TAB_ID 直接给出 pi 所在标签 id，
 *   HERDR_BIN_PATH 注入 herdr CLI 路径。
 * - herdr app：herdr-core（herdr-app 的终端后端）向其运行的终端注入
 *   HC_TERMINAL_ID，给出 pi 所在终端的地址。
 *
 * 统一读取规则：所有变量一律 trim 后再判断，空白或未设置视同不存在；
 * HERDR_ENV 只有恰为 "1" 才算旧 herdr 环境。
 *
 * 标签更名只有旧 herdr 支持：HERDR_TAB_ID 直接寻址，经 herdr CLI 执行
 * tab rename。herdr app 只作环境声明（不改窗口标题、disableInHerdr 等
 * 环境判定由此走 inHerdrEnv），不做标签更名。
 *
 * 本模块无进程级状态；放在 lib/ 子目录（无 index.ts 与 package.json），
 * pi 的扩展发现不会把它当扩展加载，仅供扩展以相对路径导入。
 */

/** 与 pi.exec 兼容的执行入口；调用方注入，测试可用假实现替换。 */
export type Exec = (command: string, args: string[]) => Promise<{ code: number; stdout: string }>;

/** herdr 标签更名操作。 */
export interface TabRenamer {
	/** 把 pi 所在标签更名为 label；失败原样抛给调用方处置。 */
	rename(label: string): Promise<void>;
}

/** 读取并 trim 一个环境变量；未设置或纯空白时视同不存在。 */
function envValue(name: string): string | undefined {
	return process.env[name]?.trim() || undefined;
}

/** 是否处于任一代 herdr 环境。 */
export function inHerdrEnv(): boolean {
	return process.env.HERDR_ENV?.trim() === "1" || envValue("HC_TERMINAL_ID") !== undefined;
}

/** 旧 herdr CLI 命令名；herdr 注入 HERDR_BIN_PATH 时以其为准。 */
const HERDR_CLI = "herdr";

/**
 * 组装 pi 所在标签的更名操作。仅旧 herdr 支持（HERDR_TAB_ID 直接寻址）；
 * herdr app 环境或标签 id 缺失时为 undefined，如何处置由调用方决定。
 */
export function createTabRenamer(exec: Exec): TabRenamer | undefined {
	const tabId = envValue("HERDR_TAB_ID");
	if (!tabId) return undefined;
	// 命令优先用 herdr 注入的 HERDR_BIN_PATH——Windows 下 spawn 不解析 PATH
	// 与可执行扩展名，绝对路径才可靠。
	const command = envValue("HERDR_BIN_PATH") ?? HERDR_CLI;
	return {
		rename(label) {
			return exec(command, ["tab", "rename", tabId, label]).then(() => undefined);
		},
	};
}
