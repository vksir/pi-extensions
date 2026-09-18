# Pi Extensions

本仓库是 Pi 编码助手的一组扩展。扩展之间彼此独立，共享同一套领域语言来描述「进程内 cron 调度」。

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
