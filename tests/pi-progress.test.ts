import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { renderProgressCall } from "../extensions/lib/tui/progress.ts";
import { piProgressPrompt } from "../extensions/prompt/pi-progress.ts";

// ─── 测试替身 ───

type WidgetContent = (tui: unknown, theme: unknown) => { render(width: number): string[] };

interface FakeCtx {
	hasUI: boolean;
	ui: { setWidget: (key: string, content: WidgetContent | undefined) => void };
}

type Handler = (event: unknown, ctx: FakeCtx) => unknown;

interface WidgetCall {
	key: string;
	content: WidgetContent | undefined;
}

interface Setup {
	tools: Map<string, Setup["tool"]>;
	tool: {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		parameters: unknown;
		execute: (...args: unknown[]) => Promise<any>;
		renderCall?: (args: unknown, theme: unknown, context: unknown) => { render(width: number): string[] };
	};
	fire: (event: string, ctx?: FakeCtx) => void;
	ctx: FakeCtx;
	widgets: WidgetCall[];
}

const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text };

/** 把一次 setWidget 的工厂渲染成去掉首尾空白的行。 */
function renderWidget(call: WidgetCall, width = 80): string[] {
	assert.ok(call.content);
	return call.content({}, theme).render(width).map((line) => line.trim());
}

/** 每个用例拿到全新的扩展实例，避免注册表互相污染。 */
let moduleSeq = 0;
async function setup(hasUI = true, subAgent = false): Promise<Setup> {
	// 导入时判角色：根代理没有 PI_AGENT_ID，子代理由 herdr-agent 注入。
	const previousAgentId = process.env.PI_AGENT_ID;
	if (subAgent) process.env.PI_AGENT_ID = "a1b2c3";
	else delete process.env.PI_AGENT_ID;

	try {
		const { default: progressExtension } = await import(`../extensions/pi-progress.ts?run=${moduleSeq++}`);

		const tools = new Map<string, Setup["tool"]>();
		const handlers = new Map<string, Handler[]>();

		const pi = {
			on(event: string, handler: Handler) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool(definition: Setup["tool"]) {
				tools.set(definition.name, definition);
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
		};

		return {
			tools,
			tool: tools.get("progress")!,
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

// ─── 设置与展示 ───

test("herdr-agent 拉起的子代理不注册 progress", async () => {
	const { tools, fire, widgets } = await setup(true, true);

	assert.equal(tools.size, 0);
	fire("agent_start");
	assert.deepEqual(widgets, []);
});

test("根代理没有 PI_AGENT_ID 时照常注册", async () => {
	const { tools } = await setup();
	assert.deepEqual([...tools.keys()], ["progress"]);
});

test("progress 注册为模型可见工具，带索引行", async () => {
	const { tool } = await setup();
	assert.equal(tool.name, "progress");
	assert.equal(tool.label, "Progress");
	assert.equal(tool.description, piProgressPrompt.declarations.progress.description);
	assert.equal(tool.promptSnippet, piProgressPrompt.system.snippets.progress);
	assert.ok(tool.renderCall);
});

test("设置进展后写进编辑器上方的 widget", async () => {
	const { tool, ctx, widgets } = await setup();
	const result = await tool.execute("call-1", { text: "Fixing the retry loop" }, undefined, undefined, ctx);

	assert.equal(widgets.length, 1);
	assert.equal(widgets[0].key, "pi-progress");
	assert.deepEqual(renderWidget(widgets[0]), ["▸ Fixing the retry loop"]);
	assert.equal(result.isError, undefined);
	assert.equal(result.details.text, "Fixing the retry loop");
	assert.equal(result.content[0].text, "progress set.");
});

test("连续调用覆盖上一条进展", async () => {
	const { tool, ctx, widgets } = await setup();
	await tool.execute("call-1", { text: "Reading the failing test" }, undefined, undefined, ctx);
	await tool.execute("call-2", { text: "Patching the uploader" }, undefined, undefined, ctx);

	assert.equal(widgets.length, 2);
	assert.deepEqual(renderWidget(widgets[1]), ["▸ Patching the uploader"]);
});

test("换行和多余空白压成一行", async () => {
	const { tool, ctx, widgets } = await setup();
	await tool.execute("call-1", { text: "  Running\n  the   auth tests  " }, undefined, undefined, ctx);

	assert.deepEqual(renderWidget(widgets[0]), ["▸ Running the auth tests"]);
});

test("窄终端下进展行不溢出", async () => {
	const { tool, ctx, widgets } = await setup();
	await tool.execute(
		"call-1",
		{ text: "Wiring the retry loop into the uploader" },
		undefined,
		undefined,
		ctx,
	);

	const lines = renderWidget(widgets[0], 20);
	assert.equal(lines.length, 1);
	assert.ok(visibleWidth(lines[0]) <= 20, `line is ${visibleWidth(lines[0])} columns: ${lines[0]}`);
});

test("没有 UI 时只返回确认，不碰 widget", async () => {
	const { tool, ctx, widgets } = await setup(false);
	const result = await tool.execute("call-1", { text: "Running the auth tests" }, undefined, undefined, ctx);

	assert.deepEqual(widgets, []);
	assert.equal(result.isError, undefined);
	assert.equal(result.content[0].text, "progress set.");
});

// ─── 输入校验 ───

test("空白文本返回错误，不覆盖当前进展", async () => {
	const { tool, ctx, widgets } = await setup();
	await tool.execute("call-1", { text: "Fixing the retry loop" }, undefined, undefined, ctx);
	widgets.length = 0;

	const result = await tool.execute("call-2", { text: " \n\t " }, undefined, undefined, ctx);

	assert.deepEqual(widgets, []);
	assert.equal(result.isError, true);
	assert.equal(result.details.error, piProgressPrompt.results.errors.empty());
	assert.equal(result.content[0].text, "Error: progress text is empty.");
});

test("超长文本返回错误，不写 widget", async () => {
	const { tool, ctx, widgets } = await setup();
	const result = await tool.execute("call-1", { text: "x".repeat(121) }, undefined, undefined, ctx);

	assert.deepEqual(widgets, []);
	assert.equal(result.isError, true);
	assert.equal(result.details.error, piProgressPrompt.results.errors.tooLong(120));
	assert.equal(result.content[0].text, "Error: progress text is longer than 120 characters.");
});

// ─── 清空时机 ───

test("新一轮开始时清空上一轮的进展", async () => {
	const { tool, ctx, widgets, fire } = await setup();
	await tool.execute("call-1", { text: "Fixing the retry loop" }, undefined, undefined, ctx);
	widgets.length = 0;

	fire("agent_start");

	assert.deepEqual(widgets, [{ key: "pi-progress", content: undefined }]);
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
