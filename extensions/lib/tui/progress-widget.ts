/**
 * progress 的进展行 —— 编辑器上方的 widget（`ctx.ui.setWidget`）。
 *
 * 展示位置：输入框上方、对话流与编辑器之间；不是 transcript 消息。最多 8 行，
 * 只显示当前轮次最近 8 条，更早的用 `/progress` 看。
 * 效果（3 条）：
 *
 *   20:14  Reading the failing test
 *   20:15  Patching the uploader
 *  ▌ 20:16  Running the auth tests
 *
 * 最新一条由 accent 竖块标出、正文用默认前景色；历史行正文 muted，时间统一 dim。
 * 单行截断，不折叠。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, TruncatedText } from "@earendil-works/pi-tui";

/** widget 最多显示多少条；超出的只留在 `/progress` 里。 */
export const MAX_PROGRESS_LINES = 8;

/** widget 只需要文本与写入时间。 */
export interface ProgressWidgetItem {
	text: string;
	at: number;
}

function clock(at: number): string {
	const date = new Date(at);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 渲染当前轮次的进展；扩展用 `ctx.ui.setWidget(key, (tui, theme) => renderProgressWidget(items, theme))` 挂上。 */
export function renderProgressWidget(items: readonly ProgressWidgetItem[], theme: Theme): Container {
	const container = new Container();
	const shown = items.slice(-MAX_PROGRESS_LINES);
	shown.forEach((item, index) => {
		const latest = index === shown.length - 1;
		const time = clock(item.at);
		// 历史行用空格占住竖块的位置，让时间戳对齐。
		const marker = latest ? theme.fg("accent", "▌") : " ";
		const line = `${marker} ${theme.fg("dim", time)}  ${theme.fg(latest ? "text" : "muted", item.text)}`;
		container.addChild(new TruncatedText(line, 1, 0));
	});
	return container;
}
