# 0.18.71

只动提示词账本，不改行为、不改预算：常驻工具文本 16381 B → 15197 B（约 -297 tokens/请求）。

## 改了什么

- `memory_save` 参数说明压缩（17 处），`selection` 的旧「null 清空」改成 `clearSelection`，与实际 schema 一致。
- 「值得记 / 不记」判据只在 `memory_save` 讲一遍，`memory_suggest` 改成「判据同 memory_save」，不重复。
- 常驻字节账本收紧：`memory_save` ≤ 5860 B、`memory_suggest` ≤ 2900 B、合计 ≤ 15400 B（`test/resident.test.mjs`）。

## 验证

- `npm test` EXIT=0，28 个套件全绿；`resident tool text 15197 bytes`。
- 预算常量零改动：`git diff` 条目数/字节/名额/窗口类常量改动行数为 0。
