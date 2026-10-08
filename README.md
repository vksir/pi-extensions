# Pi Extensions

我的 [Pi 编码助手](https://pi.dev) 扩展集合。

## 兼容性

需要 Pi 1.x（最低 `1.0.0`）；仓库的 Pi 开发依赖与 peer 依赖均以此版本为基线。

## 扩展列表

| 扩展 | 描述 |
|------|------|
| [pi-balance](extensions/pi-balance.ts) | 查询 AI 模型提供商余额/额度（支持 DeepSeek、Moonshot、OpenRouter、OpenAI Codex） |
| [pi-notify](extensions/pi-notify.ts) | 任务完成后发送桌面通知（支持 iTerm2、Kitty、Ghostty、WezTerm、Windows Terminal） |
| [pi-title-animation](extensions/pi-title-animation.ts) | Agent 运行时在窗口标题显示旋转动画，结束后恢复原标题 |
| [pi-token-stats](extensions/pi-token-stats.ts) | 统计 Token 用量，支持 `/tokens` 命令和 footer 实时显示 |
| [pi-context](extensions/pi-context.ts) | `/context` 立即写入系统提示词；下次请求刷新提示词并导出原生工具定义、激活工具列表及写入时间，支持 codemode 动态描述 |
| [pi-cron](extensions/pi-cron.ts) | 进程级 cron job：`cron` 工具（create / list / delete）按 cron 表达式反复把一段 prompt 交给 agent；人工入口是 `/cron <间隔> [once] <prompt>`、`/cron list`、`/cron delete [id]` |

`/balance codex` 需要先通过 `/login openai-codex` 登录 ChatGPT Plus/Pro 订阅。

### 上下文快照

执行 `/context` 立即写入系统提示词；再发送一条消息，捕获实际请求并更新两份文件：

- `system-prompt.md`：先保存命令时的系统提示词，再用实际请求的 system/developer 指令文本刷新，不含用户和助手消息。
- `tools.md`：记录本次实际捕获的写入时间（UTC），简要列出激活工具名称，下方展示原生工具定义 JSON，完整保留 codemode 动态描述、参数 schema 与 freeform grammar，不截断。激活不等于独立顶层可见，实际定义以下方 JSON 为准。

不导出注册定义、统计信息或完整请求体。内容来自 `before_provider_request` 捕获点，后续处理器仍可能修改请求。

默认输出目录为 `~/.pi/agent/pi-context/`，可通过 `PI_CODING_AGENT_DIR` 改变 agent dir。

回归测试（Node.js 24+）：

```bash
node --test 'tests/pi-context.test.ts'
```
