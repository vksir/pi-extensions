# 隐藏 skill 在运行时置位，不 fork skill 文件

通过 pi packages 安装的 skill（如 herdr）借助包机制更新；其中一部分只该服务人工调用，不应进入系统提示词。pi 的原生手段是 SKILL.md frontmatter 写 `disable-model-invocation: true`，但对包安装的 skill 用它就得 fork 文件——fork 一次，就失去包更新。我们需要「加载之后、run 之前」追加这层语义的入口。

## 决策

pi-skill-visibility 在 `before_agent_start` 钩子里对 `event.systemPromptOptions.skills` 中命中配置的 skill **原地置位 `disableModelInvocation = true`**。这条路径与 pi 原生行为同源：

- 系统提示词每次 run 都由该数组经 `formatSkillsForPrompt` 构建，而该函数过滤 `disableModelInvocation === true` 的 skill——置位后效果与 frontmatter 写法逐字节一致。
- `/skill:<名称>` 命令的展开读的是 resourceLoader 的完整 skill 列表，不经过这条路径，所以显式调用不受影响——这正是 `disable-model-invocation` 的语义边界。

配置放 settings.json 的 `pi-skill-visibility.hidden`（`pi.getSettings()` 返回全局与项目合并后的结果），skill 名称匹配大小写不敏感。

## 被否决的选项

- **fork skill 文件加 frontmatter**：立即生效，但从此与上游更新分叉；每次包更新都要重新合入一行 frontmatter，维护成本随包数量线性增长。
- **包资源过滤（settings 中该包条目写 `"skills": []`）**：粒度是「这个包的 skill 一个都不加载」，连 `/skill:<名称>` 也没了。我们要的是「模型看不见、人还能调」，过滤做不到这个粒度。
- **`context_with_system` 改写系统提示词文本**：要在请求层重新解析并剔除 `<skills>` XML 分段，形状随 provider 而异，且系统消息分段由 pi 管理改写属越权。
- **等上游加配置项**：需求明确且实现是一条钩子十行代码，不必等。

## 后果

- 隐藏发生在 run 边界：会话第一条系统消息在第一次 run 时构建，彼时钩子已跑过，所以从会话起点就是隐藏后的形态，没有泄漏窗口。
- 修改配置需 `/reload` 重读 settings 后生效；`before_agent_start` 每次 run 都触发，会话中途不会有半生效状态。
- 扩展依赖「skills 经 `before_agent_start` 的 `systemPromptOptions` 构建系统提示词」这条内部路径。若上游改变构建方式，扩展会静默失效——可用 pi-context 的 `/context` 快照验证 skills 分段是否仍包含被隐藏的 skill。
- 与包资源过滤的分工：过滤管「要不要装」，本扩展管「装了要不要给模型看」。
