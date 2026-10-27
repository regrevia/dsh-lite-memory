# 0.18.0

## 记录语义：有效期与取代链（P0）

- 每条记录新增四个可选字段：`validFrom`（默认写入时间）、`validUntil`、`supersededBy`、`supersedeReason`。字段随索引落盘并进校验和，没有这些字段的旧记录照常读、照常搜。
- `memory_save` 支持 `supersedes: <id>`：新内容写成新条目，旧记录当场标记 `supersededBy` + `validUntil` + `supersedeReason=user_replaced`，旧正文同时进新记录的 `versions` 链头，回滚时两代都在。
- 默认检索不再返回被取代或已过期的记录；`memory_search history:true` 仍能取回并看到取代来源，`memory_read` 按 id 直接读也不拦。
- 同一层才能取代、不能取代自己、已被取代过的不能再取代（`conflict`）；重新保存一条被取代的记录会摘掉取代链，让它回到现行。
- 相似度合并、主题槽位判断只在现行记录里找目标，新内容不会再合进一条已经不是现行的记录。

## 写入前扫描与候选解释（P1）

- `memory_save` / `memory_suggest` 落盘前扫完整原文：提示注入句式、`<system>`/`<instructions>` 这类伪造标签、开头冒充 `system:`、不可见 Unicode 一律拒绝；凭据仍按「只记位置不记值」拒绝并给出改写提示。
- 判据按形状写死，正常讨论规则（「忽略这条要求」）不会被误拦；凭据检测与注入扫描合并成一次 `unsafe` 报错，错误里说清改哪里。
- `needsResolution` 的候选现在带 `updated` / `when` / 首行摘要 / `reason`（标题相近或同一主题槽位），调用方能直接判断合并还是另建。

## 可用性加固（P0/P1）

- 冷存正文写盘走 `writeDurable`（临时文件 + `fsync` + `rename`），归档正文不会再出现「索引说写了、文件没落地」。
- 冷存缺文件/坏文件报 `cold_missing` / `cold_corrupt`，不拿空正文冒充「这条没有正文」。
- 崩溃残留的 `.lock` 按 pid 判活回收：`ESRCH` 才回收，`EPERM` 视为进程仍在；回收前后核对内容，避免抢别人的锁。另一个进程真在写时报 `busy`，文案给「删哪个文件」的下一步。
- `state.json` 校验失败自动隔离成 `state.corrupt-<时间>.json` 并从 `state.prev.json` 恢复；两代都坏才停写，错误里给恢复步骤。
- 新增 `test/ha.test.mjs`（锁回收、损坏恢复、落盘原子性、只读目录、冷存往返与损坏）与 `test/safety.test.mjs`（注入、凭据、不可见字符、候选解释）。

## 面板

- 引用按分组折叠成一行摘要；每条引用带层级、更新时间和归属范围，不再只给标题。
- 点引用就地展开摘录，再点收起；「解释模式」下无命中时说明没触发的原因。
