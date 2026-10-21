-- 首次写入入站公告配置：总合集链接 + 提取码。
-- 这份值和 index.html 里写死的默认值一致，等于把「当前公告内容」固化进 D1，
-- 之后管理员在后台「编辑入站公告」里改的就是这一行。
INSERT INTO site_config (key, value, updated)
VALUES (
  'notice',
  '{"totalUrl":"https://pan.baidu.com/s/1tETEPhn096H4RKxcpmKA0w?pwd=gu9g","totalPwd":"gu9g"}',
  '2026-10-20T00:00:00.000Z'
)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated;
