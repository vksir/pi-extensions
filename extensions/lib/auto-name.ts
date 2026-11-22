/**
 * 自动标签名：标题清洗，以及「同一触发内最多尝试几次」的重试循环。
 *
 * 只有 pi-title 用（herdr app 的 tab 自动命名）。依赖全部注入：模型调用、
 * 会话是否已被 /name 命名、把标题写出去、退避时长——测试可换成假实现。
 *
 * 语义（见 ADR-0012）：
 * - 尝试次数由 delaysMs 的长度决定，第 n 次尝试前等 delaysMs[n] 毫秒；
 * - 每次尝试前检查会话是否已被 /name 命名，被抢名就整体放弃；
 * - 生成成功但会话在生成期间被 /name 命名，同样放弃（不覆盖人名）；
 * - 抛错、返回空标题都只算一次失败，继续下一次尝试；
 * - 本函数不重试写入失败：更名是显示层的锦上添花，写不出去就作罢。
 */

/** 第 n 次尝试前的退避毫秒数；长度即尝试次数。 */
export const AUTO_NAME_DELAYS_MS: readonly number[] = [0, 1000, 3000];

export interface AutoNameOptions {
	/** 生成一次标题；抛错或返回空都算这次尝试失败。 */
	attempt(): Promise<string | undefined>;
	/** 会话是否已被 /name 命名（标题模型可能跑在人命名之后）。 */
	isNamed(): boolean;
	/** 拿到标题后写出去；失败由调用方自行处置。 */
	apply(title: string): void;
	/** 覆盖退避时长；默认 {@link AUTO_NAME_DELAYS_MS}。 */
	delaysMs?: readonly number[];
	/** 覆盖等待实现；测试注入为立即返回。 */
	sleep?(ms: number): Promise<void>;
}

/** 按退避序列反复取标题，第一次成功即写出并结束。 */
export async function runAutoName(options: AutoNameOptions): Promise<void> {
	const { attempt, isNamed, apply, delaysMs = AUTO_NAME_DELAYS_MS, sleep = wait } = options;
	for (const delay of delaysMs) {
		if (delay > 0) await sleep(delay);
		if (isNamed()) return;

		let title: string | undefined;
		try {
			title = await attempt();
		} catch {
			title = undefined; // 网络、认证、模型选择等失败一律按「这次没拿到」处理
		}
		if (!title) continue;
		if (isNamed()) return; // 生成期间被 /name 抢名
		apply(title);
		return;
	}
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把模型返回的一段文本清洗成单行标题：去掉代码块围栏、取出 `{"title": …}`
 * 的字段、折叠换行与连续空白、剥掉包裹引号。清洗后为空返回 undefined，
 * 由调用方算作一次失败尝试。
 */
export function sanitizeTitle(raw: string): string | undefined {
	let text = raw.trim();
	text = text.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "");
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && "title" in parsed) {
			const title = (parsed as { title: unknown }).title;
			if (typeof title === "string") text = title;
		}
	} catch {
		// 不是 JSON：模型直接给了一句，按纯文本用
	}
	text = text.replace(/\s+/g, " ").trim();
	text = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
	return text || undefined;
}
