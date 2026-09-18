# Pi Extensions

我的 [Pi 编码助手](https://pi.dev) 扩展集合。

## 扩展列表

| 扩展 | 描述 |
|------|------|
| [pi-balance](extensions/pi-balance.ts) | 查询 AI 模型提供商余额/额度（支持 DeepSeek、Moonshot、OpenRouter、OpenAI Codex） |
| [pi-notify](extensions/pi-notify.ts) | 任务完成后发送桌面通知（支持 iTerm2、Kitty、Ghostty、WezTerm、Windows Terminal） |
| [pi-title-animation](extensions/pi-title-animation.ts) | Agent 运行时在窗口标题显示旋转动画，结束后恢复原标题 |
| [pi-token-stats](extensions/pi-token-stats.ts) | 统计 Token 用量，支持 `/tokens` 命令和 footer 实时显示 |
| [pi-context](extensions/pi-context.ts) | `/context` 命令将系统提示词、工具定义写入 `~/.pi/pi-context/`，并挂起一次性钩子：下次请求时把真实请求体写入 `~/.pi/pi-context/last-request.json` |
| [pi-cron](extensions/pi-cron.ts) | 进程级 cron job：`cron` 工具（create / list / delete）按 cron 表达式反复把一段 prompt 交给 agent；人工入口是 `/cron <间隔> [once] <prompt>`、`/cron list`、`/cron delete [id]` |

`/balance codex` 需要先通过 `/login openai-codex` 登录 ChatGPT Plus/Pro 订阅。
