/**
 * pi-progress 的模型可见文案。
 *
 * 呈现场景见每条注释。规则见 ./README.md。
 * 本文件不 import 任何扩展代码：只收已格式化的原始值。
 */

/** 错误结果的统一前缀。 */
export const ERROR_PREFIX = "Error: ";

export const piProgressPrompt = {
	// ─── 常驻·工具声明（每次请求随参数 schema 序列化） ───

	declarations: {
		progress: {
			// 常驻·工具声明。只讲用途与调用时机，格式约束留给字段 text。
			description:
				"Report your progress to the user. On long or complex tasks, call it when you start a stage or switch approach.",
			parameters: {
				// 常驻·工具声明。
				text: "One short sentence. Say what you are doing now, not what you already did.",
			},
		},
	},

	// ─── 常驻·系统提示词（工具索引行） ───

	system: {
		snippets: {
			// 常驻·系统提示词。索引行只回答「有这个工具」。
			progress: "Report progress to the user",
		},
	},

	// ─── 每次调用·工具返回 ───

	results: {
		/** 每次调用。设置成功。 */
		shown: () => "progress set.",

		errors: {
			/** 每次调用。 */
			empty: () => "progress text is empty.",
			/** 每次调用。 */
			tooLong: (max: number) => `progress text is longer than ${max} characters.`,
		},
	},
} as const;
