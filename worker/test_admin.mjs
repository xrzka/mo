/**
 * 管理员编辑（覆盖层）的后端逻辑测试。用 node:sqlite 内存库当 D1 的替身跑真实 SQL。
 *
 * 重点盯鉴权：这是站上第一个「能改内容」的接口，之前所有写操作都只能让计数变大。
 * 所以未登录、假 token、过期 token、越权字段、伪协议链接都得逐条验。
 *
 * 跑法：node test_admin.mjs
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import worker, { _internal } from "./index.js";

const ORIGIN = "https://xrzka.github.io";
const PASSWORD = "correct-horse-battery";
let fail = 0;
const check = (name, ok, extra = "") => {
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

/* ---------- D1 替身（与 test_requests.mjs 同一套） ---------- */
function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf-8"));
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    async run() {
      const r = db.prepare(sql).run(...args);
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async first() { return db.prepare(sql).get(...args) ?? null; },
  });
  return { _db: db, prepare: (sql) => wrap(sql), async batch(s) { for (const x of s) await x.run(); return s.map(() => ({ success: true })); } };
}

/** 用 node 的 pbkdf2 造出和 Worker 端格式一致的哈希。 */
function makeHash(password, iter = 1000) {
  const salt = randomBytes(16);
  const h = pbkdf2Sync(password, salt, iter, 32, "sha256");
  return `pbkdf2$${iter}$${salt.toString("hex")}$${h.toString("hex")}`;
}

const newEnv = (opts = {}) => ({
  DB: makeD1(),
  ADMIN_PASSWORD_HASH: "ADMIN_PASSWORD_HASH" in opts ? opts.ADMIN_PASSWORD_HASH : makeHash(PASSWORD),
});

const req = (path, { method = "GET", body, origin = ORIGIN, ip = "1.2.3.4", token } = {}) => {
  const headers = { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": ip };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("https://stats.example.com" + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
};
const call = async (env, path, opts) => {
  const r = await worker.fetch(req(path, opts), env);
  return { status: r.status, data: await r.json() };
};
const login = (env, password, opts) =>
  call(env, "/api/admin/login", { method: "POST", body: { password }, ...opts });
const save = (env, token, item_id, fields) =>
  call(env, "/api/admin/override", { method: "POST", token, body: { item_id, fields } });

/* ---------- 1. 登录 ---------- */
{
  console.log("\n--- 登录 ---");
  const env = newEnv();

  let r = await login(env, "wrong-password");
  check("密码错返回 401", r.status === 401, String(r.status));
  check("不泄露内部信息", r.data.error === "密码不对", JSON.stringify(r.data));

  r = await login(env, PASSWORD);
  check("密码对返回 200", r.status === 200, String(r.status));
  check("发了 token", typeof r.data.token === "string" && r.data.token.length === 64,
        String(r.data.token && r.data.token.length));
  check("带了过期时间", !!Date.parse(r.data.expires || ""), String(r.data.expires));

  const hours = (Date.parse(r.data.expires) - Date.now()) / 3600000;
  check(`有效期约 ${_internal.SESSION_HOURS} 小时`,
        Math.abs(hours - _internal.SESSION_HOURS) < 0.1, hours.toFixed(2));

  // 两次登录应得到不同 token
  const r2 = await login(env, PASSWORD);
  check("每次登录 token 不同", r2.data.token !== r.data.token);

  // 空密码不能当成「没设密码」放过去
  r = await login(env, "");
  check("空密码被拒", r.status === 401, String(r.status));
}

/* ---------- 2. 没设 secret 时整块关闭 ---------- */
{
  console.log("\n--- 未配置 ADMIN_PASSWORD_HASH ---");
  const env = newEnv({ ADMIN_PASSWORD_HASH: "" });
  const r = await login(env, "anything");
  check("返回 503 而不是放行", r.status === 503, String(r.status));
  check("说明原因", String(r.data.error).includes("未启用"), JSON.stringify(r.data));

  // 任意密码都不该通过
  const r2 = await login(env, "");
  check("空密码也不放行", r2.status === 503, String(r2.status));
}

/* ---------- 3. 登录限流 ---------- */
{
  console.log("\n--- 登录限流 ---");
  const env = newEnv();
  const ip = "9.9.9.9";
  let blocked = 0;
  for (let i = 0; i < _internal.LOGIN_TRIES + 3; i++) {
    const r = await login(env, "nope", { ip });
    if (r.status === 429) blocked++;
  }
  check("连续试错会被 429 挡住", blocked >= 2, `blocked=${blocked}`);

  // 被限流期间即使密码正确也进不来 —— 这是有意的，别给暴力破解留缝
  const r = await login(env, PASSWORD, { ip });
  check("限流期内正确密码也挡", r.status === 429, String(r.status));

  // 换个 IP 不受影响
  const other = await login(env, PASSWORD, { ip: "8.8.8.8" });
  check("其他 IP 不受影响", other.status === 200, String(other.status));
}

/* ---------- 4. 鉴权 ---------- */
{
  console.log("\n--- 鉴权 ---");
  const env = newEnv();
  const { data } = await login(env, PASSWORD);
  const token = data.token;

  let r = await save(env, undefined, "manual-manga-1", { name: "改了" });
  check("不带 token 被 401", r.status === 401, String(r.status));

  r = await save(env, "f".repeat(64), "manual-manga-1", { name: "改了" });
  check("伪造 token 被 401", r.status === 401, String(r.status));

  // 长度/字符集不对的 token。这里必须用 ASCII —— HTTP 头是 ByteString，
  // 塞中文会在构造 Request 时就抛，压根测不到 Worker 的逻辑。
  r = await save(env, "short-token", "manual-manga-1", { name: "改了" });
  check("格式不对的 token 被 401", r.status === 401, String(r.status));

  r = await save(env, "z".repeat(64), "manual-manga-1", { name: "改了" });
  check("非 hex 字符的 token 被 401", r.status === 401, String(r.status));

  r = await save(env, token, "manual-manga-1", { name: "改了" });
  check("带正确 token 能写", r.status === 200, JSON.stringify(r.data));

  // session 查询接口
  r = await call(env, "/api/admin/session", { token });
  check("session 有效", r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  r = await call(env, "/api/admin/session");
  check("无 token 时 session 无效", r.status === 401, String(r.status));

  // 登出后 token 立刻失效
  r = await call(env, "/api/admin/logout", { method: "POST", token });
  check("登出成功", r.status === 200, String(r.status));
  r = await save(env, token, "manual-manga-1", { name: "再改" });
  check("登出后 token 失效", r.status === 401, String(r.status));
}

/* ---------- 5. 过期 token ---------- */
{
  console.log("\n--- 过期 token ---");
  const env = newEnv();
  const { data } = await login(env, PASSWORD);
  const token = data.token;

  // 手动把过期时间改到过去
  env.DB._db.prepare("UPDATE admin_sessions SET expires = ? WHERE token = ?")
    .run(new Date(Date.now() - 1000).toISOString(), token);

  const r = await save(env, token, "manual-manga-1", { name: "改了" });
  check("过期 token 被 401", r.status === 401, String(r.status));

  const left = env.DB._db.prepare("SELECT COUNT(*) c FROM admin_sessions").get();
  check("过期会话被顺手删掉", left.c === 0, JSON.stringify(left));
}

/* ---------- 6. 只能改白名单字段 ---------- */
{
  console.log("\n--- 可编辑字段白名单 ---");
  const env = newEnv();
  const { data } = await login(env, PASSWORD);
  const token = data.token;

  // id 与 section 绝不能改：点击数、失效反馈都以 id 为键
  for (const [f, v] of [["id", "别的id"], ["section", "game"], ["adult", "true"], ["links", "x"]]) {
    const r = await save(env, token, "manual-manga-1", { [f]: v });
    check(`改 ${f} 被 400`, r.status === 400, JSON.stringify(r.data));
  }

  // 白名单里的五项都能改
  const r = await save(env, token, "manual-manga-1", {
    name: "新标题", description: "新简介", url: "https://example.com/",
    password: "abcd", note: "新备注",
  });
  check("五个字段一起改成功", r.status === 200, JSON.stringify(r.data));

  const got = (await call(env, "/api/overrides")).data.overrides["manual-manga-1"];
  check("读回标题", got.name === "新标题", got.name);
  check("读回简介", got.description === "新简介", got.description);
  check("读回链接", got.url === "https://example.com/", got.url);
  check("读回提取码", got.password === "abcd", got.password);
  check("读回备注", got.note === "新备注", got.note);
}

/* ---------- 7. 链接与文本校验 ---------- */
{
  console.log("\n--- 链接与文本校验 ---");
  const env = newEnv();
  const { data } = await login(env, PASSWORD);
  const token = data.token;

  // 伪协议必须挡住：卡片上的链接是 <a href>，javascript: 会变成 XSS
  for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "//evil.example.com", "ftp://x.com"]) {
    const r = await save(env, token, "manual-manga-1", { url: bad });
    check(`伪协议 ${bad.slice(0, 18)} 被 400`, r.status === 400, JSON.stringify(r.data));
  }

  let r = await save(env, token, "manual-manga-1", { url: "https://ok.example.com/x" });
  check("https 链接通过", r.status === 200, JSON.stringify(r.data));
  r = await save(env, token, "manual-manga-1", { url: "http://ok.example.com/x" });
  check("http 链接通过", r.status === 200, JSON.stringify(r.data));

  // 空串是有意义的：表示「这条不显示提取码」，不是撤销覆盖
  r = await save(env, token, "manual-manga-1", { password: "" });
  check("空串可以存", r.status === 200, JSON.stringify(r.data));
  let got = (await call(env, "/api/overrides")).data.overrides["manual-manga-1"];
  check("空串被保留（不是回落原值）", got.password === "", JSON.stringify(got.password));

  // 超长文本按上限截断，不报错
  const long = "长".repeat(_internal.OVERRIDE_MAX.name + 50);
  r = await save(env, token, "manual-manga-2", { name: long });
  check("超长标题被接受", r.status === 200, JSON.stringify(r.data));
  got = (await call(env, "/api/overrides")).data.overrides["manual-manga-2"];
  check(`标题截到 ${_internal.OVERRIDE_MAX.name} 字`,
        got.name.length === _internal.OVERRIDE_MAX.name, String(got.name.length));

  // 控制字符与零宽字符走 sanitizeText 清掉
  r = await save(env, token, "manual-manga-3", { name: "标​题\n换行" });
  got = (await call(env, "/api/overrides")).data.overrides["manual-manga-3"];
  check("零宽与换行被清理", got.name === "标题 换行", JSON.stringify(got.name));

  // 非法 item_id
  for (const bad of ["", "中文id", "x; DROP TABLE overrides", "y".repeat(65)]) {
    const rr = await call(env, "/api/admin/override",
      { method: "POST", token, body: { item_id: bad, fields: { name: "x" } } });
    check(`item_id ${bad.slice(0, 14) || "(空)"} 被 400`, rr.status === 400, String(rr.status));
  }
  const alive = env.DB._db.prepare("SELECT COUNT(*) c FROM overrides").get();
  check("注入没破坏表", alive.c === 3, JSON.stringify(alive));
}

/* ---------- 8. 增量更新与撤销 ---------- */
{
  console.log("\n--- 增量更新与撤销 ---");
  const env = newEnv();
  const { data } = await login(env, PASSWORD);
  const token = data.token;

  await save(env, token, "manual-novel-1", { name: "标题A", note: "备注A" });

  // 只改一个字段，其他的不该被清掉
  await save(env, token, "manual-novel-1", { name: "标题B" });
  let got = (await call(env, "/api/overrides")).data.overrides["manual-novel-1"];
  check("改一个字段不影响其他", got.name === "标题B" && got.note === "备注A",
        JSON.stringify(got));

  // null 撤销单项，回落到 items.json 的原值
  await save(env, token, "manual-novel-1", { note: null });
  got = (await call(env, "/api/overrides")).data.overrides["manual-novel-1"];
  check("null 撤销该项", got.name === "标题B" && !("note" in got), JSON.stringify(got));

  // 全部撤销后整行删掉，不留空覆盖
  await save(env, token, "manual-novel-1", { name: null });
  const list = (await call(env, "/api/overrides")).data;
  check("全撤销后整行删除", !("manual-novel-1" in list.overrides),
        JSON.stringify(Object.keys(list.overrides)));

  // updated 时间戳要跟着变，前端靠它判断新鲜度
  await save(env, token, "manual-novel-2", { name: "X" });
  const t1 = (await call(env, "/api/overrides")).data.overrides["manual-novel-2"].updated;
  await new Promise((r) => setTimeout(r, 15));
  await save(env, token, "manual-novel-2", { name: "Y" });
  const t2 = (await call(env, "/api/overrides")).data.overrides["manual-novel-2"].updated;
  check("updated 会刷新", t2 > t1, `${t1} -> ${t2}`);
}

/* ---------- 9. 覆盖层公开读 ---------- */
{
  console.log("\n--- 覆盖层公开读 ---");
  const env = newEnv();
  const { data } = await login(env, PASSWORD);
  await save(env, data.token, "manual-manga-1", { name: "公开可见的新标题" });

  // 访客要用它盖住 items.json，所以读接口不能要 token
  const r = await call(env, "/api/overrides");
  check("不带 token 也能读", r.status === 200, String(r.status));
  check("内容正确", r.data.overrides["manual-manga-1"].name === "公开可见的新标题");
  check("带了计数", r.data.count === 1, String(r.data.count));

  // 但不能泄露会话相关的东西
  const blob = JSON.stringify(r.data);
  check("不含 token 字样", !/token/i.test(blob));
  check("不含 by_who", !blob.includes("by_who"));
}

console.log(fail ? `\n${fail} 项失败` : "\n全部通过");
process.exit(fail ? 1 : 0);
