/**
 * pi-subagent 测试骨架：mock pi（捕获工具与事件注册）、假 Herdr adapter、可控主会话与子进程 context。
 * 断言只针对外部动作与参数；不触碰扩展内部结构。
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type { ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const RUNTIME_KEY = Symbol.for("vkzha.pi-subagent.runtime");

export type Handler = (event: any, ctx: any) => unknown;

export interface Tool {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
	parameters: { properties?: Record<string, unknown> };
	description: string;
}

export interface App {
	handlers: Map<string, Handler>;
	tools: Map<string, Tool>;
	/** 主 Agent 实际收到的 follow-up 消息 */
	sent: { content: unknown; options?: Record<string, unknown> }[];
}

/** 当前测试的假 Herdr；`makeCtx` 每次都会切换它，于是 pi.exec 与 ctx 指向同一套假环境。 */
let activeHerdr: FakeHerdr | undefined;

export function setup(factory: (pi: ExtensionAPI) => void): App {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, Tool>();
	const sent: { content: unknown; options?: Record<string, unknown> }[] = [];
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerTool: (definition: Tool & { name: string }) => tools.set(definition.name, definition),
		sendUserMessage: (content: unknown, options?: Record<string, unknown>) => {
			sent.push({ content, options });
		},
		exec: (command: string, args: string[]) => {
			assert.ok(activeHerdr, "派发前必须先构造 ctx（makeCtx）");
			return activeHerdr.exec(command, args);
		},
	};
	factory(pi as unknown as ExtensionAPI);
	return { handlers, tools, sent };
}

export interface FakeHerdr {
	exec: (command: string, args: string[]) => Promise<ExecResult>;
	calls: { command: string; args: string[] }[];
	tabs: { tabId: string; paneId: string }[];
	createFails?: string;
	startFails?: string;
	promptFails?: string;
	/** 默认 true：模拟子进程启动时通过 IPC 报告实例绑定（真实桥接在 session_start 时发送）。 */
	autoBind?: boolean;
	/** 模拟子 session 中已保存的绑定类型；缺省表示这是一个全新的子 session。 */
	savedType?: string;
}

export function fakeHerdr(): FakeHerdr {
	const fake: FakeHerdr = { calls: [], tabs: [], exec: async (command, args) => respond(fake, command, args) };
	return fake;
}

async function respond(fake: FakeHerdr, command: string, args: string[]): Promise<ExecResult> {
	fake.calls.push({ command, args });
	const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", code: 0, killed: false });
	const bad = (stderr: string): ExecResult => ({ stdout: "", stderr, code: 1, killed: false });
	if (command !== "herdr") return bad(`command not found: ${command}`);
	if (args[0] === "tab" && args[1] === "create") {
		if (fake.createFails) return bad(fake.createFails);
		const n = fake.tabs.length + 1;
		const tab = { tabId: `w1:t${n}`, paneId: `w1:p${n}` };
		fake.tabs.push(tab);
		return ok(JSON.stringify({ result: { tab: { tab_id: tab.tabId }, root_pane: { pane_id: tab.paneId } } }));
	}
	if (args[0] === "agent" && args[1] === "start") {
		if (fake.startFails) return bad(fake.startFails);
		if (fake.autoBind !== false) await reportBinding(fake);
		return ok(JSON.stringify({ result: {} }));
	}
	if (args[0] === "agent" && args[1] === "prompt") {
		if (fake.promptFails) return bad(fake.promptFails);
		return ok(JSON.stringify({ result: {} }));
	}
	if (args[0] === "tab" && args[1] === "close") {
		fake.tabs = fake.tabs.filter((tab) => tab.tabId !== args[2]);
		return ok(JSON.stringify({ result: {} }));
	}
	return bad(`unsupported command: ${args.join(" ")}`);
}

/** 模拟子进程启动握手：报告实例身份与子 session 中已保存的绑定。 */
async function reportBinding(fake: FakeHerdr): Promise<void> {
	const env = childEnv(fake);
	const pipe = env.PI_SUBAGENT_PIPE;
	if (!pipe) return;
	const ownerKey = env.PI_SUBAGENT_OWNER_KEY ?? "";
	const name = env.PI_SUBAGENT_NAME ?? "";
	await sendRaw(
		pipe,
		JSON.stringify({
			kind: "binding",
			ownerKey,
			name,
			type: env.PI_SUBAGENT_TYPE ?? "",
			bound: fake.savedType ? { ownerKey, name, type: fake.savedType } : undefined,
		}) + "\n",
	);
}

export function sendRaw(pipe: string, payload: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = connect(pipe);
		socket.on("error", reject);
		socket.on("connect", () => socket.end(payload));
		socket.on("close", () => resolve());
	});
}

export interface CtxOptions {
	sessionId?: string;
	sessionFile?: string | undefined;
	cwd?: string;
}

export function makeCtx(fake: FakeHerdr, options: CtxOptions = {}): ExtensionContext {
	activeHerdr = fake;
	const sessionFile = "sessionFile" in options ? options.sessionFile : "D:/sessions/main-1.jsonl";
	return {
		cwd: options.cwd ?? "D:/work/project",
		sessionManager: {
			getSessionId: () => options.sessionId ?? "main-session-1",
			getSessionFile: () => sessionFile,
		},
		ui: { notify: () => {} },
		isIdle: () => true,
		isProjectTrusted: () => true,
	} as unknown as ExtensionContext;
}

export async function dispatch(app: App, ctx: ExtensionContext, params: Record<string, unknown>) {
	// 真实 pi 中 session_start 一定先于任何工具调用；测试在此补齐这一步，让主会话身份就位。
	app.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
	const tool = app.tools.get("agent");
	assert.ok(tool, "agent 工具必须已注册");
	const result = await tool.execute("call-1", params, undefined, undefined, ctx);
	return { text: result.content[0]?.text ?? "", details: result.details };
}

export function definitionFile(agentDir: string, name: string, frontmatter: string, body: string): void {
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(join(agentDir, "agents", name), `---\n${frontmatter}\n---\n${body}\n`, "utf8");
}

export function calls(fake: FakeHerdr, ...head: string[]) {
	return fake.calls.filter((call) => head.every((part, index) => call.args[index] === part));
}

export function piArgs(fake: FakeHerdr): string[] {
	const start = calls(fake, "agent", "start").at(-1);
	assert.ok(start, "必须启动过 agent");
	const marker = start.args.indexOf("--");
	assert.ok(marker >= 0, "agent start 必须用 -- 传入 Pi 原生参数");
	return start.args.slice(marker + 1);
}

/** 读取 `tab create --env` 实际传给子 Agent 的环境变量。 */
export function childEnv(fake: FakeHerdr): Record<string, string> {
	const create = calls(fake, "tab", "create").at(-1);
	assert.ok(create, "必须创建过标签页");
	const env: Record<string, string> = {};
	for (let index = 0; index < create.args.length; index += 1) {
		if (create.args[index] !== "--env") continue;
		const entry = create.args[index + 1] ?? "";
		const separator = entry.indexOf("=");
		if (separator > 0) env[entry.slice(0, separator)] = entry.slice(separator + 1);
	}
	return env;
}

export function argValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

// ─── 子 Agent 进程一侧（桥接）───

export interface BridgeHarness {
	handlers: Map<string, Handler>;
	tools: Map<string, Tool>;
	entries: { customType: string; data: unknown }[];
	notifications: { message: string; level?: string }[];
	ctx: ExtensionContext;
	fire(event: string, payload?: unknown): unknown;
}

export function setupBridge(
	factory: (pi: ExtensionAPI) => void,
	env: Record<string, string>,
	options: { entries?: unknown[] } = {},
): BridgeHarness {
	for (const [key, value] of Object.entries(env)) process.env[key] = value;
	const handlers = new Map<string, Handler>();
	const entries: { customType: string; data: unknown }[] = [];
	const notifications: { message: string; level?: string }[] = [];
	const ctx = {
		sessionManager: {
			getSessionId: () => "sb-child-session",
			getSessionFile: () => "D:/sessions/child.jsonl",
			getEntries: () => options.entries ?? [],
		},
		ui: {
			notify: (message: string, level?: string) => {
				notifications.push({ message, level });
			},
		},
	} as unknown as ExtensionContext;
	const tools = new Map<string, Tool>();
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerTool: (definition: Tool & { name: string }) => tools.set(definition.name, definition),
		appendEntry: (customType: string, data?: unknown) => {
			entries.push({ customType, data });
		},
	};
	factory(pi as unknown as ExtensionAPI);
	return {
		handlers,
		tools,
		entries,
		notifications,
		ctx,
		fire: (event: string, payload: unknown = { type: event }) => handlers.get(event)?.(payload, ctx),
	};
}

/**
 * 模拟运行资源丢失（pane 被关闭、父 pi 进程重启）：只丢运行态定位，
 * 子 session 与其中的绑定不受影响。
 */
export function loseRuntime(): void {
	const store = (globalThis as unknown as Record<symbol, { instances: Map<string, unknown> } | undefined>)[RUNTIME_KEY];
	store?.instances.clear();
}

export async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(check(), "等待条件超时");
}
