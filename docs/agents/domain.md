# 领域文档

各工程技能在探索本仓库代码时应如何消费领域文档。

## 探索之前，先读这些

- 仓库根的 **`CONTEXT.md`**，或
- 仓库根的 **`CONTEXT-MAP.md`**（若存在）：它指向每个上下文各自的 `CONTEXT.md`，读取与当前主题相关的每一份。
- **`docs/adr/`**：读取涉及你即将改动的区域的 ADR。在多上下文仓库中，还要检查 `src/<context>/docs/adr/` 里的上下文级决策。

如果这些文件不存在，**静默跳过**。不要指出它们缺失，也不要在开工前建议创建。`/domain-modeling` 技能（经 `/grill-with-docs` 与 `/improve-codebase-architecture` 触达）会在术语或决策真正定下来时惰性创建它们。

## 文件结构

单上下文仓库（大多数仓库）：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

多上下文仓库（根目录存在 `CONTEXT-MAP.md`）：

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← 全系统决策
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← 上下文专属决策
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

本仓库为**单上下文**：使用仓库根的 `CONTEXT.md` 与 `docs/adr/`。

## 使用词汇表中的术语

当你的产出要命名某个领域概念时（issue 标题、重构提案、假设、测试名），使用 `CONTEXT.md` 中定义的那个术语。不要漂移到词汇表明确避免的同义词。

如果你需要的概念还不在词汇表中，这本身是个信号：要么你在发明项目并不使用的说法（重新考虑），要么确实存在缺口（记下来交给 `/domain-modeling`）。

## 标记 ADR 冲突

如果你的产出与既有 ADR 相矛盾，要显式指出，而不是静默覆盖：

> _与 ADR-0007（事件溯源订单）冲突，但值得重开，因为……_
