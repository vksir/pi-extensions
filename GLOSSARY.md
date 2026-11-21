# Pi Extensions

本仓库是 Pi 编码助手的一组扩展。扩展之间彼此独立，各自维护自己的领域语言。

## Language

### Token 速率（pi-token-stats）

**输出速率 (Output Rate)**：
最近一次完成的 assistant 响应的输出 token 数除以该次耗时（`AssistantMessage.durationMs`），单位 token/秒，显示在 footer 状态行的缓存读取与缓存命中率之间。耗时含思考与首字等待，不单算生成窗口。
_Avoid_: 速度、生成速度、tokens per second、TPS

**会话视图替身 (footer session stand-in)**：
扩展上下文里能取到的那部分会话数据，用来驱动内置 `FooterComponent` 渲染——因为 `setFooter` 只能整体替换 footer。
_Avoid_: 假 session、mock session

**时间窗 (Time Window)**：
`/token` 的聚合范围，默认过去 1 小时，可用 `3h` / `30m` / `1d` / `all` 等参数指定。窗口覆盖库里的所有会话与所有 pi 进程，不按会话区分。
_Avoid_: 区间、时间段、period

**首字延迟 (Time to First Token)**：
时间窗内测到首字的响应之和除以样本数，按模型展示。首字只能在流式过程中测，样本数可能少于响应数；没有样本时显示 `-`。
_Avoid_: 平均延迟、平均耗时、平均首字（与旧会话口径混淆）

**时间窗速率 (Window Output Rate)**：
时间窗内有耗时响应的输出 token 之和除以这些响应的耗时之和，单位 token/秒。按 token 加权，不是逐次速率的算术平均；耗时取完整请求时间（含首字等待）。
_Avoid_: 平均速度、平均 TPS、会话平均速率

**明细行 (Turn Record)**：
SQLite 里 `turn` 表的一行，对应一次 assistant 响应，带时间、会话、模型、用量、耗时与首字。时间窗汇总直接聚合它。
_Avoid_: 事件、日志行、raw event

**归档表 (Archive Table)**：
schema v2 迁移时由 v1 的 `day_model` / `session` 改名而来的 `archive_day_model` / `archive_session`。数据保留，不再写入也不再读取。
_Avoid_: 旧表、废弃表、legacy table

**schema 版本 (Schema Version)**：
记在 `meta.schema_version` 的整数。打开数据库时按它跑迁移；v2 把旧汇总表归档，并把版本写回。
_Avoid_: 数据库版本、migration id

**写线程 (Writer Worker)**：
token-stats 独占 SQLite 连接的 worker 线程。主线程只 `postMessage` 一轮响应；建库、迁移、写入、查询都按消息顺序在这里执行，不阻塞 TUI 的事件循环。
_Avoid_: 后台任务、异步队列、db thread

### 定时调度（pi-cron）

**cron job**：
用户排定、由扩展在指定时刻递交给 agent 的一段 prompt，拥有一个短 id。
_Avoid_: 定时任务、循环任务、loop、timer、scheduled task

**cron 表达式 (Cron Expression)**：
cron job 的排期表示，5 字段（分钟 小时 日 月 星期），按进程本地时区解释。
_Avoid_: 计划表、schedule string、时间表

**间隔 (Interval)**：
用户用来描述排期的自然写法（如 `5m`、`2h`、`1d`，或多个片段连写如 `1h30m`），在创建 cron job 时被转换为 cron 表达式。省略时按默认间隔 `15m` 处理。
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
主 agent settle 且没有进程内子 agent 在跑时发出的桌面通知；等子 agent 的 settle、herdr 子 agent 会话（有 `PI_AGENT_ID`）、中止与非交互模式一律静默。
_Avoid_: 结束提醒、done 提示

### 顺带分派（pi-btw）

**顺带请求 (btw request)**：
用户经 `/btw` 递交的一段消息，作为新 pi 的首条消息随启动 argv 递交（经 `--` 停止选项解析，见 ADR-0004）。与当前会话互不干扰。
_Avoid_: 旁支任务、side task、转交

**btw 标签 (btw tab)**：
承载 fork 出去的新 pi 的新开标签；不命名，沿用 herdr 的默认编号命名。
_Avoid_: 分身标签、影子会话、shadow session

**fork 会话 (Forked Session)**：
btw 标签里新 pi 的会话起点——以 `pi --fork <当前会话文件>` 从当前会话分叉，带全量上下文，fork 进当前工作目录。当前 turn 未结束时，fork 源先截到最后一个 turn 边界。
_Avoid_: 新会话、克隆、clone、resume

**turn 边界 (Turn Boundary)**：
一条 content 里不含工具调用的 assistant 消息，代表一轮对话的收尾。pi 只在 `message_end` 落盘，会话文件在 turn 进行中必然停在半截；`/btw` 据此把 fork 源回退到最后一个完整轮次（见 ADR-0008）。
_Avoid_: 检查点、断点、checkpoint、断点续跑

**fork 快照 (Fork Snapshot)**：
忙碌时由 `snapshotAtTurnBoundary()` 写进系统临时目录的会话副本——header + 当前分支到 turn 边界的前缀，供 `pi --fork` 使用；源会话只读。
_Avoid_: 临时会话、备份会话、dump

### 标题与标签（pi-title）

**旧 herdr (legacy herdr)**：
第一代 herdr 终端复用器，以 `HERDR_ENV=1` + `HERDR_TAB_ID` + `HERDR_BIN_PATH` 声明环境；标签 id 由 env 直接给出，操作走 `herdr` CLI。
_Avoid_: herdr CLI 环境、herdr v1

**herdr app**：
第二代 herdr（herdr-app 窗口 + herdr-core 终端后端），以 `HC_TERMINAL_ID` 声明环境；标签 id 不在 env 里，寻址要经 `herdr-app ls` 查询（见 ADR-0005）。
_Avoid_: herdr-core 环境、HC 环境

**标签更名 (tab rename)**：
`/name` 更名会话时把 pi 所在的窗口标签同步改名；会话启动（resume、`/reload`、切换会话）后按已有会话名再对齐一次，免得 herdr 在未命名标签上回落到 pi 的 `π - <会话名> - <cwd>` 标题。两代 herdr 命令不同（`herdr tab rename` / `herdr-app do tab.rename`），失败一律静默放弃。
_Avoid_: 重命名窗口、title rename

### 后台任务（pi-bg）

**后台任务 (bg job)**：
立刻把控制权交还模型、自身继续执行的一次命令或脚本，拥有一个 8 位十六进制的任务 id。两种来源：由 `bash_bg` / `codemode_bg` 直接启动，或由前台调用到点转后台（见「转后台」）。id 在文本与工具参数之外一律写作 `bg_job <id>`，不单独出现（避免与子 Agent 的 id 混淆）。
_Avoid_: 异步任务、后台进程、job、subprocess

**结果回传 (bg delivery)**：
后台任务结束时把输出作为 `pi-bg` 自定义消息投递给会话的动作；投递点是当前 turn 的工具跑完、下一次 LLM 调用之前，agent 空闲时立刻起一轮。被 `bg_job kill` 终止的任务不回传。
_Avoid_: 通知、回调、推送、notify

**启用联动 (availability)**：
三个后台工具都跟着内置工具的启用状态走：`bash` 未启用就不注册 `bash_bg`，两个后端都未启用就连 `bg_job` 也不注册。schema 复用 `getAllTools()` 里内置工具的那一份，所以不是「功能相同」的承诺，而是同一份声明。
_Avoid_: 动态开关、条件注册、feature flag

**委托 (delegation)**：
后台工具把执行交给内置 `bash` / `codemode` 完成的做法——后台工具只是外壳，不重新实现命令执行、截断与沙箱（见 ADR-0006）。
_Avoid_: 包装、转发、代理、wrap

**转后台 (promote)**：
前台 `bash` / `codemode` 调用超过等待预算仍未结束，就把执行中的命令或脚本转为后台任务、立刻把控制权交还模型的动作；进程/沙箱不重启，输出不丢。只发生在模型直接调用那一层，嵌套调用（脚本里的 `tools.bash`、`bash_bg` 的委托）永不转。
_Avoid_: 升级、转化、detach、backgrounding、超时

**等待预算 (foreground budget)**：
`pi-bg.promoteAfterSeconds` 的值，前台 `bash` / `codemode` 一次调用允许阻塞的最长时间；`<= 0` 表示关闭，此时连覆盖版都不注册。
_Avoid_: 超时、timeout、上限、limit

**存续域 (lifetime)**：
后台任务只活在当前会话里：`/new`、`/reload`、`/resume`、`/fork`、退出都中止全部在跑任务。
_Avoid_: 进程级、全局、persistent

### 子 agent（pi-herdr-agent）

**herdr 子 agent (agent)**：
由 `agent` 工具在 headless hc 终端里拉起的交互式 pi；每个都是独立进程、独立 pi 会话，按 hc 的 parent 关系组成树。与 pi-subagents 的进程内子 agent 是两种形态。
_Avoid_: 进程内子 agent、subagent、分身、worker

**agent id**：
agent 的 6 位字母数字短码（如 `a7k2f9`），是工具参数与消息里唯一的寻址名。子 agent 的 id 在拉起时生成（与推导出的会话 id `pi-<id>` 绑定，跨 resume 不变）；根 agent 的 id 取自己会话 id 末尾 6 位（uuidv7 尾段，如 `5e6f70`），写进终端的 `pi.agent.root` label 供树里其它 agent 识别，`/new`、`/resume`、`/fork` 后随会话 id 重写；label 写不进去时退回 hc 终端地址（如 `t4m`）。
_Avoid_: 会话 id、uuid、handle、agent 名

**name（侧边栏名）**：
子 agent 的 hc 终端名，创建时固定，herdr-app 侧边栏显示的就是它；1–32 位 `[a-z0-9._-]`，活终端间唯一，非法或重名直接报错。根 agent 没有自己的 hc 名，`/agent list` 里的显示名取 pi 终端标题（`/name` 的会话名，未命名时 `π - <cwd>`），不取 hc 终端名。只作显示，寻址一律用 agent id。
_Avoid_: label、别名、标题、会话名

**asker（当轮提问者）**：
发起当前这一轮对话的 agent：可能是拉起者，也可能是后来通过 `agent_job ask` 提问的任意 agent。只活在接收方进程内存里，一轮 settle 后清空；拉起时的 prompt 也算一次 ask。
_Avoid_: 调用方、owner、requester、父 agent（归属关系与当轮发起是两件事）

**结果回发 (result delivery)**：
子 agent 一轮结束（settle）时把最终 assistant 文本发给当轮 asker 的动作；没有 asker 的轮（人直接打字、收到 result、单纯 steer）不回发。
_Avoid_: 通知、回调、completion、汇报

**销毁倒计时 (destroy countdown)**：
子 agent 空闲满 `destroyAfterSeconds`（默认 180 秒）后自行退出、由 hc 删掉终端的机制；`0` 表示永不销毁。只有「安静」时才计时——还有活着的子终端、运行中的后台任务、进程内子 agent 或 cron job 都不算，任何新入站立即清零。销毁只回收终端与进程，会话文件仍在磁盘上，可按 id resume。
_Avoid_: TTL、超时、idle timeout、GC、回收

**信封 (agent envelope)**：
消息首行的一行标签 `<pi-agent from="…" addr="…" name="…" kind="ask|steer|result">`；接收方扩展在 `input` 事件里剥掉它，模型只看到正文。`kind=result` 的入站消息不设 asker，避免回环。
_Avoid_: header、前缀、metadata、标记

**会话推导 (derived session id)**：
子 agent 的 pi 会话 id 由 agent id 确定性推导为 `pi-<agent id>`；resume 时按它扫 `sessions/*/` 找会话文件，不需要任何登记表。根 agent 反过来：id 是从自己的会话 id 尾部截出来的。
_Avoid_: 映射表、registry、session 映射
