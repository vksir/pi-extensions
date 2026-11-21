import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	agentSourceLine,
	formatAgentEnvelope,
	parseAgentEnvelope,
	stripHcTransport,
	truncateTail,
	validateAgentName,
} from "../extensions/lib/agent-protocol.ts";
import { hasBusyActivity, registerBusyProbe } from "../extensions/lib/activity.ts";
import {
	buildRows,
	currentTree,
	formatAgentTree,
	formatRows,
	isDescendant,
	lastAssistantText,
	normalizeDestroyAfter,
	parseDestroyAfter,
	readSessionFacts,
	rewriteDoneStatus,
	rootIdOf,
	type AgentRow,
	type TreeLine,
} from "../extensions/pi-herdr-agent.ts";
import { HcError, type HcClient, type HcLabelParams, type HcRunParams, type HcRunResult, type HcSendParams, type HcSendResult, type HcTerminal, type HcWaitParams, type HcWaitResult } from "../extensions/lib/hc.ts";

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
	userMessages: string[];
	settings: { steeringMode?: "all" | "one-at-a-time"; followUpMode?: "all" | "one-at-a-time" };
	getSettings: () => { steeringMode?: "all" | "one-at-a-time"; followUpMode?: "all" | "one-at-a-time" };
	registerTool: (definition: {
		name: string;
		description: string;
		execute: (...args: unknown[]) => Promise<ToolCallResult>;
	}) => void;
	on: (event: string, handler: (...args: unknown[]) => unknown) => void;
	registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> | void }) => void;
	registerEntryRenderer: () => void;
	appendEntry: (type: string, data: unknown) => void;
	sendUserMessage: (content: unknown) => void;
	emit: (event: string, ...args: unknown[]) => Promise<unknown>;
}

function createFakePi(): FakePi {
	const tools: FakePi["tools"] = new Map();
	const handlers: FakePi["handlers"] = new Map();
	const commands: FakePi["commands"] = new Map();
	const entries: FakePi["entries"] = [];
	const userMessages: string[] = [];
	const settings: { steeringMode?: "all" | "one-at-a-time"; followUpMode?: "all" | "one-at-a-time" } = {
		steeringMode: "all",
	};
	return {
		tools,
		handlers,
		commands,
		entries,
		userMessages,
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
		appendEntry(type, data) {
			entries.push({ type, data });
		},
		sendUserMessage(content) {
			userMessages.push(String(content));
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
		PI_AGENT_DESTROY_AFTER: "180",
	});
	assert.ok(argv.includes("--model") && argv.includes("p/m2"));
	assert.ok(argv.includes("--thinking") && argv.includes("low"));

	const send = hc.callsOf("send")[0].params;
	assert.equal(send.terminal, "t10");
	assert.equal(send.caller, "t4m");
	const envelope = parseAgentEnvelope(String(send.text));
	assert.equal(envelope?.result, false);
	assert.equal(envelope?.from, "t4m");
	assert.equal(envelope?.name, undefined); // 根没有注入的名字，会话也未命名
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

test("ask never checks the target's status", async () => {
	const hc = new FakeHc();
	hc.terminals = [
		terminal({ address: "t10", name: "reviewer", labels: { "pi.agent": "aaaa" }, status: { app: "pi", state: "working" } }),
	];
	const { pi } = await setup({ hc });

	const busy = await pi.tools.get("agent_job")!.execute("call", { action: "ask", id: "aaaa", message: "hi" }, undefined, undefined, context());
	assert.match(toolResultText(busy), /^Asked aaaa \(reviewer\)\.$/);
	assert.equal(hc.callsOf("send").length, 1);

	const send = hc.callsOf("send")[0].params;
	assert.equal(send.terminal, "t10");
	assert.equal(send.if, undefined); // 不再带状态前置条件
	const envelope = parseAgentEnvelope(String(send.text));
	assert.equal(envelope?.result, false);
	assert.equal(envelope?.body, "hi");
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

test("dispatch: idle starts a round, the owner steers, others queue and merge", async () => {
	const hc = new FakeHc();
	hc.terminals = [
		terminal({ address: "t7", labels: { "pi.agent": "aaaa" } }),
		terminal({ address: "t8", labels: { "pi.agent": "bbbb" } }),
		terminal({ address: "t9", labels: { "pi.agent": "dddd" } }),
	];
	const { pi } = await setup({ hc, env: { PI_AGENT_ID: "cccc", PI_AGENT_DEPTH: "1" } });

	// 空闲：第一条放行，派活人 = aaaa。
	const firstText = formatAgentEnvelope({ from: "aaaa", body: "task A" });
	assert.deepEqual(await pi.emit("input", { type: "input", text: firstText }), {
		action: "transform",
		text: firstText,
	});
	await pi.emit("agent_start");

	// 派活人插话：放行（pi 原生 steer）。
	const moreText = formatAgentEnvelope({ from: "aaaa", body: "more" });
	assert.deepEqual(
		await pi.emit("input", { type: "input", text: moreText, streamingBehavior: "steer" }),
		{ action: "transform", text: moreText },
	);

	// 别人：吞掉并排队。
	assert.deepEqual(
		await pi.emit("input", {
			type: "input",
			text: formatAgentEnvelope({ from: "bbbb", body: "task B1" }),
			streamingBehavior: "steer",
		}),
		{ action: "handled" },
	);
	assert.deepEqual(
		await pi.emit("input", {
			type: "input",
			text: formatAgentEnvelope({ from: "dddd", body: "task Z" }),
			streamingBehavior: "steer",
		}),
		{ action: "handled" },
	);
	// 同一个发送方再发：合进他那一条，位置还在 Z 前面。
	assert.deepEqual(
		await pi.emit("input", {
			type: "input",
			text: formatAgentEnvelope({ from: "bbbb", body: "task B2" }),
			streamingBehavior: "steer",
		}),
		{ action: "handled" },
	);

	// 收工：回发 aaaa，然后起队首（bbbb 的合并消息）。
	await pi.emit("agent_end", {
		type: "agent_end",
		messages: [{ role: "assistant", content: [{ type: "text", text: "done A" }] }],
	});
	await pi.emit("agent_settled", { type: "agent_settled", aborted: false }, context());

	const sends = hc.callsOf("send");
	assert.equal(sends.length, 1);
	assert.equal(sends[0].params.terminal, "t7");
	const reply = parseAgentEnvelope(String(sends[0].params.text));
	assert.equal(reply?.result, true);
	assert.equal(reply?.body, "done A");

	assert.equal(pi.userMessages.length, 1);
	const next = parseAgentEnvelope(pi.userMessages[0]);
	assert.equal(next?.from, "bbbb");
	assert.equal(next?.body, "task B1\n\ntask B2");

	// 下一轮收工：回发 bbbb，然后才起 Z。
	await pi.emit("agent_start");
	await pi.emit("agent_end", {
		type: "agent_end",
		messages: [{ role: "assistant", content: [{ type: "text", text: "done B" }] }],
	});
	await pi.emit("agent_settled", { type: "agent_settled", aborted: false }, context());
	assert.equal(hc.callsOf("send")[1].params.terminal, "t8");
	assert.equal(parseAgentEnvelope(pi.userMessages[1])?.from, "dddd");
});

test("a message arriving while the previous round is settling is queued, not promoted", async () => {
	const hc = new FakeHc();
	hc.terminals = [
		terminal({ address: "t7", labels: { "pi.agent": "aaaa" } }),
		terminal({ address: "t8", labels: { "pi.agent": "bbbb" } }),
	];
	const { pi } = await setup({ hc, env: { PI_AGENT_ID: "cccc", PI_AGENT_DEPTH: "1" } });

	await pi.emit("input", { type: "input", text: formatAgentEnvelope({ from: "aaaa", body: "task A" }) });
	await pi.emit("agent_start");
	await pi.emit("agent_end", {
		type: "agent_end",
		messages: [{ role: "assistant", content: [{ type: "text", text: "done A" }] }],
	});

	// 收工处理里有 await；这期间进来的消息不能抢成新的派活人。
	const settled = pi.emit("agent_settled", { type: "agent_settled", aborted: false }, context());
	const arriving = await pi.emit("input", {
		type: "input",
		text: formatAgentEnvelope({ from: "bbbb", body: "task B" }),
	});
	assert.deepEqual(arriving, { action: "handled" });

	await settled;
	assert.equal(hc.callsOf("send").length, 1);
	assert.equal(hc.callsOf("send")[0].params.terminal, "t7");
	assert.equal(pi.userMessages.length, 1);
	assert.equal(parseAgentEnvelope(pi.userMessages[0])?.from, "bbbb");
});

test("result messages are passed through and never replied to", async () => {
	const hc = new FakeHc();
	const { pi } = await setup({ hc, env: { PI_AGENT_ID: "abcd", PI_AGENT_DEPTH: "1" } });

	const resultText = formatAgentEnvelope({ result: true, from: "zzzz", body: "here is the answer" });
	assert.deepEqual(await pi.emit("input", { type: "input", text: resultText }), {
		action: "transform",
		text: resultText,
	});
	await pi.emit("agent_settled", { type: "agent_settled", aborted: false }, context());
	assert.equal(hc.callsOf("send").length, 0);
});

// ─── 入站消息与结果回发 ───

test("inbound ask keeps the sender line and its sender receives the final answer", async () => {
	const hc = new FakeHc();
	hc.terminals = [terminal({ address: "t7", labels: { "pi.agent": "zzzz" } })];
	const { pi } = await setup({ hc, env: { PI_AGENT_ID: "abcd", PI_AGENT_NAME: "worker", PI_AGENT_DEPTH: "1" } });

	const askText = formatAgentEnvelope({ from: "zzzz", name: "boss", body: "do the thing" });
	const passed = await pi.emit("input", { type: "input", text: askText });
	// 首行留给模型看，不再剥；只有 hc 包装会被剥掉。
	assert.deepEqual(passed, { action: "transform", text: askText });

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
	assert.equal(envelope?.result, true);
	assert.equal(envelope?.from, "abcd");
	assert.equal(envelope?.name, "worker");
	assert.equal(envelope?.body, "all done");
});

test("a reply to a peer that is gone is dropped and noted, not retried", async () => {
	const hc = new FakeHc();
	hc.terminals = [];
	const { pi } = await setup({ hc, env: { PI_AGENT_ID: "abcd", PI_AGENT_DEPTH: "1" } });

	await pi.emit("input", { type: "input", text: formatAgentEnvelope({ from: "zzzz", body: "q" }) });
	await pi.emit("agent_end", {
		type: "agent_end",
		messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
	});
	await pi.emit("agent_settled", { type: "agent_settled", aborted: false }, context());

	assert.equal(hc.callsOf("send").length, 0);
	assert.ok(pi.entries.some((entry) => String(entry.data?.text ?? "").includes("replay to zzzz failed")));
});

test("quit notifies the owner and everyone still queued", async () => {
	const hc = new FakeHc();
	hc.terminals = [
		terminal({ address: "t7", labels: { "pi.agent": "aaaa" } }),
		terminal({ address: "t8", labels: { "pi.agent": "bbbb" } }),
	];
	const { pi } = await setup({ hc, env: { PI_AGENT_ID: "abcd", PI_AGENT_DEPTH: "1" } });

	await pi.emit("input", { type: "input", text: formatAgentEnvelope({ from: "aaaa", body: "task A" }) });
	await pi.emit("agent_start");
	await pi.emit("input", {
		type: "input",
		text: formatAgentEnvelope({ from: "bbbb", body: "task B" }),
		streamingBehavior: "steer",
	});

	await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context());

	const bodies = hc.callsOf("send").map((call) => parseAgentEnvelope(String(call.params.text))?.body);
	assert.ok(bodies.some((body) => body === "agent abcd exited before answering."));
	assert.ok(bodies.some((body) => body === "agent abcd exited. Your task was not processed."));
});

test("empty answers and aborted runs still report back", async () => {
	const hc = new FakeHc();
	hc.terminals = [terminal({ address: "t7", labels: { "pi.agent": "aaaa" } })];
	const { pi } = await setup({ hc, env: { PI_AGENT_ID: "abcd", PI_AGENT_DEPTH: "1" } });

	await pi.emit("input", { type: "input", text: formatAgentEnvelope({ from: "aaaa", body: "q" }) });
	await pi.emit("agent_settled", { type: "agent_settled", aborted: true }, context());
	assert.match(String(hc.callsOf("send")[0].params.text), /Run aborted\./);

	await pi.emit("input", { type: "input", text: formatAgentEnvelope({ from: "aaaa", body: "q" }) });
	await pi.emit("agent_end", { type: "agent_end", messages: [] });
	await pi.emit("agent_settled", { type: "agent_settled", aborted: false }, context());
	assert.match(String(hc.callsOf("send")[1].params.text), /No text output this turn\./);
});

test("blocked dialog notifies the owner once per span", async () => {
	const hc = new FakeHc();
	hc.terminals = [terminal({ address: "t7", labels: { "pi.agent": "aaaa" } })];
	const { pi } = await setup({ hc, env: { PI_AGENT_ID: "abcd", PI_AGENT_DEPTH: "1" } });

	await pi.emit("input", { type: "input", text: formatAgentEnvelope({ from: "aaaa", body: "q" }) });
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
	hc.terminals = [terminal({ address: "t7", labels: { "pi.agent": "aaaa" } })];
	const { pi } = await setup({ hc, env: { PI_AGENT_ID: "abcd", PI_AGENT_DEPTH: "1" } });

	await pi.emit("input", { type: "input", text: formatAgentEnvelope({ from: "aaaa", body: "q" }) });
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

function childEnv(destroyAfterSeconds: string): Record<string, string> {
	return { PI_AGENT_ID: "abcd", PI_AGENT_DEPTH: "1", PI_AGENT_DESTROY_AFTER: destroyAfterSeconds };
}

test("a quiet child shuts itself down after destroyAfterSeconds", async () => {
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

test("destroyAfterSeconds 0 and a missing env disable the countdown", async () => {
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

test("destroyAfterSeconds is normalized and injected into the child env", async () => {
	const hc = new FakeHc();
	const { pi } = await setup({ hc });
	const tool = pi.tools.get("agent")!;

	await tool.execute("call", { prompt: "x", destroyAfterSeconds: 0 }, undefined, undefined, context());
	await tool.execute("call", { prompt: "x", destroyAfterSeconds: 42.9 }, undefined, undefined, context());
	await tool.execute("call", { prompt: "x", destroyAfterSeconds: -5 }, undefined, undefined, context());

	assert.deepEqual(
		hc.callsOf("run").map((call) => call.params.env.PI_AGENT_DESTROY_AFTER),
		["0", "42", "180"],
	);
});

test("resume applies destroyAfterSeconds from the call, not from the session", async () => {
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
			.execute("call", { prompt: "again", resume: "aaaa", destroyAfterSeconds: 0 }, undefined, undefined, context());
		assert.match(toolResultText(result), /^Resumed agent aaaa/);
		assert.equal(hc.callsOf("run")[0].params.env.PI_AGENT_DESTROY_AFTER, "0");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ─── 纯函数 ───

test("envelope round-trips and rejects foreign text", () => {
	const text = formatAgentEnvelope({ from: "a7k2", name: "reviewer", body: "hi\nthere" });
	assert.equal(text, '<agent a7k2 "reviewer">\nhi\nthere');
	assert.deepEqual(parseAgentEnvelope(text), {
		from: "a7k2",
		name: "reviewer",
		result: false,
		body: "hi\nthere",
	});

	const reply = formatAgentEnvelope({ from: "a7k2", result: true, body: "done" });
	assert.equal(reply, "<agent a7k2 result>\ndone");
	assert.deepEqual(parseAgentEnvelope(reply), { from: "a7k2", name: undefined, result: true, body: "done" });

	assert.equal(parseAgentEnvelope("hello world"), undefined);
	assert.equal(parseAgentEnvelope('<pi-agent from="a" addr="t7" kind="ask">\nx'), undefined);
	assert.equal(parseAgentEnvelope("<agent>\nx"), undefined);
	// 没有正文也认：空着正文的发现在收工时不会发生，但解析器不该因此乱喷。
	assert.deepEqual(parseAgentEnvelope('<agent a7k2 "boss">'), {
		from: "a7k2",
		name: "boss",
		result: false,
		body: "",
	});
});

test("agent names follow the herdr-core terminal rule", () => {
	assert.equal(validateAgentName("reviewer"), undefined);
	assert.equal(validateAgentName("fix-login.2"), undefined);
	for (const bad of ["", "Reviewer", "fix login", "代码审查", "a".repeat(33)]) {
		assert.match(String(validateAgentName(bad)), /name must be/);
	}
	assert.equal(agentSourceLine("a7k2", "reviewer"), '<agent a7k2 "reviewer">');
	assert.equal(agentSourceLine("a7k2"), "<agent a7k2>");
	assert.equal(agentSourceLine("a7k2", "reviewer", true), '<agent a7k2 "reviewer" result>');
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
		from: "a7k2",
		body: "hi",
	})}</hc>`;
	assert.deepEqual(parseAgentEnvelope(wrapped), {
		from: "a7k2",
		name: undefined,
		result: false,
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

test("destroyAfterSeconds normalizes tool input and parses the child env", () => {
	assert.equal(normalizeDestroyAfter(undefined), 180);
	assert.equal(normalizeDestroyAfter(0), 0);
	assert.equal(normalizeDestroyAfter(42.9), 42);
	assert.equal(normalizeDestroyAfter(-1), 180);
	assert.equal(normalizeDestroyAfter(Number.NaN), 180);

	assert.equal(parseDestroyAfter(undefined), 0);
	assert.equal(parseDestroyAfter("0"), 0);
	assert.equal(parseDestroyAfter(" 90 "), 90);
	assert.equal(parseDestroyAfter("-5"), 0);
	assert.equal(parseDestroyAfter("abc"), 0);
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
