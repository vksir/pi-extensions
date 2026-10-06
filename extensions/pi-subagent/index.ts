/**
 * pi-subagent —— 基于 Herdr 的子 Agent 委派。
 *
 * 模型侧只有一个 `agent(type, name, prompt)` 工具：
 *   - type 选择 Agent 定义（<agent-dir>/agents/*.md）
 *   - name 选择所属主会话中的子 Agent 实例
 *   - prompt 是本次派发内容
 *
 * 首次使用某个实例名时在 Herdr 新标签页中启动独立 Pi 子 Agent；同名再次派发复用原 pane。
 * 工具只在创建或提交完成后返回，不等待子 Agent 的工作轮次。
 *
 * 子 session 由主会话身份与实例名确定性定位，运行态只维护 `(ownerKey, 实例名) → pane`。
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { loadAgentDefinitions, type AgentDefinition } from "./definitions.ts";
import { createHerdr } from "./herdr.ts";
import { childSessionIdOf, herdrAgentNameOf, ownerKeyOf } from "./identity.ts";
import { closeOtherResultServers, ensureResultServer } from "./ipc.ts";
import type { BindingMessage, ResultMessage, SubagentBinding } from "./protocol.ts";
import { getRuntime, removeRuntime, runtimeKey, runtimeStore, setRuntime } from "./runtime.ts";

/** 子 Agent 启动后应立刻报告实例绑定；超过该时限视为启动异常。 */
const BINDING_TIMEOUT_MS = 15_000;

const TOOL_NAME = "agent";

/** 简短工具描述（ADR-0002）；使用目录与委派约定由提示词区块承载（后续 ticket）。 */
const TOOL_DESCRIPTION = [
	"Dispatch a work round to a specialized subagent instance.",
	"type selects the agent definition; name identifies an instance owned by this session, reusing it or starting it in a new Herdr tab.",
	"Returning means the subagent started or received the prompt - not that its work round finished.",
].join(" ");

interface DispatchDetails {
	action?: "started" | "submitted";
	name?: string;
	type?: string;
	paneId?: string;
	tabId?: string;
	childSessionId?: string;
	sessionDir?: string;
	error?: string;
}

interface StartedInstance {
	paneId: string;
	tabId: string;
	childSessionId: string;
	sessionDir: string;
}

function text(body: string, details: DispatchDetails) {
	return { content: [{ type: "text" as const, text: body }], details };
}

function fail(message: string, details: DispatchDetails = {}) {
	return text(`Error: ${message}`, { ...details, error: message });
}

type OwnerResolution = { ok: true; ownerKey: string } | { ok: false; error: string };

/**
 * ownerKey 由主会话 session ID 与 session 文件绝对路径共同确定；
 * 缺少持久 session 文件时无法稳定定位实例，只报错、不猜测。
 */
function resolveOwner(ctx: ExtensionContext): OwnerResolution {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		return {
			ok: false,
			error: "the owning session has no session file; subagent dispatch needs a persisted main session",
		};
	}
	return { ok: true, ownerKey: ownerKeyOf(ctx.sessionManager.getSessionId(), sessionFile) };
}

/** 桥接扩展的绝对路径：子 Agent 只加载它，从而能回传结果但拿不到委派工具。 */
function bridgePath(): string {
	return fileURLToPath(new URL("./bridge.ts", import.meta.url));
}

/**
 * 转译为 Pi 原生启动参数。子 Agent 与主 Agent 共用 cwd 与工作区、独立对话历史。
 * 当前只覆盖会话定位与提示词；model/thinking/tools/extensions 等字段由后续 ticket 转译。
 */
function buildPiArgs(definition: AgentDefinition, sessionDir: string, childSessionId: string, name: string): string[] {
	const args = [
		// 不加载被发现的扩展，只显式加载桥接：子 Agent 不会获得本扩展的委派工具，也不继承其他扩展行为。
		"-ne",
		"-e",
		bridgePath(),
		"--session-dir",
		sessionDir,
		"--session-id",
		childSessionId,
		"--name",
		name,
	];
	// prompt_mode 默认 replace：定义正文直接作为子 Agent 的系统提示词。
	if (definition.body) args.push("--system-prompt", definition.body);
	return args;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 校验子进程报告的绑定：身份必须与本次派发一致，且已保存的实例不能换角色。
 * 已保存实例的类型检查发生在提交 prompt 之前，不会悄悄改变现有实例。
 */
function assertBinding(binding: BindingMessage, expected: SubagentBinding): void {
	if (binding.ownerKey !== expected.ownerKey || binding.name !== expected.name || binding.type !== expected.type) {
		throw new Error(
			`the subagent process reported instance "${binding.name}" (type "${binding.type}") instead of "${expected.name}" (type "${expected.type}")`,
		);
	}
	const bound = binding.bound;
	if (bound && (bound.ownerKey !== expected.ownerKey || bound.name !== expected.name || bound.type !== expected.type)) {
		throw new Error(
			`instance "${expected.name}" is bound to type "${bound.type}" in its saved session; it cannot be dispatched as "${expected.type}". Use a different instance name.`,
		);
	}
}

/** 把工作轮次结果包装成主 Agent 可见的 follow-up：头部是关联信息，正文是完整回复原文。 */
function frameResult(message: ResultMessage): string {
	const header = [
		`[subagent result] instance="${message.name}"`,
		`type="${message.type}"`,
		`round=${message.round}`,
		`status=${message.status}`,
		`session=${message.sessionId}`,
		message.sessionFile ? `file="${message.sessionFile}"` : undefined,
	]
		.filter(Boolean)
		.join(" ");
	return `${header}\n\n${message.reply}`;
}

export default function (pi: ExtensionAPI) {
	/** 尚无运行位置、但正在创建的实例；并行同名派发共享同一次创建，避免重复启动。 */
	const pending = new Map<string, Promise<StartedInstance>>();
	/** 等待子进程启动握手的创建流程，按 (ownerKey, 实例名) 定位。 */
	const bindingWaiters = new Map<string, (message: BindingMessage) => void>();

	function waitForBinding(ownerKey: string, name: string): Promise<BindingMessage> {
		const key = runtimeKey(ownerKey, name);
		const promise = new Promise<BindingMessage>((resolve, reject) => {
			const timer = setTimeout(() => {
				bindingWaiters.delete(key);
				reject(new Error("the subagent process did not report its instance binding in time"));
			}, BINDING_TIMEOUT_MS);
			bindingWaiters.set(key, (message) => {
				clearTimeout(timer);
				bindingWaiters.delete(key);
				resolve(message);
			});
		});
		// 创建阶段就失败时没有人 await 这个 promise，这里吸收它的超时拒绝。
		void promise.catch(() => {});
		return promise;
	}

	// IPC 端点可能由上一个扩展实例创建，但注入始终走当前 runtime，因此 /reload 后结果照常进入主会话。
	runtimeStore().sink = (message) => {
		const store = runtimeStore();
		// 旧主会话的迟到结果不得注入当前主会话。
		if (!store.ownerKey || message.ownerKey !== store.ownerKey) return;
		if (message.kind === "binding") {
			bindingWaiters.get(runtimeKey(message.ownerKey, message.name))?.(message);
			return;
		}
		const running = getRuntime(message.ownerKey, message.name);
		if (!running || running.type !== message.type) return;
		// 忙时排在当前工作之后，空闲时启动新一轮；绝不 steer 打断。
		pi.sendUserMessage(frameResult(message), { deliverAs: "followUp" });
	};

	pi.on("session_start", (_event, ctx) => {
		const owner = resolveOwner(ctx);
		if (!owner.ok) return;
		runtimeStore().ownerKey = owner.ownerKey;
		closeOtherResultServers(owner.ownerKey);
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Subagent",
		description: TOOL_DESCRIPTION,
		parameters: Type.Object({
			type: Type.String({ description: "Agent definition to run, matched exactly by type name." }),
			name: Type.String({ description: "Instance name; unique within the owning session and stable across dispatches." }),
			prompt: Type.String({ description: "Self-contained instructions for this work round." }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const type = params.type.trim();
			const name = params.name.trim();
			const prompt = params.prompt;

			if (!type || !name) {
				return fail("type and name must not be empty.");
			}

			const catalog = loadAgentDefinitions(getAgentDir());
			const definition = catalog.definitions.get(type);
			if (!definition) {
				const available = [...catalog.definitions.keys()].sort();
				const list = available.length > 0 ? available.join(", ") : "(none)";
				const broken = catalog.errors.length > 0 ? ` Unreadable definitions: ${catalog.errors.join("; ")}` : "";
				return fail(`unknown agent type "${type}". Available types: ${list}.${broken}`, { name, type });
			}

			const owner = resolveOwner(ctx);
			if (!owner.ok) return fail(owner.error, { name, type });

			const herdr = createHerdr((command, args) => pi.exec(command, args), {
				herdrEnv: process.env.HERDR_ENV,
				workspaceId: process.env.HERDR_WORKSPACE_ID,
			});

			const key = runtimeKey(owner.ownerKey, name);
			const running = getRuntime(owner.ownerKey, name);
			if (running && running.type !== type) {
				return fail(
					`instance "${name}" is already bound to type "${running.type}" in this session; it cannot be dispatched as "${type}". Use a different instance name.`,
					{ name, type },
				);
			}

			if (running) {
				try {
					// 复用原 pane：不重复启动 Pi；忙碌实例的 steer 与排队行为交给 Pi 自己。
					await herdr.prompt(running.paneId, prompt);
				} catch (error) {
					return fail(
						`subagent "${name}" (type "${type}") already runs in Herdr pane ${running.paneId}, but submitting the prompt failed: ${messageOf(error)}`,
						{ name, type, paneId: running.paneId, tabId: running.tabId },
					);
				}
				return text(
					`Submitted the prompt to running subagent "${name}" (type "${type}") in its Herdr tab; its work round has not finished yet. Its result will arrive as a follow-up when the round settles.`,
					{ action: "submitted", name, type, paneId: running.paneId, tabId: running.tabId },
				);
			}

			let creation = pending.get(key);
			if (!creation) {
				creation = (async (): Promise<StartedInstance> => {
					const sessionDir = join(getAgentDir(), "pi-subagent", "sessions", owner.ownerKey);
					const childSessionId = childSessionIdOf(owner.ownerKey, name);
					const agentName = herdrAgentNameOf(owner.ownerKey, name);
					mkdirSync(sessionDir, { recursive: true });
					const pipe = (await ensureResultServer(owner.ownerKey)).path;
					// 先登记握手等待：子进程启动时就会报告绑定，可能早于 agent start 返回。
					const handshake = waitForBinding(owner.ownerKey, name);
					const tab = await herdr.createTabWithPi({
						cwd: ctx.cwd,
						label: name,
						agentName,
						piArgs: buildPiArgs(definition, sessionDir, childSessionId, name),
						env: {
							PI_SUBAGENT_OWNER_KEY: owner.ownerKey,
							PI_SUBAGENT_NAME: name,
							PI_SUBAGENT_TYPE: type,
							PI_SUBAGENT_PIPE: pipe,
						},
					});
					// 先登记运行位置再提交：提交失败时同名派发仍复用这个 pane，而不是再启动一个实例。
					setRuntime({
						ownerKey: owner.ownerKey,
						name,
						type,
						paneId: tab.paneId,
						tabId: tab.tabId,
						agentName,
						startedAt: Date.now(),
					});
					try {
						// 核对子 session 中已保存的绑定：同名不同类型必须报错，不能悄悄换角色。
						assertBinding(await handshake, { ownerKey: owner.ownerKey, name, type });
					} catch (error) {
						removeRuntime(owner.ownerKey, name);
						await herdr.closeTab(tab.tabId).catch(() => {});
						throw error;
					}
					return { paneId: tab.paneId, tabId: tab.tabId, childSessionId, sessionDir };
				})();
				pending.set(key, creation);
				void creation.then(
					() => pending.delete(key),
					() => pending.delete(key),
				);
			}

			let instance: StartedInstance;
			try {
				instance = await creation;
			} catch (error) {
				return fail(`could not start subagent "${name}" (type "${type}"): ${messageOf(error)}`, { name, type });
			}

			try {
				await herdr.prompt(instance.paneId, prompt);
			} catch (error) {
				return fail(
					`started subagent "${name}" (type "${type}") in Herdr pane ${instance.paneId}, but submitting the prompt failed: ${messageOf(error)}`,
					{ name, type, paneId: instance.paneId, tabId: instance.tabId, childSessionId: instance.childSessionId, sessionDir: instance.sessionDir },
				);
			}

			return text(
				[
					`Started subagent "${name}" (type "${type}") in a new Herdr tab and submitted the prompt.`,
					`It works in its own Pi session ${instance.childSessionId} with its own conversation history; its work round has not finished yet.`,
					"Its result will arrive as a follow-up when the round settles.",
				].join(" "),
				{
					action: "started",
					name,
					type,
					paneId: instance.paneId,
					tabId: instance.tabId,
					childSessionId: instance.childSessionId,
					sessionDir: instance.sessionDir,
				},
			);
		},
	});
}
