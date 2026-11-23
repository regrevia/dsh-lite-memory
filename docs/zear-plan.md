# ZEAR 开发方案（据本仓库实测改写）

口径：2026-11-23 / main @ b68e21d，macOS arm64，Node v24.16.0。
本文件替换此前外部方案里的 Phase 0–6 排序。原文给出的文件名、SQLite 表、排名权重都是**建议结构**，与当前代码不符；下面是审计后的真实结论。

## 0. 一句话结论

当前瓶颈不是「缺一个检索算法」，而是**既有的精度闸门在中文上根本没生效**。
先把这道闸门修对（改动量约 20 行、不加模块），再谈 BM25 / 关系 / 自适应。
在 50–60 条活跃记忆的规模上增加 SQLite、FTS5、索引服务，没有任何实测依据，暂不引入。

## 1. Phase 0 审计结果（已完成，非计划）

| 原方案假设 | 实测 |
| --- | --- |
| `view.js` 是记忆展示 | `view.js:599 rank()` 就是召回器；`matchScore` 在 `:425`，`MATCH_FLOOR 2.4` 在 `:588` |
| `store.js` 管数据模型 | `store.js:90 toFlat()` 是唯一展平口径；存储事实来源是 `<root>/<scope>/state.json` 的 `payload.entries` |
| 存在独立索引 / FTS | **不存在**。每次查询现算词表：`view.js:608` 的 `corpus = {df, total}`，只在这批候选内统计 |
| 是否用 Embedding | 没有。`package.json` 零 `dependencies` / `peerDependencies` / `optionalDependencies` |
| 是否每轮调 LLM | 没有。召回全程确定性函数 |
| 需要 FTS5 提升中文 | FTS5 可开（`node:sqlite` 在 Node 24 内置，`DatabaseSync` 可用），但 `unicode61` 对中文**不切词**：`MATCH '认证'` 命中 0，整句 `MATCH '"认证模块重构"'` 才命中 1 |
| 需要外部中文分词 | 不需要，但也不能直接信 ICU（见 §2） |
| Context Gateway 是待开发项 | **已实现**。`index.js:2194` 走 `view.selectContextBundle`；卡片上限、字节账本、`dropped` 计数、`recallHeader` 计费都在 `index.js:1832` 之后 |
| 多轮检索待开发 | `index.js:1903` 已有第二轮（`requireApplicable:false`、`limit:8`），但**只用于解释「为什么没提醒」**，不参与注入 |

回收站式结论：Phase 1 的索引层、Phase 5 的网关，按原方案做等于重复造已有的东西或提前优化不存在的瓶颈。

## 2. 真正的缺陷：中文实词被切碎 → 精度闸门失效

`view.js:377 contentWordsOf()` 用 `Intl.Segmenter('zh',{granularity:'word'})` 且只留 `length >= 2` 的词元。本机 ICU 的实际输出：

```
认证模块重构        -> 认证 | 模 | 块 | 重 | 构        （≥2 字实词：1 个）
打印机卡纸了怎么处理 -> 打印 | 机 | 卡 | 纸 | 了 | 怎么 | 处理
为什么之前放弃 Redux -> 为什么 | 之前 | 放弃 | Redux
```

后果链条（都在 `matchScore` 内）：

1. `:490 distinctContent` 只收到 ≤1 个实词；
2. `:510 enoughContent = distinctContent.length < 2 || matchedContent >= 2` —— 实词不足 2 个时**恒为 true**；
3. 于是 `:522` 的 `if (!enoughContent && !strongRun && !rareTitleHit) { keywordWords.clear(); titleWords.clear(); }` 这道闸门几乎不会触发；
4. 单个共享词（「打印」「超时」「数据」）就能把分数顶过 `2.4`。

这不是「阈值该调」，是**判据拿不到它要判的东西**。此前记录的 7 条具名误注入（`docs/BENCH.md`、`bench/recall-300.mjs`）全部是这条链的产物。

## 3. 反事实实验（已跑，未提交代码）

把 `view.js:522–525` 那段闸门整体删掉，其余不动，用现有两套样本量：

| 指标 | 现状 b68e21d | 去掉闸门 | 变化 |
| --- | --- | --- | --- |
| 硬样本 Recall@3（120 条） | 101/120 = 84.17% | 114/120 = 95.0%（CI 89.5–97.7） | +10.8 pt |
| 硬样本 MRR@3 | 0.8375 | 0.9194 | +0.082 |
| 误注入率（80 条该拒绝） | 7/80 = 8.75% | 9/80 = 11.25%（CI 6.0–20.0） | 变差 2 条 |
| 更新准确率（30 条） | 66.7% | 96.7% | +30 pt |
| 跨项目泄漏 | 0/30 | 0/30 | 不变 |
| 弃权准确率 | 1.0 | 1.0 | 不变 |
| 失败总数 | 36 | 16 | −20 |
| 冻结 39 条 Recall@3 / MRR@3 | 1.000 / 0.929 | 1.000 / 0.964 | 不退化 |
| P50 / P95 | 2.7 / 3.3 ms | 2.96 / 3.88 ms | 同一量级 |

两个方向都读得出来：

- 闸门确实在拦东西，但拦错的比例很高（删掉它净赚 18 条失败）；
- 它的判据是坏的：有 2 条误注入反而因为闸门失效而更早出现，说明现在的「保留」与「放行」几乎是随机的。

所以**不要**现在删掉闸门（误注入会升），也**不要**调 `MATCH_FLOOR`（会拿真命中换误注入）。要做的是把 `distinctContent` 换成中文上真实可用的实词判据。

## 4. 排期（替换原 10 周）

原则不变且更硬：**先证明有效，再加架构**。每一阶段有独立的放行闸门，不过闸不进入下一阶段。

### A · 修判据（1–2 天，唯一立刻该做的）

- 目标：让 `contentWordsOf` 在中文上返回真实实词数。
- 做法（二选一，按实测选）：
  1. 在 `wordsOf` 的 bigram 分支上补「相邻单字重组」：ICU 给出连续单字时按 `wordIn` 落在记录里的二/三字组合并回实词；
  2. `distinctContent` 直接在字符二元组上算，`matchedContent` 用 `wholeText` 的 bigram 命中数。
- **不许动**：`MATCH_FLOOR`、`WEIGHT`、冻结的 39 条、`LIMITS.stateBytes`。
- 验收：硬样本 Recall@3 ≥ 95% 且误注入 ≤ 7/80 且冻结 39 条仍 1.000 / 未知条件投递仍为 0；P95 ≤ 5 ms。四条同时满足才算过。
- 出测试的方式：先在 `bench/recall-300.mjs` 上量，再补 `test/` 里一条把「打印机卡纸」这类查询钉成负例的断言，最后才改 `view.js`。

### B · 字符级证据（2–3 天）

- 只在 A 的验收没全过时做。用 `longestRun` 的字符级重合当补充证据，替代部分 bigram 噪声。
- 不新增文件；仍在 `view.js` 内。
- 验收同 A。

### C · Alias / 关系（需要时）

- 前提：A（或 B）过了闸门，且**仍有 ≥10 条具名失败**属于「换说法不认」。
- 现状：`LINK_TYPES = ['related']` 只有一种关系，`linksOf` + 融合路（`view.js:685–697`）已经在扩一跳邻居，但只对 `sameTask` 或 `global` 目标生效。
- 若要做，先扩的是**这条已有路的可用性**，不是新造 `entity-store.js` / `relation-store.js` / 七种谓词。原方案的 7 种关系类型属于新分类体系，未放行。

### D · 自适应多轮（需要时）

- 前提：C 之后仍有系统性低词面重合失败，且 A/B/C 的 P95 未超 5 ms。
- 约束：`index.js:1903` 的第二轮现在只用于解释，不许直接改成注入；要改必须同时给出「第二轮注入带来的误注入增量」数字。

### E · 索引投影（暂不做）

- 触发条件（任一）：单层活跃记忆 > 1000、纯召回 P95 > 20 ms、或需要跨进程并发读。
- 形态：JSON 仍是事实来源，索引是**可重建**的派生投影；用 `node:sqlite`（内置，零依赖），中文列预先切成 bigram 存，不要指望 `unicode61`。
- 现在的数字离触发线很远：50–53 条活跃时外部工具单查询 14 ms / 3 ms（含读盘与展平），进程内纯召回 P50 2.7 ms。

### F · 跨 Agent（仍待放行）

- 见 `docs/lite-memory-share.md`。MCP 服务与 `bin` CLI 属于「扩框架」，未放行前只出文档。

## 5. 对原方案的具体删除项

| 原方案 | 处置 | 理由 |
| --- | --- | --- |
| SQLite + FTS5 + `memory_terms` / `memory_aliases` 表 | 推迟到 E | 规模不到触发线；先加索引等于给未验证的瓶颈上工程 |
| `S = 0.40T + 0.25S + 0.25G + 0.10B` 等权重 | 不做 | 现有 `WEIGHT` 已经过 300 条样本标定；再叠一层权重就是调参 |
| `interface StructuredMemory` 的 `type` 六分类、`relations` 七谓词 | 不放行 | 新分类体系，与项目约束冲突；先证明需要 |
| `RecallFeedback` 四种 outcome + `index_version` | 不放行 | 现有 `receipts` / `suppressions` / `topicKey` 已覆盖相当部分；新增前先证明现结构表达不了 |
| `searchMemories` / `admitMemories` 双接口 | 已存在等价物 | `recallRank`（排序）与 `selectContextBundle`（准入）就是这两件事 |
| 1000 条记忆 / 3000 条查询的 ZEAR Benchmark v1 | 推迟 | 75 条记忆下的具名失败还没清零，先扩数据集会让比例好看、问题变模糊 |
| 五组消融 A–E | 保留骨架，改内容 | A 改为「修判据前/后」，B 改为「字符级证据」，其余按 §4 顺序触发 |
| 论文目录 `docs/research/*` | 推迟 | 在拿到 A 的前后对比数字之前，文献综述不产生决策 |

## 6. 指标口径（不许混用）

- 硬样本：`bench/recall-300.mjs`，75 条记忆 / 300 条查询，分 `recall 120 / reject 80 / await 40 / cross 30 / update 30`，每个比率带 Wilson 95% CI。
- 冻结样本：`bench/recall-quality.mjs`，39 条查询 / 16 条记忆，已接近饱和，只能证明「不退化」，不能证明「变好」。
- 纯召回延迟（`bench/scale.mjs`、`recall-300`）与端到端 prepare（`bench/bench.mjs`，`LITE_MEMORY_BENCH_N` 是**每层**）永不同表。
- 误注入率的分母是「该拒绝的查询」，Miss 率的分母是「有答案的查询」，两者不能相加、不能换用。
- 当前 8.75%（7/80）与 66.7% 都是带 CI 的结果，不许只报点估计。

## 7. 工程纪律（沿用并加强）

- 每次改 `view.js` / `store.js` / `index.js` 前先 `md5 -q` 记账，改完再核；坏文件从 `git cat-file -p HEAD:<file>` 取回，不信 `git checkout`。
- 一个提交只做一件事：判据修正不夹存储变更，实验性分支不进 `main`。
- 不在可移动卷/网络卷上开发或跑测试（见 `README.md` 本地开发小节）。
- 任何阶段结束时：`git fsck --full`、`git status --porcelain`、逐文件 md5 对比、`npm test` 全绿，四件齐了才算完。
- 具名失败必须原样列在 `docs/BENCH.md`，不许用「整体召回率」把它盖掉。
