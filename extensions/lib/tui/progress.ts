/**
 * progress 的工具调用行 —— transcript 里的 tool call 区域。
 *
 * 展示位置：工具调用那一块的头（调用行）；结果行由 pi 的默认渲染接在下面。
 * 效果（折叠与展开相同，进展限定一句话）：
 *
 *   progress  Wiring the retry loop into the uploader
 *
 * 头行：工具名 `progress` 白色加粗，正文灰色。不做折叠。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** renderCall 只关心 `text` 这个字段。 */
export interface ProgressCallArgs {
	text?: string;
}

/** 渲染工具调用行；扩展用 `renderCall: renderProgressCall` 挂上。 */
export function renderProgressCall(args: ProgressCallArgs, theme: Theme): Text {
	const text = (args.text ?? "").replace(/\s+/g, " ").trim();
	const head = theme.fg("toolTitle", theme.bold("progress"));
	return new Text(text ? `${head} ${theme.fg("muted", text)}` : head, 0, 0);
}
