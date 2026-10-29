# 0.18.49 — 待裁决区不再显示「（没有正文）」

## 改了什么

- 0.18.48 之前的版本排队保存冲突时，只留了标题和相近条目，没有把草稿正文一起落盘。这些旧记录展开后正文是空的，界面原来显示「（没有正文）」，还照样给「存新的」按钮——那条草稿其实已经救不回来，点了只会失败。
- 现在这类记录展开后明确写「旧版本排队的草稿没正文，只能丢掉」，并且不再给「存新的」，只留「丢掉」。
- 判定用 `conflictFactsOf(row).draftMissing`（纯函数），测试覆盖：有草稿、空正文、只有标题三种。
- 新版本写入冲突时本来就整份带走草稿（`store.js` `queueConflictLocked`），这个坑只影响升级前排队的三条旧记录。

## 验证

- `node test/client.test.mjs` 22 passed + palace（新增 draftMissing 断言）。
- `npm test` 21 套件全绿。
- `ui-copy-lint client.js` 3 error / 21 warning，与改动前同计数；`zh-lint` 0 error。
