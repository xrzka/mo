/**
 * fix_chapter_order.mjs
 *
 * 对比 Worker API 返回的 blocks 顺序与源站 (linovelib.com) 的实际顺序，
 * 定位内容错乱根因，然后用正确数据覆盖 KV 缓存。
 *
 * 用法：node fix_chapter_order.mjs
 * 可选：node fix_chapter_order.mjs --novel=5360 --chapter=334725
 */
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const getArg = (name, default_) => {
  const match = args.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split("=")[1] : default_;
};
const NOVEL_ID = getArg("novel", "5360");
const CHAPTER_ID = getArg("chapter", "334725");
const KV_KEY = `${NOVEL_ID}/${CHAPTER_ID}`;

const WORKER_API = "https://mo-stats.pages.dev";
const ADMIN_API = "https://mo-stats.werneruszcb71.workers.dev";
const SOURCE_ORIGIN = "https://www.linovelib.com";

const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 过滤广告/图标类装饰图 */
function isNovelDecorationImage(url) {
  try {
    const u = new URL(url);
    const name = u.pathname.split('/').pop() || '';
    const path = u.pathname.toLowerCase();
    if (/\.svg(?:$|\?)/i.test(path)) return true;
    if (/(?:^|\/)(?:logo|icon|avatar|sloading|loading|blank|spacer|placeholder)[^/]*$/i.test(path)) return true;
    if (/(?:^|[-_.])(?:logo|icon|avatar|ads?|banner)(?:[-_.]|$)/i.test(name)) return true;
    return false;
  } catch { return false; }
}

/** 深度感知提取 id=container 的内容（正确处理嵌套 div） */
function extractContainerById(html, id) {
  const startRe = new RegExp(`id=["']${id}["'][^>]*>`, 'i');
  const startM = html.match(startRe);
  if (!startM) return '';
  const startIndex = startM.index + startM[0].length;
  let depth = 1;
  let i = startIndex;
  while (i < html.length && depth > 0) {
    const nextOpen = html.indexOf('<div', i);
    const nextClose = html.indexOf('</div>', i);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      const afterDiv = html.indexOf('>', nextOpen + 4);
      if (afterDiv === -1 || afterDiv > nextClose) { depth--; i = nextClose + 6; }
      else { depth++; i = afterDiv + 1; }
    } else {
      depth--;
      i = nextClose + 6;
    }
  }
  return html.slice(startIndex, i - 6);
}

console.log(`=== 诊断 ${KV_KEY} 内容顺序 ===\n`);

/* ---------- 1. 拉 Worker API ---------- */
console.log("[1/3] 拉取 Worker API…");
const workerRes = await fetch(
  `${WORKER_API}/api/watch/novel?action=chapter&novel=${NOVEL_ID}&chapter=${CHAPTER_ID}`,
  { headers: { Accept: "application/json" } }
);
if (!workerRes.ok) {
  console.error(`Worker API 返回 ${workerRes.status}`);
  process.exit(1);
}
const workerData = await workerRes.json();
const workerBlocks = (workerData.blocks || []).map((b) =>
  b.type === "image" ? `[IMG] ${b.src}` : b.text
);
console.log(`  Worker: ${workerBlocks.length} blocks, pages=${workerData.pages}`);
console.log(`  前 3 段：`);
workerBlocks.slice(0, 3).forEach((t, i) => console.log(`    [W${i + 1}] ${t.slice(0, 60)}`));

/* ---------- 2. 拉源站 4 页 ---------- */
console.log("\n[2/3] 拉取源站各页…");

async function fetchSourcePage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": DESKTOP_UA,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Referer": `${SOURCE_ORIGIN}/`,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

/**
 * 提取容器内段落 + 图片块（按标签顺序）。
 * 桌面版结构：<div id="mlfy_main_text">...</div> 内含完整正文段落和插图。
 */
function extractBlocks(html) {
  const containers = ["mlfy_main_text", "acontent", "TextContent"];
  let raw = "";
  for (const id of containers) {
    const extracted = extractContainerById(html, id);
    if (extracted.length > 50) { raw = extracted; break; }
  }
  if (!raw || raw.length < 100) raw = html;

  // 按标签顺序提取：<img> → 图片块，<p> → 文本块
  const blocks = [];
  const tagRe = /<img[^>]+(?:data-src|data-original|src)=["']([^"']+)["'][^>]*>|<p[^>]*>([\s\S]*?)<\/p>/gi;
  let tm;
  while ((tm = tagRe.exec(raw))) {
    if (tm[1]) {
      const imageUrl = tm[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"');
      if (imageUrl && !isNovelDecorationImage(imageUrl)) {
        blocks.push({ type: "image", src: imageUrl });
      }
    } else if (tm[2]) {
      let text = tm[2]
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      if (/^Advertisement$/i.test(text)) continue;
      if (/adsbygoogle|googlesyndication|googleads|pagead/i.test(text)) continue;
      if (text.includes("内容加载失败") || text.includes("內容加載失敗")) continue;
      if (text.includes("加載失敗") || text.includes("加载失败")) continue;
      blocks.push({ type: "text", text });
    }
  }

  // 兜底：完全没有 <p>/<img> 块时，用 <br>/换行切分（替换而非追加，避免重复）
  if (blocks.length === 0) {
    // 先把 br/n 改成換行，保留句末分隔線，再 collapse 為單空格段
    const text = raw
      .replace(/<\/p>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
    // 優先按換行切分；若無換行則按雙空格切分
    const parts = text.includes('\n')
      ? text.split('\n')
      : text.split(/\s{2,}/);
    for (const p of parts) {
      const trimmed = p.trim();
      if (trimmed) blocks.push({ type: "text", text: trimmed });
    }
  }
  return blocks;
}

const sourcePages = [];
for (let page = 1; page <= 4; page++) {
  const path = page === 1
    ? `/novel/${NOVEL_ID}/${CHAPTER_ID}.html`
    : `/novel/${NOVEL_ID}/${CHAPTER_ID}_${page}.html`;
  const url = `${SOURCE_ORIGIN}${path}`;
  try {
    console.log(`  抓取 ${path}…`);
    const html = await fetchSourcePage(url);
    const blocks = extractBlocks(html);
    const textCount = blocks.filter(b => b.type === "text").length;
    const imgCount = blocks.filter(b => b.type === "image").length;
    sourcePages.push({ page, blocks });
    console.log(`    ${textCount} 段 + ${imgCount} 张图`);
  } catch (e) {
    console.log(`    失败：${e.message}`);
    break;
  }
}

/* ---------- 3. 对比顺序 ---------- */
console.log("\n[3/3] 对比顺序…");
const clean = (s) => s.replace(/\[.*?\]/g, "").replace(/^P\d+\.\d+\s/, "");
const sourceFirst = sourcePages[0] ? sourcePages[0].blocks[0] || null : null;
const workerFirst = workerBlocks[0] || "";

// 取第一个文本块对比
let sourceFirstText = "";
let workerFirstText = workerBlocks[0] || "";
if (sourcePages[0]) {
  const firstTextBlock = sourcePages[0].blocks.find(b => b.type === "text");
  sourceFirstText = firstTextBlock ? firstTextBlock.text : "";
}

console.log(`\n源站第 1 段：${sourceFirstText.slice(0, 50)}`);
console.log(`Worker 第 1 段：${workerFirstText.slice(0, 50)}`);

// 逐段检查：源站文本是否在 Worker blocks 里出现
let mismatchCount = 0;
for (const [idx, sp] of sourcePages.entries()) {
  for (const block of sp.blocks) {
    if (block.type !== "text") continue;
    const foundInWorker = workerBlocks.some(
      (wb) => clean(String(wb)).includes(block.text.slice(0, 20))
    );
    if (!foundInWorker) {
      if (mismatchCount < 5) {
        console.log(`  缺失：源站 P${idx + 1} 「${block.text.slice(0, 40)}…」 未出现在 Worker`);
      }
      mismatchCount++;
    }
  }
}
console.log(`\n总源站块数：${sourcePages.reduce((s, sp) => s + sp.blocks.length, 0)}`);
console.log(`Worker blocks 数：${workerBlocks.length}`);
console.log(`源站有但 Worker 没有的段落数：${mismatchCount}`);

// 检查 Worker blocks 是否有重复段（错乱的重要标志）
const seen = new Set();
let dupCount = 0;
for (const wb of workerBlocks) {
  const norm = clean(String(wb)).slice(0, 30);
  if (seen.has(norm)) dupCount++;
  seen.add(norm);
}
console.log(`Worker blocks 中重复段落数：${dupCount}`);

if (mismatchCount > 0 || dupCount > 0) {
  console.log(`\n⚠  检测到内容错乱：${mismatchCount} 段缺失 + ${dupCount} 段重复`);
  console.log("正在用源站数据覆盖 KV 缓存…\n");

  /* ---------- 4. 推正确数据到 KV（含图片） ---------- */
  const allBlocks = sourcePages.flatMap((sp) => sp.blocks);
  const textCount = allBlocks.filter(b => b.type === "text").length;
  const imgCount = allBlocks.filter(b => b.type === "image").length;
  const pages = sourcePages.length;

  console.log(`  准备推送 ${allBlocks.length} blocks（${textCount} 段 + ${imgCount} 图，${pages} 页）到 KV…`);
  const kvRes = await fetch(`${ADMIN_API}/api/admin/novel-cache`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: KV_KEY, blocks: allBlocks, pages }),
  });
  const kvData = await kvRes.json();
  console.log(`  KV 推送结果：${JSON.stringify(kvData)}`);

  if (kvData.ok) {
    console.log(`\n✅ 修复完成。${KV_KEY} 的 KV 缓存已用源站正确顺序覆盖（含 ${imgCount} 张插图）。`);
    console.log(`   清 Worker 内存缓存（30 分钟 TTL）后，mo 站刷新即正常。`);
  }
} else {
  console.log(`\n✅ ${KV_KEY} 顺序正确，无需修复。`);
}
