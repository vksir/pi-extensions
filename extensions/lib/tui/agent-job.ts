/**
 * agent_job 的工具调用行 —— transcript 里的 tool call 区域。
 *
 * 展示位置：工具调用那一块的头（调用行）；结果行由 pi 的默认渲染接在下面。
 * 效果（折叠）：
 *
 *   agent_job send 21f943
 *   line01
 *   line02
 *   line03
 *   … (3 more lines, ctrl+o to expand)
 *   Sent to 21f943 (reviewer).
 *
 * 展开（ctrl+o）后显示全部正文。头行：工具名 `agent_job` 白色加粗，子动作（send/stop）与 `name (id)` 灰色；
 * 正文用 `muted`；list / stop 只出头行，不带正文。
 */

import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { agentLabel } from "./names.ts";

/** 工具调用行只关心这三个字段；具体参数类型由扩展保证。 */
export interface AgentJobCallArgs {
	action?: string;
	id?: string;
	message?: string;
}

/** 折叠时最多显示几行、每行多少字符。 */
const ARG_PREVIEW_LINES = 3;
const ARG_PREVIEW_CHARS = 100;

/**
 * 参数预览：折叠时最多 3 行、每行 100 字符；有截断就追加 `… (N more lines, ctrl+o to expand)`。
 * `hint` 由调用方用 `context.keyHint("app.tools.expand", "to expand")` 生成，跟随用户的键位设置。
 */
export function previewArg(text: string, expanded: boolean, theme: Theme, hint: string): string {
	const normalized = text.replace(/\r/g, "").trimEnd();
	if (expanded) return normalized;
	const all = normalized.split("\n");
	const shown = all
		.slice(0, ARG_PREVIEW_LINES)
		.map((line) => (line.length <= ARG_PREVIEW_CHARS ? line : `${line.slice(0, ARG_PREVIEW_CHARS - 1)}…`));
	const hidden = all.length - shown.length;
	const clipped = hidden > 0 || shown.some((line, index) => line !== all[index]);
	if (!clipped) return shown.join("\n");
	const detail = hidden > 0 ? `${hidden} more line${hidden === 1 ? "" : "s"}` : "truncated";
	return `${shown.join("\n")}\n${theme.fg("dim", `… (${detail}, `)}${hint}${theme.fg("dim", ")")}`;
}

/** 渲染工具调用行；扩展用 `createAgentJobRenderCall(resolveName)` 产出后挂到 `agent_job.renderCall`。 */
export function createAgentJobRenderCall(
	resolveName: (id: string) => string | undefined,
): NonNullable<ToolRenderers["renderCall"]> {
	return (raw, theme, context) => {
		const args = raw as unknown as AgentJobCallArgs;
		const action = args.action ?? "";
		const verb = `${theme.fg("toolTitle", theme.bold("agent_job"))} ${theme.fg("muted", action)}`;
		const head = args.id ? `${verb} ${theme.fg("muted", agentLabel(args.id, resolveName(args.id)))}` : verb;
		if (args.action !== "send" || !args.message) return new Text(head, 0, 0);

		const hint = context.keyHint("app.tools.expand", "to expand");
		return new Text(`${head}\n${theme.fg("muted", previewArg(args.message, context.expanded, theme, hint))}`, 0, 0);
	};
}
