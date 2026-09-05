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
-- 资源帮找 / 失效反馈：同一张表，用 kind 区分
-- ---------------------------------------------------------------

-- kind:   want   访客想要站里没有的资源
--         broken 访客报告站内某条资源失效了，需要补档
-- status: open 待处理 / found 已补上或已找到 / closed 已关闭（找不到或不再需要）
--
-- title 存去重键，display 存展示用的原文：
--   want   -> title = 标准化后的作品名
--   broken -> title = 'item:' + 站内条目 id
-- 两种 kind 的去重键空间不同，所以唯一索引建在 (kind, title) 上。
--
-- item_id 只对 broken 有意义，记是哪条资源失效了，便于直接定位去修。
-- fp 是提交者指纹（IP+UA+日期的哈希），只用于限流与滥用排查，无法反查 IP。
CREATE TABLE IF NOT EXISTS requests (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  kind    TEXT NOT NULL DEFAULT 'want',
  item_id TEXT NOT NULL DEFAULT '',
  title   TEXT NOT NULL,
  display TEXT NOT NULL DEFAULT '',
  note    TEXT NOT NULL DEFAULT '',
  status  TEXT NOT NULL DEFAULT 'open',
  votes   INTEGER NOT NULL DEFAULT 1,
  reply   TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  fp      TEXT NOT NULL DEFAULT ''
);

-- 列表页按「类型 + 状态 + 票数」排
CREATE INDEX IF NOT EXISTS idx_requests_list ON requests (kind, status, votes DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_requests_created ON requests (created);
CREATE INDEX IF NOT EXISTS idx_requests_item ON requests (item_id);

-- 重复提交的去重键。两种 kind 各自独立，所以是联合唯一索引。
CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_norm ON requests (kind, title);

-- 「+1」去重。k = 请求 id | 访客指纹
CREATE TABLE IF NOT EXISTS request_votes (
  k   TEXT PRIMARY KEY,
  day TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_request_votes_day ON request_votes (day);

-- ---------------------------------------------------------------
-- 管理员编辑：条目字段覆盖层
-- ---------------------------------------------------------------

-- 站点是纯静态的，浏览器改不了 data/items.json。所以后台编辑不写文件，
-- 而是把「改成什么」存在这里，前端加载时用它盖住 items.json 里的原值。
--
-- 这样做还有个必要理由：import_from_xlsx.py 会重新生成 xlsx-* / gal-*
-- 那五百多条，直接改 items.json 的话下次重跑导入就全被冲掉了，覆盖层不会。
--
-- item_id 对应 items.json 里的条目 id，也是主键 —— 一条资源只有一份覆盖。
-- **id 不可覆盖**：点击数（clicks.item）与失效反馈（requests.item_id）都以它
-- 为键，改了等于把这条已有的统计和反馈全丢掉。
-- section / subsection 可以覆盖：换分区只影响它出现在哪个标签页下，id 不变，
-- 所以统计和反馈都跟着走。
-- 值为 NULL 表示该字段不覆盖，用原值；空字符串是有意义的覆盖（清空该字段）。
CREATE TABLE IF NOT EXISTS overrides (
  item_id  TEXT PRIMARY KEY,
  name     TEXT,
  description TEXT,
  url      TEXT,
  password TEXT,
  note     TEXT,
  section     TEXT,
  subsection  TEXT,
  updated  TEXT NOT NULL,
  by_who   TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_overrides_updated ON overrides (updated);

-- ---------------------------------------------------------------
-- 管理员新增：后台加的条目
-- ---------------------------------------------------------------

-- 后台新增的资源存这里，前端加载时接在 items.json 后面一起渲染。
-- 和覆盖层同一个理由：纯静态站改不了仓库文件，而且重跑导入会冲掉手改。
--
-- id 由后端生成（custom-<时间戳>-<随机>），不让前端指定 —— 前端能指定 id 的话，
-- 撞上 items.json 里已有的 id 会让那条被顶掉。
-- 字段与 items.json 的结构对齐，tags 存逗号分隔的字符串（D1 没有数组类型）。
CREATE TABLE IF NOT EXISTS custom_items (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  url      TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '',
  note     TEXT NOT NULL DEFAULT '',
  section  TEXT NOT NULL,
  subsection TEXT NOT NULL DEFAULT '',
  tags     TEXT NOT NULL DEFAULT '',
  kind     TEXT NOT NULL DEFAULT '',
  adult    INTEGER NOT NULL DEFAULT 0,
  created  TEXT NOT NULL,
  updated  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_custom_items_created ON custom_items (created);
CREATE INDEX IF NOT EXISTS idx_custom_items_section ON custom_items (section, subsection);

-- 管理员会话。密码只以 PBKDF2 哈希形式存在 Cloudflare secret 里，不进这张表。
-- token 是随机 32 字节的 hex，expires 是 ISO 时间串，过期由 cron 清理。
CREATE TABLE IF NOT EXISTS admin_sessions (
  token   TEXT PRIMARY KEY,
  created TEXT NOT NULL,
  expires TEXT NOT NULL,
  ip      TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions (expires);

-- 登录失败计数，用于挡暴力破解。k = ip，window 是分钟级时间窗。
CREATE TABLE IF NOT EXISTS admin_throttle (
  k       TEXT PRIMARY KEY,
  n       INTEGER NOT NULL DEFAULT 0,
  window  TEXT NOT NULL
);

