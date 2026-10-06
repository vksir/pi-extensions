/**
 * 子 Agent 实例的稳定身份。
 *
 *   ownerKey      = f(主会话 session ID, 主会话 session 文件绝对路径)
 *   子 session ID = f(ownerKey, 实例名)
 *
 * 身份不使用 PID、窗口标题或 Herdr 显示名称；丢失运行资源不等于丢失逻辑实例或对话历史。
 */
import { createHash } from "node:crypto";

function digest(scope: string, ...parts: string[]): string {
	return createHash("sha256").update([scope, ...parts].join("\0"), "utf8").digest("hex");
}

/** 主会话命名空间键，同时用作子 session 目录名。 */
export function ownerKeyOf(sessionId: string, sessionFile: string): string {
	return digest("vkzha.pi-subagent/owner", sessionId, sessionFile).slice(0, 32);
}

/** 子 session ID：以字母开头，只含字母数字与 `-`，满足 Pi 的 session ID 约束。 */
export function childSessionIdOf(ownerKey: string, name: string): string {
	return `sb-${digest("vkzha.pi-subagent/child", ownerKey, name).slice(0, 32)}`;
}

/**
 * Herdr agent 名必须匹配 `[a-z][a-z0-9_-]{0,31}`，且在同一 server 的所有存活 agent 中唯一。
 * 因此始终附带 ownerKey 与实例名的短哈希，使不同主会话的同名实例不会互相占用。
 * 它只服务 Herdr 的展示与识别；实例身份仍由 pane ID 决定，不靠这个显示名查找。
 */
export function herdrAgentNameOf(ownerKey: string, name: string): string {
	const suffix = digest("vkzha.pi-subagent/herdr", ownerKey, name).slice(0, 4);
	const ascii = name
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	const stem = (/^[a-z]/.test(ascii) ? ascii : `sb-${ascii.replace(/^-+/, "")}`).replace(/-+$/, "");
	const room = 32 - suffix.length - 1;
	const head = (stem || "sb").slice(0, room).replace(/-+$/, "") || "sb";
	return `${head}-${suffix}`;
}
