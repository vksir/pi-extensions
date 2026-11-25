import assert from "node:assert/strict";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHcClient, HcError, type HcTerminal, type HcWatchMessage } from "../extensions/lib/hc.ts";

// ─── 假 core：行模式 / framed 模式各一份 ───

const FRAME_HEADER = 9;
const FRAME_DATA = 0;
const FRAME_CREDIT = 1;
const FRAME_CLOSE = 2;

function encodeFrame(channel: number, kind: number, payload: Buffer): Buffer {
	const header = Buffer.allocUnsafe(FRAME_HEADER);
	header.writeUInt32LE(channel, 0);
	header[4] = kind;
	header.writeUInt32LE(payload.length, 5);
	return Buffer.concat([header, payload]);
}

function terminal(address: string, overrides: Partial<HcTerminal> = {}): HcTerminal {
	return {
		address,
		argv: [],
		cwd: "D:\\repo",
		name: address,
		labels: {},
		parent: null,
		state: "live",
		status: null,
		turn: 0,
		title: "",
		exit_code: null,
		reason: null,
		...overrides,
	};
}

interface Call {
	id: number;
	method: string;
	params: any;
	reply(result: unknown): void;
	fail(kind: string, message?: string): void;
	/** 往 framed 连接的某个 channel 推一行 JSON。 */
	push(channel: number, value: unknown): void;
	/** 原样写字节：用来把回复帧和事件帧放进同一个 chunk。 */
	pushRaw(bytes: Buffer): void;
}

class FakeCore {
	readonly path: string;
	readonly framed: boolean;
	/** 模拟旧 core：不认 `framed` 参数，直接回 invalid_params。 */
	rejectFramed = false;
	connections = 0;
	readonly calls: { id: number; method: string; params: any }[] = [];
	readonly frames: { channel: number; kind: number; payload: Buffer }[] = [];
	terminals: HcTerminal[] = [];
	onCall: (call: Call) => void = (call) => call.reply({});

	private readonly server: net.Server;
	private readonly sockets = new Set<net.Socket>();

	constructor(framed: boolean) {
		this.framed = framed;
		this.path =
			process.platform === "win32"
				? `\\\\.\\pipe\\pi-hc-test-${process.pid}-${Math.random().toString(16).slice(2)}`
				: join(tmpdir(), `pi-hc-test-${process.pid}-${Math.random().toString(16).slice(2)}.sock`);
		this.server = net.createServer((socket) => this.accept(socket));
	}

	async start(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.path, () => resolve());
		});
	}

	async stop(): Promise<void> {
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	/** 断开所有已建连接：模拟 core 重启 / 管道坏掉。 */
	dropConnections(): void {
		for (const socket of this.sockets) socket.destroy();
	}

	private accept(socket: net.Socket): void {
		this.connections += 1;
		this.sockets.add(socket);
		socket.on("close", () => this.sockets.delete(socket));

		let mode: "line" | "framed" = "line";
		let buffer: Buffer = Buffer.alloc(0);

		const write = (bytes: Buffer): void => {
			if (!socket.destroyed) socket.write(bytes);
		};
		const writeLine = (value: unknown): void => write(Buffer.from(`${JSON.stringify(value)}\n`));
		const writeFrame = (channel: number, kind: number, payload: Buffer): void =>
			write(encodeFrame(channel, kind, payload));
		const writeResult = (id: number, result: unknown): void => {
			const message = { jsonrpc: "2.0", id, result };
			if (mode === "framed") writeFrame(0, FRAME_DATA, Buffer.from(JSON.stringify(message)));
			else writeLine(message);
		};
		const makeCall = (id: number, method: string, params: any): Call => ({
			id,
			method,
			params,
			reply: (result) => writeResult(id, result),
			fail: (kind, message = kind) => {
				const payload = { jsonrpc: "2.0", id, error: { code: -32000, message, data: { kind } } };
				if (mode === "framed") writeFrame(0, FRAME_DATA, Buffer.from(JSON.stringify(payload)));
				else writeLine(payload);
			},
			push: (channel, value) =>
				writeFrame(channel, FRAME_DATA, Buffer.from(`${JSON.stringify(value)}\n`)),
			pushRaw: (bytes) => write(bytes),
		});
		const dispatch = (message: any): void => {
			this.calls.push({ id: message.id, method: message.method, params: message.params });
			this.onCall(makeCall(message.id, message.method, message.params));
		};

		const pump = (): void => {
			if (mode === "framed") {
				while (buffer.length >= FRAME_HEADER) {
					const channel = buffer.readUInt32LE(0);
					const kind = buffer[4]!;
					const length = buffer.readUInt32LE(5);
					if (buffer.length < FRAME_HEADER + length) return;
					const payload = buffer.subarray(FRAME_HEADER, FRAME_HEADER + length);
					buffer = buffer.subarray(FRAME_HEADER + length);
					this.frames.push({ channel, kind, payload });

					if (channel === 0 && kind === FRAME_DATA) dispatch(JSON.parse(payload.toString("utf8")));
				}
				return;
			}

			let newline = buffer.indexOf(0x0a);
			while (newline >= 0) {
				const line = buffer.subarray(0, newline).toString("utf8").trim();
				buffer = buffer.subarray(newline + 1);
				newline = buffer.indexOf(0x0a);
				if (!line) continue;

				const message = JSON.parse(line);
				if (message.method === "hello") {
					if (this.rejectFramed && message.params?.framed === true) {
						writeLine({
							jsonrpc: "2.0",
							id: message.id,
							error: { code: -32602, message: "invalid params", data: { kind: "invalid_params" } },
						});
						continue;
					}
					// 只有 framed 模式标注支持的 core 才真的切帧。
					const framed = this.framed && message.params?.framed === true;
					writeLine({
						jsonrpc: "2.0",
						id: message.id,
						result: {
							generation: 1,
							version: "test",
							core: { id: "core", name: "test" },
							framed,
							methods: [],
							features: framed ? ["framed", "events"] : [],
							keeps_running_after_logout: null,
						},
					});
					if (framed) {
						mode = "framed";
						pump();
						return;
					}
					continue;
				}
				dispatch(message);
			}
		};

		socket.on("data", (chunk: Buffer) => {
			buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk]) : chunk;
			pump();
		});
	}
}

async function waitFor(what: string, condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

// ─── 连接 ───

test("lazy connect, then every call rides the same connection", async () => {
	const core = new FakeCore(false);
	core.terminals = [terminal("t1")];
	core.onCall = (call) => call.reply(call.method === "terminal.get" ? core.terminals[0] : { terminals: core.terminals });
	await core.start();
	const hc = createHcClient(core.path);
	try {
		assert.equal(core.connections, 0, "the first call is what connects");

		assert.equal((await hc.list()).length, 1);
		await hc.list();
		await hc.get("t1");

		assert.equal(core.connections, 1);
		assert.deepEqual(
			core.calls.map((call) => call.method),
			["terminal.list", "terminal.list", "terminal.get"],
		);
	} finally {
		hc.close?.();
		await core.stop();
	}
});

test("calls are multiplexed: a slow list does not block a get", async () => {
	const core = new FakeCore(false);
	core.onCall = (call) => {
		const delay = call.method === "terminal.list" ? 40 : 0;
		setTimeout(() => call.reply(call.method === "terminal.list" ? { terminals: [] } : terminal("t1")), delay);
	};
	await core.start();
	const hc = createHcClient(core.path);
	try {
		const order: string[] = [];
		const list = hc.list().then(() => order.push("list"));
		const get = hc.get("t1").then(() => order.push("get"));
		await Promise.all([list, get]);
		assert.deepEqual(order, ["get", "list"]);
		assert.equal(core.connections, 1);
	} finally {
		hc.close?.();
		await core.stop();
	}
});

test("a dropped connection rejects in-flight calls and the next call reconnects", async () => {
	const core = new FakeCore(false);
	let dropped = false;
	core.onCall = (call) => {
		if (!dropped) {
			dropped = true;
			core.dropConnections();
			return;
		}
		call.reply({ terminals: [] });
	};
	await core.start();
	const hc = createHcClient(core.path);
	try {
		await assert.rejects(hc.list(), (error: unknown) => error instanceof HcError && error.kind === "socket");
		assert.equal((await hc.list()).length, 0);
		assert.equal(core.connections, 2);
	} finally {
		hc.close?.();
		await core.stop();
	}
});

// ─── framed 事件 ───

test("a framed subscription delivers the snapshot before events, then heartbeats", async () => {
	const core = new FakeCore(true);
	core.terminals = [terminal("t1")];
	const channel = 7;
	core.onCall = (call) => {
		if (call.method === "terminal.list") return call.reply({ terminals: core.terminals });
		if (call.method !== "events.subscribe") return call.reply({});

		// 回复帧与事件帧放在同一个 chunk 里：快照必须仍然排在事件前面。
		const snapshot = encodeFrame(
			0,
			FRAME_DATA,
			Buffer.from(
				JSON.stringify({
					jsonrpc: "2.0",
					id: call.id,
					result: { seq: 10, terminals: core.terminals, channel },
				}),
			),
		);
		const event = encodeFrame(
			channel,
			FRAME_DATA,
			Buffer.from(
				`${JSON.stringify({
					jsonrpc: "2.0",
					method: "event",
					params: { seq: 11, type: "finished", terminal: "t1", data: {} },
				})}\n`,
			),
		);
		call.pushRaw(Buffer.concat([snapshot, event]));
		setTimeout(() => {
			call.push(channel, { jsonrpc: "2.0", method: "heartbeat", params: { seq: 12 } });
		}, 20);
	};

	await core.start();
	const hc = createHcClient(core.path);
	try {
		const messages: HcWatchMessage[] = [];
		const subscription = await hc.subscribe!({ children_of: "self" }, (message) => messages.push(message));

		assert.deepEqual(
			messages.map((message) => message.kind),
			["snapshot", "event"],
		);
		const event = messages[1] as Extract<HcWatchMessage, { kind: "event" }>;
		assert.equal(event.type, "finished");
		assert.equal(event.terminal, "t1");

		await waitFor("the heartbeat", () => messages.some((message) => message.kind === "heartbeat"));
		await waitFor("credit for event bytes", () =>
			core.frames.some((frame) => frame.channel === channel && frame.kind === FRAME_CREDIT),
		);
		assert.equal(subscription.channel, channel);

		// 订阅和调用共用一条连接：订阅开着，普通调用照样走。
		assert.equal((await hc.list()).length, 1);
		assert.equal(core.connections, 1);

		subscription.close();
		await waitFor("the core to receive CLOSE", () =>
			core.frames.some((frame) => frame.channel === channel && frame.kind === FRAME_CLOSE),
		);
		assert.equal((await hc.list()).length, 1);
		assert.equal(core.connections, 1);
	} finally {
		hc.close?.();
		await core.stop();
	}
});

test("a line-mode core keeps working; events report themselves as unsupported", async () => {
	const core = new FakeCore(false);
	core.terminals = [terminal("t1")];
	core.onCall = (call) => call.reply({ terminals: core.terminals });
	await core.start();
	const hc = createHcClient(core.path);
	try {
		assert.equal((await hc.list()).length, 1);
		await assert.rejects(
			hc.subscribe!({}, () => undefined),
			(error: unknown) => error instanceof HcError && error.kind === "unsupported",
		);
		assert.equal(core.connections, 1);
	} finally {
		hc.close?.();
		await core.stop();
	}
});

test("a core that rejects the framed parameter is retried with a plain hello", async () => {
	const core = new FakeCore(false);
	core.rejectFramed = true;
	core.terminals = [terminal("t1")];
	core.onCall = (call) => call.reply({ terminals: core.terminals });
	await core.start();
	const hc = createHcClient(core.path);
	try {
		assert.equal((await hc.list()).length, 1);
		assert.equal(core.connections, 2, "one rejected hello, then a plain reconnect");
	} finally {
		hc.close?.();
		await core.stop();
	}
});

test("closing the client notifies subscribers and the next call reconnects", async () => {
	const core = new FakeCore(true);
	core.terminals = [terminal("t1")];
	core.onCall = (call) => {
		if (call.method === "events.subscribe") {
			return call.reply({ seq: 1, terminals: core.terminals, channel: 3 });
		}
		call.reply({ terminals: core.terminals });
	};
	await core.start();
	const hc = createHcClient(core.path);
	const messages: HcWatchMessage[] = [];
	try {
		await hc.subscribe!({ children_of: "self" }, (message) => messages.push(message));
		hc.close?.();
		await waitFor("the lost notice", () => messages.some((message) => message.kind === "lost"));
		assert.equal((await hc.list()).length, 1);
		assert.equal(core.connections, 2);
	} finally {
		hc.close?.();
		await core.stop();
	}
});
