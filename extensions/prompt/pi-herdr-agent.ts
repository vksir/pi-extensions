/**
 * pi-herdr-agent 的模型可见文案。
 *
 * 呈现场景见每条注释。规则见 ./README.md，改动前的审核流程见 docs/prompt-review.md。
 * 本文件不 import 任何扩展代码：只收已格式化的原始值。
 *
 * 去重口径：
 * - 动作的语义在工具描述里，`action` 只列可选值。
 * - 「答案会以消息回来」写在工具描述里，返回文本不再复述。
 * - 「不要睡等」只在守则里，守则挂 `agent_job`（最深一层没有 `agent` 工具）。
 * - 可见范围不进文案：模型看不到的 agent，本来就不会出现在它的参数里。
 */

/** 错误结果的统一前缀。 */
export const ERROR_PREFIX = "Error: ";

export const piHerdrAgentPrompt = {
	// ─── 常驻·工具声明（每次请求随参数 schema 序列化） ───

	declarations: {
		agent: {
			// 常驻·工具声明。参数规则只在参数描述里，这里不再复述。
			description:
				"Start a sub-agent in its own terminal. It runs a separate pi session; the answer comes back as a message when it finishes.",
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
			// 常驻·工具声明。三个动作的语义都写在这里。
			description:
				"The list action returns the running agents. " +
				"The ask action sends a message and the answer comes back as a message when the target finishes; a busy target queues it. " +
				"The stop action ends one of your own descendants.",
			parameters: {
				action: "One of: list, ask, stop.",
				id: "Agent id. Required for every action except list.",
				message: "Message for ask.",
			},
		},
	},

	// ─── 常驻·系统提示词 ───

	system: {
		snippets: {
			agent: "Start a sub-agent that reports back by message",
			// 动作名与 action 的枚举值逐字一致，避免模型在两套词之间做映射。
			agentJob: "List, message, or stop sub-agents",
		},
		/**
		 * 常驻·系统提示词：Guidelines 段的规则。挂在 `agent_job` 上——它全深度都有，
		 * 而 `agent` 在树深上限那一层不会注册。
		 */
		guidelines: {
			agentJob: "Do not sleep or poll to wait for an agent you started or messaged.",
		},
	},

	// ─── 每次调用·工具返回 ───

	results: {
		/** 每次调用。`agent` 启动成功。 */
		startedAgent: (id: string, name: string) => `Started agent ${id} as '${name}'.`,

		/** 每次调用。`agent` resume 成功。 */
		resumedAgent: (id: string, name: string) => `Resumed agent ${id} as '${name}'.`,

		/** 每次调用。`agent_job list` 没有 agent。 */
		listEmpty: () => "No agents are running.",

		/** 每次调用。`agent_job ask` 投递成功。 */
		asked: (id: string, name: string) => `Asked ${id} (${name}).`,

		/** 每次调用。`agent_job stop` 成功。 */
		stopped: (id: string) => `Stopped agent ${id}.`,

		errors: {
			/** 每次调用。 */
			idRequired: (action: string) => `id is required for ${action}.`,
			/** 每次调用。 */
			messageRequired: (action: string) => `message is required for ${action}.`,
			/** 每次调用。 */
			notRunning: (id: string) => `agent '${id}' is not running.`,
			/** 每次调用。 */
			notDescendant: (id: string) => `agent '${id}' is not your descendant; only your own subtree can be stopped.`,
			/** 每次调用。 */
			cannotActOnSelf: (action: string) => `an agent cannot ${action} itself.`,
			/** 每次调用。 */
			noId: () => "could not allocate an unused agent id.",
			/** 每次调用。 */
			invalidName: (name: string, reason: string) => `invalid name '${name}': ${reason}`,
			/** 每次调用。 */
			stillRunning: (id: string) => `agent '${id}' is still running; use agent_job ask.`,
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
		/** 每次投递。子 agent 在等人工输入；`detail` 是弹窗标题，可空。 */
		blocked: (detail: string) => `Blocked waiting for human input${detail}.`,
		/** 每次投递。子 agent 在收工前退出，本轮不会再回发。 */
		exitedBeforeAnswering: (id: string) => `agent ${id} exited before answering.`,
		/** 每次投递。子 agent 退出时排队里还有待处理的消息。 */
		exitedTaskNotProcessed: (id: string) => `agent ${id} exited. Your task was not processed.`,
		/** 每次投递。文本被截断。 */
		truncatedWithPath: (path: string) => `[Output truncated. Full output: ${path}]`,
		truncated: (reason: string) => `[Output truncated: ${reason}]`,
	},
} as const;
