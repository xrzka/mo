// 离线复现「刷新后继续阅读条不出现」：把 app.js 里那段匹配逻辑原样抄出来，
// 用真实章节数据 + 各种 localStorage 记录形态跑一遍，看到底哪种形态会落到 resumeAt = -1。
// 运行：node _resume_logic_test.mjs

const chapters = [
  { id: "333596", title: "序章" },
  { id: "333597", title: "第1話 童年（1）p1" },
  { id: "333598", title: "第1話 童年（1）p2" },
  { id: "333599", title: "第1話 童年（1）" },
  { id: "333600", title: "第2話 童年（2）" },
  { id: "333601", title: "第3話 童年（3）" },
];

// ---- 当前 app.js 的逻辑（原样） ----
function matchCurrent(saved) {
  let resumeAt = -1;
  if (saved && String(saved.id) === "5340" && chapters.length) {
    if (Number.isInteger(saved.partIndex) && saved.partIndex >= 0 && saved.partIndex < chapters.length) {
      const byIndex = !saved.partId
        || typeof saved.partId !== "string"
        || String(chapters[saved.partIndex].id) === saved.partId;
      if (byIndex) resumeAt = saved.partIndex;
    }
    if (resumeAt < 0 && saved.partId) {
      resumeAt = chapters.findIndex((c) => String(c.id) === String(saved.partId));
    }
  }
  return resumeAt;
}

// ---- 放宽后的逻辑：以 partId 为准，下标只做兜底 ----
function matchFixed(saved) {
  if (!saved || String(saved.id) !== "5340" || !chapters.length) return -1;
  const eq = (a, b) => a != null && b != null && String(a) === String(b);
  // 1) partId 是权威键（上游 id 稳定，id 对得上就是同一章）
  if (saved.partId) {
    const byId = chapters.findIndex((c) => eq(c.id, saved.partId));
    if (byId >= 0) return byId;
  }
  // 2) 下标做兜底，但要求下标处标题也对得上，防章节表变动后跳错
  if (Number.isInteger(saved.partIndex) && saved.partIndex >= 0 && saved.partIndex < chapters.length) {
    const at = chapters[saved.partIndex];
    if (!saved.partTitle || String(at.title) === String(saved.partTitle)) return saved.partIndex;
  }
  // 3) 最后按标题找
  if (saved.partTitle) {
    const byTitle = chapters.findIndex((c) => String(c.title) === String(saved.partTitle));
    if (byTitle >= 0) return byTitle;
  }
  return -1;
}

const cases = [
  ["诊断快照：partIndex=5(数字) partId=333600(字符串)", { id: "5340", partIndex: 5, partId: "333600", partTitle: "第2話 童年（2）" }],
  ["partId 是数字 333600（上游偶尔返数字）", { id: "5340", partIndex: 5, partId: 333600, partTitle: "第2話 童年（2）" }],
  ["老记录：无 partIndex，只有 partId", { id: "5340", partId: "333600", partTitle: "第2話 童年（2）" }],
  ["老记录：partIndex=null，partId 空", { id: "5340", partIndex: null, partId: "", partTitle: "第2話 童年（2）" }],
  ["下标越界（章节数变了）但有 partId", { id: "5340", partIndex: 999, partId: "333600", partTitle: "第2話 童年（2）" }],
  ["下标处的章已换（id 对不上，下标失效）", { id: "5340", partIndex: 5, partId: "333597", partTitle: "第1話 童年（1）p1" }],
  ["只有标题", { id: "5340", partIndex: null, partId: "", partTitle: "第2話 童年（2）" }],
  ["partIndex 存成字符串 \"5\"", { id: "5340", partIndex: "5", partId: "333600", partTitle: "第2話 童年（2）" }],
  ["别的书（id 不匹配）", { id: "9999", partIndex: 5, partId: "333600", partTitle: "第2話 童年（2）" }],
];

let bad = 0;
console.log("case".padEnd(46), "current", "fixed");
for (const [name, saved] of cases) {
  const cur = matchCurrent(saved);
  const fix = matchFixed(saved);
  const expectOther = saved.id !== "5340";
  const ok = expectOther ? fix < 0 : fix >= 0;
  if (!ok) bad++;
  console.log(
    name.padEnd(46),
    String(cur).padEnd(7),
    String(fix).padEnd(5),
    ok ? "" : "  <== FIX FAIL"
  );
}
console.log(bad ? `\nFAIL: ${bad} 项不符合预期` : "\nOK: 全部符合预期（partId 优先，下标/标题兜底）");
process.exit(bad ? 1 : 0);
