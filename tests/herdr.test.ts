import assert from "node:assert/strict";
import { test } from "node:test";
import { createTabRenamer, inHerdrEnv, type Exec } from "../extensions/lib/herdr.ts";

const HERDR_ENV_KEYS = ["HERDR_ENV", "HERDR_TAB_ID", "HERDR_BIN_PATH", "HC_TERMINAL_ID"] as const;
type HerdrEnvKey = (typeof HERDR_ENV_KEYS)[number];

interface Call {
	command: string;
	args: string[];
}

/** 清空 herdr 相关 env，注入给定值后跑断言（含异步），结束后还原进程环境 */
async function withEnv(values: Partial<Record<HerdrEnvKey, string>>, run: () => void | Promise<void>): Promise<void> {
	const previous = new Map(HERDR_ENV_KEYS.map((k) => [k, process.env[k]]));
	try {
		for (const k of HERDR_ENV_KEYS) delete process.env[k];
		for (const [k, v] of Object.entries(values)) process.env[k] = v;
		await run();
	} finally {
		for (const [k, v] of previous) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

/** 记录 CLI 调用的假 exec：herdr-app ls 返回包含当前 HC_TERMINAL_ID 的标签树 */
function fakeExec(options: { failNextLs?: boolean } = {}): { exec: Exec; calls: Call[] } {
	const calls: Call[] = [];
	let lsFailures = options.failNextLs ? 1 : 0;
	const exec: Exec = async (command, args) => {
		calls.push({ command, args });
		if (args[0] === "ls") {
			if (lsFailures > 0) {
				lsFailures--;
				return { code: 1, stdout: "", stderr: "" };
			}
			const terminal = process.env.HC_TERMINAL_ID;
			const tree = {
				spaces: [{ tabs: [{ id: "tab-1", terminals: terminal ? [{ terminal }] : [] }] }],
			};
			return { code: 0, stdout: JSON.stringify(tree), stderr: "" };
		}
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

test("herdr app：rename 先 ls 解析标签再 tab.rename，解析结果在实例内缓存", async () => {
	await withEnv({ HC_TERMINAL_ID: "t1" }, async () => {
		const { exec, calls } = fakeExec();
		const renamer = createTabRenamer(exec)!;
		await renamer.rename("重构认证模块");
		await renamer.rename("写测试");
		assert.deepEqual(calls, [
			{ command: "herdr-app", args: ["ls"] },
			{ command: "herdr-app", args: ["do", "tab.rename", "--id", "tab-1", "--name", "重构认证模块"] },
			{ command: "herdr-app", args: ["do", "tab.rename", "--id", "tab-1", "--name", "写测试"] },
		]);
	});
});

test("herdr app：ls 解析失败静默放弃，下次 rename 重试解析", async () => {
	await withEnv({ HC_TERMINAL_ID: "t1" }, async () => {
		const { exec, calls } = fakeExec({ failNextLs: true });
		const renamer = createTabRenamer(exec)!;
		await renamer.rename("重构认证模块");
		await renamer.rename("重构认证模块");
		assert.deepEqual(calls, [
			{ command: "herdr-app", args: ["ls"] },
			{ command: "herdr-app", args: ["ls"] },
			{ command: "herdr-app", args: ["do", "tab.rename", "--id", "tab-1", "--name", "重构认证模块"] },
		]);
	});
});

test("两套 env 同时存在时优先旧 herdr，不走 ls 解析", async () => {
	await withEnv({ HERDR_ENV: "1", HERDR_TAB_ID: "tab-1", HERDR_BIN_PATH: "herdr-stub", HC_TERMINAL_ID: "t1" }, async () => {
		const { exec, calls } = fakeExec();
		await createTabRenamer(exec)!.rename("重构认证模块");
		assert.deepEqual(calls, [{ command: "herdr-stub", args: ["tab", "rename", "tab-1", "重构认证模块"] }]);
	});
});
