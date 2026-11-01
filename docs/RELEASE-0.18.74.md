# 0.18.74

同一层里不再出现两条同名记忆。

- 标题就是唯一句柄：同层同名一律更新那一条，前置条件不同也更新，不再按 `when` 分叉另建。
- `resolution="distinct"` 只能换标题另存；撞上同名直接报 `已经有同名记忆「…」，另存一条请换一个能区分的标题`。
- 旧数据里已经分叉的同名条目，下一次写入该层时自动收并：留更新的一条，`when` 与别名合并进去，另一条进可恢复归档（`cold/`），不删正文。
- 写入结果带 `mergedTitles`，工具回执显示「已收并同名「…」」。
- 本机两处线上重名已收并：`DSH-0ea3b310` 38 → 36 条 active（`Issue 处理规范…`、`手绘风 HTML 宣传片…` 各并一条），`dsh-mobile-use-0796939a` 6 → 5 条 active；重名扫描 0 组。
- 跨层同名（项目层覆盖全局层）保持两行，不受影响。
- `npm test` EXIT=0；`test/store.test.mjs` 80 passed、`test/crossing.test.mjs` 30 passed、`test/bundle.test.mjs: passed`、常驻提示词 15263 B（上限 15400 B）。
