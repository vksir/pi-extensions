/**
 * herdr-core（hc）的 JSON-RPC 客户端。
 *
 * 扩展在 hc 终端里跑时，环境里带着两样东西：`HC_TERMINAL_ID`（本终端的地址）与
 * `HC_TERMINAL_SOCKET`（core 的命名管道）。协议是一行一条 JSON-RPC 2.0，先 `hello`
 * 握手，再发调用；错误形状是 `{error: {message, data: {kind, hint}}}`，`kind` 是稳定的
 * 错误码（`not_found` / `name_taken` / `blocked` / `status_mismatch` ...）。
 *
 * 为什么不用 `hc` CLI：拉起子 agent 必须给子进程注入 `PI_AGENT_*` 环境变量，而 CLI 没有
 * `--env`（只有 API 的 `terminal.run` 有）；而且 socket 一步到位，不用拼命令行。
 *
 * 一个进程一条连接：第一次调用才建连（懒建连），之后所有调用复用同一条连接，按 JSON-RPC
 * id 多路复用，直到连接断了才在下次调用时重建。连接上的调用彼此独立：一个 `terminal.wait`
 * 等 60 秒也不挡别的调用。
 *
 * `hello` 里带 `framed: true`：新 core 会把连接切换成帧协议，请求仍走 channel 0，
 * `events.subscribe` 另开一个 channel 推终端事实变化（快照 + 增量）。这样轮询可以退化成
 * 长连接上的事件；旧 core 回 `framed: false` 时继续一行一条 JSON 的老模式。
 *
 * 等待类调用（`terminal.wait`）在调用自己的 timeout 到点时由 core 回包，客户端的兜底
 * 超时只用于防 core 挂掉。
 */

import net from "node:net";

/** 程序自己上报的状态词；`done` 是「结束但还没被看」的那一档。 */
export type HcAgentState = "idle" | "working" | "done" | "blocked" | "error";

export interface HcStatus {
	/** 上报的程序种类，例如 "pi"。 */
	app?: string;
	state: HcAgentState | string;
	kind?: string | null;
	msg?: string;
	title?: string;
}

/** `terminal.list` / `terminal.get` 返回的终端记录（只声明本模块用得到的字段）。 */
export interface HcTerminal {
	address: string;
	argv: string[];
	cwd: string;
	name: string | null;
	labels: Record<string, string>;
	parent: string | null;
	state: "live" | "finished";
	status: HcStatus | null;
	turn: number;
	title: string;
	exit_code?: number | null;
	reason?: string | null;
}

export interface HcWaitResult {
	terminal: string;
	/** false 表示超时（check-in）：对方还在跑。 */
	ended: boolean;
	reason: "status" | "exit" | "output" | "timeout" | "not_started" | "message" | "running" | "children" | string;
	status: string | null;
	turn: number;
	exit_code: number | null;
	signal: number | null;
	from: string | null;
	children?: HcWaitResult[];
}

export interface HcRunResult extends HcTerminal {
	/** 带 `wait` 时，等待结束那一刻的屏幕文本。 */
	output: string | null;
	wait: HcWaitResult | null;
}

export interface HcSendResult {
	/** 发送后几秒内是否进入 working；程序不上报状态时为 null。 */
	started: boolean | null;
	status: string | null;
	turn: number;
	wait: HcWaitResult | null;
}

export interface HcRunParams {
	argv: string[];
	cwd?: string;
	name?: string;
	parent?: string;
	labels?: Record<string, string>;
	env?: Record<string, string>;
	no_notify?: boolean;
	rm?: boolean;
	/** 启动后等到它不再 working（对 agent 就是等它就绪）再返回。 */
	wait?: boolean;
	/** 与 `wait` 配合：多少秒后 check-in，程序继续跑。 */
	timeout?: number;
}

export interface HcSendParams {
	terminal: string;
	text: string;
	caller?: string;
	/** 只在对方状态恰好是这个时发送；变了就报 status_mismatch。 */
	if?: "idle" | "working";
}

export interface HcWaitParams {
	terminal: string;
	caller?: string;
	/** 秒；超时是 check-in，不是错误。 */
	timeout?: number;
}

export interface HcLabelParams {
	terminal: string;
	/** 要设置的 label；`key=`（空串）表示删除。 */
	labels: Record<string, string>;
}

export interface HcKeysParams {
	terminal: string;
	caller?: string;
	/** 按键名：`enter` / `esc` / `ctrl+d` / `a` ... */
	keys: string[];
}

export interface HcClient {
	run(params: HcRunParams): Promise<HcRunResult>;
	send(params: HcSendParams): Promise<HcSendResult>;
	wait(params: HcWaitParams): Promise<HcWaitResult>;
	get(terminal: string): Promise<HcTerminal>;
	list(): Promise<HcTerminal[]>;
	label(params: HcLabelParams): Promise<HcTerminal>;
	keys(params: HcKeysParams): Promise<unknown>;
	kill(terminal: string): Promise<HcTerminal>;
	/** 订阅终端事实变化（framed 连接）；旧 core 上会抛 `unsupported`。 */
	subscribe?(params: HcSubscribeParams, onMessage: (message: HcWatchMessage) => void): Promise<HcSubscription>;
	/** 关闭底层连接与订阅；之后再用会重新懒建。 */
	close?(): void;
}

/** core 返回的结构化错误；`kind` 原样保留，供调用方翻译成人话。 */
export class HcError extends Error {
	readonly kind: string;

	constructor(kind: string, message: string) {
		super(message);
		this.name = "HcError";
		this.kind = kind;
	}
}

/** 是否跑在 hc 终端里：地址与 socket 缺一不可。空白视同不存在。 */
export function inHcEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.HC_TERMINAL_ID?.trim() && env.HC_TERMINAL_SOCKET?.trim());
}

/** 单次请求的兜底超时：远大于 `terminal.wait` 能给出的等待上限，只用于防 core 无响应。 */
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

/** 连接 + hello 的兜底超时：core 没起来时不要挂住调用方。 */
const CONNECT_TIMEOUT_MS = 10_000;

// framed 帧：`[channel u32 LE][kind u8][len u32 LE][payload]`。channel 0 走 JSON-RPC，
// 事件订阅各占一个 channel；事件流按字节回 CREDIT，否则 256 KiB 后 core 会暂停推送。
const FRAME_HEADER = 9;
const FRAME_MAX_PAYLOAD = 16 << 20;
const FRAME_DATA = 0;
const FRAME_CREDIT = 1;
const FRAME_CLOSE = 2;

/** `events.subscribe` 的过滤器；不传任何字段就是「全部终端」。 */
export interface HcSubscribeParams {
	/** 只看这个终端（地址或名字）。 */
	terminal?: string;
	/** 只看这个终端的直接子终端。 */
	children_of?: string;
	/** 只看带这些 label 的终端。 */
	labels?: Record<string, string>;
	/** 文档事件；一般不用。 */
	docs?: string[];
}

/** 一条订阅消息：先 `snapshot`，之后是 `event`；落后时 core 重发 `missed` 快照。 */
export type HcWatchMessage =
	| { kind: "snapshot"; seq: number; terminals: HcTerminal[] }
	| { kind: "missed"; seq: number; terminals: HcTerminal[] }
	| { kind: "event"; seq: number; type: string; terminal?: string; data?: Record<string, unknown> }
	| { kind: "heartbeat"; seq: number }
	| { kind: "lost"; reason: string };

export interface HcSubscription {
	readonly channel: number;
	/** 取消订阅：framed 连接上发 CLOSE，core 立即释放这条订阅。 */
	close(): void;
}

interface RpcErrorShape {
	message?: string;
	data?: { kind?: string };
}

interface RpcMessage {
	id?: number;
	method?: string;
	params?: any;
	result?: any;
	error?: RpcErrorShape;
}

interface PendingCall {
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface SubscriptionState {
	onMessage: (message: HcWatchMessage) => void;
	channel: number | null;
	closed: boolean;
}

function rpcError(message: RpcMessage): HcError {
	const kind = message.error?.data?.kind ?? "error";
	return new HcError(kind, message.error?.message ?? kind);
}

function frame(channel: number, kind: number, payload: Buffer): Buffer {
	const header = Buffer.allocUnsafe(FRAME_HEADER);
	header.writeUInt32LE(channel, 0);
	header[4] = kind;
	header.writeUInt32LE(payload.length, 5);
	return Buffer.concat([header, payload]);
}

/**
 * 一条懒建的 hc 连接：`hello`（protocol generation 1）之后才是业务方法。
 * - 并发调用共用一个连接，按 id 配对回复；connection 断了就一起失败，下次调用再建。
 * - 新 core 把连接切到 framed，`subscribe` 才能在同一个连接上再开事件 channel。
 * - 行模式与 framed 模式都按字节缓冲解析，不依赖 chunk 边界。
 */
class HcConnection {
	private socket: net.Socket | null = null;
	private connecting: Promise<void> | null = null;
	private mode: "line" | "framed" = "line";
	private helloDone = false;
	private helloFinish: ((error?: unknown) => void) | null = null;
	private buffer: Buffer = Buffer.alloc(0);
	private nextId = 1;
	/** 首次 hello 带 framed；旧 core 不认这个参数时退回普通 hello 重连一次。 */
	private helloFramed = true;
	/** 这条连接对端是否接受了 framed（能力是 core 级的，跨重连保持）。 */
	private framedSupported = false;
	private readonly pending = new Map<number, PendingCall>();
	/** 等 `events.subscribe` 回复的订阅：回复里带 channel，必须先登记再交付事件。 */
	private readonly pendingSubscriptions = new Map<number, SubscriptionState>();
	private readonly subscriptions = new Set<SubscriptionState>();
	private readonly channels = new Map<number, SubscriptionState>();

	private readonly socketPath: string;
	private readonly requestTimeoutMs: number;

	constructor(socketPath: string, requestTimeoutMs = REQUEST_TIMEOUT_MS) {
		this.socketPath = socketPath;
		this.requestTimeoutMs = requestTimeoutMs;
	}

	async call(method: string, params: unknown): Promise<unknown> {
		await this.ready();
		return this.callWithId(this.nextId++, method, params);
	}

	async subscribe(
		params: HcSubscribeParams,
		onMessage: (message: HcWatchMessage) => void,
	): Promise<HcSubscription> {
		await this.ready();
		if (!this.framedSupported) {
			throw new HcError("unsupported", "hc events need a framed connection (upgrade herdr-core)");
		}

		const id = this.nextId++;
		const subscription: SubscriptionState = { onMessage, channel: null, closed: false };
		this.pendingSubscriptions.set(id, subscription);
		try {
			await this.callWithId(id, "events.subscribe", params);
		} catch (error) {
			this.pendingSubscriptions.delete(id);
			throw error;
		}
		return {
			channel: subscription.channel!,
			close: () => this.closeSubscription(subscription),
		};
	}

	/** 懒建连；并发的第一次调用共享同一次 hello。 */
	private ready(): Promise<void> {
		if (this.socket && this.helloDone) return Promise.resolve();
		if (this.connecting) return this.connecting;

		const connecting = this.connectWithFallback();
		this.connecting = connecting;
		const clear = (): void => {
			if (this.connecting === connecting) this.connecting = null;
		};
		// 调用方拿到的是原始 promise；这里只负责清掉共享引用。
		connecting.then(clear, clear);
		return connecting;
	}

	/** 旧 core 可能拒收未知的 `framed` 参数（invalid_params）：去掉它再连一次。 */
	private async connectWithFallback(): Promise<void> {
		try {
			await this.connect();
		} catch (error) {
			if (this.helloFramed && error instanceof HcError && error.kind === "invalid_params") {
				this.helloFramed = false;
				await this.connect();
				return;
			}
			throw error;
		}
	}

	private connect(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const socket = net.createConnection(this.socketPath);
			this.socket = socket;
			this.mode = "line";
			this.helloDone = false;
			this.buffer = Buffer.alloc(0);

			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				this.fail(new HcError("timeout", "hc hello timed out"));
			}, CONNECT_TIMEOUT_MS);
			timer.unref?.();

			this.helloFinish = (error?: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error) reject(error);
				else resolve();
			};

			const gone = (error: HcError): void => {
				// 旧 socket 的收尾事件不能把新连接拆掉。
				if (this.socket !== socket) return;
				this.fail(error);
			};

			socket.on("connect", () => {
				this.writeMessage({
					jsonrpc: "2.0",
					id: 0,
					method: "hello",
					params: this.helloFramed ? { generation: 1, framed: true } : { generation: 1 },
				});
			});
			socket.on("data", (chunk: Buffer) => this.onData(chunk));
			socket.on("error", (error) => gone(new HcError("socket", error.message)));
			socket.on("close", () => gone(new HcError("socket", "hc connection closed")));
		});
	}

	/** 关闭连接：拒绝在飞调用、通知订阅者；下次调用会重新懒建。 */
	close(): void {
		this.fail(new HcError("closed", "hc client closed"));
	}

	/** 连接失效：拒绝在飞的调用、通知订阅者，再清空状态等下次懒建。 */
	private fail(error: HcError): void {
		const socket = this.socket;
		const helloFinish = this.helloFinish;
		this.socket = null;
		this.helloDone = false;
		this.helloFinish = null;
		this.mode = "line";
		this.buffer = Buffer.alloc(0);

		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		this.pendingSubscriptions.clear();

		for (const subscription of this.subscriptions) {
			if (!subscription.closed) subscription.onMessage({ kind: "lost", reason: error.message });
		}
		this.subscriptions.clear();
		this.channels.clear();

		socket?.removeAllListeners();
		socket?.destroy();
		helloFinish?.(error);
	}

	private onData(chunk: Buffer): void {
		this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk;
		this.pump();
	}

	private pump(): void {
		if (this.mode === "framed") this.pumpFrames();
		else this.pumpLines();
	}

	private pumpLines(): void {
		while (this.mode === "line") {
			const newline = this.buffer.indexOf(0x0a);
			if (newline < 0) return;
			const line = this.buffer.subarray(0, newline).toString("utf8").trim();
			this.buffer = this.buffer.subarray(newline + 1);
			if (line) this.handleLine(line);
		}
		// hello 把连接切到 framed：缓冲区剩下的字节是帧。
		this.pumpFrames();
	}

	private pumpFrames(): void {
		while (this.buffer.length >= FRAME_HEADER) {
			const channel = this.buffer.readUInt32LE(0);
			const kind = this.buffer[4]!;
			const length = this.buffer.readUInt32LE(5);
			if (length > FRAME_MAX_PAYLOAD) {
				this.fail(new HcError("protocol", `hc frame of ${length} bytes exceeds the limit`));
				return;
			}
			if (this.buffer.length < FRAME_HEADER + length) return;

			const payload = this.buffer.subarray(FRAME_HEADER, FRAME_HEADER + length);
			this.buffer = this.buffer.subarray(FRAME_HEADER + length);
			this.handleFrame(channel, kind, payload);
		}
	}

	private handleLine(line: string): void {
		let message: RpcMessage;
		try {
			message = JSON.parse(line);
		} catch {
			return; // 非 JSON 行（理论上不会出现）忽略
		}

		if (message.id === 0 && !this.helloDone) {
			this.handleHello(message);
			return;
		}
		if (typeof message.id === "number") this.handleReply(message.id, message);
	}

	private handleHello(message: RpcMessage): void {
		if (message.error) {
			this.fail(rpcError(message));
			return;
		}

		this.helloDone = true;
		this.mode = message.result?.framed === true ? "framed" : "line";
		this.framedSupported = this.mode === "framed";
		// 空闲时不替进程续命；有在飞调用时由 callWithId 重新 ref。
		this.unrefSocketIfIdle();
		const finish = this.helloFinish;
		this.helloFinish = null;
		finish?.();
	}

	private handleFrame(channel: number, kind: number, payload: Buffer): void {
		if (channel === 0) {
			if (kind !== FRAME_DATA) return;
			let message: RpcMessage;
			try {
				message = JSON.parse(payload.toString("utf8"));
			} catch {
				return;
			}
			if (typeof message.id === "number") this.handleReply(message.id, message);
			return;
		}

		const subscription = this.channels.get(channel);
		if (!subscription) return;
		// 事件流按字节计 credit；heartbeat 也要还，否则长命订阅会被 core 暂停。
		this.writeFrame(channel, FRAME_CREDIT, creditPayload(payload.length));

		if (kind === FRAME_CLOSE) {
			this.channels.delete(channel);
			subscription.channel = null;
			if (!subscription.closed) {
				subscription.onMessage({ kind: "lost", reason: payload.toString("utf8") || "closed by core" });
			}
			return;
		}
		if (kind !== FRAME_DATA) return;

		for (const line of payload.toString("utf8").split("\n")) {
			if (line.trim()) this.deliver(subscription, line);
		}
	}

	/** `events.subscribe` 的回复要先登记 channel，再交付快照，最后才 resolve 调用。 */
	private handleReply(id: number, message: RpcMessage): void {
		const subscription = this.pendingSubscriptions.get(id);
		if (subscription) {
			this.pendingSubscriptions.delete(id);
			const pending = this.pending.get(id);
			if (pending) {
				this.pending.delete(id);
				clearTimeout(pending.timer);
				this.unrefSocketIfIdle();
			}
			if (message.error) {
				pending?.reject(rpcError(message));
				return;
			}

			const result = message.result as { channel?: number; seq?: number; terminals?: HcTerminal[] };
			if (typeof result?.channel !== "number") {
				pending?.reject(new HcError("protocol", "hc events.subscribe returned no channel"));
				return;
			}

			subscription.channel = result.channel;
			this.channels.set(result.channel, subscription);
			this.subscriptions.add(subscription);
			// 快照先于后续事件：事件帧在同一批数据里排在回复后面。
			subscription.onMessage({
				kind: "snapshot",
				seq: Number(result.seq ?? 0),
				terminals: result.terminals ?? [],
			});
			pending?.resolve(result);
			return;
		}

		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		this.unrefSocketIfIdle();
		if (message.error) pending.reject(rpcError(message));
		else pending.resolve(message.result);
	}

	private deliver(subscription: SubscriptionState, line: string): void {
		let message: RpcMessage;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}

		const params = message.params ?? {};
		if (message.method === "event") {
			subscription.onMessage({
				kind: "event",
				seq: Number(params.seq ?? 0),
				type: String(params.type ?? ""),
				terminal: typeof params.terminal === "string" ? params.terminal : undefined,
				data: params.data,
			});
		} else if (message.method === "missed") {
			subscription.onMessage({
				kind: "missed",
				seq: Number(params.seq ?? 0),
				terminals: params.terminals ?? [],
			});
		} else if (message.method === "heartbeat") {
			subscription.onMessage({ kind: "heartbeat", seq: Number(params.seq ?? 0) });
		}
	}

	private closeSubscription(subscription: SubscriptionState): void {
		if (subscription.closed) return;
		subscription.closed = true;
		this.subscriptions.delete(subscription);
		if (subscription.channel === null) return;

		const channel = subscription.channel;
		subscription.channel = null;
		this.channels.delete(channel);
		this.writeFrame(channel, FRAME_CLOSE, Buffer.alloc(0));
	}

	private callWithId(id: number, method: string, params: unknown): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);
				this.unrefSocketIfIdle();
				pending.reject(new HcError("timeout", `hc ${method} timed out`));
			}, this.requestTimeoutMs);
			timer.unref?.();

			this.pending.set(id, { resolve, reject, timer });
			// 在飞调用期间保持进程存活；订阅不 ref（不该阻止 pi 退出）。
			this.socket?.ref();
			if (this.writeMessage({ jsonrpc: "2.0", id, method, params: params ?? {} })) return;

			this.pending.delete(id);
			clearTimeout(timer);
			this.unrefSocketIfIdle();
			reject(new HcError("socket", `hc ${method}: connection is not writable`));
		});
	}

	/** 没有在飞调用时放开事件循环：长连接与订阅不替 pi 续命。 */
	private unrefSocketIfIdle(): void {
		if (this.pending.size === 0) this.socket?.unref();
	}

	private writeMessage(message: Record<string, unknown>): boolean {
		const json = JSON.stringify(message);
		if (this.mode === "framed") return this.writeFrame(0, FRAME_DATA, Buffer.from(json, "utf8"));

		const socket = this.socket;
		if (!socket || socket.destroyed) return false;
		try {
			socket.write(`${json}\n`);
			return true;
		} catch {
			return false;
		}
	}

	private writeFrame(channel: number, kind: number, payload: Buffer): boolean {
		const socket = this.socket;
		if (!socket || socket.destroyed) return false;
		try {
			socket.write(frame(channel, kind, payload));
			return true;
		} catch {
			return false;
		}
	}
}

function creditPayload(bytes: number): Buffer {
	const payload = Buffer.allocUnsafe(4);
	payload.writeUInt32LE(bytes, 0);
	return payload;
}

export function createHcClient(socketPath: string): HcClient {
	const connection = new HcConnection(socketPath);
	const rpc = (method: string, params: unknown): Promise<unknown> => connection.call(method, params);
	return {
		async run(params) {
			return (await rpc("terminal.run", params)) as HcRunResult;
		},
		async send(params) {
			return (await rpc("terminal.send", params)) as HcSendResult;
		},
		async wait(params) {
			return (await rpc("terminal.wait", params)) as HcWaitResult;
		},
		async get(terminal) {
			return (await rpc("terminal.get", { terminal })) as HcTerminal;
		},
		async list() {
			const result = (await rpc("terminal.list", {})) as { terminals?: HcTerminal[] };
			return result.terminals ?? [];
		},
		async label(params) {
			return (await rpc("terminal.label", params)) as HcTerminal;
		},
		async keys(params) {
			return rpc("terminal.keys", params);
		},
		async kill(terminal) {
			return (await rpc("terminal.kill", { terminal })) as HcTerminal;
		},
		async subscribe(params, onMessage) {
			return connection.subscribe(params, onMessage);
		},
		close() {
			connection.close();
		},
	};
}
