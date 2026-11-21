# Pi Extensions

我的 [Pi 编码助手](https://pi.dev) 扩展集合。

## 兼容性

需要 Pi ≥ `1.5.2`；仓库的 Pi 开发依赖与 peer 依赖均以此版本为基线。

类型检查与回归测试（Node.js 24+）：

```bash
npx tsc -p tsconfig.json
node --test tests/*.test.ts
```

`tsconfig.json` 只做类型检查，不参与构建：扩展由 pi 直接加载 `.ts`。它把 `@earendil-works/pi-ai` 映射到 pi 的扩展视图（`pi-ai/compat` + TypeBox 的 `Type`/`Static`/`StringEnum`），与 pi loader 的运行时解析保持一致。

## 扩展列表

| 扩展 | 描述 |
|------|------|
| [pi-balance](extensions/pi-balance.ts) | 查询 AI 模型提供商余额/额度（支持 DeepSeek、Moonshot、OpenRouter、OpenAI Codex、OpenCode Go、智谱 GLM）；`/balance` 列支持的 Provider，`/balance all` 查全部，`/balance <provider>` 查单个 |
| [pi-notify](extensions/pi-notify.ts) | 任务完成后发送桌面通知（支持 iTerm2、Kitty、Ghostty、WezTerm、Windows Terminal）；需 Pi ≥ 1.3.0 |
| [pi-title](extensions/pi-title.ts) | Agent 运行时在窗口标题显示旋转动画，结束后恢复原标题；herdr 环境（两代）不修改窗口标题，`/name` 更名与会话启动（resume / `/reload` / 切换会话）时同步重命名所在标签（旧 herdr 经 CLI 直接寻址，herdr app 经 herdr-app CLI ls 寻址）；进程内子 agent 会话（ctx.mode 非 "tui"）不参与标题与标签管理 |
| [pi-token-stats](extensions/pi-token-stats.ts) | 统计 Token 用量与速率（`/token`，默认过去 1 小时，支持 `3h` / `30m` / `7d` / `all`），按当前模型汇总所有会话与进程的 Turns / Input / Output / Cost 与平均首字/输出速率；footer 状态行里插入最近一次响应的首字时间与输出速率（`R1.5M 0.9s 42t/s CH97.1%`） |
| [pi-context](extensions/pi-context.ts) | `/context` 触发一次空转请求，导出这次请求的系统提示词与工具声明（含 codemode 动态描述），两者同源 |
| [pi-cron](extensions/pi-cron.ts) | 进程级 cron job：`cron` 工具（create / list / delete）按 cron 表达式反复把一段 prompt 交给 agent；人工入口是 `/cron [间隔] [once] <prompt>`（省略间隔按 `15m`）、`/cron list`、`/cron delete [id]` |
| [pi-btw](extensions/pi-btw.ts) | 顺带分派：仅在 herdr / herdr app 环境注册 `/btw <消息>`，新开一个标签，fork 当前会话启动 pi 并把消息作为首条消息递交；本轮还在跑时先把 fork 源截到上一个完整轮次，避免新会话继承半截 turn（见 [ADR-0008](docs/adr/0008-btw-forks-at-turn-boundary.md)） |
| [pi-bg](extensions/pi-bg.ts) | 后台运行：`bash_bg` / `codemode_bg` 立即返回，结束后把结果作为消息回发；前台 `bash` / `codemode` 超过等待预算（默认 5 分钟）自动转成后台任务；`bg_job` 工具（list / show / kill）与 `/bg` 命令查看/终止，并与内置工具的启用状态联动 |
| [pi-herdr-agent](extensions/pi-herdr-agent.ts) | 用 herdr-core（hc）的终端树跑子 agent：`agent` 拉起、`agent_job` 管理（list / kill / ask / steer），结果按 asker 自动回发；`/agent list` 显示 agent 树；仅 herdr app + hc 环境生效 |

`/balance codex` 需要先通过 `/login openai-codex` 登录 ChatGPT Plus/Pro 订阅。`/balance opencode` 查 OpenCode Go 的 5 小时/周/月额度，需要先配置 `opencode-go` 的 API Key。

### 首字时间与输出速率

footer 状态行里多一段首字时间与输出速率，位置在缓存读取与缓存命中率之间：`↑225k ↓42k R1.5M 0.9s 42t/s CH97.1% $0.090 7.1%/1.0M (auto)`。

- 首字时间（TTFT）= 第一个内容块到达时刻 − 请求开始时刻。请求开始用的是 assistant 消息的 `timestamp`（provider 发请求前打的点），所以包含网络往返与排队，正是用户等待首字的时间。一秒以内显示毫秒（`850ms`），再长显示秒（`1.2s`）。它只能在流式过程中测，所以只记内存里的最近一次：重启、切会话、老会话里的消息都不显示——此时只剩速率一段。
- 速率 = 最近一次完成的 assistant 响应的 output ÷ 该次耗时（`AssistantMessage.durationMs`，token/秒），两位数以上取整，个位数保留一位小数；老会话里的消息没有耗时记录，往前找最近一条有的。流式过程中显示的是上一次响应的首字时间与速率，本轮结束后更新。
- 两段都取自同一条 assistant 消息；消息没带耗时（比如老会话）时，首字时间也一并隐身，避免张冠李戴。

pi 没有给 footer 留插槽，`setFooter` 只能整体替换，所以 `lib/footer-rate.ts` 用内置 `FooterComponent` 渲染原状态行，只往里面插一段首字时间与速率：路径、用量、命中率、上下文占比、模型右对齐、扩展状态行仍由 pi 自己管。插入多出的宽度从模型名前的留白里扣回，窄终端上留白不够才截断。代价是扩展上下文拿不到的几段不显示：虚拟模型的路由结果（`→ 物理模型`）与订阅标记（`(sub)`）。

### 时间窗用量与速率

`/token` 默认汇总**过去 1 小时**，也可以 `/token 3h`。参数沿用旧命令的 `<数字><单位>` 写法：`30m`、`6h`、`24h`、`7d`（旧默认）、`all`；旧的 `Out` 已随柱状图移除。窗口覆盖所有会话、所有 pi 进程，但只统计**当前模型**（`ctx.model` 的 `provider/id`），不按模型拆表（见 [ADR-0009](docs/adr/0009-rolling-window-from-turn-detail.md)）：

- `Turns`：窗口内的响应数。
- `Input`：总输入（未缓存 + 缓存读 + 缓存写），括号内 `CH` 是缓存命中率 = 缓存读 ÷ 总输入。
- `Output` / `Cost`：窗口内的输出 token 与费用。
- `Avg TTFT`：窗口内当前模型测到首字的响应之和 ÷ 样本数。首字只能在流式过程中测到，所以续聊、重启、老会话里的响应可能没有样本；没有样本时显示 `-`。
- `Avg Rate`：窗口内当前模型有耗时响应的输出 token 之和 ÷ 这些响应的耗时之和，单位 token/秒。按 token 加权，不是逐次速率的算术平均；耗时取 `AssistantMessage.durationMs`，是包含首字等待的完整请求时间。没有计时样本时显示 `-`。
- 当前模型没有记录时显示 `No data for <provider/model>.`，不会混入其他模型的数据。

数据落在 `~/.pi/agent/pi-token-stats/token-stats.db`，每次 `turn_end` 只写一行 `turn` 明细（时间、会话、模型、用量、耗时、首字）。用量字段 `input / output / cache_read / cache_write / cost` 都在这行里，所以删掉旧的按天/按会话汇总表不会丢用量；`/token` 直接对明细做 `at >= 窗口起点 AND model = 当前模型` 的聚合。

写库在 **worker 线程**里（`lib/token-stats-worker.ts`）：`turn_end` 只 `postMessage` 一轮响应就返回，建库、迁移、INSERT 都在 worker 里按顺序执行；多进程抢写时 `busy_timeout` 的等待也不会卡住 TUI 的事件循环。worker 启动时用 `--disable-warning=ExperimentalWarning` 屏蔽 Node 22/23 的 SQLite 实验性警告，否则那行提示会被 pi 画进 TUI。`/token` 的查询同样走这个 worker（消息 FIFO，查询前投递的 turn 一定已提交），主线程不碰 SQLite。

多个 pi 进程（herdr 里的各个 agent、fork 出来的子会话）共用同一个库。并发写靠 SQLite 自己保证，不再手写锁文件：

- 建库时一次性切 WAL（写在库头里，后续打开不用再设置）；连接开 `busy_timeout=5000`。
- 每轮一条 `INSERT`，并发的写入在 SQLite 里排队等前一个提交，不会丢增量。
- 多个进程同时首次打开时，切 WAL 那个 PRAGMA 要短暂独占，代码里自带重试；始终抢不到就退回默认日志模式，功能不受影响。

**schema v3 迁移**：旧库里的 `day_model` / `session`（以及 v2 一度改名的 `archive_day_model` / `archive_session`）在打开时直接删除，数据不保留；v1 的 `turn_session` 索引删除，版本号记在 `meta.schema_version`。旧版 `token-stats.json` 的静默导入代码已删除，按小时统计只使用 `turn` 明细。

回归测试（Node.js 24+）：

```bash
node --test 'tests/pi-token-stats.test.ts' 'tests/token-stats-db.test.ts' 'tests/token-stats-client.test.ts'
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

会话启动（`pi -c` resume、`/reload`、切换会话）后 pi 会把终端标题重写成 `π - <会话名> - <cwd>`，而 herdr 在标签没有名字时显示的就是这个标题——恢复出来的命名会话因此会显示成 `π - abc - <cwd>`。所以会话名存在时，启动后同样把标签对齐到会话名，herdr 里仍旧只有 `abc`；无名会话启动时不动标签，既不洗掉人为改的标签名，也不把上一会话的名字留在新会话上。

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

本轮还在跑时（模型正在生成、工具正在执行）敲 `/btw`，会话文件末尾必然是半截 turn：本轮的 user 消息已落盘但没有回答，或带 `toolCall` 的 assistant 还没有 `toolResult`。直接 fork 会让新 pi 把这半截当成自己的完整过去，从第一句话起就跑偏。所以忙碌时先由 `extensions/lib/session-snapshot.ts` 把会话截到**最后一个完整 turn 的边界**（一条不含 `toolCall` 的 assistant 消息），写进系统临时目录再 fork；成功通知会说明回退了多远、丢了几条未完成记录。代价是 fork 丢掉本轮进展，换来干净的历史。设计取舍见 [ADR-0008](docs/adr/0008-btw-forks-at-turn-boundary.md)。

回归测试（Node.js 24+）：

```bash
node --test 'tests/herdr.test.ts' 'tests/pi-btw.test.ts' 'tests/session-snapshot.test.ts'
```

### 后台运行（bash_bg / codemode_bg / 前台转后台）

两个后台工具都是内置工具的**薄壳**：真正的执行委托给 `bash` / `codemode`（`ctx.executeTool`），因此截断（尾部 2000 行 / 50KB，附全文临时文件路径）、退出码、结构化输出、`tool_call` hook 与权限检查全部与内置逐字一致；后台脚本里调 `tools.*` 的语义也与 `codemode` 相同。为什么不自研、也不做成 `bash` 的一个参数，见 [ADR-0006](docs/adr/0006-bg-tools-delegate-to-builtin.md)。

- 启动返回只有一行 `bg_job b3f1a2c4 started in background.`，完整结果**不**出现在 tool result 里，而是任务结束时以自定义消息 `pi-bg` 回传：头行 `[bg_job b3f1a2c4] bash_bg · npm test — done · exit 0 · 12s`，空行后是内置工具的原样输出（空输出为 `(no output)`）。
- 回传走 `pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })`：不打断当前 LLM 调用，当前 turn 的工具跑完、下次调用前投递；agent 空闲时立刻起一轮。与 [@tintinweb/pi-subagents](https://www.npmjs.com/package/@tintinweb/pi-subagents) 的后台 Agent 同一通道。
- 后台任务受**自己的** `AbortController` 约束。发起它的 tool call 被 Esc 中断不会连坐杀掉后台任务。
- **前台自动转后台**：模型直接调用 `bash` / `codemode` 时，超过等待预算还没结束，就把执行中的命令/脚本转成后台任务、立刻把控制权交还模型，进程/沙箱**不重启**。返回 `bash promoted to bg_job b3f1a2c4 after 5m00s. Still running, last output 1m42s ago.`，之后按后台任务同一套回传。为什么可以覆盖内置工具、以及这条能力的退场条件，见 [ADR-0010](docs/adr/0010-foreground-budget-promotes-to-bg.md)。
  - 只发生在模型直接调用那一层：脚本里的 `tools.bash`、`bash_bg` 的委托都是嵌套调用，永不转后台，返回形状与内置逐字一致。
  - 模型显式给的 `timeout` 照旧透传给内置实现：到点仍然失败，只是不再让整轮陪它卡住。
  - 晋升不受并发上限限制；`bash_bg` / `codemode_bg` 仍受 64 上限。
  - 晋升后父轮 Esc 不再连坐（与后台任务一致）。
  - 等待预算 = `settings.json` 的 `pi-bg.promoteAfterSeconds`（默认 `300`，`<= 0` 关闭；关闭时连覆盖版都不注册）。
- **任务 id 一律写成 `bg_job <id>`**：启动返回、完成消息、列表、`bg_job kill` 的回显都是 `bg_job a3307cb8 started in background` 这种形式。裸 8 位十六进制 id 与子 Agent 的 id 同形，模型会误调 `get_subagent_result`，所以 id 从不单独出现。
- `bg_job` 工具与 `/bg` 命令：列出在跑任务与最近 20 条已完成记录；`bg_job show <id>`（或 `/bg show <id>`）打印命令/脚本、状态与输出（在跑任务给已产出的部分）；`bg_job kill <id>`（或 `/bg kill`）中止任务，连带杀掉它的进程树。`bash_bg` / `codemode_bg` 同时最多 64 个任务，超出直接拒绝（转后台的不占这个名额）。
- **没有 `wait`**：任务结束后结果**只**以 `pi-bg` 消息回传，收尾在后台完成，不阻塞任何一轮。提示词里因此各有一条 `Do not sleep to wait for a bash_bg / codemode_bg job` 的规则——sleep 干等既拿不到更快的答案，又白占一轮。
- **与内置工具的启用状态联动**：三个工具都在 `session_start` 里注册，注册前读 `getActiveTools()`。`bash` 未启用就根本不注册 `bash_bg`，`codemode` 未启用就不注册 `codemode_bg`，两个都未启用就连 `bg_job` 也不注册。schema 直接复用 `getAllTools()` 里内置工具的那一份，所以 pi 给内置工具加参数时这里不用跟。`prepareLoadout` 只兜「会话中途被 `setActiveTools` 关掉」这条快照覆盖不到的路径。
- **存续域与会话绑定**：`/new`、`/reload`、`/resume`、`/fork`、退出都会触发 `session_shutdown`，一律中止全部在跑任务；`/new` 与 `/reload` 还会重建扩展实例，任务表随之清空。已完成但未回传的结果随会话一起消失，与 pi-cron 同一取舍（[ADR-0001](docs/adr/0001-cron-tasks-are-process-scoped.md)）。
- **文案**：给模型的文字全部在 `extensions/prompt/pi-bg.ts`，规则见 `extensions/prompt/README.md`。「长命令用后台工具」这条跨调用的规则写在 `bash_bg` / `codemode_bg` 的 `promptGuidelines` 里（工具被隐藏时规则自动消失），不写进返回值。
- **缓存稳定性**：三个工具在首次 `session_start` 注册一次（幂等守卫挡住 `rebindCurrentSession` 的二次触发），`description` / `promptSnippet` / `parameters` 全部确定，`prepareLoadout` 是纯函数，所以一局会话内系统提示词、工具列表与顺序都不变。`session_shutdown` 不区分 reason，五种理由都是「离开这个会话」。
- **Windows + Git Bash 的不保证项**：pi 的 `killProcessTree` 在 Windows 上用 `taskkill /F /T <pid>`，而 MSYS 子进程（`sleep`、`grep` 这类）在 Windows 记录的父进程并不是 bash，所以中止后可能残留孤儿进程。对前台 `bash` 调用按 Esc 是**完全一样**的行为，不是 pi-bg 引入的。所以 `/new` 与 `bg_job kill` 保证的是「本次会话不再回传、内置执行已收到 abort」，**不是**「进程一定被杀死」——这个保证在 Windows + MSYS 上是弱的。

回归测试（Node.js 24+）：

```bash
node --test 'tests/pi-bg.test.ts'
```

### 子 agent（herdr-agent）

用 herdr-core（hc）的终端树替代进程内子 agent：每个 agent 都是 headless hc 终端里一个**交互式 pi** 进程，herdr-app 把它挂在父 tab 下当 sub-agent 显示（`agent.focus` 可临时给它一个 pane），pi 退出即销毁终端。只在 herdr app + hc 环境注册（`HC_TERMINAL_ID` 与 `HC_TERMINAL_SOCKET` 都在）。设计取舍见 [ADR-0007](docs/adr/0007-herdr-subagents-live-in-hc-terminal-tree.md)。

两个工具：

- `agent { prompt, name?, model?, thinking?, resume?, destroyAfterSeconds? }`：拉起子 agent，等 pi 就绪且 prompt 送达后返回 id / name，不等结果。`name` 是 hc 终端名（侧边栏显示），1–32 位 `[a-z0-9._-]`、活终端间唯一，非法或重名直接报错；省略用 agent id。`model` / `thinking` 省略时继承父 agent 当前值。结果作为消息回到当轮 asker（拉起也算一次 ask）。`destroyAfterSeconds` 控制空闲销毁（见下文），默认 180 秒，`0` 表示永不销毁。
- `agent_job { action, id?, message? }`：`list`（本 hc session 所有活 agent，带 relation / parent / depth / status）、`kill`（仅自己的后代）、`ask`（目标必须 idle，忙则报错）、`steer`（目标必须 working）。子 agent 的结果按 asker 以消息回发，`agent` 的规则里因此写明「不要 sleep 等它」。

人工入口：`/agent list` 以**卡片式森林**渲染当前 hc session 的 agent 树——每棵独立的树一块（`▌` 引导），名字在前、id 在后，状态右对齐（不显示 cwd）；根显示 pi 会话名（无会话名时 `(root)`）；`●` 自己、`↑` 父 agent，父终端已消失的 agent 标「失联」。

身份与寻址：

- 子 agent id 是拉起时生成的 6 位十六进制短码，pi 会话 id 推导为 `pi-<id>`；resume 按 id 找会话文件重新拉起，不需要登记表。根 agent（人启动的 pi）的 id 是它的 hc 地址。
- `name` 只作显示；asker、会话路径等可变语义不进 hc label。发现靠创建时写入的 label `pi.agent=<id>`。
- 拉起时注入 `PI_AGENT_ID` / `PI_AGENT_NAME` / `PI_AGENT_PARENT` / `PI_AGENT_ROOT` / `PI_AGENT_DEPTH`，子进程的扩展据此知道自己是谁、在树里的哪一层；另外注入 `PI_AGENT_DESTROY_AFTER`（空闲销毁秒数）。

约束：

- **空闲销毁**：子 agent 在 settle 之后开始计时，安静满 `destroyAfterSeconds`（默认 180 秒）就自己 `ctx.shutdown()`，pi 退出后 hc 按 `rm: true` 删掉终端；会话文件仍在磁盘上，按 id `resume` 就能回来。`0` 表示永不销毁。
- 只有「安静」才计时：还有活的子终端、运行中的后台任务（pi-bg）、进程内子 agent（pi-subagents）或 cron job（pi-cron）都不算；后两者经 `lib/activity.ts` 的忙探测登记表汇总，没加载的扩展按「不忙」处理。任何新入站（`ask` / `steer` / 人打字 / cron 投递）立即清零。
- 每 30 秒一拍检查，销毁最多迟到一拍；`hc.list` 读不到时按「忙」处理。一个 `destroyAfterSeconds: 0` 的子 agent 会永久钉住父 agent（父永远有子），要收尾就用 `kill` 或删 cron。
- 树深最多三层（root → 子 → 孙），深度 2 的 agent 不再注册 `agent`。
- resume 不允许换模型 / 思考级别：传了与会话记录不一致的值直接报错（避免缓存整体未命中）。
- 结果正文超过 2000 行 / 50 KB 时按 bash 同款尾部截断，全文写 `pi-herdr-agent-*.log`，由 asker 自己读。
- `kill` 只允许自己的后代；root 正常退出时递归清理直接子 agent；硬崩溃留下的孤儿在 `list` 里标 `orphan`。
- 拉起时 `no_notify: true`：hc 的 note 不进消息通道；消息只有 `ask` 与结果回发。
- 子 agent settle 时把 pi 内置 reporter 的 OSC `state=done` 在 stdout 层改写成 `state=idle`：hc 侧只看到 `working → idle`，不留下 done（根 agent 不受影响）。
- 子 agent 卡在扩展 UI 弹窗时会给当轮 asker 发一条 blocked 提示。

回归测试：

```bash
node --test 'tests/pi-herdr-agent.test.ts'
```

### 通知配置

pi-notify 仅在交互 TUI 模式发通知，RPC/JSON/print 等非交互模式下静默。

主 agent 因 [@tintinweb/pi-subagents](https://www.npmjs.com/package/@tintinweb/pi-subagents) 的进程内子 agent 仍在运行或排队而停下等待时（同样触发 `agent_settled`），不发通知——只有真正完成才通知。探测实现在 `lib/subagents.ts`：注册表取不到时（未安装、被过滤、形状变化）一律按没有子 agent 处理，照常通知。作为 herdr 子 agent 运行的会话（有 `PI_AGENT_ID`）同样不通知：它的一轮结束不是人在等的那件事。

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
| `lib/hc.ts` | herdr-core 的 JSON-RPC 客户端（命名管道、一行一条） |
| `lib/agent-protocol.ts` | 子 agent 的消息信封、名称校验、结果截断（纯函数） |
| `lib/output-file.ts` | 超长结果落临时文件（与 pi 内置输出文件同套约定） |
| `lib/subagents.ts` | pi-subagents 注册表的子 agent 存活探测 |
| `lib/activity.ts` | 进程级忙探测登记表：pi-bg / pi-cron 各自登记，pi-herdr-agent 汇总 |
| `lib/cron/schedule.ts` | cron 表达式解析、下次触发、间隔换算（纯函数） |
| `lib/cron/presentation.ts` | 排期的人类可读化与触发 prompt 包装 |
| `lib/bg/jobs.ts` | 后台任务表：上限、淘汰、id 分配（纯函数） |
| `lib/bg/format.ts` | 后台任务的格式片段（耗时、状态行）与 TUI 专用文本 |
| `extensions/prompt/` | 全部模型可见文案，按扩展一文件；规则见 `extensions/prompt/README.md` |
| `lib/balance/providers.ts` | Provider 凭据、请求与响应归一化 |
| `lib/balance/render.ts` | `/balance` 结果排版 |
| `lib/json.ts` | Agent 数据目录 JSON 的容错读取与原子写入 |
| `lib/settings.ts` | settings.json 中的扩展配置读取 |
| `lib/render.ts` | entry 结果块的统一渲染 |
| `lib/text.ts` | basename、truncate 等文本工具 |
| `lib/http.ts` | HTTP 错误摘要 |
| `lib/errors.ts` | 任意异常值的可读消息 |
