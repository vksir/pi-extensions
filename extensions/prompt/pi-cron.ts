/**
 * pi-cron 的模型可见文案。
 *
 * 呈现场景见每条注释。规则见 ./README.md。
 * 本文件不 import 任何扩展代码：只收已格式化的原始值。
 */

/** 错误结果的统一前缀。 */
export const ERROR_PREFIX = "Error: ";

export const piCronPrompt = {
	// ─── 常驻·工具声明（每次请求随参数 schema 序列化） ───

	declarations: {
		cron: {
			// 常驻·工具声明。进程级存续域原本每次都写在返回文本里，改为一处常驻。
			description:
				"Create, list, or delete cron jobs; a cron job delivers a prompt to you on a cron schedule. Cron jobs are process-scoped and are cleared when pi exits.",
			parameters: {
				// 常驻·工具声明。
				action: "create: schedule a cron job. list: show cron jobs. delete: cancel a cron job by id.",
				// 常驻·工具声明。
				cron: "5-field cron (minute hour day-of-month month day-of-week), local time. Required for create.",
				// 常驻·工具声明。
				prompt: "Prompt delivered verbatim on every fire. Required for create.",
				// 常驻·工具声明。
				recurring: "Default true. false = fire once, then delete the cron job.",
				// 常驻·工具声明。
				id: "Cron job id. Required for delete.",
			},
		},
	},

	// ─── 每次调用·工具返回 ───

	results: {
		/** 每次调用。循环任务创建成功；「立即执行一次」是行为约定，一次调用说一次。 */
		createdRecurring: (id: string, human: string, when: string) =>
			`cron job ${id} created (${human}, recurring). It fires next at ${when}; run its prompt now as the first iteration instead of waiting for it.`,

		/** 每次调用。一次性任务创建成功。 */
		createdOnce: (id: string, human: string, when: string) =>
			`cron job ${id} created (${human}, one-shot). It fires once at ${when}, then deletes itself.`,

		/** 每次调用。没有任务。 */
		listEmpty: () => "cron list: no jobs.",

		/** 每次调用。列表行；表格型文本，允许 `·` 与 `—`。 */
		listRow: (id: string, human: string, cron: string, next: string, flags: string, preview: string) =>
			`${id} — ${human} (${cron}) · ${next}${flags}: ${preview}`,

		/** 每次调用。删除成功。 */
		deleted: (id: string) => `cron job ${id} deleted.`,

		errors: {
			/** 每次调用。 */
			createMissing: () => "create requires both cron and prompt.",
			/** 每次调用。 */
			invalidCron: (cron: string) =>
				`invalid cron expression '${cron}'. Expected 5 fields: minute hour day-of-month month day-of-week.`,
			/** 每次调用。 */
			noMatch: (cron: string) => `cron expression '${cron}' does not match any calendar date in the next year.`,
			/** 每次调用。 */
			tooMany: (max: number) => `too many cron jobs (max ${max}).`,
			/** 每次调用。 */
			idRequired: () => "id is required for delete.",
			/** 每次调用。 */
			unknownJob: (id: string) => `no cron job with id '${id}'.`,
			/** 每次调用。 */
			unknownAction: (action: string) => `unknown action '${action}'.`,
		},
	},
} as const;
