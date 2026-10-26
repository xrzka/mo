-- 增量迁移：/qiu 真实需求看板的「站内搜索热词」表。可重复执行。
--
-- 只记「词 + 结果数」，不存 IP、不存访客指纹 —— 这张表是拿来做聚合展示的，
-- 没必要留住任何能指向个人的东西。searches 是「去重后的搜索次数」
-- （同一 IP 搜同一个词 1 小时内只记一笔，去重键在 KV 里，不落库）。
CREATE TABLE IF NOT EXISTS search_terms (
  term         TEXT PRIMARY KEY,
  searches     INTEGER NOT NULL DEFAULT 0,
  zero_results INTEGER NOT NULL DEFAULT 0,
  last_results INTEGER NOT NULL DEFAULT 0,
  first_at     INTEGER NOT NULL DEFAULT 0,
  last_at      INTEGER NOT NULL DEFAULT 0
);

-- 榜单按搜索次数排
CREATE INDEX IF NOT EXISTS idx_search_terms_searches ON search_terms(searches DESC);
