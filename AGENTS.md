## 规范

### 测试规范

- 开发完成后，必须利用 herdr 对扩展进行充分 E2E 验证。

### 提交规范

- 测试完成后，必须检查代码没有不包含敏感信息、个性化信息，然后再提交并推送。

## Agent skills

### Issue tracker

issue、spec 与 triage 状态以 markdown 文件存放在 `.scratch/<feature>/` 下。详见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用默认的五个角色标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。详见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：仓库根的 `GLOSSARY.md` + `docs/adr/`。详见 `docs/agents/domain.md`。

## Prompt 文案

模型可见文案（工具 description、参数 description、promptSnippet、promptGuidelines、工具返回、投递消息正文）一律集中放在 `prompt/`，按扩展一文件，必须用英文。规则、载体选择与文案规范见 `prompt/README.md`。
