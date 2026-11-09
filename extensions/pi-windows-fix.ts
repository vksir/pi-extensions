/**
 * pi-windows-fix —— Windows 修复扩展
 *
 * 在工具真正执行前改写两类 Windows 不兼容写法：
 * - 路径工具（write/read/edit/grep/find/ls）里的 `/tmp/...` → 系统临时目录；
 * - bash 命令里的 `>nul` → `>/dev/null`。
 *
 * 非 Windows 平台不注册任何 handler。
 */

import { tmpdir } from "node:os";
import { normalize } from "node:path";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const IS_WINDOWS = process.platform === "win32";
const TEMP_DIR = tmpdir();
const PATH_TOOLS = new Set(["write", "read", "edit", "grep", "find", "ls"]);

// ─── 路径与命令修复 ───

function fixPath(path: string): string {
	if (!path.startsWith("/tmp")) return path;
	if (path.length === 4) return TEMP_DIR;
	if (path[4] === "/") return normalize(`${TEMP_DIR}${path.slice(4)}`);
	return path;
}

function fixBashCommand(command: string): string {
	return command.replace(/> ?nul\b/gi, ">/dev/null");
}

// ─── 扩展入口 ───

export default function (pi: ExtensionAPI) {
	if (!IS_WINDOWS) return;

	pi.on("tool_call", (event) => {
		if (PATH_TOOLS.has(event.toolName)) {
			const input = event.input as { path?: string };
			if (input?.path) input.path = fixPath(input.path);
			return;
		}
		if (isToolCallEventType("bash", event)) {
			event.input.command = fixBashCommand(event.input.command);
		}
	});
}
