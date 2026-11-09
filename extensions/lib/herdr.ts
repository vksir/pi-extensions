/**
 * herdr / herdr-app 集成：环境探测、pi 所在标签的更名，以及在新标签里启动 pi。
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
 * 两代 herdr 都支持标签更名，寻址方式不同：旧 herdr 的 HERDR_TAB_ID 直接给出
 * 标签 id，经 herdr CLI 执行 tab rename；herdr app 的标签 id 不在 env 里，
 * 先 herdr-app ls 找到装着本终端的 tab，再 herdr-app do tab.rename（见
 * ADR-0005）。更名失败（窗口未开、终端不在窗口里等）抛错，由调用方静默处置。
 *
 * 新标签启动两代都支持，消息都即时送达：herdr app 一条 `tab.new`，消息经
 * `--` 进 pi 启动 argv（pi 就绪瞬间即处理，实测转义可靠；--task 首消息对
 * 带参 argv 不投递，弃用）；旧 herdr 四步——tab create、`pane run` 启动
 * pi（命令行只含 ASCII 安全参数）、轮询 agent list 等 idle、
 * `pane send-text` + `send-keys enter` 投递。全程不注册命名 agent。同一
 * 进程出现两代环境变量时按 herdr app 优先。
 *
 * 本模块无进程级状态；放在 lib/ 子目录（无 index.ts 与 package.json），
 * pi 的扩展发现不会把它当扩展加载，仅供扩展以相对路径导入。
 */

// ─── 公共类型 ───

/** 与 pi.exec 兼容的执行入口；调用方注入，测试可用假实现替换。 */
export type Exec = (command: string, args: string[]) => Promise<{
	code: number;
	stdout: string;
	/** pi.exec 会带 stderr；注入方省略时错误摘要退回 stdout。 */
	stderr?: string;
}>;

/** herdr 标签更名操作。 */
export interface TabRenamer {
	/** 把 pi 所在标签更名为 label；失败原样抛给调用方处置。 */
	rename(label: string): Promise<void>;
}

// ─── 环境探测 ───

/** 读取并 trim 一个环境变量；未设置或纯空白时视同不存在。 */
function envValue(name: string): string | undefined {
	return process.env[name]?.trim() || undefined;
}

/** 旧 herdr CLI 命令名；herdr 注入 HERDR_BIN_PATH 时以其为准。 */
const HERDR_CLI = "herdr";

/** herdr app CLI 命令名；herdr app 不注入二进制路径，从 PATH 解析。 */
const HERDR_APP_CLI = "herdr-app";

/** 是否处于旧 herdr 环境（HERDR_ENV 恰为 "1"）。 */
function inLegacyHerdr(): boolean {
	return process.env.HERDR_ENV?.trim() === "1";
}

/** 是否处于任一代 herdr 环境。 */
export function inHerdrEnv(): boolean {
	return inLegacyHerdr() || envValue("HC_TERMINAL_ID") !== undefined;
}

/** 旧 herdr CLI 命令：优先注入的 HERDR_BIN_PATH（Windows 下绝对路径才可靠）。 */
function herdrCommand(): string {
	return envValue("HERDR_BIN_PATH") ?? HERDR_CLI;
}

/** 从失败结果里抽一句人话：stderr 优先，退回 stdout，各截 200 字符。 */
function failureDetail(result: { stdout: string; stderr?: string }): string {
	const detail = (result.stderr?.trim() || result.stdout.trim()).slice(0, 200);
	return detail ? `：${detail}` : "";
}

// ─── 新标签启动 ───

/**
 * 新标签启动参数。message 是交给新 pi 的首条消息，随启动 argv 递交（经
 * `--` 停止选项解析，pi 就绪瞬间即处理）。不指定标签名：标签沿用 herdr
 * 的默认命名（编号）。
 */
export interface TabLaunchOptions {
	/** 新 pi 启动后收到的首条消息。 */
	message: string;
	/** fork 进新 pi 的会话文件；给出时新 pi 以 `--fork <file>` 启动。 */
	forkSession?: string;
	/** 新 pi 的工作目录；缺省取进程当前目录。 */
	cwd?: string;
}

/** 新标签启动操作。 */
export interface TabLauncher {
	/** 在新标签里启动 pi 并递交首条消息；失败原样抛给调用方处置。 */
	launch(options: TabLaunchOptions): Promise<void>;
}

/**
 * herdr app：一条 `tab.new` 搞定新标签、pi 启动与首条消息——消息经
 * `--` 分隔符进 pi 的启动 argv，pi 就绪瞬间即开始处理，零额外等待
 * （实测 herdr 的 pwsh 包装对引号/$/反引号/多行/中文转义可靠；
 * `--task` 首消息机制对带参 argv 不投递，hc send 又要等就绪，均弃用）。
 */
function createAppTabLauncher(exec: Exec): TabLauncher {
	return {
		async launch({ message, forkSession, cwd }) {
			const result = await exec(HERDR_APP_CLI, [
				"do",
				"tab.new",
				"--folder",
				cwd ?? process.cwd(),
				"--argv",
				piArgv(message, forkSession),
			]);
			if (result.code !== 0) throw appFailure("tab.new", result);
		},
	};
}

/**
 * pi 的启动 argv：fork 参数与首条消息（经 `--` 停止选项解析，消息可以
 * 以 `-` 开头）一起进 argv，pi 就绪瞬间即处理首条消息。
 */
function piArgv(message: string, forkSession: string | undefined): string {
	const argv = forkSession ? ["pi", "--fork", forkSession] : ["pi"];
	return JSON.stringify([...argv, "--", message]);
}

/** herdr app 的 `do` 失败时 stdout 是 `{"error": "..."}`，优先取出 error 字段。 */
function appFailure(step: string, result: { code: number; stdout: string; stderr?: string }): Error {
	let detail: string | undefined;
	try {
		const error = JSON.parse(result.stdout)?.error;
		if (typeof error === "string" && error) detail = error;
	} catch {
		// stdout 不是 JSON，退回 stderr/stdout 摘要。
	}
	detail ??= (result.stderr?.trim() || result.stdout.trim()).slice(0, 200) || undefined;
	return new Error(`herdr-app ${step} 失败（code ${result.code}）${detail ? `：${detail}` : ""}`);
}

/** 旧 herdr `tab create` 的 JSON 输出里取出新标签根 pane 的 id。 */
function parseRootPane(stdout: string): string {
	let pane: unknown;
	try {
		const root = JSON.parse(stdout)?.result?.root_pane;
		// root_pane 可能直接是 id 字符串，也可能是 pane 详情对象（id 在 pane_id 字段）。
		pane = typeof root === "string" ? root : root?.pane_id;
	} catch {
		// 输出不是 JSON，pane 保持 undefined，走下面的统一报错。
	}
	if (typeof pane === "string" && pane) return pane;
	const excerpt = stdout.trim().slice(0, 200);
	throw new Error(`无法从 herdr tab create 输出解析 root_pane${excerpt ? `：${excerpt}` : ""}`);
}

/** 就绪轮询间隔与总超时；测试可注入小值。 */
export interface LauncherOptions {
	pollMs?: number;
	readyTimeoutMs?: number;
}

const LEGACY_POLL_MS = 500;
const LEGACY_READY_TIMEOUT_MS = 60000;

/**
 * 轮询 `agent list` 直到 herdr 在目标 pane 识别出 pi 且状态为 idle。
 * agent 刚被检测到时 agent_status 是 "unknown"，此时 TUI 尚未就绪，
 * 不能投递；等到真实状态（idle）再发（实测 ~0.5s）。
 */
async function waitLegacyIdle(
	exec: Exec,
	command: string,
	pane: string,
	pollMs: number,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let last = "";
	while (Date.now() < deadline) {
		const probe = await exec(command, ["agent", "list"]);
		last = (probe.stderr?.trim() || probe.stdout.trim()).slice(0, 200);
		if (probe.code === 0) {
			let ready = false;
			try {
				const agents = JSON.parse(probe.stdout)?.result?.agents;
				ready =
					Array.isArray(agents) &&
					agents.some((a) => a?.pane_id === pane && a?.agent === "pi" && a?.agent_status === "idle");
			} catch {
				// 非 JSON 输出视为未就绪，继续轮询。
			}
			if (ready) return;
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
	throw new Error(`pi 未在 ${timeoutMs}ms 内就绪（herdr agent list${last ? `：${last}` : ""}）`);
}

/**
 * 旧 herdr：四步编排——建标签、`pane run` 启动 pi（命令行只含 ASCII 安全
 * 的启动参数：pane run 是把命令逐字敲进 shell，用户消息绝不能在这里）、
 * 轮询等 herdr 识别 pi 就绪、`pane send-text` + `send-keys enter` 逐字
 * 投递消息。全程不注册命名 agent（`agent start` 强制命名，弃用）。
 */
function createLegacyTabLauncher(exec: Exec, options?: LauncherOptions): TabLauncher {
	const pollMs = options?.pollMs ?? LEGACY_POLL_MS;
	const readyTimeoutMs = options?.readyTimeoutMs ?? LEGACY_READY_TIMEOUT_MS;
	return {
		async launch({ message, forkSession, cwd }) {
			const command = herdrCommand();
			const created = await exec(command, ["tab", "create", "--cwd", cwd ?? process.cwd()]);
			if (created.code !== 0) {
				throw new Error(`herdr tab create 失败（code ${created.code}）${failureDetail(created)}`);
			}
			const pane = parseRootPane(created.stdout);
			// fork 路径单引号包裹：PowerShell 与 POSIX shell 都按字面量解析
			// （Windows 路径不可能含单引号；Unix 路径含单引号时才需另行处理）。
			const runArgs = ["pane", "run", pane, "pi"];
			if (forkSession) runArgs.push("--fork", `'${forkSession}'`);
			const launched = await exec(command, runArgs);
			if (launched.code !== 0) {
				throw new Error(`herdr pane run 失败（code ${launched.code}）${failureDetail(launched)}`);
			}
			await waitLegacyIdle(exec, command, pane, pollMs, readyTimeoutMs);
			const typed = await exec(command, ["pane", "send-text", pane, message]);
			if (typed.code !== 0) {
				throw new Error(`herdr pane send-text 失败（code ${typed.code}）${failureDetail(typed)}`);
			}
			const enter = await exec(command, ["pane", "send-keys", pane, "enter"]);
			if (enter.code !== 0) {
				throw new Error(`herdr pane send-keys 失败（code ${enter.code}）${failureDetail(enter)}`);
			}
		},
	};
}

/**
 * 组装「新标签启动 pi」操作。两代 herdr 都支持；不在 herdr 环境时为
 * undefined，如何处置由调用方决定。同一进程出现两代 herdr 的环境变量时
 * 按 herdr app 优先。
 */
export function createTabLauncher(exec: Exec, options?: LauncherOptions): TabLauncher | undefined {
	if (envValue("HC_TERMINAL_ID") !== undefined) return createAppTabLauncher(exec);
	if (inLegacyHerdr()) return createLegacyTabLauncher(exec, options);
	return undefined;
}

// ─── 标签更名 ───

/** herdr-app ls 输出里本模块需要的最小形状：spaces > tabs > terminals。 */
interface AppLsTerminal {
	terminal: string;
}

interface AppLsTab {
	id: string;
	terminals?: AppLsTerminal[];
}

interface AppLsSpace {
	tabs?: AppLsTab[];
}

interface AppLsOutput {
	spaces?: AppLsSpace[];
}

/** 从 herdr-app ls 的 JSON 输出里找装着给定终端的 tab id；找不到或输出不合法返回 undefined。 */
function findTabId(lsOutput: string, terminalId: string): string | undefined {
	let parsed: AppLsOutput;
	try {
		parsed = JSON.parse(lsOutput) as AppLsOutput;
	} catch {
		return undefined;
	}
	for (const space of parsed.spaces ?? []) {
		for (const tab of space.tabs ?? []) {
			if ((tab.terminals ?? []).some((t) => t.terminal === terminalId)) return tab.id;
		}
	}
	return undefined;
}

/**
 * herdr app 的更名：每次先 ls 寻址再 tab.rename。不缓存 tab id——用户可以把
 * 终端挪去别的 tab，缓存会悄悄改错对象；更名是低频操作，多一次 ls 无妨。
 */
function createAppTabRenamer(exec: Exec, terminalId: string): TabRenamer {
	return {
		async rename(label) {
			const ls = await exec(HERDR_APP_CLI, ["ls"]);
			if (ls.code !== 0) throw new Error(`herdr-app ls 失败（code ${ls.code}）${failureDetail(ls)}`);
			const tabId = findTabId(ls.stdout, terminalId);
			if (!tabId) throw new Error(`终端 ${terminalId} 不在任何已打开的标签里，无法更名`);
			const renamed = await exec(HERDR_APP_CLI, ["do", "tab.rename", "--id", tabId, "--name", label]);
			if (renamed.code !== 0) {
				throw new Error(`herdr-app tab.rename 失败（code ${renamed.code}）${failureDetail(renamed)}`);
			}
		},
	};
}

/**
 * 组装 pi 所在标签的更名操作。旧 herdr（HERDR_TAB_ID 直接寻址）与 herdr app
 * （HC_TERMINAL_ID，ls 寻址）都支持；两套 env 都缺失时为 undefined，如何处置
 * 由调用方决定。同一进程出现两代 env 时旧 herdr 优先——HERDR_TAB_ID 是唯一
 * 直接给出标签寻址的变量，无需查询。
 */
export function createTabRenamer(exec: Exec): TabRenamer | undefined {
	const tabId = envValue("HERDR_TAB_ID");
	if (tabId) {
		// 命令优先用 herdr 注入的 HERDR_BIN_PATH——Windows 下 spawn 不解析 PATH
		// 与可执行扩展名，绝对路径才可靠。
		const command = herdrCommand();
		return {
			rename(label) {
				return exec(command, ["tab", "rename", tabId, label]).then(() => undefined);
			},
		};
	}
	const terminalId = envValue("HC_TERMINAL_ID");
	if (terminalId) return createAppTabRenamer(exec, terminalId);
	return undefined;
}
