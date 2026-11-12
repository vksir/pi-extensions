# Pi Extensions

本仓库是 Pi 编码助手的一组扩展。扩展之间彼此独立，各自维护自己的领域语言。

## Language

### Token 用量（pi-token-stats）

**输出速率 (Output Rate)**：
最近一次完成的 assistant 响应的输出 token 数除以该次耗时（`AssistantMessage.durationMs`），单位 token/秒，显示在 footer 状态行的缓存读取与缓存命中率之间。耗时含思考与首字等待，不单算生成窗口。
_Avoid_: 速度、生成速度、tokens per second、TPS

**会话视图替身 (footer session stand-in)**：
扩展上下文里能取到的那部分会话数据，用来驱动内置 `FooterComponent` 渲染——因为 `setFooter` 只能整体替换 footer。
_Avoid_: 假 session、mock session

### 定时调度（pi-cron）

**cron job**：
用户排定、由扩展在指定时刻递交给 agent 的一段 prompt，拥有一个短 id。
_Avoid_: 定时任务、循环任务、loop、timer、scheduled task

**cron 表达式 (Cron Expression)**：
cron job 的排期表示，5 字段（分钟 小时 日 月 星期），按进程本地时区解释。
_Avoid_: 计划表、schedule string、时间表

**间隔 (Interval)**：
用户用来描述排期的自然写法（如 `5m`、`2h`、`1d`，或多个片段连写如 `1h30m`），在创建 cron job 时被转换为 cron 表达式。
_Avoid_: 周期、cadence、frequency

**规范化 (Canonical Form)**：
间隔到 cron 表达式的转换规则；间隔无法被 cron 精确表达时，取最接近的干净间隔。
_Avoid_: 归一化、取整、rounding

**触发 (Fire)**：
把某个 cron job 的 prompt 递交给 agent 的那一次动作。prompt 逐字递交，不附加任何包装文字。
_Avoid_: 运行、执行、回调、tick

**立即执行 (Immediate Fire)**：
循环 cron job 创建后立刻发生的那一次触发，先于第一次排期到期；agent 忙碌时不打断进行中的会话，转欠跑，空闲后补。
_Avoid_: 预热、首次运行、kickoff、steer

**循环 cron job (Recurring)**：
按 cron 表达式反复触发的 cron job；创建后立即执行一次。
_Avoid_: 重复任务、loop

**一次性 cron job (One-shot)**：
只在唯一一个时刻触发一次、触发后自动删除的 cron job；没有立即执行。
_Avoid_: 单次任务、reminder、timer

**欠跑 (Backlog)**：
agent 忙碌期间已经到期的触发。欠跑会被合并：agent 一旦空闲，至多补一次触发；但用户手动打断（Esc）时直接作废，不补发。
_Avoid_: 积压队列、补跑次数、pending fires

**手动打断 (Abort)**：
用户按 Esc 中止当前一轮。打断后的 settle 不补跑欠跑，到期的欠跑作废——「停」就是「停」，不拿延迟的触发再起一轮。已过期的一次性 cron job 因此无法再触发，直接删除。
_Avoid_: 取消、中止信号、interrupt

**进程级 (Process-scoped)**：
cron job 的存续范围——活过 `/reload` 与 `/resume`，随 pi 进程退出而消失。
_Avoid_: 会话级、session-only、durable、持久化

**cron job 清单 (Job List)**：
当前进程中全部 cron job 的集合，是 `cron` 工具与 `/cron` 命令共同的真相来源。
_Avoid_: 任务清单、调度表、registry

### 完成通知（pi-notify）

**进程内子 agent (in-process subagent)**：
@tintinweb/pi-subagents 在主 pi 进程内拉起并托管的 agent；存活状态经 `globalThis` 上 `pi-subagents:manager` 注册表查询，覆盖 running 与 queued 两种状态。
_Avoid_: 分身、内部 agent、内嵌 agent

**完成通知 (completion notification)**：
主 agent settle 且没有进程内子 agent 在跑时发出的桌面通知；等子 agent 的 settle、中止与非交互模式一律静默。
_Avoid_: 结束提醒、done 提示

### 顺带分派（pi-btw）

**顺带请求 (btw request)**：
用户经 `/btw` 递交的一段消息，作为新 pi 的首条消息随启动 argv 递交（经 `--` 停止选项解析，见 ADR-0004）。与当前会话互不干扰。
_Avoid_: 旁支任务、side task、转交

**btw 标签 (btw tab)**：
承载 fork 出去的新 pi 的新开标签；不命名，沿用 herdr 的默认编号命名。
_Avoid_: 分身标签、影子会话、shadow session

**fork 会话 (Forked Session)**：
btw 标签里新 pi 的会话起点——以 `pi --fork <当前会话文件>` 从当前会话分叉，带全量上下文，fork 进当前工作目录。
_Avoid_: 新会话、克隆、clone、resume

### 标题与标签（pi-title）

**旧 herdr (legacy herdr)**：
第一代 herdr 终端复用器，以 `HERDR_ENV=1` + `HERDR_TAB_ID` + `HERDR_BIN_PATH` 声明环境；标签 id 由 env 直接给出，操作走 `herdr` CLI。
_Avoid_: herdr CLI 环境、herdr v1

**herdr app**：
第二代 herdr（herdr-app 窗口 + herdr-core 终端后端），以 `HC_TERMINAL_ID` 声明环境；标签 id 不在 env 里，寻址要经 `herdr-app ls` 查询（见 ADR-0005）。
_Avoid_: herdr-core 环境、HC 环境

**标签更名 (tab rename)**：
`/name` 更名会话时把 pi 所在的窗口标签同步改名；两代 herdr 命令不同（`herdr tab rename` / `herdr-app do tab.rename`），失败一律静默放弃。
_Avoid_: 重命名窗口、title rename

### 后台任务（pi-bg）

**后台任务 (bg job)**：
由 `bash-bg` / `codemode-bg` 启动、立刻把控制权交还模型、自身继续执行的一次命令或脚本，拥有一个 8 位十六进制的任务 id。
_Avoid_: 异步任务、后台进程、job、subprocess

**结果回传 (bg delivery)**：
后台任务结束时把输出作为 `pi-bg` 自定义消息投递给会话的动作；投递点是当前 turn 的工具跑完、下一次 LLM 调用之前，agent 空闲时立刻起一轮。被 `bg kill` 终止的任务不回传。
_Avoid_: 通知、回调、推送、notify

**交付 (bg delivery state)**：
一份输出是“只到达一次”的状态：要么作为 `pi-bg` 消息回传，要么被 `bg wait` 的 tool result 接过。后到的 `bg wait` 只报状态，不重复输出。
_Avoid_: 消费、去重、已读

**等候 (bg wait)**：
`bg wait [id]` 阻塞到任务结束、直接把原样输出放进 tool result 的动作；省略 id 则等全部在跑任务。父轮 Esc 取消的只是「等」，任务照跑、结果仍会回传。
_Avoid_: 轮询、poll、join、同步等待

**启用联动 (availability)**：
三个后台工具都跟着内置工具的启用状态走：`bash` 未启用就不注册 `bash-bg`，两个后端都未启用就连 `bg` 也不注册。schema 复用 `getAllTools()` 里内置工具的那一份，所以不是「功能相同」的承诺，而是同一份声明。
_Avoid_: 动态开关、条件注册、feature flag

**委托 (delegation)**：
后台工具把执行交给内置 `bash` / `codemode` 完成的做法——后台工具只是外壳，不重新实现命令执行、截断与沙箱（见 ADR-0006）。
_Avoid_: 包装、转发、代理、wrap

**存续域 (lifetime)**：
后台任务只活在当前会话里：`/new`、`/reload`、`/resume`、`/fork`、退出都中止全部在跑任务。
_Avoid_: 进程级、全局、persistent
