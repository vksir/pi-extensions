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
 *     "hidden": ["herdr"]
 *   }
 * }
 *
 * 原理:每次 agent run 前,系统提示词由 before_agent_start 暴露的
 * systemPromptOptions.skills 构建而来;pi 在构建时过滤
 * disableModelInvocation === true 的 skill。本扩展在该钩子里对
 * 命中配置的 skill 原地置位该字段;/skill: 命令从 resourceLoader
 * 的完整列表展开,不经过这条路径,因此不受影响。
 */

import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";

/** settings.json 中 "pi-skill-visibility" 键下的扩展配置 */
interface PiSkillVisibilitySettings {
	/** 不进入系统提示词的 skill 名称列表(大小写不敏感) */
	hidden?: string[];
}

function readHiddenSkills(pi: ExtensionAPI): Set<string> {
	const raw = (pi.getSettings() as Record<string, unknown>)["pi-skill-visibility"];
	const settings = typeof raw === "object" && raw !== null ? (raw as PiSkillVisibilitySettings) : {};
	const names = Array.isArray(settings.hidden) ? settings.hidden : [];
	return new Set(names.filter((name): name is string => typeof name === "string").map((name) => name.toLowerCase()));
}

/** 对命中配置的 skill 原地置位 disableModelInvocation;已隐藏的保持不变 */
function applyVisibility(skills: Skill[], hidden: ReadonlySet<string>): void {
	if (hidden.size === 0) return;
	for (const skill of skills) {
		if (hidden.has(skill.name.toLowerCase())) {
			skill.disableModelInvocation = true;
		}
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		applyVisibility(event.systemPromptOptions.skills, readHiddenSkills(pi));
	});
}
