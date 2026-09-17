// Service 快速测试：直接用浏览器获取某章节，验证完整性与正确性
// 启动时先执行测试，验证后退出
import http from 'node:http';
import { chromium } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = parseInt(process.env.PORT || '50051');
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

function stripTags(s) {
  return String(s||"").replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
}

async function fetchWithBrowser(novelId, chapterId) {
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

async function main() {
  const novelId = '4649';
  const chapterId = '332058';
  console.log(`Testing fetch: ${novelId}/${chapterId}`);
  const pages = await fetchWithBrowser(novelId, chapterId);
  console.log(`Got ${pages.length} pages`);
  const allBlocks = [];
  for (const html of pages) {
    const idx = html.indexOf('id="mlfy_main_text"');
    if (idx < 0) continue;
    let raw = html.slice(idx);
    const pIdx = raw.indexOf('class="mlfy_page"');
    if (pIdx > 0) raw = raw.slice(0, pIdx);
    
    const matches = [...raw.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)];
    for (const m of matches) {
      const text = stripTags(m[1]);
      if (text && !/^Advertisement$/i.test(text) && !/pagead|googlesyndication|googleads/i.test(text)) {
        allBlocks.push(text);
      }
    }
  }
  console.log(`Total blocks: ${allBlocks.length}`);
  console.log(`Sample blocks:
${allBlocks.slice(0, 20).map((b, i) => `[${i}] ${b.slice(0, 80)}...`).join('\n')}`);
  
  // 检查连贯性
  if (allBlocks.length >= 3) {
    const ok = allBlocks[0].includes('最近这段时间') && allBlocks[2].includes('总算结束');
    console.log(`Consecutive (first+third): ${ok}`);
  }
  
  // 启动 HTTP 服务器供 Worker 使用
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const parts = url.pathname.split('/').filter(Boolean);
    
    if (parts.length >= 2 && parts[0] === 'novel') {
      const novelId = parts[1];
      const chapterId = parts[2].replace('.html', '');
      try {
        const data = await fetchWithBrowser(novelId, chapterId);
        const allBlocks = [];
        for (const html of data) {
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
        
        res.writeHead(200);
        res.end(JSON.stringify({ id: chapterId, novelId, title: `章节 ${chapterId}`, blocks: allBlocks }));
      } catch(e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });

  server.listen(PORT, () => {
    console.log(`Playwright service running on port ${PORT}`);
  });

  // 保持进程运行
  await new Promise(() => {});
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
