// 小说正文插图解析验证：把上游真实 HTML 喂给 parseNovelChapter，
// 断言插图被解析出来、URL 正确、且 asset 白名单放行其域名。
import { readFileSync } from "node:fs";
import worker, { _internal } from "./index.js";

const { parseNovelChapter } = _internal;
if (typeof parseNovelChapter !== "function") {
  console.error("parseNovelChapter 未导出");
  process.exit(1);
}

// 1) 构造与 linovelib 一致的正文结构（lazysizes：src 占位 + data-src 真地址）
const html = `<!doctype html><html><body>
<div id="acontent" class="content">
  <p>正文第一段。</p>
  <img src="/images/sloading.svg" data-src="https://img3.readpai.com/5/5340/333609/321949.jpeg" class="imagecontent lazyload">
  <p>插图说明段落。</p>
  <img src="/images/sloading.svg" data-src="https://img3.readpai.com/5/5340/333609/321950.jpeg" class="imagecontent lazyload">
  <p>结尾段落。</p>
</div>
</body></html>`;

const out = parseNovelChapter(html, "https://tw.linovelib.com", "5340", "333609");
const images = out.blocks.filter((b) => b.type === "image");
const texts = out.blocks.filter((b) => b.type === "text");

const checks = [];
const ok = (name, cond, extra = "") => checks.push({ name, pass: !!cond, extra });

ok("解析出 2 张插图", images.length === 2, `实际 ${images.length}`);
ok("解析出 3 段正文", texts.length === 3, `实际 ${texts.length}`);
ok("插图走 asset 代理", images.every((b) => b.src.startsWith("/api/watch/asset?")), images[0]?.src?.slice(0, 70));
ok("不含占位图 sloading", images.every((b) => !/sloading/.test(b.src)));
ok("原始地址是 readpai", images.every((b) => decodeURIComponent(b.src).includes("readpai.com")));

for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.extra ? "  → " + c.extra : ""}`);

// 2) 装饰图仍要被过滤（防止为了修插图把广告放进来）
const { isNovelDecorationImage } = _internal;
const deco = [
  ["正文插图 readpai（域名含 ad，必须保留）", "https://img3.readpai.com/5/5340/333609/321949.jpeg", false],
  ["懒加载占位 sloading.svg", "https://tw.linovelib.com/images/sloading.svg", true],
  ["站徽 logo.png", "https://tw.linovelib.com/images/logo.png", true],
  ["图标 icon_arrow.gif", "https://tw.linovelib.com/themes/zhmb/icon_arrow.gif", true],
  ["广告图 /ads/banner.jpg", "https://tw.linovelib.com/ads/banner.jpg", true],
  ["头像 avatar_1.jpg", "https://tw.linovelib.com/avatar_1.jpg", true],
];
console.log("\n--- 装饰图过滤 ---");
for (const [name, url, shouldFilter] of deco) {
  const got = isNovelDecorationImage(url);
  const pass = got === shouldFilter;
  if (!pass) checks.push({ name: `过滤判定 ${name}`, pass: false, extra: `期望 ${shouldFilter} 实得 ${got}` });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} → ${got ? "过滤" : "保留"}`);
}

const failed = checks.filter((c) => !c.pass).length;
console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
