# 0.18.76

- `memory_read` 按缩短标题解析时，同名前缀的**归档副本不再算第二条候选**：收并留下的旧副本和活条目并存，读落在活条目上，不再报「相近的里有」。
- 只有归档候选时仍认得：唯一一条归档前缀能对上就返回该条（`status: "archived"`），读得到正文说明。
- 两条**活**前缀候选仍然报歧义，不猜。
- 回归：契约测试新增「活副本优先 / 只剩归档可读」两组；`npm test` 全绿（`bundle.test.mjs: passed`，resident tool text 15263 bytes）。

安装：`~/.dsh/profiles/desktop/node_modules/dsh-lite-memory`，版本 `0.18.76`。
