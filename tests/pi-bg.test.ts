import assert from "node:assert/strict";
import { test } from "node:test";

import {
	KEEP_FINISHED,
	type BgJob,
	finishedJobs,
	findJob,
	newJobId,
	pruneFinished,
	runningCount,
	runningJobs,
	summarizeLabel,
} from "../extensions/lib/bg/jobs.ts";
import {
	deliveryContent,
	elapsedText,
	formatListLines,
	splitDelivery,
	startText,
	statusText,
} from "../extensions/lib/bg/format.ts";

function job(overrides: Partial<BgJob> = {}): BgJob {
	return {
		id: "b3f1a2c4",
		kind: "bash",
		label: "npm test",
		startedAt: 1_000,
		status: "running",
		...overrides,
	};
}

// ─── summarizeLabel ───

test("label 取第一条非空行并压成单行", () => {
	assert.equal(summarizeLabel("\n\n  npm   run\tbuild \n second"), "npm run build");
});

test("label 超长时以省略号收尾", () => {
	const label = summarizeLabel("x".repeat(200), 10);
	assert.equal(label.length, 10);
	assert.ok(label.endsWith("…"));
});

test("空内容得到空 label", () => {
	assert.equal(summarizeLabel("   \n\t\n"), "");
});

// ─── newJobId ───

test("任务 id 是 8 位十六进制", () => {
	const id = newJobId(() => false, () => "0a1b2c3d-4e5f-6789-abcd-ef0123456789");
	assert.equal(id, "0a1b2c3d");
	assert.match(id, /^[0-9a-f]{8}$/);
});

test("撞号时重摇", () => {
	const sequence = ["aaaaaaaa-1", "bbbbbbbb-2"];
	let index = 0;
	const id = newJobId((candidate) => candidate === "aaaaaaaa", () => sequence[Math.min(index++, sequence.length - 1)]!);
	assert.equal(id, "bbbbbbbb");
});

test("连续撞号 100 次后报错而不是返回重复 id", () => {
	assert.throws(() => newJobId(() => true, () => "aaaaaaaa-0"), /unique/);
});

// ─── 任务表 ───

test("在跑与已完成分开统计", () => {
	const jobs = [
		job({ id: "a" }),
		job({ id: "b", status: "done", durationMs: 100 }),
		job({ id: "c", status: "failed", durationMs: 100 }),
	];
	assert.equal(runningCount(jobs), 1);
	assert.deepEqual(
		runningJobs(jobs).map((entry) => entry.id),
		["a"],
	);
	assert.deepEqual(
		finishedJobs(jobs).map((entry) => entry.id),
		["b", "c"],
	);
	assert.equal(findJob(jobs, "c")?.status, "failed");
	assert.equal(findJob(jobs, "zzz"), undefined);
});

test("淘汰只动最旧的已完成任务，在跑的任务永不被淘汰", () => {
	const jobs: BgJob[] = [job({ id: "run-1" })];
	for (let index = 0; index < KEEP_FINISHED + 3; index += 1) {
		jobs.push(job({ id: `done-${index}`, status: "done", durationMs: 1 }));
	}
	const dropped = pruneFinished(jobs);
	assert.equal(dropped.length, 3);
	assert.deepEqual(
		dropped.map((entry) => entry.id),
		["done-0", "done-1", "done-2"],
	);
	assert.equal(finishedJobs(jobs).length, KEEP_FINISHED);
	assert.ok(findJob(jobs, "run-1"), "在跑任务必须留下");
});

test("未超出保留数时不淘汰", () => {
	const jobs = [job({ id: "a" }), job({ id: "b", status: "done" })];
	assert.deepEqual(pruneFinished(jobs), []);
	assert.equal(jobs.length, 2);
});

// ─── 文本 ───

test("耗时格式：一位小数 → 整秒 → 分秒", () => {
	assert.equal(elapsedText(3_240), "3.2s");
	assert.equal(elapsedText(42_400), "42s");
	assert.equal(elapsedText(63_000), "1m03s");
	assert.equal(elapsedText(-5), "0.0s");
});

test("状态行带上退出码与耗时", () => {
	assert.equal(statusText(job({ status: "done", exitCode: 0, durationMs: 12_400 })), "done · exit 0 · 12s");
	assert.equal(statusText(job({ status: "failed", exitCode: 127, durationMs: 500 })), "failed · exit 127 · 0.5s");
	assert.equal(statusText(job({ status: "killed", durationMs: 500 })), "killed · 0.5s");
	assert.equal(statusText(job({ kind: "codemode", status: "done", durationMs: 2_100 })), "done · 2.1s");
});

test("启动返回告知 id、回传方式与进程级存续域", () => {
	const text = startText(job());
	assert.match(text, /Started background job b3f1a2c4 \(npm test\)/);
	assert.match(text, /bg kill/);
	assert.match(text, /process-scoped/);
});

test("完成消息是头行 + 原样输出，空输出退回占位", () => {
	const done = job({ status: "done", exitCode: 0, durationMs: 12_400, output: "line 1\nline 2" });
	assert.equal(deliveryContent(done), "[bash-bg b3f1a2c4] npm test — done · exit 0 · 12s\n\nline 1\nline 2");
	assert.match(deliveryContent(job({ status: "done", output: "   " })), /\(no output\)$/);
});

test("splitDelivery 把头行与正文分开", () => {
	assert.deepEqual(splitDelivery("head\n\nbody"), { head: "head", body: "body" });
	assert.deepEqual(splitDelivery("only head"), { head: "only head", body: "" });
});

test("列表：在跑在前，已完成新到旧", () => {
	assert.deepEqual(formatListLines([]), ["没有后台任务。"]);

	const lines = formatListLines([
		job({ id: "old", status: "done", durationMs: 1_000 }),
		job({ id: "run", startedAt: Date.now() - 1_000 }),
		job({ id: "new", status: "done", durationMs: 2_000 }),
	]);
	assert.equal(lines[0], "共 1 个在跑 / 2 条已完成");
	assert.equal(lines[1], "");
	assert.match(lines[2]!, /^run — bash · running · /);
	assert.match(lines[3]!, /^new — bash · done/);
	assert.match(lines[4]!, /^old — bash · done/);
});

// ─── 扩展接线：注册、委托、回传、终止 ───

import { captureCodemodeTool, registerPiBg } from "../extensions/pi-bg.ts";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

interface FakePi {
	pi: ExtensionAPI;
	tools: Map<string, any>;
	commands: Map<string, any>;
	sent: Array<{ message: any; options: any }>;
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
	entries: Array<{ type: string; data: any }>;
	captured: any[];
}

function fakePi(): FakePi {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const sent: Array<{ message: any; options: any }> = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const entries: Array<{ type: string; data: any }> = [];
	const captured: any[] = [];
	const pi = {
		registerTool: (def: any) => {
			captured.push(def);
			tools.set(def.name, def);
		},
		registerCommand: (name: string, options: any) => commands.set(name, options),
		registerMessageRenderer: () => {},
		registerEntryRenderer: () => {},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		sendMessage: (message: any, options: any) => sent.push({ message, options }),
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		getSettings: () => ({}),
		getAllTools: () => [],
		getActiveTools: () => [],
	} as unknown as ExtensionAPI;
	return { pi, tools, commands, sent, handlers, entries, captured };
}

/** 假的 codemode 定义：只记录调用，不跑沙箱。 */
function stubCodemode(calls: Array<{ code: unknown }>): ToolDefinition {
	return {
		name: "codemode",
		label: "Codemode",
		description: "",
		parameters: {} as any,
		execute: async (_toolCallId: string, params: any) => {
			calls.push({ code: params.code });
			return { content: [{ type: "text", text: "Script completed\n42" }] };
		},
	} as unknown as ToolDefinition;
}

function outcome(name: string, text: string, structuredContent?: unknown, isError = false) {
	return {
		toolCall: { type: "toolCall", id: `nested-${name}`, name, arguments: {} },
		result: { content: [{ type: "text", text }], structuredContent, ...(isError ? { isError: true } : {}) },
		isError,
	};
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("captureCodemodeTool 接住真实的 codemode 工具定义", () => {
	const { pi } = fakePi();
	const definition = captureCodemodeTool(pi);
	assert.ok(definition, "应能从 createCodemodeExtension 接住定义");
	assert.equal(definition!.name, "codemode");
	assert.equal(typeof definition!.execute, "function");
});

test("bash-bg 委托内置 bash，结束后以 steer + triggerTurn 回传", async () => {
	const { pi, tools, sent } = fakePi();
	registerPiBg(pi, stubCodemode([]));
	const calls: Array<{ name: string; args: any }> = [];
	const ctx = {
		executeTool: async (name: string, args: any) => {
			calls.push({ name, args });
			return outcome(name, "hello\nCommand exited with code 0", {
				output: "hello",
				truncated: false,
				exit_code: 0,
				wall_time_seconds: 0.1,
			});
		},
	};

	const result = await tools.get("bash-bg").execute("call-1", { command: "echo hello" }, undefined, undefined, ctx);
	const id = result.details.jobs[0].id;
	assert.match(result.content[0].text, new RegExp(`Started background job ${id}`));
	assert.deepEqual(calls, [{ name: "bash", args: { command: "echo hello" } }]);

	await until(() => sent.length === 1);
	assert.equal(sent[0]!.options.deliverAs, "steer");
	assert.equal(sent[0]!.options.triggerTurn, true);
	assert.equal(sent[0]!.message.customType, "pi-bg");
	assert.equal(sent[0]!.message.display, true);
	assert.ok(
		sent[0]!.message.content.startsWith(`[bash-bg ${id}] echo hello — done · exit 0 · `),
		sent[0]!.message.content,
	);
	assert.match(sent[0]!.message.content, /hello\nCommand exited with code 0$/);
});

test("codemode-bg 调用接住的定义，而不是 executeTool", async () => {
	const { pi, tools, sent } = fakePi();
	const calls: Array<{ code: unknown }> = [];
	registerPiBg(pi, stubCodemode(calls));
	const ctx = {
		executeTool: async () => {
			throw new Error("codemode-bg 不该走 executeTool");
		},
	};

	const result = await tools.get("codemode-bg").execute("call-1", { code: "return 42" }, undefined, undefined, ctx);
	const id = result.details.jobs[0].id;
	await until(() => sent.length === 1);
	assert.deepEqual(calls, [{ code: "return 42" }]);
	assert.ok(sent[0]!.message.content.startsWith(`[codemode-bg ${id}] return 42 — done · `), sent[0]!.message.content);
	assert.match(sent[0]!.message.content, /Script completed\n42$/);
});

test("codemode 后端接不到时给出明确错误而不是静默失败", async () => {
	const { pi, tools } = fakePi();
	registerPiBg(pi, null);
	const result = await tools.get("codemode-bg").execute("call-1", { code: "return 1" }, undefined, undefined, {});
	assert.match(result.details.error!, /codemode backend unavailable/);
	assert.match(result.content[0].text, /^Error: codemode backend unavailable/);
});

test("父轮 signal 不传给后台任务：已中止的入参不阻止任务完成", async () => {
	const { pi, tools, sent } = fakePi();
	registerPiBg(pi, stubCodemode([]));
	let seenSignal: AbortSignal | undefined;
	const ctx = {
		executeTool: async (_name: string, _args: unknown, options: { signal?: AbortSignal }) => {
			seenSignal = options?.signal;
			return outcome("bash", "ok", { exit_code: 0 });
		},
	};
	const parent = new AbortController();
	parent.abort();
	await tools.get("bash-bg").execute("call-1", { command: "true" }, parent.signal, undefined, ctx);
	await until(() => sent.length === 1);

	assert.ok(seenSignal);
	assert.notEqual(seenSignal, parent.signal);
	assert.equal(seenSignal.aborted, false);
});

test("bg kill 中止任务且不回传", async () => {
	const { pi, tools, sent } = fakePi();
	registerPiBg(pi, stubCodemode([]));
	let aborted = false;
	const ctx = {
		executeTool: (_name: string, _args: unknown, options: { signal?: AbortSignal }) =>
			new Promise((resolve) => {
				options.signal?.addEventListener("abort", () => {
					aborted = true;
					resolve(outcome("bash", "Command aborted", undefined, true));
				});
			}),
	};

	const started = await tools.get("bash-bg").execute("call-1", { command: "sleep 60" }, undefined, undefined, ctx);
	const id = started.details.jobs[0].id;
	const killed = await tools.get("bg").execute("call-2", { action: "kill", id });
	assert.equal(killed.content[0].text, `Killed background job ${id}.`);

	await until(() => aborted);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(sent.length, 0, "被 kill 的任务不回传");
});

test("并发上限 64：超出直接拒绝", async () => {
	const { pi, tools } = fakePi();
	registerPiBg(pi, stubCodemode([]));
	const ctx = { executeTool: () => new Promise(() => {}) };
	for (let index = 0; index < 64; index += 1) {
		const result = await tools.get("bash-bg").execute(`call-${index}`, { command: `cmd-${index}` }, undefined, undefined, ctx);
		assert.match(result.content[0].text, /Started background job/);
	}
	const refused = await tools.get("bash-bg").execute("call-65", { command: "cmd-65" }, undefined, undefined, ctx);
	assert.match(refused.content[0].text, /^Error: too many background jobs \(max 64\)/);
});

test("/bg 列出任务，/bg kill <id> 终止", async () => {
	const { pi, commands, entries } = fakePi();
	registerPiBg(pi, stubCodemode([]));
	await commands.get("bg").handler("", { mode: "tui" });
	assert.match(entries[0]!.data.lines[0].text, /没有后台任务/);

	await commands.get("bg").handler("kill", { mode: "rpc" });
	assert.match(entries[1]!.data.lines[0].text, /没有在跑的后台任务/);
});

test("session_shutdown 中止在跑任务且不再回传", async () => {
	const { pi, tools, handlers, sent } = fakePi();
	registerPiBg(pi, stubCodemode([]));
	let aborted = false;
	const ctx = {
		executeTool: (_name: string, _args: unknown, options: { signal?: AbortSignal }) =>
			new Promise((resolve) => {
				options.signal?.addEventListener("abort", () => {
					aborted = true;
					resolve(outcome("bash", "Command aborted", undefined, true));
				});
			}),
	};
	const started = await tools.get("bash-bg").execute("call-1", { command: "sleep 60" }, undefined, undefined, ctx);
	const id = started.details.jobs[0].id;

	await handlers.get("session_shutdown")!({ type: "session_shutdown" }, {});
	await until(() => aborted);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(sent.length, 0);
	assert.match((await tools.get("bg").execute("call-2", { action: "list" })).content[0].text, new RegExp(id));
});

test("session_start 清掉上个会话遗留的已完成记录", async () => {
	const { pi, tools, handlers } = fakePi();
	registerPiBg(pi, stubCodemode([]));
	const ctx = { executeTool: async (name: string) => outcome(name, "ok", { exit_code: 0 }) };
	await tools.get("bash-bg").execute("call-1", { command: "true" }, undefined, undefined, ctx);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.match((await tools.get("bg").execute("call-2", { action: "list" })).content[0].text, /共 0 个在跑 \/ 1 条已完成/);

	await handlers.get("session_start")!({ type: "session_start" }, {});
	assert.match((await tools.get("bg").execute("call-3", { action: "list" })).content[0].text, /没有后台任务/);
});
