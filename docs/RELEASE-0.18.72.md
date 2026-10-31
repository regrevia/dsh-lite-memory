# 0.18.72

去重 + 面板少一次重读；体积棘轮反而降了。

## 改了什么

- 待裁决处理成功且回执带 `remaining` 时，只从本地清单摘掉那一行，不再整块重读；提示里给出剩余条数。
  失败或没给余量时照旧重载，过期行不会留在原地变成「点了没反应」。
- 删掉三处从未被引用的常量（`ITEM`、`scopeTag`、`EVO_STATE`）。

## 体积

`client.js` 186590 → 186561 B，gzip 46309 → 46296 B；向 40 KiB 的差额 5349 → 5336 B。基线同步下调。

## 验证

- `npm test` EXIT=0，0 个 AssertionError；`bundle.test.mjs: passed`。
