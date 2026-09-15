# CS 区记录说明

CS 区 = 挂人/避雷记录。**每条 CS 条目的 `note` 末尾必须带【避坑建议】小节**
（怎么写才不再踩同款坑），这是站规，新增条目时照抄模板即可。

## 展示字段

- 单图：`"image": "cs/xxx.png"`（只展示图，不做链接型卡片）
- 多图（一次几条截图=一张卡）：`"images": ["cs/a.jpg","cs/b.jpg", ...]`
  → 卡片顶部画廊，点图放大（桌面两列/手机单列）
- 文字实录：直接写在 `note` 里，换行会原样保留（多行自动 pre-wrap）

**把图片放进本目录（`mo_site/cs/`）**。站点部署在 `/mo/`，相对路径解析为
`https://xrzka.github.io/mo/cs/xxx.png`。支持 png / jpg / jpeg / webp / gif。

## 新条目模板（section 固定为 `cs`）

```json
{
  "id": "cs-xxxxxxxx",
  "name": "记录标题",
  "section": "cs",
  "description": "一段话说清事件（卡片收起态可见）",
  "tags": ["挂人", "避雷"],
  "kind": "挂人 / 记录",
  "need_login": false,
  "update_info": "长期",
  "note": "【事件经过】\n1. …\n2. …\n\n【避坑建议】\n1. …\n2. …",
  "images": ["cs/a.jpg", "cs/b.jpg"]
}
```

（无图条目把 `images`/`image` 省略即可；kk 借款条目 id 为 `cs-skl-1`，
家庭维修条目 id 为 `cs-weixiu-1`。）

## 批量转录截图文字

项目根目录有 `_ocr_cs.py`（RapidOCR 本地识别，离线）：把 `cs/cs-skl-*.jpg`
逐张转录为文字，可粘进 `note`。
