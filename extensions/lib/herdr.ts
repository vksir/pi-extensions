/**
 * herdr / herdr-app 集成：环境探测，以及 pi 所在标签的寻址与更名。
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
 * 标签更名（createTabRenamer）按 env 选出所在一代，两套 env 同时存在时
 * 优先旧 herdr（标签 id 直接可得，免去 ls 解析）。herdr app 的标签 id 需经
 * `herdr-app ls` 从标签树解析：终端归属的标签在其存活期间不变，成功解析的
 * id 在 renamer 实例内缓存，失败不缓存、下次更名重试（ls 要窗口在开才能应答）。
 *
 * rename 的失败语义：CLI 缺失、退出码非零等错误原样抛给调用方处置；
 * 仅「解析不出标签 id」（窗口未开等）视为放弃而不报错。
 *
 * 本模块无进程级状态，renamer 每实例自带缓存；放在 lib/ 子目录
 * （无 index.ts 与 package.json），pi 的扩展发现不会把它当扩展加载，
 * 仅供扩展以相对路径导入。
 */

/** 与 pi.exec 兼容的执行入口；调用方注入，测试可用假实现替换。 */
export type Exec = (command: string, args: string[]) => Promise<{ code: number; stdout: string }>;

/** herdr 标签更名操作。 */
export interface TabRenamer {
	/** 把 pi 所在标签更名为 label；失败语义见模块注释。 */
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

/** herdr app CLI 命令名。 */
const HERDR_APP = "herdr-app";

/**
 * 旧 herdr CLI 命令；优先用 herdr 注入的 HERDR_BIN_PATH——
 * Windows 下 spawn 不解析 PATH 与可执行扩展名，绝对路径才可靠。
 */
function legacyCommand(): string {
	return envValue("HERDR_BIN_PATH") ?? HERDR_CLI;
}

interface HerdrLsTerminal {
	terminal?: string;
}

interface HerdrLsTab {
	id?: string;
	terminals?: HerdrLsTerminal[];
}

interface HerdrLsTree {
	spaces?: { tabs?: HerdrLsTab[] }[];
}

/**
 * 按注入的 env 组装 pi 所在标签的更名操作；两套 env 同时存在时优先旧 herdr。
 * env 声明了 herdr 但寻址信息不全（如 HERDR_ENV=1 而标签 id 缺失）时为
 * undefined，此时如何处置由调用方决定。
 */
export function createTabRenamer(exec: Exec): TabRenamer | undefined {
	const legacyTabId = envValue("HERDR_TAB_ID");
	if (legacyTabId) {
		return {
			rename(label) {
				return exec(legacyCommand(), ["tab", "rename", legacyTabId, label]).then(() => undefined);
			},
		};
	}
	const terminalId = envValue("HC_TERMINAL_ID");
	if (!terminalId) return undefined;
	// 终端归属的标签在其存活期间不变，成功解析的标签 id 在实例内缓存；
	// 失败不缓存，让下次 rename 重试（herdr-app ls 要窗口在开才能应答）。
	let cachedTabId: string | undefined;
	async function resolveTabId(): Promise<string | undefined> {
		if (cachedTabId !== undefined) return cachedTabId;
		let stdout: string;
		try {
			({ stdout } = await exec(HERDR_APP, ["ls"]));
		} catch {
			return undefined;
		}
		try {
			const tree = JSON.parse(stdout) as HerdrLsTree;
			for (const space of tree.spaces ?? []) {
				for (const tab of space.tabs ?? []) {
					if ((tab.terminals ?? []).some((t) => t.terminal === terminalId)) {
						cachedTabId = tab.id;
						return cachedTabId;
					}
				}
			}
		} catch {
			// ls 输出不是预期 JSON，下次重试。
		}
		return undefined;
	}
	return {
		async rename(label) {
			const tabId = await resolveTabId();
			if (!tabId) return; // 窗口未开等场景静默放弃
			const { code } = await exec(HERDR_APP, ["do", "tab.rename", "--id", tabId, "--name", label]);
			if (code !== 0) cachedTabId = undefined; // 标签 id 可能已失效，下次重新解析
		},
	};
}
