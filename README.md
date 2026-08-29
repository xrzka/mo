# 墨小说漫画

小说、漫画、动画、游戏、AI 资源分区导航。纯静态，无框架无依赖，可直接部署到 GitHub Pages。

## 文件

| 文件 | 说明 |
| --- | --- |
| `index.html` | 页面结构，卡片用 `<template>` 定义 |
| `styles.css` | 样式，深浅色主题走 CSS 变量 |
| `app.js` | 原生 JS，分区切换 + 搜索 |
| `data/items.json` | 资源数据，目前是 5 条示例 |
| `.nojekyll` | 关掉 Jekyll，静态文件原样输出 |

## 怎么加资源

编辑 `data/items.json`，在 `items` 数组里加一项：

```json
{
  "id": "唯一标识",
  "name": "资源名称",
  "section": "novel",
  "description": "一两句简介，卡片上最多显示两行",
  "url": "https://example.com/",
  "tags": ["标签1", "标签2"],
  "kind": "网站",
  "need_login": false,
  "update_info": "每日更新",
  "note": "备注，留空则不显示"
}
```

`section` 取值：`novel` 小说、`manga` 漫画、`anime` 动画、`game` 游戏、`ai` AI。填错或留空会自动归到小说分区，不会丢卡片。

`tags` 最多显示 6 个，`icon` 可选，不填则用分区默认图标。

## 加新分区

改 `app.js` 顶部的 `SECTIONS` 数组，加一项 `{ id, label, icon }`，然后数据里 `section` 用这个 id。标签栏和计数会自动出来，不用改别处。

## 本地预览

```bash
cd mo_site
python -m http.server 8899
```

必须走 HTTP，双击 `index.html` 会因 `file://` 的 CORS 限制读不到 JSON。

## 安全说明

所有文本走 `textContent` 写入，无 `innerHTML` 赋值，数据内容不会被当 HTML 执行。外链 `href` 做协议白名单，只放行 `http(s)`。

