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

/** 访客侧的提交接口。反馈运维那几节要先造出数据来才有东西可改。
 *  不同 ip 模拟不同访客 —— 同一指纹每天有条数上限。 */
const post = (env, path, body, opts) =>
  call(env, path, { method: "POST", body, ...opts });
const create = (env, title, note = "", opts) =>
  post(env, "/api/requests", { title, note }, opts);

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

  // id 绝不能改：点击数（clicks.item）与失效反馈（requests.item_id）都以它为键
  for (const [f, v] of [["id", "another-id"], ["adult", "true"], ["links", "x"]]) {
    const r = await save(env, token, "manual-manga-1", { [f]: v });
    check(`改 ${f} 被 400`, r.status === 400, JSON.stringify(r.data));
  }

  // 白名单里的七项都能改（含分区两项）
  const r = await save(env, token, "manual-manga-1", {
    name: "新标题", description: "新简介", url: "https://example.com/",
    password: "abcd", note: "新备注", section: "novel", subsection: "jp",
  });
  check("七个字段一起改成功", r.status === 200, JSON.stringify(r.data));

  const got = (await call(env, "/api/overrides")).data.overrides["manual-manga-1"];
  check("读回标题", got.name === "新标题", got.name);
  check("读回简介", got.description === "新简介", got.description);
  check("读回链接", got.url === "https://example.com/", got.url);
  check("读回提取码", got.password === "abcd", got.password);
  check("读回备注", got.note === "新备注", got.note);
  check("读回分区", got.section === "novel", got.section);
  check("读回小分区", got.subsection === "jp", got.subsection);
}

/* ---------- 6b. 移动分区 ---------- */
{
  console.log("\n--- 移动分区 ---");
  const env = newEnv();
  const { data } = await login(env, PASSWORD);
  const token = data.token;
  const read = async (id) => (await call(env, "/api/overrides")).data.overrides[id] || {};

  // 漫画/公众号 -> 小说/日轻，正是用户要的那个场景
  let r = await save(env, token, "manual-manga-5", { section: "novel", subsection: "jp" });
  check("漫画搬到小说/日轻", r.status === 200, JSON.stringify(r.data));
  let got = await read("manual-manga-5");
  check("分区与小分区都记下了", got.section === "novel" && got.subsection === "jp",
        JSON.stringify(got));

  // 未知分区必须挡住 —— 放行的话前端 normalize 会丢弃它，
  // 表现为「保存成功但分区没变」，比报错难查得多
  for (const bad of ["nonsense", "NOVEL", "all"]) {
    r = await save(env, token, "manual-manga-5", { section: bad });
    check(`未知分区 ${bad} 被 400`, r.status === 400, JSON.stringify(r.data));
  }

  // 小分区必须属于目标分区。gal 只在 game 下有
  r = await save(env, token, "manual-manga-5", { section: "novel", subsection: "gal" });
  check("小分区不属于该分区被 400", r.status === 400, JSON.stringify(r.data));

  // 只改 section、旧小分区在新分区里不存在时静默清空 ——
  // 报错更严格但很烦：用户就是想换个大区，不该被逼着先想好小分区
  await save(env, token, "manual-manga-6", { section: "manga", subsection: "wechat" });
  r = await save(env, token, "manual-manga-6", { section: "novel" });
  check("只换大区也能成功", r.status === 200, JSON.stringify(r.data));
  got = await read("manual-manga-6");
  check("不合法的旧小分区被清空", got.section === "novel" && !got.subsection,
        JSON.stringify(got));

  // 两边都有的小分区（site/app/download）在换区时应保留
  await save(env, token, "manual-manga-7", { section: "manga", subsection: "download" });
  r = await save(env, token, "manual-manga-7", { section: "novel" });
  got = await read("manual-manga-7");
  check("两边都有的小分区保留", got.section === "novel" && got.subsection === "download",
        JSON.stringify(got));

  // 分区可以撤销，回到 items.json 里的原始分区
  r = await save(env, token, "manual-manga-5", { section: null, subsection: null });
  got = await read("manual-manga-5");
  check("撤销分区覆盖", !("section" in got) && !("subsection" in got), JSON.stringify(got));
}

/* ---------- 6c. 多分区归属（placements） ---------- */
{
  console.log("\n--- 多分区归属 ---");
  const env = newEnv();
  const { data } = await login(env, PASSWORD);
  const token = data.token;
  const read = async (id) => (await call(env, "/api/overrides")).data.overrides[id] || {};
  const P = _internal.parsePlacements;

  // 先单独验 parsePlacements —— 它是这套语义的唯一来源
  check("单个分区", P("tool").value === "tool");
  check("分区带小分区", P("novel:jp").value === "novel:jp");
  check("多个归属", P("novel:download,manga:kr").value === "novel:download,manga:kr");
  check("首尾空白裁掉", P(" novel:jp , manga ").value === "novel:jp,manga");

  // 同一分区可以挂多个小分区 —— 一个网盘包既算「下载」又算「日轻」是真实需求。
  // 去重的是完整的「分区:小分区」对，不是分区本身。
  check("同区多个小分区都保留",
        P("novel:download,novel:jp").value === "novel:download,novel:jp",
        P("novel:download,novel:jp").value);
  check("同区多小分区 + 跨区混用",
        P("novel:jp,novel:download,manga:kr").value === "novel:jp,novel:download,manga:kr",
        P("novel:jp,novel:download,manga:kr").value);
  check("完全相同的一对才去重", P("novel:jp,novel:jp").value === "novel:jp");
  // 「不指定」是「该区全部」的意思，已被具体小分区涵盖，留着会让条目在该区出现两次
  check("同区留空被具体小分区顶掉", P("novel,novel:jp").value === "novel:jp",
        P("novel,novel:jp").value);
  check("顺序反了也一样", P("novel:jp,novel").value === "novel:jp",
        P("novel:jp,novel").value);

  check("空串合法（表示不指定）", P("").ok && P("").value === "");
  check("未知分区报错", !P("bogus").ok, P("bogus").error);
  check("小分区不属于该分区报错", !P("novel:gal").ok, P("novel:gal").error);

  const over = Array.from({ length: _internal.PLACEMENT_MAX + 1 }, (_, i) =>
    ["novel", "manga", "anime", "game", "music", "study", "tool", "ai", "forum"][i]
  ).join(",");
  check(`超过 ${_internal.PLACEMENT_MAX} 个报错`, !P(over).ok, P(over).error);

  // 走接口：一条挂三个位置，正是「几个大区都有资源」的场景
  let r = await save(env, token, "manual-manga-1", {
    placements: "manga:site,novel:jp,game:gal",
  });
  check("挂三个位置成功", r.status === 200, JSON.stringify(r.data));
  let got = await read("manual-manga-1");
  check("读回归属串", got.placements === "manga:site,novel:jp,game:gal", got.placements);

  // 同一分区下挂两个小分区：用户的原话「下载、日轻」
  r = await save(env, token, "manual-novel-1", {
    placements: "novel:download,novel:jp",
  });
  check("同区两个小分区成功", r.status === 200, JSON.stringify(r.data));
  got = await read("manual-novel-1");
  check("同区两个小分区都存下来", got.placements === "novel:download,novel:jp",
        got.placements);

  // placements 一给值就该清掉单值旧形式，否则前端得猜听谁的
  await save(env, token, "manual-manga-2", { section: "novel", subsection: "kr" });
  r = await save(env, token, "manual-manga-2", { placements: "tool" });
  got = await read("manual-manga-2");
  check("placements 顶掉旧的 section", got.placements === "tool" && !got.section,
        JSON.stringify(got));

  // 非法值同样被挡
  for (const bad of ["bogus", "novel:gal", "all"]) {
    r = await save(env, token, "manual-manga-1", { placements: bad });
    check(`非法归属 ${bad} 被 400`, r.status === 400, JSON.stringify(r.data));
  }

  // 撤销后回到 items.json 的原始分区
  r = await save(env, token, "manual-manga-1", { placements: null });
  got = await read("manual-manga-1");
  check("撤销 placements", !("placements" in got), JSON.stringify(got));
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

/* ---------- 10. 新增条目 ---------- */
{
  console.log("\n--- 新增条目 ---");
  const env = newEnv();
  const { data } = await login(env, PASSWORD);
  const token = data.token;
  const add = (body) => call(env, "/api/admin/item", { method: "POST", token, body });
  const list = async () => (await call(env, "/api/items")).data;

  let r = await add({ name: "" });
  check("空资源名被 400", r.status === 400, JSON.stringify(r.data));

  r = await add({ name: "无分区的条目" });
  check("缺分区被 400", r.status === 400, JSON.stringify(r.data));

  r = await add({ name: "分区不存在", section: "nonsense" });
  check("未知分区被 400", r.status === 400, JSON.stringify(r.data));

  r = await add({ name: "小分区不匹配", section: "novel", subsection: "gal" });
  check("小分区不属于该分区被 400", r.status === 400, JSON.stringify(r.data));

  r = await add({ name: "伪协议链接", section: "novel", url: "javascript:alert(1)" });
  check("伪协议被 400", r.status === 400, JSON.stringify(r.data));

  // 不带 token 不能新增
  r = await call(env, "/api/admin/item", { method: "POST", body: { name: "x", section: "novel" } });
  check("未登录被 401", r.status === 401, String(r.status));

  // 正常新增
  r = await add({
    name: "后台加的小说", section: "novel", subsection: "jp",
    description: "简介", url: "https://example.com/x", password: "1234",
    tags: "日轻, 网盘 ,测试", kind: "网盘资源", note: "备注", adult: true,
  });
  check("正常新增成功", r.status === 200, JSON.stringify(r.data));
  const id = r.data.id;
  check("id 带 custom- 前缀", String(id).startsWith(_internal.CUSTOM_PREFIX), String(id));
  check("id 符合 ID_RE", _internal.ID_RE.test(id), String(id));

  let d = await list();
  check("公开读能拿到（不带 token）", d.count === 1, JSON.stringify(d.count));
  const it = d.items[0];
  check("字段齐全", it.name === "后台加的小说" && it.section === "novel"
        && it.subsection === "jp" && it.url === "https://example.com/x",
        JSON.stringify(it).slice(0, 120));
  check("tags 拆成数组并去空白",
        JSON.stringify(it.tags) === JSON.stringify(["日轻", "网盘", "测试"]),
        JSON.stringify(it.tags));
  check("adult 转成布尔", it.adult === true, String(it.adult));
  check("标了来源", it.update_info === "后台添加", String(it.update_info));

  // tags 最多 6 个 —— 前端也只显示 6 个
  r = await add({ name: "标签很多", section: "tool", tags: "a,b,c,d,e,f,g,h,i" });
  d = await list();
  const many = d.items.find((x) => x.name === "标签很多");
  check("tags 截到 6 个", many.tags.length === 6, JSON.stringify(many.tags));

  // 没有小分区的分区（tool）不该被要求填
  check("无小分区的分区能新增", many.section === "tool" && !many.subsection,
        JSON.stringify({ s: many.section, sub: many.subsection }));

  // 两次新增的 id 不能撞
  const a = (await add({ name: "同名条目", section: "novel" })).data.id;
  const b = (await add({ name: "同名条目", section: "novel" })).data.id;
  check("同名也生成不同 id", a !== b, `${a} vs ${b}`);
  d = await list();
  check("同名两条都在", d.items.filter((x) => x.name === "同名条目").length === 2);

  // 新增时也能一次挂多个分区
  r = await add({ name: "挂三个区的资源", placements: "novel:jp,manga:kr,game:gal" });
  check("多分区新增成功", r.status === 200, JSON.stringify(r.data));
  d = await list();
  const multi = d.items.find((x) => x.name === "挂三个区的资源");
  check("归属串完整", multi.placements === "novel:jp,manga:kr,game:gal", multi.placements);
  check("主分区取第一个", multi.section === "novel" && multi.subsection === "jp",
        `${multi.section}/${multi.subsection}`);

  // 老形式（section+subsection）仍然收，兼容还没更新的前端
  r = await add({ name: "老形式新增", section: "tool" });
  d = await list();
  const legacy = d.items.find((x) => x.name === "老形式新增");
  check("老形式补出 placements", legacy.placements === "tool", legacy.placements);

  for (const bad of ["bogus", "novel:gal"]) {
    r = await add({ name: "坏归属", placements: bad });
    check(`非法归属 ${bad} 被 400`, r.status === 400, JSON.stringify(r.data));
  }
}

/* ---------- 11. 删除条目 ---------- */
{
  console.log("\n--- 删除条目 ---");
  const env = newEnv();
  const { data } = await login(env, PASSWORD);
  const token = data.token;
  // tok 显式传 null 表示「不带 token」。用 ?? 而不是默认参数：
  // 默认参数只在 undefined 时生效，传 null 反而会变成 Authorization: Bearer null
  const del = (id, tok) =>
    call(env, "/api/admin/item/delete",
      { method: "POST", token: tok === undefined ? token : (tok || undefined), body: { id } });

  const { data: made } = await call(env, "/api/admin/item",
    { method: "POST", token, body: { name: "待删除", section: "tool" } });
  const id = made.id;

  // 注意传 null 而不是 undefined：默认参数 tok = token 只在 undefined 时生效，
  // 传 undefined 等于带上了 token，那条断言就测不到未登录的情况（还会真把条目删掉）
  let r = await del(id, null);
  check("未登录不能删", r.status === 401, String(r.status));

  // items.json 里的条目不在 custom_items 表里，不该从这里删
  r = await del("manual-manga-1");
  check("拒绝删非 custom 条目", r.status === 400, JSON.stringify(r.data));
  r = await del("x; DROP TABLE custom_items");
  check("注入串被 400", r.status === 400, String(r.status));

  r = await del(id);
  check("删除成功", r.status === 200, JSON.stringify(r.data));
  const d = (await call(env, "/api/items")).data;
  check("列表里没了", d.count === 0, JSON.stringify(d.count));

  r = await del(id);
  check("重复删除返回 404", r.status === 404, String(r.status));

  // 删条目要连带清掉它的覆盖，否则留下一行孤儿数据
  const { data: made2 } = await call(env, "/api/admin/item",
    { method: "POST", token, body: { name: "带覆盖的条目", section: "tool" } });
  await save(env, token, made2.id, { name: "改过的名字" });
  let ov = (await call(env, "/api/overrides")).data;
  check("先确认覆盖存在", made2.id in ov.overrides, JSON.stringify(Object.keys(ov.overrides)));
  await del(made2.id);
  ov = (await call(env, "/api/overrides")).data;
  check("删条目连带清覆盖", !(made2.id in ov.overrides),
        JSON.stringify(Object.keys(ov.overrides)));
}

/* ---------- 12. 反馈运维：改状态 / 写回复 ---------- */
{
  console.log("\n--- 反馈运维：改状态与回复 ---");
  const env = newEnv();
  const { data } = await login(env, PASSWORD);
  const token = data.token;

  // 造一条失效反馈
  await post(env, "/api/requests", { kind: "broken", item_id: "manual-manga-1", title: "失效资源" });
  let list = (await call(env, "/api/requests")).data;
  const id = list.items[0].id;
  check("初始是 open", list.items[0].status === "open", list.items[0].status);

  const upd = (body, tok = token) =>
    call(env, "/api/admin/request", { method: "POST", token: tok, body });

  let r = await upd({ id, status: "found" }, null);
  check("未登录不能改", r.status === 401, String(r.status));

  r = await upd({ id: 99999, status: "found" });
  check("不存在的 id 返回 404", r.status === 404, String(r.status));
  r = await upd({ id, status: "bogus" });
  check("未知状态被 400", r.status === 400, JSON.stringify(r.data));
  r = await upd({ id });
  check("什么都不改被 400", r.status === 400, JSON.stringify(r.data));

  r = await upd({ id, status: "found" });
  check("标成 found", r.status === 200, JSON.stringify(r.data));
  list = (await call(env, "/api/requests")).data;
  check("状态已变", list.items[0].status === "found", list.items[0].status);
  // 待补档计数要跟着降，站长看的就是这个数字
  check("broken.open 归零", list.summary.broken.open === 0,
        JSON.stringify(list.summary.broken));
  check("broken.found 变 1", list.summary.broken.found === 1,
        JSON.stringify(list.summary.broken));

  r = await upd({ id, reply: "  已换新链接  " });
  check("写回复成功", r.status === 200, JSON.stringify(r.data));
  list = (await call(env, "/api/requests")).data;
  check("回复被清洗（裁掉首尾空白）", list.items[0].reply === "已换新链接",
        JSON.stringify(list.items[0].reply));

  // 回复走 sanitizeText，控制字符与零宽字符要清掉
  await upd({ id, reply: "补​好了\n换行" });
  list = (await call(env, "/api/requests")).data;
  check("回复里的零宽与换行被清理", list.items[0].reply === "补好了 换行",
        JSON.stringify(list.items[0].reply));

  // 能放回 open
  await upd({ id, status: "open" });
  list = (await call(env, "/api/requests")).data;
  check("能放回 open", list.items[0].status === "open", list.items[0].status);
}

/* ---------- 13. 反馈运维：删除与批量清理 ---------- */
{
  console.log("\n--- 反馈运维：删除与清理 ---");
  const env = newEnv();
  const { data } = await login(env, PASSWORD);
  const token = data.token;

  const upd = (body) => call(env, "/api/admin/request", { method: "POST", token, body });
  const delReq = (id, tok = token) =>
    call(env, "/api/admin/request/delete",
      { method: "POST", token: tok === null ? undefined : tok, body: { id } });
  const purge = (body, tok = token) =>
    call(env, "/api/admin/requests/purge",
      { method: "POST", token: tok === null ? undefined : tok, body });
  const listAll = async () => (await call(env, "/api/requests?limit=100")).data;

  // 造 5 条：broken 三种状态各一，want 两条
  await post(env, "/api/requests", { kind: "broken", item_id: "aa", title: "待补档" });
  await post(env, "/api/requests", { kind: "broken", item_id: "bb", title: "已补上" }, { ip: "2.2.2.2" });
  await post(env, "/api/requests", { kind: "broken", item_id: "cc", title: "已关闭" }, { ip: "3.3.3.3" });
  await create(env, "想要的还没找", "", { ip: "4.4.4.4" });
  await create(env, "想要的已找到", "", { ip: "5.5.5.5" });

  let all = await listAll();
  const byTitle = {};
  all.items.forEach((x) => (byTitle[x.title] = x.id));
  await upd({ id: byTitle["已补上"], status: "found" });
  await upd({ id: byTitle["已关闭"], status: "closed" });
  await upd({ id: byTitle["想要的已找到"], status: "found" });

  /* --- 单条删除 --- */
  let r = await delReq(byTitle["待补档"], null);
  check("未登录不能删", r.status === 401, String(r.status));
  r = await delReq(99999);
  check("删不存在的返回 404", r.status === 404, String(r.status));
  r = await delReq("abc");
  check("非法 id 被 400", r.status === 400, String(r.status));

  // 删掉后它的投票去重键也要清 —— 不清的话同一访客以后再报会被当成已投过
  const before = env.DB._db.prepare("SELECT COUNT(*) c FROM request_votes").get().c;
  r = await delReq(byTitle["待补档"]);
  check("删除成功", r.status === 200, JSON.stringify(r.data));
  const after = env.DB._db.prepare("SELECT COUNT(*) c FROM request_votes").get().c;
  check("连带清掉投票去重键", after === before - 1, `${before} -> ${after}`);
  all = await listAll();
  check("列表里少了一条", all.items.length === 4, String(all.items.length));

  /* --- 批量清理 --- */
  r = await purge({ kind: "broken" }, null);
  check("未登录不能清理", r.status === 401, String(r.status));
  r = await purge({ kind: "broken", statuses: ["bogus"] });
  check("状态全非法被 400", r.status === 400, JSON.stringify(r.data));

  // 只清 broken 的 found/closed；want 那两条不该被带走
  r = await purge({ kind: "broken" });
  check("清掉 2 条", r.status === 200 && r.data.deleted === 2, JSON.stringify(r.data));
  all = await listAll();
  const left = all.items.map((x) => x.title).sort();
  check("只剩 want 两条", JSON.stringify(left) === JSON.stringify(["想要的已找到", "想要的还没找"]),
        JSON.stringify(left, null, 0));

  // 不带 kind 时两类都清，但仍只清 found/closed
  r = await purge({});
  check("再清掉 want 的 found", r.data.deleted === 1, JSON.stringify(r.data));
  all = await listAll();
  check("待处理的那条留着", all.items.length === 1 && all.items[0].title === "想要的还没找",
        JSON.stringify(all.items.map((x) => x.title), null, 0));

  // 没有可清的时候返回 0 而不是报错
  r = await purge({});
  check("没得清返回 deleted:0", r.status === 200 && r.data.deleted === 0, JSON.stringify(r.data));

  // 显式指定 open 也能清 —— 接口允许，但前端不会这么调
  r = await purge({ statuses: ["open"] });
  check("显式清 open 也可以", r.data.deleted === 1, JSON.stringify(r.data));
  all = await listAll();
  check("全空了", all.items.length === 0, String(all.items.length));
  const votes = env.DB._db.prepare("SELECT COUNT(*) c FROM request_votes").get().c;
  check("投票去重键也清干净", votes === 0, String(votes));
}

console.log(fail ? `\n${fail} 项失败` : "\n全部通过");
process.exit(fail ? 1 : 0);
