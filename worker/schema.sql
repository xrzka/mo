-- 点击计数。period ∈ day/week/month/year/all，bucket 是具体的桶名（如 2026-08-30）。
-- 主键三元组 + ON CONFLICT 自增，所以并发点击不会丢数（KV 的读改写会丢）。
CREATE TABLE IF NOT EXISTS clicks (
  period TEXT NOT NULL,
  bucket TEXT NOT NULL,
  item   TEXT NOT NULL,
  n      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (period, bucket, item)
);

-- 排行榜查询是「取某个桶里 n 最大的 10 条」，按这个建索引
CREATE INDEX IF NOT EXISTS idx_clicks_rank ON clicks (period, bucket, n DESC);

-- 访问人数（去重后的人数，不是次数）
CREATE TABLE IF NOT EXISTS visits (
  period TEXT NOT NULL,
  bucket TEXT NOT NULL,
  n      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (period, bucket)
);

-- 访客去重表。k = period|bucket|访客指纹哈希。
-- INSERT OR IGNORE 的 changes 是否为 1，用来判断「这个桶里是不是新访客」。
CREATE TABLE IF NOT EXISTS seen (
  k     TEXT PRIMARY KEY,
  day   TEXT NOT NULL
);

-- 清理老指纹时按 day 扫
CREATE INDEX IF NOT EXISTS idx_seen_day ON seen (day);
