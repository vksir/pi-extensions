/**
 * pi-bg 的模型可见文案。
 *
 * 呈现场景见每条注释。规则见 ./README.md。
 * 本文件不 import 任何扩展代码：只收已格式化的原始值。
 */

/** 错误结果的统一前缀。 */
export const ERROR_PREFIX = "Error: ";

export const piBgPrompt = {
	// ─── 常驻·工具声明（每次请求随参数 schema 序列化） ───

	declarations: {
		bashBg: {
			// 常驻·工具声明。description 与内置 bash 的语义无关，独立成句。
			description:
				"Run a bash command in the background. Returns immediately; the command's output arrives as a message when it finishes.",
			// 常驻·工具声明。参数直接复用内置 bash 的 schema，这里不出现。
		},
		codemodeBg: {
			// 常驻·工具声明。
			description:
				"Run a codemode script in the background. Returns immediately; the script's result arrives as a message when it finishes.",
		},
		bgJob: {
			// 常驻·工具声明。只讲工具是什么；动作语义在 action 的枚举描述里。
			description:
				"List, show, stop, or wait for background jobs started by bash_bg and codemode_bg, or promoted from bash and codemode.",
			parameters: {
				// 常驻·工具声明。
				action:
					"list: all jobs. show: one job's command or script, status, and output. kill: stop a running job. wait: block until a job finishes; takes an id, 'any', or 'all'.",
				// 常驻·工具声明。
				id: "Background job id, or 'any' (next to finish) / 'all' (every one) for wait.",
				// 常驻·工具声明。
				timeout: "wait only: max seconds to block before returning. On timeout the job keeps running.",
			},
		},
	},

	// ─── 常驻·系统提示词 ───

	system: {
		// 常驻·系统提示词：Available tools 段的索引行。
		snippets: {
			bashBg: "Run a bash command in the background",
			codemodeBg: "Run a codemode script in the background",
			bgJob: "List, show, stop, or wait for background jobs",
		},
		/**
		 * 常驻·系统提示词：Guidelines 段的规则。
		 * 挂在 bash_bg / codemode_bg 上——工具被 prepareLoadout 隐藏时规则自动消失。
		 * 覆盖版 bash / codemode 不加载它，避免「用 bash_bg」这条建议漏进脚本视角。
		 */
		guidelines: {
			bashBg: (threshold: string) =>
				`Use bash_bg for commands that may take over ${threshold}, unless their result blocks the next step.`,
			codemodeBg: (threshold: string) =>
				`Use codemode_bg for scripts that may take over ${threshold}, unless their result blocks the next step.`,
			bgJob: "Use bg_job wait instead of sleeping.",
		},
	},

	// ─── 每次调用·工具返回 ───

	results: {
		/** 每次调用。`bash_bg` / `codemode_bg` 启动成功。 */
		started: (id: string) => `bg_job ${id} started in background.`,

		/** 每次调用。前台 bash 到点转后台。 */
		promotedBash: (id: string, ran: string, activity: string) =>
			`bash promoted to bg_job ${id} after ${ran}. Still running, ${activity}.`,

		/** 每次调用。前台 codemode 到点转后台。 */
		promotedCodemode: (id: string, ran: string, activity: string) =>
			`codemode promoted to bg_job ${id} after ${ran}. Still running, ${activity}.`,

		/** 每次调用。晋升时的活动信号：距最后一次输出多久。 */
		activityLastOutput: (ago: string) => `last output ${ago} ago`,

		/** 每次调用。晋升时的活动信号：还没有任何输出。 */
		activityNoOutput: () => "no output yet",

		/** 每次调用。codemode 晋升时的活动信号：已有几次嵌套调用，当前在跑哪一个。 */
		activityCalls: (count: number, current?: string) => {
			const noun = count === 1 ? "call" : "calls";
			return current ? `${count} ${noun} so far, current: ${current}` : `${count} ${noun} so far`;
		},

		/** 每次调用。`wait` 超时；`refs` 是逗号分隔的 `bg_job <id>` 列表。 */
		waitTimedOut: (waited: string, refs: string) =>
			`bg_job wait timed out after ${waited}. Still running: ${refs}.`,

		/** 每次调用。`wait` 时没有在跑的任务。 */
		waitNoJob: () => "bg_job wait found no running job.",

		/** 每次调用。`wait` 被父轮 Esc 取消。 */
		waitAborted: () => "wait aborted. The job keeps running.",

		/** 每次调用。`wait` 的目标早已回传过。 */
		alreadyDelivered: (id: string) => `bg_job ${id} already finished. Its output was delivered as a message.`,

		/** 每次调用。`kill` 成功。 */
		killed: (id: string) => `bg_job ${id} killed.`,

		/** 每次调用。`kill` 的目标已经结束；只有拿到退出码时才能报出耗时。 */
		alreadyFinished: (id: string, exitCode?: number, took?: string) =>
			exitCode === undefined || took === undefined
				? `bg_job ${id} already finished.`
				: `bg_job ${id} already finished with exit ${exitCode} in ${took}.`,

		/** 每次调用。`list` 的表头。 */
		listSummary: (running: number, finished: number) =>
			`bg_job list: ${running} running, ${finished} finished.`,

		/** 每次调用。`list` 没有任务。 */
		listEmpty: () => "bg_job list: no jobs.",

		/** 每次调用。`list` / `/bg` 共用的一行；表格型文本，允许 `·` 与 `—`。 */
		listRow: (ref: string, kind: string, status: string, label: string) =>
			`${ref} — ${kind} · ${status} · ${label}`,

		/** 每次调用。`show` 的头行：不带标签，输入行紧随其后。 */
		showHead: (id: string, origin: string, status: string) => `bg_job ${id} — ${origin} · ${status}`,

		/** 每次调用。`show` 的输入字段：bash 用 `command:`，codemode 用 `script:`。 */
		showInput: (field: "command" | "script", value: string) => `${field}: ${value}`,

		/** 每次调用。`show` 的在跑任务还没有任何输出。 */
		showNoOutputYet: () => "(no output yet)",

		/** 每次调用。`show` 的在跑任务：后面跟已产出的部分输出。 */
		showOutputSoFar: () => "output so far:",

		/** 每次调用。`show` 的全量输出落在临时文件时追加的一行。 */
		showFullOutput: (path: string) => `full output: ${path}`,

		/** 每次调用。空输出占位，对齐内置 bash 的写法。 */
		noOutput: () => "(no output)",

		/** 每次调用。错误：缺少 id。 */
		idRequired: (action: string) => `id is required for ${action}.`,

		/** 每次调用。错误：未知 id。 */
		unknownJob: (id: string) => `no background job with id '${id}'.`,

		/** 每次调用。错误：并发上限。 */
		tooMany: (max: number) => `too many background jobs (max ${max}).`,
	},

	// ─── 每次投递·自定义消息正文 ───

	messages: {
		/** 每次投递。完成消息的头行；表格型文本，允许 `·` 与 `—`。 */
		deliveryHead: (id: string, origin: string, label: string, status: string) =>
			`[bg_job ${id}] ${origin} · ${label} — ${status}`,
	},
} as const;
