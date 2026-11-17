# 通过 hc API 驱动终端里的 pi

## 什么时候看这份

E2E 验证要在一台真实 herdr 终端里跑 pi：给它发消息、发 `/` 命令、读屏、按键、收尾。CLI 能做大部分，**但斜杠命令只能走 API**。

## 两种发送方式的区别

| 方式 | 写法 | 加 `<hc from=…>` 包络 | 能发 `/` 命令 |
|---|---|---|---|
| CLI | `hc send <t> <text>` | 会（notes 功能） | 不能，被当成普通消息 |
| API | `hc connect` + `terminal.send` | 不会 | 能 |

包络是从 CLI 这一层加的，`terminal.send` 本身只是「粘贴文本 + 回车」。

## 怎么调

一行一个 JSON-RPC 请求，写到 `hc connect` 的 stdin：

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"terminal.send","params":{"terminal":"e2e","text":"/bg"}}' | hc connect --json
```

`hc schema` 打印完整的 OpenRPC 描述（方法、参数、返回、错误码），字段以它为准。

### 常用方法

| 方法 | 用途 | 主要参数 |
|---|---|---|
| `terminal.run` | 起一个终端 | `argv`、`cwd`、`name`、`parent`、`no_notify`、`wait`、`timeout` |
| `terminal.send` | 粘贴文本并回车 | `terminal`、`text`、`if: "idle" \| "working"`、`wait`、`timeout`、`force` |
| `terminal.keys` | 按键 | `terminal`、`keys: ["enter", "esc", "ctrl+c", "a"]` |
| `terminal.read` | 读屏 / 历史 | `terminal`、`lines` |
| `terminal.wait` | 等它停下来 | `terminal`、`timeout`、`children` |
| `terminal.list` / `get` / `kill` | 列举 / 详情 / 结束 | `terminal`（地址 `t7` 或名字）、`all` |

`terminal` 接受地址（`t7`）或名字；在终端里调用时可以省略，脚本里永远显式写。

### 返回里值得看的字段

- `terminal.send` → `{status, turn, started}`；带 `wait: true` 时还会带上 `wait.ended` / `wait.exit_code`。
- `terminal.read` → `{text, how, complete, why}`：`how` 是 `screen | history | stitched`；`why: "working"` 表示程序还在跑，只给了可见屏幕（没有历史）。
- `terminal.wait` → `ended: false` 是超时 check-in，**不是**失败；终端还在跑。

## 一份最小流程

```bash
# 1. 起终端：--approve 信任项目文件，--no-notify 不往父 agent 里打字
hc run --bg --name e2e --cwd <临时项目目录> --no-notify \
  pi --no-extensions -e builtin:codemode -e <本仓库>/extensions/pi-bg.ts --approve

# 2. 等它起来（能读到输入框即可）
sleep 8 && hc read e2e | tail -20

# 3. 发消息
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"terminal.send","params":{"terminal":"e2e","text":"Use the bash tool to run: sleep 20"}}' | hc connect --json

# 4. 发斜杠命令（只有 API 能发）
printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"terminal.send","params":{"terminal":"e2e","text":"/bg"}}' | hc connect --json

# 5. 读结果并收尾
hc read e2e | tail -20
hc kill e2e
```

## 坑

- **Git Bash 会改路径**：以 `/` 开头的参数被当成路径（`/bg` → `C:/Program Files/Git/bg`）。走 API 即可绕开；不得已用 CLI 时加 `MSYS_NO_PATHCONV=1`。
- **working 时读不到历史**：`hc read` 只给可见屏幕，`terminal.wait` 之后再读才有完整输出。
- **发送会等草稿**：`terminal.send` 会等人正在输入的内容（最多 60 秒）；脚本里传 `if: "idle"` 更稳。
- **别污染别人的上下文**：起终端带 `--no-notify`，否则 hc 会往父 agent 里打字。
- **收尾**：`hc kill <name>`，再用 `hc ls` 确认没有残留终端。
