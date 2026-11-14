import assert from "node:assert/strict";
import { test } from "node:test";

import { hasRunningSubagents } from "../extensions/lib/subagents.ts";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
/** globalThis 按符号索引的视图，测试里用来装卸假注册表。 */
const globalRef = globalThis as unknown as Record<symbol, unknown>;

/** 卸掉假注册表，恢复「未安装 pi-subagents」状态。 */
function removeRegistry(): void {
	delete globalRef[MANAGER_KEY];
}

// ─── lib/subagents：存活探测的容错口径 ───

test("未安装 pi-subagents 时视为没有子 agent", () => {
	removeRegistry();
	assert.equal(hasRunningSubagents(), false);
});

test("注册表形状不符（hasRunning 非函数）视为没有子 agent", () => {
	globalRef[MANAGER_KEY] = { hasRunning: "not-a-function" };
	try {
		assert.equal(hasRunningSubagents(), false);
	} finally {
		removeRegistry();
	}
});

test("注册表缺 hasRunning 成员视为没有子 agent", () => {
	globalRef[MANAGER_KEY] = {};
	try {
		assert.equal(hasRunningSubagents(), false);
	} finally {
		removeRegistry();
	}
});

test("hasRunning 抛错视为没有子 agent", () => {
	globalRef[MANAGER_KEY] = {
		hasRunning: () => {
			throw new Error("boom");
		},
	};
	try {
		assert.equal(hasRunningSubagents(), false);
	} finally {
		removeRegistry();
	}
});

test("hasRunning 为 true 表示有子 agent 在跑", () => {
	globalRef[MANAGER_KEY] = { hasRunning: () => true };
	try {
		assert.equal(hasRunningSubagents(), true);
	} finally {
		removeRegistry();
	}
});

test("hasRunning 为 false 表示没有子 agent", () => {
	globalRef[MANAGER_KEY] = { hasRunning: () => false };
	try {
		assert.equal(hasRunningSubagents(), false);
	} finally {
		removeRegistry();
	}
});

test("非 true 真值严格按没有子 agent 处理", () => {
	globalRef[MANAGER_KEY] = { hasRunning: () => 1 as unknown as boolean };
	try {
		assert.equal(hasRunningSubagents(), false);
	} finally {
		removeRegistry();
	}
});

// ─── pi-notify 接线：settle 时按子 agent 存活决定是否发通知 ───

type SettleHandler = (event: { aborted?: boolean }, ctx: { mode: string }) => Promise<void> | void;

interface Setup {
	/** 触发已注册的 agent_settled handler */
	fire: (options?: { aborted?: boolean; mode?: string }) => Promise<void>;
	/** handler 期间写进 stdout 的转义序列（即通知报文），取后不清零 */
	oscWrites: () => string[];
	/** 装上假注册表，模拟 pi-subagents 已激活 */
	setRegistry: (hasRunning: () => boolean) => void;
	/** 还原 stdout、platform、环境变量与注册表 */
	restore: () => void;
}

/**
 * pi-notify 在 default() 里读环境并注册 handler；带 cache-busting 地重新导入
 * 模块，保证每个 setup 拿到干净的注册流程。
 */
let moduleSeq = 0;
async function setup(): Promise<Setup> {
	// 本进程可能带着 herdr 的环境变量，先摘掉再导入，让 inHerdrEnv 按否处理。
	const herdrEnvKeys = ["HERDR_ENV", "HERDR_TAB_ID", "HERDR_BIN_PATH", "HC_TERMINAL_ID", "PI_AGENT_ID"] as const;
	const savedEnv = new Map(herdrEnvKeys.map((k) => [k, process.env[k]]));
	for (const k of herdrEnvKeys) delete process.env[k];

	const { default: notifyExtension } = await import(`../extensions/pi-notify.ts?run=${moduleSeq++}`);

	const handlers = new Map<string, SettleHandler>();
	const pi = {
		on: (event: string, handler: SettleHandler) => handlers.set(event, handler),
		getSettings: () => ({}),
	};
	notifyExtension(pi as never);

	// 本机是 Windows，真通知走 powershell + BurntToast；测试里改成 linux，让
	// notify 走可观测的 OSC 777 路径，报文从假 stdout 写出里捕获。
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { value: "linux" });
	const kittyWindowId = process.env.KITTY_WINDOW_ID;
	delete process.env.KITTY_WINDOW_ID;

	const chunks: string[] = [];
	const originalWrite = process.stdout.write;
	process.stdout.write = ((chunk: unknown) => {
		chunks.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;

	return {
		async fire({ aborted = false, mode = "tui" } = {}) {
			chunks.length = 0;
			await handlers.get("agent_settled")!({ aborted }, { mode });
		},
		oscWrites: () => chunks.filter((chunk) => chunk.includes("\x1b]")),
		setRegistry(hasRunning) {
			globalRef[MANAGER_KEY] = { hasRunning };
		},
		restore() {
			process.stdout.write = originalWrite;
			Object.defineProperty(process, "platform", platformDescriptor);
			if (kittyWindowId !== undefined) process.env.KITTY_WINDOW_ID = kittyWindowId;
			for (const [k, v] of savedEnv) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			removeRegistry();
		},
	};
}

test("有子 agent 在跑时 settle 不通知", async () => {
	const t = await setup();
	try {
		t.setRegistry(() => true);
		await t.fire();
		assert.deepEqual(t.oscWrites(), []);
	} finally {
		t.restore();
	}
});

test("没有子 agent 时 settle 照常通知", async () => {
	const t = await setup();
	try {
		await t.fire();
		const writes = t.oscWrites();
		assert.equal(writes.length, 1);
		assert.match(writes[0]!, /\x1b\]777;notify;/);
		assert.match(writes[0]!, /Task Completed/);
	} finally {
		t.restore();
	}
});

test("子 agent 结束后（hasRunning 翻 false）恢复通知", async () => {
	const t = await setup();
	try {
		let running = true;
		t.setRegistry(() => running);
		await t.fire();
		assert.deepEqual(t.oscWrites(), []);
		running = false;
		await t.fire();
		assert.equal(t.oscWrites().length, 1);
	} finally {
		t.restore();
	}
});

test("herdr 子 agent 会话的 settle 不通知", async () => {
	const t = await setup();
	try {
		process.env.PI_AGENT_ID = "abcd";
		await t.fire();
		assert.deepEqual(t.oscWrites(), []);
	} finally {
		t.restore();
	}
});

test("aborted 的 settle 不通知（既有行为）", async () => {
	const t = await setup();
	try {
		await t.fire({ aborted: true });
		assert.deepEqual(t.oscWrites(), []);
	} finally {
		t.restore();
	}
});

test("非 TUI 模式不通知（既有行为）", async () => {
	const t = await setup();
	try {
		await t.fire({ mode: "rpc" });
		assert.deepEqual(t.oscWrites(), []);
	} finally {
		t.restore();
	}
});
