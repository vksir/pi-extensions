## 规范

### 项目规范

- 模型可见文案（如系统提示词、工具描述、工具返回等）一律集中放在 `extensions/prompt/`，按扩展区分文件，必须用英文。
- 载体选择、文案规范与检查清单见 `extensions/prompt/README.md`。
- 改动提示词时，动手前必须按 `docs/prompt-review.md` 的格式出一版前后对比表，审过再改。

### 测试规范

- 开发完成后，必须利用 herdr-app + hc 对扩展进行充分 E2E 验证。
- `/` 命令只能通过 hc API 发送；起终端、发消息、发命令、读屏、收尾的写法见 `docs/e2e/hc-api.md`。

### 提交规范

- 测试完成后，必须检查代码不包含敏感信息、个性化信息，然后再提交并推送。

## Agent skills

### Issue tracker

issue、spec 与 triage 状态以 markdown 文件存放在 `.scratch/<feature>/` 下。详见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用默认的五个角色标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。详见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：仓库根的 `GLOSSARY.md` + `docs/adr/`。详见 `docs/agents/domain.md`。
