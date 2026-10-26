-- 增量迁移：/qiu 求资源热榜的快照缓存表。可重复执行。
CREATE TABLE IF NOT EXISTS hot_rank (
  src        TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  provider   TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER NOT NULL DEFAULT 0
);
