/**
 * 在内置 footer 的状态行里插入输出速率。
 *
 * pi 没给 footer 留插槽：`ctx.ui.setFooter` 只能整体替换。这里不重写渲染，而是让内置
 * `FooterComponent` 照原样渲染（路径、用量、命中率、上下文占比、模型右对齐、扩展状态行
 * 都归它管），只把速率塞进用量段与缓存命中率之间，例如 `R1.5M 42t/s CH97.1%`。pi 改
 * footer 排版时不用跟着改。
 *
 * `FooterComponent` 吃的是 AgentSession，扩展上下文只给得出等价的一部分（会话管理器、
 * 当前模型、思考级别、上下文用量），下面用替身补齐 footer 真正读到的字段。替身没有
 * 虚拟模型的路由结果与订阅状态，因此 `→ 物理模型` 后缀和 `(sub)` 标记不显示。
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	FooterComponent,
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

/** FooterComponent 读到的会话视图；扩展上下文能补齐的部分都在这里。 */
type FooterSession = ConstructorParameters<typeof FooterComponent>[0];

function footerSession(ctx: ExtensionContext): FooterSession {
	// 用 getter 而不是快照：切换模型或思考级别后 footer 立即反映新值。
	const session = {
		sessionManager: ctx.sessionManager,
		get model() {
			return ctx.model;
		},
		get thinkingLevel() {
			return ctx.thinkingLevel;
		},
		get state() {
			return { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
		},
		getContextUsage: () => ctx.getContextUsage(),
		// 订阅制（OAuth 计费包）在扩展上下文里没有来源，按按量付费处理。
		modelRuntime: { isUsingSubscription: () => false },
	};
	return session as unknown as FooterSession;
}

/**
 * 输出速率（token/秒）= 最近一次完成且有耗时的 assistant 响应的 output ÷ 耗时。
 * 老会话里的消息没有 `durationMs`，跳过继续往前找；一次都没有时返回 undefined。
 */
export function outputRate(entries: readonly SessionEntry[]): number | undefined {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const { usage, durationMs } = entry.message as AssistantMessage;
		const seconds = (durationMs ?? 0) / 1000;
		if (seconds > 0 && usage.output > 0) return usage.output / seconds;
	}
	return undefined;
}

/** 两位数以上取整，个位数保留一位小数：`42t/s`、`3.4t/s`。 */
export function formatRate(rate: number): string {
	return `${rate >= 10 ? rate.toFixed(0) : rate.toFixed(1)}t/s`;
}

/**
 * 把速率插进状态行：优先落在缓存命中率之前（`R1.5M 42t/s CH97.1%`）；
 * 没有命中率时接在最后一个用量段之后。
 */
export function insertRate(statsLine: string, rate: string): string {
	const hit = statsLine.search(/ CH\d+(?:\.\d+)?%/);
	if (hit >= 0) return `${statsLine.slice(0, hit)} ${rate}${statsLine.slice(hit)}`;
	const lastUsage = [...statsLine.matchAll(/ [↑↓RW]\d+(?:\.\d+)?[kM]?/g)].at(-1);
	if (lastUsage?.index === undefined) return statsLine;
	const end = lastUsage.index + lastUsage[0].length;
	return `${statsLine.slice(0, end)} ${rate}${statsLine.slice(end)}`;
}

/**
 * 插入多占了宽度就从右侧留白里等量扣回：内置状态行用连续空格把模型名顶到右边，
 * 直接截断会切掉模型名尾部。留白不够时（窄终端）返回原样，由调用方兜底截断。
 */
export function shrinkPadding(line: string, extra: number): string {
	if (extra <= 0) return line;
	const widest = [...line.matchAll(/ {2,}/g)].reduce<{ index: number; length: number } | undefined>(
		(best, match) => (match[0].length > (best?.length ?? 0) ? { index: match.index, length: match[0].length } : best),
		undefined,
	);
	if (!widest) return line;
	// 至少留一个空格，别把模型名粘到用量段上。
	const cut = Math.min(extra, widest.length - 1);
	return `${line.slice(0, widest.index)}${line.slice(widest.index + cut)}`;
}

export interface RateFooterOptions {
	/** 自动压缩是否开启，即状态行末尾的 `(auto)`。 */
	isAutoCompactEnabled: () => boolean;
}

/** 包一层内置 footer：渲染结果不变，只在状态行（第 2 行）里多一段速率。 */
export function createRateFooter(
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	options: RateFooterOptions,
): Component & { dispose(): void } {
	const inner = new FooterComponent(footerSession(ctx), footerData);
	let cached: { sessionId: string; leafId: string | null; entries: number; rate?: number } | undefined;

	// footer 每帧都渲染，而条目只在会话追加时变化；按条目数缓存，避免逐帧全量扫描。
	const rate = (): number | undefined => {
		const entries = ctx.sessionManager.getEntries();
		const sessionId = ctx.sessionManager.getSessionId();
		const leafId = ctx.sessionManager.getLeafId();
		if (cached?.sessionId !== sessionId || cached.leafId !== leafId || cached.entries !== entries.length) {
			cached = { sessionId, leafId, entries: entries.length, rate: outputRate(entries) };
		}
		return cached.rate;
	};

	return {
		render(width: number): string[] {
			inner.setAutoCompactEnabled(options.isAutoCompactEnabled());
			const lines = inner.render(width);
			const value = rate();
			const statsLine = lines[1];
			if (value === undefined || statsLine === undefined) return lines;
			const inserted = insertRate(statsLine, formatRate(value));
			// 先扣回右侧留白，窄终端上留白不够时再兜底截断。
			const extra = visibleWidth(inserted) - visibleWidth(statsLine);
			lines[1] = truncateToWidth(shrinkPadding(inserted, extra), width, "");
			return lines;
		},
		invalidate(): void {
			inner.invalidate();
		},
		dispose(): void {
			inner.dispose();
		},
	};
}
