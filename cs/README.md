# CS 区图片放置说明

CS 区的条目通过 `image` 字段展示图片（只展示图，不做链接型卡片）。

**把要展示的图片放进本目录（`mo_site/cs/`）**，然后在 `data/items.json` 里把对应
条目的 `image` 改为相对站根的路径，例如：

- 图片放 `cs/kk-record-1.png` → `data/items.json` 里写
  `"image": "cs/kk-record-1.png"`

站点部署在 `/mo/`，相对路径会自动解析为
`https://xrzka.github.io/mo/cs/kk-record-1.png`。

支持的图片：png / jpg / jpeg / webp / gif。

给新 CS 记录加条目的最小模板（section 固定为 `cs`）：

```json
{
  "id": "cs-xxxxxxxx",
  "name": "记录标题（会显示在图下方）",
  "section": "cs",
  "description": "一句话说明（可选）",
  "image": "cs/你的图片.png",
  "tags": [],
  "need_login": false,
  "update_info": "长期",
  "note": ""
}
```
