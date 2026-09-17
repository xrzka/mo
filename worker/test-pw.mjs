// 直接测试 Playwright 抓取 linovelib 章节，验证正确性
import { chromium } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

function stripTags(s) {
  return String(s||"").replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
}

async function fetchChapter(novelId, chapterId) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ]
  });
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  
  try {
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': 'https://www.linovelib.com/',
    });

    const pages = [];
    let p = `/novel/${novelId}/${chapterId}.html`;
    let pageNo = 1;

    while (pageNo <= 5) {
      await page.goto(`https://www.linovelib.com${p}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(2000);
      
      const html = await page.evaluate(() => document.documentElement.outerHTML);
      pages.push(html);
      
      const nextHref = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="/novel/"]'));
        const next = links.find(a => /\/\d+_\d+\.html$/.test(a.href));
        return next ? new URL(next.href).pathname : null;
      });
      if (!nextHref || nextHref === p) break;
      p = nextHref;
      pageNo++;
    }

    await page.close();
    return pages;
  } finally {
    await browser.close();
  }
}

async function parseChapter(htmls, novelId, chapterId) {
  const allBlocks = [];
  for (const html of htmls) {
    const idx = html.indexOf('id="mlfy_main_text"');
    if (idx < 0) continue;
    let raw = html.slice(idx);
    const pIdx = raw.indexOf('class="mlfy_page"');
    if (pIdx > 0) raw = raw.slice(0, pIdx);
    
    const matches = [...raw.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)];
    for (const m of matches) {
      const text = stripTags(m[1]);
      if (text && !/^Advertisement$/i.test(text) && !/pagead|googlesyndication|googleads/i.test(text)) {
        allBlocks.push({ type: "text", text });
      }
    }
  }
  return { id: chapterId, novelId, title: `章节 ${chapterId}`, blocks: allBlocks };
}

// 测试：4649/332058（已知正确顺序的章节）
console.log("=== 测试 1: 4649/332058 ===");
const data = await fetchChapter('4649', '332058');
console.log(`抓到 ${data.length} 页`);
const result = await parseChapter(data, '4649', '332058');
console.log(`解析出 ${result.blocks.length} 段`);
console.log("前 10 段:");
result.blocks.slice(0, 10).forEach((b, i) => console.log(`  [${i}] ${b.text.slice(0, 80)}`));

// 测试 2: 5360/334725（用户报告错位的章节）
console.log("\n=== 测试 2: 5360/334725 ===");
const data2 = await fetchChapter('5360', '334725');
console.log(`抓到 ${data2.length} 页`);
const result2 = await parseChapter(data2, '5360', '334725');
console.log(`解析出 ${result2.blocks.length} 段`);
console.log("前 10 段:");
result2.blocks.slice(0, 10).forEach((b, i) => console.log(`  [${i}] ${b.text.slice(0, 80)}`));