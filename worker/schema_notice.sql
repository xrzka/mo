-- 站点级可编辑配置。目前只用来存「入站公告」：
-- 管理员在后台改总合集链接 / 提取码 / 一键解压工具链接等，值是一个 JSON 字符串，
-- 前端拿到后覆盖 index.html 里的默认文案；没有配置时页面就用写死的默认值。
--
-- 为什么要这张表：站点是纯静态的，公告原本写死在 index.html 里，改一个字就要动代码
-- 再发一次 Pages。放到 D1 后管理员自己就能改，而且和 overrides / custom_items 一样
-- 不碰仓库文件，重跑导入脚本也不会被冲掉。
CREATE TABLE IF NOT EXISTS site_config (
  key     TEXT PRIMARY KEY,
  value   TEXT NOT NULL,
  updated TEXT NOT NULL
);
