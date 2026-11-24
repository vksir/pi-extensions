/**
 * 界面备注行 —— transcript 里的一行灰色提示（`pi.appendEntry` + `registerEntryRenderer`）。
 *
 * 展示位置：对话流里的单行提示，不是模型消息，也不进模型上下文。目前用于「等回信」通知
 * 发不出去这类尽力而为的失败记录。
 * 效果：
 *
 *   could not report a7k2: it disappeared.
 */

import type { EntryRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

/** 备注条目的 customType。 */
export const NOTE_ENTRY = "pi-herdr-agent:note";

export interface NoteEntry {
	text: string;
}

/** 渲染器本体；扩展用 `pi.registerEntryRenderer(NOTE_ENTRY, noteEntryRenderer)` 挂上。 */
export const noteEntryRenderer: EntryRenderer<NoteEntry> = (entry, _options, theme) => {
	const box = new Box(0, 1);
	box.addChild(new Text(theme.fg("muted", entry.data?.text ?? ""), 0, 0));
	return box;
};
