# 0.18.82 — 安装前预检清零：4 条历史告警的处理

## 现象

`lifeguard_check` 对本仓库一直是「致命 2 · 起不来 2」，每次装 profile 前都要人肉判断这 4 条是不是真炸：
告警不清零，真问题就会淹在假问题里。

| 规则 | 位置 | 结论 |
| --- | --- | --- |
| P018 / R005 `process.exit(` | `bench/evolution.mjs:114` | 真问题，已改 |
| P010 patch 里的 name 没声明 | `cordis.patch.yml` | 真问题（写法），已改 |
| R012 ESM 里没有 require | `client.js:3` | 误报，但可消除，已改 |

## 修法

1. **`bench/evolution.mjs`**：失败分支从 `process.exit(1)` 改成 `process.exitCode = 1`，和 `bench/bench.mjs` 一致。
   退出码不变（仍然是 1），但不再有「插件接管宿主退出」的形态：基准脚本跑在宿主进程里时，杀进程等于掉会话。
2. **`cordis.patch.yml`**：`name: 'dsh-lite-memory'` 去掉引号。
   旧版 guard 用 `/^\s*name:\s*([^\s#]+)/` 抓名字，引号跟着进了名字，于是 `'dsh-lite-memory' !== dsh-lite-memory`，
   被当成「没声明的包」。去掉引号 YAML 语义不变，loader 解析结果相同。
3. **`client.js`**：前两行 loader 注入的形参 `require` 改名 `loadReq`，两处调用同步改。
   `__ModuleLoader__.load({ factory(require) {} })` 里 `require` 是 loader 按位传进来的参数名，不是 ESM 的 `require`，
   编译器规则认不出来；改名后规则不再误报，宿主调用方式是 `factory(fn)` 按位传参，行为完全不变。
   顺手把 gzip 从 47133 B 压到 47131 B。

## 棘轮基线（收紧，不是放宽）

`bench/bundle-baseline.json`：`gzipBytes 47133 → 47131`、`targetGap 6173 → 6171`。
`test/bundle.test.mjs` 要求 `targetGap` 与实测严格相等，这一步是把债记少 2 B；rawBytes 保持 188792 B 未动，
`client.js` 原始体积未增（改名等长），测试上限没有放宽。

## 验证

- `lifeguard_check .` → 预检通过，0 条；
- `npm test` 全绿（含 `bench/bundle.test.mjs`、`client.test.mjs` 24 项、`eval-hard` 8 项）；
- `node --check client.js` 通过。

## 影响面

- 运行时行为、工具定义、记忆数据格式均未变；
- `client.js` 文本变了，profile 需要重装后热重载才生效（见下）。
