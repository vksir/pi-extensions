/**
 * Pi Title Animation Extension
 *
 * 在 Pi agent 运行时，为终端窗口标题添加旋转动画，
 * 指示 agent 正在活跃处理中。agent 结束后恢复原标题。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FRAMES = ["⠂", "⠐"];
const INTERVAL_MS = 960;
let timer: ReturnType<typeof setInterval> | null = null;
let i = 0;

function basename(p: string): string {
    const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
    return idx >= 0 ? p.slice(idx + 1) : p;
}

function getTitle(ctx: ExtensionContext): string {
    const session = ctx.sessionManager.getSessionName();
    const cwdName = basename(process.cwd());
    return session ? `π - ${session} - ${cwdName}` : `π - ${cwdName}`;
}

function start(ctx: ExtensionContext) {
    if (timer !== null) return;
    i = 0;
    const tick = () => {
        ctx.ui.setTitle(FRAMES[i++ % FRAMES.length]);
    };
    tick();
    timer = setInterval(tick, INTERVAL_MS);
}

function stop(ctx: ExtensionContext, title: string) {
    if (timer !== null) {
        clearInterval(timer);
        timer = null;
    }
    i = 0;
    ctx.ui.setTitle(title);
}

export default function (pi: ExtensionAPI) {
    pi.on("agent_start", async (_event, ctx) => {
        start(ctx);
    });

    pi.on("agent_settled", async (_event, ctx) => {
        const title = getTitle(ctx);
        stop(ctx, title);
    });

    pi.on("session_shutdown", async () => {
        if (timer !== null) {
            clearInterval(timer);
            timer = null;
        }
        i = 0;
    });
}
