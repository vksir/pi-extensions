import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createTabLauncher,
	createTabRenamer,
	inHerdrEnv,
	type Exec,
	type LauncherOptions,
	type TabLaunchOptions,
} from "../extensions/lib/herdr.ts";

const HERDR_ENV_KEYS = ["HERDR_ENV", "HERDR_TAB_ID", "HERDR_BIN_PATH", "HC_TERMINAL_ID"] as const;
type HerdrEnvKey = (typeof HERDR_ENV_KEYS)[number];

interface Call {
	command: string;
	args: string[];
}

/** 清空 herdr 相关 env，注入给定值后跑断言，结束后还原进程环境 */
function withEnv(values: Partial<Record<HerdrEnvKey, string>>, run: () => void | Promise<void>): Promise<void> {
	const previous = new Map(HERDR_ENV_KEYS.map((k) => [k, process.env[k]]));
	try {
		for (const k of HERDR_ENV_KEYS) delete process.env[k];
		for (const [k, v] of Object.entries(values)) process.env[k] = v;
		return Promise.resolve(run()).finally(() => {
			for (const [k, v] of previous) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		});
	} catch (error) {
		for (const [k, v] of previous) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		throw error;
	}
}

/** 记录 CLI 调用的假 exec，所有命令返回成功 */
function fakeExec(): { exec: Exec; calls: Call[] } {
	const calls: Call[] = [];
	const exec: Exec = async (command, args) => {
		calls.push({ command, args });
		return { code: 0, stdout: "", stderr: "" };
	};
	return { exec, calls };
}

test("env 全部未设置：不在 herdr 环境，renamer 为空", () => {
	withEnv({}, () => {
		assert.equal(inHerdrEnv(), false);
		const { exec } = fakeExec();
		assert.equal(createTabRenamer(exec), undefined);
	});
});

test("旧 herdr 全套 env：HERDR_ENV=1 算 herdr，rename 走 herdr CLI tab rename", async () => {
	await withEnv({ HERDR_ENV: "1", HERDR_TAB_ID: "tab-1", HERDR_BIN_PATH: "herdr-stub" }, async () => {
		assert.equal(inHerdrEnv(), true);
		const { exec, calls } = fakeExec();
		await createTabRenamer(exec)!.rename("重构认证模块");
		assert.deepEqual(calls, [{ command: "herdr-stub", args: ["tab", "rename", "tab-1", "重构认证模块"] }]);
	});
});

test("旧 herdr 未注入 BIN_PATH 时命令兜底 herdr", async () => {
	await withEnv({ HERDR_ENV: "1", HERDR_TAB_ID: "tab-1" }, async () => {
		const { exec, calls } = fakeExec();
		await createTabRenamer(exec)!.rename("重构认证模块");
		assert.deepEqual(calls, [{ command: "herdr", args: ["tab", "rename", "tab-1", "重构认证模块"] }]);
	});
});

test("统一 trim 规则：纯空白值视同不存在，首尾空白被剥掉", async () => {
	withEnv({ HERDR_ENV: "  ", HC_TERMINAL_ID: "   " }, () => {
		// 空串/空白的 HC_TERMINAL_ID 不把环境判成 herdr（旧 pi-notify !== undefined 的不一致已修）
		assert.equal(inHerdrEnv(), false);
		const { exec } = fakeExec();
		assert.equal(createTabRenamer(exec), undefined);
	});
	await withEnv({ HERDR_ENV: " 1 ", HERDR_TAB_ID: " tab-9 ", HERDR_BIN_PATH: " herdr-stub " }, async () => {
		assert.equal(inHerdrEnv(), true);
		const { exec, calls } = fakeExec();
		await createTabRenamer(exec)!.rename("重构认证模块");
		assert.deepEqual(calls, [{ command: "herdr-stub", args: ["tab", "rename", "tab-9", "重构认证模块"] }]);
	});
});

test("HERDR_ENV 只有恰为 1 才标记旧 herdr", () => {
	withEnv({ HERDR_ENV: "0" }, () => {
		assert.equal(inHerdrEnv(), false);
	});
	withEnv({ HERDR_ENV: "true" }, () => {
		assert.equal(inHerdrEnv(), false);
	});
});

test("herdr app：HC_TERMINAL_ID 算 herdr 环境，renamer 不再为空", () => {
	withEnv({ HC_TERMINAL_ID: "t1" }, () => {
		assert.equal(inHerdrEnv(), true);
		const { exec } = fakeExec();
		assert.notEqual(createTabRenamer(exec), undefined);
	});
});

test("herdr app（rename）：先 ls 寻址再 tab.rename，可跨 space 找到 tab", async () => {
	await withEnv({ HC_TERMINAL_ID: "t1" }, async () => {
		const ls = JSON.stringify({
			spaces: [
				{ tabs: [{ id: "tb1", terminals: [{ terminal: "t9" }] }] },
				{ tabs: [{ id: "tb2", terminals: [{ terminal: "t1" }, { terminal: "t8" }] }] },
			],
		});
		const { exec, calls } = scriptedExec([{ stdout: ls }, {}]);
		await createTabRenamer(exec)!.rename("重构认证模块");
		assert.deepEqual(calls, [
			{ command: "herdr-app", args: ["ls"] },
			{ command: "herdr-app", args: ["do", "tab.rename", "--id", "tb2", "--name", "重构认证模块"] },
		]);
	});
});

test("herdr app（rename）：清名时 --name 传空串，恢复按序号命名", async () => {
	await withEnv({ HC_TERMINAL_ID: "t1" }, async () => {
		const ls = JSON.stringify({ spaces: [{ tabs: [{ id: "tb1", terminals: [{ terminal: "t1" }] }] }] });
		const { exec, calls } = scriptedExec([{ stdout: ls }, {}]);
		await createTabRenamer(exec)!.rename("");
		assert.deepEqual(calls[1], { command: "herdr-app", args: ["do", "tab.rename", "--id", "tb1", "--name", ""] });
	});
});

test("herdr app（rename）：ls 失败或输出不合法时抛错，不发起 tab.rename", async () => {
	await withEnv({ HC_TERMINAL_ID: "t1" }, async () => {
		const { exec, calls } = scriptedExec([{ code: 1, stderr: "no window" }]);
		await assert.rejects(createTabRenamer(exec)!.rename("重构认证模块"), /ls 失败.*no window/s);
		assert.equal(calls.length, 1);
	});
	await withEnv({ HC_TERMINAL_ID: "t1" }, async () => {
		const { exec, calls } = scriptedExec([{ stdout: "not json" }]);
		await assert.rejects(createTabRenamer(exec)!.rename("重构认证模块"));
		assert.equal(calls.length, 1);
	});
});

test("herdr app（rename）：终端不在任何已打开的 tab 时抛错且不改名", async () => {
	await withEnv({ HC_TERMINAL_ID: "t1" }, async () => {
		const ls = JSON.stringify({ spaces: [{ tabs: [{ id: "tb1", terminals: [{ terminal: "t9" }] }] }] });
		const { exec, calls } = scriptedExec([{ stdout: ls }]);
		await assert.rejects(createTabRenamer(exec)!.rename("重构认证模块"), /不在任何已打开的标签/);
		assert.equal(calls.length, 1);
	});
});

test("herdr app（rename）：tab.rename 失败时抛错并带上错误详情", async () => {
	await withEnv({ HC_TERMINAL_ID: "t1" }, async () => {
		const ls = JSON.stringify({ spaces: [{ tabs: [{ id: "tb1", terminals: [{ terminal: "t1" }] }] }] });
		const { exec } = scriptedExec([{ stdout: ls }, { code: 1, stdout: '{"error":"no window"}' }]);
		await assert.rejects(createTabRenamer(exec)!.rename("重构认证模块"), /tab.rename 失败.*no window/s);
	});
});

// ---- 新标签启动（pi-btw）----

/** 记录 CLI 调用的假 exec，可按命令序号给脚本化返回值。 */
function scriptedExec(responses: { code?: number; stdout?: string; stderr?: string }[]): {
	exec: Exec;
	calls: { command: string; args: string[] }[];
} {
	const calls: { command: string; args: string[] }[] = [];
	const exec: Exec = async (command, args) => {
		calls.push({ command, args });
		return { code: 0, stdout: "", stderr: "", ...responses.shift() };
	};
	return { exec, calls };
}

const FORK_FILE = "D:/tmp/sess/abc.json";

/** 旧 herdr 路径的快速轮询参数，避免测试真睡 500ms。 */
const LEGACY_POLL: LauncherOptions = { pollMs: 1, readyTimeoutMs: 200 };

/** `agent list` 探针：agents 里 pane 的状态为 state。 */
function agentList(state: string, pane = "wF:p2"): string {
	return JSON.stringify({
		result: {
			agents: [
				{ pane_id: "wE:p1", agent: "pi", agent_status: "idle" },
				{ pane_id: pane, agent: "pi", agent_status: state },
			],
		},
	});
}
const BASE_LAUNCH: TabLaunchOptions = {
	message: "顺便看下登录页的样式 bug",
	forkSession: FORK_FILE,
	cwd: "/work/repo",
};

test("launcher：非 herdr 环境为 undefined", () => {
	withEnv({}, () => {
		const { exec } = fakeExec();
		assert.equal(createTabLauncher(exec), undefined);
	});
});

test("launcher（herdr app）：一条 tab.new，fork 与首条消息经 -- 进 argv", async () => {
	await withEnv({ HC_TERMINAL_ID: "t1" }, async () => {
		const { exec, calls } = scriptedExec([{ stdout: '{"tab":"tb1","terminal":"t9"}' }]);
		await createTabLauncher(exec)!.launch(BASE_LAUNCH);
		assert.deepEqual(calls, [
			{
				command: "herdr-app",
				args: [
					"do",
					"tab.new",
					"--folder",
					"/work/repo",
					"--argv",
					JSON.stringify(["pi", "--fork", FORK_FILE, "--", "顺便看下登录页的样式 bug"]),
				],
			},
		]);
	});
});

test("launcher（herdr app）：无 forkSession 时 argv 只有 pi -- message，cwd 缺省取进程目录", async () => {
	await withEnv({ HC_TERMINAL_ID: "t1" }, async () => {
		const { exec, calls } = scriptedExec([{}]);
		await createTabLauncher(exec)!.launch({ message: "m" });
		assert.equal(calls[0]!.args[calls[0]!.args.indexOf("--argv") + 1], JSON.stringify(["pi", "--", "m"]));
		assert.equal(calls[0]!.args[calls[0]!.args.indexOf("--folder") + 1], process.cwd());
	});
});

test("launcher（herdr app）：tab.new 失败时抛错并优先取 {\"error\"} 字段", async () => {
	await withEnv({ HC_TERMINAL_ID: "t1" }, async () => {
		const { exec, calls } = scriptedExec([{ code: 1, stdout: '{"error":"no window"}' }]);
		await assert.rejects(createTabLauncher(exec)!.launch(BASE_LAUNCH), /no window/);
		assert.equal(calls.length, 1);
	});
	await withEnv({ HC_TERMINAL_ID: "t1" }, async () => {
		const { exec } = scriptedExec([{ code: 1, stdout: "", stderr: "socket gone" }]);
		await assert.rejects(createTabLauncher(exec)!.launch(BASE_LAUNCH), /socket gone/);
	});
});

test("launcher（旧 herdr）：tab create → pane run → 等 idle → send-text + enter，不命名", async () => {
	await withEnv({ HERDR_ENV: "1", HERDR_BIN_PATH: "herdr-stub" }, async () => {
		const { exec, calls } = scriptedExec([
			{ stdout: '{"result":{"root_pane":{"pane_id":"wF:p2"}}}' }, // tab create（对象形态）
			{}, // pane run
			{ stdout: agentList("unknown") }, // 探针 1：刚检测到，尚未就绪
			{ stdout: agentList("idle") }, // 探针 2：就绪
			{}, // send-text
			{}, // send-keys enter
		]);
		await createTabLauncher(exec, LEGACY_POLL)!.launch(BASE_LAUNCH);
		assert.equal(calls.length, 6);
		assert.deepEqual(calls[0], { command: "herdr-stub", args: ["tab", "create", "--cwd", "/work/repo"] });
		assert.deepEqual(calls[1]!.args, ["pane", "run", "wF:p2", "pi", "--fork", `'${FORK_FILE}'`]);
		assert.deepEqual(calls[2]!.args, ["agent", "list"]);
		assert.deepEqual(calls[4]!.args, ["pane", "send-text", "wF:p2", "顺便看下登录页的样式 bug"]);
		assert.deepEqual(calls[5]!.args, ["pane", "send-keys", "wF:p2", "enter"]);
	});
});

test("launcher（旧 herdr）：root_pane 为 pane 详情对象时取 pane_id 字段", async () => {
	await withEnv({ HERDR_ENV: "1", HERDR_BIN_PATH: "herdr-stub" }, async () => {
		// 真实输出的形态（2026-11-05 用户现场）：root_pane 是 pane 详情而非 id 字符串
		const stdout = JSON.stringify({
			id: "cli:tab:create",
			result: {
				root_pane: {
					agent_status: "unknown",
					cwd: "D:\\Workspace\\",
					focused: false,
					pane_id: "wE:p2",
					revision: 0,
					scroll: { max_offset_from_bottom: 0, offset_from_bottom: 0 },
				},
			},
		});
		const { exec, calls } = scriptedExec([{ stdout }, {}, { stdout: agentList("idle", "wE:p2") }, {}, {}]);
		await createTabLauncher(exec, LEGACY_POLL)!.launch(BASE_LAUNCH);
		assert.equal(calls[1]!.args[2], "wE:p2");
	});
});

test("launcher（旧 herdr）：无 BIN_PATH 时兜底 herdr 命令", async () => {
	await withEnv({ HERDR_ENV: "1" }, async () => {
		const { exec, calls } = scriptedExec([
			{ stdout: '{"result":{"root_pane":"w1:p1"}}' },
			{},
			{ stdout: agentList("idle", "w1:p1") },
			{},
			{},
		]);
		await createTabLauncher(exec, LEGACY_POLL)!.launch(BASE_LAUNCH);
		assert.equal(calls[0]!.command, "herdr");
	});
});

test("launcher（旧 herdr）：tab create 输出无法解析 root_pane 时抛错且不再启动", async () => {
	await withEnv({ HERDR_ENV: "1", HERDR_BIN_PATH: "herdr-stub" }, async () => {
		const { exec, calls } = scriptedExec([{ stdout: "not json" }]);
		await assert.rejects(createTabLauncher(exec)!.launch(BASE_LAUNCH), /root_pane.*not json/s);
		assert.equal(calls.length, 1);
	});
});

test("launcher（旧 herdr）：pi 始终未就绪时超时抛错且不投递", async () => {
	await withEnv({ HERDR_ENV: "1", HERDR_BIN_PATH: "herdr-stub" }, async () => {
		const { exec, calls } = scriptedExec([
			{ stdout: '{"result":{"root_pane":"w1:p1"}}' },
			{},
			{ stdout: agentList("unknown") },
		]);
		// 脚本用尽后探针返回空输出，解析不出 idle
		await assert.rejects(
			createTabLauncher(exec, { pollMs: 1, readyTimeoutMs: 30 })!.launch(BASE_LAUNCH),
			/未在 30ms 内就绪/,
		);
		const sends = calls.filter((c) => c.args[0] === "send-text" || c.args[0] === "send-keys");
		assert.deepEqual(sends, []);
		assert.ok(calls.length > 3); // 确实轮询过多次
	});
});

test("launcher（旧 herdr）：send-text 失败时抛错", async () => {
	await withEnv({ HERDR_ENV: "1", HERDR_BIN_PATH: "herdr-stub" }, async () => {
		const { exec } = scriptedExec([
			{ stdout: '{"result":{"root_pane":"w1:p1"}}' },
			{},
			{ stdout: agentList("idle", "w1:p1") },
			{ code: 1, stderr: "pane busy" },
		]);
		await assert.rejects(createTabLauncher(exec, LEGACY_POLL)!.launch(BASE_LAUNCH), /send-text 失败.*pane busy/s);
	});
});

test("launcher：两代环境变量同时出现时按 herdr app 优先", async () => {
	await withEnv({ HERDR_ENV: "1", HERDR_TAB_ID: "tab-1", HC_TERMINAL_ID: "t1" }, async () => {
		const { exec, calls } = scriptedExec([{}]);
		await createTabLauncher(exec)!.launch(BASE_LAUNCH);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.command, "herdr-app");
	});
});
