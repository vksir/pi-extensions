/**
 * pi-herdr-agent 的模型可见文案。
 *
 * 呈现场景见每条注释。规则见 ./README.md。
 * 本文件不 import 任何扩展代码：只收已格式化的原始值。
 *
 * 去重口径（2026-02）：`agent` 的描述不再复述 `name` / `model` / `thinking` / `resume` /
 * `destroyAfterSeconds` 的规则；
 * `agent_job` 的动作枚举只出现在 snippet（索引）与 `action` 枚举（语义）两处，
 * 「忙是错误」「答案作为消息到达」「只能杀自己的后代」各只留一份。
 */

/** 错误结果的统一前缀。 */
export const ERROR_PREFIX = "Error: ";

export const piHerdrAgentPrompt = {
	// ─── 常驻·工具声明（每次请求随参数 schema 序列化） ───

	declarations: {
		agent: {
			// 常驻·工具声明。参数规则只在参数描述里，这里不再复述。
			description:
				"Start a sub-agent in its own terminal. It runs a separate pi session and sends its final answer back as a message.",
			parameters: {
				prompt: "The task for the sub-agent.",
				name: "Sidebar name: 1-32 chars of a-z, 0-9, '.', '_' or '-', unique among running agents. Defaults to the agent id.",
				model: "Model as provider/id or a fuzzy name. Defaults to your current model.",
				thinking: "Thinking level. Defaults to yours.",
				resume:
					"Agent id whose exited session to continue instead of starting a new one. Model and thinking must match the session. A destroyed agent can be resumed by its id.",
				destroyAfterSeconds:
					"Seconds of idleness before the agent's terminal is destroyed. Default 180. 0 never destroys it.",
			},
		},
		agentJob: {
			// 常驻·工具声明。跨动作的权限约束；单动作语义在 action 枚举里。
			description: "Manage the sub-agents you started. Only your own descendants can be killed.",
			parameters: {
				action:
					"list: running agents. wait: block until a sub-agent stops working; takes an id, 'any', or 'all'. kill: end one of your own descendants. ask: send a request to an idle agent; busy is an error and the answer arrives as a message. steer: insert a message into a working agent.",
				id: "Agent id, or 'any' (next to stop) / 'all' (every one) for wait.",
				message: "Message for ask and steer.",
				timeout: "wait only: max seconds before returning. A timeout is a check-in, not a failure.",
			},
		},
	},

	// ─── 常驻·系统提示词 ───

	system: {
		snippets: {
			agent: "Start a sub-agent that reports back by message",
			// 动作名与 action 的枚举值逐字一致，避免模型在两套词之间做映射。
			agentJob: "List, wait, kill, ask, or steer sub-agents",
		},
		/**
		 * 常驻·系统提示词：Guidelines 段的规则。挂在 `agent_job` 上——工具被
		 * prepareLoadout 隐藏时规则自动消失。只防 sleep；any / all 的含义在 id 参数描述里。
		 */
		guidelines: {
			agentJob: "Use agent_job wait instead of sleeping.",
		},
	},

	// ─── 每次调用·工具返回 ───

	results: {
		/** 每次调用。`agent` 启动成功。 */
		startedAgent: (id: string, name: string) =>
			`Started agent ${id} as '${name}'. Its final answer will arrive as a message.`,

		/** 每次调用。`agent` resume 成功。 */
		resumedAgent: (id: string, name: string) =>
			`Resumed agent ${id} as '${name}'. Its final answer will arrive as a message.`,

		/** 每次调用。`agent_job list` 没有 agent。 */
		listEmpty: () => "No agents are running.",

		/** 每次调用。`agent_job wait` 的结果。 */
		waitStillRunning: (label: string, status: string, turn: number) =>
			`${label}: still running (${status}, turn ${turn}).`,
		waitExited: (label: string, code: string) => `${label}: exited (code ${code}).`,
		waitStatus: (label: string, status: string, turn: number) => `${label}: ${status} (turn ${turn}).`,
		/** 每次调用。`agent_job wait` 没有在 working 的子 agent。 */
		noAgentWorking: () => "No agent is working.",
		/** 每次调用。`agent_job wait` 超时；`waited` 是已格式化的「 after 5s」，未知时为空串。 */
		waitTimedOut: (waited: string, refs: string) =>
			`agent_job wait timed out${waited}. Still running: ${refs}.`,
		/** 每次调用。父轮 Esc 打断了「等」。 */
		waitAborted: () => "wait aborted. The agent keeps running.",
		/** 每次调用。等待被一条与子 agent 无关的消息打断。 */
		waitMessage: () => "wait ended by an incoming message.",

		/** 每次调用。`agent_job kill` 成功。 */
		killed: (id: string) => `Killed agent ${id}.`,

		/** 每次调用。`agent_job ask` 投递成功；`pending` 是「还没开始干活」的补充。 */
		asked: (id: string, name: string, pending: string) =>
			`Asked ${id} (${name}). Its answer will arrive as a message when the turn ends.${pending}`,

		/** 每次调用。`ask` 已投递但对方尚未开始。 */
		askPending: () => " It has not started working yet.",

		/** 每次调用。`agent_job steer` 成功。 */
		steered: (id: string, name: string) => `Steered ${id} (${name}).`,

		errors: {
			/** 每次调用。 */
			idRequired: (action: string) => `id is required for ${action}.`,
			/** 每次调用。 */
			messageRequired: (action: string) => `message is required for ${action}.`,
			/** 每次调用。 */
			notRunning: (id: string) => `agent '${id}' is not running.`,
			/** 每次调用。 */
			notDescendant: (id: string) => `agent '${id}' is not your descendant; only your own subtree can be killed.`,
			/** 每次调用。 */
			cannotActOnSelf: (action: string) => `an agent cannot ${action} itself.`,
			/** 每次调用。 */
			askNotIdle: (id: string, status: string) => `agent '${id}' is ${status}; ask works only when it is idle.`,
			/** 每次调用。 */
			steerNotWorking: (id: string, status: string) =>
				`agent '${id}' is ${status}; steer works only while it is running. Use ask when it is idle.`,
			/** 每次调用。 */
			noId: () => "could not allocate an unused agent id.",
			/** 每次调用。 */
			invalidName: (name: string, reason: string) => `invalid name '${name}': ${reason}`,
			/** 每次调用。 */
			stillRunning: (id: string) => `agent '${id}' is still running; use agent_job ask or agent_job steer.`,
			/** 每次调用。 */
			noSession: (id: string) => `no session for agent '${id}'.`,
			/** 每次调用。 */
			noSessionCwd: (id: string) => `session for agent '${id}' has no working directory.`,
			/** 每次调用。 */
			unknownModel: (model: string) => `unknown model '${model}'. Pass provider/id.`,
			/** 每次调用。 */
			resumeModelMismatch: (id: string, provider: string, model: string) =>
				`agent '${id}' runs ${provider}/${model}; resume cannot switch models.`,
			/** 每次调用。 */
			resumeThinkingMissing: (id: string) =>
				`agent '${id}' has no recorded thinking level; resume cannot verify it.`,
			/** 每次调用。 */
			resumeThinkingMismatch: (id: string, thinking: string) =>
				`agent '${id}' uses thinking '${thinking}'; resume cannot switch thinking levels.`,
			/** 每次调用。herdr-core 的错误码翻成的模型可读消息。 */
			terminalNotFound: () => "terminal not found.",
			terminalExited: () => "terminal has exited.",
			terminalBlocked: () => "terminal is blocked on a dialog.",
			terminalStatusMismatch: () => "status mismatch.",
			agentExited: (id: string) => `agent '${id}' has exited.`,
			agentBlocked: (id: string) => `agent '${id}' is blocked on a dialog; answer it in its terminal first.`,
			agentStatusMismatch: (id: string) => `agent '${id}' changed state; the action needs the documented state.`,
			nameTaken: () => "name is already used by a running agent.",
			spawnFailed: (message: string) => `could not start pi in a new terminal: ${message}`,
			coreError: (kind: string, message: string) => `herdr-core ${kind}: ${message}`,
		},
	},

	// ─── 每次投递·自定义消息正文 ───

	reports: {
		/** 每次投递。本轮没有文本输出。 */
		noText: () => "No text output this turn.",
		/** 每次投递。run 被中止。 */
		runAborted: () => "Run aborted.",
		/** 每次投递。另一个 ask 已经占着这一轮。 */
		busy: () => "Busy: another request is already pending. Try again when this agent is idle.",
		/** 每次投递。子 agent 在等人工输入；`detail` 是弹窗标题，可空。 */
		blocked: (detail: string) => `Blocked waiting for human input${detail}.`,
		/** 每次投递。文本被截断。 */
		truncatedWithPath: (path: string) => `[Output truncated. Full output: ${path}]`,
		truncated: (reason: string) => `[Output truncated: ${reason}]`,
	},
} as const;
