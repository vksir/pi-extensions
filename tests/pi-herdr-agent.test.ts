import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import {
	agentSourceLine,
	formatAgentEnvelope,
	parseAgentEnvelope,
	truncateTail,
	validateAgentName,
} from "../extensions/lib/agent-protocol.ts";
import {
	buildRows,
	formatAgentTree,
	formatRows,
	isDescendant,
	lastAssistantText,
	readSessionFacts,
	rewriteDoneStatus,
	type AgentRow,
	type TreeLine,
} from "../extensions/pi-herdr-agent.ts";
import { HcError, type HcClient, type HcRunParams, type HcRunResult, type HcSendParams, type HcSendResult, type HcTerminal, type HcWaitParams, type HcWaitResult } from "../extensions/lib/hc.ts";

// ─── 测试替身 ───

interface ToolCallResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
}

interface FakePi {
	tools: Map<string, { name: string; description: string; execute: (...args: unknown[]) => Promise<ToolCallResult> }>;
	handlers: Map<string, ((...args: unknown[]) => unknown)[]>;
	commands: Map<string, (args: string, ctx: unknown) => Promise<void> | void>;
	entries: { type: string; data: any }[];
	registerTool: (definition: {
		name: string;
		description: string;
		execute: (...args: unknown[]) => Promise<ToolCallResult>;
	}) => void;
	on: (event: string, handler: (...args: unknown[]) => unknown) => void;
	registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> | void }) => void;
	registerEntryRenderer: () => void;
	appendEntry: (type: string, data: unknown) => void;
	emit: (event: string, ...args: unknown[]) => Promise<unknown>;
}

function createFakePi(): FakePi {
	const tools: FakePi["tools"] = new Map();
	const handlers: FakePi["handlers"] = new Map();
	const commands: FakePi["commands"] = new Map();
	const entries: FakePi["entries"] = [];
	return {
		tools,
		handlers,
		commands,
		entries,
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
		appendEntry(type, data) {
			entries.push({ type, data });
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

	async kill(name: string) {
		this.record("kill", { terminal: name });
		return terminal({ address: name, state: "finished" });
	}
}

interface FakeCtx {
	cwd: string;
	model: { provider: string; id: string } | undefined;
	thinkingLevel: string | undefined;
	sessionManager: { getSessionName: () => string | undefined };
	modelRegistry: { getAll: () => { provider: string; id: string; name?: string }[] };
}

function context(overrides: Partial<FakeCtx> = {}): FakeCtx {
	return {
		cwd: "D:\\repo",
		model: { provider: "p", id: "m" },
		thinkingLevel: "high",
		sessionManager: { getSessionName: () => undefined },
		modelRegistry: { getAll: () => [{ provider: "p", id: "m", name: "M" }] },
		...overrides,
	};
}

let moduleSeq = 0;

async function setup(options: { env?: Record<string, string>; hc?: FakeHc } = {}) {
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
		spill: async (text: string) => `/tmp/spill-${text.length}.log`,
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

// ─── agent 拉起 ───

test("agent launches pi with identity env, labels and ask envelope", async () => {
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
	});
	assert.ok(argv.includes("--model") && argv.includes("p/m2"));
	assert.ok(argv.includes("--thinking") && argv.includes("low"));

	const send = hc.callsOf("send")[0].params;
	assert.equal(send.terminal, "t10");
	assert.equal(send.caller, "t4m");
	const envelope = parseAgentEnvelope(String(send.text));
	assert.equal(envelope?.kind, "ask");
	assert.equal(envelope?.from, "t4m");
	assert.equal(envelope?.addr, "t4m");
	assert.equal(envelope?.body, "do the thing");
	assert.ok(text.includes(id));
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

test("ask refuses a busy agent and accepts an idle one", async () => {
	const hc = new FakeHc();
	hc.terminals = [terminal({ address: "t10", name: "reviewer", labels: { "pi.agent": "aaaa" }, status: { app: "pi", state: "working" } })];
	const { pi } = await setup({ hc });

	const busy = await pi.tools.get("agent_job")!.execute("call", { action: "ask", id: "aaaa", message: "hi" }, undefined, undefined, context());
	assert.match(toolResultText(busy), /is working; ask works only when it is idle/);
	assert.equal(hc.callsOf("send").length, 0);

	hc.terminals = [terminal({ address: "t10", name: "reviewer", labels: { "pi.agent": "aaaa" }, status: { app: "pi", state: "idle" } })];
	const idle = await pi.tools.get("agent_job")!.execute("call", { action: "ask", id: "aaaa", message: "hi" }, undefined, undefined, context());
	assert.match(toolResultText(idle), /^Asked aaaa \(reviewer\)/);
	const send = hc.callsOf("send")[0].params;
	assert.equal(send.if, "idle");
	assert.equal(parseAgentEnvelope(String(send.text))?.kind, "ask");
});

test("steer only works while the target is working", async () => {
	const hc = new FakeHc();
	hc.terminals = [terminal({ address: "t10", labels: { "pi.agent": "aaaa" }, status: { app: "pi", state: "idle" } })];
	const { pi } = await setup({ hc });

	const idle = await pi.tools.get("agent_job")!.execute("call", { action: "steer", id: "aaaa", message: "hi" }, undefined, undefined, context());
	assert.match(toolResultText(idle), /Use ask when it is idle/);
	assert.equal(hc.callsOf("send").length, 0);

	hc.terminals = [terminal({ address: "t10", labels: { "pi.agent": "aaaa" }, status: { app: "pi", state: "working" } })];
	const working = await pi.tools.get("agent_job")!.execute("call", { action: "steer", id: "aaaa", message: "hi" }, undefined, undefined, context());
	assert.match(toolResultText(working), /^Steered aaaa/);
	assert.equal(hc.callsOf("send")[0].params.if, "working");
	assert.equal(parseAgentEnvelope(String(hc.callsOf("send")[0].params.text))?.kind, "steer");
});

test("kill only reaches descendants", async () => {
	const hc = new FakeHc();
	hc.terminals = [
		terminal({ address: "t4m", labels: {} }),
		terminal({ address: "t20", labels: { "pi.agent": "eeee" }, parent: null }),
		terminal({ address: "t10", labels: { "pi.agent": "aaaa" }, parent: "t4m" }),
	];
	const { pi } = await setup({ hc });

	const stranger = await pi.tools.get("agent_job")!.execute("call", { action: "kill", id: "eeee" }, undefined, undefined, context());
	assert.match(toolResultText(stranger), /not your descendant/);
	assert.equal(hc.callsOf("kill").length, 0);

	const own = await pi.tools.get("agent_job")!.execute("call", { action: "kill", id: "aaaa" }, undefined, undefined, context());
	assert.match(toolResultText(own), /^Killed agent aaaa/);
	assert.equal(hc.callsOf("kill")[0].params.terminal, "t10");
});

test("kill reports success when rm removes the terminal before the reply", async () => {
	const hc = new FakeHc();
	hc.terminals = [terminal({ address: "t10", labels: { "pi.agent": "aaaa" }, parent: "t4m" })];
	hc.kill = async () => {
		throw new HcError("not_found", "t10 was removed");
	};
	const { pi } = await setup({ hc });
	const result = await pi.tools.get("agent_job")!.execute("call", { action: "kill", id: "aaaa" }, undefined, undefined, context());
	assert.match(toolResultText(result), /^Killed agent aaaa/);
});

test("wait requires an id and never treats a timeout as an error", async () => {
	const hc = new FakeHc();
	hc.terminals = [terminal({ address: "t10", name: "reviewer", labels: { "pi.agent": "aaaa" }, status: { app: "pi", state: "working" } })];
	const { pi } = await setup({ hc });

	const missing = await pi.tools.get("agent_job")!.execute("call", { action: "wait" }, undefined, undefined, context());
	assert.match(toolResultText(missing), /id is required for wait/);

	const originalWait = hc.wait.bind(hc);
	hc.wait = async (params) => {
		hc.record("wait", params);
		return waitResult({ ended: false, reason: "timeout", status: "working", terminal: "t10" });
	};
	const result = await pi.tools.get("agent_job")!.execute("call", { action: "wait", id: "aaaa", timeout: 5 }, undefined, undefined, context());
	assert.match(toolResultText(result), /still running \(working, turn 0\)/);
	hc.wait = originalWait;
});

// ─── 入站消息与结果回发 ───

test("ask envelope is stripped and its sender receives the final answer", async () => {
	const hc = new FakeHc();
	const { pi } = await setup({ hc, env: { PI_AGENT_ID: "abcd", PI_AGENT_NAME: "worker", PI_AGENT_DEPTH: "1" } });

	const transformed = await pi.emit("input", {
		type: "input",
		text: formatAgentEnvelope({ kind: "ask", from: "zzzz", addr: "t7", name: "boss", body: "do the thing" }),
	});
	assert.deepEqual(transformed, { action: "transform", text: "do the thing" });

	await pi.emit("agent_end", {
		type: "agent_end",
		messages: [
			{ role: "assistant", content: [{ type: "toolCall", name: "read" }] },
			{ role: "assistant", content: [{ type: "text", text: "all done" }] },
		],
	});
	await pi.emit("agent_settled", { type: "agent_settled", aborted: false }, context());

	const send = hc.callsOf("send")[0].params;
	assert.equal(send.terminal, "t7");
	assert.equal(send.caller, "t4m");
	const envelope = parseAgentEnvelope(String(send.text));
	assert.equal(envelope?.kind, "result");
	assert.equal(envelope?.from, "abcd");
	assert.equal(envelope?.body, "[agent abcd · worker]\nall done");
});

test("result envelopes never set an asker", async () => {
	const hc = new FakeHc();
	const { pi } = await setup({ hc, env: { PI_AGENT_ID: "abcd", PI_AGENT_DEPTH: "1" } });

	await pi.emit("input", {
		type: "input",
		text: formatAgentEnvelope({ kind: "result", from: "zzzz", addr: "t7", body: "[agent zzzz]\nhi" }),
	});
	await pi.emit("agent_settled", { type: "agent_settled", aborted: false }, context());
	assert.equal(hc.callsOf("send").length, 0);
});

test("empty answers and aborted runs still report back", async () => {
	const hc = new FakeHc();
	const { pi } = await setup({ hc, env: { PI_AGENT_ID: "abcd", PI_AGENT_DEPTH: "1" } });

	await pi.emit("input", { type: "input", text: "<pi-agent from=\"a\" addr=\"t7\" kind=\"ask\">\nq" });
	await pi.emit("agent_settled", { type: "agent_settled", aborted: true }, context());
	assert.match(String(hc.callsOf("send")[0].params.text), /Run aborted\./);

	await pi.emit("input", { type: "input", text: "<pi-agent from=\"a\" addr=\"t7\" kind=\"ask\">\nq" });
	await pi.emit("agent_end", { type: "agent_end", messages: [] });
	await pi.emit("agent_settled", { type: "agent_settled", aborted: false }, context());
	assert.match(String(hc.callsOf("send")[1].params.text), /No text output this turn\./);
});

test("blocked dialog notifies the asker once per span", async () => {
	const hc = new FakeHc();
	const { pi } = await setup({ hc, env: { PI_AGENT_ID: "abcd", PI_AGENT_DEPTH: "1" } });

	await pi.emit("input", { type: "input", text: "<pi-agent from=\"a\" addr=\"t7\" kind=\"ask\">\nq" });
	await pi.emit("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "Allow?" });
	await pi.emit("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "Allow?" });
	assert.equal(hc.callsOf("send").length, 1);
	assert.match(String(hc.callsOf("send")[0].params.text), /Blocked waiting for human input \(Allow\?\)\./);

	await pi.emit("ui_prompt_end", { type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm" });
	await pi.emit("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "Again?" });
	assert.equal(hc.callsOf("send").length, 2);
});

test("long answers are truncated and spilled to a file", async () => {
	const hc = new FakeHc();
	const { pi } = await setup({ hc, env: { PI_AGENT_ID: "abcd", PI_AGENT_DEPTH: "1" } });

	await pi.emit("input", { type: "input", text: "<pi-agent from=\"a\" addr=\"t7\" kind=\"ask\">\nq" });
	const big = "x".repeat(60 * 1024);
	await pi.emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: big }] }] });
	await pi.emit("agent_settled", { type: "agent_settled", aborted: false }, context());

	const body = String(hc.callsOf("send")[0].params.text);
	assert.match(body, /\[Output truncated\. Full output: \/tmp\/spill-61440\.log\]/);
});

// ─── 生命周期 ───

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

// ─── 纯函数 ───

test("envelope round-trips and rejects foreign text", () => {
	const text = formatAgentEnvelope({ kind: "ask", from: "a7k2", addr: "t7", name: "reviewer", body: "hi\nthere" });
	assert.equal(
		text,
		'<pi-agent from="a7k2" addr="t7" name="reviewer" kind="ask">\nhi\nthere',
	);
	const parsed = parseAgentEnvelope(text);
	assert.deepEqual(parsed, { kind: "ask", from: "a7k2", addr: "t7", name: "reviewer", body: "hi\nthere" });

	assert.equal(parseAgentEnvelope("hello world"), undefined);
	assert.equal(parseAgentEnvelope('<pi-agent from="a" addr="t7" kind="nope">\nx'), undefined);
	assert.equal(parseAgentEnvelope('<pi-agent from="a" kind="ask">\nx'), undefined);
});

test("agent names follow the herdr-core terminal rule", () => {
	assert.equal(validateAgentName("reviewer"), undefined);
	assert.equal(validateAgentName("fix-login.2"), undefined);
	for (const bad of ["", "Reviewer", "fix login", "代码审查", "a".repeat(33)]) {
		assert.match(String(validateAgentName(bad)), /name must be/);
	}
	assert.equal(agentSourceLine("a7k2", "reviewer"), "[agent a7k2 · reviewer]");
	assert.equal(agentSourceLine("a7k2"), "[agent a7k2]");
});

test("truncateTail keeps the tail within both limits", () => {
	assert.deepEqual(truncateTail("short"), { text: "short", truncated: false });

	const manyLines = Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n");
	assert.deepEqual(truncateTail(manyLines, 2, 1024).text, "line 8\nline 9");

	const hugeLine = "a".repeat(100);
	assert.equal(truncateTail(hugeLine, 10, 10).text.length, 10);
});

test("lastAssistantText picks the last non-empty assistant text", () => {
	assert.equal(
		lastAssistantText([
			{ role: "assistant", content: [{ type: "text", text: "first" }] },
			{ role: "assistant", content: [{ type: "toolCall", name: "x" }] },
			{ role: "user", content: "hi" },
		]),
		"first",
	);
	assert.equal(lastAssistantText([]), undefined);
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
		kind: "ask",
		from: "a7k2",
		addr: "t7",
		body: "hi",
	})}</hc>`;
	assert.deepEqual(parseAgentEnvelope(wrapped), {
		kind: "ask",
		from: "a7k2",
		addr: "t7",
		name: undefined,
		body: "hi",
	});
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

test("root name strips the title wrapper and never shows cwd", () => {
	const named = terminal({ address: "t4m", labels: {}, title: "π - herdr-agent - repo", cwd: "D:\\x\\repo" });
	const unnamed = terminal({ address: "t4n", labels: {}, title: "π - repo", cwd: "D:\\x\\repo" });
	const rows = buildRows([named, unnamed], "t4m", "t4m");
	const byId = new Map(rows.map((row) => [row.id, row]));
	assert.equal(byId.get("t4m")?.name, "herdr-agent");
	assert.equal(byId.get("t4n")?.name, "(root)");
});

test("/agent list appends one tree entry", async () => {
	const hc = new FakeHc();
	hc.terminals = [
		terminal({ address: "t4m", labels: {} }),
		terminal({ address: "t10", name: "reviewer", labels: { "pi.agent": "aaaa" }, parent: "t4m" }),
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
});

test("subagent done OSC is rewritten to idle", () => {
	assert.equal(
		rewriteDoneStatus("\x1b]7501;state=done:app=pi:msg=c2V0dGxlY2hpbGQ=\x1b\\"),
		"\x1b]7501;state=idle:app=pi:msg=c2V0dGxlY2hpbGQ=\x1b\\",
	);
	assert.equal(rewriteDoneStatus("\x1b]7501;state=idle:app=pi\x1b\\"), "\x1b]7501;state=idle:app=pi\x1b\\");
	assert.equal(rewriteDoneStatus("hello"), "hello");
});
