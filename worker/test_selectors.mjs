/**
 * 选择器对齐检查。app.js 里 $("[data-xxx]") 拿不到元素时多数是静默失效
 * （renderStats 里 if (!box) return 之类），线上看不出报错但功能没了。
 * 所以把 app.js 用到的 data-* 选择器抽出来，逐个确认 index.html 里存在。
 *
 * 跑法：node test_selectors.mjs
 */
import { readFileSync } from "node:fs";

const js = readFileSync(new URL("../app.js", import.meta.url), "utf-8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf-8");

let fail = 0;
const check = (name, ok, extra = "") => {
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

// app.js 里的 [data-foo] 与 [data-field="foo"]
const attrs = new Set();
for (const m of js.matchAll(/\[data-([a-z0-9-]+)\]/g)) attrs.add(m[1]);

const fields = new Set();
for (const m of js.matchAll(/data-field="\$\{name\}"/g)) void m; // 模板本身跳过
for (const m of js.matchAll(/field\("([A-Za-z0-9]+)"\)/g)) fields.add(m[1]);

// HTML 里实际存在的
const htmlAttrs = new Set();
for (const m of html.matchAll(/data-([a-z0-9-]+)(?==|[\s>])/g)) htmlAttrs.add(m[1]);

const htmlFields = new Set();
for (const m of html.matchAll(/data-field="([^"]+)"/g)) htmlFields.add(m[1]);

// data-filter 是带值的属性，单独核对
const filters = new Set();
for (const m of js.matchAll(/data-filter="([^"]+)"/g)) filters.add(m[1]);
const htmlFilters = new Set();
for (const m of html.matchAll(/data-filter="([^"]+)"/g)) htmlFilters.add(m[1]);

const skip = new Set(["field", "filter", "stat", "card-template", "item-id"]);

[...attrs].sort().forEach((a) => {
  if (skip.has(a)) return;
  check(`[data-${a}] 存在于 HTML`, htmlAttrs.has(a));
});

[...fields].sort().forEach((f) => {
  check(`data-field="${f}" 存在于模板`, htmlFields.has(f));
});

[...filters].sort().forEach((f) => {
  check(`data-filter="${f}" 存在于 HTML`, htmlFilters.has(f));
});

// 统计相关的关键节点单独点名，漏一个整块排行榜就不显示
[
  "stats-panel",
  "stats-toggle",
  "stats-body",
  "stats-tabs",
  "stats-scope",
  "stats-visitors",
  "stats-rank",
  "stats-empty",
].forEach((a) => check(`排行榜节点 data-${a}`, htmlAttrs.has(a)));

// 资源帮找的关键节点，同理
[
  "wanted-panel",
  "wanted-toggle",
  "wanted-body",
  "wanted-sub",
  "wanted-form",
  "wanted-submit",
  "wanted-msg",
  "wanted-kinds",
  "wanted-broken-hint",
  "wanted-tabs",
  "wanted-list",
  "wanted-empty",
  "goto-wanted",
].forEach((a) => check(`帮找节点 data-${a}`, htmlAttrs.has(a)));

// data-wanted-input 是带值的属性，单独核对
const wantedInputs = new Set();
for (const m of js.matchAll(/data-wanted-input="([^"]+)"/g)) wantedInputs.add(m[1]);
const htmlWantedInputs = new Set();
for (const m of html.matchAll(/data-wanted-input="([^"]+)"/g)) htmlWantedInputs.add(m[1]);
[...wantedInputs].sort().forEach((f) => {
  check(`data-wanted-input="${f}" 存在于 HTML`, htmlWantedInputs.has(f));
});

check("模板含 hits 角标", htmlFields.has("hits"));
check("index.html 引了 config.js", /src="config\.js/.test(html));

// 版本号：改了 app.js/styles.css 必须同步提 querystring，否则 CDN 缓存 10 分钟不更新
const vers = [...html.matchAll(/(?:app\.js|styles\.css|config\.js)\?v=([A-Za-z0-9]+)/g)].map((m) => m[1]);
check(`静态资源版本号一致 (${[...new Set(vers)].join(",")})`, new Set(vers).size === 1);
check("三个静态资源都带版本号", vers.length === 3, String(vers.length));

console.log(fail ? `\n${fail} 项失败` : "\n全部通过");
process.exit(fail ? 1 : 0);
