# 反馈：unlag 实际能换 host 模块（更正上一条），以及 memory_read 不接受检索结果里显示的标题（2026-10-28，0.18.24）

第二条来自同一天另一次真实翻车：改完 `dsh-pause-resume` 的 host 代码后，我按「host 侧改文件不重启不生效」的旧认知让用户重启 DSH，用户反问「为啥要重启 unlag 能行嘛 为啥没命中记忆」。实测结论是 **unlag 就够了，agent 的建议错了**。

## 一、Unlag 能换掉 host 半的子模块（与上一条反馈的「顺带发现」冲突，请以本条的对照实验为准）

被测插件：`/Users/apple/Desktop/DSH/dsh-pause-resume`（profile 里的 `node_modules/dsh-pause-resume` 是指向它的符号链接），host 入口 `index.js` 静态 import `./lib/engine.js`、`./lib/probe.js` 等子模块。

对照实验（全部只读接口取证）：

1. 在 `lib/engine.js` 的 `describe()` 返回对象里加临时字段 `rev: 'probe065'`，`node --check` 通过。
2. `POST http://127.0.0.1:53344/dsh-unlag/reload`，头 `x-dsh-unlag: 1` → `{"status":"done","pending":[],"restartReason":null,"failedEntries":[],"rebuild":"safe"}`。
3. `GET /dsh-pause-resume/state` → `rev = "probe065"`。**子模块新代码已生效，没有重启 DSH，也没有加 `?v=`。**

4. 还原 `lib/engine.js`（`git diff` 干净）后再 reload 一次 → `/state` 里 `rev` 字段消失，`pending:0, restart:null`。

`~/.dsh/unlag-reload.log` 对应两行 `plugins reloaded (... pending=0)`。所以至少对这套插件，`reconcileProfile` 重建插件图时是整棵 host 模块树重新求值，不存在「只换了 client bundle rev、host ESM 仍是缓存」的情况。

上一条反馈的 addendum 观察到 `dsh-video-preview/index.js` 加标记后响应体仍旧，可能与标记所在路径（403 响应、网关包装、或该次 reload 实际未重建该 entry）有关，建议用同样的 `/state`-类可读接口复测，不要把它写成「host 半一律不生效」的结论——这条结论现在会直接导致 agent 让用户重启，代价很高。

对记忆内容的连带影响：`[global] DSH 桌面端重载页面/插件一律先走 dsh-unlag` 正文里「子模块还要加 ?v= 才重读」这句至少不是普遍事实；`[DSH] 本地开发的 DSH 插件开发完成后立即安装到本机 Harness` 正文里「host 半 `index.js`：文件一改就重读」也不准确（入口与子模块都要经过一次 unlag 重载）。两处建议按实测改写。

## 二、检索结果里的标题不是 `memory_read` 可用的句柄

一次诊断里需要读三条记忆正文，`memory_read` 连续失败 3 次（都返回「没有「…」这条记忆；先用 memory_search 对一下标题」）：

- 带 scope 前缀：`[global] 「DSH 桌面端重载页面/插件一律先走 dsh-unlag」`
- 只带书名号：`「DSH 桌面端重载页面/插件一律先走 dsh-unlag」`
- 工具描述要求「原样抄搜索结果里的标题」，而 `memory_search` 展示的正是 `- [global] 「标题」（条件）` 这一整行。

成功的写法只有裸标题：`DSH 桌面端重载页面/插件一律先走 dsh-unlag`。

影响：任何遵守「原样抄」的会话都会先吃 1–3 次失败，且失败文案把原因归给用户/模型（「先用 memory_search 对一下」），实际是显示格式与解析规则不一致。

建议（任选其一，成本都很低）：

1. `memory_search` / 召回卡额外输出可复制的精确句柄（`id` 或裸 `title`，与 scope 分开一列），显示格式与句柄解耦；
2. `memory_read` 解析标题时先剥掉 `[scope]` 前缀与 `「」` 包裹，再按裸标题查；
3. 失败文案写清「支持裸标题或 id」，并回显收到的字符串，便于定位。

## 三、这次自动召回为什么仍然没拦住（补充上一条反馈）

- 上一轮用户原话只谈暂停/恢复按钮的状态细节，没有任何「重启 / unlag / 刷新 / 插件」字面；
- 我准备做的动作是「让用户重启 DSH」——预防型规则的命中面在**动作侧**，不在用户原话里；
- 本轮用户一说「重启 unlag」，运行时上下文立刻出现三条相关记忆（global unlag 条、启动清单条、插件安装条），说明排序与条件判定本身没问题，单纯是触发词只扫用户原话。

即上一条反馈的根因复现成功，属同一个缺口，不是两件事。
