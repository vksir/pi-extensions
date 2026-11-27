/**
 * progress 的进展行 —— 编辑器上方的 widget（`ctx.ui.setWidget`）。
 *
 * 展示位置：输入框上方、对话流与编辑器之间；不是 transcript 消息。最多 8 行，
 * 只显示当前轮次最近 8 条，更早的用 `/progress` 看。
 * 效果（4 条）：
 *
 *    ▸ Reading the failing test
 *    ▸ Patching the uploader
 *    ▸ Running the auth tests
 *    ▸ Wiring the retry loop
 *
 * 最新一条用默认前景色，更早的用 muted；前缀 `▸` 用 accent。单行截断，不折叠。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, TruncatedText } from "@earendil-works/pi-tui";

/** widget 最多显示多少条；超出的只留在 `/progress` 里。 */
export const MAX_PROGRESS_LINES = 8;

/** 渲染当前轮次的进展；扩展用 `ctx.ui.setWidget(key, (tui, theme) => renderProgressWidget(texts, theme))` 挂上。 */
export function renderProgressWidget(texts: readonly string[], theme: Theme): Container {
	const container = new Container();
	const shown = texts.slice(-MAX_PROGRESS_LINES);
	shown.forEach((text, index) => {
		const tone = index === shown.length - 1 ? "text" : "muted";
		const line = `${theme.fg("accent", "▸")} ${theme.fg(tone, text)}`;
		container.addChild(new TruncatedText(line, 1, 0));
	});
	return container;
}
