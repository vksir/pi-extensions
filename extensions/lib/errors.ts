/** 把任意 catch 到的值转成可读消息。 */

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
