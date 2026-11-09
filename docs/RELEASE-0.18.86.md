# 0.18.86：分类边界修词形，回放与生产同源装箱

这一版不加功能，只修两处已有判断的口径：调度器认词形、回放认档位。

## 分类边界（`scheduler.js`）

- 英文词形按整词认，不再吃前缀：`copyright` 不再被判成「内容生成」，`crashes / errors / bugs`、`planning / refactor(ed|ing)`、`summarized / translated / drafted / written` 都能命中各自类型。
- 中文规则与先后顺序不变：排障 > 精确查找 > 规划 > 生成 > 流程 > 续接；「继续评估重构方案」仍是规划，「解释为什么要写发布说明」仍是流程，「继续」单独出现才是续接。
- 空查询仍返回 `general`（0.18.84 起），这一版没有改回续接。
- 新增 50 条表驱动回归（`test/scheduler.test.mjs`），覆盖三种档位的正反例、纯续句与带目标续句的边界、空输入、英文词形误判。

## 回放与生产同源装箱（`evolve.js`）

回放此前用 `CARD.max / CARD.bytes`（3 张 / 1200 B）装箱，而生产已按档位收口，低档回合两者会得到不同卡片集合。现在回放先按这一轮的话定档，再用 `min(硬顶, 档位额度)` 装箱，`deliveredIds` 与 `budgetDropped` 的口径与生产一致；排序参数、适用性门槛不变，回放仍只求两轮可比。

## 三档规模重测（`docs/BENCH.md`）

同机重跑 200 / 400 / 1000（每层）三档，数值已写回 `docs/BENCH.md`：P50 91.2 / 145.7 / 323.4 ms，P95 106.1 / 156.7 / 347.5 ms。与 10 月 31 日那组相比，1000 档 P50 +15.1 ms、P95 +20.5 ms，属于同机日内波动量级；调度定档是纯本地正则，没有新增 IO、缓存或额外扫描，本轮不据此做优化。

## 验证

- 全量 `npm test`：35 个测试文件全过、0 失败。
- `test/scheduler.test.mjs` 5 项通过（含新增 50 条分类回归）。
- `test/evolve.test.mjs` 14 项、`test/evolve-consistency.test.mjs` 13 项通过。
- `test/eval-hard.test.mjs` 8 项通过（固定负例 6 条 0 误触发），`test/evolution-read.test.mjs` 全部通过。
- 包体未动（只改 `scheduler.js` / `evolve.js` / 测试 / 文档），`test/bundle.test.mjs` 仍是 raw 193948 B / gzip -9 48482 B / 距目标 7522 B。
