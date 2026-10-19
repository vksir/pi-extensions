import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const { default: titleExtension } = await import("../extensions/pi-title.ts");

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

function setup(options: { herdr?: boolean } = {}): Setup {
	const previous = {
		HERDR_ENV: process.env.HERDR_ENV,
		HERDR_TAB_ID: process.env.HERDR_TAB_ID,
		HERDR_BIN_PATH: process.env.HERDR_BIN_PATH,
	};
	if (options.herdr) {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_TAB_ID = "tab-1";
		process.env.HERDR_BIN_PATH = "herdr-stub";
	} else {
		delete process.env.HERDR_ENV;
		delete process.env.HERDR_TAB_ID;
	}

	const handlers = new Map<string, Handler>();
	const execs: { command: string; args: string[] }[] = [];
	const pi = {
		on: (event: string, handler: Handler) => { handlers.set(event, handler); },
		exec: async (command: string, args: string[]) => { execs.push({ command, args }); return { code: 0, stdout: "", stderr: "" }; },
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
		/** 返回队列消化后新发出的 herdr CLI 调用（取后即清） */
		execCalls: async () => {
			await new Promise((resolve) => setImmediate(resolve));
			return execs.splice(0, execs.length);
		},
		ctx,
		titles,
		restoreEnv: () => {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		},
	};
}

/** 测试收尾：释放模块级定时器并还原环境变量 */
function shutdown(setup_: Setup) {
	// herdr 分支未注册动画事件，无定时器可释放，fire 安全空转
	setup_.fire("session_shutdown", { type: "session_shutdown" }, { ...setup_.ctx, mode: "tui" });
	setup_.restoreEnv();
}

test("herdr：主会话 /name 同步重命名标签", async () => {
	const s = setup({ herdr: true });
	try {
		s.fire("session_info_changed", { type: "session_info_changed", name: "重构认证模块" });
		assert.deepEqual(await s.execCalls(), [{ command: "herdr-stub", args: ["tab", "rename", "tab-1", "重构认证模块"] }]);

		// /name 清除会话名时同步清空标签
		s.fire("session_info_changed", { type: "session_info_changed", name: undefined });
		assert.deepEqual(await s.execCalls(), [{ command: "herdr-stub", args: ["tab", "rename", "tab-1", ""] }]);
	} finally {
		shutdown(s);
	}
});

test("herdr：子 agent 会话更名不得触碰主标签", async () => {
	const s = setup({ herdr: true });
	try {
		// pi-subagents 在 bindExtensions 前派生更名，此时 ctx.mode 还是 undefined；
		// bindExtensions 未传 mode 时则是 "print"。两者都必须被忽略。
		s.fire("session_info_changed", { type: "session_info_changed", name: "explore#a1b2c3d4" }, { ...s.ctx, mode: undefined });
		assert.deepEqual(await s.execCalls(), []);

		s.fire("session_info_changed", { type: "session_info_changed", name: "explore#a1b2c3d4" }, { ...s.ctx, mode: "print" });
		assert.deepEqual(await s.execCalls(), []);
	} finally {
		shutdown(s);
	}
});

test("普通终端：主会话 agent 运行时播放标题动画并恢复原标题", () => {
	const s = setup();
	try {
		s.fire("agent_start", { type: "agent_start" });
		assert.equal(s.titles.length, 1); // start() 立即 tick 一帧

		s.fire("agent_settled", { type: "agent_settled" });
		assert.equal(s.titles.at(-1), "π - sess - " + process.cwd().split(/[\\/]/).at(-1));
	} finally {
		shutdown(s);
	}
});

test("普通终端：子 agent 会话不参与标题动画", () => {
	const s = setup();
	try {
		s.fire("agent_start", { type: "agent_start" }, { ...s.ctx, mode: "print" });
		assert.equal(s.titles.length, 0);

		s.fire("agent_settled", { type: "agent_settled" }, { ...s.ctx, mode: "print" });
		assert.equal(s.titles.length, 0);
	} finally {
		shutdown(s);
	}
});
