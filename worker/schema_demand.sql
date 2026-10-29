-- 增量迁移：/qiu 真实需求看板的「站内搜索热词」明细表。可重复执行。
--
-- 一行 = 一位访客对某个词的有效搜索。主键 (term, fp) 就是去重：
-- 同一个人同一个词只占一行，重复搜索只更新时间与结果，**不加次数** ——
-- 一个人狂搜不该把榜刷上去。所以「一个词有几行」直接等于「几位访客想要它」，
-- 不需要额外的计数列，也就少一处会和明细对不上的地方。
--
-- 隐私：fp 是 sha256 摘要，**不存 IP、不存访客 id 原值**。优先摘要前端生成的
-- 随机 visitor_id（不含个人信息，换网络也还是同一个人）；前端没带时兜底摘要
-- IP+UA 并带上当天日期，跨天的记录无法互相关联。明细保留 90 天，由 Worker 的
-- 定时任务 pruneSearchEvents 清理。
CREATE TABLE IF NOT EXISTS search_events (
  term    TEXT    NOT NULL,
  fp      TEXT    NOT NULL,
  at      INTEGER NOT NULL DEFAULT 0,
  results INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (term, fp)
);

-- 窗口统计（`WHERE at >= ? AND at < ?`）和过期清理（`WHERE at < ?`）都走这里
CREATE INDEX IF NOT EXISTS idx_search_events_at ON search_events(at);
-- 缺口榜：窗口内 results = 0 的行
CREATE INDEX IF NOT EXISTS idx_search_events_zero ON search_events(at, results);

-- 上一版用的是「按词累计计数」的 search_terms，已被明细表取代（计数会掩盖
-- 一个人刷榜，也算不出滑动窗口）。线上那张表是空的，直接删掉，避免留着一张
-- 谁也不读、却会慢慢和明细对不上的表。
DROP TABLE IF EXISTS search_terms;
