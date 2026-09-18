# Triage 标签

各技能以五个标准 triage 角色来表述。本文件把这些角色映射到本仓库议题追踪器中实际使用的标签字符串。

| 技能中的角色 | 本仓库的标签 | 含义 |
| ------------ | ------------ | ---- |
| `needs-triage` | `needs-triage` | 维护者需要评估该 issue |
| `needs-info` | `needs-info` | 等待报告者补充信息 |
| `ready-for-agent` | `ready-for-agent` | 已完全指定，可交给 AFK agent |
| `ready-for-human` | `ready-for-human` | 需要人工实现 |
| `wontfix` | `wontfix` | 不会处理 |

当技能提到某个角色（例如「应用 AFK-ready 的 triage 标签」）时，使用上表对应的标签字符串。

如需改用别的命名，直接修改右列的取值即可。

本仓库使用本地 markdown 追踪器时，标签以每个 issue 文件顶部的 `Status:` 行表示，取值同上表中的标签字符串。
