// Playwright 抓取服务（ESM）
// 原理：复用本地 Playwright 抓 linovelib，返回完整正确顺序
// 端口: 50051
import http from 'node:http';
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = parseInt(process.env.PORT || '50051');
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const cache = new Map();

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function stripTags(s) {
  return String(s||"").replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
}

async function fetchWithBrowser(novelId, chapterId) {
  const key = `${novelId}/${chapterId}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < 15 * 60 * 1000) {
    log(`Cache hit: ${key}`);
    return cached;
  }

  log(`Fetching: ${key}`);

  // 尝试连接本地 Chrome（通过 CDP 或 ws:// 端口）
  let browser = null;
  let page = null;
  
  // 方式1: 检查是否有已开启远程调试的 Chrome
  try {
    const cdpTarget = await getCdpTarget();
    if (cdpTarget) {
      browser = await chromium.connectOverCDP(cdpTarget);
      log(`Connected to existing Chrome via CDP`);
    }
  } catch(e) {
    log(`No existing Chrome: ${e.message}`);
  }

  // 方式2: 如果没有，启动 headless
  if (!browser) {
    log('Launching headless browser...');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ]
    });
    log('Headless browser launched');
  }

  const ctx = browser.contexts ? browser.contexts()[0] : null;
  if (!ctx) throw new Error('No browser context');

  page = await ctx.newPage();
  try {
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': 'https://www.linovelib.com/',
    });

    const pages = [];
    let p = `/novel/${novelId}/${chapterId}.html`;
    let pageNo = 1;

    while (pageNo <= 50) {
      log(`Page ${pageNo}: ${p}`);
      await page.goto(`https://www.linovelib.com${p}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(2000);
      
      const html = await page.evaluate(() => document.documentElement.outerHTML);
      pages.push(html);
      
      // 找下一页链接（桌面版：/novel/:id/:chapterId_N.html）
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
    
    const result = { pages, pageCount: pages.length };
    cache.set(key, { at: Date.now(), ...result });
    log(`Done: ${key} -> ${pages.length} pages`);
    return result;
  } catch(e) {
    if (page) await page.close();
    throw e;
  } finally {
    // 不关闭 browser（复用）
  }
}

async function getCdpTarget() {
  try {
    const res = await fetch('http://localhost:9222/json/version', { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const info = await res.json();
      return info.webSocketDebuggerUrl;
    }
  } catch {}
  return null;
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

async function handleRequest(req, res) {
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
      const result = await parseChapter(data.pages, novelId, chapterId);
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch(e) {
      log(`Error: ${e.message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  }
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  log(`Playwright service started on port ${PORT}`);
});

process.on('SIGINT', () => { process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });