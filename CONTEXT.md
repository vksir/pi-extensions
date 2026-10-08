# Pi Extensions

本仓库是 Pi 编码助手的一组扩展。扩展之间彼此独立，共享同一套领域语言来描述定时调度与子 Agent 委派。

## Language

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
循环 cron job 创建后立刻发生的那一次触发，先于第一次排期到期。
_Avoid_: 预热、首次运行、kickoff

**循环 cron job (Recurring)**：
按 cron 表达式反复触发的 cron job；创建后立即执行一次。
_Avoid_: 重复任务、loop

**一次性 cron job (One-shot)**：
只在唯一一个时刻触发一次、触发后自动删除的 cron job；没有立即执行。
_Avoid_: 单次任务、reminder、timer

**欠跑 (Backlog)**：
agent 忙碌期间已经到期的触发。欠跑会被合并：agent 一旦空闲，至多补一次触发。
_Avoid_: 积压队列、补跑次数、pending fires

**进程级 (Process-scoped)**：
cron job 的存续范围——活过 `/reload` 与 `/resume`，随 pi 进程退出而消失。
_Avoid_: 会话级、session-only、durable、持久化

**cron job 清单 (Job List)**：
当前进程中全部 cron job 的集合，是 `cron` 工具与 `/cron` 命令共同的真相来源。
_Avoid_: 任务清单、调度表、registry

### 子 Agent 委派（pi-subagent）

**Agent 定义 (Agent Definition)**：
描述一种专用 Agent 的配置模板，以类型名标识；同一份定义可以创建多个子 Agent 实例。
_Avoid_: Agent 实例、子进程、任务

**子 Agent 实例 (Subagent Instance)**：
归属于某个主会话、具有实例名与独立对话历史的逻辑工作者，可反复接收派发，运行资源回收后仍保留同一身份。同一主会话内实例名唯一，实例所属的 Agent 定义不随派发改变。
_Avoid_: Agent 定义、Agent 类型、一次性任务

**主会话 (Owner Session)**：
创建并拥有子 Agent 实例的主 Agent 会话，是实例名称与结果归属的边界；它的全部分支共享同一组子 Agent 实例。
_Avoid_: 全局 Agent 池、共享主进程

**派发 (Dispatch)**：
主 Agent 向某个子 Agent 实例发送一段 prompt 的动作；派发既可以启动新实例，也可以向已有实例补充输入。
_Avoid_: 创建任务、独立任务、触发

**工作轮次 (Work Round)**：
子 Agent 从开始处理输入到结束本轮自动工作的完整过程，可以同时处理多次派发；每个工作轮次产生一份结果，而非每次派发各自产生结果。
_Avoid_: 派发、单次模型请求、工具调用轮次

**实例续聊 (Instance Continuation)**：
子 Agent 实例在运行资源释放后恢复原有对话历史、继续接收派发的行为；恢复运行不等于创建一个没有历史的新实例。
_Avoid_: 新建对话、复制主会话、重新派发旧任务

**空闲回收 (Idle Reclamation)**：
子 Agent 实例结束当前工作且没有待处理输入后，因持续空闲而释放其运行资源的动作；对话历史仍然保留。
_Avoid_: 无输出超时、任务超时、删除会话
