/**
 * 资源帮找的后端逻辑测试。用 node:sqlite 内存库当 D1 的替身跑真实 SQL ——
 * 去重、限流、投票幂等这些光看代码看不出来。
 *
 * 跑法：node test_requests.mjs
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { _internal } from "./index.js";

const ORIGIN = "https://xrzka.github.io";
let fail = 0;
const check = (name, ok, extra = "") => {
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

/* ---------- D1 替身（与 test_worker.mjs 同一套） ---------- */

function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf-8"));

  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    async run() {
      const r = db.prepare(sql).run(...args);
      return {
        meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) },
      };
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
      this._lock = run.catch(() => {});
      await run;
      return stmts.map(() => ({ success: true }));
    },
  };
}

/** 不同 ip/ua 组合模拟不同访客。指纹算法带当天日期，所以同参数就是同一人。 */
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

const post = (env, path, body, opts) =>
  worker.fetch(req(path, { method: "POST", body, ...opts }), env);
const get = async (env, path) => {
  const r = await worker.fetch(req(path), env);
  return { status: r.status, data: await r.json() };
};
const create = (env, title, note = "", opts) =>
  post(env, "/api/requests", { title, note }, opts);

/** 报告站内某条资源失效。按钮在卡片上，所以 item_id 总是准确的。 */
const reportBroken = (env, itemId, title = "", opts) =>
  post(env, "/api/requests", { kind: "broken", item_id: itemId, title }, opts);
/* ---------- 1. 文本清洗与去重键 ---------- */
{
  console.log("\n--- 文本清洗 ---");
  const { sanitizeText, normalizeTitle, REQ_TITLE_MAX } = _internal;

  check("首尾空白裁掉", sanitizeText("  进击的巨人  ", 60) === "进击的巨人");
  check("连续空白折叠", sanitizeText("鬼灭   之刃", 60) === "鬼灭 之刃");
  check(
    "零宽字符被清掉",
    sanitizeText("咒​术‌回﻿战", 60) === "咒术回战",
    JSON.stringify(sanitizeText("咒​术‌回﻿战", 60))
  );
  check("换行折叠成空格", sanitizeText("上一话\n下一话", 60) === "上一话 下一话");
  check("非字符串返回空", sanitizeText(null, 60) === "" && sanitizeText(123, 60) === "");
  // 按字符数截断：中文不能被腰斩成半个字
  const long = "字".repeat(100);
  check(`超长按字符截到 ${REQ_TITLE_MAX}`, [...sanitizeText(long, REQ_TITLE_MAX)].length === REQ_TITLE_MAX);

  check("去重键忽略标点", normalizeTitle("进击的巨人！！") === normalizeTitle("进击的巨人"));
  check("去重键忽略大小写与空格", normalizeTitle("One Piece") === normalizeTitle("onepiece"));
  check("去重键保留日文假名", normalizeTitle("ワンピース").length === 5);
  check("纯标点的去重键为空", normalizeTitle("！！！???") === "");
}

/* ---------- 2. 提交与列表 ---------- */
{
  console.log("\n--- 提交与列表 ---");
  const env = { DB: makeD1() };

  let r = await create(env, "进击的巨人", "想看最终季");
  check("首次提交返回 200", r.status === 200, String(r.status));
  const created = await r.json();
  check("返回新建 id", Number.isInteger(created.id) && created.id > 0, JSON.stringify(created));

  const { status, data } = await get(env, "/api/requests");
  check("列表返回 200", status === 200);
  check("列表含 1 条", data.items.length === 1, JSON.stringify(data.items).slice(0, 120));
  const it = data.items[0];
  check("展示的是原文标题", it.title === "进击的巨人", it.title);
  check("补充说明保留", it.note === "想看最终季", it.note);
  check("初始状态 open", it.status === "open");
  check("初始票数 1", it.votes === 1, String(it.votes));
  check("汇总计数正确", data.summary.want.open === 1 && data.summary.want.found === 0,
    JSON.stringify(data.summary));
  check("不泄露提交者指纹", !("fp" in it), Object.keys(it).join(","));

  // 空标题、纯标点标题要被挡
  check("空标题被 400", (await create(env, "   ")).status === 400);
  check("纯标点标题被 400", (await create(env, "！！！")).status === 400);
  check("坏 JSON 被 400", (await post(env, "/api/requests", undefined)).status === 400);
}

/* ---------- 3. 重复提交合并成投票 ---------- */
{
  console.log("\n--- 重复提交合并 ---");
  const env = { DB: makeD1() };
  await create(env, "鬼灭之刃", "", { ip: "1.1.1.1" });

  // 不同访客提交同一部作品（带标点差异），应合并并加票而不是新建
  const r = await create(env, "鬼灭之刃！！", "", { ip: "2.2.2.2" });
  const body = await r.json();
  check("重复提交返回 merged", body.merged === true, JSON.stringify(body));

  const { data } = await get(env, "/api/requests");
  check("仍然只有 1 条", data.items.length === 1, String(data.items.length));
  check("票数涨到 2", data.items[0].votes === 2, String(data.items[0].votes));
  check("标题保留最早提交的原文", data.items[0].title === "鬼灭之刃", data.items[0].title);

  // 同一个人重复提交不该再加票
  const again = await create(env, "鬼灭之刃", "", { ip: "2.2.2.2" });
  await again.json();
  const after = await get(env, "/api/requests");
  check("同一人重复提交不加票", after.data.items[0].votes === 2, String(after.data.items[0].votes));
}
/* ---------- 4. 投票去重 ---------- */
{
  console.log("\n--- 投票去重 ---");
  const env = { DB: makeD1() };
  const r = await create(env, "咒术回战", "", { ip: "1.1.1.1" });
  const { id } = await r.json();

  // 提交者自己那一票已经记进去重表，再点不该加
  let v = await post(env, "/api/requests/vote", { id }, { ip: "1.1.1.1" });
  let vb = await v.json();
  check("提交者不能给自己再投", vb.ok === false && vb.reason === "already voted",
    JSON.stringify(vb));

  v = await post(env, "/api/requests/vote", { id }, { ip: "3.3.3.3" });
  check("其他访客可以投", (await v.json()).ok === true);

  v = await post(env, "/api/requests/vote", { id }, { ip: "3.3.3.3" });
  check("同一访客不能重复投", (await v.json()).ok === false);

  const { data } = await get(env, "/api/requests");
  check("票数为 2", data.items[0].votes === 2, String(data.items[0].votes));

  // 并发投票：10 个不同访客同时投，票数必须正好 +10
  const env2 = { DB: makeD1() };
  const r2 = await create(env2, "海贼王", "", { ip: "9.9.9.9" });
  const { id: id2 } = await r2.json();
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      post(env2, "/api/requests/vote", { id: id2 }, { ip: `10.0.0.${i}` })
    )
  );
  const d2 = await get(env2, "/api/requests");
  check("10 个并发投票不丢不重", d2.data.items[0].votes === 11,
    String(d2.data.items[0].votes));

  check("投不存在的 id 返回 404",
    (await post(env, "/api/requests/vote", { id: 99999 })).status === 404);
  check("坏 id 返回 400",
    (await post(env, "/api/requests/vote", { id: "abc" })).status === 400);
  check("负数 id 返回 400",
    (await post(env, "/api/requests/vote", { id: -1 })).status === 400);
}

/* ---------- 5. 每日提交上限 ---------- */
{
  console.log("\n--- 每日提交上限 ---");
  const env = { DB: makeD1() };
  const { REQ_PER_DAY } = _internal;

  let blocked = 0;
  for (let i = 0; i < REQ_PER_DAY + 3; i++) {
    const r = await create(env, `作品${i}`, "", { ip: "7.7.7.7" });
    if (r.status === 429) blocked++;
  }
  check(`超过 ${REQ_PER_DAY} 条被挡`, blocked === 3, `blocked=${blocked}`);

  const { data } = await get(env, "/api/requests");
  check(`库里只有 ${REQ_PER_DAY} 条`, data.items.length === REQ_PER_DAY,
    String(data.items.length));

  // 换个访客不受影响
  check("换访客可以继续提交",
    (await create(env, "别人的作品", "", { ip: "8.8.8.8" })).status === 200);
}

/* ---------- 6. 排序与状态过滤 ---------- */
{
  console.log("\n--- 排序与过滤 ---");
  const env = { DB: makeD1() };
  const ids = [];
  for (const [i, t] of ["甲", "乙", "丙"].entries()) {
    const r = await create(env, t, "", { ip: `20.0.0.${i}` });
    ids.push((await r.json()).id);
  }
  // 给「丙」投 3 票，让它排到最前
  for (let i = 0; i < 3; i++) {
    await post(env, "/api/requests/vote", { id: ids[2] }, { ip: `30.0.0.${i}` });
  }
  let { data } = await get(env, "/api/requests");
  check("按票数降序", data.items[0].title === "丙", data.items.map((x) => x.title).join(","));

  // 手动把「甲」标成已找到，测状态过滤
  env.DB._db.prepare("UPDATE requests SET status='found', reply='已加到漫画区' WHERE id=?").run(ids[0]);

  data = (await get(env, "/api/requests?status=open")).data;
  check("过滤 open 排除已找到", !data.items.some((x) => x.title === "甲"),
    data.items.map((x) => x.title).join(","));

  data = (await get(env, "/api/requests?status=found")).data;
  check("过滤 found 只剩 1 条", data.items.length === 1 && data.items[0].title === "甲");
  check("已找到的带回复", data.items[0].reply === "已加到漫画区", data.items[0].reply);

  data = (await get(env, "/api/requests")).data;
  check("汇总区分状态", data.summary.want.open === 2 && data.summary.want.found === 1,
    JSON.stringify(data.summary));

  // limit 上限保护
  data = (await get(env, "/api/requests?limit=99999")).data;
  check("limit 超界不报错", Array.isArray(data.items));
  data = (await get(env, "/api/requests?limit=abc")).data;
  check("limit 非数字不报错", Array.isArray(data.items));
}
/* ---------- 7. 安全：注入、XSS 载荷、CORS ---------- */
{
  console.log("\n--- 安全 ---");
  const env = { DB: makeD1() };

  // SQL 注入串：走的是 bind 参数，不该破坏表结构
  const inj = "'; DROP TABLE requests; --";
  const r = await create(env, inj, "", { ip: "40.0.0.1" });
  check("注入串按普通文本存下", r.status === 200, String(r.status));
  const alive = env.DB._db.prepare("SELECT COUNT(*) c FROM requests").get();
  check("requests 表未被破坏", typeof alive.c === "number" && alive.c >= 1,
    JSON.stringify(alive));

  // XSS 载荷：后端原样存，前端靠 textContent 渲染，所以这里只验证没被吞掉也没执行的可能
  const xss = '<img src=x onerror=alert(1)>';
  await create(env, xss, "<script>alert(2)</script>", { ip: "40.0.0.2" });
  const { data } = await get(env, "/api/requests");
  const found = data.items.find((x) => x.title.includes("img"));
  check("XSS 载荷原样存储（前端用 textContent 渲染）",
    found && found.title === xss, found ? found.title : "未找到");

  // 超长输入被截断而不是报错
  const huge = "长".repeat(5000);
  const rr = await create(env, huge, huge, { ip: "40.0.0.3" });
  check("超长输入不报错", rr.status === 200, String(rr.status));
  const d2 = await get(env, "/api/requests");
  const big = d2.data.items.find((x) => x.title.startsWith("长"));
  check(`标题截到 ${_internal.REQ_TITLE_MAX} 字`,
    big && [...big.title].length === _internal.REQ_TITLE_MAX,
    big ? String([...big.title].length) : "未找到");
  check(`说明截到 ${_internal.REQ_NOTE_MAX} 字`,
    big && [...big.note].length === _internal.REQ_NOTE_MAX,
    big ? String([...big.note].length) : "未找到");

  // CORS：写接口只接受白名单来源
  const evil = "https://evil.example.com";
  check("非白名单提交被 403",
    (await create(env, "坏来源", "", { origin: evil })).status === 403);
  check("非白名单投票被 403",
    (await post(env, "/api/requests/vote", { id: 1 }, { origin: evil })).status === 403);
  const readAnon = await worker.fetch(req("/api/requests", { origin: "" }), env);
  check("读接口不限来源", readAnon.status === 200, String(readAnon.status));
}

/* ---------- 8. 限流与定时清理 ---------- */
{
  console.log("\n--- 限流与清理 ---");
  const kv = () => {
    const m = new Map();
    return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); } };
  };
  const env = { DB: makeD1(), RATE: kv() };

  let blocked = 0;
  for (let i = 0; i < 70; i++) {
    const r = await post(env, "/api/requests/vote", { id: 1 }, { ip: "50.0.0.1" });
    if (r.status === 429) blocked++;
  }
  check("投票走 IP 限流", blocked === 10, `blocked=${blocked}`);

  // 清理：老的投票去重键要清，但票数不能动
  const env2 = { DB: makeD1() };
  const c = await create(env2, "老求助", "", { ip: "60.0.0.1" });
  const { id } = await c.json();
  await post(env2, "/api/requests/vote", { id }, { ip: "60.0.0.2" });
  env2.DB._db.prepare("UPDATE request_votes SET day='2020-01-01'").run();

  const before = env2.DB._db.prepare("SELECT votes FROM requests WHERE id=?").get(id);
  await worker.scheduled({}, env2);
  const left = env2.DB._db.prepare("SELECT COUNT(*) c FROM request_votes").get();
  const after = env2.DB._db.prepare("SELECT votes FROM requests WHERE id=?").get(id);
  check("清掉过期投票去重键", left.c === 0, String(left.c));
  check("票数不受清理影响", after.votes === before.votes,
    `${before.votes} -> ${after.votes}`);
}

/* ---------- 9. 失效反馈（kind=broken） ---------- */
{
  console.log("\n--- 失效反馈：基本流程 ---");
  const env = { DB: makeD1() };

  let r = await reportBroken(env, "manual-manga-2", "G社漫画");
  check("首次反馈返回 200", r.status === 200, String(r.status));
  const body = await r.json();
  check("返回新建 id", Number.isInteger(body.id) && body.id > 0, JSON.stringify(body));

  const { data } = await get(env, "/api/requests");
  check("列表含 1 条", data.items.length === 1, String(data.items.length));
  const it = data.items[0];
  check("kind 是 broken", it.kind === "broken", it.kind);
  check("记下了失效的条目 id", it.item_id === "manual-manga-2", it.item_id);
  check("展示名用传入的标题", it.title === "G社漫画", it.title);
  check("初始状态 open", it.status === "open");
  check("初始票数 1", it.votes === 1, String(it.votes));
  check("不泄露提交者指纹", !("fp" in it), Object.keys(it).join(","));

  // 汇总按 kind 分开
  check("汇总里 broken.open = 1", data.summary.broken.open === 1,
    JSON.stringify(data.summary));
  check("汇总里 want 仍为 0", data.summary.want.open === 0);
}

/* ---------- 10. 缺 item_id / 坏 item_id ---------- */
{
  console.log("\n--- 失效反馈：参数校验 ---");
  const env = { DB: makeD1() };

  check("缺 item_id 被 400",
    (await post(env, "/api/requests", { kind: "broken", title: "某资源" })).status === 400);
  check("空 item_id 被 400", (await reportBroken(env, "")).status === 400);
  check("注入串 item_id 被 400",
    (await reportBroken(env, "'; DROP TABLE requests; --")).status === 400);
  check("非 ASCII item_id 被 400", (await reportBroken(env, "中文id")).status === 400);
  check("超长 item_id 被 400", (await reportBroken(env, "x".repeat(65))).status === 400);
  check("合法 item_id 通过", (await reportBroken(env, "manual-novel-4")).status === 200);

  const alive = env.DB._db.prepare("SELECT COUNT(*) c FROM requests").get();
  check("requests 表未被注入破坏", alive.c === 1, JSON.stringify(alive));

  // 没传标题时用 item_id 兜底，列表上至少能看出是哪条
  const { data } = await get(env, "/api/requests");
  check("无标题时展示名回落到 item_id", data.items[0].title === "manual-novel-4",
    data.items[0].title);
}

/* ---------- 11. 两类去重互不干扰 ---------- */
{
  console.log("\n--- 两类去重互不干扰 ---");
  const env = { DB: makeD1() };

  // 同一条资源被多人报失效 → 合并加票
  await reportBroken(env, "manual-manga-2", "G社漫画", { ip: "1.1.1.1" });
  const dup = await reportBroken(env, "manual-manga-2", "G社漫画", { ip: "2.2.2.2" });
  const dupBody = await dup.json();
  check("同一条资源重复反馈合并", dupBody.merged === true, JSON.stringify(dupBody));

  let { data } = await get(env, "/api/requests?kind=broken");
  check("broken 仍只有 1 条", data.items.length === 1, String(data.items.length));
  check("票数涨到 2", data.items[0].votes === 2, String(data.items[0].votes));

  // 关键：want 用同名标题提交，不该和 broken 那条撞去重键
  const w = await create(env, "G社漫画", "", { ip: "3.3.3.3" });
  const wBody = await w.json();
  check("want 用同名不被误判为重复", wBody.merged !== true, JSON.stringify(wBody));

  data = (await get(env, "/api/requests")).data;
  check("库里现在两条", data.items.length === 2, String(data.items.length));
  const kinds = data.items.map((x) => x.kind).sort();
  check("两条 kind 分别是 broken 与 want", kinds.join(",") === "broken,want", kinds.join(","));

  data = (await get(env, "/api/requests?kind=want")).data;
  check("按 kind=want 过滤只剩 1 条", data.items.length === 1 && data.items[0].kind === "want");
  data = (await get(env, "/api/requests?kind=broken")).data;
  check("按 kind=broken 过滤只剩 1 条", data.items.length === 1 && data.items[0].kind === "broken");
}

/* ---------- 12. 每日上限按 kind 分开算 ---------- */
{
  console.log("\n--- 每日上限按 kind 分开 ---");
  const env = { DB: makeD1() };
  const { REQ_PER_DAY } = _internal;
  const ip = "7.7.7.7";

  // 先把 broken 的额度用满
  let blocked = 0;
  for (let i = 0; i < REQ_PER_DAY + 2; i++) {
    const r = await reportBroken(env, `item-${i}`, `资源${i}`, { ip });
    if (r.status === 429) blocked++;
  }
  check(`broken 超过 ${REQ_PER_DAY} 条被挡`, blocked === 2, `blocked=${blocked}`);

  // 同一个人的 want 额度不该被 broken 吃掉 —— 报失效和求资源是两件事
  const w = await create(env, "另一部作品", "", { ip });
  check("broken 用满后 want 仍可提交", w.status === 200, String(w.status));

  const { data } = await get(env, "/api/requests");
  check(`broken 恰好 ${REQ_PER_DAY} 条`,
    data.items.filter((x) => x.kind === "broken").length === REQ_PER_DAY);
  check("want 有 1 条", data.items.filter((x) => x.kind === "want").length === 1);
}

/* ---------- 13. 投票与状态流转 ---------- */
{
  console.log("\n--- 失效反馈：投票与状态 ---");
  const env = { DB: makeD1() };
  const r = await reportBroken(env, "manual-novel-6", "wenku8", { ip: "1.1.1.1" });
  const { id } = await r.json();

  // 提交者自己那一票已记入，不能再投
  let v = await post(env, "/api/requests/vote", { id }, { ip: "1.1.1.1" });
  check("提交者不能给自己再投", (await v.json()).ok === false);

  v = await post(env, "/api/requests/vote", { id }, { ip: "9.9.9.9" });
  check("其他人可以投「我也遇到失效」", (await v.json()).ok === true);

  let { data } = await get(env, "/api/requests");
  check("票数为 2", data.items[0].votes === 2, String(data.items[0].votes));

  // 站长补档后标 found 并写回复
  env.DB._db
    .prepare("UPDATE requests SET status='found', reply='已换新链接' WHERE id=?")
    .run(id);

  data = (await get(env, "/api/requests?kind=broken&status=open")).data;
  check("补档后不在 open 列表", data.items.length === 0, String(data.items.length));

  data = (await get(env, "/api/requests?kind=broken&status=found")).data;
  check("出现在 found 列表", data.items.length === 1);
  check("带上补档回复", data.items[0].reply === "已换新链接", data.items[0].reply);

  data = (await get(env, "/api/requests")).data;
  check("汇总反映状态变化",
    data.summary.broken.found === 1 && data.summary.broken.open === 0,
    JSON.stringify(data.summary.broken));
}

/* ---------- 14. kind 非法值回落 ---------- */
{
  console.log("\n--- kind 非法值处理 ---");
  const env = { DB: makeD1() };

  // 未知 kind 一律当 want 处理，而不是报错 —— 老客户端不传 kind 也要能用
  const r = await post(env, "/api/requests", { kind: "nonsense", title: "某作品" });
  check("未知 kind 回落成 want", r.status === 200, String(r.status));
  let { data } = await get(env, "/api/requests");
  check("落库的 kind 是 want", data.items[0].kind === "want", data.items[0].kind);

  // 不传 kind（老前端的行为）也走 want
  const r2 = await post(env, "/api/requests", { title: "另一部作品" });
  check("不传 kind 也当 want", r2.status === 200);
  data = (await get(env, "/api/requests")).data;
  check("两条都是 want", data.items.every((x) => x.kind === "want"));

  // 非法 kind 过滤参数应被忽略，返回全部而不是空
  data = (await get(env, "/api/requests?kind=bogus")).data;
  check("非法 kind 过滤被忽略", data.items.length === 2, String(data.items.length));
}

console.log(fail ? `\n${fail} 项失败` : "\n全部通过");
process.exit(fail ? 1 : 0);
