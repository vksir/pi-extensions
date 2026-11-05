# Pi Extensions

我的 [Pi 编码助手](https://pi.dev) 扩展集合。

## 兼容性

需要 Pi 1.x（最低 `1.0.0`）；仓库的 Pi 开发依赖与 peer 依赖均以此版本为基线。

## 扩展列表

| 扩展 | 描述 |
|------|------|
| [pi-balance](extensions/pi-balance.ts) | 查询 AI 模型提供商余额/额度（支持 DeepSeek、Moonshot、OpenRouter、OpenAI Codex） |
| [pi-notify](extensions/pi-notify.ts) | 任务完成后发送桌面通知（支持 iTerm2、Kitty、Ghostty、WezTerm、Windows Terminal）；需 Pi ≥ 1.3.0 |
| [pi-title](extensions/pi-title.ts) | Agent 运行时在窗口标题显示旋转动画，结束后恢复原标题；herdr 环境（两代）不修改窗口标题，`/name` 更名时同步重命名所在标签（旧 herdr 经 CLI 直接寻址，herdr app 经 herdr-app CLI ls 寻址）；进程内子 agent 会话（ctx.mode 非 "tui"）不参与标题与标签管理 |
| [pi-token-stats](extensions/pi-token-stats.ts) | 统计 Token 用量，支持 `/token` 命令和 footer 实时显示 |
| [pi-context](extensions/pi-context.ts) | `/context` 触发一次空转请求，导出这次请求的系统提示词与工具声明（含 codemode 动态描述），两者同源 |
| [pi-cron](extensions/pi-cron.ts) | 进程级 cron job：`cron` 工具（create / list / delete）按 cron 表达式反复把一段 prompt 交给 agent；人工入口是 `/cron <间隔> [once] <prompt>`、`/cron list`、`/cron delete [id]` |
| [pi-btw](extensions/pi-btw.ts) | 顺带分派：仅在 herdr / herdr app 环境注册 `/btw <消息>`，新开一个标签，fork 当前会话启动 pi 并把消息作为首条消息递交 |

`/balance codex` 需要先通过 `/login openai-codex` 登录 ChatGPT Plus/Pro 订阅。

### 上下文快照

执行 `/context` 触发一次空转请求：向会话发一条 `pi-context` 自定义消息，并让 agent 走一轮，快照写的就是这次真实请求。Agent 忙碌时不再触发，直接等本轮的下一次请求。

两份文件来自同一次请求，都用 `---` 抬头的 YAML 键值记录捕获时间与模型：

- `system-prompt.md`：抬头列出具名分段与各段字符数；正文就是模型实际收到的系统提示词。内容来自请求 transcript 的 system 消息，用的是 provider 读取提示词的同一组 replay 助手，与 provider 形状无关。
- `tools.md`：每个声明一节——`# 工具名` → `## 描述` → `## 定义`。描述按 Markdown 原文渲染（不套代码块，逐字保留、不截断），定义是 JSON，长文本位置留 `<见「节名」>` 占位；描述以外的长文本（如 grammar 定义）按 JSON 路径单独成节。抬头记录数量与原始 JSON 字符数。工具声明只能取自 provider 请求体，这是唯一带 `prepareLoadout` 改写与 provider 原生格式的地方。触发消息只在捕获那一次请求里出现，之后由 `context` 事件从每次请求里滤掉，不会长期占用上下文。不导出用户或助手消息、注册定义、统计信息或完整请求体。请求体没有 `tools` 字段时，文件会写明是「本次请求没有工具声明」还是「无法从该 API 读取」。

默认输出目录为 `~/.pi/agent/pi-context/`，可通过 `PI_CODING_AGENT_DIR` 改变 agent dir。

回归测试（Node.js 24+）：

```bash
node --test 'tests/pi-context.test.ts'
```

### 标题与 herdr 标签

进程内子 agent（如 `@tintinweb/pi-subagents`）会在同一进程里为子会话重新加载扩展，并触发各自的 `agent_start` / `session_info_changed` 事件。pi-title 只认 `ctx.mode === "tui"` 的主会话：子会话不参与标题动画，子会话的更名也不会改写 herdr 标签。

两代 herdr 环境下都不修改窗口标题；`/name` 更名会话时同步重命名 pi 所在标签，两代都支持，寻址方式不同：

- **旧 herdr**（`HERDR_ENV=1`）：`HERDR_TAB_ID` 直接给出标签 id，经 `herdr` CLI（或注入的 `HERDR_BIN_PATH`）`tab rename` 更名。
- **herdr app**（`HC_TERMINAL_ID`）：标签 id 不在 env 里，先 `herdr-app ls` 找到装着本终端的 tab，再 `herdr-app do tab.rename` 改名（空名恢复按序号命名）。窗口未开、终端不在窗口里等失败静默放弃，详见 ADR-0005。

回归测试：

```bash
node --test 'tests/pi-title.test.ts'
```

### 顺带分派（/btw）

仅在 [herdr](https://herdr.dev) 环境注册（两代都支持：旧 herdr 注入 `HERDR_ENV=1`，herdr app 注入 `HC_TERMINAL_ID`）；其他环境扩展零 footprint，不注册任何命令。

`/btw <消息>`：新开一个标签（不命名，沿用 herdr 默认编号），在其中 fork 当前会话启动一个新的 pi（`pi --fork`，带全量上下文，fork 进当前工作目录），消息作为它的首条消息逐字递交；当前会话不受影响。消息随启动 argv 递交（经 `--` 停止选项解析，pi 就绪瞬间即处理，零额外等待；见 [ADR-0004](docs/adr/0004-btw-message-in-pi-argv.md)）：

- **herdr app**：一条 `herdr-app do tab.new --folder <cwd> --argv '["pi","--fork",<会话文件>,"--",<消息>]'` 搞定（实测 herdr 转义对引号/`$`/多行/中文可靠）。
- **旧 herdr**：`herdr tab create` → `herdr pane run <pane> pi --fork '<会话文件>'` → 轮询 `agent list` 等就绪（~0.5s）→ `pane send-text` + `send-keys enter`。全程不注册命名 agent。

以 `--no-session` 启动（无会话文件可 fork）时 `/btw` 直接报错拒绝，不降级成全新会话。标签与首条消息的代际编排在 `extensions/lib/herdr.ts`，与 pi-title 共用环境探测。

回归测试（Node.js 24+）：

```bash
node --test 'tests/herdr.test.ts' 'tests/pi-btw.test.ts'
```

### 通知配置

pi-notify 仅在交互 TUI 模式发通知，RPC/JSON/print 等非交互模式下静默。

在两代 [herdr](https://herdr.dev) 终端环境中（旧 herdr 注入 `HERDR_ENV=1`，或 herdr-core 注入 `HC_TERMINAL_ID`）默认启用；如需在 herdr 中禁用，在 settings.json 中配置：

```json
{
	"pi-notify": {
		"disableInHerdr": true
	}
}
```

如需整体禁用扩展（任何环境下都不发通知），配置：

```json
{
	"pi-notify": {
		"disable": true
	}
}
```
