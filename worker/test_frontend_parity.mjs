/**
 * 前后端桶名一致性 + 本机模式统计逻辑自测。
 *
 * app.js 是 IIFE，没法直接 import，所以这里把它里面的桶名算法和本机计数逻辑
 * 按同样的代码重新实现一遍做对照 —— 改 app.js 里那两处时必须同步改这里，
 * 否则这个测试会失效（这是它的已知局限）。
 *
 * 另外校验 data/items.json 里所有 id 都能过 Worker 的 ID_RE，
 * 否则那些条目的点击会被后端 400 掉，静默丢数。
 *
 * 跑法：node test_frontend_parity.mjs
 */
import { readFileSync } from "node:fs";
import { _internal } from "./index.js";

let fail = 0;
const check = (name, ok, extra = "") => {
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

/* --- 1. 前端桶名算法（复制自 app.js，用本地时区） --- */
const pad2 = (n) => String(n).padStart(2, "0");

function feIsoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad2(week)}`;
}

function feBuckets(now) {
  return {
    day: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
    week: feIsoWeek(now),
    month: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`,
    year: String(now.getFullYear()),
    all: "all",
  };
}

// 同一个「当地日期」在两边应算出同一组桶名。用当地正午构造，避开时区偏移跨日。
for (const [y, m, d] of [
  [2026, 0, 1],
  [2025, 11, 29],
  [2026, 11, 31],
  [2026, 7, 30],
  [2026, 7, 31],
  [2026, 5, 15],
]) {
  const local = new Date(y, m, d, 12, 0, 0);
  const utc = new Date(Date.UTC(y, m, d, 12, 0, 0));
  const a = feBuckets(local);
  const b = _internal.buckets(utc);
  const label = `${y}-${pad2(m + 1)}-${pad2(d)}`;
  check(
    `桶名一致 ${label}`,
    a.day === b.day && a.week === b.week && a.month === b.month && a.year === b.year,
    `前端=${a.day}/${a.week} 后端=${b.day}/${b.week}`
  );
}

/* --- 2. 本机模式的分桶累加与裁剪 --- */
const PERIODS = ["day", "week", "month", "year", "all"];
const KEEP = { day: 14, week: 8, month: 12, year: 3, all: 1 };

function makeLocalStats() {
  const store = {};
  return {
    store,
    bump(id, now) {
      const bk = feBuckets(now);
      PERIODS.forEach((p) => {
        const g = (store[p] = store[p] || {});
        const bucket = (g[bk[p]] = g[bk[p]] || {});
        bucket[id] = (bucket[id] || 0) + 1;
      });
      // 裁剪
      Object.keys(KEEP).forEach((p) => {
        const g = store[p];
        if (!g) return;
        const keys = Object.keys(g).sort();
        const drop = keys.length - KEEP[p];
        if (drop > 0) keys.slice(0, drop).forEach((k) => delete g[k]);
      });
    },
    collapse(now) {
      const bk = feBuckets(now);
      const out = {};
      PERIODS.forEach((p) => (out[p] = { ...((store[p] || {})[bk[p]] || {}) }));
      return out;
    },
  };
}

const s = makeLocalStats();
const t1 = new Date(2026, 7, 30, 12);
s.bump("a", t1);
s.bump("a", t1);
s.bump("b", t1);
let c = s.collapse(t1);
check("同日累加 a=2", c.day.a === 2, JSON.stringify(c.day));
check("同日累加 b=1", c.day.b === 1);
check("累计 a=2", c.all.a === 2);

// 次日：day 归零重算，month/all 继续累积
const t2 = new Date(2026, 7, 31, 12);
s.bump("a", t2);
c = s.collapse(t2);
check("次日 day.a=1", c.day.a === 1, JSON.stringify(c.day));
check("次日 month.a=3", c.month.a === 3);
check("次日 all.a=3", c.all.a === 3);
check("次日 week 切了新桶 a=1", c.week.a === 1, JSON.stringify(c.week));

// 跨月：month 归零，year/all 累积
const t3 = new Date(2026, 8, 2, 12);
s.bump("a", t3);
c = s.collapse(t3);
check("跨月 month.a=1", c.month.a === 1);
check("跨月 year.a=4", c.year.a === 4);
check("跨月 all.a=4", c.all.a === 4);

// 裁剪：连打 20 天，day 桶不超过 14 个
const s2 = makeLocalStats();
for (let i = 0; i < 20; i++) s2.bump("x", new Date(2026, 7, 1 + i, 12));
check("day 桶裁剪到 14", Object.keys(s2.store.day).length === 14, String(Object.keys(s2.store.day).length));
check("all 桶只有 1 个", Object.keys(s2.store.all).length === 1);
check("all 计数没被裁剪影响 x=20", s2.store.all.all.x === 20, String(s2.store.all.all.x));

/* --- 3. 真实数据的 id 都能过后端校验 --- */
const raw = JSON.parse(readFileSync(new URL("../data/items.json", import.meta.url), "utf-8"));
const items = Array.isArray(raw) ? raw : raw.items || [];
const bad = items.filter((it) => !_internal.ID_RE.test(it.id || ""));
check(`items.json 共 ${items.length} 条，id 全部合法`, bad.length === 0, bad.map((x) => x.id).join(","));

const dup = items.map((x) => x.id).filter((id, i, arr) => arr.indexOf(id) !== i);
check("id 无重复", dup.length === 0, dup.join(","));

console.log(fail ? `\n${fail} 项失败` : "\n全部通过");
process.exit(fail ? 1 : 0);
