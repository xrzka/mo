/**
 * 墨小说漫画 —— 点击 / 访问统计后端（Cloudflare Worker + D1）。
 *
 * 三个接口：
 *   GET  /api/stats  返回各周期 Top N 点击数 + 访问人数
 *   POST /api/hit    {"id":"资源id"}  点击 +1
 *   POST /api/visit  {}               当天访问人数 +1（按访客指纹去重）
 *
 * 设计取舍：
 * - 用 D1 而不是 KV。计数是读改写，KV 最终一致会丢数；D1 的
 *   INSERT ... ON CONFLICT DO UPDATE n = n + 1 是原子的。
 * - 访客不写 IP，只存 IP+UA+日期 的 SHA-256 前 32 位。日期当盐，
 *   跨天无法关联同一访客，也无法反查 IP。
 * - 没有鉴权，因为接口只能让计数变大，读不到隐私数据；
 *   但因此必须限制来源和频率，见 ALLOWED_ORIGINS 与 RATE_LIMIT。
 */

const PERIODS = ["day", "week", "month", "year", "all"];
const RANK_LIMIT = 20;

/** 允许跨域访问的站点。部署时改成你自己的域名。 */
const ALLOWED_ORIGINS = ["https://xrzka.github.io"];

/** 单个 IP 每分钟最多多少次写入，挡掉刷榜脚本。 */
const RATE_LIMIT = 60;

/** 资源 id 白名单字符集，防止任意字符串灌进表里把库撑大。 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

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
    h["Access-Control-Allow-Headers"] = "Content-Type";
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

/** 定时清理：seen 表只留近 400 天，否则会无限增长。 */
async function cleanup(env) {
  const cutoff = new Date(Date.now() - 400 * 86400000);
  const day = `${cutoff.getUTCFullYear()}-${pad2(cutoff.getUTCMonth() + 1)}-${pad2(cutoff.getUTCDate())}`;
  await env.DB.prepare("DELETE FROM seen WHERE day < ?").bind(day).run();
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
export const _internal = { isoWeek, buckets, PERIODS, ID_RE };
