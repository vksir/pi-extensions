/**
 * pi-title 的模型可见文案。
 *
 * 呈现场景见每条注释。规则见 ./README.md。
 * 本文件不 import 任何扩展代码：只收已格式化的原始值。
 */

export const piTitlePrompt = {
	// ─── 每次调用·辅助模型系统提示词（herdr app tab 自动命名） ───
	// 这通调用独立于主会话：只给这一个模型看，不进主 agent 上下文。
	// 输出被 code 按 JSON 解析，解析不出来时退回纯文本（见 lib/auto-name.ts）。

	autoName: {
		system: `Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session. The title should be clear enough that the user recognizes the session in a tab list. Use sentence case: capitalize only the first word and proper nouns.

Return JSON with a single "title" field.

Good examples:
{"title": "Fix login button on mobile"}
{"title": "Add OAuth authentication"}
{"title": "Debug failing CI tests"}
{"title": "Refactor API client error handling"}

Bad (too vague): {"title": "Code changes"}
Bad (too long): {"title": "Investigate and fix the issue where the login button does not respond on mobile devices"}
Bad (wrong case): {"title": "Fix Login Button On Mobile"}`,
	},
} as const;
