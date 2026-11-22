# herdr app 的 tab 名用短标题模型自动生成

herdr app 的 tab 没名字时按序号显示（1、2、…），一个 space 里开几个 pi 就只有一排数字；旧 herdr 的未命名标签显示终端标题 `π - <会话名> - <cwd>`，herdr app 不会。因此没有 `/name` 的新会话在窗口里毫无辨识度。决策：herdr app 下给新建会话的 tab 自动起名——把第一条人类消息交给短标题模型，生成一句 2-4 词的标题写进 tab 名，并按显示宽度硬截到 20 列，一个会话只试一次。

## 决策

- **只管 herdr app**（`HC_TERMINAL_ID`）。旧 herdr 的未命名标签已经有终端标题（含 cwd），再覆盖会丢信息。
- **触发点唯一**：`input` 事件里第一个「人类消息」——`source !== "extension"`（pi-cron、herdr-agent peer 走 `sendUserMessage`）、非纯空白、不以 `/` 开头（`/skill:…`、prompt 模板在展开前就到这里），且会话还没有会话名。满足后立即消耗掉唯一一次机会，无论成败。
- **只认新建会话**：判据是会话里还没有真人消息（`session_start` 时查 `getEntries()`），且启动原因不是 `fork`。不能只看 `session_start` 的 `reason`：`pi -c` 在扩展加载之前就把旧会话打开了，它发出的事件也是 `startup`。所以 `resume` / `fork` / `reload` 出来的有历史的会话一律不回溯命名，tab 保持原样。
- **子 agent 不参与**：进程内子 agent（pi-subagents）的 `ctx.mode` 不是 `tui`，已经在所有 handler 里被过滤；herdr-agent 拉起的子 agent 是独立进程、`ctx.mode` 也是 `tui`，靠注入的 `PI_AGENT_ID` 认出来（根 agent 没有这个变量）。它们的 tab 名由拉起方的 `--name` 决定，自动命名只会跟它抢名字。
- **名字来源是模型**：`ctx.modelRegistry.complete` + `extensions/prompt/pi-title.ts` 里的系统提示词（2-4 词、sentence case、中文 ≤ 10 字 / 英文 ≤ 20 字符、JSON `{"title"}`，口径照 Claude Code 的 `generateSessionTitle`）。模型默认用 `ctx.model`，可用 `pi-title.autoNameModel`（`provider/id`）指定便宜模型，解析失败回落会话模型。
- **长度硬截到 20 列**（中文 1 字 = 2 列）：herdr app 的 tab 条给标签 `max_w(170)`、侧边栏 agents 行给名字 `max_w(200)`（带 `·` 细节时 120），超出就是省略号，等于把人要看的字藏起来。实测模型不守「短」这个约束，所以提示词之外再按显示宽度截一次：中文 10 字 ≈ 130px，英文 20 字符 ≈ 128px，两边都落在 170px 的预算里。按空格与中英文标点回退，不切半个词，截完去尾部标点；找不到合适的断点（或断点丢掉一半以上）就硬切。
- **不传推理选项**：pi-ai 的 Anthropic 适配器在 `thinkingEnabled` 未设置时根本不在请求里带 thinking，等同 Claude Code `queryHaiku` 的 `thinkingConfig: { type: "disabled" }`；OpenAI 兼容适配器用 provider 默认。`ThinkingLevel` 里没有 `off`，所以不走 `streamSimple({ reasoning })`。
- **重试**：同一次触发内最多 3 次，第 2、3 次前分别退避 1s / 3s；抛错、空标题都算失败；全败就放弃，这个会话不再尝试。每次尝试前和拿到标题后都重查会话名——生成期间被 `/name` 抢先就丢弃结果。
- **优先级**：会话名（`/name`、`--name`）> 自动标签名 > 序号。会话名被清空时直接清空标签回序号，不回落到内存里的自动标题，也等于放弃这次机会。注意 TUI 的 `/name ""` 不算清空——pi 的 `handleNameCommand` 只在参数非空时设置名字，`""` 会被当成字面名字存下；真正的清空来自 RPC `set_session_name` 传空串或扩展调 `pi.setSessionName("")`。
- **只是显示**：不调 `pi.setSessionName`、不写会话文件、不进 `/resume` 列表；更名失败（窗口没开）静默放弃，不重试。
- **配置**：`settings.json` 的 `pi-title` 段，`autoName`（默认 `true`）、`autoNameModel`（可选）。不加 `/` 命令。

## 被否决的选项

- **截断首条消息原文当名字**：零成本、不加模型调用，但长 prompt 会变成半句话，herdr 的 tab 条直接挤爆；而且中文首条消息截出来多半不成词。Claude Code 也是交给模型。
- **cwd 目录名**：herdr app 的 space 名本来就取自 folder/repo，同一 space 的 tab 通常同目录，名字全重复，区分不了。
- **resume 时用会话里的首条消息补生成**：pi 能拿到历史消息（Claude Code 的 REPL 拿不到，所以它干脆不命名），但用户要的是「只有新建会话才命名」；否则每次 resume 都要多一次调用，模型输出还可能每次略有不同，tab 名跟着抖。
- **失败摊到后续人类消息重试**（Claude Code 的做法：失败重置一次性标记，下一轮再试）：用户选择同一次触发内连试三次，状态机因此保持一次性，没有「这个会话到底还会不会被改名」的悬念。
- **用 `pi.setSessionName` 写回会话名**：会连带改 `/resume` 列表、终端标题和 OSC 7501 状态消息，超出 tab 显示的范围，也污染 `/name` 的语义（人以为是自己命名过的会话）。
- **给 tab 名加 `⠂`/`⠐` 动画前缀**（Claude Code 的终端标题做法）：herdr app 改一次名要 spawn `herdr-app ls` + `do tab.rename` 两个进程，960ms 一次跑满整个 turn 不可接受；tab 名是给人扫读的，抖起来更糟。
- **检测「人手动改过 tab 名」后跳过**：`herdr-app ls` 不返回 `named` 标记，只能靠「名字不是纯数字」猜；`/new` 之后上一会话的自动名不是数字，会被误判成人命名而永远不覆盖。代价（偶尔盖掉一次手动改名）比这个 bug 小，且人可以用 `/name` 固定名字。
- **只靠 prompt 约束长度，不在代码里截**（Claude Code 的做法：它不校验、不截断）：Claude Code 的标题只进终端标题栏，而 herdr app 的 tab 条与侧边栏都是定宽格子，超了直接省成省略号；初版 prompt 写「3-7 词」实测出了 20+ 字符的标题，字段被截得只剩前半句。

## 后果

- 每个新建会话的第一条消息会多一次小模型调用（几十 token）。它不进 footer 的 token 统计，也不写 `token-stats` 的 SQLite——那里记的是 agent 自己那几轮响应的用量。
- tab 名和 `/resume` 列表可能不一致：tab 是模型标题，列表里无名会话显示首条消息。要统一就 `/name`。
- 窗口没开时更名静默失败，tab 停在序号；下次 resume 也不会补（resume 不命名）。
- 首条消息是中文时模型多半给中文标题，英文消息给英文标题——跟人的语言走，是期望行为。
- 提醒 ADR-0005 的一处措辞：「herdr 在标签没有名字时显示终端标题」只对旧 herdr 成立，herdr app 实测按序号显示。所以本决策不是修显示回落，而是新增信息。
- 「新会话」的判据踩过一次坑：`pi -c` 的 `session_start` reason 是 `startup` 而不是 `resume`（会话在扩展加载前就打开了），只看 reason 会把 resume 出来的会话重新命名。
- 依赖 `ctx.model` 或 `autoNameModel` 所在 provider 已配置认证；都没配时每次尝试都会抛错，三次后放弃，tab 停在序号（静默）。
