import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 在加载扩展前隔离输出目录，不能覆盖用户的上下文快照。
const agentDir = mkdtempSync(join(tmpdir(), "pi-context-test-"));
const outDir = join(agentDir, "pi-context");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: contextExtension } = await import("../extensions/pi-context.ts");
after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

interface UIContext {
	ui: { notify: (message: string, level?: string) => void };
}

function setup(activeTools = ["cron", "codemode"]) {
	rmSync(outDir, { recursive: true, force: true });
	let command: (args: string, ctx: UIContext) => Promise<void>;
	const handlers = new Map<string, (event: { payload: unknown }, ctx: UIContext) => unknown>();
	const notifications: { message: string; level?: string }[] = [];
	const ctx = {
		getSystemPrompt: () => "命令时系统提示词",
		ui: { notify: (message: string, level?: string) => { notifications.push({ message, level }); } },
	};
	const pi = {
		registerCommand: (_name: string, definition: { handler: typeof command }) => { command = definition.handler; },
		on: (event: string, handler: (event: { payload: unknown }, ctx: UIContext) => unknown) => {
			handlers.set(event, handler);
		},
		getActiveTools: () => activeTools,
		getAllTools: () => { throw new Error("不应读取注册定义"); },
	};
	contextExtension(pi as unknown as ExtensionAPI);
	return {
		capture: () => command("", ctx),
		request: (payload: unknown) => handlers.get("before_provider_request")!({ payload }, ctx),
		read: (name = "tools.md") => readFileSync(join(outDir, name), "utf8"),
		notifications,
	};
}

function toolsBody(report: string): string {
	const pattern = /^- 写入时间：\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n\n/m;
	assert.match(report, pattern, "工具定义必须记录实际写入时间（UTC）");
	return report.replace(pattern, "");
}

function toolsMarkdown(tools: unknown[], activeTools = ["cron", "codemode"]): string {
	return [
		"# 工具",
		"",
		"## 激活工具",
		"",
		"激活不等于独立顶层可见；LLM 实际收到的定义见下方。",
		"",
		activeTools.map((name) => `- \`${name}\``).join("\n") || "（无工具）",
		"",
		"## 对 LLM 展示的工具定义",
		"",
		"~~~json",
		JSON.stringify(tools, null, 2),
		"~~~",
		"",
	].join("\n");
}

test("简要列出激活工具，保留实际定义与系统提示词，不生成请求体或注册定义", async () => {
	const app = setup();
	await app.capture();
	const tools = [{
		type: "custom",
		name: "codemode",
		description: "嵌套工具：cron；调用 tools.cron({ action: 'list' })",
		format: { type: "grammar", syntax: "lark", definition: "start: SOURCE" },
	}];
	const payload = { instructions: "请求时系统提示词", tools, input: [{ role: "user", content: "不要导出用户消息" }] };
	const before = structuredClone(payload);
	assert.equal(app.request(payload), undefined, "捕获不能替换请求");
	assert.deepEqual(payload, before, "捕获不能修改请求");
	assert.equal(toolsBody(app.read()), toolsMarkdown(tools));
	assert.equal(app.read("system-prompt.md"), "请求时系统提示词");
	assert.deepEqual(readdirSync(outDir).sort(), ["system-prompt.md", "tools.md"]);
});

test("命令立即写入系统提示词，工具定义仍等待实际请求", async () => {
	const app = setup();
	await app.capture();
	assert.equal(app.read("system-prompt.md"), "命令时系统提示词");
	assert.equal(existsSync(join(outDir, "tools.md")), false);
	assert.ok(app.notifications.some((item) => item.message.includes("下次请求")));
});

test("工具写入时间随实际捕获更新，未挂起的请求不改时间", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-03T07:52:03.000Z") });
	const app = setup();
	await app.capture();
	t.mock.timers.tick(1000);
	app.request({ tools: [], instructions: "请求时系统提示词" });
	assert.match(app.read(), /- 写入时间：2026-10-03T07:52:04\.000Z/);
	t.mock.timers.tick(1000);
	app.request({ tools: [] });
	assert.match(app.read(), /- 写入时间：2026-10-03T07:52:04\.000Z/);
	await app.capture();
	assert.equal(app.read("system-prompt.md"), "命令时系统提示词");
	app.request({ tools: [], instructions: "第二次实际提示词" });
	assert.match(app.read(), /- 写入时间：2026-10-03T07:52:05\.000Z/);
	assert.equal(app.read("system-prompt.md"), "第二次实际提示词");
});

const formats: { name: string; payload: Record<string, unknown>; tools: unknown[]; prompt: string }[] = [
	{
		name: "OpenAI Responses",
		payload: {
			tools: [{ type: "function", name: "cron", description: "动态描述", parameters: {} }],
			input: [
				{ role: "system", content: [{ type: "input_text", text: "系统提示词" }] },
				{ role: "developer", content: [{ type: "input_text", text: "后续系统指令" }] },
				{ role: "user", content: "用户消息" },
			],
		},
		tools: [{ type: "function", name: "cron", description: "动态描述", parameters: {} }],
		prompt: "系统提示词\n\n后续系统指令",
	},
	{
		name: "OpenAI Chat Completions",
		payload: {
			tools: [{ type: "function", function: { name: "cron", description: "动态描述", parameters: {} } }],
			messages: [
				{ role: "system", content: "系统提示词" },
				{ role: "developer", content: [{ type: "text", text: "后续系统指令" }] },
				{ role: "assistant", content: "助手消息" },
			],
		},
		tools: [{ type: "function", function: { name: "cron", description: "动态描述", parameters: {} } }],
		prompt: "系统提示词\n\n后续系统指令",
	},
	{
		name: "Anthropic（含后续 system 消息）",
		payload: {
			system: [{ type: "text", text: "系统提示词", cache_control: { type: "ephemeral" } }],
			tools: [{ name: "cron", description: "动态描述", input_schema: { type: "object" } }],
			messages: [
				{ role: "system", content: [{ type: "text", text: "后续系统指令" }] },
				{ role: "user", content: "用户消息" },
			],
		},
		tools: [{ name: "cron", description: "动态描述", input_schema: { type: "object" } }],
		prompt: "系统提示词\n\n后续系统指令",
	},
	{
		name: "Google SDK",
		payload: {
			config: {
				systemInstruction: { parts: [{ text: "系统提示词" }] },
				tools: [{ functionDeclarations: [{ name: "cron", description: "动态描述" }] }],
			},
			contents: [{ role: "user", parts: [{ text: "用户消息" }] }],
		},
		tools: [{ functionDeclarations: [{ name: "cron", description: "动态描述" }] }],
		prompt: "系统提示词",
	},
	{
		name: "Google REST",
		payload: {
			system_instruction: { parts: [{ text: "系统提示词" }] },
			tools: [{ function_declarations: [{ name: "cron", description: "动态描述" }] }],
			contents: [],
		},
		tools: [{ function_declarations: [{ name: "cron", description: "动态描述" }] }],
		prompt: "系统提示词",
	},
];
for (const fixture of formats) {
	test(`只导出原生工具定义与系统文本：${fixture.name}`, async () => {
		const app = setup();
		await app.capture();
		app.request(fixture.payload);
		assert.equal(toolsBody(app.read()), toolsMarkdown(fixture.tools));
		assert.equal(app.read("system-prompt.md"), fixture.prompt);
	});
}

test("完整保存较长工具定义，不截断", async () => {
	const app = setup();
	await app.capture();
	const tools = [{ name: "codemode", description: "定义".repeat(110_000) }];
	app.request({ tools, instructions: "" });
	assert.equal(toolsBody(app.read()), toolsMarkdown(tools));
	assert.equal(app.read("system-prompt.md"), "");
});

test("没有工具或系统提示词时，输出空定义与空文本", async () => {
	const app = setup([]);
	await app.capture();
	app.request({ messages: [{ role: "user", content: "用户消息" }] });
	assert.equal(toolsBody(app.read()), toolsMarkdown([], []));
	assert.equal(app.read("system-prompt.md"), "");
});

test("激活列表使用请求时状态，不把 codemode 隐藏的工具混入实际声明", async () => {
	const activeTools = ["cron", "codemode"];
	const app = setup(activeTools);
	await app.capture();
	activeTools.push("late");
	const tools = [{ name: "codemode", description: "实际动态描述" }];
	app.request({ tools });
	assert.equal(toolsBody(app.read()), toolsMarkdown(tools, activeTools));
	const definition = app.read().match(/~~~json\n([\s\S]*?)\n~~~/);
	assert.ok(definition);
	assert.deepEqual(JSON.parse(definition[1]), tools);
});

test("未知请求格式不冒充已捕获，错误不影响请求", async () => {
	const app = setup();
	await app.capture();
	assert.equal(app.request({ customToolset: ["cron"] }), undefined);
	assert.equal(app.read("system-prompt.md"), "命令时系统提示词");
	assert.equal(existsSync(join(outDir, "tools.md")), false);
	assert.ok(app.notifications.some((item) => item.level === "error"));
});

test("只捕获一次，重复命令可以重新挂起", async () => {
	const app = setup();
	await app.capture();
	app.request({ tools: [{ name: "first" }], instructions: "第一次" });
	app.request({ tools: [{ name: "ignored" }], instructions: "忽略" });
	assert.equal(toolsBody(app.read()), toolsMarkdown([{ name: "first" }]));
	assert.equal(app.read("system-prompt.md"), "第一次");
	await app.capture();
	app.request({ tools: [{ name: "second" }], instructions: "第二次" });
	assert.equal(toolsBody(app.read()), toolsMarkdown([{ name: "second" }]));
	assert.equal(app.read("system-prompt.md"), "第二次");
});
