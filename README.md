# dsh-lite-memory

**没有常驻的记忆正文：不写系统提示，不逐轮注入，命中才读。**
**No memory in the prompt: nothing injected per turn, read only on a hit.**

---

## 它是什么 / What it is

给 DeepSeek Harness 的轻量记忆：不写常驻系统提示、不逐轮注入、不扫描文件。记忆只在两种时刻出现——你说「记一下」，或者这句话跟已有条目真有关（最多三条标题，正文仍按需读）。

Lightweight memory for the DeepSeek Harness. No standing system prompt, nothing injected per turn, no file scanning. Memory appears at exactly two moments: you ask it to remember, or the message genuinely overlaps an existing entry (at most three titles; bodies are read on demand).

## 触发方式 / Triggers

| 场景 | 行为 |
| --- | --- |
| **L0** 你明确要求「记住这个」 | 立即写盘，一条确认行 |
| **L1** 它发现有跨会话价值的经验 | 一行灰字 `memory · suggested "X" · sug_x` + 一个 `keep` 按钮；标题加一句话，看得懂才点，不点就永远不写，48 小时内不重复 |
| **L2** 常识、一次性参数、凭据的值 | 永不写入 |

这些行只属于产生它的那一轮：重进会话就没了，历史里只留正文。再记一次时插件自己判是更新还是新增：同层、同前置条件下，标题（或这条用过的旧标题）完全一致就更新原条目，换过说法而标题变了的旧标题记成别名以后也认得。像但不同名的不写：先在结果里回「相近：X」和它的 id，确认要更新就带那个 id 再存，确认是另一条才加 `resolution="distinct"`。更新时没给的字段保持原值，正文整段替换——旧正文原样留在 `versions` 里（每字都留，不截断）；前置条件不同的同一主题是两条。

写入时分两层：默认只在这个项目生效；用户说「以后所有项目都这样」才进全局层（上限 200 条），检索时一起查。同一主题在不同前提下用 `when` 区分，各存一条。

触发词：`记住`、`记一下`、`上次`、`规范`、`约定`、`路径`、`凭据怎么取`。

真命中不看触发词：这句话与某条记忆的标题（含旧标题）有重合时，本步多一行「已有记忆可能相关」，最多三条标题和 id；没重合就不出现，不改命中计数，正文要 `memory_read` 才读。

| Case | Behaviour |
| --- | --- |
| **L0** you ask it to remember | written immediately, one confirmation line |
| **L1** it spots something worth keeping | one muted line `memory · suggested "X" · sug_x` with a single `keep` button — readable before you click, nothing written unless you click, at most once per two days |
| **L2** common sense, one-off parameters, credential values | never written |

Those lines belong to the turn that made them: reopening the session drops them, leaving only the prose in history. Saving again updates an entry only when the title (or one of its earlier titles) matches exactly under the same precondition. A merely similar title writes nothing first: the result reports the closest entry and its id, so the caller either updates that id or re-saves with `resolution="distinct"`. An update keeps every field it was not given and replaces the body wholesale; the previous body stays in `versions` verbatim. The same subject under different preconditions stays two entries.

Writes land in one of two layers: the current project by default, or the global layer (max 200 entries) when the user says the rule holds for every project. Both layers are searched together, and a `when` field separates the same subject under different preconditions.

## 点一下就存 / One click, no turn

`keep` 是同源直写：不产生消息、不动输入框、不打断当前回复。按钮变 `kept` 就结束了。行尾的 `✕` 按 id 撤销：改过的条目还原成上一版（显示 `restored`），刚建的条目移入归档（显示 `archived`）。

`keep` writes straight to disk from the page: no message, no extra model turn, the input box untouched. The button turns into `kept` and that is the whole interaction. The `✕` at the end of a line undoes by id: an edited entry goes back to its previous version (`restored`), a freshly created one moves to the archive (`archived`).

## 底部引用条 / Citation footer

这次会话真正读进来的记忆，会在输入框下面留一行 `记忆引用 N 条`：点开是标题，再点一条就地展开正文，再点收起。行和正文都按当前状态显示——条目改过名就显示新名字，被归档或删掉就不再出现。没读过记忆就不出现；换会话回来还在，一个会话最多留 20 条，30 天不用就清掉。

Memories actually read into this session leave one line under the composer — `记忆引用 N 条`. It expands to titles, a title expands to the raw body, and clicking again collapses it. Nothing read, nothing shown. It reads the entry as it is now — a renamed entry shows its new title, a dropped one disappears. It survives switching conversations; at most 20 rows per session, cleared after 30 days.

## 为什么轻 / Why it stays light

- **0 依赖**，存储层无定时器、无监听、无网络，只有同步单文件写；写入用一把有超时的锁，别的进程正在写就明确报「忙」，不抢别人的锁。
- 搜索最多 4 条、400 字；正文只在 `memory_read` 里出现，全文永不进上下文。
- 超限直接报错、原数据不动：单条正文 4096 字节、整库 512 KB、项目 200 条、全局 200 条、标题 60 字、摘要 60 字。90 天未用只留 `id + 标题`。满了不自动归档，直接报错：先腾一条再存；归档只在用户明确说「别记」时发生（正文与完整记录都留着，可人工取回），文件从不删除。
- 一个项目一个目录，项目之间互相看不见。

- **Zero dependencies.** The store has no timers, no listeners, no network — just synchronous single-file writes, guarded by a lock that gives up after 500 ms instead of stealing it.
- Search returns at most 4 hits and 400 characters. Full text only appears in `memory_read`.
- Over any limit the call fails and the old state stays: 4096 bytes per body, 512 KB per store, 200 entries per project, 200 in the global layer, 60 characters per title or summary. Unused for 90 days drops to `id + title`. A full store refuses the write instead of archiving on its own; archiving happens only when the user asks to drop an entry (body and full record kept, restorable by hand). Files are never deleted.
- One directory per project, so projects never see each other's notes.

## 安装 / Install

Plugin Manager 里搜 `dsh-lite-memory` 直接装；或 `npm pack` 后用 Plugin Manager 安装生成的 `.tgz`。

Install from the DSH Plugin Manager (search `dsh-lite-memory`), or `npm pack` and install the resulting `.tgz` through it.

## 工具 / Tools

`memory_save` · `memory_suggest` · `memory_search` · `memory_read` · `memory_forget`

完整触发规则见 [TRIGGERS.md](TRIGGERS.md)。 / Full trigger rules: [TRIGGERS.md](TRIGGERS.md).

## License

MIT
