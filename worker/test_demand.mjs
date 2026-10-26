/**
 * demand.js 单测：站内搜索埋点 + /api/demand 的四块聚合。
 *
 * 和 test_worker.mjs 一样，用 node:sqlite 内存库当 D1 替身跑**真实 SQL** ——
 * 这里最容易错的就是 SQL 本身（UPSERT 的累加、缺口筛选、票数排序、时间桶），
 * 用假 Map 替身测不出来。
 *
 * 不联网：items.json 的抓取用假的 fetch 顶掉。
 * 跑法：node test_demand.mjs
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleDemand, handleSearchLog } from "./demand.js";

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

/** KV 替身：只实现去重要用到的 get/put。 */
function makeKV() {
  const m = new Map();
  return {
    async get(k) {
      return m.has(k) ? m.get(k) : null;
    },
    async put(k, v) {
      m.set(k, v);
    },
    _map: m,
  };
}

const post = (body, ip = "1.2.3.4") =>
  new Request("https://x/api/search/log", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });

const URL_DEMAND = new URL("https://mo-stats.pages.dev/api/demand");

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
  const env = { DB: makeD1(), NOVEL_CACHE: makeKV() };

  console.log("== 搜索词清洗 ==");
  for (const [raw, label] of [
    ["", "空词"],
    ["a", "1 个字"],
    ["x".repeat(41), "超长"],
    ["https://example.com", "URL"],
    [null, "非字符串"],
  ]) {
    const res = await handleSearchLog(post({ term: raw }), env);
    ok(res.status === 400, `拒绝${label}`, JSON.stringify(res.body));
  }
  {
    const res = await handleSearchLog(
      post({ term: "  一人  之下\u200b  " }),
      env
    );
    const row = env.DB._db.prepare("SELECT term FROM search_terms").get();
    ok(res.status === 200 && row && row.term === "一人 之下", "清洗空白与零宽字符", row && row.term);
  }

  console.log("== 记账与去重 ==");
  env.DB._db.exec("DELETE FROM search_terms");
  await handleSearchLog(post({ term: "一人之下", results: 0 }), env);
  const dup = await handleSearchLog(post({ term: "一人之下", results: 0 }), env);
  ok(dup.body.deduped === true, "同 IP + 同词 1 小时内去重");
  {
    const row = env.DB._db
      .prepare("SELECT searches, zero_results FROM search_terms WHERE term = ?")
      .get("一人之下");
    ok(row.searches === 1 && row.zero_results === 1, "只记一笔，且标了 0 结果", JSON.stringify(row));
  }
  await handleSearchLog(post({ term: "一人之下", results: 5 }, "9.9.9.9"), env);
  {
    const row = env.DB._db
      .prepare("SELECT searches, zero_results, last_results FROM search_terms WHERE term = ?")
      .get("一人之下");
    ok(
      row.searches === 2 && row.zero_results === 1 && row.last_results === 5,
      "换 IP 累加次数，零结果数不回退，上次结果刷新",
      JSON.stringify(row)
    );
  }
  await handleSearchLog(post({ term: "进击的巨人", results: 0 }, "9.9.9.9"), env);
  await handleSearchLog(post({ term: "进击的巨人", results: 0 }, "8.8.8.8"), env);
  await handleSearchLog(post({ term: "新手指南", results: 3 }, "9.9.9.9"), env);

  console.log("== /api/demand：搜索与缺口 ==");
  {
    const res = await handleDemand(new Request("https://x/api/demand"), URL_DEMAND, env);
    ok(res.status === 200, "整体 200");
    const s = res.body.search;
    ok(s.terms.length === 3, "三个词都回来了", String(s.terms.length));
    ok(s.terms[0].term === "进击的巨人" && s.terms[0].searches === 2, "按搜索次数排序",
      JSON.stringify(s.terms[0]));
    ok(s.gaps.length === 2, "缺口只含 0 结果的词", String(s.gaps.length));
    ok(
      s.gaps.every((g) => g.zero_results > 0),
      "缺口条目都带 zero_results"
    );
    ok(s.searches === 5 && s.terms_total === 3 && s.gaps_total === 2,
      "汇总用真实总数而不是列表长度", JSON.stringify({ s: s.searches, t: s.terms_total, g: s.gaps_total }));
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
    const bare = { DB: makeD1([]), NOVEL_CACHE: makeKV() };
    const res = await handleDemand(new Request("https://x/api/demand"), URL_DEMAND, bare);
    ok(res.status === 200, "缺表仍 200");
    ok(
      res.body.search.terms.length === 0 &&
        res.body.wanted.items.length === 0 &&
        res.body.clicks.month.length === 0,
      "缺表时三块都空着"
    );
    const logged = await handleSearchLog(post({ term: "随便一个词" }), bare);
    ok(logged.status === 200 && logged.body.ok === false, "缺表时记账返回 ok:false 而不是 500");
  }

  console.log("== KV 挂了也要记账 ==");
  {
    const noKv = { DB: makeD1() };
    const res = await handleSearchLog(post({ term: "没 KV 也得记", results: 1 }), noKv);
    const row = noKv.DB._db
      .prepare("SELECT searches FROM search_terms WHERE term = ?")
      .get("没 KV 也得记");
    ok(res.status === 200 && row && row.searches === 1, "没绑 KV 时照样入账");
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
