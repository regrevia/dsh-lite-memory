# 0.18.70

这一版不加功能面，修的是「学到的能不能用、想起的准不准、贵的才提醒」三件事，外加宫殿按需挂载和体积棘轮。

## 学习主链路

- 同标题更新就地改版，不再新建；显式 `supersedes` 记 `supersededBy` + `supersedeReason=user_replaced`，旧版本退出自动使用（`test/recall.test.mjs` A34）。
- 证据计数与样本口径一致；来源项目门控按 `projectId` 决定可见性，未确认来源的样本不参与规则形成。
- 关闭会话后延迟写回不再产生「stale」幽灵；`persona-learning` 的来源闸门按当前项目判定。

## 写入质量与容量

- 硬上限（4096 B）回 `needsCompaction` + `stored:false` + `maxBytes` + 可执行拆法，绝不谎报存下。
- 软提示四条：细节较多 / 引用临时路径 / 建议补适用条件 / 混合多个主题（≥3 个小标题）。只随回执给一行，不拦写入、不改正文（`test/contract.test.mjs`）。
- 试用 → 暂停 → 归档的生命周期收拾，每轮 ≤8 条、同项目 ≥24 h，无后台定时器；active/pinned 永不被 TTL 清掉，归档可恢复（`test/lifecycle.test.mjs`）。
- 名额按同一套规则计数；待确认候选不再报假的「已到上限」。

## 召回

- 召回耗时上限随库大小放宽：200 条内 150 ms，每多 8 条 +1 ms，封顶 400 ms；显式传入更宽的值仍优先。
- 超时/取消不再静默：回执记 `deadline` / `aborted`，面板说「上次没提醒，准备超时」。
- 数字按整段比：问「条目 7」不再被「条目 77 / 797」抢走（`view.WEIGHT.number`，标题满加分、正文半加分）。
- 三个规模档（项目/全局各 200、400、1000 条）全部 gate：P50 89.5 / 143.8 / 308.3 ms，注入 358–359 B，正向问题每次都能拿到那张全局卡。

## 宫殿

- 只创建当前模式的视图：关掉的图谱/宫殿不进树，切走即卸载，不用 `display` 藏。
- 走廊只看见门，门位由房间 id 定，撞槽按房间顺序顺延；浏览不触发模型、召回、学习（`test/palace-isolation.test.mjs`）。
- 没有小人、没有装饰色块，只有极简白线。

## 包体

- `client.js` raw 186590 B / gzip -9 46309 B，比上一基线各降 40 B；40 KiB 目标还差 5349 B，作为债记在 `bench/bundle-baseline.json`，`test/bundle.test.mjs` 只许下降。

## 已知未做

- 价值裁决的半衰期加权：只有 `hits`/`used` 两个信号，都不等于「这条帮到了」，没有反馈通道就先不做，不拿 `lastUsed` 顶替（`docs/ROADMAP.md`「已知未做」）。

## 兼容

- 工具参数 schema 不用 type 数组（宿主只收单类型）：`selection` 改 `object`，`topicKey` 空串清空，新增 `clearSelection` 开关。

## 验证

- `npm test`：33 个文件全绿（`EXIT=0`）。
- 召回回执：10 个 reason 都有面板文案（`aborted` 有意不出声），`client.test.mjs` 24 条断言锁住。
- 超时丢弃投影：额度、正文名额、处理次数都退回，且没送达的条目不记使用（`recall.test.mjs` A36）。
- 面板区分「准备超时」与「没命中」：真实 HTTP 探测 `/lite-memory/overview` 读到 `reason: deadline`、`cards: 0`（`contract.test.mjs`）。
- 宫殿只有看：遍历四个房间与所有页不交 id、不改记录；走廊层不预挂展品，展开哪间才画哪间（`palace.test.mjs`）。
- `LITE_MEMORY_BENCH_N=200/400/1000 node bench/bench.mjs`：三档 `EXIT=0`。
- lint：zh-lint 0 error，style-lint 0 error。
