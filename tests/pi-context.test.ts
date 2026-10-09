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

const MODEL = { provider: "deepseek", id: "deepseek-flash", api: "openai-completions" };
const SYSTEM_MESSAGE = {
	role: "system",
	content: "base prompt",
	sections: { preamble: "PREAMBLE", tools: "TOOLS" },
	timestamp: 0,
};

interface UiContext {
	model: typeof MODEL;
	isIdle: () => boolean;
	ui: { notify: (message: string, level?: string) => void };
}

type Handler = (event: unknown, ctx: UiContext) => unknown;

function setup() {
	rmSync(outDir, { recursive: true, force: true });
	let command: ((args: string, ctx: UiContext) => Promise<void>) | undefined;
	const handlers = new Map<string, Handler>();
	const notifications: { message: string; level?: string }[] = [];
	let idle = true;
	const sent: { message: Record<string, unknown>; options?: { triggerTurn?: boolean } }[] = [];
	const ctx: UiContext = {
		model: MODEL,
		isIdle: () => idle,
		ui: { notify: (message, level) => { notifications.push({ message, level }); } },
	};
	const pi = {
		registerCommand: (_name: string, definition: { handler: typeof command }) => { command = definition.handler; },
		on: (event: string, handler: Handler) => { handlers.set(event, handler); },
		sendMessage: (message: Record<string, unknown>, options?: { triggerTurn?: boolean }) => { sent.push({ message, options }); },
	};
	contextExtension(pi as unknown as ExtensionAPI);

	return {
		/** /context 挂起一次捕获 */
		arm: () => command!("", ctx),
		/** 每个 LLM 调用前 Pi 送来的完整 transcript */
		transcript: (messages: unknown[]) => handlers.get("context_with_system")!({ type: "context_with_system", messages }, ctx),
		/** 每个 LLM 调用前的对话消息 */
		conversation: (messages: unknown[]) => handlers.get("context")!({ type: "context", messages }, ctx),
		/** provider 请求体成型后 Pi 送来的事件 */
		request: (payload: unknown) => handlers.get("before_provider_request")!({ type: "before_provider_request", payload }, ctx),
		read: (name = "tools.md") => readFileSync(join(outDir, name), "utf8"),
		files: () => readdirSync(outDir).sort(),
		notifications,
		sent,
		busy: () => { idle = false; },
	};
}

/** 挂起后送一次 transcript 与一次请求体。 */
async function capture(app: ReturnType<typeof setup>, payload: unknown = { tools: [], instructions: "base prompt" }, messages: unknown[] = [SYSTEM_MESSAGE]) {
	await app.arm();
	app.transcript(messages);
	app.request(payload);
}

/** 抬头字段值：键值对。 */
function meta(report: string, key: string): string | undefined {
	return report.match(new RegExp(`^${key}: (.*)$`, "m"))?.[1];
}

/** 正文：抬头之后的部分。 */
function body(report: string): string {
	const match = report.match(/^---\n[\s\S]*?\n---\n\n?/);
	assert.ok(match, "文件必须以 --- 抬头开始");
	return report.slice(match[0].length);
}

/** 定义 JSON：文件里最后一个 JSON 围栏。 */
function declaration(report: string): unknown {
	const blocks = [...report.matchAll(/~~~json\n([\s\S]*?)\n~~~/g)];
	assert.ok(blocks.length > 0, "必须有定义 JSON 块");
	return JSON.parse(blocks[blocks.length - 1][1]);
}

test("命令触发一次请求，自己不写文件", async () => {
	const app = setup();
	await app.arm();
	assert.equal(existsSync(outDir), false);
	assert.equal(app.sent.length, 1);
	assert.equal(app.sent[0].options?.triggerTurn, true);
	assert.equal(app.sent[0].message.customType, "pi-context");
	assert.equal(app.sent[0].message.display, false);
	assert.ok(app.notifications.some((item) => item.level === "info" && item.message.includes("快照将写入")));
});

test("Agent 忙碌时不触发请求，快照等本轮下一请求", async () => {
	const app = setup();
	app.busy();
	await app.arm();
	assert.equal(app.sent.length, 0);
	assert.ok(app.notifications.some((item) => item.message.includes("运行中")));
});

test("捕获之后把触发消息从请求里滤掉，捕获那一次保留", async () => {
	const app = setup();
	const trigger = { role: "custom", customType: "pi-context", content: "触发器", display: false, timestamp: 0 };
	const user = { role: "user", content: "你好", timestamp: 1 };
	await app.arm();
	// 捕获那一次必须留着触发器，否则请求就不是模型实际收到的那份。
	assert.equal(app.conversation([trigger, user]), undefined);
	app.transcript([SYSTEM_MESSAGE]);
	app.request({ tools: [] });
	// 之后的请求不再带上触发器。
	assert.deepEqual(app.conversation([trigger, user]), { messages: [user] });
	assert.equal(app.conversation([user]), undefined, "没有触发器时不改消息列表");
});

test("抬头用 --- 包住键值，正文与抬头分开", async () => {
	const app = setup();
	await capture(app);
	const report = app.read("system-prompt.md");
	assert.match(report, /^---\n/);
	assert.match(report, /\n---\n\n/);
	assert.equal(meta(report, "模型"), "deepseek/deepseek-flash（openai-completions）");
	assert.match(meta(report, "捕获时间") ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	assert.match(report, /^分段字符数:\n  preamble: 8\n  tools: 5$/m);
	assert.equal(body(report), "base prompt\n\nPREAMBLE\n\nTOOLS\n");
	// 两份文件来自同一次请求，共用一个捕获时间。
	assert.equal(meta(report, "捕获时间"), meta(app.read("tools.md"), "捕获时间"));
	assert.deepEqual(app.files(), ["system-prompt.md", "tools.md"]);
});

test("后续 system 消息按名覆盖分段，replay 出当前提示词", async () => {
	const app = setup();
	await capture(app, { tools: [] }, [
		{ role: "system", content: "", sections: { preamble: "第一版", skills: "旧技能" }, timestamp: 0 },
		{ role: "system", content: "补充指令", sections: { skills: null, cwd: "D:/project" }, timestamp: 1 },
		{ role: "user", content: "用户消息不进快照" },
	]);
	const report = app.read("system-prompt.md");
	assert.equal(body(report), "补充指令\n\n第一版\n\nD:/project\n");
	assert.match(report, /^分段字符数:\n  preamble: 3\n  cwd: 10$/m);
	assert.ok(!report.includes("用户消息"));
});

test("工具声明按工具名、描述、定义三段式", async () => {
	const app = setup();
	const description = ["Run JavaScript that calls other tools.", "```ts", "const value = 1;", "```", "说明".repeat(120)].join("\n");
	const tools = [{ type: "custom", name: "codemode", description, format: { type: "grammar", definition: "start: SOURCE" } }];
	await capture(app, { tools });
	const report = app.read("tools.md");
	assert.equal(meta(report, "数量"), "1");
	assert.equal(meta(report, "JSON 字符数"), String(JSON.stringify(tools, null, 2).length));
	assert.match(report, /^# codemode$/m);
	// 描述按 Markdown 原样渲染：它自带标题与围栏，套上代码块就没法识别了。
	assert.ok(report.includes(`## 描述\n\n${description}\n\n## 定义`), "描述必须完整保留且不被围栏包住");
	assert.ok(!report.includes("~~~text"), "描述不能写在代码块里");
	assert.deepEqual(declaration(report), { type: "custom", name: "codemode", description: "<见「描述」>", format: { type: "grammar", definition: "start: SOURCE" } });
});

test("描述里的标题、围栏、列表原样保留，不被转义或改写", async () => {
	const app = setup();
	const description = ["## Namespace", "", "```ts", "const value = 1;", "```", "", "- 列表项"].join("\n");
	await capture(app, { tools: [{ name: "read", description }] });
	const report = app.read("tools.md");
	assert.ok(report.includes(`## 描述\n\n${description}\n\n## 定义`), "描述必须在定义之前逐字出现");
	assert.ok(!report.includes("~~~text"), "描述不能写在代码块里");
	assert.deepEqual(declaration(report), { name: "read", description: "<见「描述」>" }, "定义仍可解析");
});

test("工具描述始终单独成节，参数 schema 里的短描述留在定义里", async () => {
	const app = setup();
	const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string", description: "Path to the file" } } } }];
	await capture(app, { tools });
	const report = app.read("tools.md");
	assert.ok(report.includes("## 描述\n\nRead a file\n\n## 定义"), "描述必须单独成节");
	assert.deepEqual(declaration(report), {
		name: "read",
		description: "<见「描述」>",
		parameters: { type: "object", properties: { path: { type: "string", description: "Path to the file" } } },
	});
});

test("描述以外的长文本按 JSON 路径成节", async () => {
	const app = setup();
	const definition = ["start: source", "source: token"].join("\n");
	const tools = [{ name: "codemode", description: "短描述", format: { type: "grammar", definition } }];
	await capture(app, { tools });
	const report = app.read("tools.md");
	assert.ok(report.includes(`## 描述\n\n短描述\n\n## format.definition\n\n${definition}\n\n## 定义`), "路径必须成为节标题");
	assert.deepEqual(declaration(report), { name: "codemode", description: "<见「描述」>", format: { type: "grammar", definition: "<见「format.definition」>" } });
});

test("Google SDK 的 config.tools 按声明成节，工具名取自嵌套字段", async () => {
	const app = setup();
	const tools = [{ functionDeclarations: [{ name: "cron", description: "动态描述" }] }];
	await capture(app, { config: { tools, systemInstruction: { parts: [{ text: "提示词" }] } }, contents: [] });
	const report = app.read("tools.md");
	assert.match(report, /^# cron$/m);
	assert.ok(report.includes("## 描述\n\n动态描述\n\n## 定义"), "嵌套描述同样单独成节");
	assert.deepEqual(declaration(report), { functionDeclarations: [{ name: "cron", description: "<见「描述」>" }] });
});

test("请求体没有工具字段时给出结论，不假装空声明", async () => {
	const app = setup();
	await capture(app, { instructions: "base prompt" });
	assert.equal(meta(app.read("tools.md"), "来源"), "本次请求没有工具声明");

	const missing = setup();
	await capture(missing, { instructions: "base prompt" }, [
		{ role: "system", content: "", toolsAdded: [{ name: "read" }, { name: "write" }], timestamp: 0 },
	]);
	assert.equal(meta(missing.read("tools.md"), "来源"), "无法从该 API 的请求体读取工具声明（transcript 声明了 2 个）");
});

test("没有 transcript 时也落盘，并说明来源缺失", async () => {
	const app = setup();
	await app.arm();
	app.request({ messages: [{ role: "user", content: "x" }] });
	assert.equal(meta(app.read("system-prompt.md"), "来源"), "本次请求没有系统提示词");
	assert.equal(meta(app.read("tools.md"), "来源"), "未捕获到 transcript，无法判断工具声明");
});

test("只在下一次请求捕获，且不修改请求体、不替换 payload", async () => {
	const app = setup();
	const payload = { tools: [{ name: "first" }], instructions: "第一次" };
	app.transcript([{ role: "system", content: "第一次", timestamp: 0 }]);
	assert.equal(app.request(payload), undefined, "捕获必须返回 undefined");
	assert.equal(existsSync(outDir), false, "未挂起时不写文件");

	await app.arm();
	app.transcript([{ role: "system", content: "第二次", timestamp: 0 }]);
	const before = structuredClone(payload);
	assert.equal(app.request(payload), undefined);
	assert.deepEqual(payload, before, "捕获不能修改请求体");
	assert.equal(body(app.read("system-prompt.md")), "第二次\n");

	const written = app.read("tools.md");
	app.request({ tools: [{ name: "ignored" }] });
	assert.equal(app.read("tools.md"), written, "一次挂起只捕获一次");
});

test("重复命令可以重新挂起", async () => {
	const app = setup();
	await capture(app, { tools: [{ name: "first" }] });
	assert.equal(meta(app.read("tools.md"), "数量"), "1");
	await capture(app, { tools: [{ name: "first" }, { name: "second" }] });
	assert.equal(meta(app.read("tools.md"), "数量"), "2");
});
