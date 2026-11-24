/**
 * agent 消息卡片 —— transcript 里的自定义消息（`pi.sendMessage` + `registerMessageRenderer`）。
 *
 * 展示位置：对话流里一张独立的卡片，和工具结果同级；不是用户输入行，也不跟 human 打字混在一起。
 * 效果（折叠）：
 *
 *   agent_message  ← reviewer (a7k2) · reply
 *   line01
 *   line02
 *   line03
 *   line04
 *   … 6 more lines · ctrl+o
 *
 * 展开（ctrl+o）后显示全文。头行 `agent_message` 加粗、用 `customMessageLabel`（默认主题是紫），
 * 整块铺 `customMessageBg`；类型色：task = accent、reply = success、notice = warning。
 * 正文顶格，不缩进。模型看到的仍是完整 XML，卡片只是 TUI 视图。
 */

import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { AgentMessageType } from "../agent-protocol.ts";

/** 自定义消息类型；会话文件里的 customType 也是它。 */
export const AGENT_MESSAGE = "pi-herdr-agent";

/** 折叠时最多显示几行正文。 */
export const COLLAPSED_LINES = 4;

export interface AgentMessageDetails {
	from: string;
	name?: string;
	type: AgentMessageType;
	body: string;
}

/** 渲染器本体；扩展用 `pi.registerMessageRenderer(AGENT_MESSAGE, agentMessageRenderer)` 挂上。 */
export const agentMessageRenderer: MessageRenderer<AgentMessageDetails> = (message, options, theme) => {
	const details = message.details;
	const body = details?.body ?? (typeof message.content === "string" ? message.content : "");
	const from = details?.from ?? "?";
	const who = details?.name ? `${details.name} (${from})` : from;
	const kind = details?.type ?? "task";
	const tone = kind === "reply" ? "success" : kind === "notice" ? "warning" : "accent";

	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	const label = theme.bold(theme.fg("customMessageLabel", "agent_message"));
	box.addChild(new Text(`${label}${theme.fg(tone, `  ← ${who} · ${kind}`)}`, 0, 0));
	if (!body) return box;

	const lines = body.split("\n");
	const collapsed = !options.expanded && lines.length > COLLAPSED_LINES;
	box.addChild(new Text((collapsed ? lines.slice(0, COLLAPSED_LINES) : lines).join("\n"), 0, 0));
	if (collapsed) {
		box.addChild(new Text(theme.fg("dim", `… ${lines.length - COLLAPSED_LINES} more lines · ctrl+o`), 0, 0));
	}
	return box;
};
