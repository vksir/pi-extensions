/**
 * `agent`（拉起 / resume）的工具行 —— transcript 里的 tool call 区域。
 *
 * 展示位置：工具调用那一块的头（调用行）+ 结果行；结果行用 details 里的 id/name 补全。
 * 效果：
 *
 *   agent reviewer
 *   Fix the login redirect. Steps:
 *   1. read src/auth.ts
 *   … (2 more lines, ctrl+o to expand)
 *   reviewer (7f3a) · started
 *
 *   agent resume reviewer (a7k2)
 *   继续，把缺失的测试补上
 *   reviewer (a7k2) · resumed
 *
 * 头行：工具名 `agent` 白色加粗（`toolTitle`），`resume`、名字、id 都是灰色；
 * 正文 `muted`，折叠 3 行 / 每行 100 字符；结果行 `muted`，出错时用 `error`。
 * 拉起的 id 到结果行才能拿到，头行只有名字。
 */

import type { AgentToolResult, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { previewArg } from "./agent-job.ts";
import { agentLabel } from "./names.ts";

export interface AgentLaunchArgs {
	prompt?: string;
	name?: string;
	resume?: string;
}

export interface AgentLaunchDetails {
	action?: "start" | "resume" | "list" | "stop" | "send";
	id?: string;
	name?: string;
}

/** 结果里的第一段文本（错误信息也走这里）。 */
function resultText(result: AgentToolResult<unknown>): string {
	const block = result.content?.[0];
	return block && block.type === "text" ? block.text : "";
}

/** 生成 `agent` 工具的 renderCall / renderResult；`resolveName` 用来把 resume 的 id 补成 `name (id)`。 */
export function createAgentLaunchRenderers(
	resolveName: (id: string) => string | undefined,
): Pick<ToolRenderers, "renderCall" | "renderResult"> {
	const renderCall: NonNullable<ToolRenderers["renderCall"]> = (raw, theme, context) => {
		const args = raw as AgentLaunchArgs;
		const tool = theme.fg("toolTitle", theme.bold("agent"));
		const verb = args.resume ? `${tool} ${theme.fg("muted", "resume")}` : tool;
		const target = args.resume ? agentLabel(args.resume, resolveName(args.resume)) : args.name;
		const head = target ? `${verb} ${theme.fg("muted", target)}` : verb;
		if (!args.prompt) return new Text(head, 0, 0);

		const hint = context.keyHint("app.tools.expand", "to expand");
		return new Text(`${head}\n${theme.fg("muted", previewArg(args.prompt, context.expanded, theme, hint))}`, 0, 0);
	};

	const renderResult: NonNullable<ToolRenderers["renderResult"]> = (result, _options, theme) => {
		const details = result.details as AgentLaunchDetails | undefined;
		if (result.isError) return new Text(theme.fg("error", resultText(result)), 0, 0);
		if (!details?.id) return new Text(theme.fg("muted", resultText(result)), 0, 0);

		const who = agentLabel(details.id, details.name);
		return new Text(theme.fg("muted", `${who} · ${details.action === "resume" ? "resumed" : "started"}`), 0, 0);
	};

	return { renderCall, renderResult };
}
