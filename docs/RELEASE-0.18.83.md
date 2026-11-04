# 0.18.83 — 待裁决能被丢掉、模型自己裁决合并或丢弃、面板能看「所有项目」

## 1. 「丢掉」点了却丢不掉

### 现象

待裁决队列里点「丢掉」没反应，刷新后那行还在；重复点也不消失。

### 原因

老数据里的待裁决行 `revision` 是 `null`，`/conflict` 的版本校验把它当成「版本对不上」，
返回 409 `stale_draft`。面板只把这次失败当成一次没成功的请求，行留着不动。
丢掉本来只是删掉一条待办、不写记忆，用版本校验挡住它反而让队列卡死。

### 修法（三层，缺一层都不够）

1. `store.js` `loadIndex` 走 `normalizeConflicts`：读出时补齐 `id`/`title` 的字符串形态、
   `revision = Number(...) || 1`、`scope` 默认值。老行读出来就是合法行，不再带着 `null` 到处跑。
2. `store.js` `dropConflict` 去掉版本拒绝：版本对不上也照丢。丢掉不覆盖任何记忆，没有可保护的对象。
3. `index.js` `/conflict` 的版本校验只留给 `keep`（另存一条要写记忆，必须知道自己盖的是哪一版）；
   `drop` 不再需要 `expectedRevision`。

## 2. 相近条目让模型自己裁决：合并 / 另存 / 丢弃

### 现象

以前撞到相近条目只能把决定推回给人（`needsResolution` 挂起），面板上堆一串「等你定」，
模型明明读得懂两条是不是同一件事，却被迫停下来问。

### 修法

`memory_save` 增加 `resolution`（`distinct` / `merge` / `discard`）与 `mergeInto`：

- `merge`：并进指定的那一条，`mergeInto` 给标题或 id；不给就按最相近的那条。
  合并保留目标条目的标题（标题是句柄），只更新正文、标签等字段。
- `distinct`：确实是另一条，换标题另存。
- `discard`：重复信息，不存。返回 `discarded: true`，不产生新条目、不留待办。

默认行为不变：不带 `resolution` 时仍按原来的相近条目流程走。`memory_suggest` 不接受这两个参数
（建议不是写入），已从它的参数表里排除。

判据写进工具描述：需要模型在保存当下就裁决，不要挂回给用户。

## 3. 面板可选「所有项目」：列表 / 图谱 / 宫殿都分得清层

### 现象

面板只能一层一层看：切到别的项目就看不到当前项目，切到全局就看不到任何项目，
想「一眼看全部」只能来回切。

### 修法

- 服务端 `/lite-memory/overview` 接受 `scopeKey: "all"`：把枚举到的所有项目层 + 全局层合成一张表。
  行带 `scope`（`project` / `global`）、`scopeKey`、`scopeLabel`，回读正文、裁决冲突都用行自己的层。
  合并只读——`/body`、`/entry`、`/conflict` 显式拒绝 `scopeKey: "all"`，写哪层必须指名哪层。
  某一层状态读坏了只跳过那一层，不连坐整张视图。合并用 `${scopeKey}:${id}` 去重，不同层同标题各算一条。
- 面板范围选择器在项目列表前加「所有」；选中后：
  - 列表每行显示层名；
  - 图谱节点标签前缀层名；
  - 宫殿按层分房间（默认仍按类型分，不受影响）；
  - 详情正文按行自己的层取；
  - 别的层的行只读：改正文、「另存一条」、丢掉按行的层判断，不给越层写。
- 当前项目不变：看「所有」只是换一面看，不切当前项目、不影响召回。

## 阈值与基线变动（明示，不是悄悄放宽）

| 项 | 旧 | 新 | 原因 |
| --- | --- | --- | --- |
| `test/resident.test.mjs` `memory_save` 上限 | 5860 B | 6260 B | save 要讲清 merge/distinct/discard 三种裁决，这段判据省不掉 |
| `test/resident.test.mjs` 常驻总账 | 15400 B | 15600 B | 同上；仍逐工具记账，总账没有模糊 |
| `bench/bundle-baseline.json` raw | 188792 B | 191327 B | 面板加「所有」视图与按层显示 |
| `bench/bundle-baseline.json` gzip | 47131 B | 47892 B | 同上 |
| `bench/bundle-baseline.json` targetGap | 6171 B | 6932 B | 40 KiB 目标差额如实记债 |

常驻文本先做过压缩：save 描述、`resolution`/`mergeInto`/`scope` 等参数说明按判据重写，
上面两处上限是压缩后仍然装不下的部分，已在测试里注明原因。
`test/contract.test.mjs` 里 `resolution` 枚举断言从旧的两值改成三值并补 `mergeInto`，
这是**预期行为变化**，不是为了让测试通过而改断言。

## 新增测试

- `test/contract.test.mjs`：「所有」合并视图——跨三层都有行、行带归属层、同层同标题不重复、
  当前项目不变、`/body` `/entry` `/conflict` 拒绝 `"all"`、折回单层还是原来那张表；
- `test/client.test.mjs`：宫殿按层分房间（含分页）、走廊按层列门、图谱标签带层名前缀，
  以及不带选项时默认行为一字不改；
- 合并 / 丢弃两种裁决各自的落库结果。

## 验证

- `node --test test/*.test.mjs` → 84 passed / 0 failed；
- `node --check index.js && node --check client.js` 通过；
- `lifeguard_check` 预检通过，0 条。
