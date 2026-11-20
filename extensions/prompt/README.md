# prompt —— 模型可见文案的唯一来源

## 这份目录管什么

「模型可见文案」指一切会进入模型上下文的文字：

- 工具 `description`、每个参数的 `description`
- `promptSnippet`（系统提示词里的工具索引行）、`promptGuidelines`（系统提示词的 Guidelines 段）
- 工具返回正文
- 扩展投递的自定义消息正文（例如 pi-bg 的任务完成消息）

**不在此列**：`/` 命令的输出、TUI 组件里的装饰文字（箭头、框线、颜色标签）、渲染器里的样式。它们只给人看。

**一律英文。** 仓库文档、命令输出、代码注释用中文；凡模型会读到的，用英文，避免模型在两种语言之间切换。

## 放在哪

按扩展一文件，放在 `extensions/prompt/`，文件名与扩展同名：

```
extensions/prompt/pi-bg.ts
extensions/prompt/pi-cron.ts
extensions/prompt/pi-herdr-agent.ts
```

每个文件导出**一个**对象，四段固定顺序：

```ts
export const piBgPrompt = {
  declarations: { … },  // 常驻·工具声明
  system:       { … },  // 常驻·系统提示词（snippet / guidelines）
  results:      { … },  // 每次调用·工具返回
  messages:     { … },  // 每次投递·自定义消息正文
};
```

扩展代码只从这里取文案，不在扩展里内联任何模型可见字符串。

## 怎么写

- **每条都注明呈现场景**，行注释用四种之一：`常驻·工具声明`、`常驻·系统提示词`、`每次调用`、`每次投递`。
- **静态文案是常量，带变量的才是函数**。函数名说清用途（`promotedBash`、`waitTimedOut`），参数只收原始值（id、已格式化的状态文本、耗时、计数）。
- **本目录不允许 import 任何扩展代码**，保持纯字符串，方便单测与逐条检视。
- 数值格式（`3.2s` / `1m03s` / `exit 0`）由扩展算好再传进来，本目录不做单位换算。
- 错误文案只写**前缀之后的部分**（`no background job with id 'x'.`），`Error: ` 由扩展用 `ERROR_PREFIX` 拼上。

## 选哪个载体

| 信息 | 载体 |
|---|---|
| 工具是什么、参数是什么 | `description` + 参数 `description` |
| 「有这个工具」这句索引 | `promptSnippet` |
| 跨调用的行为规则（如「长命令用后台工具」） | `promptGuidelines` |
| 只在这次调用才需要的结果 | 工具返回 |

- **一条规则只写一处**。参数语义写在参数 `description` 里，`description` 不再复述；动作枚举写在 `action` 的枚举描述里，`description` 不再列举。
- **`promptGuidelines` 只对声明给模型的工具生效**：`prepareLoadout` 隐藏工具即消失，不需要额外条件判断。
- **覆盖同名内置工具时**，`promptGuidelines` / `promptSnippet` / `description` / `outputSchema` 必须继承内置那份，否则等于静默删掉 pi 自己的规则（例如 bash 的 `You can inspect PI_* environment variables…`）。
- 判断依据是**调用频次**：低频工具的规则放返回文本（每次调用付一次）；高频工具的规则放 `promptGuidelines`（每请求付一次，但不重复长文）。

## 文案规范

1. **大小写**：工具返回以实体名小写开头（`bg_job <id>`、`bash`、`codemode`、`agent_job`），其后句子正常大写。没有以普通单词开头的工具返回。
2. **标点**：句子之间只用 `.`，不用 `;` 和 `—`；`,` 只用于同句补充，`:` 只用于列举。
3. **`·` 与 `—` 只出现在表格型文本里**（列表行、完成消息头行、`show` 的字段块），散文里不用。
4. **重点在第一句**，细节在后。
5. **前缀之后仍按第 1 条**：`Error: ` 后面同样小写实体开头。
6. **单行 UI 不加句末句号**。
7. **不写「下一步怎么做」的样板句**（`use agent_job list …` 这类）。规则进 `promptGuidelines` 或工具描述，返回值只陈述事实。

## 检查清单

新增或修改模型可见文案时：

- [ ] 在 `extensions/prompt/<扩展>.ts` 里改，不在扩展代码里内联
- [ ] 有呈现场景注释
- [ ] 英文，且符合上面 7 条
- [ ] 这条信息是否已在 `promptGuidelines` 或参数描述里存在（避免重复常驻）
- [ ] `tests/` 里断言文案的用例已同步
