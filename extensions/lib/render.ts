/**
 * 自定义 entry 的统一渲染：所有扩展的结果块都走同一个 Box + 行样式。
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

/** 一行 entry 文本；缺省 tone 表示使用终端默认前景色。 */
export interface EntryLine {
	text: string;
	tone?: ThemeColor;
}

/** 把若干行装进与 pi 原生提示块一致的内边距 Box。 */
export function renderLineBox(theme: Theme, lines: readonly EntryLine[]): Box {
	const box = new Box(1, 1);
	for (const line of lines) {
		box.addChild(new Text(line.tone ? theme.fg(line.tone, line.text) : line.text, 0, 0));
	}
	return box;
}

/** 整块统一着 dim 色的便捷写法；/balance、/token 的结果都用它。 */
export function renderDimLines(theme: Theme, lines: readonly string[]): Box {
	return renderLineBox(theme, lines.map((text) => ({ text, tone: "dim" })));
}
