# herdr app 的标签更名走 app CLI，ls 寻址不读 core 标签

`/name` 更名会话时，pi-title 会同步重命名 pi 所在的终端标签。旧 herdr 在 env 里直接给出标签 id（`HERDR_TAB_ID`），一条 `herdr tab rename` 即可；herdr app 不注入任何标签 id——它的窗口把归属关系（space > tab > terminal）维护在 app 侧，env 里只有终端地址 `HC_TERMINAL_ID`。要在 herdr app 下支持 `/name` 同步更名，得回答「怎么把终端地址变成标签 id」。

## 决策

每次更名两步走，全部经 herdr-app CLI：

1. `herdr-app ls`：窗口返回 spaces > tabs > terminals 的 JSON，从中找出装着 `$HC_TERMINAL_ID` 的 tab id；
2. `herdr-app do tab.rename --id <tab> --name <label>`：改名；空名恢复按序号命名。

每次都重新 ls，不缓存 tab id——用户可以把终端挪去别的 tab，缓存会悄悄改错对象；更名是低频操作，多一次 ls 无妨。窗口未开、终端不在窗口的标签清单里或输出不合法时找不到 tab，rename 抛错，由 pi-title 按既有约定静默放弃：更名是锦上添花，不能变成噪音源。

## 被否决的选项

- **读 core 侧的 `herdr.tab` 标签（`hc get` → labels）**：herdr app 确实把 tab id 写在终端标签里，但这是 app 的私有布局状态（herdr-core 文档明言 label「never interpreted」），依赖它等于耦合 app 内部约定；而 `herdr-app ls` 是 app 给 agent 的公开接口（`herdr-app --skill` 手册明确「改变人看到的东西用 app 命令」）。且这条路要先 `hc get` 再 `tab.rename`，比一条 `ls` 多拉一个进程。
- **改写窗口标题（OSC 序列）让 app 显示会话名**：herdr app 的 tab 名与终端 title 是两个独立字段（当前 tab 名是「1」，title 是「π - …」，title 变更不会成为 tab 名）；而且 pi-title 在 herdr 环境刻意不动窗口标题（动画会让 tab 名抖动），走 title 等于绕开自己刚立的规矩。
- **直连 herdr-core 的 JSON-RPC（命名管道）/ 自拼协议**：herdr-core 的 RPC 走 `HC_TERMINAL_SOCKET` 管道且能查到标签，但扩展为改个名字维护一套 socket 协议客户端超出应承担的复杂度；CLI 已足够，且与 pi-btw 的 launcher 共用同一入口形态。

## 后果

- herdr app 下更名依赖窗口在跑：窗口没开会静默失败（旧 herdr 的 CLI 失败同样静默），`/name` 的会话名照常设置，只是 tab 不跟。
- `herdr-app` 从 PATH 解析（app 安装目录在 PATH 上，Windows 下 spawn 可解析，已实测）；不像旧 herdr 有 `HERDR_BIN_PATH` 注入，app 侧暂无覆盖入口，真遇到非标准安装再加。
- 与 pi-btw 的 `createTabLauncher` 同居 `lib/herdr.ts`：两代 herdr 的能力差异（谁注入什么 env、CLI 怎么调）集中在这一处；但更名优先认 `HERDR_TAB_ID`（launcher 是 app 优先）——直接寻址优先于需要查询的寻址。
- 依赖 herdr-app 提供 `tab.rename` 与 `ls` 的版本；上游若改命令形状，pi-title 在 herdr app 下静默失效，可用 `herdr-app do tab.rename --id <tab> --name x` 手工验证。
