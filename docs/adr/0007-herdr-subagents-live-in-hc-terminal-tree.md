# 子 agent 跑在 hc 终端树里，结果按 asker 回发

> **部分被取代**：消息与回发部分（「结果按 asker 回发」、消息信封的 `kind=ask|steer|result`）已由 [ADR-0011](0011-agent-dispatch-owner-and-queue.md) 取代，又由 [ADR-0012](0012-agent-replies-are-sends.md) 统一成单一的 `send`（扩展不再代发）。本文件其余部分（终端树、身份注入、id 推导、空闲销毁）仍然有效。

要替代 [@tintinweb/pi-subagents](https://www.npmjs.com/package/@tintinweb/pi-subagents) 的进程内子 agent：后者的 agent 与主 pi 同进程、不可在 herdr-app 里当独立终端观察，崩溃会连坐，也没有真正独立的生命周期。herdr-core（hc）已经提供了一套终端树：子终端的 `parent` 指向拉起它的终端，herdr-app 把没有 pane 的终端显示为父 tab 下的 sub-agent，`agent.focus` 可临时给它一个 pane。子 agent 因此落在 hc 终端里，每个都是独立的交互式 pi。

## 决策

- **一 agent 一终端一 pi**：`terminal.run` 直接以 `pi` 为 argv 启动，`parent` 指向调用者终端，`rm: true`（pi 退出即销毁终端），`no_notify: true`（hc 的 note 不参与语义）。
- **身份靠 env 注入**：`PI_AGENT_ID` / `PI_AGENT_NAME` / `PI_AGENT_PARENT` / `PI_AGENT_ROOT` / `PI_AGENT_DEPTH`。子 agent 的 id 在拉起时生成（6 位 hex），根 agent（人启动的 pi）的 id 取自己会话 id 末尾 6 位。
- **根 agent 自己登记短 id**：`session_start` 时把会话 id 尾段写进自己终端的 `pi.agent.root` label（`/new`、`/resume`、`/fork` 后随会话 id 重写），树里其它 agent 从 `terminal.list` 即可认出根；label 写失败时退回 hc 地址。label 只承担这一项发现职责，asker 等可变语义仍不进 label。
- **id 与 name 分离**：id 是 6 位字母数字短码，子 agent 跨 resume 不变（根的 id 随会话切换而变）；name 是 hc 终端名（侧边栏显示），创建时固定、只作显示；根的显示名取 pi 终端标题（`/name` 或 `π - <cwd>`）——asker、会话路径这类可变语义不进 label。
- **会话 id 由 agent id 推导**为 `pi-<id>`；resume 扫 sessions 目录找 `_pi-<id>.jsonl`，读头里的 cwd 重新拉起。不引入第二份登记表（hc doc 是 per-session 的，换 session 就丢）。
- **结果按 asker 回发**：消息首行信封带 kind（`ask` / `steer` / `result`），接收方在 `input` 事件里剥掉并记当轮 asker；settle 时把最终文本发回 asker，`kind=result` 不设 asker，避免回环。hc 自己会给发给 agent 的消息套一层 `<hc from="…">…</hc>`（`notes = false` 时不套），所以解析先剥运输层、再看信封。
- **树深三层**（root 0 → 子 1 → 孙 2），深度 2 不再注册 `agent`；`kill` 只允许自己的后代；`session_shutdown(reason=quit)` 递归杀直接子 agent。

## 被否决的选项

- **继续用进程内子 agent**：与主 pi 共享进程，无法在 herdr-app 里当独立终端观察，崩溃会连坐，也没有 hc 的 parent 语义。
- **`hc run` CLI**：`terminal.run` 的 `env` 没有 CLI 对应项，而身份注入是核心需求；socket 还免去命令行转义。
- **doc / labels 当登记表**：labels 创建时固定，不承担可变语义；doc 按 hc session 隔离，换 session 旧登记就丢了。推导式会话 id 零存储、跨 session 成立，故弃用（例外：根 agent 只在自己终端上写一个 `pi.agent.root` 短 id 作发现提示，会话切换时重写）。
- **预开标签页**：每个 agent 一个 herdr-app tab 会把标签栏塞满；headless 终端以 sub-agent 形式挂在父 tab 下，要看时 `agent.focus`。
- **沿用 hc 的 note 作为状态通道**：note 是纯文本打进父 agent 输入，会额外触发回合，且只到父、不到 asker；与结果回发重复。
- **允许 resume 换模型 / 思考级别**：会话缓存会整体未命中，代价远大于收益，所以传了不一致的值直接报错。

## 后果

- 每个子 agent 都是一个完整 pi 进程：内存与启动开销真实存在；树深限三层，并发不设上限（扇出由模型自己控制）。
- 结果正文按 bash 工具同款（2000 行 / 50 KB）尾部截断，全文落 `pi-herdr-agent-*.log`，由 asker 自己读。
- 子 agent 的 settle 状态从 pi 内置的 `done` 改写成 `idle`（stdout 层改写 OSC 7501）；根 agent 保持原生 `done` 行为。
- `blocked` 在子 agent 上会被认出来：它停在工作就发一条「没回信」通知给发消息的一方，`blocked` / `error` 附上等待种类或错误首行（见下方增补）。
- 目标停止工作（`idle` / `done` / `blocked` / `error`）后不会再自己回信，所以等回信的一笔记的是「停止」而不是「退出」：`agent_job list` 仍可查，但不必等它退出。
- root 的终端前台是 shell，hc 原生的「子随父程序结束」不覆盖 root：正常退出靠扩展显式清理，硬崩溃会留下孤儿，`list` 标记 `orphan`，没有看门狗。
- resume 依赖会话文件仍在磁盘；agent 的终端被销毁不影响 resume。

## 增补：空闲销毁与忙探测（2026-02）

长期驻留的终端会随扇出累积，每个都是完整 pi 进程。`agent` 因此增加 `destroy_time`：子 agent 在 settle 之后自己退出，`rm: true` 顺手删掉终端；会话文件留在磁盘上，按 id `resume` 仍然成立。

- **默认 180 秒，`0` 关闭**：策略随每次拉起 / resume 的调用传入，注入 `PI_AGENT_DESTROY_TIME`，不落会话——生命周期是运行策略，不是会话内容。根 agent 没有这个 env，保持原生行为。
- **只在「安静」时计时**：有活的子终端、运行中的后台任务、进程内子 agent 或 cron job 都不算安静。后两者由 `lib/activity.ts` 在 globalThis 上登记忙探测（pi-bg 看运行中任务，pi-cron 看 job 表），探测不到一律按「不忙」处理。
- **新入站清零，30 秒一拍**：任何 `ask` / `steer` / 人打字 / cron 投递都重置计时；销毁最多迟到一拍；`hc.list` 失败按「忙」处理（不知道该不该杀就先不杀）。
- **发起点在子 agent 自己**，不在拉起者：省掉「我拉起过谁」的登记表，asker 先退出也照样收尸，resume 拉起的新进程天然按本次参数重新决定生死。

### 被否决的选项（增补）

- **settle 后立即销毁**：一轮结束就杀，等于砍掉 `ask` / `steer` 的续聊窗口，而这是 asker 最常用的路径。
- **父 agent 收到结果后回来 `hc.kill`**：需要在拉起者维护登记表，与「id 与终端靠推导、不落表」的决策冲突；子 agent 自己退出还能直接复用 hc 的 `rm: true`。
- **把 `destroy_time` 写进会话**：会话会在下次 resume 时悄悄改变运行策略，与会话文件「只记对话」的定位冲突。

### 后果（增补）

- 一个 `destroy_time: 0` 的子 agent 会永久钉住父 agent（父永远有子）；同理循环 cron 会永久钉住它的 agent。要收尾只能 `kill` 或删 cron。
- 忙探测只覆盖**本进程**：别的 pi 进程里的任务不算，这与「销毁只影响自己这棵子树」一致。
- 倒计时期间 agent 仍是 `idle`：`ask` 照常可用，`list` / `wait` 也看不出它即将消失。

## 增补：等回信的账记在「停止工作」上（2026-11）

原来只有终端消失（`finished` / `removed`）才补一条「它退出了但没回信」。子 agent 停止工作后不会再自己回信——413 之类的错误停在 `error`、弹窗停在 `blocked`、正常收工停在 `idle` / `done`——这些情况以前只能靠 `agent_job list` 发现，发消息的一方会一直等。

- **判据是 hc 的状态词**：`working` 算在干活；`idle` / `done` / `blocked` / `error` 都算停了。信号只来自已有的 `events.subscribe`（`children_of: self` 或单个终端）的 `status` 事件，以及没有事件时的 `hc.list()` 轮询，不新增定时器、不打 stdout。
- **一段停止只报一次**：见过 `working`、或我又发了一条，才算新的一段；`told` 标记随账走，收到回信或账销掉即清。停住后再退出，只销账不补第二条。
- **自己停的不报**：`agent_job stop` 成功后销账，避免「我叫它停的」变成「它没回信」。
- **只有派活要回答**：`agent_job send` 的 `type=reply` 不记账——否则回信本身会再记一笔「等对方回答回信」，子父之间来回触发。
- **订阅快照只认 `working`**：事件订阅建立得晚时，快照里的 `working` 补上错过的那条；快照里就停着的没有「变了」的含义，交给后续事件（轮询路径另有 20 秒启动宽限，防止刚发出去就宣布没回）。
- **hc 的 note 照旧关掉**（拉起时 `no_notify: true`），通知只有一种形态：扩展发的 `type="notice"` 卡片。

### 被否决的选项（增补）

- **停止后的固定宽限**：等 5 秒再报只换来「通知变慢」，而 `status` 事件本身就是变化通知，不重复。
- **靠抢在 hc 的 note 之前 `terminal.get` 标已读**：`no_notify` 已经让 core 根本不生成 note，不需要竞态。
- **轮询所有账**：事件路径健康时仍然轮询会把「不发定时器」的设计退回去。
