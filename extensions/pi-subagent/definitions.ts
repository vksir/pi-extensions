/**
 * Agent 定义：Markdown frontmatter 存放配置，正文作为子 Agent 的系统提示词。
 *
 * 当前只发现全局目录 `<agent-dir>/agents/*.md`，只解释 `name` 与 `description`；
 * 其余来源与字段由后续 ticket 补充。类型名与实例名精确匹配，不做模糊猜测。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface AgentDefinition {
	/** 类型名：frontmatter 的 name，缺省时取定义文件名（去 .md） */
	type: string;
	/** 供主 Agent 判断是否适合委派的用途说明 */
	description?: string;
	/** 正文：子 Agent 的系统提示词原文，不自动翻译 */
	body: string;
	/** 定义文件路径，用于错误提示与去重 */
	file: string;
}

export interface DefinitionCatalog {
	definitions: Map<string, AgentDefinition>;
	/** 解析失败或不可用的定义；只提示，不影响其他定义加载 */
	errors: string[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** 极简 frontmatter：单行 `key: value`，值可加引号；嵌套结构留给后续 ticket。 */
export function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
	const match = FRONTMATTER_RE.exec(raw);
	if (!match) return { fields: {}, body: raw };
	const fields: Record<string, string> = {};
	for (const line of match[1]!.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const sep = line.indexOf(":");
		if (sep <= 0) continue;
		const key = line.slice(0, sep).trim();
		let value = line.slice(sep + 1).trim();
		if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
			value = value.slice(1, -1);
		}
		fields[key] = value;
	}
	return { fields, body: raw.slice(match[0].length) };
}

export function parseAgentDefinition(file: string, raw: string): AgentDefinition | { error: string } {
	const { fields, body } = parseFrontmatter(raw);
	const declared = fields.name?.trim();
	const type = declared || basename(file).replace(/\.md$/i, "");
	if (!type) return { error: `${file}: agent definition has an empty type name` };
	return {
		type,
		description: fields.description?.trim() || undefined,
		body: body.trim(),
		file,
	};
}

/** 读取目录中的全部 `.md` 定义；同名（含文件名推导）时按文件名排序后后者覆盖，行为确定。 */
export function loadAgentDefinitions(agentDir: string): DefinitionCatalog {
	const catalog: DefinitionCatalog = { definitions: new Map(), errors: [] };
	const dir = join(agentDir, "agents");
	if (!existsSync(dir)) return catalog;

	let names: string[];
	try {
		names = readdirSync(dir)
			.filter((name) => name.toLowerCase().endsWith(".md"))
			.sort();
	} catch (error) {
		catalog.errors.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
		return catalog;
	}

	for (const name of names) {
		const file = join(dir, name);
		let raw: string;
		try {
			raw = readFileSync(file, "utf8");
		} catch (error) {
			catalog.errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		const parsed = parseAgentDefinition(file, raw);
		if ("error" in parsed) {
			catalog.errors.push(parsed.error);
			continue;
		}
		catalog.definitions.set(parsed.type, parsed);
	}
	return catalog;
}
