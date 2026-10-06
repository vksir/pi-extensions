/**
 * Herdr adapter：本扩展对 Herdr 的全部交互都经过这里。
 *
 * 只使用公开 CLI 能力：创建标签页、以交互式 Pi 启动 agent、提交 prompt、关闭标签页。
 * 不抓取终端输出获取结果，不使用 Herdr 的全局显示名作为实例身份。
 */
import type { ExecResult } from "@earendil-works/pi-coding-agent";

/** 与 `ctx.exec` 兼容的粗粒度执行入口；测试用假实现替换整个 Herdr 环境。 */
export type Exec = (command: string, args: string[]) => Promise<ExecResult>;

export interface HerdrEnvironment {
	/** 由 Herdr 注入：HERDR_ENV=1 表示当前 pi 运行在 Herdr 管理的 pane 中 */
	herdrEnv: string | undefined;
	/** 由 Herdr 注入：新标签页应归属的 workspace */
	workspaceId: string | undefined;
}

export class HerdrError extends Error {}

export interface HerdrTab {
	tabId: string;
	paneId: string;
}

export interface Herdr {
	createTabWithPi(options: {
		cwd: string;
		label: string;
		agentName: string;
		piArgs: string[];
		/** 传给新标签页进程的环境变量；子 Agent 据此得到实例身份与结果回传端点 */
		env?: Record<string, string>;
	}): Promise<HerdrTab>;
	prompt(target: string, text: string): Promise<void>;
	closeTab(tabId: string): Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function pickId(node: unknown, keys: readonly string[]): string | undefined {
	const record = asRecord(node);
	if (!record) return undefined;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

export function createHerdr(exec: Exec, env: HerdrEnvironment): Herdr {
	function ensureAvailable(): void {
		if (env.herdrEnv !== "1") {
			throw new HerdrError(
				"subagent dispatch requires Herdr: this pi process is not running inside a Herdr pane (HERDR_ENV=1 is not set).",
			);
		}
	}

	async function run(args: string[]): Promise<unknown> {
		const command = `herdr ${args.join(" ")}`;
		const result = await exec("herdr", args);
		if (result.code !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
			throw new HerdrError(`${command} failed: ${detail}`);
		}
		const stdout = result.stdout.trim();
		if (!stdout) return undefined;
		try {
			return JSON.parse(stdout) as unknown;
		} catch {
			throw new HerdrError(`${command} returned non-JSON output: ${stdout.slice(0, 200)}`);
		}
	}

	async function closeTab(tabId: string): Promise<void> {
		ensureAvailable();
		await run(["tab", "close", tabId]);
	}

	return {
		async createTabWithPi({ cwd, label, agentName, piArgs, env: childEnv }) {
			ensureAvailable();
			const createArgs = ["tab", "create", "--cwd", cwd, "--label", label, "--no-focus"];
			if (env.workspaceId) createArgs.push("--workspace", env.workspaceId);
			for (const [key, value] of Object.entries(childEnv ?? {})) createArgs.push("--env", `${key}=${value}`);
			const created = await run(createArgs);
			const result = asRecord(asRecord(created)?.result) ?? asRecord(created);
			const tabId = pickId(result?.tab, ["tab_id", "id"]);
			const paneId = pickId(result?.root_pane, ["pane_id", "id"]);
			if (!tabId || !paneId) {
				throw new HerdrError("herdr tab create did not return a tab id and pane id");
			}
			try {
				await run(["agent", "start", agentName, "--kind", "pi", "--pane", paneId, "--", ...piArgs]);
			} catch (error) {
				// 启动失败不留半成品标签页；关闭失败不掩盖原始错误。
				await closeTab(tabId).catch(() => {});
				throw error;
			}
			return { tabId, paneId };
		},

		async prompt(target, text) {
			ensureAvailable();
			// 不等待子 Agent 的工作轮次结束：只提交，提交后立即返回。
			await run(["agent", "prompt", target, text]);
		},

		closeTab,
	};
}
