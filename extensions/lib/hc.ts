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
 * 每个请求单独开一条连接（连接 → hello → 调用 → 关闭）：命名管道开销很小，换来的是
 * 没有长连接要维护、没有断线重连状态。等待类调用（`terminal.wait`）在调用自己的
 * timeout 到点时由 core 回包，客户端的兜底超时只是防 core 挂掉。
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

export interface HcClient {
	run(params: HcRunParams): Promise<HcRunResult>;
	send(params: HcSendParams): Promise<HcSendResult>;
	wait(params: HcWaitParams): Promise<HcWaitResult>;
	get(terminal: string): Promise<HcTerminal>;
	list(): Promise<HcTerminal[]>;
	kill(terminal: string): Promise<HcTerminal>;
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

type RawRpc = (method: string, params: unknown) => Promise<unknown>;

/**
 * 一次调用一条连接：`hello`（protocol generation 1）之后才是业务方法。
 * 响应按行切分；先到的 `error` 直接抛 HcError，其余以 hello 为界判断阶段。
 */
function createSocketRpc(socketPath: string): RawRpc {
	return (method, params) =>
		new Promise((resolve, reject) => {
			const socket = net.createConnection(socketPath);
			let buffer = "";
			let helloDone = false;
			let settled = false;
			const timer = setTimeout(
				() => finish(new HcError("timeout", `hc ${method} timed out`)),
				REQUEST_TIMEOUT_MS,
			);

			const finish = (error?: unknown, result?: unknown): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				if (error) reject(error);
				else resolve(result);
			};

			const write = (name: string, payload: unknown): void => {
				const message = {
					jsonrpc: "2.0",
					id: helloDone ? 2 : 1,
					method: name,
					params: payload ?? {},
				};
				socket.write(`${JSON.stringify(message)}\n`);
			};

			socket.setEncoding("utf8");
			socket.on("connect", () => write("hello", { generation: 1 }));
			socket.on("error", (error) => finish(new HcError("socket", error.message)));
			socket.on("close", () => finish(new HcError("socket", `hc ${method} connection closed`)));
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
					if (!line) continue;

					let message: {
						error?: { message?: string; data?: { kind?: string } };
						result?: unknown;
					};
					try {
						message = JSON.parse(line);
					} catch {
						continue; // 非 JSON 行（理论上不会出现）忽略
					}

					if (message.error) {
						const kind = message.error.data?.kind ?? "error";
						finish(new HcError(kind, message.error.message ?? kind));
						return;
					}
					if (!helloDone) {
						helloDone = true;
						write(method, params);
						continue;
					}
					finish(undefined, message.result);
					return;
				}
			});
		});
}

export function createHcClient(socketPath: string): HcClient {
	const rpc = createSocketRpc(socketPath);
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
		async kill(terminal) {
			return (await rpc("terminal.kill", { terminal })) as HcTerminal;
		},
	};
}
