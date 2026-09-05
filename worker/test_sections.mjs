/**
 * 分区白名单一致性检查。
 *
 * 后端 SECTION_SUBS 用来校验「移动到哪个分区」，前端 SECTIONS 决定标签页与
 * normalize() 的取值。两边不一致时症状很隐蔽：后端放行的值到前端会被当成
 * 无效丢弃，用户看到「保存成功但分区没变」，日志里也没有错误。
 *
 * app.js 是 IIFE，没法 import，所以从源码里正则解析 SECTIONS ——
 * 与 test_frontend_parity.mjs 抄桶名算法同一个理由（那里的注释也说了这个局限）。
 *
 * 跑法：node test_sections.mjs
 */
import { readFileSync } from "node:fs";
import { _internal } from "./index.js";

let fail = 0;
const check = (name, ok, extra = "") => {
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const js = readFileSync(new URL("../app.js", import.meta.url), "utf-8");

/** 从 app.js 里抠出 SECTIONS 数组的源码片段。 */
function sectionsBlock() {
  const start = js.indexOf("const SECTIONS = [");
  if (start < 0) return "";
  // 从 [ 开始做括号配平，找到对应的 ]
  let i = js.indexOf("[", start);
  let depth = 0;
  for (let j = i; j < js.length; j++) {
    if (js[j] === "[") depth++;
    else if (js[j] === "]") {
      depth--;
      if (depth === 0) return js.slice(i, j + 1);
    }
  }
  return "";
}

const block = sectionsBlock();
check("在 app.js 里找到 SECTIONS", block.length > 100, `${block.length} 字符`);

/** 解析成 { 分区id: [小分区id...] }。all 是伪分区，跳过。 */
function parseFrontend(src) {
  const out = {};
  // 按顶层逗号切成一个个分区对象。不用正则一把梭 —— subs 是嵌套数组，
  // 正则的前瞻在嵌套结构里不可靠，括号配平才稳。
  let depth = 0, cur = "", chunks = [];
  for (const ch of src.slice(1, -1)) {
    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) { chunks.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) chunks.push(cur);

  for (const c of chunks) {
    const idm = c.match(/id:\s*"([a-z]+)"/);
    if (!idm) continue;
    const id = idm[1];
    if (id === "all") continue;
    const subsm = c.match(/subs:\s*\[([\s\S]*?)\]/);
    const subs = subsm
      ? [...subsm[1].matchAll(/id:\s*"([a-z]+)"/g)].map((m) => m[1])
      : [];
    out[id] = subs;
  }
  return out;
}

const front = parseFrontend(block);
const back = _internal.SECTION_SUBS;

check(`前端解析出 ${Object.keys(front).length} 个分区`, Object.keys(front).length >= 10,
      Object.keys(front).join(","));

/* ---------- 分区集合必须完全一致 ---------- */
{
  console.log("\n--- 分区集合 ---");
  const fk = Object.keys(front).sort();
  const bk = Object.keys(back).sort();
  check("分区数量一致", fk.length === bk.length, `前端 ${fk.length} / 后端 ${bk.length}`);

  const onlyFront = fk.filter((k) => !bk.includes(k));
  const onlyBack = bk.filter((k) => !fk.includes(k));
  check("没有前端独有的分区", onlyFront.length === 0, onlyFront.join(","));
  // 后端独有 = 能存进库但前端不认，保存后分区会被 normalize 丢回兜底区
  check("没有后端独有的分区", onlyBack.length === 0, onlyBack.join(","));
}

/* ---------- 每个分区的小分区必须一致 ---------- */
{
  console.log("\n--- 小分区 ---");
  for (const sec of Object.keys(front).sort()) {
    const f = (front[sec] || []).slice().sort();
    const b = (back[sec] || []).slice().sort();
    check(
      `${sec}: ${f.length ? f.join("/") : "（无）"}`,
      JSON.stringify(f) === JSON.stringify(b),
      JSON.stringify(f) === JSON.stringify(b) ? "" : `前端 [${f}] vs 后端 [${b}]`
    );
  }
}

/* ---------- 真实数据里的组合都得合法 ---------- */
{
  console.log("\n--- items.json 的实际取值 ---");
  const raw = JSON.parse(readFileSync(new URL("../data/items.json", import.meta.url), "utf-8"));
  const items = Array.isArray(raw) ? raw : raw.items || [];

  const badSec = new Set();
  const badSub = new Set();
  for (const it of items) {
    const sec = it.section;
    if (!(sec in back)) { badSec.add(sec); continue; }
    // 数据里存在没有 subsection 的条目，那是允许的（落在「全部」里）
    if (it.subsection && !back[sec].includes(it.subsection)) {
      badSub.add(`${sec}/${it.subsection}`);
    }
    for (const extra of it.also_in || []) {
      if (!(extra.section in back)) badSec.add(extra.section);
      else if (extra.subsection && !back[extra.section].includes(extra.subsection)) {
        badSub.add(`${extra.section}/${extra.subsection}`);
      }
    }
  }
  check(`${items.length} 条数据的分区都在白名单里`, badSec.size === 0, [...badSec].join(","));
  check("小分区组合都合法", badSub.size === 0, [...badSub].join(","));
}

console.log(fail ? `\n${fail} 项失败` : "\n全部通过");
process.exit(fail ? 1 : 0);
