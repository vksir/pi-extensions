/**
 * Pi Title Extension
 *
 * 普通终端：在 Pi agent 运行时，为终端窗口标题添加旋转动画，
 * 指示 agent 正在活跃处理中。agent 结束后恢复原标题。
 *
 * HERDR 环境：不改窗口标题，改为在 `/name` 更名会话时，
 * 通过 herdr CLI 同步重命名当前标签。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

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

// ---- HERDR 标签更名 ----

// Windows 下 spawn 不解析 PATH 与可执行扩展名，优先用 herdr 注入的绝对路径。
function herdrCommand(): string {
    return process.env.HERDR_BIN_PATH || "herdr";
}

// /name 可能连续执行，串行排队，保证最后一次重命名最终胜出。
let renameQueue: Promise<void> = Promise.resolve();

function renameHerdrTab(name: string | undefined): void {
    const tabId = process.env.HERDR_TAB_ID;
    if (!tabId) return;
    const label = name?.trim() ?? ""; // /name 清除会话名时同步清空标签
    renameQueue = renameQueue
        .then(() => execFileAsync(herdrCommand(), ["tab", "rename", tabId, label], { windowsHide: true }))
        .then(() => undefined, () => undefined); // herdr 未运行等失败场景静默放弃
}

export default function (pi: ExtensionAPI) {
    // HERDR 环境下不注册动画事件，避免修改窗口标题。
    if (process.env.HERDR_ENV === "1") {
        pi.on("session_info_changed", (event) => {
            renameHerdrTab(event.name);
        });
        return;
    }

    pi.on("agent_start", async (_event, ctx) => {
        start(ctx);
    });

    pi.on("agent_settled", async (_event, ctx) => {
        stop(ctx, getTitle(ctx));
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        cleanup(ctx);
    });
}
