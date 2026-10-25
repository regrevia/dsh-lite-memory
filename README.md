# dsh-lite-memory

**没有常驻的记忆正文：不写系统提示，不逐轮注入，命中才读。**
**No memory in the prompt: nothing injected per turn, read only on a hit.**

---

## 它是什么 / What it is

给 DeepSeek Harness 的轻量记忆：不写系统提示、不逐轮注入、不扫描文件。记忆只在两种时刻出现——你说「记一下」，或者它命中了一条查过的内容。

Lightweight memory for the DeepSeek Harness. Nothing in the system prompt, nothing injected per turn. Memory appears at exactly two moments: you ask it to remember, or a query matches something already stored.

## 触发方式 / Triggers

| 场景 | 行为 |
| --- | --- |
| **L0** 你明确要求「记住这个」 | 立即写盘，一条确认行 |
| **L1** 它发现有跨会话价值的经验 | 一行灰字 `memory · keep? "X" — 要记的内容` + 一个 `keep` 按钮；标题加一句话，看得懂才点，不点就永远不写，48 小时内不重复 |
| **L2** 常识、一次性参数、凭据的值 | 永不写入 |

这些行只属于产生它的那一轮：重进会话就没了，历史里只留正文。再记一次时插件自己判是更新还是新增：同层、同前置条件下，标题（或这条用过的旧标题）完全一致就更新原条目，换过说法而标题变了的旧标题记成别名以后也认得；像但不同名的不合并，只在结果里报「相近：X」和它的 id，交给模型确认后用 id 更新。旧正文留在 `versions` 里；正文合并只在同一 Markdown 章节内覆盖同名键，跨章节的同名键互不覆盖；前置条件不同的同一主题是两条。

写入时分两层：默认只在这个项目生效；用户说「以后所有项目都这样」才进全局层（上限 40 条），检索时一起查。同一主题在不同前提下用 `when` 区分，各存一条。

触发词：`记住`、`记一下`、`上次`、`规范`、`约定`、`路径`、`凭据怎么取`。

| Case | Behaviour |
| --- | --- |
| **L0** you ask it to remember | written immediately, one confirmation line |
| **L1** it spots something worth keeping | one muted line `memory · keep? "X" — what would be remembered` with a single `keep` button — readable before you click, nothing written unless you click, at most once per two days |
| **L2** common sense, one-off parameters, credential values | never written |

Those lines belong to the turn that made them: reopening the session drops them, leaving only the prose in history. Saving again updates an entry only when the title (or one of its earlier titles) matches exactly under the same precondition. A merely similar title creates a new entry and reports the closest one with its id, so the caller can update it deliberately. Earlier bodies stay in `versions`, and key lines are only overwritten within the same Markdown section. The same subject under different preconditions stays two entries.

Writes land in one of two layers: the current project by default, or the global layer (max 40 entries) when the user says the rule holds for every project. Both layers are searched together, and a `when` field separates the same subject under different preconditions.

## 点一下就存 / One click, no turn

`keep` 是同源直写：不产生消息、不动输入框、不打断当前回复。按钮变 `kept` 就结束了。自动写入的行尾有个 `✕`，点它就把刚才那条移入归档。

`keep` writes straight to disk from the page: no message, no extra model turn, the input box untouched. The button turns into `kept` and that is the whole interaction. An auto-saved line ends with `✕`: click it and that entry moves to the archive.

## 为什么轻 / Why it stays light

- **0 依赖**，存储层无定时器、无监听、无网络，只有同步单文件写。
- 搜索最多 4 条、400 字；正文只在 `memory_read` 里出现，全文永不进上下文。
- 判重只看标题与旧标题，不靠相似度覆盖；90 天未用只留 `id + 标题`；超 200 条或 512 KB 转 `archive/`（正文与完整记录都留着，可人工取回），文件从不删除。
- 一个项目一个目录，项目之间互相看不见。

- **Zero dependencies.** The store has no timers, no listeners, no network — just synchronous single-file writes.
- Search returns at most 4 hits and 400 characters. Full text only appears in `memory_read`.
- Identity is the title (or a title it used before), never fuzzy similarity. Unused for 90 days drops to `id + title`. Over 200 entries or 512 KB archives with body and full record kept, so an entry can be restored by hand. Files are never deleted.
- One directory per project, so projects never see each other's notes.

## 安装 / Install

Plugin Manager 里搜 `dsh-lite-memory` 直接装；或 `npm pack` 后用 Plugin Manager 安装生成的 `.tgz`。

Install from the DSH Plugin Manager (search `dsh-lite-memory`), or `npm pack` and install the resulting `.tgz` through it.

## 工具 / Tools

`memory_save` · `memory_suggest` · `memory_search` · `memory_read` · `memory_forget`

完整触发规则见 [TRIGGERS.md](TRIGGERS.md)。 / Full trigger rules: [TRIGGERS.md](TRIGGERS.md).

## License

MIT
