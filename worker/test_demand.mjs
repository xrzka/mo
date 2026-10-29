/**
 * demand.js 单测：站内搜索埋点 + /api/demand 的四块聚合。
 *
 * 和 test_worker.mjs 一样，用 node:sqlite 内存库当 D1 替身跑**真实 SQL** ——
 * 这里最容易错的就是 SQL 本身（UPSERT 的冲突分支、窗口筛选、名次对比、
 * 缺口排序、时间桶），用假 Map 替身测不出来。
 *
 * 不联网：items.json 的抓取用假的 fetch 顶掉。
 * 跑法：node test_demand.mjs
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleDemand, handleSearchLog, pruneSearchEvents } from "./demand.js";

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};

/* ---------- D1 替身（与 test_worker.mjs 同款） ---------- */

function makeD1(ddlFiles = ["./schema.sql", "./schema_demand.sql"]) {
  const db = new DatabaseSync(":memory:");
  for (const f of ddlFiles) {
    db.exec(readFileSync(new URL(f, import.meta.url), "utf-8"));
  }
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    async run() {
      const r = db.prepare(sql).run(...args);
      return { meta: { changes: Number(r.changes) } };
    },
    async all() {
      return { results: db.prepare(sql).all(...args) };
    },
    async first() {
      return db.prepare(sql).get(...args) ?? null;
    },
  });
  return { _db: db, prepare: (sql) => wrap(sql) };
}

/**
 * 造一个形状合法的前端 visitor_id（跟 aicu 一样 16–64 位 URL 安全字符）。
 * 用 visitor_id 而不是 IP 来测去重，是因为 IP 兜底路径带了当天日期，
 * 测窗口的时候会不好构造。
 */
const vid = (n) => String(n).padStart(16, "0");

const post = (body, ip = "1.2.3.4") =>
  new Request("https://x/api/search/log", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });

const URL_DEMAND = new URL("https://mo-stats.pages.dev/api/demand");

const dayMs = 86400000;

/* ---------- 假 items.json ---------- */

const FAKE_ITEMS = {
  items: [
    { id: "xlsx-novel-22", name: "某本小说", section: "novel", subsection: "site" },
    { id: "gal-1", name: "某作", section: "game", subsection: "gal", adult: true },
    { id: "manual-guide-1", name: "新手指南", section: "guide" },
  ],
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).includes("items.json")) {
    return new Response(JSON.stringify(FAKE_ITEMS), { status: 200 });
  }
  return realFetch(url);
};

/* ---------- 用例 ---------- */

async function main() {
  const env = { DB: makeD1() };

  console.log("== 搜索词清洗 ==");
  for (const [raw, label] of [
    ["", "空词"],
    ["a", "1 个字"],
    ["x".repeat(41), "超长"],
    ["https://example.com", "URL"],
    [null, "非字符串"],
  ]) {
    const res = await handleSearchLog(post({ term: raw, visitor_id: vid(1) }), env);
    ok(res.status === 400, `拒绝${label}`, JSON.stringify(res.body));
  }
  {
    const res = await handleSearchLog(
      post({ term: "  一人  之下\u200b  ", visitor_id: vid(1) }),
      env
    );
    const row = env.DB._db.prepare("SELECT term FROM search_events").get();
    ok(
      res.status === 200 && row && row.term === "一人 之下",
      "清洗空白与零宽字符",
      row && row.term
    );
  }

  console.log("== 按访客去重（不是按次数计数） ==");
  env.DB._db.exec("DELETE FROM search_events");
  await handleSearchLog(post({ term: "一人之下", results: 0, visitor_id: vid(1) }), env);
  {
    const dup = await handleSearchLog(
      post({ term: "一人之下", results: 0, visitor_id: vid(1) }),
      env
    );
    const n = env.DB._db
      .prepare("SELECT COUNT(*) c FROM search_events WHERE term = ?")
      .get("一人之下").c;
    ok(dup.body.deduped === true && n === 1, "同一位访客 1 小时内重复上报被拦下", `${n} 行`);
  }
  {
    // 把时间往前挪 2 小时，1 小时去重窗口之外 → 应该真的写进去
    env.DB._db
      .prepare("UPDATE search_events SET at = at - ? WHERE term = ?")
      .run(2 * 3600 * 1000, "一人之下");
    const again = await handleSearchLog(
      post({ term: "一人之下", results: 0, visitor_id: vid(1) }),
      env
    );
    ok(again.body.deduped !== true, "超出 1 小时后同一位访客可以再报一次");
  }
  // 换访客：同一个词应该多出一行（这就是「几位访客」的来源）
  await handleSearchLog(post({ term: "一人之下", results: 5, visitor_id: vid(2) }), env);
  {
    const rows = env.DB._db
      .prepare("SELECT COUNT(*) c FROM search_events WHERE term = ?")
      .get("一人之下").c;
    ok(rows === 2, "不同访客各占一行", `${rows} 行`);
    const last = env.DB._db
      .prepare("SELECT results FROM search_events WHERE term = ? AND results > 0")
      .get("一人之下");
    ok(last && last.results === 5, "后来那次的结果覆盖到「上次结果」", JSON.stringify(last));
  }
  {
    // 同一个 IP + 同一天没有 visitor_id 时，兜底指纹应该稳定（同一个人不会算成两个）
    const bare = { DB: makeD1() };
    await handleSearchLog(post({ term: "兜底指纹", results: 1 }), bare);
    const dup = await handleSearchLog(post({ term: "兜底指纹", results: 1 }), bare);
    const n = bare.DB._db.prepare("SELECT COUNT(*) c FROM search_events").get().c;
    ok(dup.body.deduped === true && n === 1, "没带 visitor_id 时 IP+UA 兜底同样去重", `${n} 行`);
  }

  console.log("== 滑动窗口 + 热度值 + trend ==");
  {
    // 三个窗口的时间点：最近 7 天 / 前 7 天 / 再往前 7 天
    const now = Date.now();
    const recent = now - 1 * dayMs;
    const prev = now - 8 * dayMs;
    const older = now - 15 * dayMs;
    const bare = { DB: makeD1() };
    const ins = bare.DB._db.prepare(
      "INSERT INTO search_events (term, fp, at, results) VALUES (?, ?, ?, ?)"
    );
    // 三体：最近 7 天 3 位访客、都搜到 0 条 → 热度 3*2+3=9，应该是第一名
    ins.run("三体", "a1", recent, 0);
    ins.run("三体", "a2", recent, 0);
    ins.run("三体", "a3", recent, 0);
    // 进击的巨人：最近 7 天 2 位，前 7 天 5 位 → 热度 4+0=4，名次从第 1 掉到第 3
    ins.run("进击的巨人", "b1", recent, 5);
    ins.run("进击的巨人", "b2", recent, 5);
    for (let i = 0; i < 5; i++) ins.run("进击的巨人", `b9${i}`, prev, 5);
    // 海贼王：只有前 7 天有 → 不该出现在本期榜上
    for (let i = 0; i < 4; i++) ins.run("海贼王", `c${i}`, prev, 5);
    // 某冷门老片：最近 7 天 1 位、0 条 → 热度 2+1=3
    ins.run("某冷门老片", "d1", recent, 0);
    // 一人之下：最近 7 天 2 位、前 7 天 1 位 → 热度 4+1=5，名次从第 3 升到第 2
    ins.run("一人之下", "e1", recent, 3);
    ins.run("一人之下", "e2", recent, 3);
    ins.run("一人之下", "e3", prev, 3);
    // 很老的词：三个窗口之外 → 只进全量汇总，不进榜
    ins.run("很老的词", "f1", older, 2);

    const res = await handleDemand(new Request("https://x/api/demand"), URL_DEMAND, bare);
    const s = res.body.search;
    ok(res.status === 200, "整体 200");
    ok(s.window_days === 7 && s.min_visitors === 1, "回传窗口与门槛", JSON.stringify([s.window_days, s.min_visitors]));
    ok(s.terms.length === 4, "只出本期窗口有数据的词", String(s.terms.length));
    ok(
      s.terms.map((t) => t.term).join(",") === "三体,一人之下,进击的巨人,某冷门老片",
      "按热度值排序（量级为主、动量为辅）",
      s.terms.map((t) => `${t.term}:${t.hot_value}`).join(" ")
    );
    ok(
      s.terms[0].hot_value === 9 && s.terms[0].visitors === 3,
      "热度 = 访客数×2 + 动量",
      JSON.stringify(s.terms[0])
    );
    ok(
      s.terms.find((t) => t.term === "进击的巨人").trend === "down",
      "名次后移 → 下降",
      JSON.stringify(s.terms.find((t) => t.term === "进击的巨人"))
    );
    ok(s.terms.find((t) => t.term === "一人之下").trend === "up", "名次前移 → 上升");
    ok(s.terms.find((t) => t.term === "三体").trend === "up", "新进榜 → 上升");
    ok(
      !s.terms.some((t) => t.term === "海贼王") && !s.terms.some((t) => t.term === "很老的词"),
      "窗口外/仅有历史数据的词不上榜"
    );
    ok(
      s.terms.find((t) => t.term === "进击的巨人").prev_visitors === 5,
      "回传上一个窗口的访客数"
    );

    console.log("== 缺口榜 ==");
    ok(s.gaps.length === 2, "只含窗口内有人搜到 0 条的词", String(s.gaps.length));
    ok(s.gaps[0].term === "三体" && s.gaps[0].zero_visitors === 3, "按「搜了没结果的人次」排", JSON.stringify(s.gaps[0]));
    ok(s.gaps.every((g) => g.zero_visitors > 0), "缺口条目都带 zero_visitors");
    ok(
      s.gaps.every((g) => g.term !== "进击的巨人"),
      "有结果的词不进缺口榜"
    );

    console.log("== 汇总口径 ==");
    ok(s.visitors_total === 8, "窗口内人次 = 3+2+1+2", String(s.visitors_total));
    ok(s.searches === 19, "全量人次含窗口外", String(s.searches));
    ok(s.terms_total === 6, "全量表词数", String(s.terms_total));
    ok(s.gaps_total === 4, "全量 0 结果人次", String(s.gaps_total));

    console.log("== 明细保留期 ==");
    ins.run("过期词", "z1", now - 200 * dayMs, 1);
    const removed = await pruneSearchEvents(bare);
    const gone = bare.DB._db
      .prepare("SELECT COUNT(*) c FROM search_events WHERE term = ?")
      .get("过期词").c;
    const kept = bare.DB._db.prepare("SELECT COUNT(*) c FROM search_events").get().c;
    ok(removed === 1 && gone === 0, "prune 只删过期那一行", `${removed} 行`);
    ok(kept === 19, "窗口内的明细不动", `${kept} 行`);
  }

  console.log("== /api/demand：帮找榜 ==");
  {
    // 真表里 title NOT NULL 且 display 另存展示名，插入时两个都要给；
    // 列表接口读的是 display AS title。
    const ins = env.DB._db.prepare(
      `INSERT INTO requests (kind, title, display, note, status, votes, reply, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    ins.run("want", "放弃攻略女主角", "放弃攻略女主角", "", "found", 3, "", "2026-10-10T00:00:00Z");
    ins.run("want", "异人之下", "异人之下", "有人有吗", "open", 5, "去动画区看看", "2026-09-19T00:00:00Z");
    ins.run("broken", "失效的卡", "失效的卡", "", "open", 9, "", "2026-09-19T00:00:00Z");

    const res = await handleDemand(new Request("https://x/api/demand"), URL_DEMAND, env);
    const w = res.body.wanted;
    ok(w.items.length === 2, "只列 kind=want", String(w.items.length));
    ok(w.items[0].title === "异人之下" && w.items[0].votes === 5, "按票数降序",
      JSON.stringify(w.items[0]));
    ok(w.summary.want.open === 1 && w.summary.want.found === 1, "状态汇总正确",
      JSON.stringify(w.summary.want));
  }

  console.log("== /api/demand：点击榜 ==");
  {
    const ins = env.DB._db.prepare(
      "INSERT INTO clicks (period, bucket, item, n) VALUES (?, ?, ?, ?)"
    );
    const now = new Date();
    const pad2 = (n) => String(n).padStart(2, "0");
    const day = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
    ins.run("month", day.slice(0, 7), "xlsx-novel-22", 12);
    ins.run("year", day.slice(0, 4), "xlsx-novel-22", 40);
    ins.run("month", day.slice(0, 7), "gal-1", 30);
    ins.run("year", day.slice(0, 4), "manual-guide-1", 7);
    // 上个月的桶不该被算进本月
    ins.run("month", "1999-01", "xlsx-novel-22", 999);

    const res = await handleDemand(new Request("https://x/api/demand"), URL_DEMAND, env);
    const c = res.body.clicks;
    const ids = c.month.map((r) => r.id);
    ok(ids.includes("xlsx-novel-22") && !ids.includes("manual-guide-1"),
      "本月桶只含本月数据", JSON.stringify(ids));
    ok(c.month[0].n === 30, "按点击数降序", JSON.stringify(c.month[0]));
    ok(c.names["xlsx-novel-22"] && c.names["xlsx-novel-22"].name === "某本小说",
      "id 换成资源名", JSON.stringify(c.names["xlsx-novel-22"]));
    ok(c.names["gal-1"] && c.names["gal-1"].adult === true,
      "成人向条目带 adult 标记（页面据此不列出）", JSON.stringify(c.names["gal-1"]));
  }

  console.log("== 表不存在也不能 500 ==");
  {
    const bare = { DB: makeD1([]) };
    const res = await handleDemand(new Request("https://x/api/demand"), URL_DEMAND, bare);
    ok(res.status === 200, "缺表仍 200");
    ok(
      res.body.search.terms.length === 0 &&
        res.body.search.gaps.length === 0 &&
        res.body.wanted.items.length === 0 &&
        res.body.clicks.month.length === 0,
      "缺表时各块都空着"
    );
    const logged = await handleSearchLog(post({ term: "随便一个词", visitor_id: vid(3) }), bare);
    ok(logged.status === 200 && logged.body.ok === false, "缺表时记账返回 ok:false 而不是 500");
    const pruned = await pruneSearchEvents(bare);
    ok(pruned === 0, "缺表时清理返回 0 而不是抛错");
  }

  globalThis.fetch = realFetch;
  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  globalThis.fetch = realFetch;
  console.error(err);
  process.exit(1);
});
