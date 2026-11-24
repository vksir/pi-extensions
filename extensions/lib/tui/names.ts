/**
 * TUI 里的 agent 标签：`name (id)`。
 *
 * 展示位置：所有出现 agent 名字的 TUI 文本（消息卡片头行、工具调用行、`/agent list` 树、
 * 结果行）。统一成这一个格式，避免一半 `name · id`、一半只有 id。
 *
 * 效果：
 *
 *   reviewer (a7k2)
 *   a7k2                 ← 没给名字，或名字就等于 id
 */
export function agentLabel(id: string, name?: string): string {
	const trimmed = name?.trim();
	return trimmed && trimmed !== id ? `${trimmed} (${id})` : id;
}
