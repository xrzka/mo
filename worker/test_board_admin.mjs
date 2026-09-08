import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import worker from "./index.js";

const ORIGIN = "https://xrzka.github.io";
const PASSWORD = "board-correct-password";
let failures = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf-8"));
  const wrap = (sql, args = []) => ({
    bind: (...next) => wrap(sql, next),
    async run() {
      const result = db.prepare(sql).run(...args);
      return { meta: { changes: Number(result.changes) } };
    },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async first() { return db.prepare(sql).get(...args) ?? null; },
  });
  return { _db: db, prepare: (sql) => wrap(sql) };
}

function makeHash(password) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, 1000, 32, "sha256");
  return `pbkdf2$1000$${salt.toString("hex")}$${hash.toString("hex")}`;
}

const env = { DB: makeD1(), BOARD_ADMIN_PASSWORD_HASH: makeHash(PASSWORD) };
const request = (path, { method = "GET", body, token, origin = ORIGIN } = {}) => {
  const headers = { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4" };
  if (token) headers.Authorization = "Bearer " + token;
  return new Request("https://example.test" + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
};
const call = async (path, options) => {
  const response = await worker.fetch(request(path, options), env);
  return { status: response.status, data: await response.json() };
};

const fallbackEnv = { DB: makeD1(), ADMIN_PASSWORD_HASH: makeHash(PASSWORD) };
let fallback = await worker.fetch(request("/api/board/admin/login", {
  method: "POST", body: { password: PASSWORD },
}), fallbackEnv);
check("未设置独立密码时复用第二站密码", fallback.status === 200, String(fallback.status));

let result = await call("/api/board/admin/login", {
  method: "POST", body: { password: "wrong" },
});
check("错误密码被拒绝", result.status === 401, String(result.status));

result = await call("/api/board/admin/login", {
  method: "POST", body: { password: PASSWORD },
});
check("正确密码能登录", result.status === 200, String(result.status));
const token = result.data.token;
check("登录返回 64 位 token", typeof token === "string" && token.length === 64);

result = await call("/api/board/admin/override", {
  method: "POST", body: { item_id: "agentrouter", fields: { resource_name: "非法修改" } },
});
check("未登录不能修改", result.status === 401, String(result.status));

result = await call("/api/board/admin/override", {
  method: "POST", token,
  body: { item_id: "agentrouter", fields: { resource_name: "新标题", site_url: "javascript:alert(1)" } },
});
check("伪协议被拒绝", result.status === 400, JSON.stringify(result.data));

result = await call("/api/board/admin/override", {
  method: "POST", token,
  body: {
    item_id: "agentrouter",
    fields: {
      resource_name: "新标题", register_bonus: 188, direct_connect: false,
      models: ["gpt-5.6-sol", { model_id: "claude-opus-5" }],
    },
  },
});
check("保存覆盖成功", result.status === 200, JSON.stringify(result.data));
result = await call("/api/board/overrides");
check("公开接口能读覆盖", result.data.overrides.agentrouter.resource_name === "新标题");
check("数组字段已规范化", result.data.overrides.agentrouter.models.length === 2);

result = await call("/api/board/admin/override", {
  method: "POST", token,
  body: { item_id: "agentrouter", fields: { checkin_bonus: null } },
});
check("可覆盖数字为空值", result.status === 200, JSON.stringify(result.data));
result = await call("/api/board/overrides");
check("空值覆盖不会被当成撤销", "checkin_bonus" in result.data.overrides.agentrouter && result.data.overrides.agentrouter.checkin_bonus === null);

result = await call("/api/board/admin/item", {
  method: "POST", token,
  body: {
    resource_name: "后台新增站", description: "说明", site_url: "https://example.com",
    rank_position: 20, register_bonus: null, checkin_bonus: 2,
    bonus_currency: "USD", direct_connect: true, model_count: 1,
    consumer_category: "welfare", benefit_flags: ["checkin"],
    site_tags: ["后台新增"], models: ["test-model"],
  },
});
check("新增卡片成功", result.status === 200, JSON.stringify(result.data));
const customId = result.data.id;
check("新增 id 使用 custom 前缀", String(customId).startsWith("custom-"));
result = await call("/api/board/items");
check("访客能读到新增卡片", result.data.items.length === 1);
check("新增卡片字段正确", result.data.items[0].resource_name === "后台新增站");

result = await call("/api/board/admin/override", {
  method: "POST", token,
  body: { item_id: "agentrouter", fields: { deleted: true } },
});
check("静态卡片可标记删除", result.status === 200, JSON.stringify(result.data));
result = await call("/api/board/overrides");
check("删除标记公开读回", result.data.overrides.agentrouter.deleted === true);
result = await call("/api/board/admin/override", {
  method: "POST", token,
  body: { item_id: "agentrouter", fields: { deleted: "true" } },
});
check("删除标记拒绝字符串", result.status === 400, JSON.stringify(result.data));
result = await call("/api/board/admin/override", {
  method: "POST", token,
  body: { item_id: "agentrouter", fields: {}, clear_fields: ["deleted"] },
});
check("静态卡片可恢复", result.status === 200, JSON.stringify(result.data));
result = await call("/api/board/overrides");
check("恢复后清除删除标记", !("deleted" in result.data.overrides.agentrouter));

result = await call("/api/board/admin/item/delete", {
  method: "POST", token, body: { id: "agentrouter" },
});
check("不能删除静态卡片", result.status === 400, String(result.status));
result = await call("/api/board/admin/item/delete", {
  method: "POST", token, body: { id: customId },
});
check("能删除后台新增卡片", result.status === 200, String(result.status));
result = await call("/api/board/items");
check("删除后公开列表为空", result.data.items.length === 0);

result = await call("/api/board/admin/override", {
  method: "POST", token,
  body: {
    item_id: "agentrouter", fields: {},
    clear_fields: ["resource_name", "register_bonus", "checkin_bonus", "direct_connect", "models"],
  },
});
check("撤销覆盖成功", result.status === 200 && result.data.cleared === true, JSON.stringify(result.data));
result = await call("/api/board/overrides");
check("撤销后覆盖列表为空", result.data.count === 0);

result = await call("/api/board/admin/item", {
  method: "POST", token, origin: "https://evil.example",
  body: { resource_name: "跨站写入", rank_position: 1, direct_connect: true },
});
check("非白名单来源不能写", result.status === 403, String(result.status));

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
