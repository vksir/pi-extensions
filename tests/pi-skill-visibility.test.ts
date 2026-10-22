import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";

const { default: visibilityExtension } = await import("../extensions/pi-skill-visibility.ts");

function makeSkill(name: string, disableModelInvocation = false): Skill {
	return {
		name,
		description: `${name} 的路由描述`,
		filePath: `C:/skills/${name}/SKILL.md`,
		baseDir: `C:/skills/${name}`,
		sourceInfo: { path: `C:/skills/${name}/SKILL.md`, source: "user", scope: "user", origin: "top-level" },
		disableModelInvocation,
	};
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

test("同一 skill 对象在后续 run 中保持隐藏(原地修改)", () => {
	const { fire } = setup({ "pi-skill-visibility": { hidden: ["herdr"] } });
	const herdr = makeSkill("herdr");
	fire([herdr]);
	fire([herdr]);
	assert.equal(herdr.disableModelInvocation, true);
});
