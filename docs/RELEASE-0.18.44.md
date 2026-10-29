# 0.18.44 — npm 包里不再装测试

## 变化

- `package.json` 的 `files` 加 `!test`：测试留在仓库、CI 与本地 `npm test` 照常跑，只是不随 npm 包发出去。
- 依据：装到 profile 里的插件只运行 `index.js` / `store.js` / `state.js` / `view.js` / `anchor.js` / `learning.js` / `client.js`；`test/` 有 600 KB 解包体积，装完从不执行。

## 数字

| 指标 | 0.18.43 | 0.18.44 |
| --- | --- | --- |
| tarball | 377.6 KB | 249.4 KB |
| 解包 | 1.4 MB | 856.1 KB |
| 文件数 | 97 | 71 |

运行时行为、状态格式、接口与注入字节全部不变；`npm run bench` / `bench:evolution` 不受影响。测试仍在仓库：`test/` 与 CI 一个文件没少。

## 验证

- `npm test`：21 个套件全绿（改动只涉及发布文件清单）。
- `npm pack --dry-run`：71 个文件，249.4 KB，`test/` 不在清单里，`index.js`/`client.js` 等入口仍在。
