import assert from "node:assert/strict";
import { test } from "node:test";

import { renderProgressCall } from "../extensions/lib/tui/progress.ts";
import { piProgressPrompt } from "../extensions/prompt/pi-progress.ts";

// ─── 测试替身 ───

interface FakeCtx {
	hasUI: boolean;
	ui: { setStatus: (key: string, text: string | undefined) => void };
}

type Handler = (event: unknown, ctx: FakeCtx) => unknown;

interface StatusCall {
	key: string;
	text: string | undefined;
}

interface Setup {
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
	statuses: StatusCall[];
}

/** 每个用例拿到全新的扩展实例，避免注册表互相污染。 */
let moduleSeq = 0;
async function setup(hasUI = true): Promise<Setup> {
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

	const statuses: StatusCall[] = [];
	const ctx: FakeCtx = {
		hasUI,
		ui: {
			setStatus(key, text) {
				statuses.push({ key, text });
			},
		},
	};

	return {
		tool: tools.get("progress")!,
		ctx,
		statuses,
		fire(event, eventCtx = ctx) {
			for (const handler of handlers.get(event) ?? []) handler({ type: event }, eventCtx);
		},
	};
}

// ─── 设置与展示 ───

test("progress 注册为模型可见工具，带索引行", async () => {
	const { tool } = await setup();
	assert.equal(tool.name, "progress");
	assert.equal(tool.label, "Progress");
	assert.equal(tool.description, piProgressPrompt.declarations.progress.description);
	assert.equal(tool.promptSnippet, piProgressPrompt.system.snippets.progress);
	assert.ok(tool.renderCall);
});

test("设置进展后写进 footer 状态行", async () => {
	const { tool, ctx, statuses } = await setup();
	const result = await tool.execute("call-1", { text: "Fixing the retry loop" }, undefined, undefined, ctx);

	assert.deepEqual(statuses, [{ key: "pi-progress", text: "▸ Fixing the retry loop" }]);
	assert.equal(result.isError, undefined);
	assert.equal(result.details.text, "Fixing the retry loop");
	assert.equal(result.content[0].text, "progress set.");
});

test("连续调用覆盖上一条进展", async () => {
	const { tool, ctx, statuses } = await setup();
	await tool.execute("call-1", { text: "Reading the failing test" }, undefined, undefined, ctx);
	await tool.execute("call-2", { text: "Patching the uploader" }, undefined, undefined, ctx);

	assert.deepEqual(statuses, [
		{ key: "pi-progress", text: "▸ Reading the failing test" },
		{ key: "pi-progress", text: "▸ Patching the uploader" },
	]);
});

test("换行和多余空白压成一行", async () => {
	const { tool, ctx, statuses } = await setup();
	await tool.execute("call-1", { text: "  Running\n  the   auth tests  " }, undefined, undefined, ctx);

	assert.deepEqual(statuses, [{ key: "pi-progress", text: "▸ Running the auth tests" }]);
});

test("没有 UI 时只返回确认，不碰状态行", async () => {
	const { tool, ctx, statuses } = await setup(false);
	const result = await tool.execute("call-1", { text: "Running the auth tests" }, undefined, undefined, ctx);

	assert.deepEqual(statuses, []);
	assert.equal(result.isError, undefined);
	assert.equal(result.content[0].text, "progress set.");
});

// ─── 输入校验 ───

test("空白文本返回错误，不覆盖当前进展", async () => {
	const { tool, ctx, statuses } = await setup();
	await tool.execute("call-1", { text: "Fixing the retry loop" }, undefined, undefined, ctx);
	statuses.length = 0;

	const result = await tool.execute("call-2", { text: " \n\t " }, undefined, undefined, ctx);

	assert.deepEqual(statuses, []);
	assert.equal(result.isError, true);
	assert.equal(result.details.error, piProgressPrompt.results.errors.empty());
	assert.equal(result.content[0].text, "Error: progress text is empty.");
});

test("超长文本返回错误，不写状态行", async () => {
	const { tool, ctx, statuses } = await setup();
	const result = await tool.execute("call-1", { text: "x".repeat(121) }, undefined, undefined, ctx);

	assert.deepEqual(statuses, []);
	assert.equal(result.isError, true);
	assert.equal(result.details.error, piProgressPrompt.results.errors.tooLong(120));
	assert.equal(result.content[0].text, "Error: progress text is longer than 120 characters.");
});

// ─── 清空时机 ───

test("新一轮开始时清空上一轮的进展", async () => {
	const { tool, ctx, statuses, fire } = await setup();
	await tool.execute("call-1", { text: "Fixing the retry loop" }, undefined, undefined, ctx);
	statuses.length = 0;

	fire("agent_start");

	assert.deepEqual(statuses, [{ key: "pi-progress", text: undefined }]);
});

test("会话启动与退出时也清空，避免跨会话残留", async () => {
	const { statuses, fire } = await setup();

	fire("session_start");
	fire("session_shutdown");

	assert.deepEqual(statuses, [
		{ key: "pi-progress", text: undefined },
		{ key: "pi-progress", text: undefined },
	]);
});

test("没有 UI 时清空事件不写状态", async () => {
	const { statuses, fire } = await setup(false);

	fire("agent_start");
	fire("session_start");
	fire("session_shutdown");

	assert.deepEqual(statuses, []);
});

// ─── 工具调用行 ───

test("工具调用行显示工具名与一句话进展", () => {
	const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text };
	const render = (args: Record<string, unknown>): string[] =>
		renderProgressCall(args, theme as never)
			.render(80)
			.map((line) => line.trim());

	assert.deepEqual(render({ text: "Wiring the retry loop into the uploader" }), [
		"progress Wiring the retry loop into the uploader",
	]);
	assert.deepEqual(render({}), ["progress"]);
});
