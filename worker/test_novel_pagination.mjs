import worker, { _internal } from "./index.js";

// 测试 fetchNovelChapterAll 的分页遍历逻辑（mock fetch，不真打上游）
let failures = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

// mock 3 页章节：第1页 url_next=_2，第2页 url_next=_3，第3页 url_next=下一章（无 _N）
const pageHtml = (page, nextUrl) => `
<div id="abox">
<script>ReadParams={url_next:'${nextUrl}',page:'${page}',chapterid:'333600',chaptername:'第2話'};</script>
<div id="acontent" class="acontent">
<p>第${page}页段落A</p>
<p>第${page}页段落B</p>
</div>
</div>`;

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  const p = url.pathname;
  if (p === "/novel/5340/333600.html") {
    return new Response(pageHtml("1", "/novel/5340/333600_2.html"), { status: 200, headers: { "content-type": "text/html" } });
  }
  if (p === "/novel/5340/333600_2.html") {
    return new Response(pageHtml("2", "/novel/5340/333600_3.html"), { status: 200, headers: { "content-type": "text/html" } });
  }
  if (p === "/novel/5340/333600_3.html") {
    return new Response(pageHtml("3", "/novel/5340/333601.html"), { status: 200, headers: { "content-type": "text/html" } });
  }
  return new Response("not found", { status: 404 });
};

try {
  const chapter = await _internal.fetchNovelChapterAll("5340", "333600");
  check("分页抓取：合并 3 页共 6 段", chapter.blocks.length === 6, `实际 ${chapter.blocks.length}`);
  check("pages 数 = 3", chapter.pages === 3, String(chapter.pages));
  const texts = chapter.blocks.filter((b) => b.type === "text").map((b) => b.text);
  check("第1页首段正确", texts[0] === "第1页段落A", texts[0]);
  check("第2页内容正确", texts.includes("第2页段落A"), texts.join("|"));
  check("第3页末段正确", texts[texts.length - 1] === "第3页段落B", texts[texts.length - 1]);
} finally {
  globalThis.fetch = originalFetch;
}

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
