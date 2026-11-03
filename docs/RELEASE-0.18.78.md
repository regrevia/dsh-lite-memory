# 0.18.78 — 记忆面板真的能打开了

## 根因

0.18.77 改面板分区时删掉了「显示设置」这块状态，但换范围时重读显示设置的 `useEffect` 里还留着一句
`setShowSettings(false)`。这个标识符没有任何声明，于是每次面板取到数据后重渲染就抛
`ReferenceError: setShowSettings is not defined`。

`ReferenceError` 不是 React 的渲染期可捕获错误类型里我们能兜住的那种——它冒到 `shell.overlay` 的
slot 边界，宿主把 `lite-memory:panel` 记成坏 entry 并**永久摘除**（`abdicate`）。所以表现是：
点一次按钮什么都没发生，之后无论点多少次都不会再有反应，连报错都看不到。

## 修法

- 删掉那个失效引用。
- 面板自带本地错误边界 `PanelBoundary`：之后任何渲染错误都留在浮层里显示「这次没打开记忆面板 + 原始报错」，
  不再上传到 slot 层，也就不会被永久摘掉。边界本身只用静态样式，不调用 hooks、不发请求，避免二次抛出。

## 验证

- jsdom + 真 React 18 直接渲染 `MemoryPanel`（喂一份跟宿主同形状的 overview：41 条记忆、进化规则、归档行、
  两个范围），打开态渲染成功，`role="dialog"` 出现，0 个报错——修复前同一harness 抛 `setShowSettings is not defined`。
- 边界用例：子组件故意抛错，浮层显示兜底文案与原始 message，异常不外泄。
- `node --test test/*.mjs`：84 passed / 0 failed。

## 包体

`client.js` raw 188792 B / gzip 47133 B。比 0.18.77 增加 1947 B raw / 616 B gzip，全部来自错误边界与回归断言；
40 KiB 目标差额 6173 B 仍是待还的债，棘轮基线已同步并注明原因。
