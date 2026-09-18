# cron job 的存续域是进程级，载体是 globalThis

pi-cron 的 cron job 需要一种存续域。我们选择**进程级**：cron job 活过 `/reload` 与 `/resume`，随 pi 进程退出而消失。实现上 cron job 表挂在一个固定的 `globalThis` Symbol 上，而不是扩展的模块级变量——因为 pi 在 `/reload` 时会用 jiti 重新导入扩展模块（`loader.js` 传 `moduleCache: false`），模块级变量必然丢失，`globalThis` 是唯一既能跨 reload 存活、又不跨进程的载体。扩展实例只持有定时器，`session_shutdown` 清定时器，`session_start` 从 `globalThis` 重新武装。

## 被否决的选项

- **模块级变量**：最直观的写法，也是错的——`/reload` 后状态归零。开发扩展时 `/reload` 是高频动作，这会让功能几乎不可用。
- **纯会话内存（Claude Code 的 `durable: false` 等价物）**：同样活不过 `/reload`；且需要引入 owner 会话概念才能回答「哪个会话负责触发」。
- **`pi.appendEntry` 写进 session 文件**：会随 session 文件活过进程退出，与「进程级」的意图相反。
- **独立 JSON 文件（Claude Code 的 `durable: true` 等价物）**：同上，且会牵出 owner 锁、孤儿 cron job、跨会话归属一整串复杂度。

## 后果

- 同一进程内 `/new` 出的新会话会继承并继续触发旧 cron job。这是「进程级」的固有代价，不是缺陷。
- 跨进程重启（含 `pi --resume`）cron job 消失，无需任何清理代码——`globalThis` 随进程消亡。
- cron job 的「进程级」措辞必须在用户与 agent 两个触点上保持一致：工具返回文本里写明 `Cron jobs are process-scoped and are cleared when pi exits.`
