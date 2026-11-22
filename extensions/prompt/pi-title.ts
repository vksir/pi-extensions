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
		system: `Generate a very short, sentence-case title (2-4 words) that captures the main topic or goal of this coding session. The title is shown in a narrow tab strip, so keep it within 10 characters when the title is in Chinese and within 20 characters in English. Use sentence case: capitalize only the first word and proper nouns.

Return JSON with a single "title" field.

Good examples:
{"title": "Fix mobile login"}
{"title": "Add OAuth"}
{"title": "Debug failing CI"}
{"title": "修复移动端登录"}

Bad (too long): {"title": "Investigate and fix the mobile login button"}
Bad (too vague): {"title": "Code changes"}
Bad (wrong case): {"title": "Fix Mobile Login"}`,
	},
} as const;
