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

## AI 分区自动同步

AI 分区的中转站数据不要手改，它由中转站榜单站同步而来。数据源是
`../relay_board_site/data/resources.json`，改完那边跑一次：

```bash
cd mo_site
python sync_ai_section.py --dry-run   # 先看会改什么
python sync_ai_section.py             # 确认后写入
```

脚本会打印新增、移除、字段级变更明细。同步生成的条目 id 统一带 `relay-` 前缀，
脚本只覆盖这些；**其他分区，以及 AI 分区里 id 不带 `relay-` 前缀的手工条目，都不会被动。**
所以你想往 AI 分区加非中转站的资源，正常加就行，用别的 id 即可。

榜单站数据为空时脚本会中止，避免误清空整个分区。写入走临时文件再替换，
中途出错不会把 `items.json` 写坏。

## 成年 / 未成年模式

数据里带 `"adult": true` 的条目只在成年模式下显示。

- **默认未成年模式**，且刻意不做持久化 —— 每次打开页面都回到未成年模式，不记住上次选择
- 切到成年模式必须点确认弹窗（Esc 或点遮罩可取消）；关掉不需要确认
- 过滤在 `allowedItems()` 这一层统一处理，标签栏计数、小分区计数、搜索结果、顶部总数全部走它，搜索绕不过去
- 未成年模式下会提示「已隐藏 N 个成人向资源」

游戏区的标记规则在 `import_from_xlsx.py` 的 `GAME_SAFE_KEYWORDS` 里：白名单内（工具、加速器、资讯站等）不标记，**白名单之外的游戏条目一律标记为成人向**。宁可多标不可漏标，新增游戏资源时如果是正常内容，把关键词加进白名单。

## 多网盘源

同一资源常同时给百度/UC/夸克多个源，数据里用 `links` 数组表示：

```json
{
  "url": "https://drive.uc.cn/s/xxx",
  "password": "abcd",
  "links": [
    { "name": "UC 网盘", "url": "https://drive.uc.cn/s/xxx", "password": "" },
    { "name": "百度网盘", "url": "https://pan.baidu.com/s/yyy", "password": "abcd" },
    { "name": "夸克网盘", "url": "https://pan.quark.cn/s/zzz", "password": "", "label": "体验版" }
  ]
}
```

`url` / `password` 保留主源，供不读 `links` 的场景兜底。前端会给每个源渲染一个按钮，
各源的提取码分别显示在自己按钮旁边——因为不同网盘的提取码往往不一样，共用一个会给错。

只有单个源时不需要写 `links`，前端会用 `url` 自动兜底。

## xlsx 导入的解析坑

**空格子是自闭合标签。** Excel 把空单元格写成 `<c r="D5" s="6" t="s"/>`。
如果用 `<c ...>(.*?)</c>` 匹配，正则会跨过自闭合标签去找下一个 `</c>`，
把后面格子的值算到前一列上，**整行列错位**。`parse_sheet()` 里必须显式区分两种形式：

```python
r'<c r="([A-Z]+)(\d+)"([^>]*?)(?:/>|>(.*?)</c>)'
```

我第一版没处理这个，导致工具区链接全体错位一格（endgear.top 配到了别的标题上）。
修好解析后，表格其实就是规整的「A 列标题、B 列起是链接」，不需要任何偏移补偿。

改这块逻辑后务必抽查几行的列归属，再抓 URL 的 `<title>` 跟条目名对照。

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

`section` 取值：`novel` 小说、`manga` 漫画、`anime` 动画、`game` 游戏、`tool` 工具、`ai` AI、`collection` 收录。填错或留空会自动归到小说分区，不会丢卡片。

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

