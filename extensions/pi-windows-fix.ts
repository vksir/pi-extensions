/**
 * pi-windows-fix —— Windows 修复扩展
 */

import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalize } from "node:path";

const IS_WIN32 = process.platform === "win32";
const TEMP_DIR = "C:\\Windows\\Temp";
const PATH_TOOLS = new Set(["write", "read", "edit", "grep", "find", "ls"]);

function fixPath(p: string): string {
  if (p.startsWith("/tmp")) {
    if (p.length === 4) return TEMP_DIR;
    if (p[4] === "/") return normalize(`${TEMP_DIR}${p.slice(4)}`);
  }
  return p;
}

function fixBashCommand(cmd: string): string {
  return cmd.replace(/> nul/gi, "> /dev/null");
}

export default function (pi: ExtensionAPI) {
  if (!IS_WIN32) return;

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
