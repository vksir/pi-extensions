import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: FakeCtx) => unknown;

interface FakeCtx {
	mode: "tui" | "print" | undefined;
	sessionManager: { getSessionName: () => string | undefined };
	ui: { setTitle: (title: string) => void };
}

interface Setup {
	/** 触发已注册事件 */
	fire: (event: string, event_: unknown, ctx?: FakeCtx) => unknown;
	/** renameHerdrTab 发出的 herdr CLI 调用（先等待串行队列消化完） */
	execCalls: () => Promise<{ command: string; args: string[] }[]>;
	/** 恢复 setup 改动的进程环境变量 */
	restoreEnv: () => void;
	ctx: FakeCtx;
	titles: string[];
}

/**
 * 假 herdr CLI：所有命令记录调用并返回成功。
 *
 * 扩展是带模块级状态（动画定时器、更名队列）的单例；
 * 查询串导入让每个 setup 拿到全新实例，测试互不污染。
 */
let moduleSeq = 0;
async function setup(options: { variant?: "legacy" | "app" } = {}): Promise<Setup> {
	const { default: titleExtension } = await import(`../extensions/pi-title.ts?run=${moduleSeq++}`);
	const herdrEnvKeys = ["HERDR_ENV", "HERDR_TAB_ID", "HERDR_BIN_PATH", "HC_TERMINAL_ID"] as const;
	const previous = new Map(herdrEnvKeys.map((k) => [k, process.env[k]]));
	if (options.variant === "legacy") {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_TAB_ID = "tab-1";
		process.env.HERDR_BIN_PATH = "herdr-stub";
		delete process.env.HC_TERMINAL_ID;
	} else if (options.variant === "app") {
		for (const k of ["HERDR_ENV", "HERDR_TAB_ID", "HERDR_BIN_PATH"] as const) delete process.env[k];
		process.env.HC_TERMINAL_ID = "t1";
	} else {
		for (const k of herdrEnvKeys) delete process.env[k];
	}

	const handlers = new Map<string, Handler>();
	const execs: { command: string; args: string[] }[] = [];
	const pi = {
		on: (event: string, handler: Handler) => { handlers.set(event, handler); },
		exec: async (command: string, args: string[]) => {
			execs.push({ command, args });
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	titleExtension(pi as unknown as ExtensionAPI);

	const titles: string[] = [];
	const ctx: FakeCtx = {
		mode: "tui",
		sessionManager: { getSessionName: () => "sess" },
		ui: { setTitle: (title) => { titles.push(title); } },
	};

	return {
		fire: (event, event_, eventCtx) => handlers.get(event)?.(event_, eventCtx ?? ctx),
		/** 返回队列消化后新发出的 herdr-app CLI 调用（取后即清） */
		execCalls: async () => {
			await new Promise((resolve) => setImmediate(resolve));
			return execs.splice(0, execs.length);
		},
		ctx,
		titles,
		restoreEnv: () => {
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		},
	};
}

/** 测试收尾：释放模块级定时器并还原环境变量 */
function shutdown(setup_: Setup) {
	// herdr 分支未注册动画事件，无定时器可释放，fire 安全空转；
	// 模块级状态靠查询串导入隔离，这里无需手工还原
	setup_.fire("session_shutdown", { type: "session_shutdown" }, { ...setup_.ctx, mode: "tui" });
	setup_.restoreEnv();
}

test("旧 herdr：HERDR_TAB_ID 直接更名", async () => {
	const s = await setup({ variant: "legacy" });
	try {
		s.fire("session_info_changed", { type: "session_info_changed", name: "重构认证模块" });
		assert.deepEqual(await s.execCalls(), [
			{ command: "herdr-stub", args: ["tab", "rename", "tab-1", "重构认证模块"] },
		]);

		// /name 清除会话名时同步清空标签
		s.fire("session_info_changed", { type: "session_info_changed", name: undefined });
		assert.deepEqual(await s.execCalls(), [
			{ command: "herdr-stub", args: ["tab", "rename", "tab-1", ""] },
		]);
	} finally {
		shutdown(s);
	}
});

test("HC_TERMINAL_ID 同时存在时不影响旧 herdr 更名", async () => {
	const s = await setup({ variant: "legacy" });
	try {
		process.env.HC_TERMINAL_ID = "t1"; // 混合环境：更名分支只认 HERDR_TAB_ID
		s.fire("session_info_changed", { type: "session_info_changed", name: "重构认证模块" });
		assert.deepEqual(await s.execCalls(), [
			{ command: "herdr-stub", args: ["tab", "rename", "tab-1", "重构认证模块"] },
		]);
	} finally {
		shutdown(s);
	}
});

test("herdr app：不做标签更名，/name 不发出任何 CLI 调用", async () => {
	const s = await setup({ variant: "app" });
	try {
		s.fire("session_info_changed", { type: "session_info_changed", name: "重构认证模块" });
		assert.deepEqual(await s.execCalls(), []);

		s.fire("session_info_changed", { type: "session_info_changed", name: undefined });
		assert.deepEqual(await s.execCalls(), []);
	} finally {
		shutdown(s);
	}
});

test("旧 herdr：子 agent 会话更名不得触碰主标签", async () => {
	const s = await setup({ variant: "legacy" });
	try {
		// pi-subagents 在 bindExtensions 前派生更名，此时 ctx.mode 还是 undefined；
		// bindExtensions 未传 mode 时则是 "print"。两者都必须被忽略。
		s.fire("session_info_changed", { type: "session_info_changed", name: "explore#a1b2c3d4" }, { ...s.ctx, mode: undefined });
		assert.deepEqual(await s.execCalls(), []);

		s.fire("session_info_changed", { type: "session_info_changed", name: "explore#a1b2c3d4" }, { ...s.ctx, mode: "print" });
		assert.deepEqual(await s.execCalls(), []);

		// 主会话自身照常更名，证明上面两条确实是被子会话过滤掉的
		s.fire("session_info_changed", { type: "session_info_changed", name: "重构认证模块" });
		assert.deepEqual(await s.execCalls(), [
			{ command: "herdr-stub", args: ["tab", "rename", "tab-1", "重构认证模块"] },
		]);
	} finally {
		shutdown(s);
	}
});

test("普通终端：主会话 agent 运行时播放标题动画并恢复原标题", async () => {
	const s = await setup();
	try {
		s.fire("agent_start", { type: "agent_start" });
		assert.equal(s.titles.length, 1); // start() 立即 tick 一帧

		s.fire("agent_settled", { type: "agent_settled" });
		assert.equal(s.titles.at(-1), "π - sess - " + process.cwd().split(/[\\/]/).at(-1));
	} finally {
		shutdown(s);
	}
});

test("普通终端：子 agent 会话不参与标题动画", async () => {
	const s = await setup();
	try {
		s.fire("agent_start", { type: "agent_start" }, { ...s.ctx, mode: "print" });
		assert.equal(s.titles.length, 0);

		s.fire("agent_settled", { type: "agent_settled" }, { ...s.ctx, mode: "print" });
		assert.equal(s.titles.length, 0);
	} finally {
		shutdown(s);
	}
});
