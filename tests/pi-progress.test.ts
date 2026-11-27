import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { renderProgressCall } from "../extensions/lib/tui/progress.ts";
import { piProgressPrompt } from "../extensions/prompt/pi-progress.ts";

// ─── 测试替身 ───

type WidgetContent = (tui: unknown, theme: unknown) => { render(width: number): string[] };

interface FakeEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

interface FakeCtx {
	hasUI: boolean;
	ui: { setWidget: (key: string, content: WidgetContent | undefined) => void };
	sessionManager: { getEntries: () => FakeEntry[] };
}

type Handler = (event: unknown, ctx: FakeCtx) => unknown;
type CommandHandler = (args: string, ctx: FakeCtx) => unknown;

interface WidgetCall {
	key: string;
	content: WidgetContent | undefined;
}

interface ToolDefinition {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	parameters: unknown;
	execute: (...args: unknown[]) => Promise<any>;
	renderCall?: (args: unknown, theme: unknown, context: unknown) => { render(width: number): string[] };
}

interface Setup {
	tools: Map<string, ToolDefinition>;
	tool: ToolDefinition;
	commands: Map<string, CommandHandler>;
	entries: FakeEntry[];
	fire: (event: string, ctx?: FakeCtx) => void;
	ctx: FakeCtx;
	widgets: WidgetCall[];
}

const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text };

/** 把一次 setWidget 的工厂渲染成去掉行尾填充空白的行（保留行首缩进）。 */
function renderWidget(call: WidgetCall, width = 80): string[] {
	assert.ok(call.content);
	return call.content({}, theme).render(width).map((line) => line.trimEnd());
}

/** 只取 `pi-progress:entry` 记录。 */
function progressEntries(entries: readonly FakeEntry[]): { text: string; round: number; at: number }[] {
	return entries
		.filter((entry) => entry.customType === "pi-progress:entry")
		.map((entry) => entry.data as { text: string; round: number; at: number });
}

/** 每个用例拿到全新的扩展实例，避免注册表与轮次计数互相污染。 */
let moduleSeq = 0;
async function setup(hasUI = true, subAgent = false): Promise<Setup> {
	// 导入时判角色：根代理没有 PI_AGENT_ID，子代理由 herdr-agent 注入。
	const previousAgentId = process.env.PI_AGENT_ID;
	if (subAgent) process.env.PI_AGENT_ID = "a1b2c3";
	else delete process.env.PI_AGENT_ID;

	try {
		const { default: progressExtension } = await import(`../extensions/pi-progress.ts?run=${moduleSeq++}`);

		const tools = new Map<string, ToolDefinition>();
		const handlers = new Map<string, Handler[]>();
		const commands = new Map<string, CommandHandler>();
		const entries: FakeEntry[] = [];

		const pi = {
			on(event: string, handler: Handler) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool(definition: ToolDefinition) {
				tools.set(definition.name, definition);
			},
			registerCommand(name: string, options: { handler: CommandHandler }) {
				commands.set(name, options.handler);
			},
			registerEntryRenderer() {},
			appendEntry(customType: string, data?: unknown) {
				entries.push({ type: "custom", customType, data });
			},
		};
		progressExtension(pi as never);

		const widgets: WidgetCall[] = [];
		const ctx: FakeCtx = {
			hasUI,
			ui: {
				setWidget(key, content) {
					widgets.push({ key, content });
				},
			},
			sessionManager: {
				getEntries: () => entries,
			},
		};

		return {
			tools,
			tool: tools.get("progress")!,
			commands,
			entries,
			ctx,
			widgets,
			fire(event, eventCtx = ctx) {
				for (const handler of handlers.get(event) ?? []) handler({ type: event }, eventCtx);
			},
		};
	} finally {
		if (previousAgentId === undefined) delete process.env.PI_AGENT_ID;
		else process.env.PI_AGENT_ID = previousAgentId;
	}
}

async function report(tool: ToolDefinition, ctx: FakeCtx, text: string): Promise<any> {
	return tool.execute("call", { text }, undefined, undefined, ctx);
}

// ─── 角色与注册 ───

test("herdr-agent 拉起的子代理不注册工具与命令", async () => {
	const { tools, commands, fire, widgets } = await setup(true, true);

	assert.equal(tools.size, 0);
	assert.equal(commands.size, 0);
	fire("agent_start");
	assert.deepEqual(widgets, []);
});

test("根代理没有 PI_AGENT_ID 时照常注册", async () => {
	const { tools, commands } = await setup();
	assert.deepEqual([...tools.keys()], ["progress"]);
	assert.deepEqual([...commands.keys()], ["progress"]);
});

test("progress 注册为模型可见工具，带索引行", async () => {
	const { tool } = await setup();
	assert.equal(tool.name, "progress");
	assert.equal(tool.label, "Progress");
	assert.equal(tool.description, piProgressPrompt.declarations.progress.description);
	assert.equal(tool.promptSnippet, piProgressPrompt.system.snippets.progress);
	assert.ok(tool.renderCall);
});

// ─── widget ───

test("一轮内多次报告按顺序堆叠，最新一条在底部", async () => {
	const { tool, ctx, widgets } = await setup();
	await report(tool, ctx, "Reading the failing test");
	await report(tool, ctx, "Patching the uploader");
	await report(tool, ctx, "Running the auth tests");

	const lines = renderWidget(widgets.at(-1)!);
	assert.equal(lines.length, 3);
	assert.match(lines[0], /^ {3}\d{2}:\d{2}  Reading the failing test$/);
	assert.match(lines[1], /^ {3}\d{2}:\d{2}  Patching the uploader$/);
	assert.match(lines[2], /^ ▌ \d{2}:\d{2}  Running the auth tests$/);
});

test("超过 8 条时 widget 只留最近 8 条", async () => {
	const { tool, ctx, widgets, entries } = await setup();
	for (let index = 1; index <= 9; index += 1) await report(tool, ctx, `stage ${index}`);

	const lines = renderWidget(widgets.at(-1)!);
	assert.equal(lines.length, 8);
	assert.match(lines[0], /^ {3}\d{2}:\d{2}  stage 2$/);
	assert.match(lines.at(-1)!, /^ ▌ \d{2}:\d{2}  stage 9$/);
	// 全部 9 条都写进了会话，`/progress` 不会丢。
	assert.equal(progressEntries(entries).length, 9);
});

test("换行和多余空白压成一行", async () => {
	const { tool, ctx, widgets } = await setup();
	await report(tool, ctx, "  Running\n  the   auth tests  ");

	assert.match(renderWidget(widgets[0])[0], /^ ▌ \d{2}:\d{2}  Running the auth tests$/);
});

test("窄终端下进展行不溢出", async () => {
	const { tool, ctx, widgets } = await setup();
	await report(tool, ctx, "Wiring the retry loop into the uploader");

	const lines = renderWidget(widgets[0], 20);
	assert.equal(lines.length, 1);
	assert.ok(visibleWidth(lines[0]) <= 20, `line is ${visibleWidth(lines[0])} columns: ${lines[0]}`);
});

test("没有 UI 时只返回确认，不碰 widget", async () => {
	const { tool, ctx, widgets } = await setup(false);
	const result = await report(tool, ctx, "Running the auth tests");

	assert.deepEqual(widgets, []);
	assert.equal(result.isError, undefined);
	assert.equal(result.content[0].text, "progress set.");
});

// ─── 输入校验与记录 ───

test("空白文本返回错误，不覆盖当前进展也不写记录", async () => {
	const { tool, ctx, widgets, entries } = await setup();
	await report(tool, ctx, "Fixing the retry loop");
	widgets.length = 0;

	const result = await report(tool, ctx, " \n\t ");

	assert.deepEqual(widgets, []);
	assert.equal(progressEntries(entries).length, 1);
	assert.equal(result.isError, true);
	assert.equal(result.details.error, piProgressPrompt.results.errors.empty());
	assert.equal(result.content[0].text, "Error: progress text is empty.");
});

test("超长文本返回错误，不写 widget 与记录", async () => {
	const { tool, ctx, widgets, entries } = await setup();
	const result = await report(tool, ctx, "x".repeat(121));

	assert.deepEqual(widgets, []);
	assert.deepEqual(progressEntries(entries), []);
	assert.equal(result.isError, true);
	assert.equal(result.details.error, piProgressPrompt.results.errors.tooLong(120));
	assert.equal(result.content[0].text, "Error: progress text is longer than 120 characters.");
});

// ─── 轮次与清空 ───

test("每条进展都写进会话，带上轮次与时间", async () => {
	const { tool, ctx, entries, fire } = await setup();
	fire("agent_start");
	await report(tool, ctx, "First");
	fire("agent_start");
	await report(tool, ctx, "Second");

	const records = progressEntries(entries);
	assert.equal(records.length, 2);
	assert.equal(records[0].round, 1);
	assert.equal(records[1].round, 2);
	assert.ok(records[0].at > 0 && records[1].at >= records[0].at);
});

test("新一轮开始时清空 widget，但不清会话记录", async () => {
	const { tool, ctx, widgets, entries, fire } = await setup();
	await report(tool, ctx, "Fixing the retry loop");
	widgets.length = 0;

	fire("agent_start");

	assert.deepEqual(widgets, [{ key: "pi-progress", content: undefined }]);
	assert.equal(progressEntries(entries).length, 1);
});

test("会话启动后轮次编号接着历史最大值", async () => {
	const { tool, ctx, entries, fire } = await setup();
	entries.push({ type: "custom", customType: "pi-progress:entry", data: { text: "old", round: 5, at: 1 } });

	fire("session_start");
	fire("agent_start");
	await report(tool, ctx, "new");

	const records = progressEntries(entries);
	assert.equal(records.at(-1)!.round, 6);
});

test("会话启动与退出时也清空，避免跨会话残留", async () => {
	const { widgets, fire } = await setup();

	fire("session_start");
	fire("session_shutdown");

	assert.deepEqual(widgets, [
		{ key: "pi-progress", content: undefined },
		{ key: "pi-progress", content: undefined },
	]);
});

test("没有 UI 时清空事件不写 widget", async () => {
	const { widgets, fire } = await setup(false);

	fire("agent_start");
	fire("session_start");
	fire("session_shutdown");

	assert.deepEqual(widgets, []);
});

// ─── /progress 命令 ───

test("/progress 显示全部记录并按轮次分组", async () => {
	const { tool, ctx, commands, entries, fire } = await setup();
	fire("agent_start");
	await report(tool, ctx, "Reading the failing test");
	await report(tool, ctx, "Patching the uploader");
	fire("agent_start");
	await report(tool, ctx, "Running the auth tests");

	await commands.get("progress")!("", ctx);

	const info = entries.at(-1)!;
	assert.equal(info.customType, "pi-progress:info");
	const lines = (info.data as { lines: { text: string; tone?: string }[] }).lines;
	const texts = lines.map((line) => line.text);
	assert.ok(texts.includes("progress · 共 3 条 · 2 轮"));
	assert.ok(texts.some((text) => text.startsWith("第 1 轮 · ")));
	assert.ok(texts.some((text) => text.startsWith("第 2 轮 · ")));
	assert.ok(texts.some((text) => text.endsWith("▸ Reading the failing test")));
	assert.ok(texts.some((text) => text.endsWith("▸ Patching the uploader")));
	assert.ok(texts.some((text) => text.endsWith("▸ Running the auth tests")));
});

test("/progress 在没有任何记录时显示提示", async () => {
	const { ctx, commands, entries } = await setup();

	await commands.get("progress")!("", ctx);

	const info = entries.at(-1)!;
	const lines = (info.data as { lines: { text: string; tone?: string }[] }).lines;
	assert.deepEqual(lines, [{ text: "progress · 还没有记录", tone: "dim" }]);
});

// ─── 工具调用行 ───

test("工具调用行显示工具名与一句话进展", () => {
	const render = (args: Record<string, unknown>): string[] =>
		renderProgressCall(args, theme as never)
			.render(80)
			.map((line) => line.trim());

	assert.deepEqual(render({ text: "Wiring the retry loop into the uploader" }), [
		"progress Wiring the retry loop into the uploader",
	]);
	assert.deepEqual(render({}), ["progress"]);
});
