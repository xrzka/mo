/**
 * 第一站 /qiu「真实需求」数据源。
 *
 * 背景：四个平台**都不公开**「用户在搜什么资源」——它们只公开热搜（时政新闻
 * 占了绝大多数），所以光看热搜回答不了「大家想要什么资源」。真正可信的需求
 * 数据只有自己站里的行为，这个模块就把它们收成一份：
 *
 *   1. 站内搜索热词   —— mo 站搜索框埋点记下来的词（`POST /api/search/log`）
 *   2. 搜了没结果     —— 上面那些词里站内结果数为 0 的，就是「有需求没供给」的缺口
 *   3. 帮找榜         —— 用户明确提交的求助（requests 表 kind='want'），按票数
 *   4. 点击最多       —— 真实点开的资源（clicks 表），用 items.json 把 id 换成名字
 *
 * 一次 `GET /api/demand` 全给，页面只发一个请求。每一块都单独 try/catch：
 * 少一块不影响其它块，表不存在也只是那一块空着，不会 500。
 *
 * ---------------------------------------------------------------------------
 * 搜索榜的口径是照着 aicu.cc（哔哩哔哩查成分）的「用户名热搜」做的。
 * 2026-10 把它的前端 bundle 拆开看了实现（`online.aicu.cc/api/community/trending`
 * + `/search-events`），它的设计比「按历史累计次数排」合理得多，值得抄的部分：
 *
 *   - **滑动窗口 + 动量**：它算「最近 2 小时的量级 + 相对前 6 小时平均水平的动量」，
 *     量级决定基本次序、动量只做加成。我们流量小得多，所以窗口放大成
 *     近 7 天量级 + 相对前 7 天的动量（2 小时窗口在日活个位数的站上永远是空的）。
 *   - **按访客去重，不按次数**：一个人狂搜不该把榜刷上去。它「同一浏览器/网络
 *     对同一个 UID 10 分钟内最多算一次」，我们直接做到「一个人一个词只占一行」。
 *   - **上榜有门槛**：它要求「至少 5 位不同访客搜过」才上榜。我们日活个位数，
 *     门槛设 1，但把「几位访客」直接摊在页面上让站长自己判断。
 *   - **trend 是名次对比，不是猜的**：它用同一套算法再算一份 2 小时前的榜单，
 *     比较同一个 UID 在两份榜单里的名次。我们照做：跟前 7 天的榜单比名次。
 *   - **算法写在页面上**：「热搜榜算法说明」弹窗逐条写明什么算、怎么排。
 *     口径不写清楚，用户会以为数字是编的 —— 这个习惯也抄过来了（见 /qiu 的「数据口径」）。
 *
 * 有一处**故意不一样**：它只统计「查询成功的 UID」（失败的查询多半是输错或垃圾）。
 * 我们反过来 —— 「搜了但站里 0 条」恰恰是**最值钱**的信号（有人要、你没货），
 * 所以失败查询不但要记，还要单独排一个缺口榜。
 * ---------------------------------------------------------------------------
 */

/* ---------------- 常量 ---------------- */

/** 搜索词长度下限 / 上限。太短（"a"）没信息量，太长多半是粘贴了整段话。 */
const TERM_MIN = 2;
const TERM_MAX = 40;
/** 搜索榜的滑动窗口（天）与动量对比窗口（前一个等长窗口）。 */
const WINDOW_DAYS = 7;
/** 判定 trend 还要再往前看一个窗口，所以最多回溯三个窗口。 */
const WINDOW_COUNT = 3;
/**
 * 上榜门槛（窗口内至少几位访客）。aicu 用的是 5 —— 他们日活大，5 位能滤掉噪声；
 * 本站日活个位数，设 5 就永远是空榜，所以设 1，并在页面上把「几位访客」写出来。
 * 想收紧就改这里（响应里也会回传 min_visitors，页面文案跟着走）。
 */
const MIN_VISITORS = 1;
/** 同一访客对同一个词，1 小时内重复上报直接跳过 —— 省一次写，也防手抖连点。 */
const DEDUP_MS = 3600 * 1000;
/** 明细保留天数。过期的靠 cron 的 pruneSearchEvents 清掉，别让表无限长。 */
const EVENT_KEEP_DAYS = 90;
/** 前端传上来的随机 visitor_id 形状（跟 aicu 一样只收 16–64 位 URL 安全字符）。 */
const VISITOR_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** 帮找榜条数。 */
const WANTED_LIMIT = 60;
/** 点击榜条数（月 / 年各取这么多）。 */
const CLICK_TOP = 20;
/** mo 站静态数据。只用来把 clicks 里的 id 换成资源名，拿不到就只显示 id。 */
const ITEMS_URL = "https://xrzka.github.io/mo/data/items.json";

/* ---------------- 小工具 ---------------- */

/**
 * 清洗搜索词：去掉控制字符（含零宽字符）、把连续空白并成一个、首尾去空白。
 * 保留大小写与原始写法 —— 用户怎么搜的就怎么记，合并变体是后面统计的事。
 * 返回 "" 表示这个词不该记。
 */
function demandCleanTerm(raw) {
  if (typeof raw !== "string") return "";
  const term = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (term.length < TERM_MIN || term.length > TERM_MAX) return "";
  if (/^https?:\/\//i.test(term)) return "";
  return term;
}

const demandNum = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

async function demandSha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 访客身份。**只存哈希，不存原值，也不存 IP。**
 *
 * 优先用前端生成的随机 visitor_id（`localStorage` 里的 UUID，形如 aicu 的
 * `aicuCommunityVisitorId`）：它不含任何个人信息，而且换网络、换 IP 都还是同一个人
 * ——「几位不同访客搜过」才准。
 *
 * 前端没带（老缓存里的 JS、或者直接 curl）时兜底用 IP+UA，**并且带上当天日期**，
 * 跨天的记录无法互相关联（跟 index.js 的 seen 表一个口径）。代价是这种情况下
 * 同一个人隔天再搜索会算成两位，所以它只是兜底，主力是 visitor_id。
 */
async function demandVisitorKey(request, rawVisitor) {
  if (typeof rawVisitor === "string" && VISITOR_RE.test(rawVisitor)) {
    return (await demandSha256("v:" + rawVisitor)).slice(0, 32);
  }
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ua = request.headers.get("User-Agent") || "";
  const day = new Date().toISOString().slice(0, 10);
  return (await demandSha256(`h:${ip}|${ua}|${day}`)).slice(0, 32);
}

/** 时间桶。**必须和 index.js 的 `buckets()` 对齐**，否则查出来的永远是空。 */
function demandBuckets(now = new Date()) {
  const pad2 = (n) => String(n).padStart(2, "0");
  const day = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
  return {
    day,
    month: day.slice(0, 7),
    year: String(now.getUTCFullYear()),
  };
}

/* ---------------- 写：搜索词埋点 ---------------- */

/**
 * POST /api/search/log  {term, results, visitor_id?}
 *
 * 只记「词 + 有没有结果 + 一位访客」，不记 IP、不记访客身份原值 —— 这张表对外是
 * 聚合展示的，没必要留住任何能指向个人的东西。
 *
 * 写入用一条 UPSERT 搞定，去重靠主键 `(term, fp)`：
 *   - 新访客新词     → INSERT，占一行
 *   - 老访客同一个词 → 只更新时间和结果，**不加次数**（不然一个人能把榜刷上去），
 *                      并且 1 小时内重复上报直接不动（`WHERE` 挂在 DO UPDATE 上，
 *                      `meta.changes === 0` 就是被拦下了）
 * 这样表里一个词有 N 行就等于「N 位访客想要它」，不需要额外的计数列 ——
 * 少一列就少一处会和明细对不上的地方。
 */
export async function handleSearchLog(request, env) {
  const body = await request.json().catch(() => ({}));
  const term = demandCleanTerm(body.term);
  if (!term) return { status: 400, body: { error: "bad term" } };

  const results = Math.min(demandNum(body.results), 9999);
  const fp = await demandVisitorKey(request, body.visitor_id);
  const now = Date.now();

  let changes = 0;
  try {
    const res = await env.DB.prepare(
      `INSERT INTO search_events (term, fp, at, results) VALUES (?, ?, ?, ?)
       ON CONFLICT(term, fp) DO UPDATE SET
         results = excluded.results,
         at      = excluded.at
       WHERE excluded.at - search_events.at >= ?`
    )
      .bind(term, fp, now, results, DEDUP_MS)
      .run();
    changes = Number(res && res.meta && res.meta.changes) || 0;
  } catch (err) {
    // 表还没建：告诉调用方没记上，但不报 500（页面是 fire-and-forget，不看这个）
    return { status: 200, body: { ok: false, error: "search_events 表不可用" } };
  }

  // changes === 0：同一位访客 1 小时内已经报过这个词了，这次只算重复
  return { status: 200, body: changes ? { ok: true } : { ok: true, deduped: true } };
}

/* ---------------- 读：各块聚合 ---------------- */

/**
 * 搜索榜。窗口内按访客数排，动量（本窗口相对上一个窗口的增长）只做加成。
 *
 * 热度值 = 近 7 天访客数 × 2 + max(0, 近 7 天访客数 − 前 7 天访客数)
 *        = 量级(权重 2) + 动量(权重 1)
 * 跟 aicu 一个思路：量级决定基本次序（长期有人要的东西不会被一次突发挤掉），
 * 动量只把「突然被集中搜的」往前推一点。纯确定性计算，没有随机数 ——
 * 数据没变化时刷新页面，名次不会自己跳。
 */
async function demandSearch(env) {
  const out = {
    window_days: WINDOW_DAYS,
    min_visitors: MIN_VISITORS,
    terms: [],
    gaps: [],
    visitors_total: 0,
    terms_total: 0,
    gaps_total: 0,
    searches: 0,
  };

  const now = Date.now();
  const dayMs = 86400000;
  // 三个窗口从新到旧：0 = 最近 7 天，1 = 前 7 天，2 = 再往前 7 天
  const edges = [];
  for (let i = 0; i <= WINDOW_COUNT; i++) edges.push(now - i * WINDOW_DAYS * dayMs);

  const windowRows = [];
  try {
    for (let i = 0; i < WINDOW_COUNT; i++) {
      const { results } = await env.DB.prepare(
        `SELECT term,
                COUNT(*)                                     AS visitors,
                SUM(CASE WHEN results = 0 THEN 1 ELSE 0 END) AS zero_visitors
           FROM search_events
          WHERE at >= ? AND at < ?
          GROUP BY term`
      )
        .bind(edges[i + 1], edges[i])
        .all();
      const map = new Map();
      for (const row of results || []) {
        map.set(row.term, {
          visitors: demandNum(row.visitors),
          zero_visitors: demandNum(row.zero_visitors),
        });
      }
      windowRows.push(map);
    }
  } catch (err) {
    /* 表不存在 → 空榜 */
  }

  // 每个词「上次搜的时候站里几条」—— 跟时间窗无关，所以取全表最新那一行。
  // SQLite 的 bare column 规则保证 results 来自 MAX(at) 那行。
  const lastResults = new Map();
  try {
    const { results } = await env.DB.prepare(
      `SELECT term, results, MAX(at) AS last_at FROM search_events GROUP BY term`
    ).all();
    for (const row of results || []) {
      lastResults.set(row.term, {
        last_results: demandNum(row.results),
        last_at: demandNum(row.last_at),
      });
    }
  } catch (err) {
    /* 同上 */
  }

  const hotOf = (visitors, prev) => visitors * 2 + Math.max(0, visitors - prev);

  /** 按同一套算法算第 index 个窗口的榜单（index=0 是最近 7 天）。 */
  const build = (index) => {
    const cur = windowRows[index] || new Map();
    const prev = windowRows[index + 1] || new Map();
    const rows = [];
    for (const [term, c] of cur) {
      const prevV = (prev.get(term) || {}).visitors || 0;
      rows.push({
        term,
        visitors: c.visitors,
        prev_visitors: prevV,
        zero_visitors: c.zero_visitors,
        hot_value: hotOf(c.visitors, prevV),
      });
    }
    rows.sort(
      (a, b) => b.hot_value - a.hot_value || b.visitors - a.visitors || a.term.localeCompare(b.term)
    );
    return rows;
  };

  const current = build(0);
  // trend 不靠猜：拿同一套算法再算一份「前 7 天」的榜单，比较同一个词的名次
  // （aicu 的做法）。前一个窗口还没上榜的词算新进榜 → 上升。
  const prevRank = new Map();
  build(1).forEach((row, i) => prevRank.set(row.term, i + 1));
  current.forEach((row, i) => {
    const rank = i + 1;
    const was = prevRank.get(row.term);
    if (was == null || was > rank) row.trend = "up";
    else if (was < rank) row.trend = "down";
    else row.trend = "stable";
  });

  for (const row of current) {
    const extra = lastResults.get(row.term);
    row.last_results = extra ? extra.last_results : 0;
    row.last_at = extra ? extra.last_at : 0;
    // 兼容旧字段名：searches 现在就是「窗口内有几位访客」，不再是「搜了几遍」
    row.searches = row.visitors;
    row.zero_results = row.zero_visitors;
    if (row.visitors < MIN_VISITORS) continue;
    out.terms.push(row);
    if (row.zero_visitors > 0) out.gaps.push(row);
  }
  // 缺口榜按「搜了没结果的人次」排 —— 有人要却没货，补货回报最确定
  out.gaps.sort((a, b) => b.zero_visitors - a.zero_visitors || b.hot_value - a.hot_value);

  // 汇总用真实总数（列表可能被截断，别拿 length 当总数）
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) n, COUNT(DISTINCT term) t,
              SUM(CASE WHEN results = 0 THEN 1 ELSE 0 END) z
         FROM search_events`
    ).first();
    out.searches = demandNum(row && row.n);
    out.terms_total = demandNum(row && row.t);
    out.gaps_total = demandNum(row && row.z);
    const windowRow = await env.DB.prepare(
      "SELECT COUNT(*) n FROM search_events WHERE at >= ?"
    )
      .bind(edges[1])
      .first();
    out.visitors_total = demandNum(windowRow && windowRow.n);
  } catch (err) {
    /* 同上 */
  }

  return out;
}

async function demandWanted(env) {
  const out = { items: [], summary: { want: { open: 0, found: 0, closed: 0 } } };
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, display AS title, note, status, votes, reply, created
         FROM requests WHERE kind = 'want'
        ORDER BY votes DESC, id DESC LIMIT ?`
    )
      .bind(WANTED_LIMIT)
      .all();
    out.items = (results || []).map((r) => ({
      id: r.id,
      title: typeof r.title === "string" ? r.title : "",
      note: typeof r.note === "string" ? r.note : "",
      status: r.status || "open",
      votes: demandNum(r.votes),
      reply: typeof r.reply === "string" ? r.reply : "",
      created: r.created || "",
    }));
  } catch (err) {
    /* 表不存在 → 空 */
  }
  try {
    const { results } = await env.DB.prepare(
      "SELECT status, COUNT(*) c FROM requests WHERE kind = 'want' GROUP BY status"
    ).all();
    (results || []).forEach((r) => {
      if (r.status in out.summary.want) out.summary.want[r.status] = demandNum(r.c);
    });
  } catch (err) {
    /* 同上 */
  }
  return out;
}

async function demandClicks(env) {
  const buckets = demandBuckets();
  const out = { month: [], year: [], buckets };
  const ids = new Set();
  for (const period of ["month", "year"]) {
    try {
      const { results } = await env.DB.prepare(
        "SELECT item, n FROM clicks WHERE period = ? AND bucket = ? ORDER BY n DESC LIMIT ?"
      )
        .bind(period, buckets[period], CLICK_TOP)
        .all();
      out[period] = (results || []).map((r) => {
        ids.add(r.item);
        return { id: r.item, n: demandNum(r.n) };
      });
    } catch (err) {
      /* 表不存在 → 空 */
    }
  }
  out.names = await demandItemNames([...ids]);
  return out;
}

/** 把 clicks 里的 id 换成资源名。拿不到就返回空表，页面显示 id。 */
async function demandItemNames(ids) {
  if (!ids.length) return {};
  try {
    const res = await fetch(ITEMS_URL, {
      // 500KB 的静态文件，10 分钟拉一次就够；别让每个请求都去拖一遍
      cf: { cacheTtl: 600, cacheEverything: true },
      headers: { "User-Agent": "mo-stats-worker" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const payload = await res.json();
    const raw = Array.isArray(payload) ? payload : payload.items || [];
    const want = new Set(ids);
    const map = {};
    for (const item of raw) {
      if (!item || !want.has(item.id)) continue;
      map[item.id] = {
        name: String(item.name || item.id),
        section: String(item.section || ""),
        subsection: String(item.subsection || ""),
        // 成人向标记：/qiu 页面按墨站惯例不列这类条目
        adult: !!item.adult,
      };
    }
    return map;
  } catch (err) {
    return {};
  }
}

/* ---------------- 清理 ---------------- */

/** 删掉过期的搜索明细。挂在 index.js 的定时任务上（每天 03:17）。 */
export async function pruneSearchEvents(env) {
  try {
    const edge = Date.now() - EVENT_KEEP_DAYS * 86400000;
    const res = await env.DB.prepare("DELETE FROM search_events WHERE at < ?").bind(edge).run();
    return Number(res && res.meta && res.meta.changes) || 0;
  } catch (err) {
    return 0;
  }
}

/* ---------------- 入口 ---------------- */

/**
 * GET /api/demand —— /qiu 页面一次拿全。
 * 每一块都可能为空（数据少或表没建），页面按块降级显示。
 */
export async function handleDemand(request, url, env) {
  const [search, wanted, clicks] = await Promise.all([
    demandSearch(env),
    demandWanted(env),
    demandClicks(env),
  ]);
  return {
    status: 200,
    body: {
      generated_at: Date.now(),
      search,
      wanted,
      clicks,
    },
  };
}
