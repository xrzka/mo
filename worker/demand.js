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
 */

/* ---------------- 常量 ---------------- */

/** 搜索词长度下限 / 上限。太短（"a"）没信息量，太长多半是粘贴了整段话。 */
const TERM_MIN = 2;
const TERM_MAX = 40;
/** 搜索热词榜 / 缺口榜的条数。 */
const SEARCH_TOP = 60;
const GAP_TOP = 30;
/** 帮找榜条数。 */
const WANTED_LIMIT = 60;
/** 点击榜条数（月 / 年各取这么多）。 */
const CLICK_TOP = 20;
/** 同一个 IP 搜同一个词，1 小时内只记一笔 —— 让 searches 更接近「有多少人搜过」。 */
const SEARCH_DEDUP_TTL = 3600;
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

/** djb2，只用来做 KV 去重键（要 ASCII、要短）。碰撞只会少记一笔，无所谓。 */
function demandHash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

const demandNum = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/* ---------------- 写：搜索词埋点 ---------------- */

/**
 * POST /api/search/log  {term, results}
 *
 * 只记「词 + 结果数」，不记 IP、不记访客指纹 —— 这张表对外是聚合展示的，
 * 没必要留住任何能指向个人的东西。IP 只在本函数里当去重键用一下就丢。
 *
 * 去重放 KV（env.NOVEL_CACHE）而不是 D1：D1 每次写都要花钱，而这里丢几笔
 * 无所谓。KV 没绑或挂了就直接记账，不因为去重失败而丢数据。
 */
export async function handleSearchLog(request, env) {
  const body = await request.json().catch(() => ({}));
  const term = demandCleanTerm(body.term);
  if (!term) return { status: 400, body: { error: "bad term" } };

  const results = Math.min(demandNum(body.results), 9999);

  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (env.NOVEL_CACHE) {
    try {
      const key = `st:${ip}:${demandHash(term)}`;
      if (await env.NOVEL_CACHE.get(key)) {
        return { status: 200, body: { ok: true, deduped: true } };
      }
      await env.NOVEL_CACHE.put(key, "1", { expirationTtl: SEARCH_DEDUP_TTL });
    } catch (err) {
      /* KV 的问题不该让用户白搜一次，继续记 */
    }
  }

  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO search_terms (term, searches, zero_results, last_results, first_at, last_at)
       VALUES (?, 1, ?, ?, ?, ?)
       ON CONFLICT(term) DO UPDATE SET
         searches     = searches + 1,
         zero_results = zero_results + excluded.zero_results,
         last_results = excluded.last_results,
         last_at      = excluded.last_at`
    )
      .bind(term, results > 0 ? 0 : 1, results, now, now)
      .run();
  } catch (err) {
    // 表还没建：告诉调用方没记上，但不报 500（页面是 fire-and-forget，不看这个）
    return { status: 200, body: { ok: false, error: "search_terms 表不可用" } };
  }
  return { status: 200, body: { ok: true } };
}

/* ---------------- 读：各块聚合 ---------------- */

async function demandSearch(env) {
  const out = { terms: [], gaps: [], searches: 0, terms_total: 0, gaps_total: 0 };
  try {
    const { results } = await env.DB.prepare(
      `SELECT term, searches, zero_results, last_results, last_at
         FROM search_terms ORDER BY searches DESC, last_at DESC LIMIT ?`
    )
      .bind(SEARCH_TOP)
      .all();
    out.terms = (results || []).map((r) => ({
      term: r.term,
      searches: demandNum(r.searches),
      zero_results: demandNum(r.zero_results),
      last_results: demandNum(r.last_results),
      last_at: demandNum(r.last_at),
    }));
  } catch (err) {
    /* 表不存在 → 空 */
  }
  try {
    const { results } = await env.DB.prepare(
      `SELECT term, searches, zero_results, last_results, last_at
         FROM search_terms WHERE zero_results > 0
        ORDER BY searches DESC, last_at DESC LIMIT ?`
    )
      .bind(GAP_TOP)
      .all();
    out.gaps = (results || []).map((r) => ({
      term: r.term,
      searches: demandNum(r.searches),
      zero_results: demandNum(r.zero_results),
      last_results: demandNum(r.last_results),
      last_at: demandNum(r.last_at),
    }));
  } catch (err) {
    /* 同上 */
  }
  // 汇总用真实总数（列表是截断过的，别拿 length 当总数）
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) n, SUM(searches) s,
              SUM(CASE WHEN zero_results > 0 THEN 1 ELSE 0 END) g
         FROM search_terms`
    ).first();
    out.terms_total = demandNum(row && row.n);
    out.searches = demandNum(row && row.s);
    out.gaps_total = demandNum(row && row.g);
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

/**
 * 时间桶。**必须和 index.js 的 `buckets()` 对齐**，否则查出来的永远是空。
 * 这里只复刻用得上的三个（过去式：day/week/month/year + all，周桶是 ISO 周
 * 字符串 `2026-W43` 而不是周一日期，容易抄错，索性只算需要的）。
 * index.js 那边改了格式，这里要跟着改。
 */
function demandBuckets(now = new Date()) {
  const pad2 = (n) => String(n).padStart(2, "0");
  const day = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
  return {
    day,
    month: day.slice(0, 7),
    year: String(now.getUTCFullYear()),
  };
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
