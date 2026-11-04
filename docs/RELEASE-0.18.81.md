# 0.18.81 — 提醒别等用户先想起来：动作发生前也查一次，没命中留下证据

## 现象

预防型条目（`procedure` / `pitfall`）约束的是「下一步动作」，可字面往往写在命令里，而不是用户那句话里：

- 用户说「这个库要加个字段」，模型接着跑 `python migrate.py --apply`；
- 记忆里明明写着「先 `--dry-run` 看差异，再 apply」，但这句话没出现在用户原话里，
  自动召回按用户原话打分，于是这一轮什么都没注入，模型直接 apply 了。

同一条记忆在事后问「迁移要注意什么」时召得回来，在真要动手的那一步却不在场。

另外两类断点：

- 「继续发版」这种 8 字内的续说开头，整句白名单只认后面全是通用动作词的句子，
  带一个具体动词（发版/打包）就落空，上一轮的任务线索丢掉，提醒断在这一轮；
- 一轮零命中后，面板只能看到「0 条」，查了什么、差多少分完全没记录，阈值和触发词只能靠猜。

## 修法

### 1. 动作侧窄查询（`index.js` `actionSideHint`）

工具真的被调用时，在 `agent/created` 已经装好的执行前守卫里补一次窄查询：

- 查询 = 工具名 + 关键字符串参数（`command` / `file_path` / `pattern` / `query` / `url` …，单参数截 160 字）；
- 只查 `procedure` / `pitfall`，并且这条记忆的触发词必须**真的出现在这次调用里**（大小写无关的子串命中）；
  泛泛相关的条目一律不打扰；
- 只读类工具（`read` / `glob` / `grep` / `memory_*` …）直接跳过，不给读动作加噪声；
- 排序复用 `view.rank`（适用性、生命周期、冲突裁决一致），取第一条；正文原样给出，不是只给标题；
- 与自动召回共用同一份请求额度：`affordableTool(win, bytes)` → `win.toolBytes`，同一轮只补一次（`held.actionHinted`），
  已交付过的条目跳过（`deliveredIds`）；没有请求账本就不交付；
- npm 探测提示（0.18.60）仍优先：`return npmProbeHint(...) || actionSideHint(...)`，两条通道共用同一个守卫。

### 2. 续说开头放宽（`view.js` `isContinuationOpening`）

去掉空白标点后 ≤ 8 字、以「继续 / 接着 / 再接着 / 然后 / 往下 / 再来」开头的句子，一律算当前任务的续说，
带上上一轮原话检索。整句白名单（`isContinuationQuery`）与拆句规则（`isEllipticalContinuation`）都保留，
这里只补「短且带一个具体动词」的那一类，不扩大到完整句子。

### 3. 零命中留证据（`index.js` `recallReceipts`）

一条卡片都没发布时，回执里多记一项 `closest`：本轮查询下最接近的 2 条候选及分数（项目层 + 全局层，最多 3 条），
只记标题与分数，不留正文。面板 `current.recall` 直接读得到，回放和调阈值有据可查。

### 4. 读取预算写进工具描述（issue #4）

`memory_read` 描述补一句「一条消息读 3 条 / 8 次为限，下一条接着算」，数字取自 `view.REQUEST_LIMITS`，
和实际拦截共用同一来源；描述同时压短，模型可见工具文本不涨。

## 验证

`test/recall.test.mjs` 新增 3 条：

- A37：动作侧窄查询——`migrate.py` 触发的执行前守卫给出正文（含 `--dry-run`），同一轮第二次、只读工具、触发词不匹配都返回 `undefined`；
- A38：「继续发版」留下请求状态，查询带着这句话；
- A39：零命中回执可读，`cards === 0` 且 `closest` 为空（没有接近的候选时不留噪声）。

`node --test test/*.mjs`：全绿（`fail 0`；eval-hard 8 passed / 0 failed；bundle ratchet 通过）。

## 包体

`client.js` 未改：raw 188792 B / gzip 47133 B，与 0.18.80 持平；40 KiB 目标还差 6173 B，仍记为待还的债。
