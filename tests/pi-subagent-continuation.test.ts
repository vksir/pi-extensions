import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { closeResultServers } from "../extensions/pi-subagent/ipc.ts";
import {
	argValue,
	childEnv,
	definitionFile,
	dispatch,
	fakeHerdr,
	loseRuntime,
	makeCtx,
	piArgs,
	RUNTIME_KEY,
	setup,
	setupBridge,
} from "./pi-subagent-harness.ts";

// 在加载扩展前隔离 agent dir，不读写用户真实 agent 目录。
const agentDir = mkdtempSync(join(tmpdir(), "pi-subagent-continuation-"));
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
	closeResultServers();
	rmSync(agentDir, { recursive: true, force: true });
});

const { default: parentFactory } = await import("../extensions/pi-subagent/index.ts");
const { default: bridgeFactory } = await import("../extensions/pi-subagent/bridge.ts");

function startWorker(params = { type: "worker", name: "reviewer-1", prompt: "Do the work." }) {
	definitionFile(agentDir, "worker.md", "name: worker", "You are a worker.");
	definitionFile(agentDir, "other.md", "name: other", "You are something else.");
	const app = setup(parentFactory);
	const fake = fakeHerdr();
	const ctx = makeCtx(fake, { sessionId: "continuation-session", sessionFile: "D:/sessions/continuation.jsonl" });
	return { app, fake, ctx, run: (next = params) => dispatch(app, ctx, next) };
}

beforeEach(() => {
	closeResultServers();
	delete (globalThis as unknown as Record<symbol, unknown>)[RUNTIME_KEY];
	rmSync(join(agentDir, "agents"), { recursive: true, force: true });
	rmSync(join(agentDir, "pi-subagent"), { recursive: true, force: true });
});

// ─── 实例续聊 ───

test("运行资源丢失后同名派发恢复同一子 session，而不是新建对话", async () => {
	const worker = startWorker();
	await worker.run();
	const sessionDir = argValue(piArgs(worker.fake), "--session-dir");
	const childSessionId = argValue(piArgs(worker.fake), "--session-id");
	assert.ok(sessionDir && existsSync(sessionDir), "首次派发创建子 session 目录");

	// 资源释放：pane 关闭、父进程重启后运行态定位消失，但 session 文件仍在。
	loseRuntime();
	worker.fake.savedType = "worker";
	const result = await worker.run({ type: "worker", name: "reviewer-1", prompt: "Continue the work." });

	assert.equal(argValue(piArgs(worker.fake), "--session-dir"), sessionDir);
	assert.equal(argValue(piArgs(worker.fake), "--session-id"), childSessionId);
	assert.equal(result.details.action, "started", "资源已释放，必须重新拉起实例");
	assert.equal((worker.fake.calls.filter((call) => call.args[0] === "tab" && call.args[1] === "create")).length, 2);
	assert.ok(existsSync(sessionDir), "恢复运行不删除已有子 session 目录");
	assert.equal(result.details.childSessionId, childSessionId);
});

test("已保存实例的类型绑定不一致时明确报错，不提交 prompt 也不复用旧角色", async () => {
	const worker = startWorker();
	await worker.run();
	loseRuntime();
	// 子 session 里保存的是 worker 角色的绑定。
	worker.fake.savedType = "worker";

	const result = await worker.run({ type: "other", name: "reviewer-1", prompt: "Do something else." });

	assert.match(result.text, /^Error: could not start subagent "reviewer-1" \(type "other"\)/);
	assert.match(result.text, /bound to type "worker"/);
	assert.equal(
		worker.fake.calls.filter((call) => call.args[0] === "agent" && call.args[1] === "prompt").length,
		1,
		"类型冲突不得提交本次 prompt",
	);
	assert.equal(
		worker.fake.calls.filter((call) => call.args[0] === "tab" && call.args[1] === "close").length,
		1,
		"类型冲突要关闭刚拉起的标签页",
	);
});

test("已保存绑定与本次派发一致时可以继续工作", async () => {
	const worker = startWorker();
	await worker.run();
	loseRuntime();
	worker.fake.savedType = "worker";

	const result = await worker.run({ type: "worker", name: "reviewer-1", prompt: "Second round." });
	assert.equal(result.details.action, "started");
	assert.equal(
		worker.fake.calls.filter((call) => call.args[0] === "agent" && call.args[1] === "prompt").length,
		2,
		"绑定一致时照常提交 prompt",
	);
});

// ─── 绑定落盘 ───

test("首次启动即把实例绑定写进子 session，已有绑定不重复写", async () => {
	const worker = startWorker();
	await worker.run();
	const env = childEnv(worker.fake);

	const fresh = setupBridge(bridgeFactory, env, { entries: [] });
	fresh.fire("session_start");
	assert.deepEqual(fresh.entries, [
		{
			customType: "pi-subagent-binding",
			data: { ownerKey: env.PI_SUBAGENT_OWNER_KEY, name: "reviewer-1", type: "worker" },
		},
	]);

	const existing = setupBridge(bridgeFactory, env, {
		entries: [
			{
				type: "custom",
				customType: "pi-subagent-binding",
				data: { ownerKey: env.PI_SUBAGENT_OWNER_KEY, name: "reviewer-1", type: "worker" },
			},
		],
	});
	existing.fire("session_start");
	assert.equal(existing.entries.length, 0, "已有绑定时不重复写入");
});

test("绑定与轮次只落在 custom entry 中，不写入模型上下文", async () => {
	const worker = startWorker();
	await worker.run();
	const child = setupBridge(bridgeFactory, childEnv(worker.fake), { entries: [] });
	child.fire("session_start");
	child.fire("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
	child.fire("agent_before_settle", { type: "agent_before_settle", outcome: "completed" });
	child.fire("agent_settled", { type: "agent_settled" });

	// 桥接进程只提供 on / registerTool / appendEntry；若写入模型上下文会直接抛错。
	assert.deepEqual(
		child.entries.map((entry) => entry.customType),
		["pi-subagent-binding", "pi-subagent-round"],
	);
});

test("不引入额外索引文件或数据库", async () => {
	const worker = startWorker();
	await worker.run();

	const root = join(agentDir, "pi-subagent");
	assert.deepEqual(readdirSync(root), ["sessions"], "只应有子 session 存储目录");
	const owners = readdirSync(join(root, "sessions"));
	assert.equal(owners.length, 1, "一个主会话一个命名空间目录");
});
