# Pi Extensions

我的 [Pi 编码助手](https://pi.dev) 扩展集合。

## 兼容性

需要 Pi 1.x（最低 `1.0.0`）；仓库的 Pi 开发依赖与 peer 依赖均以此版本为基线。

## 扩展列表

| 扩展 | 描述 |
|------|------|
| [pi-balance](extensions/pi-balance.ts) | 查询 AI 模型提供商余额/额度（支持 DeepSeek、Moonshot、OpenRouter、OpenAI Codex、OpenCode Go、智谱 GLM）；`/balance` 列支持的 Provider，`/balance all` 查全部，`/balance <provider>` 查单个 |
| [pi-notify](extensions/pi-notify.ts) | 任务完成后发送桌面通知（支持 iTerm2、Kitty、Ghostty、WezTerm、Windows Terminal）；需 Pi ≥ 1.3.0 |
| [pi-title](extensions/pi-title.ts) | Agent 运行时在窗口标题显示旋转动画，结束后恢复原标题；herdr 环境（两代）不修改窗口标题，`/name` 更名时同步重命名所在标签（旧 herdr 经 CLI 直接寻址，herdr app 经 herdr-app CLI ls 寻址）；进程内子 agent 会话（ctx.mode 非 "tui"）不参与标题与标签管理 |
| [pi-token-stats](extensions/pi-token-stats.ts) | 统计 Token 用量，支持 `/token` 命令；footer 状态行里插入最近一次响应的输出速率（`R1.5M 42t/s CH97.1%`） |
| [pi-context](extensions/pi-context.ts) | `/context` 触发一次空转请求，导出这次请求的系统提示词与工具声明（含 codemode 动态描述），两者同源 |
| [pi-cron](extensions/pi-cron.ts) | 进程级 cron job：`cron` 工具（create / list / delete）按 cron 表达式反复把一段 prompt 交给 agent；人工入口是 `/cron <间隔> [once] <prompt>`、`/cron list`、`/cron delete [id]` |
| [pi-btw](extensions/pi-btw.ts) | 顺带分派：仅在 herdr / herdr app 环境注册 `/btw <消息>`，新开一个标签，fork 当前会话启动 pi 并把消息作为首条消息递交 |
| [pi-bg](extensions/pi-bg.ts) | 后台运行：`bash-bg` / `codemode-bg` 立即返回，结束后把结果作为消息发回会话；`bg` 工具与 `/bg` 命令查看/终止 |

`/balance codex` 需要先通过 `/login openai-codex` 登录 ChatGPT Plus/Pro 订阅。`/balance opencode` 查 OpenCode Go 的 5 小时/周/月额度，需要先配置 `opencode-go` 的 API Key。

### 输出速率

footer 状态行里多一段输出速率，位置在缓存读取与缓存命中率之间：`↑225k ↓42k R1.5M 42t/s CH97.1% $0.090 7.1%/1.0M (auto)`。

速率 = 最近一次完成的 assistant 响应的 output ÷ 该次耗时（`AssistantMessage.durationMs`，token/秒），两位数以上取整，个位数保留一位小数；老会话里的消息没有耗时记录，往前找最近一条有的。流式过程中显示的是上一次响应的速率，本轮结束后更新。

pi 没有给 footer 留插槽，`setFooter` 只能整体替换，所以 `lib/footer-rate.ts` 用内置 `FooterComponent` 渲染原状态行，只往里面插一段速率：路径、用量、命中率、上下文占比、模型右对齐、扩展状态行仍由 pi 自己管。插入多出的宽度从模型名前的留白里扣回，窄终端上留白不够才截断。代价是扩展上下文拿不到的几段不显示：虚拟模型的路由结果（`→ 物理模型`）与订阅标记（`(sub)`）。

回归测试（Node.js 24+）：

```bash
node --test 'tests/pi-token-stats.test.ts'
```

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

### 后台运行（bash-bg / codemode-bg）

两个后台工具都是内置工具的**薄壳**：真正的执行委托给 `bash` / `codemode`（`ctx.executeTool`），因此截断（尾部 2000 行 / 50KB，附全文临时文件路径）、退出码、结构化输出、`tool_call` hook 与权限检查全部与内置逐字一致；后台脚本里调 `tools.*` 的语义也与 `codemode` 相同。为什么不自研、也不做成 `bash` 的一个参数，见 [ADR-0006](docs/adr/0006-bg-tools-delegate-to-builtin.md)。

- 启动立刻返回，结果**不**出现在 tool result 里，而是任务结束时以自定义消息 `pi-bg` 回传：头行 `[bash-bg b3f1a2c4] npm test — done · exit 0 · 12s`，空行后是内置工具的原样输出（空输出为 `(no output)`）。
- 回传走 `pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })`：不打断当前 LLM 调用，当前 turn 的工具跑完、下次调用前投递；agent 空闲时立刻起一轮。与 [@tintinweb/pi-subagents](https://www.npmjs.com/package/@tintinweb/pi-subagents) 的后台 Agent 同一通道。
- 后台任务受**自己的** `AbortController` 约束。发起它的 tool call 被 Esc 中断不会连坐杀掉后台任务。
- `bg` 工具与 `/bg` 命令：列出在跑任务与最近 20 条已完成记录；`bg kill <id>`（或 `/bg kill`）中止任务，连带杀掉它的进程树。同时最多 64 个任务，超出直接拒绝。
- 存续域是**进程级**：`session_shutdown`（含 `/reload`）中止全部在跑任务，`/new` 之后任务表只保留在跑条目。已完成但未回传的结果随会话一起消失，与 pi-cron 同一取舍（[ADR-0001](docs/adr/0001-cron-tasks-are-process-scoped.md)）。
- **Windows + Git Bash 的已知边界**：pi 的 `killProcessTree` 在 Windows 上用 `taskkill /F /T <pid>`，而 MSYS 子进程（`sleep`、`grep` 这类）在 Windows 记录的父进程并不是 bash，所以中止后可能残留孤儿进程。对前台 `bash` 调用按 Esc 是**完全一样**的行为，不是 pi-bg 引入的；`bg kill` 的"已终止"保证的是本次会话不再回传、内置工具已收到 abort。

回归测试（Node.js 24+）：

```bash
node --test 'tests/pi-bg.test.ts'
```

### 通知配置

pi-notify 仅在交互 TUI 模式发通知，RPC/JSON/print 等非交互模式下静默。

主 agent 因 [@tintinweb/pi-subagents](https://www.npmjs.com/package/@tintinweb/pi-subagents) 的进程内子 agent 仍在运行或排队而停下等待时（同样触发 `agent_settled`），不发通知——只有真正完成才通知。探测实现在 `lib/subagents.ts`：注册表取不到时（未安装、被过滤、形状变化）一律按没有子 agent 处理，照常通知。

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

## 代码结构

`extensions/` 顶层每个 `.ts` 是一个独立扩展；跨扩展的公共实现放在 `extensions/lib/`。该目录没有 `index.ts` 与 `package.json`，pi 的扩展发现不会把它当扩展加载。

| 模块 | 职责 |
|------|------|
| `lib/herdr.ts` | 两代 herdr 环境探测、标签更名、新标签启动 |
| `lib/subagents.ts` | pi-subagents 注册表的子 agent 存活探测 |
| `lib/cron/schedule.ts` | cron 表达式解析、下次触发、间隔换算（纯函数） |
| `lib/cron/presentation.ts` | 排期的人类可读化与触发 prompt 包装 |
| `lib/bg/jobs.ts` | 后台任务表：上限、淘汰、id 分配（纯函数） |
| `lib/bg/format.ts` | 后台任务的启动/回传/列表文本 |
| `lib/balance/providers.ts` | Provider 凭据、请求与响应归一化 |
| `lib/balance/render.ts` | `/balance` 结果排版 |
| `lib/json.ts` | Agent 数据目录 JSON 的容错读取与原子写入 |
| `lib/settings.ts` | settings.json 中的扩展配置读取 |
| `lib/render.ts` | entry 结果块的统一渲染 |
| `lib/text.ts` | basename、truncate 等文本工具 |
| `lib/http.ts` | HTTP 错误摘要 |
| `lib/errors.ts` | 任意异常值的可读消息 |
