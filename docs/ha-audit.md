# dsh-lite-memory 高可用与记忆生命周期审计

审计对象：`store.js` / `state.js` / `index.js` / `learning.js` / `anchor.js` / `view.js` / `client.js`（只读）
基线版本：0.17.0。方法：静态读代码 + 定向失败注入测试，不改 `client.js`。

结论先说：**数据只会丢在「冷存写入未落盘」这一处**（P0-A）。其余风险是「单点坏了整层不可用、只能人工修」的可用性问题（P0-B、P1-C/D），以及若干可观测性/降级缺口（P2）。

## 分级

| 级别 | 判定 |
| --- | --- |
| P0 | 会丢用户数据，或坏一个文件就让整层记忆长期不可用且无恢复路径 |
| P1 | 不丢数据，但异常后需要人工介入、错误信息不足以自助恢复，或单次失败会阻塞不相关的正常操作 |
| P2 | 行为可接受但语义模糊/有冗余副作用/可观测性不足，记录不改 |

## P0-A 冷存写入没有落盘保证（真实数据丢失窗口）

证据：`store.js:483` `writeCold` 只做 `writeFileSync(tmp)` → `renameSync(tmp, file)`，没有 `fsync` 文件、也没有 `fsync` 目录。对比 `state.js:648` `writeDurable`（fsync 文件 → rename → fsyncDir）与 `state.js:673` `publish`。

影响链：
1. 归档条目的正文只存在于冷存文件（`applyFlat` → `coldStored` 把热状态里的 `body` 摘空，`store.js:220-232`、`527-556`）。
2. 断电/内核崩溃后，`state.json` 因为 fsync 过会一致，但刚写的 `cold/<id>.json` 可能为空或不存在（rename 元数据未落盘，甚至回退到旧文件）。
3. 之后 `readCold` 抛 `cold_corrupt` / `cold_missing`（`store.js:496-519`），`store.js:404` `readBody` 明确拒绝用空正文顶上。
4. 更糟：`coldStored` 的 `readCold`（`store.js:533`）在**每次保存**的 `applyFlat` 里执行，一条坏冷存会让该层所有 `memory_save` 失败——整层写死。
5. 没有任何工具能修冷存（无 repair/quarantine 入口），只能人工删文件。

修复：`writeCold` 复用 `state.writeDurable` 的落盘序列（fsync 文件 → rename → fsyncDir），失败时清 tmp。测试：冷存文件与目录 fsync 次数断言 + 冷存损毁后 `memory_read` 的明确报错不回归（`test/store.test.mjs` 冷存一节）。

## P0-B 状态损坏没有隔离，也没有自助恢复路径

证据：`state.js:1069` `load` 对 `readEnvelope` 错误原样 rethrow（注释明确「有 prev 也不自动回滚：回滚会掩盖一次真实损坏」），`state.js:566` `fail()` 的消息只描述损坏（已损坏 / 校验和不一致 / 格式不认 / 版本对不上），不含恢复动作。`index.js` 全文只有一处 `error.code` 分支（`2079`，`purge_pending`），`corrupt` / `busy` / `unavailable` / `migration_required` / `cold_*` 都以原始异常抛给工具调用方。

影响：坏一次 `state.json`，该层所有读写（含 `memory_search`）直接失败；恢复动作（把 `state.json` 改名后让 `load` 走 `state.prev.json` 的 `recovered:true` 分支）只存在于代码里，用户和模型都看不到。数据不丢（prev 完好时），但可用性完全依赖人工。

修复（保守，不改「不自动回滚」的设计）：`corrupt` 错误消息补恢复步骤（坏文件改名 → 自动从 `state.prev.json` 恢复），并在 `memory_*` 工具失败时保留该文案；不引入自动覆盖。

## P1-C 崩溃残留 `.lock` 没有回收，读写都会 `busy`

证据：`state.js:396-445` `withScopeLock`：`wx` 建锁、`EEXIST` 等到 `LIMITS.lockWaitMs = 500` 后抛 `busy`；token 写了 `${pid}:${rand}` 但只作注释用（「token is advisory; the lock file itself is the mutex」），退出时按 token 相等才删。没有 pid 存活检查、没有 mtime 阈值回收。

影响：进程崩溃（含被 kill -9）后锁文件残留，该层读（`search`/`read` 都走 `withLocks`）和写全部 500ms 后失败。错误信息里给了删除路径（可自助），但每个新用户/新会话都要重蹈，且模型无法自己执行删除。

修复：`EEXIST` 时读 token 的 pid，若同机进程不存在（`process.kill(pid,0)` 抛 `ESRCH`）→ 重读 token 确认未变后 unlink 并重试；不做纯 mtime 回收（会误删活进程的锁）。测试：伪造 `deadpid:xxxx` 锁文件 → 正常加锁；伪造活 pid（当前进程 pid）→ 仍然 `busy`。

## P1-D 冷存损坏会阻塞整层写入，且不会自愈

与 P0-A 同源但与落盘无关：即使冷存文件是被外部改坏/手工截断，`coldStored` 也对每条归档记录 `readCold` 且不吞错，`applyFlat` 在事务内执行 → 一条坏文件让每次 `saveIndex` 抛 `cold_corrupt`。

修复：`coldStored` 读冷存失败时先回退到热状态正文（`state.readEntryBody`，该条在热状态里还有正文时就是权威副本），拿到正文就重写冷存（自愈）；拿不到才抛原错误。这样「一条坏归档」不再拖死整层，且不掩盖真正没救的损坏。测试：手工写坏 `cold/<id>.json` 后 `memory_save` 仍成功、该条 `memory_read` 恢复。

## P1-E 归档正文在「腾挪」后短暂只在热状态里

证据：`state.js:740` `enforceBudget` 把 victim 置 `archived` 但正文仍留在热状态；`store.js:254-258` 只把 `{id,title,status:'archived'}` 补进 `index.archived`；真正的 `coldStored`（写冷存 + 摘空）发生在下一次 `applyFlat`。`coldStored` 在缺正文时会回退 `state.readEntryBody` 从磁盘热状态找回（`store.js:536-538`），所以不会丢。

结论：设计上自洽，不修。但依赖「下一次保存」——如果之后进程一直不保存，热状态会一直持有归档正文（容量账已按 active 算，归档正文没计入金币/字节预算），只在磁盘膨胀上有影响。记录为 P2 观察项。

## P2 观察项（本轮不改）

- **读路径触发迁移**：`store.js:177-180` 在无 `state.json` 时由任意 `loadIndex` 调 `state.migrateLegacy`。`migrateLegacy` 自己 `withScopeLock`（`state.js:973`），所以并发安全；问题是「读」会写盘，`options.readOnly` 才跳过。可观测性差，不改。
- **归档冷存写入早于发布**：`applyFlat` 在 `transact` 回调里写冷存，publish 失败（`budget_exhausted` / CAS 冲突）会留下孤儿冷存文件。只占空间，下次同 id 归档会覆盖，不改。
- **整理失败只留回执**：`index.js:2516-2533` 失败与取消都 `recordLearningFailure`，配额已扣不退。规则不产生副作用，`evolution.learning.receipts` 有原因码，界面能显示失败；不改。
- **整理并发/覆盖**：`feedbackRevisions`（`index.js:871`、`2488`）保证旧结果不覆盖新纠正；`learningJobs` 每层只跑一个（`2541-2574`）。`commitLearning` 在锁内复查 epoch/版本/digest，安全。
- **记忆状态机**：`learning.js:705-786` `nextLearningState` 对未改规范（`specDigest` 相同）保持 `active`/`trial`，不会被弱证据降级；`paused` 只会被显式长期规则或重置证据解除。未发现非法迁移。
- **窗口/预算账本**：`index.js` 的 `windows`/`seenHumans` 是模块级 Map、按 agent 键封顶（400/64），会话复用键时是「保守少注入」而非重复注入，不改。
- **`touchUsed` 吞错**（`store.js:1313`）：只影响 `lastUsed` 排序精度，不影响正确性。

## 未覆盖

- 未做真实断电/并发多进程压测，只有静态推理 + 定向失败注入。
- `anchor.js` / `view.js` 的排序与触发条件只审了与状态机/持久化相邻的部分；纯呈现逻辑按「不阻塞数据安全」跳过。
