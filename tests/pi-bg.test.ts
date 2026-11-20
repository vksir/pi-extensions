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
	bgCommandLines,
	deliveryContent,
	elapsedText,
	listText,
	promoteText,
	splitDelivery,
	startText,
	statusText,
} from "../extensions/lib/bg/format.ts";

function job(overrides: Partial<BgJob> = {}): BgJob {
	return {
		id: "b3f1a2c4",
		kind: "bash",
		origin: "start",
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

test("启动返回只有一行：id + started in background", () => {
	assert.equal(startText(job()), "bg_job b3f1a2c4 started in background.");
});

test("晋升返回先说 bash，再说转成哪个 job", () => {
	assert.equal(
		promoteText(job({ origin: "promote" }), "5m00s", "last output 1m42s ago"),
		"bash promoted to bg_job b3f1a2c4 after 5m00s. Still running, last output 1m42s ago.",
	);
	assert.equal(
		promoteText(job({ kind: "codemode", origin: "promote" }), "5m00s", "7 calls so far, current: bash (2m18s)"),
		"codemode promoted to bg_job b3f1a2c4 after 5m00s. Still running, 7 calls so far, current: bash (2m18s).",
	);
});

test("完成消息是头行 + 原样输出，空输出退回占位", () => {
	const done = job({ status: "done", exitCode: 0, durationMs: 12_400, output: "line 1\nline 2" });
	assert.equal(
		deliveryContent(done),
		"[bg_job b3f1a2c4] bash_bg · npm test — done · exit 0 · 12s\n\nline 1\nline 2",
	);
	assert.match(deliveryContent(job({ status: "done", output: "   " })), /\(no output\)$/);
});

test("splitDelivery 把头行与正文分开", () => {
	assert.deepEqual(splitDelivery("head\n\nbody"), { head: "head", body: "body" });
	assert.deepEqual(splitDelivery("only head"), { head: "only head", body: "" });
});

test("列表：英文表头 + 在跑在前，已完成新到旧", () => {
	assert.equal(listText([]), "bg_job list: no jobs.");

	const jobs = [
		job({ id: "old", status: "done", durationMs: 1_000 }),
		job({ id: "run", startedAt: Date.now() - 1_000 }),
		job({ id: "new", status: "done", durationMs: 2_000 }),
	];
	const lines = listText(jobs).split("\n");
	assert.equal(lines[0], "bg_job list: 1 running, 2 finished.");
	assert.equal(lines[1], "");
	assert.match(lines[2]!, /^bg_job run — bash · running · /);
	assert.match(lines[3]!, /^bg_job new — bash · done/);
	assert.match(lines[4]!, /^bg_job old — bash · done/);

	// /bg 的列表是给人看的：中文表头，行共用
	const zh = bgCommandLines(jobs);
	assert.equal(zh[0], "共 1 个在跑 / 2 条已完成");
	assert.equal(zh[2], lines[2]);
	assert.deepEqual(bgCommandLines([]), ["没有后台任务。"]);
});

// ─── 扩展接线：注册、委托、回传、终止 ───

import { hasBusyActivity } from "../extensions/lib/activity.ts";
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
	settings: Record<string, unknown>;
}

/** 内置工具的假 schema：测试只需证明「直接复用引用」，形状不重要。 */
const SCHEMAS: Record<string, any> = {
	bash: {
		type: "object",
		properties: { command: { type: "string" }, timeout: { type: "number" } },
		required: ["command"],
	},
	codemode: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
};

function fakePi(active: string[] = ["bash", "codemode"]): FakePi {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const sent: Array<{ message: any; options: any }> = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const entries: Array<{ type: string; data: any }> = [];
	const captured: any[] = [];
	const settings: Record<string, unknown> = {};
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
		getSettings: () => settings,
		getAllTools: () =>
			active.map((name) => ({
				name,
				description: "",
				parameters: SCHEMAS[name] ?? { type: "object", properties: {} },
				promptGuidelines: [],
			})),
		getActiveTools: () => [...active],
	} as unknown as ExtensionAPI;
	return { pi, tools, commands, sent, handlers, entries, captured, settings };
}

/** 注册扩展并跑一次 `session_start`：工具是在那里注册的。 */
function setup(
	options: {
		active?: string[];
		codemode?: ToolDefinition | null;
		promoteAfterSeconds?: number;
		createBash?: (cwd: string) => ToolDefinition;
	} = {},
): FakePi {
	const fake = fakePi(options.active);
	fake.settings[SETTINGS_KEY] = { promoteAfterSeconds: options.promoteAfterSeconds ?? 0 };
	registerPiBg(fake.pi, options.codemode === undefined ? stubCodemode([]) : options.codemode, {
		createBash: options.createBash ?? (() => stubBash()),
	});
	fake.handlers.get("session_start")!({ type: "session_start" }, { cwd: process.cwd() });
	return fake;
}

const SETTINGS_KEY = "pi-bg";

/** 假的覆盖目标：记录调用与信号，按 needs 决定何时结束。 */
function stubBash(): ToolDefinition {
	return {
		name: "bash",
		label: "bash",
		description: "fake bash",
		parameters: SCHEMAS.bash,
		outputSchema: { type: "object" },
		execute: async () => ({ content: [{ type: "text", text: "fake" }], details: undefined }),
	} as unknown as ToolDefinition;
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

test("bash_bg 委托内置 bash，结束后以 steer + triggerTurn 回传", async () => {
	const { tools, sent } = setup();
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

	const result = await tools.get("bash_bg").execute("call-1", { command: "echo hello" }, undefined, undefined, ctx);
	const id = result.details.jobs[0].id;
	assert.match(result.content[0].text, new RegExp(`bg_job ${id} started in background`));
	assert.deepEqual(calls, [{ name: "bash", args: { command: "echo hello" } }]);

	await until(() => sent.length === 1);
	assert.equal(sent[0]!.options.deliverAs, "steer");
	assert.equal(sent[0]!.options.triggerTurn, true);
	assert.equal(sent[0]!.message.customType, "pi-bg");
	assert.equal(sent[0]!.message.display, true);
	assert.ok(
		sent[0]!.message.content.startsWith(`[bg_job ${id}] bash_bg · echo hello — done · exit 0 · `),
		sent[0]!.message.content,
	);
	assert.match(sent[0]!.message.content, /hello\nCommand exited with code 0$/);
});

test("bash_bg 把入参原样透传给内置 bash", async () => {
	const { tools, sent } = setup();
	const calls: Array<{ name: string; args: any }> = [];
	const ctx = {
		executeTool: async (name: string, args: any) => {
			calls.push({ name, args });
			return outcome(name, "hello", { exit_code: 0 });
		},
	};

	await tools.get("bash_bg").execute("call-1", { command: "echo hello", timeout: 5 }, undefined, undefined, ctx);
	await until(() => sent.length === 1);
	// timeout 也一并透传：schema 来自内置 bash，pi 加参数时这里无需改
	assert.deepEqual(calls, [{ name: "bash", args: { command: "echo hello", timeout: 5 } }]);
});

test("codemode_bg 调用接住的定义，而不是 executeTool", async () => {
	const calls: Array<{ code: unknown }> = [];
	const { tools, sent } = setup({ codemode: stubCodemode(calls) });
	const ctx = {
		executeTool: async () => {
			throw new Error("codemode_bg 不该走 executeTool");
		},
	};

	const result = await tools.get("codemode_bg").execute("call-1", { code: "return 42" }, undefined, undefined, ctx);
	const id = result.details.jobs[0].id;
	await until(() => sent.length === 1);
	assert.deepEqual(calls, [{ code: "return 42" }]);
	assert.ok(sent[0]!.message.content.startsWith(`[bg_job ${id}] codemode_bg · return 42 — done · `), sent[0]!.message.content);
	assert.match(sent[0]!.message.content, /Script completed\n42$/);
});

test("codemode 后端接不到时不注册 codemode_bg", () => {
	const { tools } = setup({ codemode: null });
	assert.equal(tools.has("codemode_bg"), false);
	assert.equal(tools.has("bash_bg"), true);
});

test("未启用 bash 时不注册 bash_bg", () => {
	const { tools } = setup({ active: ["codemode"] });
	assert.equal(tools.has("bash_bg"), false);
	assert.equal(tools.has("codemode_bg"), true);
	assert.equal(tools.has("bg_job"), true);
});

test("未启用 codemode 时不注册 codemode_bg", () => {
	const { tools } = setup({ active: ["bash"] });
	assert.equal(tools.has("codemode_bg"), false);
	assert.equal(tools.has("bash_bg"), true);
});

test("两个后端都未启用时 bg 也不注册", () => {
	const { tools } = setup({ active: [] });
	assert.equal(tools.size, 0);
});

test("schema 直接复用内置工具的那一份", () => {
	const { tools } = setup({ codemode: stubCodemode([]) });
	assert.equal(tools.get("bash_bg").parameters, SCHEMAS.bash);
});

test("prepareLoadout：后端离开 declared 时隐藏自己", () => {
	const { tools } = setup();
	const hideBash = tools.get("bash_bg").prepareLoadout;
	assert.equal(hideBash({ declared: [{ name: "bash" }] }), undefined);
	assert.deepEqual(hideBash({ declared: [{ name: "read" }] }), { hiddenDeclarations: ["bash_bg"] });

	// bg 只要还有一个后端在就保留
	const hideBg = tools.get("bg_job").prepareLoadout;
	assert.equal(hideBg({ declared: [{ name: "bash" }] }), undefined);
	assert.equal(hideBg({ declared: [{ name: "codemode" }] }), undefined);
	assert.deepEqual(hideBg({ declared: [] }), { hiddenDeclarations: ["bg_job"] });
});

test("父轮 signal 不传给后台任务：已中止的入参不阻止任务完成", async () => {
	const { tools, sent } = setup();
	let seenSignal: AbortSignal | undefined;
	const ctx = {
		executeTool: async (_name: string, _args: unknown, options: { signal?: AbortSignal }) => {
			seenSignal = options?.signal;
			return outcome("bash", "ok", { exit_code: 0 });
		},
	};
	const parent = new AbortController();
	parent.abort();
	await tools.get("bash_bg").execute("call-1", { command: "true" }, parent.signal, undefined, ctx);
	await until(() => sent.length === 1);

	assert.ok(seenSignal);
	assert.notEqual(seenSignal, parent.signal);
	assert.equal(seenSignal.aborted, false);
});

test("bg_job kill 中止任务且不回传", async () => {
	const { tools, sent } = setup();
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

	const started = await tools.get("bash_bg").execute("call-1", { command: "sleep 60" }, undefined, undefined, ctx);
	const id = started.details.jobs[0].id;
	const killed = await tools.get("bg_job").execute("call-2", { action: "kill", id });
	assert.equal(killed.content[0].text, `bg_job ${id} killed.`);

	await until(() => aborted);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(sent.length, 0, "被 kill 的任务不回传");
});

test("并发上限 64：超出直接拒绝", async () => {
	const { tools } = setup();
	const ctx = { executeTool: () => new Promise(() => {}) };
	for (let index = 0; index < 64; index += 1) {
		const result = await tools.get("bash_bg").execute(`call-${index}`, { command: `cmd-${index}` }, undefined, undefined, ctx);
		assert.match(result.content[0].text, /bg_job .+ started in background/);
	}
	const refused = await tools.get("bash_bg").execute("call-65", { command: "cmd-65" }, undefined, undefined, ctx);
	assert.match(refused.content[0].text, /^Error: too many background jobs \(max 64\)/);
});

test("/bg 列出任务，/bg kill <id> 终止", async () => {
	const { commands, entries } = setup();
	await commands.get("bg").handler("", { mode: "tui" });
	assert.match(entries[0]!.data.lines[0].text, /转后台：关闭/);
	assert.equal(entries[0]!.data.lines[2].text, "没有后台任务。");

	await commands.get("bg").handler("kill", { mode: "rpc" });
	assert.match(entries[1]!.data.lines[0].text, /没有在跑的后台任务/);
});

test("session_shutdown 中止在跑任务且不再回传", async () => {
	const { tools, handlers, sent } = setup();
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
	const started = await tools.get("bash_bg").execute("call-1", { command: "sleep 60" }, undefined, undefined, ctx);
	const id = started.details.jobs[0].id;

	await handlers.get("session_shutdown")!({ type: "session_shutdown" }, {});
	await until(() => aborted);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(sent.length, 0);
	assert.match((await tools.get("bg_job").execute("call-2", { action: "list" })).content[0].text, new RegExp(id));
});

test("session_start 重入：清掉已完成记录且不重复注册", async () => {
	const { tools, handlers, captured } = setup();
	const registeredCount = captured.length;
	const ctx = { executeTool: async (name: string) => outcome(name, "ok", { exit_code: 0 }) };
	await tools.get("bash_bg").execute("call-1", { command: "true" }, undefined, undefined, ctx);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.match((await tools.get("bg_job").execute("call-2", { action: "list" })).content[0].text, /bg_job list: 0 running, 1 finished\./);

	// rebindCurrentSession 会在同一 runner 上二次触发 session_start
	await handlers.get("session_start")!({ type: "session_start" }, {});
	assert.equal(captured.length, registeredCount, "重入不该重复注册工具");
	assert.equal((await tools.get("bg_job").execute("call-3", { action: "list" })).content[0].text, "bg_job list: no jobs.");
});

// ─── 前台等待预算：晋升 ───

interface HangingBash {
	definition: ToolDefinition;
	/** 让内置执行结束 */
	finish: (text: string, exitCode?: number) => void;
	/** 内置执行看到的 signal */
	signal: () => AbortSignal | undefined;
}

/** 可控的内置 bash：不结束，直到测试调用 finish。 */
function hangingBash(): HangingBash {
	let settle!: (value: any) => void;
	let seen: AbortSignal | undefined;
	const pending = new Promise<any>((resolve) => {
		settle = resolve;
	});
	const definition = {
		name: "bash",
		label: "bash",
		description: "fake bash",
		parameters: SCHEMAS.bash,
		outputSchema: { type: "object" },
		execute: async (_id: string, _params: any, signal: AbortSignal, onUpdate: any) => {
			seen = signal;
			onUpdate?.({ content: [{ type: "text", text: "partial output" }], details: undefined });
			return pending;
		},
	} as unknown as ToolDefinition;
	return {
		definition,
		finish: (text, exitCode = 0) =>
			settle({
				content: [{ type: "text", text }],
				details: { fullOutputPath: "/tmp/full.log" },
				structuredContent: { output: text, truncated: false, exit_code: exitCode, wall_time_seconds: 1 },
			}),
		signal: () => seen,
	};
}

test("前台 bash 到点晋升：立刻返回、入任务表、结束时照常回传", async () => {
	const bash = hangingBash();
	const { tools, sent } = setup({ promoteAfterSeconds: 0.05, createBash: () => bash.definition });
	const parent = new AbortController();
	const result = await tools.get("bash").execute("call-1", { command: "npm test" }, parent.signal, undefined, {});
	const id = result.details.promoted as string;

	assert.match(result.content[0].text, /^bash promoted to bg_job [0-9a-f]{8} after /);
	assert.match(result.content[0].text, /Still running, last output /);
	assert.match(result.content[0].text, /\.$/);

	// 已经在任务表里，且带上了入参
	const shown = await tools.get("bg_job").execute("call-2", { action: "show", id }, undefined);
	assert.match(shown.content[0].text, new RegExp(`^bg_job ${id} — bash · running · `));
	assert.match(shown.content[0].text, /command: npm test/);
	assert.match(shown.content[0].text, /output so far:\npartial output/);

	// 晋升后父轮 Esc 不再连坐
	parent.abort();
	assert.equal(bash.signal()?.aborted, false);

	bash.finish("all good");
	await until(() => sent.length === 1);
	assert.match(sent[0]!.message.content, new RegExp(`^\\[bg_job ${id}\\] bash · npm test — done · exit 0 · `));
	assert.match(sent[0]!.message.content, /all good$/);
});

test("前台 bash 在预算内结束：原样返回结果，structuredContent 不丢", async () => {
	const bash = hangingBash();
	const { tools } = setup({ promoteAfterSeconds: 5, createBash: () => bash.definition });
	const pending = tools.get("bash").execute("call-1", { command: "true" }, undefined, undefined, {});
	bash.finish("done early", 0);
	const result = await pending;
	assert.equal(result.content[0].text, "done early");
	assert.equal((result.structuredContent as any).exit_code, 0);
	assert.equal(result.details.promoted, undefined);
});

test("嵌套调用不晋升", async () => {
	const bash = hangingBash();
	const { tools, handlers } = setup({ promoteAfterSeconds: 0.05, createBash: () => bash.definition });
	// pi 会先发 tool_call；嵌套调用带 parentToolCallId
	handlers.get("tool_call")!({ type: "tool_call", toolCallId: "call-1", parentToolCallId: "parent-1" }, {});
	const pending = tools.get("bash").execute("call-1", { command: "sleep 600" }, undefined, undefined, {});
	const raced = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve("waiting"), 150))]);
	assert.equal(raced, "waiting", "嵌套调用应该一直等");
	bash.finish("script output");
	assert.equal((await pending).content[0].text, "script output");
});

test("显式 timeout 照样晋升，timeout 继续作用在后台任务上", async () => {
	const bash = hangingBash();
	const { tools } = setup({ promoteAfterSeconds: 0.05, createBash: () => bash.definition });
	const result = await tools.get("bash").execute("call-1", { command: "true", timeout: 600 }, undefined, undefined, {});
	assert.match(result.content[0].text, /^bash promoted to bg_job /);
	bash.finish("ok");
});

test("前台 codemode 到点晋升：活动信号来自嵌套调用快照", async () => {
	let settle!: (value: any) => void;
	const pending = new Promise<any>((resolve) => {
		settle = resolve;
	});
	const definition = {
		name: "codemode",
		label: "Codemode",
		description: "",
		parameters: {},
		execute: async (_id: string, _params: any, _signal: AbortSignal, onUpdate: any) => {
			onUpdate?.({ content: [], details: { calls: [] } });
			onUpdate?.({ content: [], details: { calls: [{ name: "bash", args: "npm test", status: "running" }] } });
			return pending;
		},
	} as unknown as ToolDefinition;
	const { tools, sent } = setup({ promoteAfterSeconds: 0.05, codemode: definition });
	const result = await tools.get("codemode").execute("call-1", { code: "return 42" }, undefined, undefined, {});
	const id = result.details.promoted as string;
	assert.match(result.content[0].text, /^codemode promoted to bg_job [0-9a-f]{8} after /);
	assert.match(result.content[0].text, /1 call so far, current: bash \(/);

	const shown = await tools.get("bg_job").execute("call-2", { action: "show", id }, undefined);
	assert.match(shown.content[0].text, new RegExp(`^bg_job ${id} — codemode · running · `));
	assert.match(shown.content[0].text, /script: return 42/);
	assert.match(shown.content[0].text, /\(no output yet\)/);

	settle({ content: [{ type: "text", text: "Script completed\n42" }], details: { calls: [] } });
	await until(() => sent.length === 1);
	assert.match(sent[0]!.message.content, new RegExp(`^\\[bg_job ${id}\\] codemode · return 42 — done · `));
});

test("晋升不受并发上限限制", async () => {
	const bash = hangingBash();
	const { tools } = setup({ promoteAfterSeconds: 0.05, createBash: () => bash.definition });
	const ctx = { executeTool: () => new Promise(() => {}) };
	for (let index = 0; index < 64; index += 1) {
		await tools.get("bash_bg").execute(`call-${index}`, { command: `cmd-${index}` }, undefined, undefined, ctx);
	}
	const refused = await tools.get("bash_bg").execute("call-65", { command: "cmd-65" }, undefined, undefined, ctx);
	assert.match(refused.content[0].text, /^Error: too many background jobs \(max 64\)/);

	const promoted = await tools.get("bash").execute("call-p", { command: "npm test" }, undefined, undefined, {});
	assert.match(promoted.content[0].text, /^bash promoted to bg_job /);
	bash.finish("done");
});

test("promoteAfterSeconds 为 0 时不注册覆盖版", () => {
	const { tools } = setup({ promoteAfterSeconds: 0 });
	assert.equal(tools.has("bash"), false, "关闭时连 bash 都不该被覆盖");
	assert.equal(tools.has("bash_bg"), true);
});

test("bg_job show：未知 id 与缺少 id 都报错", async () => {
	const { tools } = setup();
	assert.equal(
		(await tools.get("bg_job").execute("call-1", { action: "show", id: "zzzzzzzz" }, undefined)).content[0].text,
		"Error: no background job with id 'zzzzzzzz'.",
	);
	assert.equal(
		(await tools.get("bg_job").execute("call-2", { action: "show" }, undefined)).content[0].text,
		"Error: id is required for show.",
	);
});

test("bg_job kill 对已结束的任务报退出码与耗时", async () => {
	const { tools } = setup();
	const ctx = { executeTool: async (name: string) => outcome(name, "ok", { exit_code: 0 }) };
	const started = await tools.get("bash_bg").execute("call-1", { command: "true" }, undefined, undefined, ctx);
	const id = started.details.jobs[0].id;
	await new Promise((resolve) => setTimeout(resolve, 20));
	const killed = await tools.get("bg_job").execute("call-2", { action: "kill", id }, undefined);
	assert.match(killed.content[0].text, new RegExp(`^bg_job ${id} already finished with exit 0 in [0-9.]+s\\.$`));
});

test("金样：覆盖目标的 schema 与 outputSchema 仍与内置 bash 一致", async () => {
	const { createBashToolDefinition } = await import("@earendil-works/pi-coding-agent");
	const definition = createBashToolDefinition(process.cwd());
	// pi 升级改了 bash 的构造（参数、结构化输出）时，这条会立刻炸出来（ADR-0010）
	assert.deepEqual(Object.keys((definition.parameters as any).properties).sort(), ["command", "timeout"]);
	assert.deepEqual(Object.keys((definition.outputSchema as any).properties).sort(), [
		"exit_code",
		"full_output_path",
		"output",
		"truncated",
		"wall_time_seconds",
	]);
});

test("长命令用后台工具的规则随预算走，关闭时退回默认 5 分钟；两条都禁止 sleep 等结果", () => {
	const off = setup({ promoteAfterSeconds: 0 });
	assert.deepEqual(off.tools.get("bash_bg").promptGuidelines, [
		"Use bash_bg for commands that may take over 5 minutes, unless their result blocks the next step.",
		"Do not sleep to wait for a bash_bg job; its output arrives as a message when it finishes.",
	]);
	assert.deepEqual(off.tools.get("codemode_bg").promptGuidelines, [
		"Use codemode_bg for scripts that may take over 5 minutes, unless their result blocks the next step.",
		"Do not sleep to wait for a codemode_bg job; its result arrives as a message when it finishes.",
	]);

	const on = setup({ promoteAfterSeconds: 90 });
	assert.deepEqual(on.tools.get("bash_bg").promptGuidelines, [
		"Use bash_bg for commands that may take over 90 seconds, unless their result blocks the next step.",
		"Do not sleep to wait for a bash_bg job; its output arrives as a message when it finishes.",
	]);
});

test("running background jobs register as process activity", async () => {
	const { tools } = setup();
	// 永不结束的委托：任务会一直停在 running。
	const ctx = { executeTool: () => new Promise(() => undefined) };

	const started = await tools.get("bash_bg")!.execute("call-1", { command: "sleep 60" }, undefined, undefined, ctx);
	const id = started.details.jobs[0].id;
	assert.equal(hasBusyActivity(), true);

	await tools.get("bg_job")!.execute("call-2", { action: "kill", id }, undefined, undefined, ctx);
	assert.equal(hasBusyActivity(), false);
});
