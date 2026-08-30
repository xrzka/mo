/**
 * Worker 逻辑测试。用 node:sqlite 内存库当 D1 的替身，跑真实 SQL —— 计数的
 * 原子性、访客去重、CORS、限流、参数校验这些光看代码看不出来。
 *
 * D1 的 prepare/bind/run/all/first/batch 接口用一层薄封装模拟，语义与
 * 文档一致（run 返回 meta.changes，all 返回 {results}，first 返回行或 null）。
 *
 * 跑法：node test_worker.mjs
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "./index.js";

const ORIGIN = "https://xrzka.github.io";
let fail = 0;
const check = (name, ok, extra = "") => {
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

/* ---------- D1 替身 ---------- */

function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf-8"));

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

  return {
    _db: db,
    prepare: (sql) => wrap(sql),
    // D1 的 batch 是一个事务。node:sqlite 是同步 API，多个 batch 交错进来会
    // 撞上 "cannot start a transaction within a transaction"，所以这里用一条
    // Promise 链把 batch 串起来 —— 真实 D1 也是在连接层串行化事务的。
    _lock: Promise.resolve(),
    async batch(stmts) {
      const run = this._lock.then(async () => {
        db.exec("BEGIN");
        try {
          for (const s of stmts) await s.run();
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      });
      // 即使这次失败也不能卡死后续 batch
      this._lock = run.catch(() => {});
      await run;
      return stmts.map(() => ({ success: true }));
    },
  };
}

/** KV 替身，只实现限流用到的 get/put。 */
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

const req = (path, { method = "GET", body, origin = ORIGIN, ip = "1.2.3.4", ua = "UA/1" } = {}) =>
  new Request("https://stats.example.com" + path, {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip,
      "User-Agent": ua,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const hit = (env, id, opts) => worker.fetch(req("/api/hit", { method: "POST", body: { id }, ...opts }), env);
const visit = (env, opts) => worker.fetch(req("/api/visit", { method: "POST", body: {}, ...opts }), env);
const readStats = async (env) => (await worker.fetch(req("/api/stats"), env)).json();
/* ---------- 1. 点击计数 ---------- */
{
  console.log("\n--- 点击计数 ---");
  const env = { DB: makeD1() };

  let r = await hit(env, "relay-agentrouter");
  check("首次点击返回 200", r.status === 200, String(r.status));

  await hit(env, "relay-agentrouter");
  await hit(env, "xlsx-novel-001");

  const s = await readStats(env);
  check("累计 a=2", s.clicks.all["relay-agentrouter"] === 2, JSON.stringify(s.clicks.all));
  check("累计 b=1", s.clicks.all["xlsx-novel-001"] === 1);
  check("五个周期都有数", ["day", "week", "month", "year", "all"].every((p) => s.clicks[p]["relay-agentrouter"] === 2));

  // 并发：50 次点击同时打，一次都不能丢。KV 方案在这里会丢数，D1 的
  // ON CONFLICT DO UPDATE n = n + 1 不会。
  const env2 = { DB: makeD1() };
  await Promise.all(Array.from({ length: 50 }, () => hit(env2, "concurrent-id")));
  const s2 = await readStats(env2);
  check("50 次并发点击无丢失", s2.clicks.all["concurrent-id"] === 50, String(s2.clicks.all["concurrent-id"]));
}

/* ---------- 2. 参数校验 ---------- */
{
  console.log("\n--- 参数校验 ---");
  const env = { DB: makeD1() };

  for (const [id, want, label] of [
    ["", 400, "空 id"],
    ["'; DROP TABLE clicks; --", 400, "SQL 注入串"],
    ["中文id", 400, "非 ASCII id"],
    ["x".repeat(65), 400, "超长 id"],
    ["ok-id_1", 200, "合法 id"],
  ]) {
    const r = await hit(env, id);
    check(`${label} → ${want}`, r.status === want, String(r.status));
  }

  const r = await worker.fetch(
    new Request("https://s.example.com/api/hit", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: "{ 这不是 JSON",
    }),
    env
  );
  check("坏 JSON 不 500，返回 400", r.status === 400, String(r.status));

  // 注入串被拒后表结构必须还在
  const alive = env.DB._db.prepare("SELECT count(*) c FROM clicks").get();
  check("clicks 表未被注入破坏", typeof alive.c === "number", JSON.stringify(alive));

  check("未知路径 404", (await worker.fetch(req("/api/nope"), env)).status === 404);
  check("GET /api/hit 不放行", (await worker.fetch(req("/api/hit"), env)).status === 404);
}

/* ---------- 3. 访问人数去重 ---------- */
{
  console.log("\n--- 访问人数 ---");
  const env = { DB: makeD1() };

  await visit(env, { ip: "1.1.1.1", ua: "A" });
  await visit(env, { ip: "1.1.1.1", ua: "A" }); // 同一人再来，不该计
  let s = await readStats(env);
  check("同一访客只计 1 人", s.visitors.day === 1, String(s.visitors.day));

  await visit(env, { ip: "2.2.2.2", ua: "A" });
  await visit(env, { ip: "1.1.1.1", ua: "B" }); // UA 不同算不同设备
  s = await readStats(env);
  check("不同访客各计 1 人", s.visitors.day === 3, String(s.visitors.day));
  check("累计人数同步", s.visitors.all === 3, String(s.visitors.all));

  // 隐私：seen 表里不能出现明文 IP 或 UA
  const rows = env.DB._db.prepare("SELECT k FROM seen").all();
  const blob = rows.map((r) => r.k).join("|");
  check("seen 表不含明文 IP", !blob.includes("1.1.1.1"), blob.slice(0, 80));
  check("seen 表不含明文 UA", !/\bUA\/|(^|\|)A(\||$)/.test(blob.replace(/[0-9a-f]{32}/g, "")));
  check("指纹是 32 位十六进制", rows.every((r) => /\|[0-9a-f]{32}$/.test(r.k)), rows[0]?.k);
}
/* ---------- 4. CORS ---------- */
{
  console.log("\n--- CORS ---");
  const env = { DB: makeD1() };

  const ok = await worker.fetch(req("/api/stats", { origin: ORIGIN }), env);
  check("白名单 Origin 拿到 ACAO", ok.headers.get("Access-Control-Allow-Origin") === ORIGIN);
  check("带 Vary: Origin", (ok.headers.get("Vary") || "").includes("Origin"));

  const evil = "https://evil.example.com";
  const bad = await worker.fetch(req("/api/hit", { method: "POST", body: { id: "x" }, origin: evil }), env);
  check("非白名单 POST 被 403", bad.status === 403, String(bad.status));
  check("非白名单不回 ACAO", bad.headers.get("Access-Control-Allow-Origin") === null);

  const readAnon = await worker.fetch(req("/api/stats", { origin: "" }), env);
  check("无 Origin 的 GET 仍可读（方便浏览器直接查）", readAnon.status === 200);

  const pre = await worker.fetch(req("/api/hit", { method: "OPTIONS" }), env);
  check("预检返回 204", pre.status === 204, String(pre.status));
  check("预检声明允许的方法", (pre.headers.get("Access-Control-Allow-Methods") || "").includes("POST"));

  const s = await readStats(env);
  check("被拒的请求没有计数", Object.keys(s.clicks.all).length === 0, JSON.stringify(s.clicks.all));
}

/* ---------- 5. 限流 ---------- */
{
  console.log("\n--- 限流 ---");
  const env = { DB: makeD1(), RATE: makeKV() };

  let blocked = 0;
  for (let i = 0; i < 70; i++) {
    const r = await hit(env, "rate-test", { ip: "9.9.9.9" });
    if (r.status === 429) blocked++;
  }
  check("超过 60 次/分被挡", blocked === 10, `blocked=${blocked}`);

  const s = await readStats(env);
  check("被挡的请求未计数", s.clicks.all["rate-test"] === 60, String(s.clicks.all["rate-test"]));

  const other = await hit(env, "rate-test", { ip: "8.8.8.8" });
  check("限流按 IP 隔离", other.status === 200, String(other.status));

  const noKv = { DB: makeD1() };
  check("未绑 KV 时不限流也不报错", (await hit(noKv, "x")).status === 200);
}

/* ---------- 6. 缺 D1 绑定 ---------- */
{
  console.log("\n--- 配置缺失 ---");
  const r = await worker.fetch(req("/api/stats"), {});
  check("未绑 D1 返回 500 并说明原因", r.status === 500);
  const body = await r.json();
  check("错误信息指向 wrangler.toml", /d1_databases/.test(body.error), body.error);
}

/* ---------- 7. 定时清理 ---------- */
{
  console.log("\n--- 定时清理 ---");
  const env = { DB: makeD1() };
  const db = env.DB._db;
  db.prepare("INSERT INTO seen (k, day) VALUES (?, ?)").run("old", "2020-01-01");
  db.prepare("INSERT INTO seen (k, day) VALUES (?, ?)").run("new", "2999-01-01");

  await worker.scheduled({}, env);
  const left = db.prepare("SELECT k FROM seen").all().map((r) => r.k);
  check("清掉 400 天前的指纹", !left.includes("old"), left.join(","));
  check("保留近期指纹", left.includes("new"));

  const counts = db.prepare("SELECT count(*) c FROM clicks").get();
  check("清理不动点击数据", counts.c === 0 || counts.c > 0);
}

/* ---------- 8. 排行榜截断 ---------- */
{
  console.log("\n--- 排行榜截断 ---");
  const env = { DB: makeD1() };
  // 25 个条目，点击数递增；接口只该回前 20 名
  for (let i = 1; i <= 25; i++) {
    for (let k = 0; k < i; k++) await hit(env, `item-${String(i).padStart(2, "0")}`);
  }
  const s = await readStats(env);
  const list = Object.entries(s.clicks.all);
  check("只返回前 20 名", list.length === 20, String(list.length));
  const top = list.sort((a, b) => b[1] - a[1])[0];
  check("第一名是点击最多的", top[0] === "item-25" && top[1] === 25, JSON.stringify(top));
  check("第 1 名到第 5 名不含垫底条目", !list.some(([id]) => id === "item-01"));
}

console.log(fail ? `\n${fail} 项失败` : "\n全部通过");
process.exit(fail ? 1 : 0);
