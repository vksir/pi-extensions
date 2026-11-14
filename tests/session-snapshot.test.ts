import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { retainToTurnBoundary, snapshotAtTurnBoundary } from "../extensions/lib/session-snapshot.ts";

const T = "2026-01-01T00:00:00.000Z";

type Entry = Record<string, unknown>;

function header(): Entry {
	return { type: "session", version: 3, id: "sess-1", timestamp: T, cwd: "/work" };
}

function base(type: string, id: string, parentId: string | null, extra: Entry = {}): Entry {
	return { type, id, parentId, timestamp: T, ...extra };
}

function user(id: string, parentId: string | null, text = "问题"): Entry {
	return base("message", id, parentId, { message: { role: "user", content: text, timestamp: 0 } });
}

function assistant(id: string, parentId: string | null, text = "答"): Entry {
	return base("message", id, parentId, {
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "test",
			provider: "test",
			model: "test",
			usage: {},
			stopReason: "stop",
			timestamp: 0,
		},
	});
}

function toolCall(id: string, parentId: string | null, callId: string): Entry {
	return base("message", id, parentId, {
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "bash", arguments: {} }],
			api: "test",
			provider: "test",
			model: "test",
			usage: {},
			stopReason: "toolUse",
			timestamp: 0,
		},
	});
}

function toolResult(id: string, parentId: string | null, callId: string): Entry {
	return base("message", id, parentId, {
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName: "bash",
			content: [{ type: "text", text: "输出" }],
			isError: false,
			timestamp: 0,
		},
	});
}

function label(id: string, parentId: string | null, targetId: string): Entry {
	return base("label", id, parentId, { targetId, label: "checkpoint" });
}

/** 建一个独立临时目录并写入会话文件，返回文件路径与目录。 */
function writeSession(entries: Entry[], tail = ""): { file: string; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-btw-snapshot-test-"));
	const file = join(dir, "session.jsonl");
	writeFileSync(file, entries.map((e) => `${JSON.stringify(e)}\n`).join("") + tail, "utf-8");
	return { file, dir };
}

function readEntries(file: string): Entry[] {
	return readFileSync(file, "utf-8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Entry);
}

// ─── 边界判定（纯函数） ───

test("末尾是完整 assistant（无工具调用）：整条链原样保留", () => {
	const entries = [header(), user("u1", null), assistant("a1", "u1")];
	assert.deepEqual(retainToTurnBoundary(entries), entries);
});

test("流式生成中：丢掉本轮 user 与半截 assistant，回到上一轮收尾", () => {
	const entries = [header(), user("u1", null), assistant("a1", "u1"), user("u2", "a1")];
	assert.deepEqual(retainToTurnBoundary(entries), [header(), user("u1", null), assistant("a1", "u1")]);
});

test("工具执行中：悬空 toolCall 与本轮 user 一起丢掉", () => {
	const entries = [
		header(),
		user("u1", null),
		assistant("a1", "u1"),
		user("u2", "a1"),
		toolCall("a2", "u2", "c1"),
	];
	assert.deepEqual(retainToTurnBoundary(entries), [header(), user("u1", null), assistant("a1", "u1")]);
});

test("本轮内已有完整 toolResult：仍整轮丢掉（未收尾的 turn 不算边界）", () => {
	const entries = [
		header(),
		user("u1", null),
		assistant("a1", "u1"),
		user("u2", "a1"),
		toolCall("a2", "u2", "c1"),
		toolResult("r1", "a2", "c1"),
		toolCall("a3", "r1", "c2"),
	];
	assert.deepEqual(retainToTurnBoundary(entries), [header(), user("u1", null), assistant("a1", "u1")]);
});

test("turn 内插话（steering）：整轮丢掉，回到上一个收尾", () => {
	const entries = [
		header(),
		user("u1", null),
		assistant("a1", "u1"),
		user("u2", "a1"),
		toolCall("a2", "u2", "c1"),
		toolResult("r1", "a2", "c1"),
		user("u3", "r1"),
		toolCall("a3", "u3", "c2"),
	];
	assert.deepEqual(retainToTurnBoundary(entries), [header(), user("u1", null), assistant("a1", "u1")]);
});

test("第一轮就分派：没有可回退的边界，只剩 header", () => {
	const entries = [header(), user("u1", null), toolCall("a1", "u1", "c1")];
	assert.deepEqual(retainToTurnBoundary(entries), [header()]);
});

test("尾部非消息 entry（label）：一并丢掉，回到 assistant", () => {
	const entries = [header(), user("u1", null), assistant("a1", "u1"), label("l1", "a1", "u1")];
	assert.deepEqual(retainToTurnBoundary(entries), [header(), user("u1", null), assistant("a1", "u1")]);
});

test("兄弟分支不保留：只写当前叶子的前缀链", () => {
	const entries = [
		header(),
		user("u1", null),
		assistant("a1", "u1"),
		// 旁支（挂在 a1 上的另一条用户消息），最后叶子走 u2
		user("ux", "a1"),
		assistant("ax", "ux"),
		user("u2", "a1"),
	];
	assert.deepEqual(retainToTurnBoundary(entries), [header(), user("u1", null), assistant("a1", "u1")]);
});

// ─── 落盘 ───

test("完整边界：不写文件，返回 undefined", () => {
	const { file, dir } = writeSession([header(), user("u1", null), assistant("a1", "u1")]);
	const dirBefore = readFileSync(file, "utf-8");
	assert.equal(snapshotAtTurnBoundary(file, { dir: join(dir, "out") }), undefined);
	assert.equal(existsSync(join(dir, "out")), false, "不该创建输出目录");
	assert.equal(readFileSync(file, "utf-8"), dirBefore, "不该改动源文件");
});

test("截断：写出合法 JSONL，保留 header，原文件不动", () => {
	const { file, dir } = writeSession([header(), user("u1", null), assistant("a1", "u1"), user("u2", "a1")]);
	const before = readFileSync(file, "utf-8");
	const snapshot = snapshotAtTurnBoundary(file, { dir: join(dir, "out") });
	assert.ok(snapshot);
	assert.equal(snapshot.droppedEntries, 1);
	assert.notEqual(snapshot.file, file);
	assert.equal(readFileSync(file, "utf-8"), before);
	const written = readEntries(snapshot.file);
	assert.deepEqual(written, [header(), user("u1", null), assistant("a1", "u1")]);
	assert.equal(written[0]!.type, "session");
});

test("第一轮分派：快照只有 header，可被 pi --fork 接受", () => {
	const { file, dir } = writeSession([header(), user("u1", null)]);
	const snapshot = snapshotAtTurnBoundary(file, { dir: join(dir, "out") });
	assert.ok(snapshot);
	assert.deepEqual(readEntries(snapshot.file), [header()]);
});

test("半截 JSON 尾行：跳过坏行后照常截断", () => {
	const { file, dir } = writeSession(
		[header(), user("u1", null), assistant("a1", "u1"), user("u2", "a1")],
		'{"type":"message","id":"hal',
	);
	const snapshot = snapshotAtTurnBoundary(file, { dir: join(dir, "out") });
	assert.ok(snapshot);
	assert.deepEqual(readEntries(snapshot.file), [header(), user("u1", null), assistant("a1", "u1")]);
	assert.equal(snapshot.droppedEntries, 1);
});

test("多次快照文件名互不相同", () => {
	const { file, dir } = writeSession([header(), user("u1", null)]);
	const out = join(dir, "out");
	const first = snapshotAtTurnBoundary(file, { dir: out });
	const second = snapshotAtTurnBoundary(file, { dir: out });
	assert.ok(first && second);
	assert.notEqual(first.file, second.file);
});

test("输出目录不存在时自动创建", () => {
	const { file, dir } = writeSession([header(), user("u1", null)]);
	const out = join(dir, "nested", "out");
	const snapshot = snapshotAtTurnBoundary(file, { dir: out });
	assert.ok(snapshot);
	assert.ok(existsSync(snapshot.file));
});

test("源文件不存在：抛出可读错误，调用方负责提示", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-btw-snapshot-test-"));
	assert.throws(
		() => snapshotAtTurnBoundary(join(dir, "missing.jsonl"), { dir: join(dir, "out") }),
		(error: unknown) => error instanceof Error,
	);
});

test("空文件（尚无 header）：不写快照，交给 pi 自己报错", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-btw-snapshot-test-"));
	const file = join(dir, "empty.jsonl");
	writeFileSync(file, "", "utf-8");
	mkdirSync(join(dir, "out"));
	assert.equal(snapshotAtTurnBoundary(file, { dir: join(dir, "out") }), undefined);
});
