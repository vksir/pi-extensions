# TUI 展示的落位规范

## 管什么

模型看不见、只出现在终端界面上的东西：消息卡片、工具调用行、entry 渲染器、自定义 `Component`、主题色与宽度处理。模型可见的文案不在这里，见 `extensions/prompt/README.md`。

## 放哪里

统一放 `extensions/lib/tui/`，**一个界面位置一个文件**：

| 文件 | 展示位置 |
|---|---|
| `lib/tui/agent-message.ts` | transcript 里的自定义消息卡片（`pi.sendMessage` + `registerMessageRenderer`） |
| `lib/tui/agent-job.ts` | `agent_job` 的工具调用行（`renderCall`） |
| `lib/tui/agent-tree.ts` | `/agent list` 的树卡片（`pi.appendEntry` + `registerEntryRenderer`） |
| `lib/tui/note.ts` | transcript 里的单行备注（entry 渲染器） |

扩展文件（`extensions/pi-*.ts`）只做三件事：**注册渲染器、收集数据、把数据交给 tui 模块**。扩展文件里不应该出现 `new Box(`、`new Text(`、`truncateToWidth(`、`visibleWidth(`；出现了就说明该搬进 `lib/tui/`。

## 颜色

- 只用主题 token：`theme.fg("muted", …)`、`theme.bg("customMessageBg", …)`。可用的 token 见 pi 的 `THEME_TOKENS`（`accent` / `success` / `warning` / `error` / `muted` / `dim` / `toolTitle` / `customMessageLabel` / `customMessageBg` …）。
- 不写死 ANSI、RGB 或 256 色；换主题要能跟着变。
- 类型色约定：`task` → `accent`，`reply` → `success`，`notice` → `warning`。

## 折叠与展开

- 用 pi 给的开关，不要自己造：消息/entry 用 `options.expanded`，工具行用 `context.expanded`。
- 展开提示用 `context.keyHint("app.tools.expand", "to expand")`，跟随用户的键位设置，不写死 `ctrl+o` 文案（消息卡片这类没有 context 的地方才写字面量）。
- 折叠行数、单行字符数写在模块常量里（如 `COLLAPSED_LINES = 4`、`ARG_PREVIEW_CHARS = 100`），渲染函数只读常量。

## 宽度

- 只认显示宽度：`visibleWidth()` / `truncateToWidth()`，不要用 `String.length`。
- 每行必须 ≤ 传入的 `width`；窄终端（40 列）下不允许溢出。

## 注释要求

每个 tui 文件的**文件头注释**必须写清三件事：

1. **展示位置**：哪个界面位置（transcript 消息卡片 / tool call 行 / entry 卡片 / overlay …），由哪个 API 挂上去。
2. **效果示例**：ASCII 草图，至少给折叠态；有展开态或窄终端行为就补一句。
3. **颜色与交互**：用了哪些 token、怎么展开、有没有截断。

示例：

```ts
/**
 * agent 消息卡片 —— transcript 里的自定义消息（`pi.sendMessage` + `registerMessageRenderer`）。
 *
 * 展示位置：对话流里一张独立的卡片，和工具结果同级；不是用户输入行。
 * 效果（折叠）：
 *
 *   agent_message  ← reviewer (a7k2) · reply
 *   line01
 *   line02
 *   line03
 *   line04
 *   … 6 more lines · ctrl+o
 *
 * 展开（ctrl+o）后显示全文；头行加粗、customMessageLabel 紫色，整块铺 customMessageBg。
 */
```

## 检查清单

- 扩展文件里是否还有 `new Box(` / `new Text(` / `truncateToWidth(`？有就搬进 `lib/tui/`。
- 文件头有没有「展示位置 + 效果示例」？
- 颜色是否全部来自主题 token？
- 折叠/展开是否走 pi 的 `expanded`？
- 渲染器里有没有 `await`、I/O 或状态突变？（`render()` 必须同步、无副作用）
- 40 列终端下会不会溢出？

## 不在这个范围

- 模型可见文案（系统提示词、工具描述、工具返回、消息正文）：`extensions/prompt/`。
- 数据整形（把终端列表拼成树行、把 agent 行拼成表格文本）：留在扩展里，`lib/tui/` 只接已拼好的数据。
