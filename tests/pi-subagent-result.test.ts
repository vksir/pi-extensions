import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { closeResultServers } from "../extensions/pi-subagent/ipc.ts";
import {
	childEnv,
	definitionFile,
	dispatch,
	fakeHerdr,
	makeCtx,
	piArgs,
	RUNTIME_KEY,
	setup,
	setupBridge,
	waitFor,
} from "./pi-subagent-harness.ts";

// 在加载扩展前隔离 agent dir，不读写用户真实 agent 目录。
const agentDir = mkdtempSync(join(tmpdir(), "pi-subagent-result-test-"));
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

const EMPTY = {
	type: "agent_end",
	messages: [{ role: "assistant", content: [{ type: "text", text: "" }] }],
};

/** 派发一个新实例，返回它实际告诉子进程的身份与端点。 */
async function startInstance(params = { type: "worker", name: "reviewer-1", prompt: "Do the work." }) {
	definitionFile(agentDir, "worker.md", "name: worker", "You are a worker.");
	const app = setup(parentFactory);
	const fake = fakeHerdr();
	// 与另一个测试文件区分主会话，避免并行测试争用同一个命名管道。
	const ctx = makeCtx(fake, { sessionId: "result-session", sessionFile: "D:/sessions/result.jsonl" });
	app.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
	const result = await dispatch(app, ctx, params);
	return { app, fake, ctx, result, env: childEnv(fake) };
}

function bridge(env: Record<string, string>, options: { entries?: unknown[] } = {}) {
	return setupBridge(bridgeFactory, env, options);
}

/** 工作轮次：一次 agent_end + before_settle + settled。 */
function completeRound(child: ReturnType<typeof bridge>, text: string, outcome = "completed") {
	child.fire("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text }] }] });
	child.fire("agent_before_settle", { type: "agent_before_settle", outcome });
	child.fire("agent_settled", { type: "agent_settled" });
}

function sendRaw(pipe: string, payload: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = connect(pipe);
		socket.on("error", reject);
		socket.on("connect", () => socket.end(payload));
		socket.on("close", () => resolve());
	});
}

beforeEach(() => {
	closeResultServers();
	delete (globalThis as unknown as Record<symbol, unknown>)[RUNTIME_KEY];
	rmSync(join(agentDir, "agents"), { recursive: true, force: true });
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
	}
});

// ─── 启动桥接 ───

test("子进程只加载桥接扩展，并拿到实例身份与结果端点", async () => {
	const { fake, env } = await startInstance();
	const args = piArgs(fake);
	assert.ok(args.includes("-ne"), "不加载被发现的扩展");
	assert.equal(args[args.indexOf("-e") + 1]?.replace(/\\/g, "/").endsWith("extensions/pi-subagent/bridge.ts"), true);
	assert.equal(env.PI_SUBAGENT_NAME, "reviewer-1");
	assert.equal(env.PI_SUBAGENT_TYPE, "worker");
	assert.match(env.PI_SUBAGENT_OWNER_KEY ?? "", /^[0-9a-f]{32}$/);
	assert.ok((env.PI_SUBAGENT_PIPE ?? "").length > 0, "必须把结果端点交给子进程");
});

test("桥接不注册任何模型可见的工具（不开放嵌套委派）", async () => {
	const { env } = await startInstance();
	const child = bridge(env);
	assert.equal(child.tools.size, 0);
});

// ─── 结果回传 ───

test("工作轮次结束后结果经 IPC 作为 follow-up 进入主会话", async () => {
	const { app, env } = await startInstance();
	const child = bridge(env);
	child.fire("session_start");
	completeRound(child, "Review complete: 2 findings.");

	await waitFor(() => app.sent.length === 1);
	const message = String(app.sent[0]?.content);
	assert.match(message, /^\[subagent result\] instance="reviewer-1" type="worker" round=1 status=completed session=sb-child-session /);
	assert.match(message, /file="D:\/sessions\/child\.jsonl"/);
	assert.ok(message.endsWith("\n\nReview complete: 2 findings."), message.slice(0, 200));
	assert.deepEqual(app.sent[0]?.options, { deliverAs: "followUp" }, "绝不 steer 打断主 Agent");
});

test("只有 agent_end 时不同步回传，等到真正结束才回传", async () => {
	const { app, env } = await startInstance();
	const child = bridge(env);
	child.fire("session_start");
	child.fire("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "half done" }] }] });
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(app.sent.length, 0, "低层运行结束不是工作轮次结束");

	child.fire("agent_settled", { type: "agent_settled" });
	await waitFor(() => app.sent.length === 1);
	assert.match(String(app.sent[0]?.content), /half done$/);
});

test("没有工作轮次内容的 settled 不回传空结果", async () => {
	const { app, env } = await startInstance();
	const child = bridge(env);
	child.fire("session_start");
	child.fire("agent_settled", { type: "agent_settled" });
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(app.sent.length, 0);
});

test("远超 50KB 的多行多字节回复逐字完整回传", async () => {
	const { app, env } = await startInstance();
	const child = bridge(env);
	const lines = Array.from({ length: 3000 }, (_, index) => `第 ${index} 行：你好，world-${index} ✅`);
	const reply = lines.join("\n");
	assert.ok(Buffer.byteLength(reply, "utf8") > 50 * 1024, "必须超过 50KB");

	child.fire("session_start");
	completeRound(child, reply);
	await waitFor(() => app.sent.length === 1);

	const expected =
		'[subagent result] instance="reviewer-1" type="worker" round=1 status=completed session=sb-child-session file="D:/sessions/child.jsonl"\n\n' +
		reply;
	assert.equal(app.sent[0]?.content, expected, "完整正文必须逐字一致");
});

test("轮次编号递增并落在子 session 中", async () => {
	const { app, env } = await startInstance();
	const child = bridge(env);
	child.fire("session_start");
	completeRound(child, "first");
	await waitFor(() => app.sent.length === 1);
	completeRound(child, "second");
	await waitFor(() => app.sent.length === 2);

	assert.match(String(app.sent[0]?.content), /round=1 /);
	assert.match(String(app.sent[1]?.content), /round=2 /);
	assert.deepEqual(
		child.entries.map((entry) => entry.customType),
		["pi-subagent-round", "pi-subagent-round"],
	);
});

test("续聊的旧 session 已有轮次时从中继续编号", async () => {
	const { app, env } = await startInstance();
	const existing = [
		{ type: "custom", customType: "pi-subagent-round", data: { round: 1 } },
		{ type: "custom", customType: "pi-subagent-round", data: { round: 2 } },
		{ type: "custom", customType: "unrelated", data: {} },
	];
	const child = bridge(env, { entries: existing });
	child.fire("session_start");
	completeRound(child, "third");
	await waitFor(() => app.sent.length === 1);
	assert.match(String(app.sent[0]?.content), /round=3 /, "轮次编号在子 session 中延续");
});

test("状态来自工作轮次结束时的真实结果", async () => {
	const { app, env } = await startInstance();
	const child = bridge(env);
	child.fire("session_start");
	completeRound(child, "", "aborted");
	await waitFor(() => app.sent.length === 1);
	assert.match(String(app.sent[0]?.content), /status=aborted/);
});

// ─── 隔离与失败路径 ───

test("旧主会话的迟到结果不会注入当前主会话", async () => {
	const { app, env } = await startInstance();
	await sendRaw(env.PI_SUBAGENT_PIPE, JSON.stringify({
		ownerKey: "ffffffffffffffffffffffffffffffff",
		name: "reviewer-1",
		type: "worker",
		round: 9,
		status: "completed",
		reply: "stale result",
		sessionId: "sb-stale",
		sessionFile: "D:/sessions/stale.jsonl",
	}) + "\n");
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(app.sent.length, 0);
});

test("畸形消息被忽略，不影响端点与后续结果", async () => {
	const { app, env } = await startInstance();
	await sendRaw(env.PI_SUBAGENT_PIPE, "not json\n");
	const child = bridge(env);
	child.fire("session_start");
	completeRound(child, "still works");
	await waitFor(() => app.sent.length === 1);
	assert.match(String(app.sent[0]?.content), /still works$/);
});

test("IPC 失败只在子进程报告错误，不重试、不抛出", async () => {
	const { env } = await startInstance();
	const broken = { ...env, PI_SUBAGENT_PIPE: process.platform === "win32" ? "\\\\.\\pipe\\pi-subagent-does-not-exist" : "/tmp/pi-subagent-does-not-exist.sock" };
	const child = bridge(broken);
	child.fire("session_start");
	completeRound(child, "any");
	await waitFor(() => child.notifications.length > 0);
	assert.equal(child.notifications[0]?.level, "error");
	assert.match(child.notifications[0]?.message ?? "", /could not deliver/);
	assert.equal(child.entries.length, 1, "轮次仍记录在子 session 中");
});

test("重复的 settled 不重复发送同一轮结果", async () => {
	const { app, env } = await startInstance();
	const child = bridge(env);
	child.fire("session_start");
	completeRound(child, "once");
	await waitFor(() => app.sent.length === 1);
	child.fire("agent_settled", { type: "agent_settled" });
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(app.sent.length, 1);
});
