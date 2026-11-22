import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fitTitle, sanitizeTitle } from "../extensions/lib/auto-name.ts";
import { piTitlePrompt } from "../extensions/prompt/pi-title.ts";

type Handler = (event: unknown, ctx: FakeCtx) => unknown;

interface ModelRef {
	provider: string;
	id: string;
}

interface CompleteContext {
	systemPrompt?: string;
	messages: { role: "user"; content: { type: "text"; text: string }[]; timestamp: number }[];
}

interface CompleteOptions {
	maxTokens?: number;
	cacheRetention?: string;
}

interface AssistantLike {
	role: "assistant";
	content: { type: "text"; text: string }[];
	stopReason: "stop";
}

interface FakeCtx {
	mode: "tui" | "print" | undefined;
	sessionManager: {
		getSessionName: () => string | undefined;
		getEntries: () => { type: "message"; message: { role: string } }[];
	};
	ui: { setTitle: (title: string) => void };
	model: ModelRef | undefined;
	modelRegistry: {
		find: (provider: string, id: string) => ModelRef | undefined;
		complete: (model: ModelRef, context: CompleteContext, options?: CompleteOptions) => Promise<AssistantLike>;
	};
}

interface ModelCall {
	model: ModelRef;
	context: CompleteContext;
	options: CompleteOptions | undefined;
}

interface SetupOptions {
	variant?: "legacy" | "app";
	/** 初始会话名；默认 "sess"。 */
	sessionName?: string;
	/** 会话里已有的真人消息条数；默认 0（全新会话）。 */
	userMessages?: number;
	/** 当前会话模型；默认 { provider: "main", id: "big" }。 */
	model?: ModelRef | undefined;
	/** `autoNameModel` 的解析结果。 */
	find?: (provider: string, id: string) => ModelRef | undefined;
	/** 假模型调用；默认返回 {"title": "Refactor auth module"}。 */
	complete?: (context: CompleteContext) => Promise<AssistantLike>;
	/** settings.json 内容；默认空。 */
	settings?: Record<string, unknown>;
}

interface Setup {
	/** 触发已注册事件 */
	fire: (event: string, event_: unknown, ctx?: FakeCtx) => unknown;
	/** 等待模型调用、更名队列与 exec 记录全部消化完 */
	settle: () => Promise<void>;
	/** 返回队列消化后新发出的 herdr CLI 调用（取后即清） */
	execCalls: () => Promise<{ command: string; args: string[] }[]>;
	/** 模型调用记录（取后即清） */
	modelCalls: () => ModelCall[];
	/** 改会话名，模拟 /name 后 ctx 的视图 */
	setSessionName: (name: string | undefined) => void;
	/** 恢复 setup 改动的进程环境变量 */
	restoreEnv: () => void;
	ctx: FakeCtx;
	titles: string[];
}

const assistant = (text: string): AssistantLike => ({
	role: "assistant",
	content: [{ type: "text", text }],
	stopReason: "stop",
});

/** 等若干轮宏任务，让 runAutoName 的链表、renameQueue 与 exec 记录都落地。 */
async function settle(): Promise<void> {
	for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 假 herdr CLI：所有命令记录调用并返回成功。
 *
 * 扩展是带模块级状态（动画定时器、更名队列、自动命名资格）的单例；
 * 查询串导入让每个 setup 拿到全新实例，测试互不污染。
 */
let moduleSeq = 0;
async function setup(options: SetupOptions = {}): Promise<Setup> {
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
	const calls: ModelCall[] = [];
	const model = "model" in options ? options.model : { provider: "main", id: "big" };
	const pi = {
		on: (event: string, handler: Handler) => { handlers.set(event, handler); },
		getSettings: () => options.settings ?? {},
		exec: async (command: string, args: string[]) => {
			execs.push({ command, args });
			// herdr app 的更名先 ls 寻址：返回一份装着 t1（variant "app" 所用终端）的清单
			const stdout =
				command === "herdr-app" && args[0] === "ls"
					? JSON.stringify({ spaces: [{ tabs: [{ id: "tb-1", terminals: [{ terminal: "t1" }] }] }] })
					: "";
			return { code: 0, stdout, stderr: "" };
		},
	};
	titleExtension(pi as unknown as ExtensionAPI);

	const session = {
		name: "sessionName" in options ? options.sessionName : "sess",
		userMessages: options.userMessages ?? 0,
	};
	const titles: string[] = [];
	const ctx: FakeCtx = {
		mode: "tui",
		sessionManager: {
			getSessionName: () => session.name,
			getEntries: () =>
				Array.from({ length: session.userMessages }, () => ({
					type: "message" as const,
					message: { role: "user" },
				})),
		},
		ui: { setTitle: (title) => { titles.push(title); } },
		model,
		modelRegistry: {
			find: (provider, id) => options.find?.(provider, id),
			complete: async (calledModel, context, completeOptions) => {
				calls.push({ model: calledModel, context, options: completeOptions });
				return options.complete?.(context) ?? assistant('{"title": "Refactor auth module"}');
			},
		},
	};

	return {
		fire: (event, event_, eventCtx) => handlers.get(event)?.(event_, eventCtx ?? ctx),
		settle,
		execCalls: async () => {
			await settle();
			return execs.splice(0, execs.length);
		},
		modelCalls: () => calls.splice(0, calls.length),
		setSessionName: (name) => { session.name = name; },
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

/** 新建一个无名会话并送来第一条人类消息。 */
function startFresh(s: Setup, prompt: string) {
	s.setSessionName(undefined);
	s.fire("session_start", { type: "session_start", reason: "startup" });
	s.fire("input", { type: "input", text: prompt, source: "interactive" });
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

test("herdr app：/name 先 ls 寻址再 tab.rename，清名传空恢复序号命名", async () => {
	const s = await setup({ variant: "app" });
	try {
		s.fire("session_info_changed", { type: "session_info_changed", name: "重构认证模块" });
		assert.deepEqual(await s.execCalls(), [
			{ command: "herdr-app", args: ["ls"] },
			{ command: "herdr-app", args: ["do", "tab.rename", "--id", "tb-1", "--name", "重构认证模块"] },
		]);

		// /name 清除会话名时同步清空标签（空名 → tab 恢复按序号命名）
		s.fire("session_info_changed", { type: "session_info_changed", name: undefined });
		assert.deepEqual(await s.execCalls(), [
			{ command: "herdr-app", args: ["ls"] },
			{ command: "herdr-app", args: ["do", "tab.rename", "--id", "tb-1", "--name", ""] },
		]);
	} finally {
		shutdown(s);
	}
});

test("herdr app：子 agent 会话更名不得触碰主 tab", async () => {
	const s = await setup({ variant: "app" });
	try {
		s.fire("session_info_changed", { type: "session_info_changed", name: "explore#a1b2c3d4" }, { ...s.ctx, mode: undefined });
		assert.deepEqual(await s.execCalls(), []);

		s.fire("session_info_changed", { type: "session_info_changed", name: "explore#a1b2c3d4" }, { ...s.ctx, mode: "print" });
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

test("herdr app：resume / 切换会话后把标签重新对齐到会话名", async () => {
	const s = await setup({ variant: "app" });
	try {
		// pi 启动后内置标题会变回 `π - sess - <cwd>`，标签得重新对齐回会话名。
		s.fire("session_start", { type: "session_start", reason: "resume" });
		assert.deepEqual(await s.execCalls(), [
			{ command: "herdr-app", args: ["ls"] },
			{ command: "herdr-app", args: ["do", "tab.rename", "--id", "tb-1", "--name", "sess"] },
		]);
	} finally {
		shutdown(s);
	}
});

test("旧 herdr：resume 后把标签重新对齐到会话名", async () => {
	const s = await setup({ variant: "legacy" });
	try {
		s.fire("session_start", { type: "session_start", reason: "resume" });
		assert.deepEqual(await s.execCalls(), [
			{ command: "herdr-stub", args: ["tab", "rename", "tab-1", "sess"] },
		]);
	} finally {
		shutdown(s);
	}
});

test("herdr 两代：无名会话启动时不动标签", async () => {
	for (const variant of ["legacy", "app"] as const) {
		const s = await setup({ variant });
		try {
			s.fire("session_start", { type: "session_start", reason: "startup" }, {
				...s.ctx,
				sessionManager: { ...s.ctx.sessionManager, getSessionName: () => undefined },
			});
			assert.deepEqual(await s.execCalls(), []);
		} finally {
			shutdown(s);
		}
	}
});

test("herdr 两代：子 agent 会话启动不得触碰主标签", async () => {
	for (const variant of ["legacy", "app"] as const) {
		const s = await setup({ variant });
		try {
			s.fire("session_start", { type: "session_start", reason: "startup" }, { ...s.ctx, mode: "print" });
			assert.deepEqual(await s.execCalls(), []);
		} finally {
			shutdown(s);
		}
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

// ─── 自动标签名（仅 herdr app） ───

test("自动命名：新会话首条消息交给模型起名并写进 tab", async () => {
	const s = await setup({ variant: "app" });
	try {
		startFresh(s, "把认证模块重构一下");
		const calls = s.modelCalls();
		assert.equal(calls.length, 1);
		assert.equal(calls[0].context.systemPrompt, piTitlePrompt.autoName.system);
		assert.equal(calls[0].context.messages[0].content[0].text, "把认证模块重构一下");
		assert.equal(calls[0].options?.cacheRetention, "none");
		assert.deepEqual(calls[0].model, { provider: "main", id: "big" });

		assert.deepEqual(await s.execCalls(), [
			{ command: "herdr-app", args: ["ls"] },
			{ command: "herdr-app", args: ["do", "tab.rename", "--id", "tb-1", "--name", "Refactor auth module"] },
		]);
	} finally {
		shutdown(s);
	}
});

test("自动命名：resume / fork / reload 不回溯命名", async () => {
	for (const reason of ["resume", "fork", "reload"] as const) {
		const s = await setup({ variant: "app", sessionName: undefined, userMessages: 1 });
		try {
			s.fire("session_start", { type: "session_start", reason });
			s.fire("input", { type: "input", text: "接着干", source: "interactive" });
			await s.settle();
			assert.deepEqual(s.modelCalls(), []);
			assert.deepEqual(await s.execCalls(), []);
		} finally {
			shutdown(s);
		}
	}
});

test("自动命名：pi -c 的启动事件也是 startup，已有对话就不命名", async () => {
	// session 在扩展加载前就打开，`pi -c` 不会报 resume；只能靠会话里有没有真人消息判断
	const s = await setup({ variant: "app", sessionName: undefined, userMessages: 2 });
	try {
		s.fire("session_start", { type: "session_start", reason: "startup" });
		s.fire("input", { type: "input", text: "继续，把日志写在错误分支里", source: "interactive" });
		await s.settle();
		assert.deepEqual(s.modelCalls(), []);
		assert.deepEqual(await s.execCalls(), []);
	} finally {
		shutdown(s);
	}
});

test("自动命名：fork 出来的空会话也不参与", async () => {
	const s = await setup({ variant: "app", sessionName: undefined });
	try {
		s.fire("session_start", { type: "session_start", reason: "fork" });
		s.fire("input", { type: "input", text: "接着干", source: "interactive" });
		await s.settle();
		assert.deepEqual(s.modelCalls(), []);
	} finally {
		shutdown(s);
	}
});

test("自动命名：斜杠命令、扩展来源、空文本不消耗唯一一次机会", async () => {
	const s = await setup({ variant: "app" });
	try {
		s.setSessionName(undefined);
		s.fire("session_start", { type: "session_start", reason: "startup" });

		s.fire("input", { type: "input", text: "/skill:pdf-tools extract", source: "interactive" });
		s.fire("input", { type: "input", text: "定时任务的正文", source: "extension" });
		s.fire("input", { type: "input", text: "   ", source: "interactive" });
		await s.settle();
		assert.deepEqual(s.modelCalls(), []);

		// 真正的人类第一句才触发，且只触发一次
		s.fire("input", { type: "input", text: "修一下登录按钮", source: "interactive" });
		s.fire("input", { type: "input", text: "再补充一句", source: "interactive" });
		await s.settle();
		assert.equal(s.modelCalls().length, 1);
		assert.deepEqual(await s.execCalls(), [
			{ command: "herdr-app", args: ["ls"] },
			{ command: "herdr-app", args: ["do", "tab.rename", "--id", "tb-1", "--name", "Refactor auth module"] },
		]);
	} finally {
		shutdown(s);
	}
});

test("自动命名：会话已有名字时不调用模型", async () => {
	const s = await setup({ variant: "app", sessionName: "sess" });
	try {
		s.fire("session_start", { type: "session_start", reason: "startup" });
		s.fire("input", { type: "input", text: "随便说一句", source: "interactive" });
		await s.settle();
		assert.deepEqual(s.modelCalls(), []);
		// 启动时的对齐照常发生，且只有那一次
		assert.deepEqual(await s.execCalls(), [
			{ command: "herdr-app", args: ["ls"] },
			{ command: "herdr-app", args: ["do", "tab.rename", "--id", "tb-1", "--name", "sess"] },
		]);
	} finally {
		shutdown(s);
	}
});

test("自动命名：模型连续失败三次后放弃，后续消息不再尝试", async () => {
	const s = await setup({
		variant: "app",
		complete: async () => {
			throw new Error("model down");
		},
	});
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		startFresh(s, "第一次就失败了");
		await s.settle();
		assert.equal(s.modelCalls().length, 1, "第一次尝试");

		mock.timers.tick(1000);
		await s.settle();
		assert.equal(s.modelCalls().length, 1, "第二次尝试（1s 退避后）");

		mock.timers.tick(3000);
		await s.settle();
		assert.equal(s.modelCalls().length, 1, "第三次尝试（再 3s 退避后）");
		assert.deepEqual(await s.execCalls(), []);

		// 一次性：后续消息不再花模型调用
		s.fire("input", { type: "input", text: "再试一次", source: "interactive" });
		await s.settle();
		assert.deepEqual(s.modelCalls(), []);
	} finally {
		mock.timers.reset();
		shutdown(s);
	}
});

test("自动命名：第一次失败、第二次成功也能落定", async () => {
	let attempts = 0;
	const s = await setup({
		variant: "app",
		complete: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("rate limited");
			return assistant('```json\n{"title": "Fix the login button"}\n```');
		},
	});
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		startFresh(s, "登录按钮点不动");
		await s.settle();

		mock.timers.tick(1000);
		await s.settle();
		assert.deepEqual(await s.execCalls(), [
			{ command: "herdr-app", args: ["ls"] },
			{ command: "herdr-app", args: ["do", "tab.rename", "--id", "tb-1", "--name", "Fix the login button"] },
		]);
	} finally {
		mock.timers.reset();
		shutdown(s);
	}
});

test("自动命名：生成期间 /name 抢先时不覆盖人名", async () => {
	let resolveComplete: ((message: AssistantLike) => void) | undefined;
	const s = await setup({
		variant: "app",
		complete: () => new Promise<AssistantLike>((resolve) => { resolveComplete = resolve; }),
	});
	try {
		startFresh(s, "重构认证模块");

		// 模型还在飞的时候用户 /name
		s.setSessionName("人工命名");
		s.fire("session_info_changed", { type: "session_info_changed", name: "人工命名" });
		resolveComplete?.(assistant('{"title": "Refactor auth module"}'));
		await s.settle();

		assert.deepEqual(await s.execCalls(), [
			{ command: "herdr-app", args: ["ls"] },
			{ command: "herdr-app", args: ["do", "tab.rename", "--id", "tb-1", "--name", "人工命名"] },
		]);
	} finally {
		shutdown(s);
	}
});

test("自动命名：生成期间切了会话，不拿旧会话的结果改新 tab", async () => {
	let resolveComplete: ((message: AssistantLike) => void) | undefined;
	const s = await setup({
		variant: "app",
		sessionName: undefined,
		complete: () => new Promise<AssistantLike>((resolve) => { resolveComplete = resolve; }),
	});
	try {
		startFresh(s, "旧会话的任务");

		// /new：换一个 sessionManager 并发出 session_start
		const next = { name: undefined as string | undefined };
		s.ctx.sessionManager = {
			getSessionName: () => next.name,
			getEntries: () => [],
		};
		s.fire("session_start", { type: "session_start", reason: "new" });
		await s.settle();

		resolveComplete?.(assistant('{"title": "Old session title"}'));
		await s.settle();
		assert.deepEqual(await s.execCalls(), []);
	} finally {
		shutdown(s);
	}
});

test("自动命名：autoName=false 时不调用模型，/name 同步照旧", async () => {
	const s = await setup({ variant: "app", settings: { "pi-title": { autoName: false } } });
	try {
		startFresh(s, "随便说一句");
		await s.settle();
		assert.deepEqual(s.modelCalls(), []);
		assert.deepEqual(await s.execCalls(), []);

		s.fire("session_info_changed", { type: "session_info_changed", name: "重构认证模块" });
		assert.deepEqual(await s.execCalls(), [
			{ command: "herdr-app", args: ["ls"] },
			{ command: "herdr-app", args: ["do", "tab.rename", "--id", "tb-1", "--name", "重构认证模块"] },
		]);
	} finally {
		shutdown(s);
	}
});

test("自动命名：autoNameModel 能解析就用它", async () => {
	const cheap = { provider: "anthropic", id: "haiku" };
	const s = await setup({
		variant: "app",
		settings: { "pi-title": { autoNameModel: "anthropic/haiku" } },
		find: (provider, id) => (provider === "anthropic" && id === "haiku" ? cheap : undefined),
	});
	try {
		startFresh(s, "起个名字");
		assert.deepEqual(s.modelCalls()[0].model, cheap);
	} finally {
		shutdown(s);
	}
});

test("自动命名：autoNameModel 解析失败时回落当前会话模型", async () => {
	const s = await setup({
		variant: "app",
		settings: { "pi-title": { autoNameModel: "nope/missing" } },
		find: () => undefined,
	});
	try {
		startFresh(s, "起个名字");
		assert.deepEqual(s.modelCalls()[0].model, { provider: "main", id: "big" });
	} finally {
		shutdown(s);
	}
});

test("自动命名：旧 herdr 不参与", async () => {
	const s = await setup({ variant: "legacy", sessionName: undefined });
	try {
		s.fire("session_start", { type: "session_start", reason: "startup" });
		s.fire("input", { type: "input", text: "重构认证模块", source: "interactive" });
		await s.settle();
		assert.deepEqual(s.modelCalls(), []);
		assert.deepEqual(await s.execCalls(), []);
	} finally {
		shutdown(s);
	}
});

test("自动命名：子会话（非 tui）不触发模型", async () => {
	const s = await setup({ variant: "app", sessionName: undefined });
	try {
		s.fire("session_start", { type: "session_start", reason: "startup" }, { ...s.ctx, mode: "print" });
		s.fire("input", { type: "input", text: "探查一下", source: "interactive" }, { ...s.ctx, mode: "print" });
		await s.settle();
		assert.deepEqual(s.modelCalls(), []);
	} finally {
		shutdown(s);
	}
});

test("标题清洗：JSON、代码围栏、引号、空白", () => {
	assert.equal(sanitizeTitle('{"title": "Add OAuth authentication"}'), "Add OAuth authentication");
	assert.equal(sanitizeTitle('```json\n{"title":"Fix login"}\n```'), "Fix login");
	assert.equal(sanitizeTitle('  "Debug failing CI tests"  '), "Debug failing CI tests");
	assert.equal(sanitizeTitle("Refactor\n\nAPI   client"), "Refactor API client");
	// 不是 JSON 标题字段就按纯文本用；洗不出内容才算失败
	assert.equal(sanitizeTitle("Just a title"), "Just a title");
	assert.equal(sanitizeTitle('{"name": "wrong field"}'), '{"name": "wrong field"}');
	assert.equal(sanitizeTitle("   \n  "), undefined);
});

test("标题截断：按显示宽度 20 列（中文 10 字 / 英文 20 字符）", () => {
	assert.equal(fitTitle("设置页添加深色模式开关"), "设置页添加深色模式开");
	assert.equal(fitTitle("给设置页加一个深色模式开关，顺便修一下翻页"), "给设置页加一个深色模");
	// 中英混排：在空格处断开，不切掉半个词
	assert.equal(fitTitle("CI 缓存改为 pnpm store"), "CI 缓存改为 pnpm");
	assert.equal(fitTitle("Fix unresponsive login button on mobile"), "Fix unresponsive");
	// 中文标点处断开，末尾标点不留
	assert.equal(fitTitle("修复登录按钮，顺便重构一遍"), "修复登录按钮");
	// 没超宽、或没有可断的地方就不动 / 硬切
	assert.equal(fitTitle("Fix mobile login"), "Fix mobile login");
	assert.equal(fitTitle("Supercalifragilisticexpialidocious"), "Supercalifragilistic");
});
