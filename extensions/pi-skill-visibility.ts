/**
 * Pi Skill Visibility Extension
 *
 * 通过 settings.json 配置把指定 skill 从系统提示词的 skills 名录中隐藏,
 * 效果等同 SKILL.md frontmatter 里的 disable-model-invocation: true,
 * 但不需要改动 skill 文件本身——适合通过 pi packages 安装、不便 fork 修改的 skill。
 *
 * 被隐藏的 skill 仍可通过 /skill:<名称> 显式调用(与 disable-model-invocation 语义一致)。
 *
 * settings.json(全局 ~/.pi/agent/settings.json 或项目 .pi/settings.json):
 * {
 *   "pi-skill-visibility": {
 *     "hidden": [
 *       "herdr",                 // 精确名称(大小写不敏感)
 *       "code-*",                // 通配名称,支持 * ? [abc] {a,b}
 *       "skills/engineering/*"   // 路径模式
 *     ]
 *   }
 * }
 *
 * 匹配规则:不含 glob 元字符(* ? [ {)的条目按精确名称匹配(大小写不敏感);
 * 含 glob 元字符的条目采用与 settings packages[].skills 相同的 minimatch 机制
 * (nocase,模式与候选均转 posix 斜杠),任一候选命中即隐藏:
 * - skill 名称
 * - SKILL.md 相对包根(sourceInfo.baseDir)的路径,以及去掉 SKILL.md 的目录路径
 *   ——包内路径写法由此生效,如 `skills/engineering/*` 命中 mattpocock/skills
 *   里 engineering 组的每个 skill(和 pi packages 匹配一样,* 不跨目录层级,
 *   需要跨层级用 `skills/**`)
 * - SKILL.md 的绝对 posix 路径,以及所在目录的绝对 posix 路径
 *
 * 原理:每次 agent run 前,系统提示词由 before_agent_start 暴露的
 * systemPromptOptions.skills 构建而来;pi 在构建时过滤
 * disableModelInvocation === true 的 skill。本扩展在该钩子里对
 * 命中配置的 skill 原地置位该字段;/skill: 命令从 resourceLoader
 * 的完整列表展开,不经过这条路径,因此不受影响。
 */

import { dirname, relative } from "node:path";
import { minimatch } from "minimatch";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";

/** settings.json 中 "pi-skill-visibility" 键下的扩展配置 */
interface PiSkillVisibilitySettings {
	/** 不进入系统提示词的 skill 条目:精确名称或 glob 模式 */
	hidden?: string[];
}

/** 含任一 glob 元字符的条目按模式处理,其余按精确名称处理 */
const GLOB_META = /[*?[{]/;

interface HiddenRules {
	/** 精确名称(已转小写) */
	exact: ReadonlySet<string>;
	/** glob 模式原文 */
	patterns: readonly string[];
}

function readHiddenRules(pi: ExtensionAPI): HiddenRules {
	const raw = (pi.getSettings() as Record<string, unknown>)["pi-skill-visibility"];
	const settings = typeof raw === "object" && raw !== null ? (raw as PiSkillVisibilitySettings) : {};
	const entries = Array.isArray(settings.hidden) ? settings.hidden : [];
	const strings = entries.filter((entry): entry is string => typeof entry === "string");
	return {
		exact: new Set(strings.filter((entry) => !GLOB_META.test(entry)).map((entry) => entry.toLowerCase())),
		patterns: strings.filter((entry) => GLOB_META.test(entry)),
	};
}

function toPosix(p: string): string {
	return p.replaceAll("\\", "/");
}

/**
 * 与 pi packages[].skills 相同的候选集(参照 package-manager 的 matchesAnyPattern):
 * 名称 + 相对包根的文件/目录路径 + 绝对文件/目录路径,全部转 posix 斜杠。
 * 非包根后代(baseDir 不是祖先,relative 结果以 .. 开头)或空串的候选跳过。
 */
function globCandidates(skill: Skill): string[] {
	const filePathPosix = toPosix(skill.filePath);
	const dirPosix = toPosix(dirname(skill.filePath));
	const candidates = new Set([skill.name, filePathPosix, dirPosix]);
	const baseDir = skill.sourceInfo.baseDir ?? skill.baseDir;
	if (typeof baseDir === "string" && baseDir !== "") {
		for (const rel of [relative(baseDir, skill.filePath), relative(baseDir, dirname(skill.filePath))]) {
			if (rel !== "" && !rel.startsWith("..")) candidates.add(toPosix(rel));
		}
	}
	return [...candidates];
}

/** 任一候选命中任一模式即隐藏;非法模式由 minimatch 判为不匹配 */
function matchesGlob(skill: Skill, patterns: readonly string[]): boolean {
	if (patterns.length === 0) return false;
	const candidates = globCandidates(skill);
	return patterns.some((pattern) => {
		const normalized = toPosix(pattern);
		return candidates.some((candidate) => minimatch(candidate, normalized, { nocase: true }));
	});
}

/** 对命中配置的 skill 原地置位 disableModelInvocation;已隐藏的保持不变 */
function applyVisibility(skills: Skill[], rules: HiddenRules): void {
	if (rules.exact.size === 0 && rules.patterns.length === 0) return;
	for (const skill of skills) {
		if (rules.exact.has(skill.name.toLowerCase()) || matchesGlob(skill, rules.patterns)) {
			skill.disableModelInvocation = true;
		}
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		applyVisibility(event.systemPromptOptions.skills, readHiddenRules(pi));
	});
}
