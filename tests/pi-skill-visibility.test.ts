import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";

const { default: visibilityExtension } = await import("../extensions/pi-skill-visibility.ts");

function makeSkill(
	name: string,
	disableModelInvocation = false,
	options: { filePath?: string; sourceBaseDir?: string } = {},
): Skill {
	const filePath = options.filePath ?? `C:/skills/${name}/SKILL.md`;
	const baseDir = options.sourceBaseDir ?? `C:/skills/${name}`;
	return {
		name,
		description: `${name} 的路由描述`,
		filePath,
		baseDir: `C:/skills/${name}`,
		sourceInfo: { path: filePath, source: "user", scope: "user", origin: "top-level", baseDir },
		disableModelInvocation,
	};
}

/** git 包安装形态:filePath 在包根(sourceInfo.baseDir)之下,如 ~/.pi/agent/git/... */
function makePackagedSkill(group: string, name: string): Skill {
	return makeSkill(name, false, {
		filePath: `C:/pkg/skills/${group}/${name}/SKILL.md`,
		sourceBaseDir: "C:/pkg",
	});
}

interface BeforeAgentStartEvent {
	systemPromptOptions: { skills: Skill[] };
}

type Handler = (event: BeforeAgentStartEvent, ctx: unknown) => unknown;

function setup(settings: Record<string, unknown>) {
	const handlers: Record<string, Handler> = {};
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers[event] = handler;
		},
		getSettings: () => settings,
	} as unknown as ExtensionAPI;
	visibilityExtension(pi);
	return {
		fire(skills: Skill[]) {
			const event: BeforeAgentStartEvent = { systemPromptOptions: { skills } };
			handlers["before_agent_start"](event, {});
			return event.systemPromptOptions.skills;
		},
	};
}

test("hidden 列表中的 skill 被置位 disableModelInvocation,其余不受影响", () => {
	const { fire } = setup({ "pi-skill-visibility": { hidden: ["herdr"] } });
	const herdr = makeSkill("herdr");
	const research = makeSkill("research");
	const result = fire([herdr, research]);
	assert.equal(result[0].disableModelInvocation, true);
	assert.equal(result[1].disableModelInvocation, false);
});

test("已通过 frontmatter 隐藏的 skill 保持隐藏", () => {
	const { fire } = setup({ "pi-skill-visibility": { hidden: ["herdr"] } });
	const wizard = makeSkill("wizard", true);
	const [result] = fire([wizard]);
	assert.equal(result.disableModelInvocation, true);
});

test("名称匹配大小写不敏感", () => {
	const { fire } = setup({ "pi-skill-visibility": { hidden: ["Herdr"] } });
	const [result] = fire([makeSkill("herdr")]);
	assert.equal(result.disableModelInvocation, true);
});

test("无配置时不修改任何 skill", () => {
	const { fire } = setup({});
	const skill = makeSkill("herdr");
	const [result] = fire([skill]);
	assert.equal(result.disableModelInvocation, false);
});

test("配置项格式错误时静默忽略", () => {
	for (const bad of [undefined, null, "herdr", 42, { hidden: "herdr" }, { hidden: [1, null, true] }]) {
		const { fire } = setup({ "pi-skill-visibility": bad });
		const skill = makeSkill("herdr");
		const [result] = fire([skill]);
		assert.equal(result.disableModelInvocation, false, `hidden=${JSON.stringify(bad)} 应被忽略`);
	}
});

test("名称通配模式 * 命中同前缀 skill", () => {
	const { fire } = setup({ "pi-skill-visibility": { hidden: ["code*"] } });
	const review = makeSkill("code-review");
	const design = makeSkill("codebase-design");
	const research = makeSkill("research");
	const result = fire([review, design, research]);
	assert.equal(result[0].disableModelInvocation, true);
	assert.equal(result[1].disableModelInvocation, true);
	assert.equal(result[2].disableModelInvocation, false);
});

test("名称通配模式 * 不跨连字符段,code-* 只命中 code-review", () => {
	const { fire } = setup({ "pi-skill-visibility": { hidden: ["code-*"] } });
	const [review] = fire([makeSkill("code-review")]);
	const [design] = fire([makeSkill("codebase-design")]);
	assert.equal(review.disableModelInvocation, true);
	assert.equal(design.disableModelInvocation, false);
});

test("名称通配模式大小写不敏感(与 pi packages 的 minimatch nocase 一致)", () => {
	const { fire } = setup({ "pi-skill-visibility": { hidden: ["CODE-*"] } });
	const [result] = fire([makeSkill("code-review")]);
	assert.equal(result.disableModelInvocation, true);
});

test("路径模式 skills/engineering/* 按 pi packages 同款机制命中包内整组 skill", () => {
	const { fire } = setup({ "pi-skill-visibility": { hidden: ["skills/engineering/*"] } });
	const review = makePackagedSkill("engineering", "code-review");
	const design = makePackagedSkill("engineering", "codebase-design");
	const grill = makePackagedSkill("productivity", "grilling");
	const result = fire([review, design, grill]);
	assert.equal(result[0].disableModelInvocation, true);
	assert.equal(result[1].disableModelInvocation, true);
	assert.equal(result[2].disableModelInvocation, false);
});

test("路径模式 * 不跨目录层级,跨层级需 **", () => {
	const star = setup({ "pi-skill-visibility": { hidden: ["skills/*"] } });
	const [deep] = star.fire([makePackagedSkill("engineering", "code-review")]);
	assert.equal(deep.disableModelInvocation, false);

	const globstar = setup({ "pi-skill-visibility": { hidden: ["skills/**"] } });
	const [hidden] = globstar.fire([makePackagedSkill("productivity", "grilling")]);
	assert.equal(hidden.disableModelInvocation, true);
});

test("花括号展开 {a,b} 与单字符 ? 通配", () => {
	const braces = setup({ "pi-skill-visibility": { hidden: ["{grilling,wizard}"] } });
	const [grill] = braces.fire([makeSkill("grilling")]);
	assert.equal(grill.disableModelInvocation, true);

	const question = setup({ "pi-skill-visibility": { hidden: ["grill?ng"] } });
	const [matched] = question.fire([makeSkill("grilling")]);
	const [missed] = question.fire([makeSkill("grinding")]);
	assert.equal(matched.disableModelInvocation, true);
	assert.equal(missed.disableModelInvocation, false);
});

test("非法 glob 模式不抛错、不隐藏任何 skill", () => {
	const { fire } = setup({ "pi-skill-visibility": { hidden: ["["] } });
	const [result] = fire([makeSkill("code-review")]);
	assert.equal(result.disableModelInvocation, false);
});

test("精确名称与 glob 模式可混用", () => {
	const { fire } = setup({ "pi-skill-visibility": { hidden: ["herdr", "code-*"] } });
	const herdr = makeSkill("herdr");
	const review = makeSkill("code-review");
	const research = makeSkill("research");
	const result = fire([herdr, review, research]);
	assert.equal(result[0].disableModelInvocation, true);
	assert.equal(result[1].disableModelInvocation, true);
	assert.equal(result[2].disableModelInvocation, false);
});

test("同一 skill 对象在后续 run 中保持隐藏(原地修改)", () => {
	const { fire } = setup({ "pi-skill-visibility": { hidden: ["herdr"] } });
	const herdr = makeSkill("herdr");
	fire([herdr]);
	fire([herdr]);
	assert.equal(herdr.disableModelInvocation, true);
});
