/**
 * Pi Title Extension
 *
 * 普通终端：在 Pi agent 运行时，为终端窗口标题添加旋转动画，
 * 指示 agent 正在活跃处理中。agent 结束后恢复原标题。
 *
 * herdr 环境：不改窗口标题，改为在 `/name` 更名会话时，同步重命名 pi 所在标签。
 * 两代 herdr 都支持：
 * - 旧 herdr（HERDR_ENV=1）：HERDR_TAB_ID 直接给出标签 id，经 herdr CLI
 *   （或注入的 HERDR_BIN_PATH）执行 `tab rename`。
 * - herdr app：HC_TERMINAL_ID 给出终端地址；先 `herdr-app ls` 解析出所在标签 id
 *   （实例内缓存，失败下次重试），再 `herdr-app do tab.rename`。
 * 两套 env 同时存在时优先旧 herdr（标签 id 直接可得，免去 ls 解析）。
 *
 * 子会话：进程内子 agent（如 @tintinweb/pi-subagents）会在同一进程里为子会话
 * 重新加载本扩展，并触发各自的 agent 与更名事件；其 ctx.mode 不是 "tui"。
 * 全部 handler 据此忽略子会话，标题与标签只由主 TUI 会话管理。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FRAMES = ["⠂", "⠐"];
const INTERVAL_MS = 960;

type SessionKey = ExtensionContext["sessionManager"];

// 活跃 session → 其 ctx。主 session 先插入，Map 迭代按插入序，主优先。
const activeSessions = new Map<SessionKey, ExtensionContext>();
let timer: ReturnType<typeof setInterval> | null = null;
let frame = 0;

function basename(p: string): string {
    const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
    return idx >= 0 ? p.slice(idx + 1) : p;
}

function getTitle(ctx: ExtensionContext): string {
    const session = ctx.sessionManager.getSessionName();
    const cwdName = basename(process.cwd());
    return session ? `π - ${session} - ${cwdName}` : `π - ${cwdName}`;
}

function pickCtx(): ExtensionContext | undefined {
    for (const ctx of activeSessions.values()) {
        return ctx;
    }
    return undefined;
}

function tick() {
    const ctx = pickCtx();
    if (!ctx) return;
    try {
        ctx.ui.setTitle(FRAMES[frame++ % FRAMES.length]);
    } catch {
        // ctx 可能已 stale（session 正在 shutdown），忽略本次写入。
    }
}

function start(ctx: ExtensionContext) {
    const sm = ctx.sessionManager;
    if (!activeSessions.has(sm)) {
        activeSessions.set(sm, ctx);
    }
    if (timer === null) {
        frame = 0;
        tick();
        timer = setInterval(tick, INTERVAL_MS);
    }
}

function stop(ctx: ExtensionContext, title: string) {
    const sm = ctx.sessionManager;
    activeSessions.delete(sm);
    if (activeSessions.size === 0) {
        if (timer !== null) {
            clearInterval(timer);
            timer = null;
        }
        frame = 0;
        ctx.ui.setTitle(title);
    }
}

function cleanup(ctx: ExtensionContext) {
    const sm = ctx.sessionManager;
    activeSessions.delete(sm);
    if (activeSessions.size === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
        frame = 0;
    }
}

// ---- herdr 标签更名（旧 herdr CLI 与 herdr app 双支持）----

/** 与 pi.exec 兼容的执行入口；测试用假实现替换。 */
export type Exec = (command: string, args: string[]) => Promise<{ code: number; stdout: string }>;

const HERDR_APP = "herdr-app";

function trimEnv(name: string): string | undefined {
    return process.env[name]?.trim() || undefined;
}

// Windows 下 spawn 不解析 PATH 与可执行扩展名，优先用 herdr 注入的绝对路径。
function legacyCommand(): string {
    return process.env.HERDR_BIN_PATH || "herdr";
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

/** pi 所在终端的地址；不在 herdr app 终端里时为空。 */
function herdrTerminalId(): string | undefined {
    return trimEnv("HC_TERMINAL_ID");
}

export default function (pi: ExtensionAPI) {
    // 终端归属的标签在其存活期间不变，成功解析的标签 id 在本扩展实例内缓存；
    // 失败不缓存，让下次 /name 重试（herdr-app ls 要窗口在开才能应答）。
    // 放在工厂闭包里而非模块级：进程内子 agent 会话各自加载本扩展，互不共享状态。
    let cachedTabId: string | undefined;

    async function resolveTabId(exec: Exec, terminalId: string): Promise<string | undefined> {
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

    // /name 可能连续执行，串行排队，保证最后一次重命名最终胜出。
    let renameQueue: Promise<void> = Promise.resolve();

    /**
     * 按 env 选出标签更名的执行体；不在任何 herdr 环境时为空。
     * 两套 env 同时存在时优先旧 herdr（标签 id 直接可得，免去 ls 解析）。
     * label 在入队前捕获：连续 /name 各自带走当时的会话名，队尾者最终胜出。
     */
    function pickRename(exec: Exec, label: string): (() => Promise<void>) | undefined {
        const legacyTabId = trimEnv("HERDR_TAB_ID");
        if (legacyTabId) {
            const command = legacyCommand();
            return () => exec(command, ["tab", "rename", legacyTabId, label]).then(() => undefined);
        }
        const terminalId = trimEnv("HC_TERMINAL_ID");
        if (!terminalId) return undefined;
        return async () => {
            const tabId = await resolveTabId(exec, terminalId);
            if (!tabId) return; // 窗口未开等场景静默放弃
            const { code } = await exec(HERDR_APP, ["do", "tab.rename", "--id", tabId, "--name", label]);
            if (code !== 0) cachedTabId = undefined; // 标签 id 可能已失效，下次重新解析
        };
    }

    function renameHerdrTab(exec: Exec, name: string | undefined): void {
        const label = name?.trim() ?? ""; // /name 清除会话名时同步清空标签
        const rename = pickRename(exec, label);
        if (!rename) return;
        renameQueue = renameQueue
            .then(rename)
            .catch(() => undefined); // 失败场景静默放弃
    }

    // herdr 环境下不注册动画事件，避免修改窗口标题（旧 herdr 或 herdr app 任一即算）。
    if (process.env.HERDR_ENV === "1" || herdrTerminalId()) {
        pi.on("session_info_changed", (event, ctx) => {
            // 子会话更名（子 agent 派生时的 setSessionName）不得触碰主 tab：
            // 标签寻址 env（HERDR_TAB_ID / HC_TERMINAL_ID）是进程级的，指向主 pi。
            if (ctx.mode !== "tui") return;
            renameHerdrTab((command, args) => pi.exec(command, args), event.name);
        });
        return;
    }

    pi.on("agent_start", async (_event, ctx) => {
        if (ctx.mode !== "tui") return;
        start(ctx);
    });

    pi.on("agent_settled", async (_event, ctx) => {
        if (ctx.mode !== "tui") return;
        stop(ctx, getTitle(ctx));
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        if (ctx.mode !== "tui") return;
        cleanup(ctx);
    });
}
