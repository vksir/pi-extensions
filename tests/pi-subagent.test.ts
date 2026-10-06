import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { closeResultServers } from "../extensions/pi-subagent/ipc.ts";
import {
	argValue,
	calls,
	childEnv,
	definitionFile as harnessDefinitionFile,
	dispatch,
	fakeHerdr,
	type FakeHerdr,
	makeCtx,
	piArgs,
	RUNTIME_KEY,
	setup as setupHarness,
	type Tool,
} from "./pi-subagent-harness.ts";


// 在加载扩展前隔离 agent dir，不读写用户真实 agent 目录。
const agentDir = mkdtempSync(join(tmpdir(), "pi-subagent-test-"));
const previous = {
	agentDir: process.env.PI_CODING_AGENT_DIR,
	herdrEnv: process.env.HERDR_ENV,
	workspace: process.env.HERDR_WORKSPACE_ID,
};
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HERDR_ENV = "1";
process.env.HERDR_WORKSPACE_ID = "w1";
after(() => {
	const restore = (key: string, value: string | undefined) => {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};
	restore("PI_CODING_AGENT_DIR", previous.agentDir);
	restore("HERDR_ENV", previous.herdrEnv);
	restore("HERDR_WORKSPACE_ID", previous.workspace);
	rmSync(agentDir, { recursive: true, force: true });
});

const { default: factory } = await import("../extensions/pi-subagent/index.ts");

const setup = () => setupHarness(factory);
const define = (name: string, frontmatter: string, body: string) =>
	harnessDefinitionFile(agentDir, name, frontmatter, body);

beforeEach(() => {
	closeResultServers();
	delete (globalThis as unknown as Record<symbol, unknown>)[RUNTIME_KEY];
	rmSync(join(agentDir, "agents"), { recursive: true, force: true });
});

// ─── 注册与会话定位 ───

test("注册 agent 工具，参数为 type / name / prompt", () => {
	const app = setup();
	const tool = app.tools.get("agent");
	assert.ok(tool);
	assert.deepEqual(Object.keys(tool.parameters.properties ?? {}).sort(), ["name", "prompt", "type"]);
});

test("主会话没有持久 session 文件时拒绝派发，不启动任何进程", async () => {
	define("worker.md", "name: worker\ndescription: does work", "You are a worker.");
	const app = setup();
	const fake = fakeHerdr();
	const result = await dispatch(app, makeCtx(fake, { sessionFile: undefined }), { type: "worker", name: "w1", prompt: "go" });
	assert.match(result.text, /^Error: .*session file/i);
	assert.equal(fake.calls.length, 0);
});

test("Herdr 不可用时报错，不启动任何进程", async () => {
	define("worker.md", "name: worker", "You are a worker.");
	delete process.env.HERDR_ENV;
	try {
		const app = setup();
		const fake = fakeHerdr();
		const result = await dispatch(app, makeCtx(fake), { type: "worker", name: "w1", prompt: "go" });
		assert.match(result.text, /^Error: .*Herdr/i);
		assert.equal(fake.calls.length, 0);
	} finally {
		process.env.HERDR_ENV = "1";
	}
});

// ─── 派发：新实例 ───

test("新实例：Herdr 新建标签页、按主 cwd 启动 Pi、提交 prompt，并在提交后返回", async () => {
	define("reviewer.md", "name: code-review\ndescription: reviews diffs", "You review code changes.");
	const app = setup();
	const fake = fakeHerdr();
	const result = await dispatch(app, makeCtx(fake), { type: "code-review", name: "reviewer-1", prompt: "Review the diff." });

	const create = calls(fake, "tab", "create")[0];
	assert.ok(create, "必须创建标签页");
	assert.equal(argValue(create.args, "--cwd"), "D:/work/project");
	assert.equal(argValue(create.args, "--label"), "reviewer-1");
	assert.equal(argValue(create.args, "--workspace"), "w1");
	assert.ok(create.args.includes("--no-focus"), "后台工作不抢焦点");

	const start = calls(fake, "agent", "start")[0];
	assert.ok(start);
	assert.match(start.args[2], /^[a-z][a-z0-9_-]{0,31}$/, "Herdr agent 名必须满足 Herdr 命名约束");
	assert.equal(argValue(start.args, "--kind"), "pi");
	assert.equal(argValue(start.args, "--pane"), "w1:p1");

	const args = piArgs(fake);
	assert.ok(args.includes("-ne"), "子 Agent 不加载被发现的扩展（不开放嵌套委派）");
	assert.equal(argValue(args, "--name"), "reviewer-1");
	assert.equal(argValue(args, "--system-prompt"), "You review code changes.");
	const sessionDir = argValue(args, "--session-dir");
	const childSessionId = argValue(args, "--session-id");
	const sessionRoot = join(agentDir, "pi-subagent", "sessions");
	assert.ok(sessionDir && (sessionDir.startsWith(sessionRoot + "\\") || sessionDir.startsWith(sessionRoot + "/")), sessionDir ?? "(missing session dir)");
	assert.ok(existsSync(sessionDir!), "子 session 目录必须已创建");
	assert.match(childSessionId ?? "", /^[a-z][a-z0-9._-]*$/);

	const prompt = calls(fake, "agent", "prompt")[0];
	assert.ok(prompt, "必须提交 prompt");
	assert.equal(prompt.args[2], "w1:p1", "按 pane ID 提交，不用显示名");
	assert.equal(prompt.args[3], "Review the diff.");
	assert.ok(!prompt.args.includes("--wait"), "提交不等待子 Agent 工作轮次");

	assert.match(result.text, /reviewer-1/);
	assert.match(result.text, /code-review/);
	assert.match(result.text, /has not finished/i);
	assert.equal(result.details.action, "started");
	assert.equal(result.details.paneId, "w1:p1");
});

test("缺省类型名取文件名，frontmatter name 覆盖文件名", async () => {
	define("plain.md", "description: no name field", "PLAIN BODY");
	define("named.md", "name: custom-type", "NAMED BODY");
	const app = setup();
	const fake = fakeHerdr();

	await dispatch(app, makeCtx(fake), { type: "plain", name: "a", prompt: "p" });
	assert.equal(argValue(piArgs(fake), "--system-prompt"), "PLAIN BODY");

	const before = fake.calls.length;
	await dispatch(app, makeCtx(fake), { type: "custom-type", name: "b", prompt: "p" });
	assert.ok(fake.calls.length > before, "frontmatter name 必须可选到定义");
	assert.equal(argValue(piArgs(fake), "--system-prompt"), "NAMED BODY");
});

test("未知类型报错并列出可用类型，不启动任何进程", async () => {
	define("alpha.md", "name: alpha", "A");
	define("beta.md", "name: beta", "B");
	const app = setup();
	const fake = fakeHerdr();
	const result = await dispatch(app, makeCtx(fake), { type: "gamma", name: "g", prompt: "p" });
	assert.match(result.text, /^Error: unknown agent type "gamma"/);
	assert.match(result.text, /alpha/);
	assert.match(result.text, /beta/);
	assert.equal(fake.calls.length, 0);
});

// ─── 派发：复用运行实例 ───

test("同名再次派发复用原 pane：不新建标签页、不重复启动 Pi", async () => {
	define("worker.md", "name: worker", "You are a worker.");
	const app = setup();
	const fake = fakeHerdr();
	const ctx = makeCtx(fake);

	await dispatch(app, ctx, { type: "worker", name: "w1", prompt: "first" });
	const second = await dispatch(app, ctx, { type: "worker", name: "w1", prompt: "second" });

	assert.equal(calls(fake, "tab", "create").length, 1);
	assert.equal(calls(fake, "agent", "start").length, 1);
	const prompts = calls(fake, "agent", "prompt");
	assert.equal(prompts.length, 2);
	assert.equal(prompts[1].args[2], "w1:p1");
	assert.equal(prompts[1].args[3], "second");
	assert.equal(second.details.action, "submitted");
	assert.match(second.text, /has not finished/i);
});

test("同名不同类型派发报错，不悄悄切换现有实例的角色", async () => {
	define("worker.md", "name: worker", "W");
	define("other.md", "name: other", "O");
	const app = setup();
	const fake = fakeHerdr();
	const ctx = makeCtx(fake);

	await dispatch(app, ctx, { type: "worker", name: "w1", prompt: "first" });
	const result = await dispatch(app, ctx, { type: "other", name: "w1", prompt: "second" });

	assert.match(result.text, /^Error: .*already bound to type "worker"/);
	assert.equal(calls(fake, "agent", "prompt").length, 1, "类型冲突不提交 prompt");
	assert.equal(calls(fake, "tab", "create").length, 1);
});

test("并行同名派发只创建一个逻辑实例，两次 prompt 都提交到同一 pane", async () => {
	define("worker.md", "name: worker", "W");
	const app = setup();
	const fake = fakeHerdr();
	const ctx = makeCtx(fake);

	await Promise.all([
		dispatch(app, ctx, { type: "worker", name: "w1", prompt: "first" }),
		dispatch(app, ctx, { type: "worker", name: "w1", prompt: "second" }),
	]);

	assert.equal(calls(fake, "tab", "create").length, 1);
	assert.equal(calls(fake, "agent", "start").length, 1);
	const prompts = calls(fake, "agent", "prompt");
	assert.equal(prompts.length, 2);
	assert.ok(prompts.every((call) => call.args[2] === "w1:p1"));
});

// ─── 稳定身份 ───

test("子 session 定位由主会话身份与实例名确定，跨会话隔离", async () => {
	define("worker.md", "name: worker", "W");
	const app = setup();
	const fakeA = fakeHerdr();
	const fakeB = fakeHerdr();

	await dispatch(app, makeCtx(fakeA, { sessionId: "s1", sessionFile: "D:/sessions/a.jsonl" }), { type: "worker", name: "w1", prompt: "p" });
	delete (globalThis as unknown as Record<symbol, unknown>)[RUNTIME_KEY];
	await dispatch(app, makeCtx(fakeA, { sessionId: "s1", sessionFile: "D:/sessions/a.jsonl" }), { type: "worker", name: "w1", prompt: "p" });
	await dispatch(app, makeCtx(fakeB, { sessionId: "s1", sessionFile: "D:/sessions/b.jsonl" }), { type: "worker", name: "w1", prompt: "p" });

	const [first, second, third] = [piArgs(fakeA), piArgs(fakeA), piArgs(fakeB)];
	assert.equal(argValue(second, "--session-id"), argValue(first, "--session-id"), "同一主会话同名实例必须落在同一 session");
	assert.equal(argValue(second, "--session-dir"), argValue(first, "--session-dir"));
	assert.notEqual(argValue(third, "--session-id"), argValue(first, "--session-id"), "不同主会话必须互相隔离");
	assert.notEqual(argValue(third, "--session-dir"), argValue(first, "--session-dir"));
});

test("Herdr agent 名始终满足 Herdr 命名约束，且跨主会话不冲突", async () => {
	define("worker.md", "name: worker", "W");
	const app = setup();
	const fakeA = fakeHerdr();
	const fakeB = fakeHerdr();
	const long = "a-very-long-ünïcode-instance-name-with-more-than-32-characters";

	await dispatch(app, makeCtx(fakeA, { sessionFile: "D:/sessions/a.jsonl" }), { type: "worker", name: long, prompt: "p" });
	await dispatch(app, makeCtx(fakeB, { sessionFile: "D:/sessions/b.jsonl" }), { type: "worker", name: long, prompt: "p" });

	const nameA = calls(fakeA, "agent", "start")[0].args[2];
	const nameB = calls(fakeB, "agent", "start")[0].args[2];
	assert.match(nameA, /^[a-z][a-z0-9_-]{0,31}$/);
	assert.match(nameB, /^[a-z][a-z0-9_-]{0,31}$/);
	assert.notEqual(nameA, nameB, "不同主会话的同名实例不能在 Herdr 显示名上互相占用");
});

test("运行位置挂在进程级载体上，重新导入模块后仍复用同一 pane", async () => {
	define("worker.md", "name: worker", "W");
	const first = setup();
	const fake = fakeHerdr();
	await dispatch(first, makeCtx(fake), { type: "worker", name: "w1", prompt: "first" });

	// 模拟 /reload：模块被重新导入，factory 内的一切局部状态归零。
	const spec = `../extensions/pi-subagent/index.ts?reload=${Date.now()}`;
	const reloaded = (await import(spec)) as { default: (pi: ExtensionAPI) => void };
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const tools = new Map<string, Tool>();
	reloaded.default({
		on: (event: string, handler: (event: any, ctx: any) => unknown) => handlers.set(event, handler),
		registerTool: (definition: Tool) => tools.set(definition.name, definition),
		exec: (command: string, args: string[]) => fake.exec(command, args),
	} as unknown as ExtensionAPI);

	const result = await dispatch({ handlers, tools, sent: [] }, makeCtx(fake), { type: "worker", name: "w1", prompt: "second" });
	assert.equal(calls(fake, "tab", "create").length, 1, "reload 后不得重复创建实例");
	assert.equal(calls(fake, "agent", "prompt").length, 2);
	assert.equal(result.details.action, "submitted");
});

// ─── 失败路径 ───

test("启动失败只报错，关闭半成品标签页，且不登记运行位置", async () => {
	define("worker.md", "name: worker", "W");
	const app = setup();
	const fake = fakeHerdr();
	fake.startFails = "agent_not_found";

	const failed = await dispatch(app, makeCtx(fake), { type: "worker", name: "w1", prompt: "p" });
	assert.match(failed.text, /^Error: could not start subagent "w1"/);
	assert.match(failed.text, /agent_not_found/);
	assert.equal(calls(fake, "tab", "close").length, 1, "启动失败要关闭刚创建的标签页");

	fake.startFails = undefined;
	await dispatch(app, makeCtx(fake), { type: "worker", name: "w1", prompt: "p" });
	assert.equal(calls(fake, "tab", "create").length, 2, "上次失败不得登记为可复用实例");
});

test("提交失败时报错，但实例仍被登记，同名派发不再重复启动", async () => {
	define("worker.md", "name: worker", "W");
	const app = setup();
	const fake = fakeHerdr();
	fake.promptFails = "agent_blocked";

	const failed = await dispatch(app, makeCtx(fake), { type: "worker", name: "w1", prompt: "p" });
	assert.match(failed.text, /^Error: started subagent "w1"/);
	assert.match(failed.text, /agent_blocked/);

	fake.promptFails = undefined;
	const retried = await dispatch(app, makeCtx(fake), { type: "worker", name: "w1", prompt: "p2" });
	assert.equal(calls(fake, "tab", "create").length, 1);
	assert.equal(retried.details.action, "submitted");
});

test("Herdr 返回非 JSON 与结构缺失时给出明确错误", async () => {
	define("worker.md", "name: worker", "W");
	const app = setup();
	const broken: FakeHerdr = {
		...fakeHerdr(),
		exec: async (command, args) => {
			void command;
			void args;
			return { stdout: "not json", stderr: "", code: 0, killed: false };
		},
	};
	const result = await dispatch(app, makeCtx(broken), { type: "worker", name: "w1", prompt: "p" });
	assert.match(result.text, /^Error: could not start subagent "w1"/);
	assert.match(result.text, /non-JSON/);
});
