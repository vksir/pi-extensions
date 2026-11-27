/**
 * /progress 的结果卡片 —— transcript 里的 entry 卡片（`pi.appendEntry` + `registerEntryRenderer`）。
 *
 * 展示位置：执行 `/progress` 后追加到对话流的一张卡片，和工具结果同级。
 * 效果：
 *
 *   progress · 共 12 条 · 3 轮
 *
 *   第 3 轮 · 14:22
 *     14:22  ▸ Running the auth tests
 *     14:23  ▸ Patching the uploader
 *   第 2 轮 · 14:15
 *     14:15  ▸ Reading the failing test
 *
 * 头行与轮次标题正常/强调色，条目灰色；不折叠。
 */

import type { EntryRenderer } from "@earendil-works/pi-coding-agent";
import { renderLineBox, type EntryLine } from "../render.ts";

/** `/progress` 结果卡片的 customType。 */
export const PROGRESS_INFO_ENTRY = "pi-progress:info";

export interface ProgressInfoEntry {
	lines: EntryLine[];
}

/** 渲染器本体；扩展用 `pi.registerEntryRenderer(PROGRESS_INFO_ENTRY, progressInfoEntryRenderer)` 挂上。 */
export const progressInfoEntryRenderer: EntryRenderer<ProgressInfoEntry> = (entry, _options, theme) =>
	renderLineBox(theme, entry.data?.lines ?? []);
