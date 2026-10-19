/**
 * Pi Notify Extension
 *
 * Sends a native terminal notification when Pi agent is done and waiting for input.
 * Supports multiple terminal protocols:
 * - OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * - OSC 99: Kitty
 * - Windows toast: 系统通知（按 process.platform 判断，任意终端都生效）
 *
 * Requires pi >= 1.3.0 (agent_settled 事件携带 aborted 字段)。
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** settings.json 中 "pi-notify" 键下的扩展配置 */
interface PiNotifySettings {
	/** 在 herdr 终端环境中禁用通知 */
	disableInHerdr?: boolean;
}

/** disableInHerdr 默认值：herdr 环境默认禁用通知 */
const DEFAULT_DISABLE_IN_HERDR = true;

function readSettings(pi: ExtensionAPI): Required<PiNotifySettings> {
	const raw = (pi.getSettings() as Record<string, unknown>)["pi-notify"];
	const s = typeof raw === "object" && raw !== null ? (raw as PiNotifySettings) : {};
	return { disableInHerdr: s.disableInHerdr ?? DEFAULT_DISABLE_IN_HERDR };
}

function basename(p: string): string {
    const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
    return idx >= 0 ? p.slice(idx + 1) : p;
}

function getTitle(): string {
    const cwdName = basename(process.cwd());
    return `π - ${cwdName}`;
}

function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notifyOSC99(title: string, body: string): void {
	// Kitty OSC 99: i=notification id, d=0 means not done yet, p=body for second part
	process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

function notifyWindows(title: string, body: string): void {
	// Install-Module -Name BurntToast
	// 单引号成对转义，防止目录名等文本破坏 PowerShell 命令
	const esc = (s: string) => s.replace(/'/g, "''");
	execFile("powershell.exe", ["-NoProfile", "-Command", `New-BurntToastNotification -Text '${esc(title)}', '${esc(body)}'`], { windowsHide: true });
}

function notify(title: string, body: string): void {
	if (process.platform === "win32") {
		notifyWindows(title, body);
	} else if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(title, body);
	} else {
		notifyOSC777(title, body);
	}
}

export default function (pi: ExtensionAPI) {
	const inHerdr = process.env.HERDR_ENV === "1";
	// getSettings 是 action 方法，工厂加载阶段不可用；首次通知时读取一次并缓存，
	// pi 重启或 /reload 重新加载扩展后缓存自动重建
	let disableInHerdr: boolean | undefined;

	// pi >= 1.3.0：agent_settled 事件自带 aborted 字段，无需再通过 agent_end + ctx.signal 跟踪
	pi.on("agent_settled", async (event, ctx) => {
		// 扩展也会在 RPC/JSON/print 模式下加载，
		// 直接写 process.stdout 会污染非交互输出，仅在 TUI 模式通知
		if (event.aborted || ctx.mode !== "tui") return;
		// herdr 环境默认禁用，settings.json 中 { "pi-notify": { "disableInHerdr": false } } 可开启
		if (inHerdr) {
			disableInHerdr ??= readSettings(pi).disableInHerdr;
			if (disableInHerdr) return;
		}
		notify(getTitle(), "Task Completed");
	});
}
