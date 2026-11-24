# 把记忆给 DSH 以外的 agent 用：现状口径与待放行清单

口径时间：2026-11-23。本文件只做评估，不含实现，不改 `state.js` / `store.js` / `view.js` 的任何行为，
不新增记录字段。凡标「待放行」的，都要先解除本轮约束（只做正确性修复与分支收敛）才允许开工。

## 一、结论

1. **只读共享今天就能用，不需要 DSH、不需要加载插件**：外部工具读 `state.json` + 调 `view.rank()` 即可，
   实测单查询 14 ms（`global`，50 条 active）/ 3–5 ms（`Desktop-DSH-8963bce6`，53 条 active）。
2. **写共享今天不能给外部工具**：一条记忆的落盘要同时满足单写者锁、校验和、原子发布、容量闸，
   外部进程直接改 JSON 会同时破坏这四件事，而且没有任何报错会传到调用方。
3. **`global` 层现在装的是「用户级跨项目稳定偏好」，不是「所有项目通用知识」**：把它开给别的 agent 之前，
   要先有 `audience` 这类「给谁看」的维度，否则 DSH 专属的偏好会被当成通用规则喂给别的 agent。

## 二、已经验证的外部只读契约

外部消费者（codex / claude code / 任何脚本）读一条记忆的完整路径：

```
<root>/<scope>/state.json  →  payload.entries            # 不是 projects.*.records
  →  过滤 entry.status === 'active'
  →  拍平：current.{title,summary,body,kind,keywords→tags,triggers,applicability,conditions,selection,links}
           + maintenance.{summaryFull,retiredNames→aliases,reviewState}
  →  view.rank(records, query, { limit, requireApplicable: true })
```

`store.js:90 toFlat()` 就是这段拍平，外部实现可以照抄，不必依赖本仓库（`/tmp/probe4.mjs` 里已用
内联版本跑通，不 import `store.js`）。

实测（同一台机器，同一查询「上线前跑什么检查」，2026-11-23）：

| scope | active 条数 | 单查询耗时 | top1 分数 |
| --- | --- | --- | --- |
| `global` | 50 | 14 ms | 9.36 |
| `Desktop-DSH-8963bce6` | 53 | 3 ms | 8.79 |

同一查询在两个 scope 命中不同 top1 ⇒ **scope 必须由调用方显式传入**，不能靠「最近改过的目录」猜。
这是只读共享唯一必须写进调用约定的东西。

注意：14 ms / 3 ms 是「单查询、50/53 条 active、拍平后纯内存打分」的口径，
不是 `bench/scale.mjs` 的档位数字，两者不要混着引用。

2026-11-24 复测（同一台机器，同一条查询，冷启动含读盘与 `JSON.parse`）：
`global` 51 条 active 26.19 ms，`Desktop-DSH-8963bce6` 53 条 active 5.55 ms。
`global` 那次是进程内第一次读，把 Node 的磁盘缓存也算进去了；量产口径看第二次的数。

## 三、名称与分层（建议，未落地）

GitHub 仓库 2026-11-24 已改名为 `regrevia/lite-memory`（旧 URL 301，`raw.githubusercontent.com`
上的旧地址实测仍回 200，第三方索引不用改也不会断）。npm 包名仍是 `dsh-lite-memory`，
`package.json` 的 `name` 不动：已发布的包名一改就是新包，别人的依赖、profile 里的
`file:`/`link:` 条目、`cordis.patch.yml` 全要跟着动。

现有插件 `dsh-lite-memory` 不改名、数据不迁移、配置不动。新的公共命名只用在分层上：

| 名字 | 角色 |
| --- | --- |
| `lite-memory-core` | `state.js` / `store.js` / `view.js` + root 解析、scope 判定、条件匹配、排序、版本/锁/校验和/归档 |
| `lite-memory`（命令） | 本机 CLI，读写都走 core，不直接碰 JSON |
| `lite-memory-mcp` | 对外的 MCP 服务：`memory_context` / `memory_search` / `memory_read` |
| `dsh-lite-memory` | DSH 适配层，内部调 core，保持现有 7 个工具签名不变 |

今天是 `index.js` 单文件入口 + 7 个工具（`memory_save` / `suggest` / `search` / `read` / `forget` / `persona` / `tune`，
见 `index.js:121` 的 `MEMORY_TOOLS`），`package.json` 没有 `bin`，也没有 stdio / MCP 出口。

有一条 HTTP 路，但它不是给外部的出口：`index.js:123` 的 `/lite-memory` 前缀路由（`index.js:3437` 注册）
由 `keepHandler` 接，先过 `sameSurface(origin, webServer.getOrigin())`，服务的是面板自己那 14 个动作
（`keep` / `undo` / `overview` / `body` / `persona` / `tune` …）。

2026-11-24 实测，对着 `http://127.0.0.1:58556/lite-memory/overview` 发 POST：

| 请求 | 响应 |
| --- | --- |
| 不带 `Origin` | `401 unauthorized` |
| `Origin: http://evil.example` | `403 forbidden` |

两个响应体都是宿主自己的单词，不是插件那套 `{ok,reason}` JSON ⇒ 拦在宿主层，插件的手都没伸到。
所以「别的 agent 拿不到」不是权限问题，是没有出口；`sameSurface` 对空 `Origin` 返回 `true`
这一条只对宿主已经放行的调用方成立，别拿它当绕过路径。

工具也不是装了插件就人人有：`desktop` 之外的 profile（`web` / `headless` / `bench`）里没有这个包，
同一个宿主里则按项目开关逐个放行——`index.js:1561 memoryOnForAgent` 判断，关掉的项目走
`syncMemoryTools` 的 `restrict({ deny: MEMORY_TOOLS })` 把这 7 个工具从该 agent 的工具面里摘掉。

## 四、身份：三类 id，不要合成一个

- `workspace_id` = `realpath(git common dir)` + 机器标识，**只在本机有效**，表示「这台机器上的这个目录」。
- `project_id` = 显式声明在 `.lite-memory/project.toml` 里的稳定 UUID，跨机器、跨 clone、跨改名都不变。
- `component_id` = monorepo 里的子项目，仓库级可向下读子目录，子目录级不能向上读。

绑定优先级：1 用户显式绑定 → 2 仓库内 `project.toml` → 3 本机绑定表 → 4 git remote（**只作候选提示**）→
5 git root（本机 workspace 兜底）→ 6 非 git 目录必须显式绑定。

remote URL 永远不能用来静默合并：fork、客户镜像、组织副本、同名内部镜像、安全分支、monorepo 里的多个产品，
这六种情况下 remote 相同但记忆不该共享。

**路径不能当权限**：scope 必须由服务端按调用方真实 cwd + 已注册 workspace + 项目绑定算出来，
调用方传上来的 `cwd` / 路径只是提示，不是授权。

## 五、权限开关（默认值按「最小可用」定）

| 开关 | 默认 | 含义 |
| --- | --- | --- |
| `memory_enabled` | 开 | 总闸 |
| `project_read_enabled` | 开 | 读本项目记忆 |
| `global_read_enabled` | 受限 | 只读「用户级稳定偏好」那一小类 |
| `project_write_enabled` | 需明确指令 | agent 推断的内容不能直接落项目记忆 |
| `global_write_enabled` | 需用户确认 | 跨项目声明才允许 |
| `auto_suggest_enabled` | 关 | 未被要求时不主动提示 |
| `sync_enabled` | 关 | 云端同步 |

界面上只露前 4 个，其余放「高级」。

## 六、召回七道闸（顺序不能换）

scope → 状态（active / 未过期 / 未换代）→ 权限 → 条件（硬过滤）→ 相关性 → 冲突 → 上下文预算
（项目最多 2 条、全局最多 1 条、合计最多 3 条，输出分组标 `[project]` / `[global]`）。

第四条是硬不变量：**语义分数永不允许跨隔离边界**。今天的代码已经是这个顺序
（`view.js:274 eligibility` → `:599 rank` 内部 `statusOf` 先筛再打分），分享时必须原样保留。

## 七、为什么写共享现在不能开

一条记忆落盘要同时过四关，外部进程绕不过其中任何一关：

| 关卡 | 位置 | 外部直改 JSON 的后果 |
| --- | --- | --- |
| 单写者锁（`wx` + owner token，只有持有者能释放） | `state.js:442` / `:500` / `:517` | 两进程同时写，后写的覆盖前写的，无报错 |
| 校验和 | `checksumOf:555`、门禁 `:698` | 手改后 `checksum` 不匹配，下次读直接硬失败「校验和不一致」 |
| 原子发布（先写 `state.prev.json`，再替换） | `publish:786` / `:790` | 半写状态被读到，条目丢失 |
| 容量闸（2 MiB、每层 1000 条 active） | `budget_exhausted:804`、`enforceBudget:848` | 越过闸门，写入静默失败或撑爆 |

`generation` / `epoch` 也在同一份状态里，直改不会有正确的递增。

**唯一正确的对外写路径**：一个持有锁的进程，调 `store.js` 的 upsert。今天这个进程只能是 DSH 宿主；
要开给别的 agent，就必须先有 `lite-memory-mcp`（stdio，单进程写，读并发）。

网络文件系统上本地锁无效，所以云端同步不能复用 `.lock`，要走 outbox 事件日志
（`eventId / entryId / scopeId / baseRevision / operation / actor / createdAt / payload`）+ 冲突队列；
`generation` 是单文件历史，不是多节点因果。正文冲突永远不允许静默合并。

## 八、明确不做的（待放行）

以下都算「新分类体系 / 新策略层 / 扩框架」，本轮约束下不开工：

- 记录上新增 `projectId / workspaceId / componentId / audience / kind / sensitivity / source / confidence`。
- `proposed` / `active` / `superseded` 三态写入协议与 `expectedRevision` 冲突返回。
- MCP / CLI 出口，`bin` 字段，包拆分。
- 短查询硬化（≥2 实词门槛、高频词降权、top1–top2 间距规则）：会动 `MATCH_FLOOR` 与排序，属于调参。
- 云端 outbox。

## 九、顺序

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 | 明确「`global` 里哪些能出机器」的判定口径（文档级，不加字段） | 归属清单可逐条判定 |
| P1 | `lite-memory-core` 抽包，行为零变化 | 现有 35 个测试文件全绿、包体棘轮不涨 |
| P2 | `lite-memory-mcp` 三个只读工具，写仍留给宿主 | 外部 agent 读通，写路径拒绝并说明 |
| P3 | CLI（`search` / `read` / `show`），只读 | 与 MCP 同口径 |
| P4 | 权限开关 + 四道防串味闸（跨项目自动注入 0、未确认条件 0、global 越权 0、冲突必须显形） | 硬样本上逐项达标，不是平均分达标 |
| P5 | 云端同步 | 另有独立设计，不在本条线下 |

## 十、今天的真实差距（不要藏）

`bench/recall-300.mjs`（75 条记忆 / 300 条查询），2026-11-23：

- Recall@3 101/120 = 84.2%（95% CI 76.6–89.6）
- 误注入 7/80 = 8.8%（95% CI 4.3–17.0）—— 七条全是「打印机 / 手机 / 快递柜」这类
  与记忆标题共享一个常用二元组、但整句说的不是同一件事。`MATCH_FLOOR` 拦不住，实测分两种成因：
  六条走 `rareTitleHit` 逃生口（查询只有一个实词对上，但那个词在语料里只出现在这一条记忆里，
  于是 `view.js:520` 保留 `titleWords`，`view.js:528` 加满 `WEIGHT.title=3`，0.33 → 3.33）；
  一条是单实词查询（「快递柜超时怎么取」切出 `快递` 一个实词，`view.js:510` 因 `distinctContent.length < 2`
  直接判 `enoughContent`，标签 `超时` 再加 `WEIGHT.keywords=4` → 5.00）。
  属已知能力边界，本轮不改阈值、不改规则。
- 换代正确率 20/30 = 66.7%（95% CI 48.8–80.8）
- 跨项目泄漏 0/30，但 CI 上界 11.4%，样本量不足以宣称「零泄漏」；同期 `deliveredAnyway: 7`。

结论：**按需检索可用，静默自动注入还没到能开给外部 agent 的程度**。
P4 的四道闸在今天的数字上都没达标，这条要写在对外说明里。
