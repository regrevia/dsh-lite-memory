# 0.18.75

**读取认得缩短的标题。** 上下文里常只剩下标题的前半截（到逗号、括号为止），
`memory_read` 精确匹配失败时不再直接报错要人重打一遍。

- `memory_read`（含 `view="links"`）在精确匹配、归档重试都落空后，改按前缀关系兜底：
  请求的标题是某条存储标题的前缀（或反过来），且这条请求本身不短于 6 个字、全库只有
  一条对得上，就直接读这条，回执里给的是完整标题。
- 对得上两条以上仍报 `相近的里有：「…」「…」`，绝不取第一条；前缀太短（少于 6 个字）
  不参与兜底，避免「发布」「顺序」这类碎片命中。
- 写入与遗忘保持严格：`memory_save` 的 `updateTitle`、`memory_forget` 的标题都必须
  精确命中，接近候选只用于把完整标题报出来。认错条目的代价比多问一轮大。
- 回归用例：截图原样 `npm 发布一律走 dsh-npm` → `npm 发布一律走 dsh-npm，ENEEDAUTH 不是缺凭据`
  直接读到正文；两条前缀候选同时存在时读取报候选；`updateTitle` 缩写的报错文案不变。
- 测试：`npm test` 全绿（含 contract / layer-read / store / bundle / resident）。

安装：`~/.dsh/profiles/desktop/node_modules/dsh-lite-memory`，版本 `0.18.75`。
