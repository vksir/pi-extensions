# /btw 的消息进 pi 启动 argv，经 `--` 停止选项解析

pi-btw 用 `/btw <消息>` 在新标签里启动一个 fork 当前会话的 pi，并把消息作为首条消息。决策历经三次迭代，最终形态：**fork 参数与消息一起进 pi 的启动 argv**——`pi --fork <file> -- <消息>`。

## 演进与证据

1. **初版：消息走 herdr 首消息通道**（herdr app 的 `tab.new --task`、旧 herdr 的 `agent prompt`），理由是消息含 `-` 开头会被 pi 当 flag、Windows ~32K argv 限制、想复用 herdr 的 first_message 机制。实测发现 `--task` 对带参数的 argv launch **根本不投递**（裸 `["pi"]` 正常，带 `--fork` 后 `first_message` 恒 null，消息静默丢失，无记录可查）。
2. **二版：轮询 `hc get` 等 idle 后 `hc send`**（hc 手册的备用路径）。能送达，但引入「pi 已就绪可见、消息迟迟不来」的间隔（fork 大会话时可达数秒），且 `hc send` 会给消息包一层 `<hc from="…">` 来源标签（herdr-core 的 notes 功能，全局 `notes = false` 可关但需重启 core）。
3. **终版：消息进 argv**。实测（2026-11-05）herdr-core 的 pwsh 包装转义可靠：单引号、双引号、`$`、反引号、`%`、多行、中文、`--` 开头行全部原样到达；`tab.new` 仅 ~50ms，**82ms 后 pi 已带消息开跑**——「启动到发送」的间隔归零。`--` 分隔符解决 `-` 开头消息（pi 文档明确支持）。

旧 herdr 路径与 app 对齐：`tab create` → `pane run <pane> pi --fork '<file>'`（命令行只含 ASCII 安全的启动参数——`pane run` 是把命令**逐字敲进 pane 的 shell**，用户消息绝不能进这里，多行文本会被 shell 撕碎）→ 轮询 `agent list` 等 herdr 在该 pane 识别出 pi 且 `agent_status` 为 idle（agent 刚被检测到时是 unknown，TUI 尚未就绪；实测 ~0.5s）→ `pane send-text` + `pane send-keys enter` 逐字投递。**全程不注册命名 agent**：`agent start` 强制命名（空名被拒：`invalid_agent_name`），弃用。实测转义 gauntlet（引号/`$`/反引号/多行/`--flag` 开头行）全部逐字到达。

## 被否决的选项

- **`tab.new --task`**：对带参数的 argv launch 不投递，静默丢消息。
- **`hc get` 轮询 + `hc send`**：功能正确但慢（就绪探测 + 发送两段延迟），消息带 `<hc>` 包装；作为过渡方案已被替换。
- **`hc keys`**：只接受键名，无法整段输入多行中文文本。
- **消息作为 pi 位置参数且不加 `--`**：`-` 开头消息会被 pi 当 flag。加 `--` 后此顾虑消除。
- **旧 herdr 用 `pane run` 直接携带消息**：pane run 把命令敲进 shell，多行文本被续行符撕碎（实测 ParserError）；消息必须走 send-text。
- **旧 herdr 用 `agent start` + `agent prompt`**：`agent start` 强制命名，名字（如 `btw-mw3ii0tj`）会污染 agent 列表；prompt 还需名字寻址，整条链路因此被 pane run + send-text 取代。

## 后果

- app 路径一次 CLI 调用完成全部工作；错误由 herdr 以非零码 + 明文报出，无中途残留状态。
- `@path` 开头的消息会被 pi 当文件引用——这是 pi argv 语义的自然延伸，用户真需要引用文件时行为反而是对的。
- 消息超过 ~32K（Windows 命令行上限）时启动失败，herdr 报错可见；/btw 场景下极罕见。
- 旧 herdr 与 app 路径在消息通道上不对称（prompt vs argv），若旧路径也出现速度抱怨，可按同思路把消息挪进 AGENT_ARG 并实测 `agent start` 的就绪检测。
