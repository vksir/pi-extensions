/**
 * settings.json 中扩展配置的读取：统一「缺失或形状不对按空配置处理」的口径。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 读取某个扩展键下的对象配置；缺失或不是普通对象时返回空对象。 */
export function readExtensionSettings<T extends object>(pi: ExtensionAPI, key: string): T {
	const raw = (pi.getSettings() as Record<string, unknown>)[key];
	return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as T) : ({} as T);
}

/** 过滤出字符串数组；非数组返回空数组，非字符串项静默丢弃。 */
export function readStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
