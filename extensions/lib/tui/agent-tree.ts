/**
 * /agent list 的树卡片 —— transcript 里的自定义 entry（`pi.appendEntry` + `registerEntryRenderer`）。
 *
 * 展示位置：对话流里插入的一整块卡片（`/agent list`、`/agent list-all` 的产物），不是模型消息，
 * 也不进模型上下文。
 * 效果：
 *
 *   ▌ reviewer  ·  a7k2        idle
 *     ├─ kid     ·  b1c2        working
 *     └─ deep    ·  d3e4        idle · 失联
 *
 * 左侧是树内容（`▌` 根引导、`├─` / `└─` 子层），右侧是右对齐的状态。卡片宽度取内容自然宽度
 * 与 64 的较大值，但不超过终端宽度；放不下时左侧先按 `…` 截断。
 */

import type { EntryRenderer, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

/** 树的一行分两段：左侧树内容与右侧右对齐的状态。 */
export interface TreeSegment {
	text: string;
	tone?: ThemeColor;
}

export interface TreeLine {
	left: TreeSegment[];
	right: TreeSegment[];
}

/** 树卡片的 customType。 */
export const TREE_ENTRY = "pi-herdr-agent:tree";

export interface TreeEntry {
	lines: TreeLine[];
}

/** 渲染器本体；扩展用 `pi.registerEntryRenderer(TREE_ENTRY, agentTreeEntryRenderer)` 挂上。 */
export const agentTreeEntryRenderer: EntryRenderer<TreeEntry> = (entry, _options, theme) => {
	const box = new Box(1, 1);
	box.addChild(new TreeView(entry.data?.lines ?? [], theme));
	return box;
};

/** `/agent list` 的渲染组件：左侧树内容 + 右对齐状态。 */
export class TreeView implements Component {
	private readonly lines: TreeLine[];
	private readonly theme: Theme;

	constructor(lines: TreeLine[], theme: Theme) {
		this.lines = lines;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const target = treeWidth(this.theme, this.lines, width);
		return this.lines.map((line) => renderTreeLine(this.theme, line, target));
	}
}

function renderTreeLine(theme: Theme, line: TreeLine, width: number): string {
	const left = paintSegments(theme, line.left);
	const right = paintSegments(theme, line.right);
	if (!right) return truncateToWidth(left, width, "…");

	const rightWidth = visibleWidth(right);
	if (rightWidth + 2 >= width) return truncateToWidth(`${left}  ${right}`, width, "…");

	const available = width - rightWidth - 1;
	const cut = visibleWidth(left) > available ? truncateToWidth(left, available, "…") : left;
	const gap = Math.max(1, width - visibleWidth(cut) - rightWidth);
	return `${cut}${" ".repeat(gap)}${right}`;
}

function paintSegments(theme: Theme, segments: TreeSegment[]): string {
	return segments.map((segment) => (segment.tone ? theme.fg(segment.tone, segment.text) : segment.text)).join("");
}

/** 卡片的目标宽度：内容自然宽度与 64 取大，但不超过终端宽度。 */
const TREE_MIN_WIDTH = 64;

function treeWidth(theme: Theme, lines: TreeLine[], width: number): number {
	let natural = 0;
	for (const line of lines) {
		const left = visibleWidth(paintSegments(theme, line.left));
		const right = line.right.length > 0 ? 2 + visibleWidth(paintSegments(theme, line.right)) : 0;
		natural = Math.max(natural, left + right);
	}
	return Math.min(width, Math.max(TREE_MIN_WIDTH, natural));
}
