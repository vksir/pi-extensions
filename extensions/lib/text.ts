/** 与 TUI 无关的通用文本处理。 */

/** 路径最后一段；同时接受 POSIX 与 Windows 分隔符。 */
export function basename(path: string): string {
	const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
	return index >= 0 ? path.slice(index + 1) : path;
}

/** 先压成单行，再截断到 max 个字符；超出时以省略号收尾。 */
export function truncate(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}
