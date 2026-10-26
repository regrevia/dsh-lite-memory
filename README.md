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

这些行只属于产生它的那一轮：每轮按那轮自己的工具结果重建，重进会话还能看见，别的轮不会混进来。再记一次时插件自己判是更新还是新增：同层、同前置条件下，标题（或这条用过的旧标题）完全一致就更新原条目，换过说法而标题变了的旧标题记成别名以后也认得。像但不同名的不写：先在结果里回「相近：X」和它的 id，确认要更新就带那个 id 再存，确认是另一条才加 `resolution="distinct"`。更新时没给的字段保持原值，正文整段替换——旧正文只作内部撤回依据，不展示、不参与检索；前置条件不同的同一主题是两条。

写入时分两层：默认只在这个项目生效；用户说「以后所有项目都这样」才进全局层（200 条起提示，硬上限 1000 条），检索时一起查。同一主题在不同前提下用 `when` 区分，各存一条。

写入前先蒸馏：标题是结论，正文只留原则、判断规则和触发条件，不把具体尺寸、字号、层级、颜色或一次性数字记进来；需要这些值时按记忆里的指针查当前代码或文档。单条正文超过 1200 字节会被拒绝，先删细节再存。

触发词：`记住`、`记一下`、`上次`、`规范`、`约定`、`路径`、`凭据怎么取`。

真命中看这句话和记忆的标题（含旧标题）、标签、触发词、摘要有没有对得上的词：有就多一行「已有记忆可能相关」，最多三条标题和 id，每条前面标归属（`[global]` 或项目目录名如 `[DSH]`）；没对上就不出现，不改命中计数，正文要 `memory_read` 才读。一条记忆写了触发词，用户说到那个词也算命中。

| Case | Behaviour |
| --- | --- |
| **L0** you ask it to remember | written immediately, one confirmation line |
| **L1** it spots something worth keeping | one muted line `memory · suggested "X" · sug_x` with a single `keep` button — readable before you click, nothing written unless you click, at most once per two days |
| **L2** common sense, one-off parameters, credential values | never written |

Those lines belong to the turn that made them: each turn is rebuilt from its own tool results, so reopening the session shows them again and no other turn leaks in. Saving again updates an entry only when the title (or one of its earlier titles) matches exactly under the same precondition. A merely similar title writes nothing first: the result reports the closest entry and its id, so the caller either updates that id or re-saves with `resolution="distinct"`. An update keeps every field it was not given and replaces the body wholesale; the previous body is kept only for internal undo and never shown or searched. The same subject under different preconditions stays two entries.

Writes land in one of two layers: the current project by default, or the global layer (warns past 200, hard ceiling 1000) when the user says the rule holds for every project. Both layers are searched together, and a `when` field separates the same subject under different preconditions.

Before writing, distill: the title is the conclusion and the body keeps only the principle, decision rule and trigger condition. Concrete dimensions, font sizes, z-index, colors and one-off numbers stay out; the memory points at where to read the current value instead. A body over 1200 bytes is refused, so drop detail before saving.

## 点一下就存 / One click, no turn

`keep` 是同源直写：不产生消息、不动输入框、不打断当前回复。按钮变 `kept` 就结束了。真写过的行尾才有 `✕`，按 id 撤销：改过的条目还原成上一版（显示 `restored`），刚建的条目移入归档（显示 `archived`）；条目后来又改过就停下并说明已经变过，不覆盖后来的修改。没变、需要确认、保存失败的行没有撤销。

`keep` writes straight to disk from the page: no message, no extra model turn, the input box untouched. The button turns into `kept` and that is the whole interaction. Only a row that really changed gets the `✕`, and it undoes by id: an edited entry goes back to its previous body (`restored`), a freshly created one moves to the archive (`archived`); if the entry changed again it stops and says so instead of overwriting. Noop, needs-confirmation and failed saves get no undo.

## 每轮引用条 / Per-turn references

每次回复末尾、在「已编辑 N 个文件」下面，按这一轮实际发生的工具结果留几行：`本轮参考 N 条` 和 `本轮更新 N 条`。点开是记忆名，再点一条就地展开当前正文；名字和正文都取当前值——改过名显示新名字，归档的标「已归档」，删掉的显示「已删除」。同一轮同一条只出现一次；没读过也没写过就整段不出现。切换会话不丢，每轮只按自己的工具结果重建。

Each completed turn keeps a few lines under 「已编辑 N 个文件」, built from that turn's own tool results: `本轮参考 N 条` and `本轮更新 N 条`. A line expands to memory names, a name expands to the body as it is now — current title, current body, archived marked, deleted said outright. One row per entry per turn; nothing read or written, nothing shown. Switching conversations keeps them, because each turn is rebuilt from its own tool results only.

## 记忆面板 / Memory panel

会话头的大脑图标打开居中的记忆面板。默认看当前项目，也可以切到其他项目或全局层；切过去只读，不回写、不迁移旧格式。面板里能看到真实记忆画成的图谱、类型分布和计数，右侧按「记忆 / 规则 / 归档」列出条目，点一条读当前正文。项目自进化的开关也在这里，只对当前项目可改。

The brain icon in the session header opens a centered memory panel. It starts on the current project and can switch to another project or the global layer; switched scopes are read-only and never migrate or create state. The panel draws the graph from real entries, shows the kind breakdown and counts, and lists memories, rules and archived notes on the right; selecting one reads its current body. The project self-evolution switch lives here too and is editable only for the current project.

- 项目记忆总开关关闭后，这个项目不再使用任何记忆（包括全局层）：自动注入、检索、读取、引用、保存全部停，面板只能查看；重新打开后沿用原来的自进化设置。
- 图谱只按数据画：每条有效记忆一个节点，共享标签和主题做枢纽，显式关联画实线；位置由 id 决定，同一批数据每次一样。
- 范围只来自服务端枚举的层；不接受客户端拼路径，也不能写别的项目。
- 关闭后停止整理与晚到写入，已固定的项目规范继续生效，实验成果留在「规则」和「归档」里。

- Turning the project memory switch off stops all memory use in that project, including the global layer: no injection, search, read, citation or save, and the panel is read-only. Turning it back on restores the previous self-evolution setting.
- The graph is data only: one node per active memory, shared tags and topics as hubs, explicit links as solid edges; positions derive from ids, so the same data looks the same every time.
- Scopes come only from the server-side list; the page cannot assemble a path or write another project's notes.
- Turning evolution off stops organizing and late writes; pinned project rules keep working and experimental results stay under Rules and Archive.

## 为什么轻 / Why it stays light

- **0 依赖**，存储层无定时器、无监听、无网络，只有同步单文件写；写入用一把有超时的锁，别的进程正在写就明确报「忙」，不抢别人的锁。
- 搜索最多 4 条、400 字；正文只在 `memory_read` 里出现，全文永不进上下文。
- 普通检索只列当前有效的记录；已经归档或被更新替换的旧说法不混进来，要查历史得在 `memory_search` 里显式要 `history`。
- 上限：单条正文 1200 字节、整库正文 512 KB、每层 1000 条、标题与摘要各 60 字；每层 200 条只当提示线。90 天未用只留 `id + 标题`。到了硬上限不拒绝新记忆：把同层最久没被读的一条移进归档，保存结果里写明是哪条（正文与完整记录都留着，可人工取回），单条本身超预算才报错；用户明确说「别记」也进归档。文件从不删除。
- 一个项目一个目录，项目之间互相看不见。

- **Zero dependencies.** The store has no timers, no listeners, no network — just synchronous single-file writes, guarded by a lock that gives up after 500 ms instead of stealing it.
- Search returns at most 4 hits and 400 characters. Full text only appears in `memory_read`.
- Normal search lists current entries only; archived notes and superseded wording stay out unless `memory_search` asks for `history`.
- Limits: 1200 bytes per body, 512 KB of bodies per store, 1000 entries per layer, 60 characters per title or summary; 200 entries per layer is just a warning line. At the hard ceiling a save is never refused: the least recently read entry in the same layer moves to archive and the result names it (body and full record kept, restorable by hand); only an entry that alone exceeds the budget fails. Saying 「别记」 also archives. Files are never deleted.
- One directory per project, so projects never see each other's notes.

## 项目自进化〔实验〕 / Project self-evolution (experimental)

默认关闭，只对当前项目生效。开启后，它从你的纠正和认可里整理出少量项目规范：纠正更新做法，认可作品只给已有规范留一条带维度的样例；执行漏掉只补检查点，不改写成禁令。下次匹配任务按需读取，不逐轮注入。会增加一次有上限的后台整理调用，以及命中的记忆读取消耗。

Off by default, per project only. When enabled it distills a few project rules from your corrections and approvals: corrections revise the approach, approvals attach one bounded sample to an existing rule, and an execution miss adds a checkpoint instead of a ban. Matching tasks read them on demand, never per turn. It adds one bounded background organize call and the memory reads that actually hit.

- 一次整理最多 2 处改动、768 输出 token、15 秒；输入不超过 8 KiB，同一作品最多 2 次，同一项目 24 小时内最多 6 次。
- 成果停在 `pending` / `trial` / `active` / `paused`；明确说「以后都这样」或两个独立作品支持才 `active`，试用与暂停 30 天后清理。
- 规则 32 条、待定 12 条、每规则样例 4 个/检查点 3 个/来源 3 条、旧版本 2 个，都有硬上限；到顶先暂停新学习，不静默丢已生效规则。
- 面板显示整理次数和已知用量；usage 没返回就写未知，不补零。
- 关闭后停止学习、读取和晚到写入；已固定为普通项目规范的内容继续生效，实验成果保留可查看。
- 同一项目换栏目、新一期、临时例外不会互相继承；仓库子目录、符号链接、worktree 视为同一项目，不同克隆分开。

- At most 2 changes, 768 output tokens and 15 s per organize call; input ≤ 8 KiB, ≤ 2 calls per episode and ≤ 6 per project in 24 h.
- Results stay `pending` / `trial` / `active` / `paused`; they become `active` only on an explicit long-term ask or two independent episodes; trial and paused entries expire after 30 days.
- Hard caps: 32 rules, 12 pending, 4 samples / 3 checkpoints / 3 sources per rule, 2 old versions. At the ceiling new learning pauses; active explicit rules are never silently dropped.
- The panel reports organize calls and known usage; missing usage is shown as unknown, never zero.
- Turning it off stops learning, reads and late writes; rules pinned as ordinary project norms keep working, experimental results stay viewable.
- Switching columns, a new episode and one-off exceptions do not leak into each other; a repository subdirectory, symlink or worktree is the same project, separate clones are not.

## 安装 / Install

Plugin Manager 里搜 `dsh-lite-memory` 直接装；或 `npm pack` 后用 Plugin Manager 安装生成的 `.tgz`。

Install from the DSH Plugin Manager (search `dsh-lite-memory`), or `npm pack` and install the resulting `.tgz` through it.

## 工具 / Tools

`memory_save` · `memory_suggest` · `memory_search` · `memory_read` · `memory_forget`

完整触发规则见 [TRIGGERS.md](TRIGGERS.md)；性能与 UI 门禁的实测数字见 [docs/BENCH.md](docs/BENCH.md)。 / Full trigger rules: [TRIGGERS.md](TRIGGERS.md); measured performance and UI-gate evidence: [docs/BENCH.md](docs/BENCH.md).

## License

MIT
