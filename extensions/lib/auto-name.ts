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

/** tab 名最多占的显示列数：中文 1 字 = 2 列，即中文 ≤ 10 字 / 英文 ≤ 20 字符。 */
export const TITLE_MAX_COLUMNS = 20;

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
 * 由调用方算作一次失败尝试。长度不在这里管，见 {@link fitTitle}。
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

/** 可以在它前面断开标题的字符：空白与中英文标点。 */
const BREAK_AFTER = " ，。、；：！？,.;:!?·—-";

/** 按显示宽度截断标题：CJK / 全角字符算 2 列，其余 1 列。 */
export function fitTitle(title: string, maxColumns = TITLE_MAX_COLUMNS): string {
	if (columnWidth(title) <= maxColumns) return title;

	// 先按宽度硬切出能放下的前缀
	const chars = Array.from(title);
	let used = 0;
	let cut = chars.length;
	for (let i = 0; i < chars.length; i += 1) {
		const width = charWidth(chars[i] as string);
		if (used + width > maxColumns) {
			cut = i;
			break;
		}
		used += width;
	}
	const head = chars.slice(0, cut).join("");

	// 尽量在标点或空格处断开，不要切半个词；边界太靠前（丢了一半以上）就干脆硬切
	let at = -1;
	for (let i = head.length - 1; i >= 0; i -= 1) {
		if (BREAK_AFTER.includes(head[i] as string)) {
			at = i;
			break;
		}
	}
	const candidate = at > 0 ? head.slice(0, at) : head;
	const chosen = at > 0 && columnWidth(candidate) >= Math.floor(maxColumns / 2) ? candidate : head;
	const trimmed = chosen.replace(/[\s，。、；：！？,.;:!?·—-]+$/u, "");
	return trimmed || head;
}

/** 整串的显示宽度。 */
function columnWidth(text: string): number {
	let width = 0;
	for (const char of text) width += charWidth(char);
	return width;
}

/** 单个字符的显示宽度：CJK、假名、谚文、全角形式算 2 列。 */
function charWidth(char: string): number {
	const code = char.codePointAt(0) ?? 0;
	const wide =
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6);
	return wide ? 2 : 1;
}
