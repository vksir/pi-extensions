# 子 agent 跑在 hc 终端树里，结果按 asker 回发

要替代 [@tintinweb/pi-subagents](https://www.npmjs.com/package/@tintinweb/pi-subagents) 的进程内子 agent：后者的 agent 与主 pi 同进程、不可在 herdr-app 里当独立终端观察，崩溃会连坐，也没有真正独立的生命周期。herdr-core（hc）已经提供了一套终端树：子终端的 `parent` 指向拉起它的终端，herdr-app 把没有 pane 的终端显示为父 tab 下的 sub-agent，`agent.focus` 可临时给它一个 pane。子 agent 因此落在 hc 终端里，每个都是独立的交互式 pi。

## 决策

- **一 agent 一终端一 pi**：`terminal.run` 直接以 `pi` 为 argv 启动，`parent` 指向调用者终端，`rm: true`（pi 退出即销毁终端），`no_notify: true`（hc 的 note 不参与语义）。
- **身份靠 env 注入**：`PI_AGENT_ID` / `PI_AGENT_NAME` / `PI_AGENT_PARENT` / `PI_AGENT_ROOT` / `PI_AGENT_DEPTH`。根 agent（人启动的 pi）没有这些变量，id 取 hc 地址。
- **id 与 name 分离**：id 是 6 位十六进制短码，跨 resume 不变；name 是 hc 终端名（侧边栏显示），创建时固定、只作显示——asker、会话路径这类可变语义不进 label。
- **会话 id 由 agent id 推导**为 `pi-<id>`；resume 扫 sessions 目录找 `_pi-<id>.jsonl`，读头里的 cwd 重新拉起。不引入第二份登记表（hc doc 是 per-session 的，换 session 就丢）。
- **结果按 asker 回发**：消息首行信封带 kind（`ask` / `steer` / `result`），接收方在 `input` 事件里剥掉并记当轮 asker；settle 时把最终文本发回 asker，`kind=result` 不设 asker，避免回环。hc 自己会给发给 agent 的消息套一层 `<hc from="…">…</hc>`（`notes = false` 时不套），所以解析先剥运输层、再看信封。
- **树深三层**（root 0 → 子 1 → 孙 2），深度 2 不再注册 `agent`；`kill` 只允许自己的后代；`session_shutdown(reason=quit)` 递归杀直接子 agent。

## 被否决的选项

- **继续用进程内子 agent**：与主 pi 共享进程，无法在 herdr-app 里当独立终端观察，崩溃会连坐，也没有 hc 的 parent 语义。
- **`hc run` CLI**：`terminal.run` 的 `env` 没有 CLI 对应项，而身份注入是核心需求；socket 还免去命令行转义。
- **doc / labels 当登记表**：labels 创建时固定，不承担可变语义；doc 按 hc session 隔离，换 session 旧登记就丢了。推导式会话 id 零存储、跨 session 成立，故弃用。
- **预开标签页**：每个 agent 一个 herdr-app tab 会把标签栏塞满；headless 终端以 sub-agent 形式挂在父 tab 下，要看时 `agent.focus`。
- **沿用 hc 的 note 作为状态通道**：note 是纯文本打进父 agent 输入，会额外触发回合，且只到父、不到 asker；与结果回发重复。
- **允许 resume 换模型 / 思考级别**：会话缓存会整体未命中，代价远大于收益，所以传了不一致的值直接报错。

## 后果

- 每个子 agent 都是一个完整 pi 进程：内存与启动开销真实存在；树深限三层，并发不设上限（扇出由模型自己控制）。
- 结果正文按 bash 工具同款（2000 行 / 50 KB）尾部截断，全文落 `pi-herdr-agent-*.log`，由 asker 自己读。
- 子 agent 的 settle 状态从 pi 内置的 `done` 改写成 `idle`（stdout 层改写 OSC 7501）；根 agent 保持原生 `done` 行为。
- `blocked` 只覆盖扩展 UI 弹窗（`ui_prompt_start`）；pi 内置的其他等待不会自动通知 asker，需 `agent_job list` / `wait` 发现。
- root 的终端前台是 shell，hc 原生的「子随父程序结束」不覆盖 root：正常退出靠扩展显式清理，硬崩溃会留下孤儿，`list` 标记 `orphan`，没有看门狗。
- resume 依赖会话文件仍在磁盘；agent 的终端被销毁不影响 resume。
