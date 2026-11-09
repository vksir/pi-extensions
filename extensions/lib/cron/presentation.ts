/**
 * pi-cron 的展示层：cron 表达式的两种人类可读形态、相对时间与 prompt 包装。
 *
 * 不读进程状态，也不依赖 TUI；命令（中文）与工具返回文本（英文）共用这里的排期描述。
 */

// ─── 人类可读排期（英文，工具返回文本用） ───

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatClock(minute: number, hour: number): string {
	// 固定用 1 月 1 日，避开夏令时跳变日
	return new Date(2000, 0, 1, hour, minute).toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "2-digit",
	});
}

/** 只覆盖常见形态；认不出来就原样返回表达式（与工具返回文本共用，故用英文） */
export function cronToHuman(expr: string): string {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return expr;
	const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];

	const everyMin = minute.match(/^\*\/(\d+)$/);
	if (minute === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") return "Every minute";
	if (everyMin && hour === "*" && dom === "*" && month === "*" && dow === "*") {
		const n = Number(everyMin[1]);
		return n === 1 ? "Every minute" : `Every ${n} minutes`;
	}

	if (/^\d+$/.test(minute) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
		const m = Number(minute);
		return m === 0 ? "Every hour" : `Every hour at :${String(m).padStart(2, "0")}`;
	}

	const everyHour = hour.match(/^\*\/(\d+)$/);
	if (/^\d+$/.test(minute) && everyHour && dom === "*" && month === "*" && dow === "*") {
		const n = Number(everyHour[1]);
		const m = Number(minute);
		const suffix = m === 0 ? "" : ` at :${String(m).padStart(2, "0")}`;
		return n === 1 ? `Every hour${suffix}` : `Every ${n} hours${suffix}`;
	}

	// 每 N 天（dom 步进；与下面的「具体日期」互斥）
	const everyDayEn = dom.match(/^\*\/(\d+)$/);
	if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && everyDayEn && month === "*" && dow === "*") {
		const n = Number(everyDayEn[1]);
		const time = formatClock(Number(minute), Number(hour));
		return n === 1 ? `Every day at ${time}` : `Every ${n} days at ${time}`;
	}

	if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && /^\d+$/.test(month) && dow === "*") {
		const date = new Date(2000, Number(month) - 1, Number(dom));
		const label = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
		return `On ${label} at ${formatClock(Number(minute), Number(hour))}`;
	}

	if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === "*" && month === "*") {
		const m = Number(minute);
		const h = Number(hour);
		if (dow === "*") return `Every day at ${formatClock(m, h)}`;
		if (dow === "1-5") return `Weekdays at ${formatClock(m, h)}`;
		if (/^\d$/.test(dow)) {
			const name = DAY_NAMES[Number(dow) % 7];
			if (name) return `Every ${name} at ${formatClock(m, h)}`;
		}
	}

	return expr;
}

// ─── 人类可读排期（中文，/cron 命令用） ───

function formatClockZh(minute: number, hour: number): string {
	return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const DAY_NAMES_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 人类可读排期的中文版。命令面向用户（英文版 cronToHuman 服务工具返回文本） */
export function cronToHumanZh(expr: string): string {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return expr;
	const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];

	if (minute === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") return "每分钟";

	const everyMin = minute.match(/^\*\/(\d+)$/);
	if (everyMin && hour === "*" && dom === "*" && month === "*" && dow === "*") {
		const n = Number(everyMin[1]);
		return n === 1 ? "每分钟" : `每 ${n} 分钟`;
	}

	if (/^\d+$/.test(minute) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
		const m = Number(minute);
		return m === 0 ? "每小时" : `每小时的第 ${m} 分`;
	}

	const everyHour = hour.match(/^\*\/(\d+)$/);
	if (/^\d+$/.test(minute) && everyHour && dom === "*" && month === "*" && dow === "*") {
		const h = Number(everyHour[1]);
		const m = Number(minute);
		const base = h === 1 ? "每小时" : `每 ${h} 小时`;
		return m === 0 ? base : `${base}的第 ${m} 分`;
	}

	// 每 N 天（dom 步进；与下面的「具体日期」互斥）
	const everyDayZh = dom.match(/^\*\/(\d+)$/);
	if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && everyDayZh && month === "*" && dow === "*") {
		const n = Number(everyDayZh[1]);
		const time = formatClockZh(Number(minute), Number(hour));
		return n === 1 ? `每天 ${time}` : `每 ${n} 天 ${time}`;
	}

	// 具体日期：一次性任务的典型形态
	if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && /^\d+$/.test(month) && dow === "*") {
		return `${Number(month)} 月 ${Number(dom)} 日 ${formatClockZh(Number(minute), Number(hour))}`;
	}

	if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === "*" && month === "*") {
		const time = formatClockZh(Number(minute), Number(hour));
		if (dow === "*") return `每天 ${time}`;
		if (dow === "1-5") return `工作日 ${time}`;
		if (/^\d$/.test(dow)) return `${DAY_NAMES_ZH[Number(dow) % 7]} ${time}`;
	}

	return expr;
}

// ─── 相对时间 ───

/** 紧凑的英文相对时长，工具返回文本用。 */
export function relative(ms: number): string {
	if (ms <= 0) return "0s";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	if (h < 24) return rm ? `${h}h${rm}m` : `${h}h`;
	const d = Math.floor(h / 24);
	const rh = h % 24;
	return rh ? `${d}d${rh}h` : `${d}d`;
}

/** 相对时长的中文单值近似（命令回执用）。只给一个量级，不堆「X 小时 Y 分」这种碎数字 */
export function relativeZh(ms: number): string {
	if (ms < 60_000) return "不到 1 分钟";
	const m = Math.round(ms / 60_000);
	if (m < 60) return `${m} 分钟`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h} 小时`;
	return `${Math.round(h / 24)} 天`;
}

/** 触发时刻：当天只显示 HH:MM，跨天补上月/日，括号里给相对时间 */
export function formatWhen(at: number, now: number): string {
	const d = new Date(at);
	const clock = formatClockZh(d.getMinutes(), d.getHours());
	const sameDay = new Date(now).toDateString() === d.toDateString();
	const stamp = sameDay ? clock : `${d.getMonth() + 1}/${d.getDate()} ${clock}`;
	return `${stamp}（${relativeZh(at - now)}后）`;
}

// ─── 触发消息的包装 ───

/** framePrompt 只关心 job 的这几个字段；pi-cron 的 CronJob 结构性满足。 */
export interface CronPromptJob {
	id: string;
	cron: string;
	prompt: string;
	recurring: boolean;
	fireCount: number;
}

/**
 * 触发时交给模型的最小包装：只补两件模型不可能自己知道的事——这条消息从哪来、
 * 以及这个 job 的 id（供它自行取消）。逐字措辞都是调过的，改动前先看测试断言：
 *   - 用第三人称陈述来源，不用否定句去否认消息自身的 role（那会与 role=user 矛盾）；
 *   - 取消条件锚到「prompt 里写明的完成条件」，而不是模型自评的 purpose——后者是早删的根因；
 *   - 没有「Run the prompt below」（D43 曾加过，D49 用户拍定删除）；
 *   - 一次性不提「已被移除」——那会暗示无事可做，与要执行的任务直接冲突；
 *   - 头行不标 recurring/one-shot；不写「怎么调工具」；不提 catch-up；不写过期策略。
 * prompt 本体逐字不变，只在前面加一行；渲染时由 unframePrompt 剥掉。
 */
export function framePrompt(job: CronPromptJob): string {
	const head = `[cron-job ${job.id} · ${job.cron} · fire ${job.fireCount}]`;
	const note = job.recurring
		? "Delivered by a scheduled cron job. Cancel this job only when the prompt's stated completion condition is met."
		: "Delivered by a scheduled cron job. Run the prompt below.";
	return `${head} ${note}\n\n${job.prompt}`;
}

/** 渲染时剥掉上面的包装（与 pi 处理 <skill> 块的做法一致），TUI 只显示 prompt 原貌 */
export function unframePrompt(text: string): string {
	if (!text.startsWith("[cron-job ")) return text;
	const sep = text.indexOf("\n\n");
	return sep < 0 ? text : text.slice(sep + 2);
}
