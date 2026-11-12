# 后台工具委托内置工具，而不是重写执行

pi-bg 需要「和 `bash` / `codemode` 功能基本相同，只是后台运行」的两个工具。我们决定**不重新实现执行**，而是让后台工具在后台调用 `ctx.executeTool("bash" | "codemode", ...)`：`bash-bg` / `codemode-bg` 只是外壳，负责任务表、并发上限、id、终止与结果回传；命令执行、尾部 2000 行 / 50KB 截断与全文临时文件、退出码与 `structuredContent`、`tool_call` hook 与权限检查、codemode 沙箱与 `tools.*` 语义，全部来自内置实现。

「功能基本相同」这个需求只有在委托下才有可验证的含义。自研一份执行并声称「基本相同」，是把无法自动发现的分歧（截断方向、超时错误文案、`structuredContent` 字段、hook 是否生效）留给未来某次 quietly 走样。

## 被否决的选项

- **给内置 `bash` 加 `background: true` 参数**（覆盖同名工具）：单从「跟随 pi 的改动」看，这条并没有想象中糟——`session_start` 里能从 `getAllTools()` 取到内置 bash 的 `parameters` 直接扩展，`execute` 也能用包根导出的 `createBashToolDefinition()` 重建，两者都随 pi 自动跟。真正否掉它的是两件无法靠动态取值绕开的事：
  - **`outputSchema` 无法同时描述两个分支**。`bash` 声明 `outputSchema: bashOutputSchema`（`output` / `truncated` / `exit_code` / `wall_time_seconds`），codemode 脚本靠它拿 `structuredContent`。`background: true` 返回的是「任务 id + 已启动」，形状完全不同，而 `outputSchema` 只有单个 schema。只能放宽校验、伪造字段、或整个去掉——最后一种会回退 codemode 脚本对 bash 的结构化契约。两个工具名各自持有一份 `outputSchema` 就没有这个问题。
  - **抢占 `bash` 这个名字**：扩展覆盖内置工具是 last-wins 且不报警，`bash` 被占用后与其他覆盖 bash 的扩展（如 gondolin）互斥。委托不占名字，是正交的。

  附带的两个次级代价：`ToolInfo` 不含 `execute`，schema 能取、执行不能取，若已有别的扩展先覆盖了 bash，拿到的 schema 与重建的 execute 会不同源；覆盖后 `ctx.executeTool("bash")` 会递归回自己，前台分支只能走 `createBashToolDefinition()`，这条禁令容易在重构时被踩。
- **后台直接调 `createLocalBashOperations().exec()`**：这条路径干净、无 UI 耦合，但要自己重写截断与结构化输出（约百行），并且绕过 `tool_call` hook——后台命令就成了权限检查的缺口。
- **自己 import `@earendil-works/pi-codemode` 组一个后台沙箱**：pi 根导出不含沙箱，只导出 `createCodemodeExtension`；自组要重写 `tools.*` 适配、`ALL_TOOLS` / `searchTools` / `describeTool`、`models.*` 与 store 落 session 的全部装配，等于重写 codemode 工具层。

## 后果

- 后台调用走的是 agent loop 的嵌套工具管线，`tool_call` / `tool_result` hook 里取到的 assistant message 是**投递那一刻**的最后一条 assistant 消息，不是发起后台任务的原始一轮；嵌套调用的记录（`nestedCalls`）与用量也挂不到已经返回的那条 tool result 上，等于丢失。两者都不影响执行正确性。
- 嵌套调用的 `tool_execution_*` 事件带 `parentToolCallId`，会出现在一个已经结束的 tool call 之下；TUI 把它当作子调用渲染，不做特殊处理。
- 父轮 Esc 的 abort 不能连坐后台任务，所以后台任务用自己的 `AbortController`，`bg kill` 与 `session_shutdown` 都通过 abort 触发内置实现的 `killProcessTree`。这个决定同时覆盖了 codemode 的沙箱中止。
- 存续域是**会话**，不是进程：`session_shutdown` 的五个 reason（`/new`、`/reload`、`/resume`、`/fork`、退出）一律中止在跑任务，`/new` 与 `/reload` 还会重建扩展实例。唯一不伴随 shutdown 的 `session_start` 来自 `rebindCurrentSession`（同一会话内重绑定），那里保留在跑任务才是对的。
- 三个工具都在首次 `session_start` 注册，因为内置工具的启用状态与 schema 在那里才能读到（factory 阶段 `getActiveTools` / `getAllTools` 都是 `notInitialized`）。注册顺序写死、内容确定，因此一局会话内的系统提示词、工具列表与顺序不变，不破坏前缀缓存。
- 后台结果作为 `pi-bg` 自定义消息回传，不回填 tool result：tool result 是「启动成功」的凭证，输出是另一件事，模型因此永远不会把「尚未产生的输出」误读为「产生了空输出」。

- Windows + Git Bash 上，`killProcessTree` 的 `taskkill /F /T <pid>` 达不到 MSYS 子里程（它们在 Windows 里记录的父进程不是 bash），中止后可能留下孤儿进程。这与对前台 `bash` 调用按 Esc 完全同一行为——委托带来的正是「与内置一致的缺陷」，而不是额外新增的缺陷；`bg kill` 的语义因此被收窄为「本会话不再回传、内置工具已收到 abort」。
- `codemode` 的暴露是 `model-only`，`ctx.executeTool` 只认 `direct` / `codemode` / `deferred`，所以 `codemode-bg` 走不了 `bash-bg` 那条委托路。pi 又不导出沙箱，只导出 `createCodemodeExtension`。折中是：用一个吞掉 `registerTool` 的 shim 调一次 `createCodemodeExtension()`，把真正注册的那份工具定义接在手里，后台直接调它的 `execute`——仍是「用内置实现」，只是不经过工具注册表。
