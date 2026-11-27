/**
 * progress 的进展行 —— 编辑器上方的 widget（`ctx.ui.setWidget`）。
 *
 * 展示位置：输入框上方、对话流与编辑器之间；不是 transcript 消息。默认最多 3 行，
 * 条数由 settings 的 `pi-progress.maxLines` 决定；更早的用 `/progress` 看。
 * 效果（3 条）：
 *
 *   20:14  Reading the failing test
 *   20:15  Patching the uploader
 *  ▌ 20:16  Running the auth tests
 *
 * 最新一条由 accent 竖块与紫色正文标出；历史行正文与时间都用 dim，和 footer 统计行同色。
 * 单行截断，不折叠。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, TruncatedText } from "@earendil-works/pi-tui";

/** 默认显示条数；扩展用 settings 的 `maxLines` 覆盖。 */
export const DEFAULT_MAX_PROGRESS_LINES = 3;

/** widget 只需要文本与写入时间。 */
export interface ProgressWidgetItem {
	text: string;
	at: number;
}

function clock(at: number): string {
	const date = new Date(at);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 渲染当前轮次的进展；扩展用 `ctx.ui.setWidget(key, (tui, theme) => renderProgressWidget(items, theme, maxLines))` 挂上。 */
export function renderProgressWidget(
	items: readonly ProgressWidgetItem[],
	theme: Theme,
	maxLines = DEFAULT_MAX_PROGRESS_LINES,
): Container {
	const container = new Container();
	const shown = items.slice(-Math.max(1, Math.floor(maxLines)));
	shown.forEach((item, index) => {
		const latest = index === shown.length - 1;
		const time = clock(item.at);
		// 历史行用空格占住竖块的位置，让时间戳对齐。
		const marker = latest ? theme.fg("accent", "▌") : " ";
		const line = `${marker} ${theme.fg("dim", time)}  ${theme.fg(latest ? "accent" : "dim", item.text)}`;
		container.addChild(new TruncatedText(line, 1, 0));
	});
	return container;
}
