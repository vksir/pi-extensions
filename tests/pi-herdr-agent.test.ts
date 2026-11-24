import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	formatAgentEnvelope,
	parseAgentEnvelope,
	stripHcTransport,
	validateAgentName,
} from "../extensions/lib/agent-protocol.ts";
import { hasBusyActivity, registerBusyProbe } from "../extensions/lib/activity.ts";
import {
	buildRows,
	currentTree,
	formatAgentTree,
	formatRows,
	isDescendant,
	normalizeDestroyTime,
	parseDestroyTime,
	readSessionFacts,
	rewriteDoneStatus,
	rootIdOf,
	type AgentRow,
} from "../extensions/pi-herdr-agent.ts";
import { type TreeLine } from "../extensions/lib/tui/agent-tree.ts";
import { HcError, type HcClient, type HcLabelParams, type HcRunParams, type HcRunResult, type HcSendParams, type HcSendResult, type HcTerminal, type HcWaitParams, type HcWaitResult } from "../extensions/lib/hc.ts";

// ─── 测试替身 ───

interface ToolCallResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
}

interface FakePi {
	tools: Map<
		string,
		{
			name: string;
			description: string;
			parameters?: unknown;
			execute: (...args: unknown[]) => Promise<ToolCallResult>;
			renderCall?: (args: any, theme: any, context: any) => { render(width: number): string[] };
		}
	>;
	handlers: Map<string, ((...args: unknown[]) => unknown)[]>;
	commands: Map<string, (args: string, ctx: unknown) => Promise<void> | void>;
	entries: { type: string; data: any }[];
	userMessages: string[];
	messages: { message: { customType?: string; content?: unknown; details?: unknown }; options?: unknown }[];
	messageRenderers: Map<string, (message: any, options: any, theme: any) => { render(width: number): string[] } | undefined>;
	settings: { steeringMode?: "all" | "one-at-a-time"; followUpMode?: "all" | "one-at-a-time" };
	getSettings: () => { steeringMode?: "all" | "one-at-a-time"; followUpMode?: "all" | "one-at-a-time" };
	registerTool: (definition: {
		name: string;
		description: string;
		parameters?: unknown;
		execute: (...args: unknown[]) => Promise<ToolCallResult>;
		renderCall?: (args: any, theme: any, context: any) => { render(width: number): string[] };
	}) => void;
	on: (event: string, handler: (...args: unknown[]) => unknown) => void;
	registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> | void }) => void;
	registerEntryRenderer: () => void;
	registerMessageRenderer: (customType: string, renderer: any) => void;
	appendEntry: (type: string, data: unknown) => void;
	sendUserMessage: (content: unknown) => void;
	sendMessage: (message: any, options?: unknown) => void;
	emit: (event: string, ...args: unknown[]) => Promise<unknown>;
}

function createFakePi(): FakePi {
	const tools: FakePi["tools"] = new Map();
	const handlers: FakePi["handlers"] = new Map();
	const commands: FakePi["commands"] = new Map();
	const entries: FakePi["entries"] = [];
	const userMessages: string[] = [];
	const messages: FakePi["messages"] = [];
	const messageRenderers: FakePi["messageRenderers"] = new Map();
	const settings: { steeringMode?: "all" | "one-at-a-time"; followUpMode?: "all" | "one-at-a-time" } = {
		steeringMode: "all",
	};
	return {
		tools,
		handlers,
		commands,
		entries,
		userMessages,
		messages,
		messageRenderers,
		settings,
		getSettings: () => settings,
		registerTool(definition) {
			tools.set(definition.name, definition);
		},
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name, options) {
			commands.set(name, options.handler);
		},
		registerEntryRenderer() {},
		registerMessageRenderer(customType, renderer) {
			messageRenderers.set(customType, renderer);
		},
		appendEntry(type, data) {
			entries.push({ type, data });
		},
		sendUserMessage(content) {
			userMessages.push(String(content));
		},
		sendMessage(message, options) {
			messages.push({ message, options });
		},
		async emit(event, ...args) {
			let last: unknown;
			for (const handler of handlers.get(event) ?? []) last = await handler(...args);
			return last;
		},
	};
}

function terminal(overrides: Partial<HcTerminal> = {}): HcTerminal {
	return {
		address: "t10",
		argv: ["pi"],
		cwd: "D:\\repo",
		name: null,
		labels: {},
		parent: null,
		state: "live",
		status: { app: "pi", state: "idle" },
		turn: 0,
		title: "π - root",
		exit_code: null,
		reason: null,
		...overrides,
	};
}

function waitResult(overrides: Partial<HcWaitResult> = {}): HcWaitResult {
	return {
		terminal: "t10",
		ended: true,
		reason: "status",
		status: "idle",
		turn: 0,
		exit_code: null,
		signal: null,
		from: null,
		...overrides,
	};
}

class FakeHc implements HcClient {
	readonly calls: { method: string; params: any }[] = [];
	terminals: HcTerminal[] = [];
	runResult: HcRunResult = { ...terminal({ address: "t10" }), output: "", wait: waitResult() };
	sendResult: HcSendResult = { started: true, status: "idle", turn: 1, wait: null };

	record(method: string, params: unknown): void {
		this.calls.push({ method, params });
	}

	callsOf(method: string): { method: string; params: any }[] {
		return this.calls.filter((call) => call.method === method);
	}

	async run(params: HcRunParams): Promise<HcRunResult> {
		this.record("run", params);
		return this.runResult;
	}

	async send(params: HcSendParams): Promise<HcSendResult> {
		this.record("send", params);
		return this.sendResult;
	}

	async wait(params: HcWaitParams): Promise<HcWaitResult> {
		this.record("wait", params);
		return waitResult({ terminal: params.terminal });
	}

	async get(name: string) {
		this.record("get", { terminal: name });
		const found = this.terminals.find((candidate) => candidate.address === name);
		if (!found) throw new HcError("not_found", `no terminal "${name}"`);
		return found;
	}

	async list() {
		this.record("list", {});
		return this.terminals;
	}

	async keys(params: { terminal: string; keys: string[] }) {
		this.record("keys", params);
		// 模拟优雅退出：终端自己消失。
		this.terminals = this.terminals.filter((candidate) => candidate.address !== params.terminal);
		return { status: "working", turn: 0 };
	}

	async kill(name: string) {
		this.record("kill", { terminal: name });
		return terminal({ address: name, state: "finished" });
	}

	async label(params: HcLabelParams) {
		this.record("label", params);
		return this.terminals.find((candidate) => candidate.address === params.terminal) ?? terminal({ address: params.terminal });
	}
}

interface FakeCtx {
	cwd: string;
	model: { provider: string; id: string } | undefined;
	thinkingLevel: string | undefined;
	sessionManager: { getSessionName: () => string | undefined; getSessionId: () => string };
	modelRegistry: { getAll: () => { provider: string; id: string; name?: string }[] };
	ui: { notify: (message: string, type?: string) => void };
	isIdle: () => boolean;
	shutdown: () => void;
}

function context(overrides: Partial<FakeCtx> = {}): FakeCtx {
	return {
		cwd: "D:\\repo",
		model: { provider: "p", id: "m" },
		thinkingLevel: "high",
		sessionManager: {
			getSessionName: () => undefined,
			getSessionId: () => "0193a5c4-8f2b-7c3d-9e01-2b3c4d5e6f70",
		},
		modelRegistry: { getAll: () => [{ provider: "p", id: "m", name: "M" }] },
		ui: { notify: () => undefined },
		isIdle: () => true,
		shutdown: () => undefined,
		...overrides,
	};
}

let moduleSeq = 0;

async function setup(
	options: {
		env?: Record<string, string>;
		hc?: FakeHc;
		sessionDir?: string;
		now?: () => number;
		schedule?: (tick: () => void, ms: number) => () => void;
		stopGraceMs?: number;
	} = {},
) {
	const { default: extension } = await import(`../extensions/pi-herdr-agent.ts?run=${moduleSeq++}`);
	const pi = createFakePi();
	const hc = options.hc ?? new FakeHc();
	extension(pi as never, {
		hc,
		env: {
			HC_TERMINAL_ID: "t4m",
			HC_TERMINAL_SOCKET: "\\\\.\\pipe\\test",
			...options.env,
		} as NodeJS.ProcessEnv,
		sessionDir: options.sessionDir,
		now: options.now,
		schedule: options.schedule,
		stopGraceMs: options.stopGraceMs,
	});
	return { pi, hc };
}

function toolResultText(result: ToolCallResult): string {
	return result.content.map((block) => block.text).join("\n");
}

// ─── 工具注册 ───

test("registers nothing outside an hc terminal", async () => {
	const { default: extension } = await import(`../extensions/pi-herdr-agent.ts?run=${moduleSeq++}`);
	const pi = createFakePi();
	extension(pi as never, { hc: new FakeHc(), env: { HC_TERMINAL_SOCKET: "x" } as NodeJS.ProcessEnv });
	assert.equal(pi.tools.size, 0);
});

test("root registers agent and agent_job; depth 2 registers only agent_job", async () => {
	const root = await setup();
	assert.deepEqual([...root.pi.tools.keys()].sort(), ["agent", "agent_job"]);

	const grandchild = await setup({ env: { PI_AGENT_ID: "abcd", PI_AGENT_DEPTH: "2" } });
	assert.deepEqual([...grandchild.pi.tools.keys()], ["agent_job"]);
});

test("agent tool exposes destroy_time and no longer the old parameter name", async () => {
	const { pi } = await setup();
	const schema = pi.tools.get("agent")?.parameters as { properties: Record<string, { description?: string }> };
	assert.deepEqual(Object.keys(schema.properties).sort(), ["destroy_time", "model", "name", "prompt", "resume", "thinking"]);
	assert.match(schema.properties.destroy_time.description ?? "", /^Seconds of idleness before the agent process is destroyed/);
});

test("守则挂在 agent_job 上（深度 2 也有），agent 不再带守则", async () => {
	const { pi } = await setup();
	const agent = pi.tools.get("agent") as unknown as { promptGuidelines?: string[] };
	const job = pi.tools.get("agent_job") as unknown as { promptGuidelines?: string[] };
	assert.equal(agent.promptGuidelines, undefined);
	assert.deepEqual(job.promptGuidelines, [
		"Do not sleep or poll to wait for an agent you started or messaged.",
	]);
});

// ─── agent 拉起 ───

test("agent launches pi with identity env, labels and the source line", async () => {
	const hc = new FakeHc();
	const { pi } = await setup({ hc });

	const result = await pi.tools.get("agent")!.execute(
		"call",
		{ prompt: "do the thing", name: "reviewer", model: "p/m2", thinking: "low" },
		undefined,
		undefined,
		context(),
	);
	const text = toolResultText(result);
	assert.match(text, /^Started agent [0-9a-f]{6} as 'reviewer'\./);

	const run = hc.callsOf("run")[0].params;
	const argv = run.argv as string[];
	const sessionId = argv[argv.indexOf("--session-id") + 1];
	const id = sessionId.slice("pi-".length);
	assert.match(id, /^[0-9a-f]{6}$/);
	assert.deepEqual(run.labels, { "pi.agent": id });
	assert.equal(run.name, "reviewer");
	assert.equal(run.parent, "t4m");
	assert.equal(run.rm, true);
	assert.equal(run.no_notify, true);
	assert.equal(run.wait, true);
	assert.deepEqual(run.env, {
		PI_AGENT_ID: id,
		PI_AGENT_NAME: "reviewer",
		PI_AGENT_PARENT: "t4m",
		PI_AGENT_ROOT: "t4m",
		PI_AGENT_DEPTH: "1",
		PI_AGENT_DESTROY_TIME: "180",
	});
	assert.ok(argv.includes("--model") && argv.includes("p/m2"));
	assert.ok(argv.includes("--thinking") && argv.includes("low"));

	const send = hc.callsOf("send")[0].params;
	assert.equal(send.terminal, "t10");
	assert.equal(send.caller, "t4m");
	const envelope = parseAgentEnvelope(String(send.text));
	assert.equal(envelope?.from, "t4m");
	assert.equal(envelope?.type, "task");
	assert.equal(envelope?.name, undefined); // 根没有注入的名字，会话也未命名
	assert.equal(envelope?.body, "do the thing");
	assert.ok(text.includes(id));
});

test("task messages carry the note; reply messages do not", async () => {
	const hc = new FakeHc();
	hc.terminals = [terminal({ address: "t10", name: "kid", labels: { "pi.agent": "aaaa" } })];
	const { pi } = await setup({ hc });

	await pi.tools.get("agent")!.execute("call", { prompt: "x" }, undefined, undefined, context());

	const sent = String(hc.callsOf("send")[0].params.text);
	assert.equal(
		sent,
		[
			'<agent_message from="t4m" type="task">',
			"  <content>",
			"    x",
			"  </content>",
			"  <note>",
			'    Your output is not returned automatically. Use agent_job send with type="reply" to reply.',
			"  </note>",
			"</agent_message>",
		].join("\n"),
	);

	const reply = await pi.tools
		.get("agent_job")!
		.execute("call", { action: "send", id: "aaaa", message: "done", type: "reply" }, undefined, undefined, context());
	assert.match(toolResultText(reply), /^Sent to aaaa/);
	const replyText = String(hc.callsOf("send")[1].params.text);
	assert.ok(!replyText.includes("<note>"));
	assert.equal(parseAgentEnvelope(replyText)?.type, "reply");
});

test("agent messages render as a card, collapsed when long", async () => {
	const { pi } = await setup();
	const renderer = pi.messageRenderers.get("pi-herdr-agent");
	assert.ok(renderer);

	const theme = {
		fg: (_token: string, text: string) => text,
		bg: (_token: string, text: string) => text,
		bold: (text: string) => text,
	};
	const render = (expanded: boolean): string[] => {
		const body = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n");
		const box = renderer!(
			{
				customType: "pi-herdr-agent",
				content: "<xml/>",
				display: true,
				details: { from: "aaaa", name: "kid", type: "reply", body },
			},
			{ expanded, outputPad: 0 },
			theme,
		);
		assert.ok(box);
		return box.render(80).map((line) => line.trim());
	};

	const collapsed = render(false);
	assert.ok(collapsed.some((line) => line.includes("agent_message")));
	assert.ok(collapsed.some((line) => line.includes("kid (aaaa) · reply")));
	assert.equal(collapsed.filter((line) => /^line \d+$/.test(line)).length, 4);
	assert.ok(collapsed.some((line) => line.includes("4 more lines")));

	const expanded = render(true);
	assert.equal(expanded.filter((line) => /^line \d+$/.test(line)).length, 8);
	assert.ok(!expanded.some((line) => line.includes("more lines")));
});

test("agent_job send renders the message under a bold header, collapsed when long", async () => {
	const { pi } = await setup();
	const tool = pi.tools.get("agent_job")!;
	assert.ok(tool.renderCall);

	const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text };
	const body = Array.from({ length: 6 }, (_, index) => `line ${index + 1}`).join("\n");
	const render = (args: Record<string, unknown>, expanded: boolean): string[] =>
		tool
			.renderCall!(args, theme, { expanded, keyHint: (_id: string, description: string) => `ctrl+o ${description}` })
			.render(80)
			.map((line) => line.trim());

	const collapsed = render({ action: "send", id: "aaaa", message: body }, false);
	assert.equal(collapsed[0], "agent_job send aaaa");
	assert.equal(collapsed.filter((line) => /^line \d+$/.test(line)).length, 3);
	assert.ok(collapsed.some((line) => line.includes("3 more lines")));

	const expanded = render({ action: "send", id: "aaaa", message: body }, true);
	assert.equal(expanded.filter((line) => /^line \d+$/.test(line)).length, 6);
	assert.deepEqual(render({ action: "list" }, false), ["agent_job list"]);
});

test("agent defaults model and thinking to the caller's", async () => {
	const hc = new FakeHc();
	const { pi } = await setup({ hc });
	await pi.tools.get("agent")!.execute("call", { prompt: "x" }, undefined, undefined, context());
	const argv = hc.callsOf("run")[0].params.argv as string[];
	assert.ok(argv.includes("--model") && argv.includes("p/m"));
	assert.ok(argv.includes("--thinking") && argv.includes("high"));
});

test("agent rejects an invalid name before starting anything", async () => {
	const hc = new FakeHc();
	const { pi } = await setup({ hc });
	const result = await pi.tools
		.get("agent")!
		.execute("call", { prompt: "x", name: "代码审查" }, undefined, undefined, context());
	assert.match(toolResultText(result), /^Error: invalid name/);
	assert.equal(hc.callsOf("run").length, 0);
});

test("agent surfaces a taken name", async () => {
	const hc = new FakeHc();
	hc.run = async () => {
		throw new HcError("name_taken", "name_taken");
	};
	const { pi } = await setup({ hc });
	const result = await pi.tools.get("agent")!.execute("call", { prompt: "x", name: "dup" }, undefined, undefined, context());
	assert.match(toolResultText(result), /name 'dup' is already used by a running agent/);
});

test("agent reports why pi never became ready", async () => {
	const hc = new FakeHc();
	hc.runResult = { ...terminal({ address: "t10", state: "finished" }), output: "boom: bad flag", wait: waitResult({ reason: "exit", status: null }) };
	const { pi } = await setup({ hc });
	const result = await pi.tools.get("agent")!.execute("call", { prompt: "x" }, undefined, undefined, context());
	assert.match(toolResultText(result), /pi exited before it was ready: boom: bad flag/);
	assert.equal(hc.callsOf("kill").length, 1);
});

// ─── agent_job ───

test("list shows relations, depth and orphans across the session", async () => {
	const root = terminal({ address: "t4m", name: "root", labels: {} });
	const child = terminal({ address: "t10", name: "reviewer", parent: "t4m", labels: { "pi.agent": "aaaa" } });
	const sibling = terminal({ address: "t11", name: "helper", parent: "t4m", labels: { "pi.agent": "bbbb" } });
	const grandchild = terminal({ address: "t12", name: "deep", parent: "t10", labels: { "pi.agent": "cccc" } });
	const orphan = terminal({ address: "t13", name: "lost", parent: "t99", labels: { "pi.agent": "dddd" } });

	const rows = buildRows([root, child, sibling, grandchild, orphan], "aaaa", "t10");
	const byId = new Map(rows.map((row) => [row.id, row]));
	assert.equal(byId.get("t4m")?.relation, "parent");
	assert.equal(byId.get("aaaa")?.relation, "self");
	assert.equal(byId.get("bbbb")?.relation, "sibling");
	assert.equal(byId.get("cccc")?.relation, "child");
	assert.equal(byId.get("t4m")?.depth, 0);
	assert.equal(byId.get("aaaa")?.depth, 1);
	assert.equal(byId.get("cccc")?.depth, 2);
	assert.equal(byId.get("dddd")?.orphan, true);

	const table = formatRows(rows);
	assert.match(table, /^id\s+name\s+relation/);
	assert.ok(!table.includes("cwd"));
	assert.match(table, /dddd\s+lost\s+other\s+idle \(orphan\)/);
});

test("send never checks the target's status", async () => {
	const hc = new FakeHc();
	hc.terminals = [
		terminal({ address: "t10", name: "reviewer", labels: { "pi.agent": "aaaa" }, status: { app: "pi", state: "working" } }),
	];
	const { pi } = await setup({ hc });

	const busy = await pi.tools.get("agent_job")!.execute("call", { action: "send", id: "aaaa", message: "hi" }, undefined, undefined, context());
	assert.match(toolResultText(busy), /^Sent to aaaa \(reviewer\)\.$/);
	assert.equal(hc.callsOf("send").length, 1);

	const send = hc.callsOf("send")[0].params;
	assert.equal(send.terminal, "t10");
	assert.equal(send.if, undefined); // 不再带状态前置条件
	const envelope = parseAgentEnvelope(String(send.text));
	assert.equal(envelope?.body, "hi");
	assert.equal(envelope?.type, "task"); // 没给 type：按 task
	assert.match(String(send.text), /<note>/);
});

test("stop only reaches descendants, and asks first before killing", async () => {
	const hc = new FakeHc();
	hc.terminals = [
		terminal({ address: "t4m", labels: {} }),
		terminal({ address: "t20", labels: { "pi.agent": "eeee" }, parent: null }),
		terminal({ address: "t10", labels: { "pi.agent": "aaaa" }, parent: "t4m" }),
	];
	const { pi } = await setup({ hc, stopGraceMs: 20 });

	const stranger = await pi.tools.get("agent_job")!.execute("call", { action: "stop", id: "eeee" }, undefined, undefined, context());
	assert.match(toolResultText(stranger), /not your descendant/);
	assert.equal(hc.callsOf("keys").length, 0);
	assert.equal(hc.callsOf("kill").length, 0);

	// 正常路径：先发 ctrl+d 请它自己退出，对方退出后不再硬杀。
	const own = await pi.tools.get("agent_job")!.execute("call", { action: "stop", id: "aaaa" }, undefined, undefined, context());
	assert.match(toolResultText(own), /^Stopped agent aaaa/);
	assert.equal(hc.callsOf("keys")[0].params.terminal, "t10");
	assert.deepEqual(hc.callsOf("keys")[0].params.keys, ["ctrl+d"]);
	assert.equal(hc.callsOf("kill").length, 0);
});

test("stop falls back to a hard kill when the agent does not quit in time", async () => {
	const hc = new FakeHc();
	hc.terminals = [terminal({ address: "t10", labels: { "pi.agent": "aaaa" }, parent: "t4m" })];
	// 按键无效：终端一直活着。
	hc.keys = async (params: { terminal: string; keys: string[] }) => {
		hc.record("keys", params);
		return { status: "working", turn: 0 };
	};
	const { pi } = await setup({ hc, stopGraceMs: 1 });

	const result = await pi.tools.get("agent_job")!.execute("call", { action: "stop", id: "aaaa" }, undefined, undefined, context());
	assert.match(toolResultText(result), /^Stopped agent aaaa/);
	assert.equal(hc.callsOf("keys").length, 2); // 中止一下 + 退出一下
	assert.equal(hc.callsOf("kill")[0].params.terminal, "t10");
});

test("stop reports success when the terminal is already gone", async () => {
	const hc = new FakeHc();
	hc.terminals = [terminal({ address: "t10", labels: { "pi.agent": "aaaa" }, parent: "t4m" })];
	hc.keys = async () => {
		throw new HcError("not_found", "t10 was removed");
	};
	hc.kill = async () => {
		throw new HcError("not_found", "t10 was removed");
	};
	const { pi } = await setup({ hc, stopGraceMs: 1 });
	const result = await pi.tools.get("agent_job")!.execute("call", { action: "stop", id: "aaaa" }, undefined, undefined, context());
	assert.match(toolResultText(result), /^Stopped agent aaaa/);
});

test("list hides anything outside self, parent, children and siblings", async () => {
	const hc = new FakeHc();
	hc.terminals = [
		terminal({ address: "t4m", name: "root", labels: {} }),
		terminal({ address: "t10", name: "me", labels: { "pi.agent": "aaaa" }, parent: "t4m" }),
		terminal({ address: "t11", name: "sib", labels: { "pi.agent": "bbbb" }, parent: "t4m" }),
		terminal({ address: "t12", name: "kid", labels: { "pi.agent": "cccc" }, parent: "t10" }),
		terminal({ address: "t13", name: "grandkid", labels: { "pi.agent": "dddd" }, parent: "t12" }),
		terminal({ address: "t20", name: "stranger", labels: { "pi.agent": "eeee" }, parent: null }),
	];
	const { pi } = await setup({
		hc,
		env: { HC_TERMINAL_ID: "t10", PI_AGENT_ID: "aaaa", PI_AGENT_DEPTH: "1" },
	});

	const result = await pi.tools.get("agent_job")!.execute("call", { action: "list" }, undefined, undefined, context());
	const rows = result.details.agents as AgentRow[];
	assert.deepEqual(rows.map((row) => row.id).sort(), ["aaaa", "bbbb", "cccc", "t4m"]);
	// 孙辈与别的树都不可见。
	assert.ok(!rows.some((row) => row.id === "dddd" || row.id === "eeee"));
});

test("every inbound agent message is passed through, busy or idle", async () => {
	const hc = new FakeHc();
	hc.terminals = [
		terminal({ address: "t7", labels: { "pi.agent": "aaaa" } }),
		terminal({ address: "t8", labels: { "pi.agent": "bbbb" } }),
	];
	const { pi } = await setup({ hc, env: { PI_AGENT_ID: "cccc", PI_AGENT_DEPTH: "1" } });

	// 空闲：原文被吞掉，转成自定义消息（triggerTurn 起一轮）。
	const first = formatAgentEnvelope({ from: "aaaa", body: "task A" });
	assert.deepEqual(await pi.emit("input", { type: "input", text: first }), { action: "handled" });
	assert.equal(pi.messages.length, 1);
	assert.equal(pi.messages[0].message.content, first);
	assert.deepEqual(pi.messages[0].options, { deliverAs: "steer", triggerTurn: true });
	await pi.emit("agent_start");

	// 忙时同样转成自定义消息：插不插队交给 pi。
	const more = formatAgentEnvelope({ from: "bbbb", type: "reply", body: "task B" });
	assert.deepEqual(
		await pi.emit("input", { type: "input", text: more, streamingBehavior: "steer" }),
		{ action: "handled" },
	);
	assert.equal(pi.messages.length, 2);
	assert.equal(pi.messages[1].message.content, more);

	// 收工：扩展一条消息也不发，也不自己起下一轮。
	await pi.emit("agent_settled", { type: "agent_settled", aborted: false }, context());
	assert.equal(hc.callsOf("send").length, 0);
	assert.deepEqual(pi.userMessages, []);
});

test("a message arriving while the previous round is settling is still passed through", async () => {
	const hc = new FakeHc();
	hc.terminals = [
		terminal({ address: "t7", labels: { "pi.agent": "aaaa" } }),
		terminal({ address: "t8", labels: { "pi.agent": "bbbb" } }),
	];
	const { pi } = await setup({ hc, env: { PI_AGENT_ID: "cccc", PI_AGENT_DEPTH: "1" } });

	await pi.emit("input", { type: "input", text: formatAgentEnvelope({ from: "aaaa", body: "task A" }) });
	await pi.emit("agent_start");

	const settled = pi.emit("agent_settled", { type: "agent_settled", aborted: false }, context());
	const arrivingText = formatAgentEnvelope({ from: "bbbb", body: "task B" });
	const arriving = await pi.emit("input", { type: "input", text: arrivingText });
	assert.deepEqual(arriving, { action: "handled" });

	await settled;
	assert.equal(hc.callsOf("send").length, 0);
	assert.deepEqual(pi.userMessages, []);
});

test("settling never messages anyone on its own: replies only happen through send", async () => {
	const hc = new FakeHc();
	hc.terminals = [terminal({ address: "t7", labels: { "pi.agent": "aaaa" } })];
	const { pi } = await setup({ hc, env: { PI_AGENT_ID: "abcd", PI_AGENT_DEPTH: "1" } });

	await pi.emit("input", { type: "input", text: formatAgentEnvelope({ from: "aaaa", body: "q" }) });
	await pi.emit("agent_start");
	await pi.emit("agent_settled", { type: "agent_settled", aborted: false }, context());
	await pi.emit("input", { type: "input", text: formatAgentEnvelope({ from: "aaaa", body: "q2" }) });
	await pi.emit("agent_start");
	await pi.emit("agent_settled", { type: "agent_settled", aborted: true }, context());
	assert.equal(hc.callsOf("send").length, 0);

	const result = await pi.tools
		.get("agent_job")!
		.execute("call", { action: "send", id: "aaaa", message: "the answer" }, undefined, undefined, context());
	assert.match(toolResultText(result), /^Sent to aaaa/);

	assert.equal(hc.callsOf("send").length, 1);
	const send = hc.callsOf("send")[0].params;
	assert.equal(send.terminal, "t7");
	const envelope = parseAgentEnvelope(String(send.text));
	assert.equal(envelope?.from, "abcd");
	assert.equal(envelope?.body, "the answer");
});

test("an ask without a reply is reported once the target's whole subtree is gone", async () => {
	const hc = new FakeHc();
	hc.terminals = [
		terminal({ address: "t4m", labels: {} }),
		terminal({ address: "t10", name: "kid", labels: { "pi.agent": "aaaa" }, parent: "t4m" }),
	];
	const scheduler = manualSchedule();
	const { pi } = await setup({ hc, schedule: scheduler.schedule });

	await pi.tools
		.get("agent_job")!
		.execute("call", { action: "send", id: "aaaa", message: "hi" }, undefined, undefined, context());
	assert.equal(scheduler.ticks.length, 1);

	// 孙子还活着：这一棵还没收场，继续等。
	hc.terminals = [
		terminal({ address: "t4m", labels: {} }),
		terminal({ address: "t11", name: "grandkid", labels: { "pi.agent": "bbbb" }, parent: "t10" }),
	];
	await tickOnce(scheduler.ticks.shift());
	assert.equal(pi.messages.length, 0);

	// 整个子树都没了：给本地 agent 补一条。
	hc.terminals = [terminal({ address: "t4m", labels: {} })];
	await tickOnce(scheduler.ticks.shift());
	assert.equal(pi.messages.length, 1);
	const notice = parseAgentEnvelope(String(pi.messages[0].message.content));
	assert.equal(notice?.type, "notice");
	assert.equal(notice?.from, "aaaa");
	assert.equal(notice?.name, "kid");
	assert.equal(notice?.body, "It exited without replying.");
	assert.equal(scheduler.ticks.length, 0); // 账销了，不再盯
});

test("a reply cancels the pending death notice", async () => {
	const hc = new FakeHc();
	hc.terminals = [
		terminal({ address: "t4m", labels: {} }),
		terminal({ address: "t10", name: "kid", labels: { "pi.agent": "aaaa" }, parent: "t4m" }),
	];
	const scheduler = manualSchedule();
	const { pi } = await setup({ hc, schedule: scheduler.schedule });

	await pi.tools
		.get("agent_job")!
		.execute("call", { action: "send", id: "aaaa", message: "hi" }, undefined, undefined, context());
	await pi.emit("input", {
		type: "input",
		text: formatAgentEnvelope({ from: "aaaa", name: "kid", type: "reply", body: "done" }),
	});

	hc.terminals = [terminal({ address: "t4m", labels: {} })];
	await tickOnce(scheduler.ticks.shift());
	// 只剩那条入站 reply，没有 notice。
	assert.ok(pi.messages.every((entry) => parseAgentEnvelope(String(entry.message.content))?.type === "reply"));
});

test("a task from the target does not clear the pending ask", async () => {
	const hc = new FakeHc();
	hc.terminals = [
		terminal({ address: "t4m", labels: {} }),
		terminal({ address: "t10", name: "kid", labels: { "pi.agent": "aaaa" }, parent: "t4m" }),
	];
	const scheduler = manualSchedule();
	const { pi } = await setup({ hc, schedule: scheduler.schedule });

	await pi.tools
		.get("agent_job")!
		.execute("call", { action: "send", id: "aaaa", message: "hi" }, undefined, undefined, context());
	// 对方发来的是新活，不是对我那条的回答：账不销。
	await pi.emit("input", {
		type: "input",
		text: formatAgentEnvelope({ from: "aaaa", name: "kid", type: "task", body: "another job" }),
	});

	hc.terminals = [terminal({ address: "t4m", labels: {} })];
	await tickOnce(scheduler.ticks.shift());
	assert.equal(
		pi.messages.filter((entry) => parseAgentEnvelope(String(entry.message.content))?.type === "notice").length,
		1,
	);
});

test("each send needs its own reply before the ledger is clear", async () => {
	const hc = new FakeHc();
	hc.terminals = [
		terminal({ address: "t4m", labels: {} }),
		terminal({ address: "t10", name: "kid", labels: { "pi.agent": "aaaa" }, parent: "t4m" }),
	];
	const scheduler = manualSchedule();
	const { pi } = await setup({ hc, schedule: scheduler.schedule });

	const send = async (): Promise<void> => {
		await pi.tools
			.get("agent_job")!
			.execute("call", { action: "send", id: "aaaa", message: "hi" }, undefined, undefined, context());
	};
	await send();
	await send();

	// 只回了一条：还剩一笔账，对方挂了仍要通知。
	await pi.emit("input", {
		type: "input",
		text: formatAgentEnvelope({ from: "aaaa", name: "kid", type: "reply", body: "done" }),
	});
	hc.terminals = [terminal({ address: "t4m", labels: {} })];
	await tickOnce(scheduler.ticks.shift());
	assert.equal(
		pi.messages.filter((entry) => parseAgentEnvelope(String(entry.message.content))?.type === "notice").length,
		1,
	);
});

test("only quit tears down direct children", async () => {
	const hc = new FakeHc();
	hc.terminals = [
		terminal({ address: "t10", labels: { "pi.agent": "aaaa" }, parent: "t4m" }),
		terminal({ address: "t11", labels: { "pi.agent": "bbbb" }, parent: "t10" }),
	];
	const { pi } = await setup({ hc });

	await pi.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
	assert.equal(hc.callsOf("kill").length, 0);

	await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	assert.deepEqual(hc.callsOf("kill").map((call) => call.params.terminal), ["t10"]);
});

// ─── 空闲销毁 ───

/** 手动调度器：把扩展注册的每一拍收起来，由测试决定何时走一拍。 */
function manualSchedule() {
	const ticks: (() => void)[] = [];
	let cancels = 0;
	return {
		ticks,
		get cancels() {
			return cancels;
		},
		schedule: (tick: () => void): (() => void) => {
			ticks.push(tick);
			return () => {
				cancels += 1;
			};
		},
	};
}

/** 走一拍并等它内部的异步探测跑完。 */
async function tickOnce(tick: (() => void) | undefined): Promise<void> {
	tick?.();
	await new Promise((resolve) => setImmediate(resolve));
}

function childEnv(destroyTime: string): Record<string, string> {
	return { PI_AGENT_ID: "abcd", PI_AGENT_DEPTH: "1", PI_AGENT_DESTROY_TIME: destroyTime };
}

test("a quiet child shuts itself down after destroy_time", async () => {
	const hc = new FakeHc();
	const clock = { value: 0 };
	const scheduler = manualSchedule();
	const { pi } = await setup({
		hc,
		env: childEnv("180"),
		now: () => clock.value,
		schedule: scheduler.schedule,
	});
	const shutdowns: number[] = [];
	const ctx = context({ shutdown: () => shutdowns.push(clock.value) });

	await pi.emit("agent_settled", { type: "agent_settled", aborted: false }, ctx);
	assert.equal(scheduler.ticks.length, 1);

	clock.value = 179_000;
	await tickOnce(scheduler.ticks[0]);
	assert.deepEqual(shutdowns, []);

	clock.value = 180_000;
	await tickOnce(scheduler.ticks[0]);
	assert.deepEqual(shutdowns, [180_000]);
	assert.equal(scheduler.cancels, 1);
});

test("the countdown only starts once no live child terminal is left", async () => {
	const hc = new FakeHc();
	hc.terminals = [terminal({ address: "t20", parent: "t4m", labels: { "pi.agent": "eeee" } })];
	const clock = { value: 0 };
	const scheduler = manualSchedule();
	const { pi } = await setup({
		hc,
		env: childEnv("180"),
		now: () => clock.value,
		schedule: scheduler.schedule,
	});
	const shutdowns: number[] = [];
	const ctx = context({ shutdown: () => shutdowns.push(clock.value) });

	await pi.emit("agent_settled", { type: "agent_settled", aborted: false }, ctx);
	clock.value = 100_000;
	await tickOnce(scheduler.ticks[0]);
	assert.deepEqual(shutdowns, []);

	// 子 agent 已销毁（finished 不再算活的子终端）：安静从这一刻起算。
	hc.terminals = [terminal({ address: "t20", parent: "t4m", state: "finished", labels: { "pi.agent": "eeee" } })];
	clock.value = 130_000;
	await tickOnce(scheduler.ticks[0]);
	clock.value = 309_000;
	await tickOnce(scheduler.ticks[0]);
	assert.deepEqual(shutdowns, []);

	clock.value = 310_000;
	await tickOnce(scheduler.ticks[0]);
	assert.deepEqual(shutdowns, [310_000]);
});

test("background activity from other extensions pauses the countdown", async () => {
	let busy = true;
	registerBusyProbe("test-activity", () => busy);

	const hc = new FakeHc();
	const clock = { value: 0 };
	const scheduler = manualSchedule();
	const { pi } = await setup({
		hc,
		env: childEnv("180"),
		now: () => clock.value,
		schedule: scheduler.schedule,
	});
	const shutdowns: number[] = [];
	const ctx = context({ shutdown: () => shutdowns.push(clock.value) });

	try {
		await pi.emit("agent_settled", { type: "agent_settled", aborted: false }, ctx);
		clock.value = 200_000;
		await tickOnce(scheduler.ticks[0]);
		assert.deepEqual(shutdowns, []);

		// 忙的一直不算；从「忙」回到「安静」的那一刻才起算。
		busy = false;
		clock.value = 230_000;
		await tickOnce(scheduler.ticks[0]);
		clock.value = 409_000;
		await tickOnce(scheduler.ticks[0]);
		assert.deepEqual(shutdowns, []);

		clock.value = 410_000;
		await tickOnce(scheduler.ticks[0]);
		assert.deepEqual(shutdowns, [410_000]);
	} finally {
		registerBusyProbe("test-activity", () => false);
	}
});

test("new input cancels the pending countdown", async () => {
	const clock = { value: 0 };
	const scheduler = manualSchedule();
	const { pi } = await setup({
		env: childEnv("180"),
		now: () => clock.value,
		schedule: scheduler.schedule,
	});
	const shutdowns: number[] = [];
	const ctx = context({ shutdown: () => shutdowns.push(clock.value) });

	await pi.emit("agent_settled", { type: "agent_settled", aborted: false }, ctx);
	await pi.emit("input", { type: "input", text: "keep working" });
	assert.equal(scheduler.cancels, 1);

	// 陈旧的一拍即使被调到，也不能再生效。
	clock.value = 1_000_000;
	await tickOnce(scheduler.ticks[0]);
	assert.deepEqual(shutdowns, []);
});

test("destroy_time 0 and a missing env disable the countdown", async () => {
	const scheduler = manualSchedule();
	const zero = await setup({ env: childEnv("0"), now: () => 0, schedule: scheduler.schedule });
	await zero.pi.emit("agent_settled", { type: "agent_settled", aborted: false }, context());

	const root = await setup({ now: () => 0, schedule: scheduler.schedule });
	await root.pi.emit("agent_settled", { type: "agent_settled", aborted: false }, context());

	assert.equal(scheduler.ticks.length, 0);
});

test("an unreadable terminal list keeps the agent alive", async () => {
	const hc = new FakeHc();
	hc.list = async () => {
		throw new HcError("not_found", "core restarted");
	};
	const clock = { value: 0 };
	const scheduler = manualSchedule();
	const { pi } = await setup({
		hc,
		env: childEnv("180"),
		now: () => clock.value,
		schedule: scheduler.schedule,
	});
	const shutdowns: number[] = [];
	const ctx = context({ shutdown: () => shutdowns.push(clock.value) });

	await pi.emit("agent_settled", { type: "agent_settled", aborted: false }, ctx);
	clock.value = 1_000_000;
	await tickOnce(scheduler.ticks[0]);
	assert.deepEqual(shutdowns, []);
});

test("destroy_time is normalized and injected into the child env", async () => {
	const hc = new FakeHc();
	const { pi } = await setup({ hc });
	const tool = pi.tools.get("agent")!;

	await tool.execute("call", { prompt: "x", destroy_time: 0 }, undefined, undefined, context());
	await tool.execute("call", { prompt: "x", destroy_time: 42.9 }, undefined, undefined, context());
	await tool.execute("call", { prompt: "x", destroy_time: -5 }, undefined, undefined, context());

	assert.deepEqual(
		hc.callsOf("run").map((call) => call.params.env.PI_AGENT_DESTROY_TIME),
		["0", "42", "180"],
	);
});

test("resume applies destroy_time from the call, not from the session", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-agent-"));
	const file = join(dir, "2026-01-01T00-00-00-000Z_pi-aaaa.jsonl");
	const lines = [
		{ type: "session", id: "pi-aaaa", cwd: "D:\\repo", timestamp: "2026-01-01T00:00:00.000Z" },
		{ type: "model_change", provider: "p", modelId: "m" },
		{ type: "thinking_level_change", thinkingLevel: "high" },
	];
	writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));

	try {
		const hc = new FakeHc();
		const { pi } = await setup({ hc, sessionDir: dir });
		const result = await pi.tools
			.get("agent")!
			.execute("call", { prompt: "again", resume: "aaaa", destroy_time: 0 }, undefined, undefined, context());
		assert.match(toolResultText(result), /^Resumed agent aaaa/);
		assert.equal(hc.callsOf("run")[0].params.env.PI_AGENT_DESTROY_TIME, "0");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ─── 纯函数 ───

test("envelope round-trips and rejects foreign text", () => {
	const text = formatAgentEnvelope({ from: "a7k2", name: "reviewer", body: "hi\nthere" });
	assert.equal(
		text,
		[
			'<agent_message from="a7k2" name="reviewer" type="task">',
			"  <content>",
			"    hi",
			"    there",
			"  </content>",
			"  <note>",
			'    Your output is not returned automatically. Use agent_job send with type="reply" to reply.',
			"  </note>",
			"</agent_message>",
		].join("\n"),
	);
	assert.deepEqual(parseAgentEnvelope(text), {
		from: "a7k2",
		name: "reviewer",
		type: "task",
		body: "hi\nthere",
	});

	const reply = formatAgentEnvelope({ from: "a7k2", type: "reply", body: "done" });
	assert.equal(
		reply,
		[
			'<agent_message from="a7k2" type="reply">',
			"  <content>",
			"    done",
			"  </content>",
			"</agent_message>",
		].join("\n"),
	);
	assert.deepEqual(parseAgentEnvelope(reply), { from: "a7k2", name: undefined, type: "reply", body: "done" });

	assert.equal(parseAgentEnvelope("hello world"), undefined);
	assert.equal(parseAgentEnvelope('<pi-agent from="a" addr="t7" kind="ask">\nx'), undefined);
	assert.equal(parseAgentEnvelope("<agent>\nx"), undefined);
	// 旧格式（`<agent …>` / `<from agent …>` / `result` 位）一律不认。
	assert.equal(parseAgentEnvelope('<agent a7k2 "boss">\ndone'), undefined);
	assert.equal(parseAgentEnvelope('<from agent a7k2 "boss">\ndone'), undefined);
	// 没有 <content> 的也不认。
	assert.equal(parseAgentEnvelope('<agent_message from="a7k2" type="task">\nhi\n</agent_message>'), undefined);

	// 空正文：content 里只有换行，解析回空串。
	assert.equal(parseAgentEnvelope(formatAgentEnvelope({ from: "a7k2", body: "" }))?.body, "");
});

test("agent names follow the herdr-core terminal rule", () => {
	assert.equal(validateAgentName("reviewer"), undefined);
	assert.equal(validateAgentName("fix-login.2"), undefined);
	for (const bad of ["", "Reviewer", "fix login", "代码审查", "a".repeat(33)]) {
		assert.match(String(validateAgentName(bad)), /name must be/);
	}
});

test("readSessionFacts reads cwd, name, model and thinking from a session file", () => {
	const dir = process.env.TEMP ?? "/tmp";
	const path = `${dir}/pi-herdr-agent-test-${Date.now()}.jsonl`;
	const lines = [
		{ type: "session", version: 3, id: "pi-a7k2", cwd: "D:\\repo" },
		{ type: "model_change", provider: "p", modelId: "m" },
		{ type: "thinking_level_change", thinkingLevel: "high" },
		{ type: "session_info", name: "reviewer" },
	];
	writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"));
	try {
		assert.deepEqual(readSessionFacts(path), {
			cwd: "D:\\repo",
			provider: "p",
			modelId: "m",
			thinking: "high",
			name: "reviewer",
		});
	} finally {
		rmSync(path, { force: true });
	}
});

test("depth counts labeled agents only: a root under an agent is depth 0", () => {
	const root = terminal({ address: "t4m", labels: {} });
	const nestedRoot = terminal({ address: "t5m", labels: {}, parent: "t4m" });
	const child = terminal({ address: "t10", labels: { "pi.agent": "aaaa" }, parent: "t5m" });
	const grandchild = terminal({ address: "t11", labels: { "pi.agent": "bbbb" }, parent: "t10" });

	const rows = buildRows([root, nestedRoot, child, grandchild], "aaaa", "t10");
	const byId = new Map(rows.map((row) => [row.id, row]));
	assert.equal(byId.get("t5m")?.depth, 0);
	assert.equal(byId.get("aaaa")?.depth, 1);
	assert.equal(byId.get("bbbb")?.depth, 2);
});

test("isDescendant walks the terminal parent chain", () => {
	const terminals = [
		terminal({ address: "t4m" }),
		terminal({ address: "t10", parent: "t4m" }),
		terminal({ address: "t11", parent: "t10" }),
		terminal({ address: "t20" }),
	];
	assert.equal(isDescendant(terminals[2], terminals, "t4m"), true);
	assert.equal(isDescendant(terminals[0], terminals, "t4m"), false);
	assert.equal(isDescendant(terminals[3], terminals, "t4m"), false);
});

test("rows include a stable sort and table header", () => {
	const rows: AgentRow[] = [
		{ id: "b", name: "b", relation: "other", status: "idle", parent: null, depth: 0, cwd: "x", orphan: false },
	];
	assert.match(formatRows(rows), /^id/);
	assert.match(formatRows([]), /No agents are running/);
});

test("hc transport wrapper is unwrapped before the envelope", () => {
	const wrapped = `<hc from="t4m">${formatAgentEnvelope({
		from: "a7k2",
		body: "hi",
	})}</hc>`;
	assert.deepEqual(parseAgentEnvelope(wrapped), {
		from: "a7k2",
		name: undefined,
		type: "task",
		body: "hi",
	});
	assert.equal(stripHcTransport(wrapped), formatAgentEnvelope({ from: "a7k2", body: "hi" }));
});

function treeText(line: TreeLine): string {
	const right = line.right.map((segment) => segment.text).join("");
	return line.left.map((segment) => segment.text).join("") + (right ? `  ${right}` : "");
}

test("formatAgentTree renders cards with self, parent and orphan marks", () => {
	const root = terminal({ address: "t4m", labels: {}, title: "π - root - repo" });
	const child = terminal({ address: "t10", name: "reviewer", labels: { "pi.agent": "aaaa" }, parent: "t4m" });
	const grandchild = terminal({ address: "t11", name: "deep", labels: { "pi.agent": "bbbb" }, parent: "t10" });
	const sibling = terminal({ address: "t12", name: "helper", labels: { "pi.agent": "cccc" }, parent: "t4m" });
	const orphan = terminal({ address: "t13", name: "lost", labels: { "pi.agent": "dddd" }, parent: "t99" });

	const rows = buildRows([root, child, grandchild, sibling, orphan], "aaaa", "t10");
	const text = formatAgentTree(rows).map(treeText);

	assert.equal(text[0], "agent 树 · 5 个 agent");
	assert.ok(text.some((line) => line.includes("▌ ↑ root  ·  t4m")));
	assert.ok(text.some((line) => line.includes("● reviewer  ·  aaaa")));
	assert.ok(text.some((line) => line.includes("└─ deep  ·  bbbb")));
	assert.ok(text.some((line) => line.includes("lost  ·  dddd") && line.includes("失联")));
	assert.equal(text.at(-1), "● 自己   ↑ 父 agent   失联 = 父终端已消失");

	assert.deepEqual(formatAgentTree([]).map(treeText), ["没有正在运行的 agent。"]);
});

test("root name follows the pi title: session name, else the default π - cwd title", () => {
	const named = terminal({ address: "t4m", labels: {}, title: "π - herdr-agent - repo", cwd: "D:\\x\\repo" });
	const unnamed = terminal({ address: "t4n", labels: {}, title: "π - repo", cwd: "D:\\x\\repo" });
	// hc 终端名（比如 herdr 标签自动起的编号/旧名）不参与根的显示名。
	const renamed = terminal({ address: "t4p", name: "verify-1", labels: {}, title: "π - repo", cwd: "D:\\x\\repo" });
	// 标题被别的程序改写成非 pi 格式时，退回 hc 终端名。
	const foreign = terminal({ address: "t4q", name: "shell", labels: {}, title: "pwsh", cwd: "D:\\x\\repo" });
	const rows = buildRows([named, unnamed, renamed, foreign], "t4m", "t4m");
	const byId = new Map(rows.map((row) => [row.id, row]));
	assert.equal(byId.get("t4m")?.name, "herdr-agent");
	assert.equal(byId.get("t4n")?.name, "π - repo");
	assert.equal(byId.get("t4p")?.name, "π - repo");
	assert.equal(byId.get("t4q")?.name, "shell");
});

test("root short id is the tail of its session id", () => {
	assert.equal(rootIdOf("0193a5c4-8f2b-7c3d-9e01-2b3c4d5e6f70"), "5e6f70");
	assert.equal(rootIdOf("pi-a7k2f9"), "a7k2f9");
	assert.equal(rootIdOf("my.SESSION_id"), "sionid");
});

test("root writes its short id as a terminal label on session_start", async () => {
	const hc = new FakeHc();
	hc.terminals = [terminal({ address: "t4m", labels: {}, title: "π - repo", cwd: "D:\\repo" })];
	const { pi } = await setup({ hc });

	await pi.emit("session_start", { type: "session_start", reason: "startup" }, context());
	assert.deepEqual(hc.callsOf("label")[0]?.params, {
		terminal: "t4m",
		labels: { "pi.agent.root": "5e6f70" },
	});

	// 会话切换（/new、/resume）：扩展实例重建，session_start 带新会话 id，label 重写。
	await pi.emit(
		"session_start",
		{ type: "session_start", reason: "new" },
		context({
			sessionManager: {
				getSessionName: () => undefined,
				getSessionId: () => "0193a5c4-8f2b-7c3d-9e01-000000000001",
			},
		}),
	);
	assert.equal(hc.callsOf("label")[1]?.params.labels["pi.agent.root"], "000001");
});

test("warns once on session_start when a queue mode is one-at-a-time", async () => {
	const { pi } = await setup();
	pi.settings.steeringMode = "one-at-a-time";
	pi.settings.followUpMode = "one-at-a-time";
	const notes: { message: string; type?: string }[] = [];
	const ctx = context({ ui: { notify: (message, type) => notes.push({ message, type }) } });

	await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	assert.equal(notes.length, 1);
	assert.match(notes[0].message, /steeringMode \/ followUpMode/);
	assert.match(notes[0].message, /all/);
	assert.equal(notes[0].type, "warning");

	// 同一进程里的 /new、/resume 不再重复提醒。
	await pi.emit("session_start", { type: "session_start", reason: "new" }, ctx);
	assert.equal(notes.length, 1);
});

test("names only the queue mode that is actually set to one-at-a-time", async () => {
	const { pi } = await setup();
	pi.settings.followUpMode = "one-at-a-time";
	const notes: string[] = [];
	const ctx = context({ ui: { notify: (message) => notes.push(message) } });

	await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	assert.equal(notes.length, 1);
	assert.match(notes[0], /^followUpMode 当前为/);
});

test("does not warn when both queue modes are all or unset", async () => {
	const { pi } = await setup();
	const notes: string[] = [];
	const ctx = context({ ui: { notify: (message) => notes.push(message) } });

	await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	assert.deepEqual(notes, []);
});

test("root short id is used for list, launch env and message envelopes", async () => {
	const hc = new FakeHc();
	const labeledRoot = () =>
		terminal({ address: "t4m", labels: { "pi.agent.root": "5e6f70" }, title: "π - repo", cwd: "D:\\repo" });
	hc.terminals = [labeledRoot()];
	const { pi } = await setup({ hc });
	await pi.emit("session_start", { type: "session_start", reason: "startup" }, context());

	// 子 agent 拿到的 parent/root 就是这个短 id。
	await pi.tools.get("agent")!.execute("call", { prompt: "x" }, undefined, undefined, context());
	assert.equal(hc.callsOf("run")[0].params.env.PI_AGENT_PARENT, "5e6f70");
	assert.equal(hc.callsOf("run")[0].params.env.PI_AGENT_ROOT, "5e6f70");

	// 自己的树按短 id 认识自己：row id 是 label 值，名字仍按标题推导。
	const rows = buildRows([labeledRoot()], "5e6f70", "t4m");
	assert.equal(rows[0].id, "5e6f70");
	assert.equal(rows[0].relation, "self");
	assert.equal(rows[0].name, "π - repo");

	const handler = pi.commands.get("agent")!;
	await handler("list", context());
	const text = ((pi.entries.at(-1)?.data.lines ?? []) as TreeLine[]).map(treeText).join("\n");
	assert.ok(text.includes("π - repo") || text.includes("repo"));
	assert.ok(text.includes("5e6f70"));
});

test("sub-agents keep the injected id and never relabel; a failed label keeps the address id", async () => {
	const hc = new FakeHc();
	const { pi } = await setup({ hc, env: { PI_AGENT_ID: "abcd", PI_AGENT_DEPTH: "1" } });
	await pi.emit("session_start", { type: "session_start", reason: "startup" }, context());
	assert.equal(hc.callsOf("label").length, 0);

	const failing = new FakeHc();
	failing.label = async () => {
		throw new HcError("unavailable", "no labels here");
	};
	failing.terminals = [terminal({ address: "t4m", labels: {}, title: "π - repo", cwd: "D:\\repo" })];
	const root = await setup({ hc: failing });
	await root.pi.emit("session_start", { type: "session_start", reason: "startup" }, context());

	// label 没写进去：本轮进程仍用地址当 id，树里靠地址认自己，不出现“自己消失”。
	const rows = buildRows([failing.terminals[0]], "t4m", "t4m");
	assert.equal(rows[0].id, "t4m");
	assert.equal(rows[0].relation, "self");
});

test("a stale pi.agent.root label on a kept shell is not an agent", () => {
	const shell = terminal({
		address: "t4z",
		labels: { "pi.agent.root": "5e6f70" },
		status: { app: "pwsh", state: "idle" },
		name: "shell",
		title: "pwsh",
	});
	assert.deepEqual(buildRows([shell], "t4z", "t4z"), []);
});

test("currentTree keeps only self's component", () => {
	const root = terminal({ address: "t4m", labels: {}, title: "π - repo" });
	const child = terminal({ address: "t10", name: "reviewer", labels: { "pi.agent": "aaaa" }, parent: "t4m" });
	const sibling = terminal({ address: "t11", name: "helper", labels: { "pi.agent": "bbbb" }, parent: "t4m" });
	const otherRoot = terminal({ address: "t9x", labels: {}, title: "π - other" });
	const otherChild = terminal({ address: "t90", name: "stranger", labels: { "pi.agent": "cccc" }, parent: "t9x" });
	const orphan = terminal({ address: "t13", name: "lost", labels: { "pi.agent": "dddd" }, parent: "t99" });

	const rows = buildRows([root, child, sibling, otherRoot, otherChild, orphan], "aaaa", "t10");
	const ids = (subset: AgentRow[]) => subset.map((row) => row.id).sort();

	// 子 agent 视角：向上爬到根，再把根下整棵子树收进来；别的树与孤儿不在内。
	assert.deepEqual(ids(currentTree(rows, "aaaa")), ["aaaa", "bbbb", "t4m"]);
	// 根视角：自己的整棵树。
	assert.deepEqual(ids(currentTree(rows, "t4m")), ["aaaa", "bbbb", "t4m"]);
	// 找不到自己时：能靠 relation 找到就用它，否则宁可全部显示。
	assert.deepEqual(ids(currentTree(rows, "nope")), ["aaaa", "bbbb", "t4m"]);
	const foreign = buildRows([root, child, sibling, otherRoot, otherChild, orphan], "nope", "t99");
	assert.equal(currentTree(foreign, "nope").length, foreign.length);

	assert.equal(treeText(formatAgentTree(currentTree(rows, "aaaa"))[0]), "agent 树 · 3 个 agent");
	assert.equal(treeText(formatAgentTree(rows, "全部 agent 树")[0]), "全部 agent 树 · 6 个 agent");
});

test("/agent list shows the current tree, /agent list-all shows every tree", async () => {
	const hc = new FakeHc();
	hc.terminals = [
		terminal({ address: "t4m", labels: {}, title: "π - repo" }),
		terminal({ address: "t10", name: "reviewer", labels: { "pi.agent": "aaaa" }, parent: "t4m" }),
		terminal({ address: "t9x", labels: {}, title: "π - other" }),
		terminal({ address: "t90", name: "stranger", labels: { "pi.agent": "cccc" }, parent: "t9x" }),
	];
	const { pi } = await setup({ hc, env: { PI_AGENT_ID: "aaaa", PI_AGENT_DEPTH: "1" } });

	const handler = pi.commands.get("agent");
	assert.ok(handler);
	await handler("list", context());

	const entry = pi.entries.at(-1);
	assert.equal(entry?.type, "pi-herdr-agent:tree");
	const text = (entry?.data.lines as TreeLine[]).map(treeText);
	assert.ok(text.some((line) => line.startsWith("agent 树")));
	assert.ok(text.some((line) => line.includes("● reviewer  ·  aaaa")));
	assert.ok(!text.some((line) => line.includes("stranger")));

	await handler("list-all", context());
	const all = (pi.entries.at(-1)?.data.lines as TreeLine[]).map(treeText);
	assert.ok(all.some((line) => line.startsWith("全部 agent 树")));
	assert.ok(all.some((line) => line.includes("stranger  ·  cccc")));
});

test("subagent done OSC is rewritten to idle", () => {
	assert.equal(
		rewriteDoneStatus("\x1b]7501;state=done:app=pi:msg=c2V0dGxlY2hpbGQ=\x1b\\"),
		"\x1b]7501;state=idle:app=pi:msg=c2V0dGxlY2hpbGQ=\x1b\\",
	);
	assert.equal(rewriteDoneStatus("\x1b]7501;state=idle:app=pi\x1b\\"), "\x1b]7501;state=idle:app=pi\x1b\\");
	assert.equal(rewriteDoneStatus("hello"), "hello");
});

test("destroy_time normalizes tool input and parses the child env", () => {
	assert.equal(normalizeDestroyTime(undefined), 180);
	assert.equal(normalizeDestroyTime(0), 0);
	assert.equal(normalizeDestroyTime(42.9), 42);
	assert.equal(normalizeDestroyTime(-1), 180);
	assert.equal(normalizeDestroyTime(Number.NaN), 180);

	assert.equal(parseDestroyTime(undefined), 0);
	assert.equal(parseDestroyTime("0"), 0);
	assert.equal(parseDestroyTime(" 90 "), 90);
	assert.equal(parseDestroyTime("-5"), 0);
	assert.equal(parseDestroyTime("abc"), 0);
});

test("busy probes are keyed by name and swallow failures", () => {
	registerBusyProbe("probe-runs", () => true);
	assert.equal(hasBusyActivity(), true);
	registerBusyProbe("probe-runs", () => false);
	registerBusyProbe("probe-throws", () => {
		throw new Error("boom");
	});
	assert.equal(hasBusyActivity(), false);
});
