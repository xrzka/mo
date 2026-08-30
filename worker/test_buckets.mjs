/**
 * 桶名算法自测。前端 app.js 和 Worker 各有一份 isoWeek/buckets 实现，
 * 两边算出的桶名必须一致，否则同一次点击会落进不同的桶，排行榜就错了。
 *
 * 跑法：node test_buckets.mjs
 */
import { _internal } from "./index.js";

const { isoWeek, buckets, ID_RE } = _internal;

let fail = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${got} want=${want}`);
};

// ISO 周的几个边界：跨年那几天按 ISO 规则可能归到上一年最后一周或下一年第一周
eq("2026-01-01 (周四)", isoWeek(new Date(Date.UTC(2026, 0, 1))), "2026-W01");
eq("2025-12-29 (周一)", isoWeek(new Date(Date.UTC(2025, 11, 29))), "2026-W01");
eq("2026-12-31 (周四)", isoWeek(new Date(Date.UTC(2026, 11, 31))), "2026-W53");
eq("2026-08-30 (周日)", isoWeek(new Date(Date.UTC(2026, 7, 30))), "2026-W35");
eq("2026-08-31 (周一)", isoWeek(new Date(Date.UTC(2026, 7, 31))), "2026-W36");

const b = buckets(new Date(Date.UTC(2026, 7, 30, 12, 0, 0)));
eq("day", b.day, "2026-08-30");
eq("week", b.week, "2026-W35");
eq("month", b.month, "2026-08");
eq("year", b.year, "2026");
eq("all", b.all, "all");

// id 校验：正常 id 放行，注入类字符串挡掉
[
  ["relay-agentrouter", true],
  ["xlsx-novel-012", true],
  ["manual_ai_1", true],
  ["", false],
  ["'; DROP TABLE clicks; --", false],
  ["中文id", false],
  ["x".repeat(65), false],
].forEach(([id, want]) => eq(`ID_RE(${JSON.stringify(id).slice(0, 30)})`, ID_RE.test(id), want));

console.log(fail ? `\n${fail} 项失败` : "\n全部通过");
process.exit(fail ? 1 : 0);
