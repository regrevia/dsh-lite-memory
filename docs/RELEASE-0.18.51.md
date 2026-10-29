# 0.18.51 — 图谱、列表、宫殿三个视图互不干扰

## 改了什么

- 三个视图各自常驻，切换按钮只切显示，任何节点点击都改不了当前视图。
- 标签筛选只作用于图谱：点 `#dsh` 只让图谱缩小到该标签，列表和宫殿保持原样。
- 搜索框只反映用户输入；图谱筛选状态是图谱里的可点掉 chip。

## 验证

- `node test/client.test.mjs` 22 passed + palace。
- `ui-copy-lint client.js` 3 error / 21 warning，与改动前同计数。
