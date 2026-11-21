# 提示词改动的提交与审核

## 这份文档管什么

凡是改动**模型可见文案**（`extensions/prompt/` 里的任何字符串：工具描述、字段说明、索引行、守则、返回文本、消息正文），动手改代码之前，必须先按本文件出一版前后对比给人审。审过了再改。

规则来源见 `extensions/prompt/README.md`（放哪里、写什么）；本文件只管**怎么呈现给人审**。

---

## 一、呈现格式

### 1. 按工具分组

一个工具一张表，先讲完 `agent` 再讲 `agent_job`。不同工具的条目不要混进同一张表。

不属于任何工具的内容（扩展主动投递的消息、协议首行）单独放最后一节，标题写明「不属于工具」。

### 2. 两列表格

| 项目 | 现在 | 改成 |
|---|---|---|

第一列写**人话的项目名**，不写代码键名。例如：

- 写「工具描述」，不写 `declarations.agentJob.description`
- 写「字段 action」，不写 `parameters.action`
- 写「返回·启动成功」，不写 `results.startedAgent`
- 写「守则」，不写 `system.guidelines.agentJob`

代码键名可以在表外单独补一句，但不进表格。

### 3. 没改的也要列，改成列写 `—`

| 项目 | 现在 | 改成 |
|---|---|---|
| 字段 id | Agent id. Required for every action except list. | — |

「现在」列写全文，不许省略成「（不变）」——审核的人看不到原文就无法判断该不该改。

### 4. 只高亮真正改动的片段

整句重写才整句高亮；改一个词就只高亮那个词。

**对**

| 现在 | 改成 |
|---|---|
| Message for ask ~~and steer.~~ | Message for ask. |
| ~~Killed~~ agent 7f3a. | `Stopped` agent 7f3a. |

**错**（把没变的词也高亮了）

| 现在 | 改成 |
|---|---|
| Asked 7f3a (reviewer). ~~Its answer will arrive as a message when the turn ends.~~ | `Asked 7f3a (reviewer).` |

### 5. 高亮的写法

| 含义 | 写法 | 效果 |
|---|---|---|
| 删除 | `~~文本~~` | 中划线 |
| 新增 | `` `文本` `` | 行内代码色（紫） |

**`**` 加粗在终端里看不出来，不要用。**

**`~~` 和 `` ` `` 的内侧不能有空格。** pi 的 Markdown 解析器用的是严格模式正则：

```
/^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/
```

开合标记内侧必须是**非空白、非 `~`** 的字符。写错就原样显示 `~~`，等于没高亮。

**对**

```
It runs a separate pi session ~~and sends its final answer back as a message.~~
```

**错**（`~~` 后面直接跟空格）

```
It runs a separate pi session~~ and sends its final answer back as a message.~~
```

要删的片段以空格开头时，把那个空格留在 `~~` 外面；句子结尾有句号时，把句号包进 `~~` 里，避免留下「ask .」这种悬挂空格。

### 6. 整条删除单独列一张表

| 删掉 | 原文 |
|---|---|
| `ask` 后对方还没开工 | ~~It has not started working yet.~~ |

### 7. 表格外面不要重复贴正文

表格已经说清楚了。最多在表后补一句「为什么这么改」，不要把改后的整段文案再抄一遍。

---

## 二、内容审查清单

改之前先自查这五条，不通过的不要拿去审。

### 1. 一条规则只写一处

同一个事实在工具描述、字段说明、守则、返回文本里只留一处。

例：「答案会以消息回来」这件事，写在工具描述里，返回文本就只写 `Asked 7f3a (reviewer).`。

### 2. 不自造术语

用模型已经知道的中文/英文词。不要引入「派活人」「轮次」这类只有我们懂的词进模型可见文案。

### 3. 不解释模型看不见的东西

模型看不到别的 agent，就不需要告诉它「你只能看到父、子、兄弟」。看不见就是看不见，写出来反而占上下文。

只写它会**撞上**的约束，比如「只能停自己的子树」——这个撞上会报错。

### 4. 描述与字段的分工

- **动作的语义写在工具描述里**，`action` 这类枚举字段只列可选值。
- 其余参数的语义写在参数字段里，工具描述不复述。

> 这条与 `extensions/prompt/README.md` 里旧的「动作枚举写在 action 的枚举描述里」相反，以本文件为准。

### 5. 常驻体积要给前后对比

工具描述与字段说明每次请求都会发出去。呈现改动时附一行字数对比：

| 项 | 前 | 后 |
|---|---:|---:|
| `agentJob` 描述 + 字段 | 472 | 409 |

涨了要说明为什么值得。

---

## 三、一次完整的呈现

```
# 一、agent 工具

| 项目 | 现在 | 改成 |
|---|---|---|
| 工具描述 | Start a sub-agent in its own terminal. It runs a separate pi session ~~and sends its final answer back as a message.~~ | Start a sub-agent in its own terminal. It runs a separate pi session`; the answer comes back as a message when it finishes`. |
| 字段 prompt | The task for the sub-agent. | — |
| 索引行 | Start a sub-agent that reports back by message | — |
| 返回·启动成功 | Started agent 7f3a as 'reviewer'. ~~Its final answer will arrive as a message.~~ | Started agent 7f3a as 'reviewer'. |

# 二、agent_job 工具

| 项目 | 现在 | 改成 |
|---|---|---|
| 字段 message | Message for ask ~~and steer.~~ | Message for ask. |
| 索引行 | ~~List, kill, ask, or steer sub-agents~~ | `List, message, or stop sub-agents` |
```

---

## 四、常见错误

| 错误 | 后果 |
|---|---|
| 把 `declarations.x.y` 写进表格第一列 | 审核的人不知道那是什么 |
| 只列改动项，不列未改动项 | 看不出改动在整体里的位置 |
| 未改动项的「改成」列留空 | 分不清「没改」和「漏填」 |
| 用 `**` 高亮 | 终端里看不见 |
| `~~` 内侧带空格 | 原样显示 `~~`，等于没标 |
| 把没变的词一起高亮 | 看不出真正的改动 |
| 表格外再贴一遍改后的全文 | 重复，且容易和表格对不上 |
