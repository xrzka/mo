/**
 * 墨小说漫画 —— 点击 / 访问统计 + 资源帮找与失效反馈后端（Cloudflare Worker + D1）。
 *
 * 统计接口：
 *   GET  /api/stats  返回各周期 Top N 点击数 + 访问人数
 *   POST /api/hit    {"id":"资源id"}  点击 +1
 *   POST /api/visit  {}               当天访问人数 +1（按访客指纹去重）
 *
 * 反馈接口（requests 表，用 kind 区分两类）：
 *   GET  /api/requests             列出，可带 ?kind=want|broken&status=...
 *   POST /api/requests             kind=want   {"title":"作品名","note":"..."}
 *                                  kind=broken {"item_id":"站内条目id","note":"..."}
 *   POST /api/requests/vote        {"id":123}  +1（按指纹去重）
 *
 * 设计取舍：
 * - 用 D1 而不是 KV。计数是读改写，KV 最终一致会丢数；D1 的
 *   INSERT ... ON CONFLICT DO UPDATE n = n + 1 是原子的。
 * - 访客不写 IP，只存 IP+UA+日期 的 SHA-256 前 32 位。日期当盐，
 *   跨天无法关联同一访客，也无法反查 IP。
 * - 统计接口没有鉴权，因为它只能让计数变大，读不到隐私数据。
 *   反馈接口能写入任意文本，所以额外加了长度上限、每日条数上限和
 *   控制字符过滤，见 REQ_* 常量与 sanitizeText()。
 */

const PERIODS = ["day", "week", "month", "year", "all"];
const RANK_LIMIT = 20;

/** 允许跨域访问的站点。部署时改成你自己的域名。 */
const ALLOWED_ORIGINS = ["https://xrzka.github.io"];

/** 单个 IP 每分钟最多多少次写入，挡掉刷榜脚本。 */
const RATE_LIMIT = 60;

/** 资源 id 白名单字符集，防止任意字符串灌进表里把库撑大。 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* ---------- 资源帮找 / 失效反馈的约束 ---------- */

/** 作品名与补充说明的长度上限，按字符数算（中文一个字算 1）。 */
const REQ_TITLE_MAX = 60;
const REQ_NOTE_MAX = 300;

/** 列表一次最多返回多少条。 */
const REQ_PAGE_MAX = 100;

/** 同一访客每天最多提交几条，防止刷屏。两种 kind 分别计数。 */
const REQ_PER_DAY = 5;

/** 库里最多保留多少条待处理，满了拒绝新增而不是无限膨胀。 */
const REQ_OPEN_MAX = 500;

/** 两种请求类型：want 想要没有的资源，broken 报告站内资源失效。 */
const REQ_KINDS = ["want", "broken"];

/* ---------- 管理员编辑的约束 ---------- */

/**
 * 可以被覆盖的字段。
 *
 * **故意不含 id** —— 点击数（clicks.item）与失效反馈（requests.item_id）都以
 * id 为键，改了等于把这条已有的统计和反馈全丢掉。
 *
 * section / subsection 可以改：换分区只影响它出现在哪个标签页下，
 * id 不变，所以统计和反馈都跟着走，不会丢。
 */
const OVERRIDE_FIELDS = [
  "name", "description", "url", "password", "note", "section", "subsection",
];

/** 各字段长度上限（按字符数，中文算 1）。 */
const OVERRIDE_MAX = {
  name: 120,
  description: 400,
  url: 500,
  password: 40,
  note: 1000,
  section: 32,
  subsection: 32,
};

/**
 * 分区与小分区白名单。**必须与 app.js 的 SECTIONS 保持一致** ——
 * 不一致的话，这里放行的值到前端会被 normalize() 当成无效丢弃，
 * 表现为「保存成功但分区没变」。test_sections.mjs 专门盯这件事。
 *
 * 空数组表示该分区没有小分区。
 */
const SECTION_SUBS = {
  novel: ["site", "app", "download", "kr", "jp"],
  manga: ["site", "app", "wechat", "download", "kr", "jp"],
  anime: ["site", "app"],
  game: ["site", "app", "gal"],
  music: ["site", "app", "download"],
  study: ["course", "video", "doc"],
  tool: [],
  ai: ["relay", "image", "tool"],
  forum: [],
  guide: [],
  collection: ["site", "app", "cloud", "doc", "guide"],
};

/** 新增条目的 id 前缀。挑 custom- 是因为现有 id 都是
 *  manual- / xlsx- / gal- / relay- 开头，不会撞，也便于一眼认出来源。
 *  xlsx 导入与 AI 同步脚本只重写自己前缀的条目，所以 custom- 不会被冲掉。 */
const CUSTOM_PREFIX = "custom-";

/** 后台新增条目的条数上限。防手滑刷爆库，也提示该把数据折回 items.json 了。 */
const CUSTOM_MAX_ITEMS = 300;

/** 会话有效期，12 小时。到点要重新登录，减少 token 泄露后的窗口。 */
const SESSION_HOURS = 12;

/** 同一 IP 每分钟最多试几次密码。超了直接 429，挡暴力破解。 */
const LOGIN_TRIES = 5;

/** PBKDF2 迭代次数。Worker 的 CPU 时间有限，10 万次约几十毫秒，够用。 */
const PBKDF2_ITER = 100000;

const pad2 = (n) => String(n).padStart(2, "0");

/** ISO 8601 周编号，与前端 app.js 的算法保持一致。 */
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad2(week)}`;
}

/** 各周期当前桶名。统一用 UTC —— 服务端没有「用户时区」，
 *  混用会让同一次点击落进不同的天。 */
function buckets(now = new Date()) {
  return {
    day: `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`,
    week: isoWeek(now),
    month: `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}`,
    year: String(now.getUTCFullYear()),
    all: "all",
  };
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** CORS 头。Origin 不在白名单时不回 ACAO，浏览器自己会拦。 */
function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const ok = ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin);
  const h = {
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin",
  };
  if (ok && origin) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS";
    // 后台编辑要带 Authorization 头，不放行的话浏览器预检就拦了
    h["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    h["Access-Control-Max-Age"] = "86400";
  }
  return { headers: h, allowed: ok };
}

const json = (data, request, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: corsHeaders(request).headers });

/**
 * 按 IP 限流。计数放 KV（env.RATE），没绑 KV 就跳过限流。
 * 用 KV 而不是 D1：这里丢几次计数无所谓，但不想给 D1 加写压力。
 */
async function rateLimited(env, ip) {
  if (!env.RATE || !ip) return false;
  const key = `rl:${ip}:${Math.floor(Date.now() / 60000)}`;
  const cur = Number((await env.RATE.get(key)) || 0);
  if (cur >= RATE_LIMIT) return true;
  await env.RATE.put(key, String(cur + 1), { expirationTtl: 120 });
  return false;
}

/** 点击 +1。五个周期各写一行，batch 走一次往返。 */
async function recordHit(env, id) {
  const b = buckets();
  const stmt = env.DB.prepare(
    `INSERT INTO clicks (period, bucket, item, n) VALUES (?, ?, ?, 1)
     ON CONFLICT (period, bucket, item) DO UPDATE SET n = n + 1`
  );
  await env.DB.batch(PERIODS.map((p) => stmt.bind(p, b[p], id)));
}

/**
 * 访问人数 +1。先往 seen 表 INSERT OR IGNORE 访客指纹，
 * meta.changes === 1 说明这个桶里第一次见到他，才给 visits 加数。
 * 所以 visits 是「人数」不是「次数」。
 */
async function recordVisit(env, request) {
  const b = buckets();
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ua = request.headers.get("User-Agent") || "";
  // 指纹带上当天日期，跨天的记录无法互相关联
  const fp = (await sha256Hex(`${ip}|${ua}|${b.day}`)).slice(0, 32);

  const insertSeen = env.DB.prepare("INSERT OR IGNORE INTO seen (k, day) VALUES (?, ?)");
  const bumpVisit = env.DB.prepare(
    `INSERT INTO visits (period, bucket, n) VALUES (?, ?, 1)
     ON CONFLICT (period, bucket) DO UPDATE SET n = n + 1`
  );

  for (const p of PERIODS) {
    const r = await insertSeen.bind(`${p}|${b[p]}|${fp}`, b.day).run();
    if (r.meta && r.meta.changes === 1) await bumpVisit.bind(p, b[p]).run();
  }
}

/** 各周期 Top N 点击 + 访问人数。 */
async function readStats(env) {
  const b = buckets();
  const clicks = {};
  const visitors = {};

  const rank = env.DB.prepare(
    "SELECT item, n FROM clicks WHERE period = ? AND bucket = ? ORDER BY n DESC LIMIT ?"
  );
  const vis = env.DB.prepare("SELECT n FROM visits WHERE period = ? AND bucket = ?");

  for (const p of PERIODS) {
    const { results } = await rank.bind(p, b[p], RANK_LIMIT).all();
    clicks[p] = Object.fromEntries((results || []).map((r) => [r.item, r.n]));
    const v = await vis.bind(p, b[p]).first();
    visitors[p] = v ? v.n : 0;
  }
  return { clicks, visitors, buckets: b };
}

/* ---------- 资源帮找 ---------- */

/**
 * 清洗用户提交的文本。
 * - 去掉控制字符与零宽字符（零宽字符能用来伪造「不同」的重复标题）
 * - 折叠连续空白，首尾裁剪
 * - 按字符数截断（不是字节，中文不该被腰斩）
 * 不做 HTML 转义：前端全部走 textContent，转义反而会显示成乱码。
 */
function sanitizeText(raw, max) {
  if (typeof raw !== "string") return "";
  // 必须用 \u 转义写法：把控制字符原样写进源码会破坏正则字面量。
  //
  // 两类字符处理方式不同，不能合并：
  // - 控制字符（换行、制表等）是词的分隔，替换成空格
  // - 零宽字符本身不可见，必须整个删掉。若也换成空格，「咒<ZWSP>术」会变成
  //   「咒 术」，去重键仍与「咒术」不同，绕过去重的口子就没堵上。
  const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
  const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;
  const cleaned = raw
    .replace(ZERO_WIDTH, "")
    .replace(CTRL, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...cleaned].slice(0, max).join("");
}

/** 去重键：小写 + 只保留数字、拉丁字母与中日韩文字，让「进击的巨人」和
 *  「进击的巨人！！」算同一条。
 *
 *  字符范围用 \u 转义而不是直接写汉字。之前一度以为「线上中文提交失败」是
 *  部署破坏了源码编码，实际原因是我用 bash + curl 发的测试请求 —— Git Bash
 *  的 GBK 控制台在到达 curl 之前就把中文改坏了。用 Python 显式编码 UTF-8
 *  重发即通过。转义写法仍然保留：它不依赖整条工具链的编码行为。 */
function normalizeTitle(title) {
  const KEEP = /[\u0030-\u0039\u0061-\u007a\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\u3400-\u4dbf\uf900-\ufaff]/;
  return [...title.toLowerCase()].filter((ch) => KEEP.test(ch)).join("");
}

/** 当天访客指纹。和访问统计同一套算法：日期当盐，无法反查 IP。 */
async function visitorFp(request) {
  const b = buckets();
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ua = request.headers.get("User-Agent") || "";
  return (await sha256Hex(`${ip}|${ua}|${b.day}`)).slice(0, 32);
}

/** 列出请求。kind / status 可过滤；按票数降序，同票数按新的在前。 */
async function listRequests(env, url) {
  const kind = url.searchParams.get("kind") || "";
  const status = url.searchParams.get("status") || "";
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") || "60", 10) || 60, 1),
    REQ_PAGE_MAX
  );

  const where = [];
  const args = [];
  if (REQ_KINDS.includes(kind)) {
    where.push("kind = ?");
    args.push(kind);
  }
  if (["open", "found", "closed"].includes(status)) {
    where.push("status = ?");
    args.push(status);
  }
  const clause = where.length ? "WHERE " + where.join(" AND ") : "";

  const sql =
    `SELECT id, kind, item_id, display AS title, note, status, votes, reply, created ` +
    `FROM requests ${clause} ORDER BY votes DESC, id DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...args, limit).all();

  // 汇总按 kind 分开算，前端两块面板各显示自己的计数
  const counts = await env.DB
    .prepare("SELECT kind, status, COUNT(*) c FROM requests GROUP BY kind, status")
    .all();
  const blank = () => ({ open: 0, found: 0, closed: 0 });
  const summary = { want: blank(), broken: blank() };
  (counts.results || []).forEach((r) => {
    if (summary[r.kind] && r.status in summary[r.kind]) summary[r.kind][r.status] = r.c;
  });

  return { items: results || [], summary };
}

/**
 * 新建请求。两种 kind：
 *   want   访客想要站里没有的资源，title 是作品名
 *   broken 访客报告站内某条资源失效，item_id 指向那条资源
 *
 * 重复提交不插新行，而是给已有的那条 +1 票 —— 同一部作品多人想要、
 * 同一条资源多人报失效，票数才有意义，分散成多条反而看不出热度。
 */
async function createRequest(env, request, body) {
  const kind = REQ_KINDS.includes(body.kind) ? body.kind : "want";
  const broken = kind === "broken";

  const title = sanitizeText(body.title, REQ_TITLE_MAX);
  const note = sanitizeText(body.note, REQ_NOTE_MAX);
  // item_id 是精确匹配的键，只能校验不能清洗 —— 用 sanitizeText 截断到 64
  // 会让超长 id 变成另一个合法 id，可能撞上真实条目，把反馈记到错误的资源上。
  const itemId = broken ? String(body.item_id ?? "").trim() : "";

  if (broken) {
    if (!ID_RE.test(itemId)) {
      return { status: 400, body: { error: "缺少有效的资源 id" } };
    }
  } else if (!title) {
    return { status: 400, body: { error: "作品名不能为空" } };
  }

  // 去重键：want 用标准化后的作品名，broken 用 item: 前缀 + 条目 id。
  // 两种 kind 的键空间不同，唯一索引建在 (kind, title) 上，互不干扰。
  const norm = broken ? "item:" + itemId : normalizeTitle(title);
  if (!norm || norm === "item:") {
    return { status: 400, body: { error: "作品名需要包含有效文字" } };
  }

  const fp = await visitorFp(request);
  const b = buckets();

  // 每日提交条数上限，按指纹与 kind 分别算 —— 报失效和求资源是两件事，
  // 报了 5 条失效就不能再求资源，那样太苛刻
  const mine = await env.DB
    .prepare("SELECT COUNT(*) c FROM requests WHERE fp = ? AND kind = ? AND created LIKE ?")
    .bind(fp, kind, b.day + "%")
    .first();
  if (mine && mine.c >= REQ_PER_DAY) {
    return { status: 429, body: { error: `今天已提交 ${REQ_PER_DAY} 条，明天再来吧` } };
  }

  const dup = await env.DB
    .prepare("SELECT id FROM requests WHERE kind = ? AND title = ?")
    .bind(kind, norm)
    .first();
  if (dup) {
    const voted = await voteRequest(env, request, dup.id);
    return {
      status: 200,
      body: { ok: true, id: dup.id, merged: true, voted: voted.body.ok === true },
    };
  }

  const open = await env.DB
    .prepare("SELECT COUNT(*) c FROM requests WHERE status = 'open'")
    .first();
  if (open && open.c >= REQ_OPEN_MAX) {
    return { status: 503, body: { error: "待处理的反馈太多了，等清理一批后再提交" } };
  }

  // display 存展示用的原文。broken 没填标题时用条目 id 兜底，
  // 列表上至少能看出是哪条资源。
  const display = title || itemId;
  const created = new Date().toISOString();
  const res = await env.DB
    .prepare(
      `INSERT INTO requests (kind, item_id, title, display, note, status, votes, reply, created, fp)
       VALUES (?, ?, ?, ?, ?, 'open', 1, '', ?, ?)`
    )
    .bind(kind, itemId, norm, display, note, created, fp)
    .run();

  // 提交者自己那一票也要记进去重表，否则他能再点一次 +1
  await env.DB
    .prepare("INSERT OR IGNORE INTO request_votes (k, day) VALUES (?, ?)")
    .bind(`${res.meta.last_row_id}|${fp}`, b.day)
    .run();

  return { status: 200, body: { ok: true, id: res.meta.last_row_id } };
}

/** +1（想看 / 我也遇到失效）。同一指纹对同一条只能投一次。 */
async function voteRequest(env, request, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return { status: 400, body: { error: "bad id" } };
  }

  const row = await env.DB.prepare("SELECT id FROM requests WHERE id = ?").bind(id).first();
  if (!row) return { status: 404, body: { error: "反馈不存在" } };

  const fp = await visitorFp(request);
  const b = buckets();
  const ins = await env.DB
    .prepare("INSERT OR IGNORE INTO request_votes (k, day) VALUES (?, ?)")
    .bind(`${id}|${fp}`, b.day)
    .run();

  // changes === 0 说明这个指纹已经投过了，不重复加票
  if (!ins.meta || ins.meta.changes !== 1) {
    return { status: 200, body: { ok: false, reason: "already voted" } };
  }

  await env.DB.prepare("UPDATE requests SET votes = votes + 1 WHERE id = ?").bind(id).run();
  return { status: 200, body: { ok: true } };
}

/* ---------- 管理员编辑 ---------- */

/** 随机 hex 串，用于 session token。crypto.getRandomValues 是 CSPRNG。 */
function randomHex(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * PBKDF2-SHA256 派生。存的哈希格式是 `pbkdf2$迭代次数$盐hex$派生hex`，
 * 自带参数，以后调迭代次数不会让旧哈希失效。
 */
async function pbkdf2Hex(password, saltHex, iter = PBKDF2_ITER) {
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 定长比较。逐字符异或累加，不提前 return —— 避免按耗时逐位猜出正确值。 */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 校验密码。ADMIN_PASSWORD_HASH 是 Cloudflare secret，不进 git 也不进前端。 */
async function checkPassword(env, password) {
  const stored = env.ADMIN_PASSWORD_HASH || "";
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iter = parseInt(parts[1], 10);
  if (!Number.isInteger(iter) || iter < 1000) return false;
  const got = await pbkdf2Hex(password, parts[2], iter);
  return timingSafeEqual(got, parts[3]);
}

/** 登录限流。按 IP + 分钟窗计数，只在密码错时才加，避免正常登录被自己挡住。 */
async function loginThrottled(env, ip) {
  if (!ip) return false;
  const win = String(Math.floor(Date.now() / 60000));
  const row = await env.DB
    .prepare("SELECT n, window FROM admin_throttle WHERE k = ?").bind(ip).first();
  if (!row || row.window !== win) return false;
  return row.n >= LOGIN_TRIES;
}

async function bumpLoginFail(env, ip) {
  if (!ip) return;
  const win = String(Math.floor(Date.now() / 60000));
  await env.DB.prepare(
    `INSERT INTO admin_throttle (k, n, window) VALUES (?, 1, ?)
     ON CONFLICT (k) DO UPDATE SET
       n = CASE WHEN admin_throttle.window = excluded.window THEN admin_throttle.n + 1 ELSE 1 END,
       window = excluded.window`
  ).bind(ip, win).run();
}

/** 登录，成功则发一个 12 小时有效的 session token。 */
async function adminLogin(env, request, body) {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (!env.ADMIN_PASSWORD_HASH) {
    return { status: 503, body: { error: "后台未启用（未设置 ADMIN_PASSWORD_HASH）" } };
  }
  if (await loginThrottled(env, ip)) {
    return { status: 429, body: { error: "尝试太频繁，等一分钟再试" } };
  }
  const password = typeof body.password === "string" ? body.password : "";
  if (!password || !(await checkPassword(env, password))) {
    await bumpLoginFail(env, ip);
    // 不区分「没这个用户」和「密码错」，少给一点探测信息
    return { status: 401, body: { error: "密码不对" } };
  }

  const token = randomHex(32);
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_HOURS * 3600000);
  await env.DB.prepare(
    "INSERT INTO admin_sessions (token, created, expires, ip) VALUES (?, ?, ?, ?)"
  ).bind(token, now.toISOString(), exp.toISOString(), ip).run();

  return { status: 200, body: { ok: true, token, expires: exp.toISOString() } };
}

/** 从 Authorization: Bearer 取 token 并校验。过期的顺手删掉。 */
async function adminAuth(env, request) {
  const raw = request.headers.get("Authorization") || "";
  const m = raw.match(/^Bearer\s+([0-9a-f]{64})$/i);
  if (!m) return null;
  const token = m[1].toLowerCase();
  const row = await env.DB
    .prepare("SELECT token, expires FROM admin_sessions WHERE token = ?").bind(token).first();
  if (!row) return null;
  if (new Date(row.expires).getTime() <= Date.now()) {
    await env.DB.prepare("DELETE FROM admin_sessions WHERE token = ?").bind(token).run();
    return null;
  }
  return token;
}

async function adminLogout(env, token) {
  await env.DB.prepare("DELETE FROM admin_sessions WHERE token = ?").bind(token).run();
  return { status: 200, body: { ok: true } };
}

/** 读全部覆盖。前端加载 items.json 后用它盖住原值，所以要一次全给。 */
async function listOverrides(env) {
  const cols = OVERRIDE_FIELDS.join(", ");
  const { results } = await env.DB
    .prepare(`SELECT item_id, ${cols}, updated FROM overrides ORDER BY updated DESC`)
    .all();
  const map = {};
  (results || []).forEach((r) => {
    const o = {};
    OVERRIDE_FIELDS.forEach((f) => {
      // null 表示这个字段没被覆盖，别塞进去 —— 否则前端会把原值盖成 null
      if (r[f] !== null && r[f] !== undefined) o[f] = r[f];
    });
    o.updated = r.updated;
    map[r.item_id] = o;
  });
  return { overrides: map, count: Object.keys(map).length };
}

/**
 * 保存一条覆盖。body: { item_id, fields: {name?, description?, url?, password?, note?} }
 *
 * 语义约定：
 *   字段给了字符串 -> 覆盖成这个值（空串就是「显示为空」）
 *   字段给 null    -> 撤销这一项的覆盖，回到 items.json 的原值
 *   字段没出现     -> 保持现状，不动
 */
async function saveOverride(env, body) {
  const itemId = String(body.item_id ?? "").trim();
  // 和失效反馈同一个理由：id 只校验不清洗，截断超长 id 会撞上另一条真实条目
  if (!ID_RE.test(itemId)) return { status: 400, body: { error: "缺少有效的资源 id" } };

  const fields = body.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return { status: 400, body: { error: "fields 必须是对象" } };
  }

  const unknown = Object.keys(fields).filter((k) => !OVERRIDE_FIELDS.includes(k));
  if (unknown.length) {
    // 明确报错而不是静默忽略 —— 静默会让人以为改了 id/section 却没生效
    return { status: 400, body: { error: `不可编辑的字段：${unknown.join(", ")}` } };
  }

  // 读现有覆盖，做增量更新
  const cur = await env.DB
    .prepare(`SELECT ${OVERRIDE_FIELDS.join(", ")} FROM overrides WHERE item_id = ?`)
    .bind(itemId).first();

  const next = {};
  for (const f of OVERRIDE_FIELDS) {
    if (!(f in fields)) {
      next[f] = cur ? cur[f] : null;   // 没提到就保持现状
      continue;
    }
    const v = fields[f];
    if (v === null) {
      next[f] = null;                  // 显式撤销这一项
      continue;
    }
    if (typeof v !== "string") {
      return { status: 400, body: { error: `${f} 必须是字符串或 null` } };
    }
    const clean = sanitizeText(v, OVERRIDE_MAX[f]);
    // url 额外校验：只收 http(s)，否则可能被塞 javascript: 这类伪协议
    if (f === "url" && clean && !/^https?:\/\//i.test(clean)) {
      return { status: 400, body: { error: "链接必须以 http:// 或 https:// 开头" } };
    }
    // 分区必须在白名单里。放行未知值的话前端 normalize() 会把它当无效丢弃，
    // 表现为「保存成功但分区没变」，比直接报错更难查。
    if (f === "section" && clean && !(clean in SECTION_SUBS)) {
      return { status: 400, body: { error: `未知分区：${clean}` } };
    }
    next[f] = clean;
  }

  // 小分区必须属于最终生效的那个分区。只改了 section 没改 subsection 时，
  // 老的小分区往新分区里往往不存在（漫画的 wechat 放到小说下就是无效值），
  // 这时清掉它，让条目落在新分区的「全部」里，而不是变成一个查不到的组合。
  const finalSection = next.section || (cur && cur.section) || "";
  if (finalSection) {
    const allowed = SECTION_SUBS[finalSection] || [];
    if (next.subsection && !allowed.includes(next.subsection)) {
      if ("subsection" in fields) {
        // 用户明确指定了一个不合法的小分区，报错而不是悄悄改掉他的输入
        return {
          status: 400,
          body: { error: `「${finalSection}」下没有小分区「${next.subsection}」` },
        };
      }
      next.subsection = "";
    }
  }

  // 全部字段都撤销了就删掉整行，别留一行空覆盖
  if (OVERRIDE_FIELDS.every((f) => next[f] === null)) {
    await env.DB.prepare("DELETE FROM overrides WHERE item_id = ?").bind(itemId).run();
    return { status: 200, body: { ok: true, cleared: true } };
  }

  const cols = OVERRIDE_FIELDS.join(", ");
  const marks = OVERRIDE_FIELDS.map(() => "?").join(", ");
  const sets = OVERRIDE_FIELDS.map((f) => `${f} = excluded.${f}`).join(", ");
  await env.DB.prepare(
    `INSERT INTO overrides (item_id, ${cols}, updated, by_who)
     VALUES (?, ${marks}, ?, 'admin')
     ON CONFLICT (item_id) DO UPDATE SET ${sets}, updated = excluded.updated`
  ).bind(itemId, ...OVERRIDE_FIELDS.map((f) => next[f]), new Date().toISOString()).run();

  return { status: 200, body: { ok: true, item_id: itemId } };
}

/* ---------- 管理员新增条目 ---------- */

/** 新增条目的字段上限。与覆盖层共用 name/description 等，另加 tags/kind。 */
const CUSTOM_MAX = { ...OVERRIDE_MAX, tags: 200, kind: 40 };

/** 读全部后台新增的条目，转成和 items.json 同构的形状供前端直接用。 */
async function listCustomItems(env) {
  const { results } = await env.DB
    .prepare(
      `SELECT id, name, description, url, password, note, section, subsection,
              tags, kind, adult, created, updated
       FROM custom_items ORDER BY created DESC`
    )
    .all();
  const items = (results || []).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    url: r.url,
    password: r.password,
    note: r.note,
    section: r.section,
    subsection: r.subsection || undefined,
    // D1 没有数组类型，tags 存的是逗号分隔串，这里拆回数组
    tags: r.tags ? r.tags.split(",").filter(Boolean) : [],
    kind: r.kind || undefined,
    adult: r.adult === 1,
    update_info: "后台添加",
    created: r.created,
  }));
  return { items, count: items.length };
}

/**
 * 新增一条资源。body 就是各字段，id 由后端生成。
 *
 * 不让前端指定 id：撞上 items.json 里已有的 id 会把那条顶掉，
 * 而且 id 是点击数与失效反馈的键，被覆盖等于两条资源的数据混在一起。
 */
async function createCustomItem(env, body) {
  const name = sanitizeText(body.name, CUSTOM_MAX.name);
  if (!name) return { status: 400, body: { error: "资源名不能为空" } };

  const section = sanitizeText(body.section, CUSTOM_MAX.section);
  if (!section || !(section in SECTION_SUBS)) {
    return { status: 400, body: { error: "请选择有效的分区" } };
  }

  const subsection = sanitizeText(body.subsection, CUSTOM_MAX.subsection);
  if (subsection && !(SECTION_SUBS[section] || []).includes(subsection)) {
    return { status: 400, body: { error: `「${section}」下没有小分区「${subsection}」` } };
  }

  const url = sanitizeText(body.url, CUSTOM_MAX.url);
  if (url && !/^https?:\/\//i.test(url)) {
    return { status: 400, body: { error: "链接必须以 http:// 或 https:// 开头" } };
  }

  const total = await env.DB.prepare("SELECT COUNT(*) c FROM custom_items").first();
  if (total && total.c >= CUSTOM_MAX_ITEMS) {
    return {
      status: 503,
      body: { error: `后台新增已达 ${CUSTOM_MAX_ITEMS} 条上限，先把数据折回 items.json` },
    };
  }

  // 标签按逗号/空格拆开，各自清洗，最多留 6 个（前端也只显示 6 个）
  const tags = sanitizeText(body.tags, CUSTOM_MAX.tags)
    .split(/[,，\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join(",");

  // id 里带时间戳便于排序，带随机后缀避免同一毫秒内撞车
  const id = CUSTOM_PREFIX + Date.now().toString(36) + "-" + randomHex(4);
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO custom_items
       (id, name, description, url, password, note, section, subsection,
        tags, kind, adult, created, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, name,
    sanitizeText(body.description, CUSTOM_MAX.description),
    url,
    sanitizeText(body.password, CUSTOM_MAX.password),
    sanitizeText(body.note, CUSTOM_MAX.note),
    section, subsection, tags,
    sanitizeText(body.kind, CUSTOM_MAX.kind),
    body.adult === true ? 1 : 0,
    now, now
  ).run();

  return { status: 200, body: { ok: true, id } };
}

/** 删除后台新增的条目。只能删 custom- 前缀的 —— items.json 里的条目
 *  不属于这张表，删不掉也不该从这里删（那得改仓库文件）。 */
async function deleteCustomItem(env, rawId) {
  const id = String(rawId ?? "").trim();
  if (!ID_RE.test(id) || !id.startsWith(CUSTOM_PREFIX)) {
    return { status: 400, body: { error: "只能删除后台新增的条目" } };
  }
  const res = await env.DB.prepare("DELETE FROM custom_items WHERE id = ?").bind(id).run();
  if (!res.meta || res.meta.changes !== 1) {
    return { status: 404, body: { error: "条目不存在" } };
  }
  // 顺手清掉它的覆盖，否则删了条目却留下一行孤儿覆盖
  await env.DB.prepare("DELETE FROM overrides WHERE item_id = ?").bind(id).run();
  return { status: 200, body: { ok: true, id } };
}

async function cleanup(env) {
  const cutoff = new Date(Date.now() - 400 * 86400000);
  const day = `${cutoff.getUTCFullYear()}-${pad2(cutoff.getUTCMonth() + 1)}-${pad2(cutoff.getUTCDate())}`;
  await env.DB.prepare("DELETE FROM seen WHERE day < ?").bind(day).run();
  // 投票去重键同样会累积。注意只清去重键，requests 里的票数不动 ——
  // 票数是历史累计值，清了会让老求助凭空掉票。
  await env.DB.prepare("DELETE FROM request_votes WHERE day < ?").bind(day).run();
  // 过期会话与登录失败计数也顺手清掉，两张表都只有短期意义
  await env.DB.prepare("DELETE FROM admin_sessions WHERE expires < ?")
    .bind(new Date().toISOString()).run();
  await env.DB.prepare("DELETE FROM admin_throttle WHERE window < ?")
    .bind(String(Math.floor(Date.now() / 60000) - 60)).run();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors.headers });
    }
    if (!env.DB) {
      return json({ error: "D1 未绑定，请检查 wrangler.toml 的 [[d1_databases]]" }, request, 500);
    }
    // 写接口必须来自白名单站点；读接口放开，方便你直接在浏览器里查
    if (request.method === "POST" && !cors.allowed) {
      return json({ error: "origin not allowed" }, request, 403);
    }

    try {
      if (url.pathname === "/api/stats" && request.method === "GET") {
        return json(await readStats(env), request);
      }

      if (url.pathname === "/api/hit" && request.method === "POST") {
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (await rateLimited(env, ip)) return json({ error: "too many requests" }, request, 429);

        const body = await request.json().catch(() => ({}));
        const id = typeof body.id === "string" ? body.id : "";
        if (!ID_RE.test(id)) return json({ error: "bad id" }, request, 400);

        await recordHit(env, id);
        return json({ ok: true }, request);
      }

      if (url.pathname === "/api/visit" && request.method === "POST") {
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (await rateLimited(env, ip)) return json({ error: "too many requests" }, request, 429);

        await recordVisit(env, request);
        return json({ ok: true }, request);
      }

      /* ---------- 资源帮找 / 失效反馈 ---------- */

      if (url.pathname === "/api/requests" && request.method === "GET") {
        return json(await listRequests(env, url), request);
      }

      if (url.pathname === "/api/requests" && request.method === "POST") {
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (await rateLimited(env, ip)) return json({ error: "too many requests" }, request, 429);

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object") {
          return json({ error: "bad request body" }, request, 400);
        }
        const r = await createRequest(env, request, body);
        return json(r.body, request, r.status);
      }

      if (url.pathname === "/api/requests/vote" && request.method === "POST") {
        const ip = request.headers.get("CF-Connecting-IP") || "";
        if (await rateLimited(env, ip)) return json({ error: "too many requests" }, request, 429);

        const body = await request.json().catch(() => ({}));
        const r = await voteRequest(env, request, body.id);
        return json(r.body, request, r.status);
      }

      /* ---------- 管理员编辑 ---------- */

      // 覆盖层是公开读的：每个访客都要用它盖住 items.json 的原值。
      // 里面只有站长自己写的展示文本，没有隐私。
      if (url.pathname === "/api/overrides" && request.method === "GET") {
        return json(await listOverrides(env), request);
      }

      if (url.pathname === "/api/admin/login" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const r = await adminLogin(env, request, body || {});
        return json(r.body, request, r.status);
      }

      // 以下都要带有效 token
      if (url.pathname === "/api/admin/logout" && request.method === "POST") {
        const token = await adminAuth(env, request);
        if (!token) return json({ error: "未登录或登录已过期" }, request, 401);
        const r = await adminLogout(env, token);
        return json(r.body, request, r.status);
      }

      if (url.pathname === "/api/admin/session" && request.method === "GET") {
        const token = await adminAuth(env, request);
        return json({ ok: !!token }, request, token ? 200 : 401);
      }

      if (url.pathname === "/api/admin/override" && request.method === "POST") {
        const token = await adminAuth(env, request);
        if (!token) return json({ error: "未登录或登录已过期" }, request, 401);
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object") {
          return json({ error: "bad request body" }, request, 400);
        }
        const r = await saveOverride(env, body);
        return json(r.body, request, r.status);
      }

      // 后台新增的条目。和覆盖层一样公开读 —— 访客要看到这些资源。
      if (url.pathname === "/api/items" && request.method === "GET") {
        return json(await listCustomItems(env), request);
      }

      if (url.pathname === "/api/admin/item" && request.method === "POST") {
        const token = await adminAuth(env, request);
        if (!token) return json({ error: "未登录或登录已过期" }, request, 401);
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object") {
          return json({ error: "bad request body" }, request, 400);
        }
        const r = await createCustomItem(env, body);
        return json(r.body, request, r.status);
      }

      if (url.pathname === "/api/admin/item/delete" && request.method === "POST") {
        const token = await adminAuth(env, request);
        if (!token) return json({ error: "未登录或登录已过期" }, request, 401);
        const body = await request.json().catch(() => ({}));
        const r = await deleteCustomItem(env, body.id);
        return json(r.body, request, r.status);
      }

      return json({ error: "not found" }, request, 404);
    } catch (err) {
      // 不把内部堆栈回给前端
      console.error(err);
      return json({ error: "internal error" }, request, 500);
    }
  },

  /** cron 触发的清理，见 wrangler.toml 的 [triggers]。 */
  async scheduled(event, env) {
    if (env.DB) await cleanup(env);
  },
};

// 供本地测试导入（Worker 运行时不受影响）
export const _internal = {
  isoWeek,
  buckets,
  PERIODS,
  ID_RE,
  sanitizeText,
  normalizeTitle,
  REQ_TITLE_MAX,
  REQ_NOTE_MAX,
  REQ_PER_DAY,
  REQ_OPEN_MAX,
  REQ_KINDS,
  OVERRIDE_FIELDS,
  OVERRIDE_MAX,
  SECTION_SUBS,
  CUSTOM_PREFIX,
  CUSTOM_MAX_ITEMS,
  SESSION_HOURS,
  LOGIN_TRIES,
  PBKDF2_ITER,
  pbkdf2Hex,
  timingSafeEqual,
  randomHex,
};
