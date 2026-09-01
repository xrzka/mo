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

-- ---------------------------------------------------------------
-- 资源帮找：匿名留言想看的作品
-- ---------------------------------------------------------------

-- status: open 待找 / found 已找到 / closed 已关闭（找不到或不合适）
-- title 存标准化后的去重键，display 存用户输入的原文。
-- fp 是提交者指纹（IP+UA+日期的哈希），只用于限流与滥用排查，无法反查 IP。
CREATE TABLE IF NOT EXISTS requests (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  title   TEXT NOT NULL,
  display TEXT NOT NULL DEFAULT '',
  note    TEXT NOT NULL DEFAULT '',
  status  TEXT NOT NULL DEFAULT 'open',
  votes   INTEGER NOT NULL DEFAULT 1,
  reply   TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  fp      TEXT NOT NULL DEFAULT ''
);

-- 列表页按「状态 + 票数」排，两个方向都建上
CREATE INDEX IF NOT EXISTS idx_requests_list ON requests (status, votes DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_requests_created ON requests (created);

-- 同一作品重复提交的去重键：标准化后的标题
CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_norm ON requests (title);

-- 「+1 想看」去重。k = 请求 id | 访客指纹
CREATE TABLE IF NOT EXISTS request_votes (
  k   TEXT PRIMARY KEY,
  day TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_request_votes_day ON request_votes (day);
