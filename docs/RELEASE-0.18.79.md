# 0.18.79 — 自进化不再被一个词、一次超时废掉整轮

## 现象

面板「自进化」页连着 8 天只有一句「最近整理失败，可查看原因」，筛选行 `全部 0 候选 0 试用 0 生效 0 暂停 0`。
项目层 `learning.receipts` 里 36 条记录、`applied` 0 条，三种失败把每一轮都吃掉：

| 条数 | 失败原因 |
| --- | --- |
| 10 | `反馈已更新，这轮结果没采用` |
| 9 | `整理已取消` |
| 9 | `反馈类型不认` |
| 1 | `这期已经换到别的作品，这次整理作废` |
| 7 | `no_change` |

## 根因与修法

1. **15 秒就掐断（9 条 `整理已取消`）**：`learning.LIMITS.timeoutMs = 15000` 到点 abort，流式循环直接抛
   `整理已取消`，这 9 条 usage 全是 `None`——模型连第一段正文都没发完。真实调用 prompt 1168 字符、
   输出上限 768 token，15 秒远不够。改成 `60000`；`maxTokens` 768 → 1024（观测到 782/833 token 的输出，
   已贴着上限）。

2. **一个词废掉整轮（9 条 `反馈类型不认`）**：`parseOutput` 里 `FEEDBACK_TYPES.includes(change.feedbackType)`
   是全有全无的硬校验，模型写 `preference`、`Spec-Change`、`accept` 这类同义词就整轮返回失败，
   哪怕另一条 change 完全合法。新增 `normalizeFeedbackType()`：小写化、空格转下划线、连字符折叠、
   同义词表归一（spec_change / execution_miss / task_exception / aspect_accept / artifact_accept / unclear），
   归一后才校验；确实不认识的仍拒，但只影响它自己，别的合法 change 照常采纳。

3. **别处的新反馈作废这一期（10 条 `反馈已更新`）**：`index.js` 用项目级 `feedbackRevisions` 比代次，
   只要在途整理期间项目里又来任何一条反馈，这一期的结果就扔。改成按 `项目键 + 作品` 记代次
   （`feedbackEpisodeRevisions`），判断收进 `learning.feedbackStillCurrent()`：只有**同一期**又来新反馈才作废；
   别的作品来新反馈不影响；没有作品绑定时退回项目级比较。

4. **模型不知道枚举**：`system` 一句只限 JSON、不许工具，没有列出允许的 `feedbackType` 取值。
   补上六个取值与各自含义，让模型本来就输出合法值，而不是靠事后兜。

## 验证

- `test/learning.test.mjs` 新增 L03b/L03c/L03d：同义词归一放行、真不认的仍拒、超时与 token 下限、
  只有同一期新反馈才作废（含无作品时退回项目代次）。
- `test/contract.test.mjs` 新增整链用例：真实插件挂载 + 假模型，模型返回 `feedbackType: 'preference'`，
  回合结束后项目层**真的生成 1 条 active 规则** `脚本先写三版再挑。`——修复前这一轮会以
  `反馈类型不认` 收尾、规则数 0。
- `node --test test/*.mjs`：84 passed / 0 failed。
- `node --check` client.js / index.js / learning.js 全过。

## 包体

`client.js` raw 188792 B / gzip 47133 B，与 0.18.78 持平（本轮改动全在宿主侧 index.js / learning.js）。
