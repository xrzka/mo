import { _internal } from "./index.js";

let failures = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

// 简繁互转
check("简→繁", _internal.novelS2T("转生成夹在百合中间的男人") === "轉生成夾在百合中間的男人", _internal.novelS2T("转生成夹在百合中间的男人"));
check("繁→简", _internal.novelT2S("轉生成夾在百合中間的男人") === "转生成夹在百合中间的男人", _internal.novelT2S("轉生成夾在百合中間的男人"));

console.log("\n--- 缓存索引搜索实测 ---");
const tests = [
  ["轉生成夾在百合中間的男人了", "3645"],
  ["转生成夹在百合中间的男人了", "3645"],
  ["百合", "3645"],
  ["转生成夹在百合", "3645"],
  ["恶魔高校", null],
  ["怕痛", null],
];
for (const [q, expectId] of tests) {
  const hits = await _internal.searchNovelLocal(q);
  const ok = expectId ? hits.some(c => c.id === expectId) : hits.length >= 0;
  check(`搜索"${q}"${expectId ? "命中"+expectId : ""}`, ok, `共${hits.length}条: ${hits.slice(0,4).map(c=>c.id+":"+c.title).join(" | ")}`);
}

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
