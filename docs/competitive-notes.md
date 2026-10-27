# 竞品记忆系统研究笔记

研究对象：主流开源记忆框架 / 主流 Agent 的记忆实现。目的不是罗列功能，而是回答六个工程问题，并把每条结论落到 `dsh-lite-memory` 的具体文件与函数上，标注 **采纳 / 拒绝 / 理由 / P0-P2**。

本文所有事实来自下列一手页面（README、官方文档、论文页）。**未记录 star 数、下载量、发布时间线**：这些数字会漂移，且本轮未做可复现的抓取，宁可缺也不编。凡属二手推断或仅见于 README 而未读实现的地方，均在行内标注「二手」或「仅 README」。

---

## 0. 结论速览（先看这 5 条）

1. **行业主流正在往「常驻注入」走**（Claude Code 每次会话加载 CLAUDE.md + 自动记忆索引，Codex 每次运行加载 AGENTS.md 链 + 注入 Memories，Hermes 把 MEMORY.md/USER.md 冻结进 system prompt，Letta 根目录记忆每轮进上下文）。`dsh-lite-memory` 的「不常驻、按需露出标题」是逆流选择，必须**明确保留并在文档里论证**，同时补上常驻方案真正的长处：**预算可见 + 冻结快照保证前缀缓存 + 会话级开关**。
2. **写入侧正在从「就地更新」转向「只追加 + 失效」**：mem0 新算法干脆取消 UPDATE/DELETE，只 ADD；Graphiti 用双时态有效期窗口「失效而不删除」；mcp-memory-service 用 belief 置信度 + 矛盾检测把旧记忆标 superseded（默认检索隐藏、显式可查）。`dsh-lite-memory` 目前只有 `versions`（最多 2 份）与归档，**没有事实级有效期/被替换链**——这是最大的可借鉴缺口（P0）。
3. **来源可视化已经是分层披露的竞赛**：claude-mem 把「搜索引 → 看时间线 → 取正文」做成 3 层 MCP 工具（约 50–100 → 500–1000 token/条，号称省 10 倍）；Graphiti 每条事实都能追到 episode；mcp-memory-service 有 insight card 与「已 superseded」标注。`dsh-lite-memory` 已有 `搜索命中 / 读过正文 / 本轮更新` 三分组，但缺**折叠态一行摘要 + 展开的来源二级（excerpt / 原轮次）**（P1）。
4. **运维面最值得抄的是「体检」与「降级开关」**：Letta 有 `/doctor`（审计记忆放置、重复、system prompt token 占用），Hermes 有 80% 容量告警与注入/外泄扫描，Codex 有「空闲才后台生成 + 剩余额度低于阈值就跳过 + 可按会话/按工具上下文关闭」。`dsh-lite-memory` 的落盘/锁/校验和/迁移意图已经很强，**缺的是可观测的体检视图与显式降级开关**（P1/P2）。
5. **有一类东西明确不要抄**：自由布局力导向图、每轮注入、恒常 token 统计、把记忆塞进 system prompt 当规则、每次编辑一次 git commit、依赖外部向量库。理由见第 10 节。

---

## 1. 范围、方法与可信度

### 1.1 覆盖清单

| 类别 | 对象 | 主要来源（均为本轮实际打开） |
| --- | --- | --- |
| 开源记忆框架 | mem0 | <https://github.com/mem0ai/mem0> ；迁移说明 <https://docs.mem0.ai/migration/oss-v2-to-v3> |
| 开源记忆框架 | Letta（MemGPT 后继）/ MemFS | <https://docs.letta.com/agent-sdk/memory/> ；<https://docs.letta.com/concepts/memfs/> ；<https://docs.letta.com/configuration/memory/> ；<https://github.com/letta-ai/letta-code> |
| 开源记忆框架 | LangMem | <https://github.com/langchain-ai/langmem> ；<https://langchain-ai.github.io/langmem/hot_path_quickstart> |
| 开源记忆框架 | basic-memory | <https://github.com/basicmachines-co/basic-memory> |
| 开源记忆框架 | claude-mem | <https://github.com/thedotmack/claude-mem> |
| 开源记忆框架 | mcp-memory-service | <https://github.com/doobidoo/mcp-memory-service> ；<https://github.com/doobidoo/mcp-memory-service/blob/main/docs/guides/memory-consolidation-guide.md> |
| 开源记忆框架 | OpenMemory | <https://github.com/mem0ai/openmemory> |
| 开源记忆框架 | Cognee | <https://github.com/topoteretes/cognee> ；<https://docs.cognee.ai/core-concepts/main-operations/remember> |
| 开源记忆框架 | Graphiti / Zep | <https://github.com/getzep/graphiti> ；论文 <https://arxiv.org/abs/2501.13956> |
| 开源记忆框架 | Memary | <https://github.com/kingjulio8238/Memary> |
| 商业 Agent 产品 | Claude Code | <https://code.claude.com/docs/en/memory> |
| 商业 Agent 产品 | Codex | <https://learn.chatgpt.com/docs/customization/memories> ；<https://learn.chatgpt.com/docs/agent-configuration/agents-md> |
| 开源 Agent 产品 | Hermes（NousResearch） | <https://github.com/NousResearch/hermes-agent> ；<https://hermes-agent.nousresearch.com/docs/user-guide/features/memory> |

### 1.2 方法

1. 抓官方 README / 文档正文（能拿 Markdown 就拿 Markdown，拿不到 HTML 转文本），只从中提取**机制、字段、默认值、命令、路径**。
2. 对同一事实做交叉核对：README 宣称与文档细节冲突时，以文档为准并标注冲突；只有 README 的写「仅 README」。
3. 对照 `dsh-lite-memory` 的 `README.md` / `TRIGGERS.md` / `DESIGN.md` 与实际代码（`store.js`、`state.js`、`index.js`、`client.js`、`learning.js`），逐条判定缺口。凡引用行号，均为本仓库当前工作副本。
4. 结论分级：**采纳**=值得做且与现有设计不冲突；**改造后采纳**=方向对但要换实现；**拒绝**=与产品契约或成本模型冲突，附理由。

### 1.3 可信度约定

- 「一手文档」：官方 docs / README 明写的机制与默认值。
- 「实现细节」：本轮未读源码的部分（如 mem0 内部提示词、Graphiti 失效算法）**不写具体算法**，只写文档明说的语义。
- 本文不引用任何未打开过的链接；不把博客转述当官方事实（例如「Codex 有两层记忆」这类说法已由官方 Memories 文档替代）。

---

## 2. Q1｜自动注入的触发条件、时机、预算、低干扰手段

### 2.1 行业做法（有据可查的部分）

| 系统 | 触发时机 | 注入位置 | 预算 | 低干扰手段 |
| --- | --- | --- | --- | --- |
| Claude Code | **每次会话开始**加载 CLAUDE.md 链 + 自动记忆索引。自动记忆默认开启 | 上下文开头（不是 system prompt，官方明确「当上下文而非强制配置」） | 记忆索引「前 200 行或 25KB」；CLAUDE.md 无固定上限但受上下文窗口约束 | 自动记忆只写**索引**（MEMORY.md），正文按 topic 文件按需读；`/memory` 可关；`/context` 显示实际加载了哪些文件 |
| Codex | AGENTS.md：**每次运行读一次**；Memories：**会话中注入已存记忆**（`memories.use_memories`） | 上下文 | AGENTS.md 默认 `project_doc_max_bytes` 32 KiB | 记忆默认关闭；后台生成要等会话**空闲够久**；剩余额度低于阈值直接跳过；可按会话 `/memories` 选择「本对话是否使用/是否贡献」；`disable_on_external_context` 可把用过 MCP/联网的对话排除 |
| Hermes | **会话开始**把 MEMORY.md（2200 字符 ≈ 800 token）+ USER.md（1375 字符 ≈ 500 token）冻结进 system prompt | system prompt，带 `[67% — 1474/2200 chars]` 表头，条目用 `§` 分隔 | 硬字符上限；**不自动压缩**，超限报错并要求同轮内 consolidate | 冻结快照（会话内不变，保前缀缓存）；`/new` 在新会话生效；`write_approval` 可让写入进 `/memory pending` 待批 |
| Letta / MemFS | **每轮**：记忆**根目录**文件进 system prompt；带 `MEMORY.md` 的子目录只给文件树，按需读 | system prompt / 文件树 | 无硬上限，但有 `/doctor` 审计 system prompt token 占用；云端仓库 5 MiB（Free）/50 MiB（Pro） | 目录即 signpost：`MEMORY.md` 当索引用，深层资料不进上下文；`/init` 初始化、`/remember` 显式教 |
| LangMem | 两种模式：**热路径**（把记忆直接拼进 prompt，无需 agent 主动搜）/ 工具模式（agent 自己调 `search_memory`） | prompt 或工具结果 | 由宿主自定 | 提供 `create_manage_memory_tool` 让模型自己决定记什么；后台 memory manager 在非热路径做抽取与整合 |
| mem0 | 检索式（query 时取） | 工具/接口返回 | 由调用方定 | 单趟 ADD-only 抽取，记忆累积不覆盖；多信号检索（语义 + BM25 + 实体） |
| Graphiti | 检索式 | 工具/接口返回 | 由调用方定 | 混合检索（embedding + BM25 + 图遍历），不靠 LLM 摘要 |
| basic-memory | 检索式（MCP） | 工具返回 | 由调用方定 | 「渐进式工具发现」：每个工具带 read-only / destructive / idempotent 行为提示，agent 按需选，不试错 |
| mcp-memory-service | 检索式 + `get_bootstrap_profile`（token 预算内的行为上下文） | 工具返回 | bootstrap profile 有 token 预算 | 检索有 `mode="ranked"`（新近度/访问频次/质量加权）与回退级联 |

### 2.2 关键洞察

1. **「常驻」派真正省的不是 token，而是「模型不必知道该搜什么」**。Claude Code/Hermes/Letta 都用「小索引常驻 + 正文按需」解决「不知道要搜」的问题，而不是把全部记忆塞进去。Hermes 的 2200 字符上限和 Claude Code 的 200 行/25KB 是同一思路的不同刻度。
2. **常驻派的代价被显式承认并量化**：Hermes 在 prompt 里打出占用百分比，超限直接报错要求腾地方；Letta 提供 `/doctor` 看 system prompt token 占用。**预算必须是可见的**，否则「小索引」会静默膨胀。
3. **冻结快照是工程妥协，不是疏忽**：Hermes 明说会话内写盘立即可见、但 prompt 不变，是为了保住前缀缓存。这与 `dsh-lite-memory` 的「每次 recall 现算」是两条路，各有成本。
4. **低干扰的核心不是「少注入」，而是「可关 + 可解释 + 有闸门」**：Codex 的三道闸（空闲才生成、额度低跳过、按会话开关）是目前最完整的低干扰设计。

### 2.3 对 dsh-lite-memory 的结论

| # | 结论 | 判定 | 理由 | 优先级 | 落点 |
| --- | --- | --- | --- | --- | --- |
| 1.1 | **不改成常驻注入**，保留「不写 system prompt、按需在 runtime context 露标题」 | 拒绝常驻 | 产品契约就是不站岗：无系统提示、无每轮注入、不扫文件。常驻方案把记忆变成「隐含规则」，与我们「记忆是历史笔记」的定位冲突；且会让前缀缓存与上下文预算不可控 | — | `index.js` `lite-memory:recall` 槽（order 60, interpolate false）保持不变 |
| 1.2 | **recall 输出补「预算与截断」可观测字段**：返回 `{titles, chars, limit, truncated, reasonCode}`，`reasonCode` 区分「无重叠」「超预算」「跨 scope 命中 global」 | 改造后采纳 | 现在的自动命中（`RECALL_QUERY_CHARS = 400`，最多 3 条标题）在超预算/无命中时对外只有一个空串，排障只能靠猜。Hermes 的百分比表头证明「预算是产品功能」 | P1 | `index.js` `recallText(holder)`（约 1510 行）；`RECALL_QUERY_CHARS`（809 行） |
| 1.3 | **自动命中要留「命中原因」**：把命中的 bigram/run 与 score 档位写进本次会话的 citation receipts，供面板与 `memory_search` 的 `noTriggerReason` 复用 | 采纳 | 现在 `memory_search` 有 `noTriggerReason`，但自动 recall 没有对应物；两边口径不一致时无法解释「为什么这次没提醒我」 | P1 | `store.js` `scoreQuery` / `queryRuns` / `matchesRun`；`store.js` `citationFile`/`citationKey`/`resolveCitation` |
| 1.4 | **会话级开关**：允许本会话关闭自动回忆或关闭自动建议（类似 Codex `/memories` 的按会话开关） | 采纳 | 低干扰的最后一环是「我现在不想被打断」。实现成本低：会话状态里一个 flag，`recallText` 直接返回空并在 receipts 记 `session_disabled` | P2 | `index.js` `recallText` + 会话状态；`client.js` 头部工具区（`conversation.session.header.utilities` 槽已有） |
| 1.5 | **不要引入「注入前 LLM 筛选」** | 拒绝 | 多一次模型调用换来的精度提升，在「最多 3 条标题、正文按需」的量级上收益极小，且引入延迟与不确定性 | — | — |

---

## 3. Q2｜写入状态机与审计字段（add / update / conflict / expire / revoke / replace）

### 3.1 行业做法

**mem0（v3 新算法）**：README 明写「single-pass ADD-only extraction，一次 LLM 调用，不做 UPDATE/DELETE，记忆只累积不覆盖」，并把「agent 生成的事实」当一等公民、加实体链接、多信号检索与时间推理；同时保留了 v2→v3 迁移文档。其旧版提示词里存在 ADD / UPDATE / DELETE / NO CHANGE 四分类（`mem0/configs/prompts.py`）。**方向很明确：用「只追加 + 检索时消歧」替代「写入时改写」。**

**Graphiti / Zep**：context graph 的每条事实（边）带**有效期窗口**（何时为真、何时被取代），信息变化时**旧事实失效而不删除**，可查询「现在为真」或「某时点为真」；实体摘要随时间演化；所有派生物都能追到 **episode（原始数据）**。这是目前文献里最完整的时间语义模型（论文 <https://arxiv.org/abs/2501.13956>）。

**mcp-memory-service**：belief 带**置信度**，并有启发式**矛盾检测**，把较旧的记忆标为 **superseded**——默认检索隐藏、显式查询仍可取回。另有「洞察卡（insight cards）」与自主整合（聚类、压缩、关联、受控遗忘）。

**Hermes**：`memory` 工具三个动作 `add` / `patch`（替换某段，保留其余）/ `remove`（子串匹配）；一批操作共享同一 `target`（`memory` 或 `user`），**限额只在批次最终结果上校验**，超限返回明确错误（差多少字符、需要腾多少），并附带 `closest_entries` 帮助定位；**精确重复直接拒绝**；写入前做**注入/外泄模式扫描**，命中可疑模式或含不可见 Unicode 直接拦截。

**Letta**：每次记忆编辑都 **commit 到 MemFS git 仓库**，从而获得版本历史、冲突解决与「已保存 vs 未提交」的清晰边界；整理记忆前先备份仓库。

**Claude Code**：自动记忆按 **topic 文件**组织，每个文件带 frontmatter `type` ∈ {user, feedback, project, reference}；索引 `MEMORY.md` 只放指针；明确「能从代码库推导的、已在 CLAUDE.md 里的不记」。

### 3.2 状态机对比

| 能力 | 行业代表 | dsh-lite-memory 现状 |
| --- | --- | --- |
| 追加 / 更新 | mem0 只追加；Hermes add/patch/remove；LangMem 工具读写 | 有：同 scope + 同 `when` + 同标题（或旧标题/别名）→ 更新；正文整段替换 |
| 冲突 | mcp-memory 置信度 + 矛盾检测标 superseded；Graphiti 失效旧边 | 有「近似标题 → `needsResolution` + 候选 id」，**但没有「新旧并存 + 谁取代谁」的持久语义** |
| 过期 | Graphiti 双时态窗口；Hermes 靠容量淘汰；mcp-memory 受控遗忘 | 只有建议/抑制的 TTL 与自进化 trial 的 `expireLearning(..., {by:'ttl', reason:'trial_expired'})`；**事实本身没有有效期** |
| 撤销 / 遗忘 | Letta git 可回滚；mem0 不删只追加 | 有：`✕` 撤销（带版本校验）、forget=归档不删除、`versions` 最多留 2 份 |
| 替换链 | Graphiti `invalidated_by` 语义；mcp-memory `superseded` 标注 | **缺**：旧版本存在 `versions` 里，但没有「被谁替换、何时、为什么」的一等字段 |
| 审计 | Graphiti episodes 溯源；Hermes 拦截记录；Letta commit 历史 | 有：`updatedAt` / `createdAt` / `lastUsed`（`touchUsed`，超阈值才回写）、citation receipts、`sourceExcerpt`（自进化变更里） |

### 3.3 对 dsh-lite-memory 的结论

| # | 结论 | 判定 | 理由 | 优先级 | 落点 |
| --- | --- | --- | --- | --- | --- |
| 2.1 | **给记录加「有效期 + 取代链」最小字段**：`validFrom`（默认写入时间）、`validUntil`（可空）、`supersededBy`（可空）、`supersedeReason`（`user_replaced` / `contradicted` / `expired`） | 改造后采纳 | 这是 Graphiti 与 mcp-memory 共同指向的能力，而我们只有 `versions`。注意**不做双时态图**：只在记录层加 4 个可选字段，`findCurrent` 的默认过滤逻辑加一条「`validUntil` 未过且未被取代」 | **P0** | `store.js` `toFlat`/`fromFlat`/`applyFlat`、`findCurrent`、`archiveEntry`；`index.js` `memory_forget`、`memory_save` |
| 2.2 | **显式 `replace` 语义**：`memory_save` 支持传 `supersedes: <id>`（或 `resolution` 之外新增 `replace_id`），写入时给旧记录打 `supersededBy`/`validUntil`，新记录进 `versions` 链头 | 采纳 | 现在靠「同标题就覆盖」，用户看不到「上一版说了什么」。带 `supersededBy` 后 `memory_search history:true` 能展示演化；面板可显示「3 次更新」 | **P0** | `store.js` `upsertLocked`、`snapshot`、`versions` 写入路径；`client.js` `TurnMemory` 的 `update` 分组 |
| 2.3 | **冲突从「阻断」升级为「阻断 + 候选解释」**：`needsResolution` 返回时附带每个候选的 `updatedAt`、`when`、首行摘要与相似缘由（标题近似 / 主题槽相同） | 改造后采纳 | 现在只给 id，调用方（模型）无法判断该合并还是另建。mcp-memory 用置信度解决同一问题；我们不引置信度，改用「人类可读的差异线索」 | P1 | `store.js` `exactDuplicate` / `crossLayerSimilar` / `bindSameTopic` |
| 2.4 | **写入前的注入/外泄扫描**（Hermes 做法）：拦截提示注入模式、凭据外泄模式、不可见 Unicode | 采纳 | 我们的记忆会被 `memory_read` 原样喂回模型，一旦有人把恶意文本写进项目记忆就是持久化提示注入。成本低、收益高；与 README 的 L2「凭据不记」互补（L2 是策略，扫描是兜底） | P1 | `store.js` `assertFits` 附近新增 `scanUnsafe(text)`；`index.js` `memory_save` / `memory_suggest` |
| 2.5 | **不引入写入时的 LLM 归并（add/update/delete 分类器）** | 拒绝 | 我们刻意用「标题 + when + 显式 id」做确定性归并，语义相似不授权覆盖（README/TRIGGERS 已规定）。加 LLM 归并会把可预期行为变成不可预期 | — | — |
| 2.6 | **不做「只追加、永不更新」** | 拒绝 | mem0 的 ADD-only 建立在「检索时能靠向量+实体+时间消歧」上；我们检索是 bigram，追加只会放大噪声。可以借它的**精神**（旧事实不物理删除），不能借它的**结构** | — | — |

---

## 4. Q3｜对话内呈现：层级、文案、来源（颜色/分组/折叠）

### 4.1 行业做法

**claude-mem 的三层渐进披露**（最值得学的一个）：MCP 工具分三层——`search` 只回结果**索引**（约 50–100 token/条）→ `timeline` 回时间线上下文 → `get_observations` 批量取正文（约 500–1000 token/条），官方称整体约 10 倍 token 节省。即：**先给你「有这些」，再给你「什么时候发生」，最后才给你「原文」**。

**Hermes 的 journey / memory-graph**：`/journey`（别名 `/learning`、`/memory-graph`）在 TUI 里开时间线 overlay，桌面端开「Star Map」面板；每个节点有 id（技能名，或 `memory:<source>:<index>:<fingerprint>`），可以**从时间线上直接 prune/correct**。

**Letta**：`/memory` 查看已存内容，`/doctor` 审计放置/重复/token；`/remember` 是显式写入入口——把「写」和「看」分成两条命令，而不是在对话里堆提示。

**mcp-memory-service**：superseded 的记忆默认不出现，但显式查询可见；另有 insight card 作为聚合视图。

**Claude Code**：`/context` 显示**这次到底加载了哪些文件**——这是「来源可见」的另一种形态：不是记忆条目的来源，而是注入事实的来源。

**Codex / ChatGPT**：`/memories` 只做「本对话是否使用/是否贡献」的开关，不做条目级展示。

### 4.2 dsh-lite-memory 现状（代码核对）

- `client.js` 的 `TurnMemory` 已把一轮引用分三组：`found`（`memory-search`）、`provided`（`memory-read`）、`update`（暴露更新），标签为「搜索命中」「读过正文」「本轮更新」，并支持 `noTriggerReason`。
- `store.js` 按会话落 citation：`citationFile(sessionId)`、`citationKey(row)`、`resolveCitation(row)`；`RefSection` 负责渲染区段。
- 缺口：**组内条目没有折叠态摘要**（几条、什么类型），**没有点击来源**（正文/原轮次/excerpt），**没有「旧了」的时间信号**。

### 4.3 对 dsh-lite-memory 的结论

| # | 结论 | 判定 | 理由 | 优先级 | 落点 |
| --- | --- | --- | --- | --- | --- |
| 3.1 | **折叠态一行摘要**：三组各给 `标题 + 条数`，如「搜索命中 2 · 读过正文 1 · 本轮更新 1」，默认收起，展开才列 id/标题 | 采纳 | 现在的分组已经对，但一轮里出现多条时会占掉对话视觉重心。claude-mem 的教训是「索引层要极省」，对话里也一样 | P1 | `client.js` `TurnMemory`、`RefSection` |
| 3.2 | **每条引用带「为什么」**：命中的 run/关键词档位（来自 2.3 的 reasonCode）、`updatedAt` 的人话（「3 天前更新」）、scope（`[global]` 已有） | 采纳 | 视觉上不加颜色，靠**文案密度**区分：命中原因一行、时间一行。DESIGN.md 禁止无数据装饰，这正是「有数据才显示」 | P1 | `client.js` `citationOf` / `citationsOfMeta` / `citationsOfTurn`；`store.js` `resolveCitation` |
| 3.3 | **来源二级：点击引用展开 excerpt 或原轮次** | 改造后采纳 | 我们已有 `sourceExcerpt`（自进化变更）与会话 id，但没有统一「来源」概念。做法：引用卡片展开后显示「来源：本轮你提到的规范（第 N 轮）」或 200 字 excerpt；没有 excerpt 就显示 `memory_read` 的正文前 3 行 | P1 | `store.js` `citationKey`/`resolveCitation` 增字段；`client.js` `RefSection` |
| 3.4 | **零命中不打扰**：只有开启「解释模式」时才显示 `noTriggerReason`；默认静默 | 改造后采纳 | 与低干扰原则一致；但排障时必须能看到，所以做成会话级开关而不是永远隐藏 | P2 | `client.js` `TurnMemory`；`index.js` `recallText` |
| 3.5 | **不引入「记忆命中率/节省 token」之类统计条** | 拒绝 | 无数据支撑的指标会把界面变成仪表盘；DESIGN.md 已禁止假指标 | — | — |
| 3.6 | **不做颜色编码的来源分类** | 拒绝 | 三组已经有文字标签，再加颜色是冗余编码；无障碍与主题适配成本高 | — | — |

---

## 5. Q4｜管理面板 / 图谱 / 宫殿：交互与信息架构

### 5.1 行业做法

| 系统 | 面板形态 | 信息架构要点 |
| --- | --- | --- |
| Zep | Dashboard：**图可视化 + debug 日志 + API 日志** | 把「图」和「这次请求发生了什么」放在同一产品里；Graphiti 开源侧只给框架，运维工具留给 Zep |
| Hermes | TUI overlay + 桌面 Star Map；`hermes journey list` 列节点 id | 时间线是主视图，**节点可 prune/correct**；技能与记忆同图 |
| Letta | `/memory` 看内容，`/doctor` 体检（放置/重复/token） | 「看」与「体检」分离；整理前自动备份仓库 |
| memary | Dashboard：用户偏好、改进速率；「rewind 记忆到某个时点」标注为 coming soon | 想表达「记忆随时间演化」，但把未完成能力先写进产品叙事 |
| claude-mem | Web viewer（Bun worker + HTTP API） | 观察记录 + 摘要 + 时间线，服务「事后复盘」而不是「实时陪聊」 |
| basic-memory | 复用 Obsidian（同一批 Markdown），自身不做图 UI | 把可视化外包给用户已有的工具，降低维护面 |
| Cognee | 强调 `remember/recall/improve/forget` 四个操作 + 会话生命周期 | 以**操作**而非**视图**组织产品 |

### 5.2 对 dsh-lite-memory 的结论

| # | 结论 | 判定 | 理由 | 优先级 | 落点 |
| --- | --- | --- | --- | --- | --- |
| 4.1 | **在「自进化」页签加「结构体检」**：重复标题、全局条目 > 200、无 `when` 的 global、从未被读过的条目、`needsResolution` 未解决数 | 采纳 | Letta `/doctor` 证明「体检」是真实需求；我们已有全部数据（`suppressionOf`、`prunedReceipts`、`lastUsed`、`needsResolution`），只差一个视图 | P1 | `client.js` `MemoryPanel` 的 `switchBar`/tabs；数据侧复用 `store.js` 的 `forgottenFingerprints`、`pruneSuggestions`、`usedStale` |
| 4.2 | **冲突队列**：把未解决的 `needsResolution` 列成待办，一键「合并 / 另建 / 忽略」 | 采纳 | 冲突现在是同步阻塞在写入调用里，用户离开那一轮就丢了上下文。队列化后可在面板里批量处理 | P1 | `store.js` 待处理集合；`index.js` `memory_save` 写入后返回 `pendingConflicts` 计数 |
| 4.3 | **图谱节点点击 = 过滤列表**（保持单一归属不变式），节点详情显示有效期/最后使用/取代链 | 改造后采纳 | 我们图谱是确定性布局、只画真实数据，这已经比力导向图克制；补「点节点过滤列表」让图成为导航而不是装饰 | P2 | `client.js` `MemoryGraph`、`graphViewOf`、`filterRecords`、`projectionOf` |
| 4.4 | **时间线视图只在有「冲突/过期/取代」时出现** | 改造后采纳 | Hermes 的 journey 是全局时间线，但我们没有那么多事件；按需出现避免空视图 | P2 | `client.js` `MemoryPalace` 的分层逻辑（`palaceRoomsOf`/`palaceRoomPageOf`）可复用为时间分页 |
| 4.5 | **不扩宫殿为 3D / 不做自由布局图** | 拒绝 | DESIGN.md 已规定确定性布局、真实数据；3D 与力导向都无法保证可复现快照，测试也失去 seam | — | — |
| 4.6 | **不做改进速率/记忆增长曲线** | 拒绝 | memary 的「改进速率」需要基线定义，我们无法给出可信口径；宁缺 | — | — |

---

## 6. Q5｜原子写、锁、损坏恢复、迁移、降级

### 6.1 行业做法

| 系统 | 一致性/持久化 | 损坏与迁移 | 降级 |
| --- | --- | --- | --- |
| Letta / MemFS | 每次编辑 commit 到 git；整理前备份仓库；「已保存 vs 未提交」边界清晰 | git 天然可回滚；云端仓库按快照计费 | 本地 runtime 无需账号；语义检索要另装 mod + QMD，默认只有文件搜索 |
| Hermes | **单写者告警**：「两个 agent 进程不要指向同一个 Hermes home」，否则写入会互相叠加出谁都没写过的状态；批量操作只在批末校验限额 | 会话搜索 FTS5（约 20ms 查询）；记忆是冻结快照，写后要新会话才生效 | `memory.memory_enabled=false` 直接摘掉工具；`write_approval` 让写入进待批队列 |
| Codex | 后台生成等会话空闲，避免总结进行中的工作 | 记忆文件视为**生成态**，不建议手改；`~/.codex/memories/` 可检查 | 额度低于阈值跳过生成；`disable_on_external_context`；按会话 `/memories` 开关；`extract_model`/`consolidation_model` 可换模型 |
| claude-mem | SQLite + Chroma + 常驻 worker | 设置文件 `~/.claude-mem/settings.json`；hook 生命周期 | 模式（`code`/`code--zh`/`code--ja`）与 `CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES` 可调 |
| mcp-memory-service | SQLite + 本地 ONNX；**定时备份**；delta-sync；JSON 导入导出（含 mem0 导出格式） | 版本升级路径明确 | 混合检索有回退级联（精确 + 标签） |
| mem0 | 云端/自托管；v2→v3 有专门迁移文档 | 迁移文档是产品的一部分 | — |
| Graphiti | 自带图库（Neo4j/FalkorDB/Neptune）；参考 MCP/REST 服务器**明说不做鉴权与注入防护**，不可暴露公网 | 增量构图，无需批重算 | 低并发默认值 + 429 处理建议 |

### 6.2 dsh-lite-memory 现状（已很强，不要重造）

已在代码里核实的强项：`writeDurable` / `publish` / `fsyncDir` / `writeAtomic` 的落盘链路；`withLock` / `withLocks` / `transactWithRetry` 的锁与重试；`checksumOf` + `readEnvelope` + `state.prev.json` 的校验与上一版；`migrationIntentFile` / `purgeIntentFile` / `moveIntentFile` 的意图文件；`isolateCold` / `restoreCold` / `dropColdQuarantine` / `cleanColdQuarantine` 的冷正文隔离；`pruneSessions` 的会话清理；`pruneSuppressions` / `pruneReceipts` 的过期清理。**这些比多数竞品更细。**

### 6.3 对 dsh-lite-memory 的结论

| # | 结论 | 判定 | 理由 | 优先级 | 落点 |
| --- | --- | --- | --- | --- | --- |
| 5.1 | **迁移「预演 + 校验 + 自动回退」做成用户可见流程**：`--dry-run` 报告将迁移多少条、多少字节、可能丢什么；迁移后校验 checksum，失败自动用 `state.prev.json` 回退并留 intent 供排查 | 改造后采纳 | 意图文件与 prev 校验已经有了，但用户侧只能「相信它」。Codex/mem0 把迁移当产品文档对待，我们需要把同样的确定性暴露出来 | P1 | `state.js` `publish` / `readEnvelope` / `migrationIntentFile`；`index.js` 管理路由（HTTP 侧约 150–620 行已有若干 400 分支） |
| 5.2 | **锁的可观测性**：state 里记录锁持有者（pid/会话）、等待时长、最近一次重试次数；`withLocks` 超时时的错误文案写明「另一个 DSH 进程正在写入，请稍后重试或关闭重复实例」 | 改造后采纳 | Hermes 的单写者坑我们有锁兜住，但没有**说人话的错误**。这是纯增量 | P1 | `store.js` `withLock`/`withLocks`/`transactWithRetry`；`state.js` `lockFile` |
| 5.3 | **空闲门控的后台维护**：`expireLearning`（trial 过期）等维护任务只在「会话空闲 + 距上次维护超过阈值 + 用户未禁用」时跑，并记录本轮维护摘要 | 采纳 | 直接对应 Codex 的 idle-gated + rate-limit-gated 思路；我们现在有 TTL 但没有调度语义，容易被误解为「后台偷偷改东西」 | P1 | `store.js` `expireLearning`（约 3451 行）；`index.js` `agent/pre-step` 钩子 |
| 5.4 | **降级开关集中化**：一组配置项（禁用自动建议 / 禁用自动回忆 / 禁用后台维护 / 只读模式），面板可见当前状态 | 采纳 | 对标 Codex `memories.*` 与 Hermes `memory_enabled`。出问题时的第一反应是「先关掉」，没有开关就只能删文件 | P2 | `index.js` 插件配置；`client.js` 面板头部 |
| 5.5 | **不做 git-per-edit、不引外部向量库/图库、不做云同步** | 拒绝 | 我们是单机插件，落盘链路已自足；引入 git 或外部服务会把「零依赖、离线可用」这个核心优势换掉 | — | — |

---

## 7. 逐项目事实卡（便于后续复核）

### 7.1 mem0 — <https://github.com/mem0ai/mem0>
- 新记忆算法（README 标注 April 2026）：单趟 **ADD-only** 抽取、一次 LLM 调用、**无 UPDATE/DELETE**、记忆累积不覆盖；agent 生成的事实为一等公民；实体链接；多信号检索（语义 + BM25 + 实体）；时间推理。
- README 自报基准：LoCoMo 92.5、LongMemEval 94.4、BEAM(1M) 64.1、BEAM(10M) 48.6（**厂商自报，未独立复现**）。
- 从 v2 到 v3 有专门迁移文档 <https://docs.mem0.ai/migration/oss-v2-to-v3>；旧版 ADD/UPDATE/DELETE/NO CHANGE 提示词仍在仓库 `mem0/configs/prompts.py`。
- 对我们的意义：证明「写入侧少做决策、检索侧多做消歧」是一条可扩展路线；但我们检索能力弱，不能照搬。

### 7.2 Letta / MemFS — <https://docs.letta.com/agent-sdk/memory/>、<https://docs.letta.com/concepts/memfs/>
- 记忆是**有 git 历史的仓库**（MemFS），投影到本机目录；每次编辑 commit，获得版本历史与冲突解决。
- 记忆**根目录文件每轮进 system prompt**；带 `MEMORY.md` 的子目录不进上下文，只给文件树当 signpost（「目录名即路标」）。
- 默认**没有**语义/向量索引：靠普通文件搜索；要语义检索得装 `memfs-search` mod 并用 QMD 建索引。
- 会话历史检索与 MemFS 分离：云端支持 full-text/vector/hybrid，本地只有全文。
- dreaming（sleep-time compute）：`trigger` = `off` / `step-count`（可配步数）/ `compaction-event`；`behavior` = `reminder` / `auto-launch`；`/sleeptime`、`/init`、`/remember`、`/memory`、`/doctor` 是配套命令。云端仓库 5 MiB（Free）/50 MiB（Pro）。
- 对我们的意义：`/doctor` 与「索引常驻 + 目录 signpost」两项最值得借；git 仓库不适合我们。

### 7.3 LangMem — <https://github.com/langchain-ai/langmem>
- 两种接入：**热路径**（记忆直接拼进 prompt，模型不必主动搜）与工具式（`create_search_memory_tool` / `create_manage_memory_tool`），底层是 LangGraph `BaseStore`（示例用 `InMemoryStore`，生产建议 Postgres 版）。
- 另有后台 memory manager 负责抽取、整合、更新（非热路径）。
- 对我们的意义：它把「注入」与「工具检索」做成同一套 API 的两种策略，正好对应我们的取舍问题；我们的答案是「工具为主 + 自动命中标题」。

### 7.4 basic-memory — <https://github.com/basicmachines-co/basic-memory>
- 本地优先：Markdown 文件 + wikilink 知识图 + SQLite 索引；MCP 服务器；与 Obsidian 读写同一批文件；云端可选（$15/月，Tigris S3），AGPL-3.0。
- 卖点里最工程化的一条：**渐进式工具发现**——每个工具带 read-only / destructive / idempotent 行为提示，让 agent 不必试错就选对工具。
- 对我们的意义：工具描述里的「行为提示」是低成本高收益的写法，可直接借到 `memory_save` / `memory_forget` 的描述里（明确 destructive）。

### 7.5 claude-mem — <https://github.com/thedotmack/claude-mem>
- 通过 Claude Code 生命周期 hook（SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / SessionEnd，命令形如 `claude-mem hook claude-code <event>`）采集；Bun worker + HTTP API + web viewer；SQLite（sessions/observations/summaries）+ Chroma 混合检索。
- **3 层 MCP 工作流**：`search`（约 50–100 token/条索引）→ `timeline`（时间顺序上下文）→ `get_observations`（约 500–1000 token/条，支持批量 id），官方称整体约 10 倍 token 节省。
- 设置 `~/.claude-mem/settings.json`；模式 `code` / `code--zh` / `code--ja`；`CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES` 控制会话开始注入哪些来源。
- 对我们的意义：三层披露的**顺序**可以直接映射到我们的「标题 → 时间/来源 → 正文」；也提醒我们「会话开始注入什么」是个产品开关。

### 7.6 mcp-memory-service — <https://github.com/doobidoo/mcp-memory-service>
- 混合检索：向量 + BM25；`mode="ranked"` 按新近度/访问频次/质量加权；回退级联（精确 + 标签）；标签 AND/OR、自然语言时间范围、存储分区。
- `summarize=true` 时返回带**已验证来源引用**的摘要；文档摄取；Claude Code hooks + `memory_harvest` 从 transcript 采集。
- 自主整合（聚类/压缩/关联/**受控遗忘**）+ 洞察卡；**belief 带置信度 + 启发式矛盾检测**，旧的标 superseded（默认隐藏、显式可取）。
- `get_bootstrap_profile`：token 预算内的行为上下文（**不按项目隔离**，这是它的局限，反而印证我们的 project scope 设计）。
- 本地 ONNX + SQLite；delta-sync；JSON 导入导出（含 mem0 格式）；定时备份；整合有定时任务（其指南里可见调度状态与 02:00 运行示例）。
- 对我们的意义：superseded 语义与「洞察卡」的聚合视图最值得借；它的规模（几十个工具）也提醒我们不要膨胀工具面。

### 7.7 OpenMemory — <https://github.com/mem0ai/openmemory>
- 现在的定位是**会话可移植性 CLI**：`openmemory tui`；`openmemory port --from --to --all|--id`，`--force`、`--json`；跨 harness 双向导入导出、先预览后写；路线图包含 port Skills / MCPs / Plugins / CLAUDE.md / AGENTS.md、autosync、支持 OpenClaw 与 Hermes。
- 注意：旧版「私有本地 MCP 记忆服务」仍在 `mem0ai/mem0` 的 `openmemory/` 目录里，**两者不能混为一谈**。
- 对我们的意义：说明「记忆在多个 agent 之间搬家」正在成为独立需求；我们至少要让导出格式稳定、可读（已有 JSON 导出则记一笔，没有则不新增）。

### 7.8 Cognee — <https://github.com/topoteretes/cognee>、<https://docs.cognee.ai/core-concepts/main-operations/remember>
- 把记忆操作收敛成四个动词：`remember` / `recall` / `improve` / `forget`（`remember` 可带 session id 写会话级记忆）。
- 文本进图（实体、关系、可检索 chunk），代码进「符号与依赖图」；会话蒸馏把被接受的教训提升为长期记忆；图 + 向量 + 关系三库并存。
- 对我们的意义：**动词化 API** 比「一堆名词概念」好学；我们的五个工具已经是这个方向，可以把「improve」对应到自进化。

### 7.9 Graphiti / Zep — <https://github.com/getzep/graphiti>、<https://arxiv.org/abs/2501.13956>
- context graph = 实体（摘要随时间演化）+ 事实/关系（带有效期窗口）+ **episode（原始数据，一切派生物的溯源）** + 可选自定义本体。
- 信息变化时**旧事实失效而不删除**，可查「现在为真」或「某时点为真」；混合检索（embedding + BM25 + 图遍历），不依赖 LLM 摘要；增量构图，无需批重算。
- 开源侧是框架：图库自带（Neo4j/FalkorDB/Neptune）；参考 MCP/REST 服务器**明确无鉴权、无注入防护，不得暴露公网**。Zep 侧提供 Dashboard（图可视化、debug 日志、API 日志）与亚 200ms 检索宣称（厂商口径）。
- 对我们的意义：有效期与 provenance 是这轮研究里最硬的结论（→ 2.1/2.2/3.3）；但整套图架构超出插件体量，只取字段语义。

### 7.10 Memary — <https://github.com/kingjulio8238/Memary>
- 组成：memory stream + 实体知识图 + routing agent；递归检索（先取查询中的关键实体，建深度 2 的子图，再拼上下文），多实体时多跳合并子图以降低延迟。
- 记忆压缩；「新的上下文窗口」= agent 回复 + 关键分类实体/主题；dashboard 展示用户偏好与「改进速率」；rewind（回到某时点的记忆）标为 coming soon。
- 对我们的意义：递归子图检索是「小上下文、高相关」的另一条路，可用于将来的图谱检索；「改进速率」是不可信指标，明确不抄。

### 7.11 Claude Code — <https://code.claude.com/docs/en/memory>
- 两套互补系统，**都在会话开始加载**，官方定性为「上下文而非强制配置」。
- CLAUDE.md 顺序：企业策略 → 用户 `~/.claude/CLAUDE.md` → 项目 `./CLAUDE.md` → 本地；`.claude/rules/` 支持按路径生效的 frontmatter；`AGENTS.md` 可作回退。
- 自动记忆默认开启：每仓库 `~/.claude/projects/<project>/memory/`，`MEMORY.md` 当索引 + 每主题一个文件，frontmatter `type` ∈ {user, feedback, project, reference}；加载「前 200 行或 25KB」；**跳过能从代码库推导的与已在 CLAUDE.md 里的**；不会每次会话都写。
- `/memory` 里可开关（`autoMemoryEnabled`），`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 可整体禁用；`/compact` 后项目 CLAUDE.md 会重新注入；`/context` 显示实际加载了哪些文件。
- 对我们的意义：**「跳过可推导内容」这条判据**应该写进我们的建议写入规则；`/context` 式「这次加载了什么」正是 1.2/1.3 要补的可解释性。

### 7.12 Codex — <https://learn.chatgpt.com/docs/customization/memories>、<https://learn.chatgpt.com/docs/agent-configuration/agents-md>
- AGENTS.md：运行前读一次；顺序为全局 `~/.codex/AGENTS.override.md` 或 `AGENTS.md`（取第一个非空）→ 从项目根逐级向下到 cwd（每目录先 `AGENTS.override.md` 再 `AGENTS.md`，再 `project_doc_fallback_filenames`），**每目录最多一个文件**，根→下拼接、后者覆盖前者；默认上限 `project_doc_max_bytes` 32 KiB；配置在 `~/.codex/config.toml`。
- Memories：**默认关闭**；开启后把「合格的过往对话」变成 `~/.codex/memories/` 下的本地记忆文件（摘要、持久条目、近期输入、支撑证据）；**跳过进行中或短命会话**；对生成字段做敏感信息脱敏；**在后台更新**而非每次对话结束立刻更新；**等会话空闲足够久**才动手；剩余额度低于 `memories.min_rate_limit_remaining_percent` 就跳过本轮生成。
- 配置项：`memories.generate_memories`、`memories.use_memories`、`memories.disable_on_external_context`（旧名 `no_memories_if_mcp_or_web_search`）、`memories.extract_model`、`memories.consolidation_model`；`/memories` 按会话控制「使用/贡献」；桌面端 `Settings > Personalization` 有 Enable/Delete。
- 官方明确建议：**必须始终生效的团队规则放 AGENTS.md，不要只靠记忆**。这句话对我们的产品叙事极有用：记忆是回忆层，不是规则层。
- 对我们的意义：Q1 的三道闸、Q5 的降级与后台调度，几乎可以逐条翻译成我们的配置项与 `agent/pre-step` 门控。

### 7.13 Hermes — <https://github.com/NousResearch/hermes-agent>、<https://hermes-agent.nousresearch.com/docs/user-guide/features/memory>
- 自述「闭环学习」：agent 自管记忆 + 周期性提醒（nudges）、自主创建技能、技能自我改进、FTS5 会话搜索 + LLM 摘要、Honcho 对话式用户建模。
- 记忆实现：MEMORY.md（2200 字符 ≈ 800 token，agent 个人笔记）+ USER.md（1375 字符 ≈ 500 token，用户画像），存 `~/.hermes/memories/`，**会话开始时冻结进 system prompt**，表头显示占用百分比与字符数，条目以 `§` 分隔。
- `memory` 工具：`add` / `patch`（替换片段保留其余）/ `remove`（子串匹配），无 `read`（内容已在 prompt 里）；每批一个 `target`（`memory` 或 `user`）；**超限报错不静默丢**，错误里说明差多少字符、附 `closest_entries`；精确重复拒绝；>80% 建议先整合；写入前做注入/外泄扫描与不可见 Unicode 拦截。
- 运维：`memory.memory_enabled=false` 摘工具；`write_approval: true` + `/memory pending` + `/memory approve all`；记忆按 profile 隔离，文档明确警告**不要两个进程共用一个 home**；写后要新会话才在 prompt 生效（冻结快照）。
- 可视化：`/journey`（别名 `/learning`、`/memory-graph`）TUI overlay，桌面端「Star Map」；`hermes journey list` 列节点 id `memory:<source>:<index>:<fingerprint>`，可从时间线 prune/correct。
- 外部 provider（Hindsight、Mem0、Honcho 等）与内置记忆并存，可只保留用户画像块。
- 对我们的意义：容量预算、冻结快照、写入扫描、待批队列、时间线纠错——五个可直接落地的点。

---

## 8. 差异矩阵（我方 vs 主流）

| 维度 | 主流做法 | dsh-lite-memory | 判定 |
| --- | --- | --- | --- |
| 注入时机 | 会话开始常驻索引（Claude Code/Codex/Hermes/Letta） | 仅重叠时暴露 ≤3 条标题 | **保留**（差异化），补预算可观测 |
| 注入内容 | 索引 + 摘要 | 标题 + id，正文按需 `memory_read` | 保留，已是最省 |
| 写入归并 | LLM 分类（mem0 旧版）或只追加（mem0 v3） | 标题+when+id 确定性归并 | 保留（可预期），补取代链 |
| 冲突 | 置信度/矛盾检测自动 superseded | `needsResolution` 阻断 + 候选 id | **补**：候选解释 + 待办队列 |
| 有效期 | 双时态窗口（Graphiti） | 无（只有建议/抑制 TTL） | **P0 补最小字段** |
| 删除 | 失效不删（Graphiti/mem0） | 归档不删 | 已对齐，补 superseded 语义 |
| 溯源 | episode（Graphiti）、3 层披露（claude-mem） | 会话 citation + `sourceExcerpt` | **P1 补二级来源** |
| 检索 | 语义+BM25+图（多数） | bigram 重叠 + 标题/标签 | 保留（零依赖），明确不做向量库 |
| 面板 | 图+日志（Zep）、时间线+纠错（Hermes）、体检（Letta） | 列表/图 + 自进化页签 | **P1 补体检与冲突队列** |
| 一致性 | git（Letta）、锁+单写者告警（Hermes） | 原子写+fsync+锁+校验和+prev | **已领先**，补锁可观测与迁移预演 |
| 降级 | 配置项 + 按会话开关（Codex） | 无集中开关 | **P2 补** |
| 后台任务 | 空闲/额度门控（Codex）、定时整合（mcp-memory） | TTL 过期逻辑但无调度语义 | **P1 补空闲门控** |

---

## 9. 行动表（唯一的执行清单）

### P0（本轮就该做，改动集中在 store/index）

| ID | 动作 | 文件 / 函数 | 验收 |
| --- | --- | --- | --- |
| P0-1 | 记录增加 `validFrom` / `validUntil` / `supersededBy` / `supersedeReason` 四个可选字段；`findCurrent` 增加「未被取代且未过期」过滤；`memory_search history:true` 能取回被取代项并标注 | `store.js` `toFlat` / `fromFlat` / `applyFlat` / `findCurrent` / `archiveEntry` | 旧数据无字段仍可读；新增字段进 checksum；归档项仍可见于 history |
| P0-2 | `memory_save` 支持 `supersedes: <id>`：写新记录、给旧记录打 `supersededBy` + `validUntil`、`versions` 保留旧正文 | `store.js` `upsertLocked` / `snapshot`；`index.js` `memory_save`（约 1544 行） | 一次调用后旧 id 在默认检索消失、在 history 出现；撤销能把两者都回滚 |
| P0-3 | 自动回忆可解释：`recallText` 返回 `reasonCode`（`no_overlap` / `budget` / `session_disabled` / `hit`）、`chars`、`limit`，并写入会话 receipts | `index.js` `recallText`（约 1510 行）、`RECALL_QUERY_CHARS`（809 行）；`store.js` `scoreQuery`、`citationKey` | 面板/日志能回答「为什么这次没提醒我」；不改变注入文本 |

### P1（下一轮）

| ID | 动作 | 文件 / 函数 |
| --- | --- | --- |
| P1-1 | 引用折叠摘要 + 展开来源（excerpt / 原轮次 / 「N 天前更新」） | `client.js` `TurnMemory`、`RefSection`、`citationOf` |
| P1-2 | 冲突候选带解释（`updatedAt`/`when`/首行摘要/相似缘由），未解决项进面板待办队列 | `store.js` `exactDuplicate` / `crossLayerSimilar` / `bindSameTopic`；`client.js` `MemoryPanel` |
| P1-3 | 结构体检视图（重复标题、global>200、无 when 的 global、从未读过、冲突数） | `client.js` `MemoryPanel` 自进化页签；复用 `usedStale` / `forgottenFingerprints` |
| P1-4 | 写入前注入/外泄扫描 + 不可见 Unicode 拦截 | `store.js` `assertFits` 旁新增 `scanUnsafe`；`index.js` `memory_save` / `memory_suggest` |
| P1-5 | 空闲门控的后台维护（`expireLearning` 等）+ 维护摘要可见 | `store.js` `expireLearning`（约 3451 行）；`index.js` `agent/pre-step` |
| P1-6 | 迁移预演 + 校验失败自动回退 | `state.js` `publish` / `readEnvelope` / `migrationIntentFile` |
| P1-7 | 锁可观测性 + 说人话的锁冲突错误 | `store.js` `withLock` / `withLocks` / `transactWithRetry`；`state.js` `lockFile` |

### P2（有余力再做）

| ID | 动作 | 文件 / 函数 |
| --- | --- | --- |
| P2-1 | 会话级「本轮不回忆 / 不打扰」开关 | `index.js` `recallText`；`client.js` header utilities 槽 |
| P2-2 | 降级开关集中化（禁用自动建议/自动回忆/后台维护/只读） | 插件配置 + `client.js` 面板头部 |
| P2-3 | 图谱节点点击过滤列表 + 节点详情（有效期/最后使用/取代链） | `client.js` `MemoryGraph` / `graphViewOf` / `filterRecords` |
| P2-4 | 时间线视图（仅在有冲突/过期/取代时出现） | `client.js` `MemoryPalace` 分页函数复用 |
| P2-5 | 工具描述加行为提示（read-only / destructive / idempotent），明确 `memory_forget` 是归档 | `index.js` 五个工具的 `description` |

---

## 10. 明确不采纳（附理由，避免以后重复讨论）

| 不采纳 | 来源 | 理由 |
| --- | --- | --- |
| 会话开始把记忆索引常驻 system prompt | Claude Code / Hermes / Letta | 与「不站岗」契约冲突；前缀缓存与预算不可控；一旦常驻，模型会把记忆当规则 |
| 每轮注入 / 每轮后台抽取 | mem0 旧版、LangMem 热路径 | 延迟与成本不可接受；我们的触发是「显式要求」或「真实重叠」 |
| 双时态图 / 每条事实一张图 | Graphiti / Zep | 体量与运维面远超插件；只取「有效期 + 取代链」字段语义 |
| 外部向量库 / 图数据库 / 云同步 | mem0 / Cognee / Zep / basic-memory 云版 | 破坏零依赖、离线优先；bigram + 标题检索在我们的量级够用，且行为可预期 |
| 写入时 LLM 归并分类 | mem0 旧版 | 把可预期归并变成不可预期；与「相似不授权覆盖」冲突 |
| ADD-only 永不更新 | mem0 v3 | 建立在强检索消歧之上；我们没有向量/实体，追加只会放大噪声 |
| 自由布局图 / 3D 宫殿 / 仪表盘指标 | Memary / 多数 SaaS | 不可复现、测试无 seam、无数据支撑，违反 DESIGN.md 的确定性布局与「只画真实数据」 |
| 每次编辑 git commit | Letta MemFS | 需要仓库与远端；我们的 intent + prev + checksum 已覆盖恢复需求 |
| 「改进速率/命中率/节省 token」统计 | memary / claude-mem 宣传口径 | 无基线定义，属假指标 |
| 把记忆当强制规则 | 所有常驻派（Codex 官方反而明确反对） | 官方建议始终生效的规则放 AGENTS.md；记忆是回忆层 |

---

## 11. 开放问题（需要实测或后续确认）

1. **mem0 v3 的「单趟 ADD-only」在长会话里的召回精度**：README 报的是厂商自测分，没有第三方复现；在我们这个「≤3 条标题」的量级上是否仍成立，未知。不影响本轮结论（我们不采纳其结构），但影响未来是否重估检索方案。
2. **Graphiti 有效期窗口的实现细节**（如何判定「被取代」、边失效的具体算法）：本轮只读文档语义，未读源码；若要照抄字段语义，需再核一次实现。
3. **Codex 记忆文件的内部格式**（`~/.codex/memories/` 下摘要 / durable entries / 支撑证据的组织方式）：官方文档只到「包含这些类别」的粒度；若要做导出兼容，需实测。
4. **claude-mem 的 token 数字**（50–100 / 500–1000 / 10x）出自其 README 口径，未独立测量；用作「分层披露更省」的方向性证据，不作为精确预算依据。
5. **Zep 的「亚 200ms」** 为厂商宣称，未验证。
6. **Hermes 的 nudge 频率**（「周期性提醒」的具体触发条件）文档未给定值；我们自己的 L1 建议已有 48 小时/每会话一次的上限，不必对齐。
7. **面板视觉规范**（配色、间距、折叠动画时长）本轮未采集竞品截图做对照：Q3/Q4 的结论只到「信息架构」层，视觉层仍以本仓库 `DESIGN.md` 为唯一依据。
