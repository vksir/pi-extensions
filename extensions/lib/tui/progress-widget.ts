/**
 * progress 的进展行 —— 编辑器上方的 widget（`ctx.ui.setWidget`）。
 *
 * 展示位置：输入框上方、对话流与编辑器之间的一行；不是 transcript 消息。
 * 效果：
 *
 *   ▸ Running the auth tests
 *
 * 前缀 `▸` 用 accent，正文默认前景色；单行截断，不折叠。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { TruncatedText } from "@earendil-works/pi-tui";

/** 渲染一行进展；扩展用 `ctx.ui.setWidget(key, (tui, theme) => renderProgressWidget(text, theme))` 挂上。 */
export function renderProgressWidget(text: string, theme: Theme): TruncatedText {
	const line = `${theme.fg("accent", "▸")} ${theme.fg("text", text)}`;
	return new TruncatedText(line, 1, 0);
}
