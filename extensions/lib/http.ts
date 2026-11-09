/** HTTP 响应处理中与具体 Provider 无关的公共部分。 */

/** 非 2xx 响应的统一摘要：`HTTP <status>[: <body>]`，body 读取失败时省略。 */
export async function responseError(response: Response): Promise<string> {
	const body = await response.text().catch(() => "");
	return `HTTP ${response.status}${body ? `: ${body}` : ""}`;
}
