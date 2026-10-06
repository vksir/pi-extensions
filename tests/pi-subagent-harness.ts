/**
 * pi-subagent 测试骨架：mock pi（捕获工具与事件注册）、假 Herdr adapter、可控主会话与子进程 context。
 * 断言只针对外部动作与参数；不触碰扩展内部结构。
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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
	const create = calls(fake, "tab", "create")[0];
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

export async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(check(), "等待条件超时");
}
