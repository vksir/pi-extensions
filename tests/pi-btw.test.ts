import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

type Handler = (args: string, ctx: FakeCtx) => Promise<void> | void;

interface FakeCtx {
	sessionManager: { getSessionFile: () => string | undefined };
	ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
	isIdle: () => boolean;
}

interface ExecScript {
	code?: number;
	stdout?: string;
	stderr?: string;
}

interface Setup {
	/** 触发已注册命令；未注册返回 { handled: false } */
	run: (name: string, args: string) => Promise<{ handled: boolean }>;
	/** 命令 handler 发出的 CLI 调用（取后即清） */
	execCalls: () => { command: string; args: string[] }[];
	/** 让假 exec 按序返回脚本化结果；不设则全部成功 */
	scriptExec: (responses: ExecScript[]) => void;
	/** 改写假 ctx 返回的当前会话文件；undefined 模拟无 session 文件 */
	setSessionFile: (file: string | undefined) => void;
	/** 模拟 agent 是否在跑 turn（默认空闲） */
	setBusy: (busy: boolean) => void;
	notifies: { message: string; type?: string }[];
	/** 恢复 setup 改动的进程环境变量 */
	restoreEnv: () => void;
}

const HERDR_ENV_KEYS = ["HERDR_ENV", "HERDR_TAB_ID", "HERDR_BIN_PATH", "HC_TERMINAL_ID"] as const;

/**
 * pi-btw 在 default() 里读环境并注册命令；这里带 cache-busting 地重新导入
 * 模块，保证每个 setup 拿到干净的注册流程，测试互不污染。
 */
let moduleSeq = 0;
async function setup(options: { variant?: "legacy" | "app" | "none" } = {}): Promise<Setup> {
	const { default: btwExtension } = await import(`../extensions/pi-btw.ts?run=${moduleSeq++}`);
	const previous = new Map(HERDR_ENV_KEYS.map((k) => [k, process.env[k]]));
	if (options.variant === "legacy") {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_TAB_ID = "tab-1";
		process.env.HERDR_BIN_PATH = "herdr-stub";
		delete process.env.HC_TERMINAL_ID;
	} else if (options.variant === "app") {
		for (const k of ["HERDR_ENV", "HERDR_TAB_ID", "HERDR_BIN_PATH"] as const) delete process.env[k];
		process.env.HC_TERMINAL_ID = "t1";
	} else {
		for (const k of HERDR_ENV_KEYS) delete process.env[k];
	}

	const commands = new Map<string, Handler>();
	const execs: { command: string; args: string[] }[] = [];
	let execScript: ExecScript[] = [];
	const pi = {
		registerCommand: (name: string, options: { handler: Handler }) => {
			commands.set(name, options.handler);
		},
		exec: async (command: string, args: string[]) => {
			execs.push({ command, args });
			return { code: 0, stdout: "", stderr: "", ...execScript.shift() };
		},
	};
	btwExtension(pi as never);

	const notifies: { message: string; type?: string }[] = [];
	let sessionFile: string | undefined = "/tmp/sess/current.json";
	let busy = false;
	const ctx: FakeCtx = {
		sessionManager: { getSessionFile: () => sessionFile },
		ui: {
			notify: (message, type) => {
				notifies.push({ message, type });
			},
		},
		isIdle: () => !busy,
	};

	return {
		run: async (name, args) => {
			const handler = commands.get(name);
			if (!handler) return { handled: false };
			await handler(args, ctx);
			return { handled: true };
		},
		execCalls: () => execs.splice(0, execs.length),
		scriptExec: (responses) => {
			execScript = responses;
		},
		setSessionFile: (file) => {
			sessionFile = file;
		},
		setBusy: (value) => {
			busy = value;
		},
		notifies,
		restoreEnv: () => {
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		},
	};
}

async function withSetup(
	options: Parameters<typeof setup>[0],
	run: (s: Setup) => void | Promise<void>,
): Promise<void> {
	const s = await setup(options);
	try {
		await run(s);
	} finally {
		s.restoreEnv();
	}
}

// ---- 注册条件 ----

test("非 herdr 环境：不注册 /btw", async () => {
	await withSetup({ variant: "none" }, async (s) => {
		assert.deepEqual(await s.run("btw", "hello"), { handled: false });
		assert.deepEqual(s.execCalls(), []);
	});
});

test("herdr app：注册 /btw；旧 herdr：注册 /btw", async () => {
	await withSetup({ variant: "app" }, async (s) => {
		assert.deepEqual(await s.run("btw", ""), { handled: true });
	});
	await withSetup({ variant: "legacy" }, async (s) => {
		assert.deepEqual(await s.run("btw", ""), { handled: true });
	});
});

// ---- 参数校验 ----

test("空消息（含纯空白）：提示用法，不发任何 CLI 调用", async () => {
	await withSetup({ variant: "app" }, async (s) => {
		await s.run("btw", "   ");
		assert.equal(s.notifies.length, 1);
		assert.equal(s.notifies[0]!.type, "warning");
		assert.match(s.notifies[0]!.message, /用法/);
		assert.deepEqual(s.execCalls(), []);
	});
});

test("当前会话没有 session 文件：报错拒绝，不降级成全新会话", async () => {
	await withSetup({ variant: "app" }, async (s) => {
		s.setSessionFile(undefined);
		await s.run("btw", "hello");
		assert.equal(s.notifies[0]!.type, "error");
		assert.match(s.notifies[0]!.message, /session 文件/);
		assert.deepEqual(s.execCalls(), []);
	});
});

// ---- 正常分派 ----

test("herdr app：/btw 消息 → 一条 tab.new，fork 与消息经 -- 进 argv，不命名标签", async () => {
	await withSetup({ variant: "app" }, async (s) => {
		await s.run("btw", "顺便查一下 flaky 测试\n再看下日志");
		const calls = s.execCalls();
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.command, "herdr-app");
		assert.deepEqual(calls[0]!.args.slice(0, 2), ["do", "tab.new"]);
		assert.equal(calls[0]!.args.includes("--name"), false);
		assert.equal(calls[0]!.args.includes("--task"), false);
		const argv = JSON.parse(calls[0]!.args[calls[0]!.args.indexOf("--argv") + 1]!);
		assert.deepEqual(argv, ["pi", "--fork", "/tmp/sess/current.json", "--", "顺便查一下 flaky 测试\n再看下日志"]);
		assert.equal(s.notifies[0]!.type, "info");
	});
});

test("旧 herdr：/btw 消息 → 四步调用，不命名、消息走 send-text", async () => {
	await withSetup({ variant: "legacy" }, async (s) => {
		s.scriptExec([
			{ stdout: '{"result":{"root_pane":{"pane_id":"w1:p1"}}}' },
			{},
			{ stdout: JSON.stringify({ result: { agents: [{ pane_id: "w1:p1", agent: "pi", agent_status: "idle" }] } }) },
			{},
			{},
		]);
		await s.run("btw", "顺便查一下 flaky 测试");
		const calls = s.execCalls();
		assert.equal(calls.length, 5);
		assert.deepEqual(calls[0]!.args, ["tab", "create", "--cwd", process.cwd()]);
		assert.deepEqual(calls[1]!.args, ["pane", "run", "w1:p1", "pi", "--fork", "'/tmp/sess/current.json'"]);
		assert.deepEqual(calls[2]!.args, ["agent", "list"]);
		assert.deepEqual(calls[3]!.args, ["pane", "send-text", "w1:p1", "顺便查一下 flaky 测试"]);
		assert.deepEqual(calls[4]!.args, ["pane", "send-keys", "w1:p1", "enter"]);
		assert.equal(s.notifies[0]!.type, "info");
	});
});

test("CLI 失败：error 通知带原因", async () => {
	await withSetup({ variant: "app" }, async (s) => {
		s.scriptExec([{ code: 1, stdout: '{"error":"no window"}' }]);
		await s.run("btw", "hello");
		assert.equal(s.notifies[0]!.type, "error");
		assert.match(s.notifies[0]!.message, /no window/);
	});
});

// ---- agent 忙碌时的安全快照 ----

const STAMP = "2026-01-01T00:00:00.000Z";

function headerLine(): Record<string, unknown> {
	return { type: "session", version: 3, id: "sess-btw", timestamp: STAMP, cwd: process.cwd() };
}

function messageLine(
	type: "user" | "assistant" | "toolCall",
	id: string,
	parentId: string | null,
): Record<string, unknown> {
	if (type === "user") {
		return {
			type: "message",
			id,
			parentId,
			timestamp: STAMP,
			message: { role: "user", content: "问题", timestamp: 0 },
		};
	}
	const content =
		type === "assistant"
			? [{ type: "text", text: "答" }]
			: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }];
	return {
		type: "message",
		id,
		parentId,
		timestamp: STAMP,
		message: {
			role: "assistant",
			content,
			api: "test",
			provider: "test",
			model: "test",
			usage: {},
			stopReason: type === "assistant" ? "stop" : "toolUse",
			timestamp: 0,
		},
	};
}

function writeSessionFile(entries: Record<string, unknown>[]): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-btw-session-"));
	const file = join(dir, "current.jsonl");
	writeFileSync(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf-8");
	return file;
}

function readSessionFile(file: string): Record<string, unknown>[] {
	return readFileSync(file, "utf-8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("agent 忙碌（流式生成中）：fork 改走截到上一轮边界的快照，并说明丢弃条数", async () => {
	await withSetup({ variant: "app" }, async (s) => {
		const file = writeSessionFile([
			headerLine(),
			messageLine("user", "u1", null),
			messageLine("assistant", "a1", "u1"),
			messageLine("user", "u2", "a1"),
		]);
		s.setSessionFile(file);
		s.setBusy(true);
		await s.run("btw", "顺便查一下");

		const calls = s.execCalls();
		assert.equal(calls.length, 1);
		const argv = JSON.parse(calls[0]!.args[calls[0]!.args.indexOf("--argv") + 1]!);
		const forkPath = argv[2] as string;
		assert.notEqual(forkPath, file);
		assert.deepEqual(readSessionFile(forkPath), [
			headerLine(),
			messageLine("user", "u1", null),
			messageLine("assistant", "a1", "u1"),
		]);
		assert.equal(readSessionFile(file).length, 4, "源会话不该被改动");
		assert.equal(s.notifies[0]!.type, "info");
		assert.match(s.notifies[0]!.message, /尚未结束/);
		assert.match(s.notifies[0]!.message, /1 条/);
	});
});

test("agent 忙碌（工具执行中）：悬空 toolCall 不会进入 fork 的上下文", async () => {
	await withSetup({ variant: "legacy" }, async (s) => {
		const file = writeSessionFile([
			headerLine(),
			messageLine("user", "u1", null),
			messageLine("assistant", "a1", "u1"),
			messageLine("user", "u2", "a1"),
			messageLine("toolCall", "a2", "u2"),
		]);
		s.setSessionFile(file);
		s.setBusy(true);
		s.scriptExec([
			{ stdout: '{"result":{"root_pane":{"pane_id":"w1:p1"}}}' },
			{},
			{ stdout: JSON.stringify({ result: { agents: [{ pane_id: "w1:p1", agent: "pi", agent_status: "idle" }] } }) },
			{},
			{},
		]);
		await s.run("btw", "顺便查一下");

		const calls = s.execCalls();
		const forkArg = calls[1]!.args[5]!;
		const forkPath = forkArg.slice(1, -1); // pane run 把路径包在单引号里
		assert.notEqual(forkPath, file);
		const entries = readSessionFile(forkPath);
		assert.equal(entries.length, 3);
		assert.equal(entries[2]!.type, "message");
	});
});

test("agent 忙碌但会话已停在完整边界：仍 fork 原文件", async () => {
	await withSetup({ variant: "app" }, async (s) => {
		const file = writeSessionFile([
			headerLine(),
			messageLine("user", "u1", null),
			messageLine("assistant", "a1", "u1"),
		]);
		s.setSessionFile(file);
		s.setBusy(true);
		await s.run("btw", "顺便查一下");
		const calls = s.execCalls();
		const argv = JSON.parse(calls[0]!.args[calls[0]!.args.indexOf("--argv") + 1]!);
		assert.equal(argv[2], file);
		assert.doesNotMatch(s.notifies[0]!.message, /尚未结束/);
	});
});

test("agent 忙碌且会话文件读不了：error 通知，不启动新标签", async () => {
	await withSetup({ variant: "app" }, async (s) => {
		s.setSessionFile(join(tmpdir(), "pi-btw-missing", "nope.jsonl"));
		s.setBusy(true);
		await s.run("btw", "顺便查一下");
		assert.deepEqual(s.execCalls(), []);
		assert.equal(s.notifies[0]!.type, "error");
		assert.match(s.notifies[0]!.message, /快照/);
	});
});
