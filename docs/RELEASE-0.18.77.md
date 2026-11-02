# 0.18.77

## 记忆面板浮层不再受宿主容器影响

- 面板浮层通过 `react-dom` 的 `createPortal` 直接挂到 `document.body`，宿主 `shell.overlay` 那一层的定位和裁切不再参与面板布局；拿不到 `react-dom` 时退回原位渲染，不影响其他入口。
- 遮罩与对话框尺寸只按视口算（`100vw/100vh` 与 `calc(100vh - 48px)`），不再用 `100%` 继承外层高度。容器高度为 0 时面板也不会被压成一条。
- 「启用记忆宫殿」的浮层同样按视口定宽高。
- 回归测试锁住打开路径：点会话头图标必须把 `panelUi.open` 置真、`MemoryOverlay` 必须渲染面板本体，关掉后必须消失；同时断言遮罩与对话框用的是视口单位。

## 安装

```
npm i -g dsh-lite-memory@0.18.77
```

已装到本机 profile 的副本路径：`~/.dsh/profiles/desktop/node_modules/dsh-lite-memory`。

## 包体

`client.js` raw 186845 B、gzip 46517 B，距 40 KiB 目标还差 5557 B。本版因浮层改动上调 592 B，差额记在 `bench/bundle-baseline.json` 里作为待还的债。
