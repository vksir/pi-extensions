# 前台工具用等待预算，到点转后台

前台 `bash` / `codemode` 一旦跑起长命令，这一轮就被它卡住：模型没有并行能力，用户按 Esc 还会把命令连同进程一起杀掉。pi 没有任何「单工具中止」或「工具结果提前 resolve」的机制——`tool_call` 只能 `block` 或改 `input`，`tool_result` 只在执行结束后跑，`tool_execution_*` 是通知，工具拿到的 signal 是**整轮 run 那一个** AbortController。所以想让「还在跑的命令」把控制权交还模型、同时进程继续跑，只有一条路：让工具自己的 `execute` 提前返回。

我们据此决定：**用同名注册覆盖内置 `bash` / `codemode`，只换 `execute` 与 `renderResult`**，给前台调用一个**等待预算**（`pi-bg.promoteAfterSeconds`，默认 300 秒，`<= 0` 关闭）。到点仍未结束就把它转成后台任务（见 [GLOSSARY](../../GLOSSARY.md) 的「转后台」）：

- 传给内置实现的是**自己的** AbortController；模型显式给的 `timeout` 原样透传，到点仍然失败，但它不再阻止晋升——E2E 里模型会主动给 `bash` 加 `timeout`，一旦「有 timeout 就不晋升」，兜底就等于不存在。晋升前把父轮 Esc 转发下去（保持现状），晋升那一刻摘掉监听，此后父轮怎么结束都不连坐。
- 晋升后的任务进 `pi-bg` 的任务表，复用既有的 `bg_job`（list / show / kill / wait）与 steer 回传通道；并发上限只约束 `bash_bg` / `codemode_bg`，转后台的不占名额。
- 重建内置定义用 `createBashToolDefinition(cwd, { shellPath, shellCommandPrefix })`——与 pi core 取自同一对设置项；`codemode` 用 `createCodemodeExtension()` 的 shim 接住的那份定义（与 ADR-0006 同一手法）。

## 与 ADR-0006 的关系

ADR-0006 否决的是「给内置 `bash` 加 `background` 参数」，理由有两条：`outputSchema` 无法同时描述两种返回形状，以及抢占 `bash` 这个名字。本决定只改 `execute` 与预算，**不新增参数**，所以参数 schema 与 `outputSchema` 都还是内置那一份；而晋升只可能发生在**模型直接调用**那一层：嵌套调用（codemode 脚本里的 `tools.bash`、`bash_bg` 的 `ctx.executeTool` 委托）用 `tool_call` 事件的 `parentToolCallId` 与 id 形状（`<调用方 id>/<n>`）判定，一律直通、不计时。`structuredContent` 的唯一消费者是 codemode 脚本，而脚本永远走不到晋升分支，所以结构化契约不受影响。

「抢名字」的代价按用户自己的判断接受：装了别的接管 `bash` 的扩展时，谁后注册谁生效，不做运行时协商。

## 被否决的选项

- **硬超时 + 用 `bash_bg` 重跑**：只改 hook 就能做（`tool_call` 注入 `timeout`，`tool_result` 命中超时后引导重跑），但会丢掉最多一整个预算的进度，并重放副作用——`npm install`、构建、迁移都不幂等，这比卡住更糟。
- **在 `tool_call` 里自己执行再 `block`**：等于重写 bash（截断、临时文件、`PI_*` 环境、退出码全部自研），hook 里没有 `onUpdate`（预算期内 TUI 没有任何输出），blocked 结果还是 `isError`，脚本也拿不到 `structuredContent`。
- **只靠提示词**：把「长命令用 `bash_bg`」写进 `promptGuidelines` 依然要做（它是唯一能改默认选择的杠杆），但它拦不住误判，而误判正是这条兜底要处理的情况。
- **把 codemode 也排除在预算外**：`codemode` 的长耗时同样是脚本在等 `tools.bash`，而脚本没有「不 await 就继续」的能力（沙箱结束时未完成的调用会被取消）。两条长尾用同一个策略处理。

## 后果

- **重建同源风险**：我们读的是 `settings.shellPath` / `settings.shellCommandPrefix`，与 pi core 构造 bash 时同源。pi 以后给 bash 的构造加新东西（新设置、新 spawn hook）时，重建版本会悄悄落后，而覆盖之后落后的那一份就是真正的 `bash`。防线是 `tests/pi-bg.test.ts` 的金样断言：参数与 `outputSchema` 的字段名一变，测试立刻炸。运行期不做自检——它只能比出字段名差异，防不住真正的构造漂移，却会引入一个「功能静默消失」的状态。
- **TUI**：晋升那一行不复用内置渲染器（它会继续转计时器、显示「执行中」），改用晋升瞬间的 partial 结果 + 一行 `→ bg_job <id> in background`；partial 只留在内存里（上限 16 条），不进 transcript，避免同一份输出在会话里存两遍。
- **文案**：晋升后模型看到的是「哪个工具、还没结束、变成了哪个 job」。第一句必须是这个结论，否则模型会把「转后台」误读成「命令完成了」。
- **退场条件**：pi 若提供单工具 abort、或允许工具结果提前 resolve（例如 `ToolDefinition` 上加一个 abandon 预算），删掉覆盖版改用它。ADR-0006 的委托路径与 `bash_bg` / `codemode_bg` 不受这条退场影响。
