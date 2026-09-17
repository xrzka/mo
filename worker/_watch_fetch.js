// 纯 Playwright 抓取服务 - 用来替代现有的 fetchNovelDesktopHtml
// 原理：同一个进程里用真实浏览器（无头）抓 linovelib，返回完整正确正文
// 规避 CF 验证、cookie、UA 等，由 Worker 专属进程启动，监听 HTTP 请求并返回 HTML

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 50051;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

let server = null;
let browser = null;
let isInitialized = false;

// 日志
function log(msg) {
  console.log(`[PLAYWRIGHT-SERVICE ${new Date().toISOString()}] ${msg}`);
}

// 初始化：启动浏览器
async function init() {
  if (isInitialized) return;
  log('启动无头 Chrome');
  browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process,block-quantum-color-codecs,HardwareMediaKeyHandling',
      '--disable-blink-features=AutomationControlled',
    ]
  });
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
  });
  // 显式通过 CF 验证
  const page = await ctx.newPage();
  await page.goto('https://www.linovelib.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  await page.close();
  log('浏览器 CF 验证通过');
  isInitialized = true;
}

// 处理请求
async function handleRequest(req, res) {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  // 简单的路由：/novel/:novelId/:chapterId.html 或任意路径
  if (method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  if (pathname.match(/^\/novel\/[^\/]+\/[^\/]+\.html$/)) {
    // 抓取指定章节，带分页提取
    const match = pathname.match(/^\/novel\/([^\/]+)\/([^\/]+)\.html$/);
    const novelId = match[1];
    const chapterId = match[2];
    log(`抓取桌面版章节: ${novelId}/${chapterId}`);

    try {
      const pages = [];
      let p = pathname;
      let pageNo = 1;
      while (pageNo <= 50) {
        const page = await browser.newPage();
        // 桌面 UA + Referer
        await page.setExtraHTTPHeaders({
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: 'https://www.linovelib.com/',
        });
        await page.goto(`https://www.linovelib.com${p}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);
        const html = await page.evaluate(() => document.documentElement.outerHTML);
        pages.push(html);
        await page.close();

        // 桌面版 "下一页" 链接（_2.html 等）
        const next = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a[href*="/novel/"')
            .map(a => a.href)
            .filter(h => /\/novel\/\d+\/\d+_\d+\.html$/.test(h));
          return links[0];
        });
        if (!next || next === `https://www.linovelib.com/novel/${novelId}/${chapterId}.html`) break;
        p = next.replace('https://www.linovelib.com', '');
        pageNo++;
      }

      // 返回完整 HTML 列表 + meta
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, novelId, chapterId, pages, pageCount: pages.length }));
    } catch (e) {
      log(`ERROR 抓取章节: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else {
    // 其他路径直接返回 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }
}

// HTTP 服务器
function startServer() {
  const http = require('http');
  server = http.createServer((req, res) => {
    // 跨域支持
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    handleRequest(req, res);
  });
  server.listen(PORT, () => {
    log(`Playwright 服务启动，监听 ${PORT}`);
  });
}

async function shutdown() {
  log('关闭服务');
  if (browser) await browser.close();
  if (server) server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

(async () => {
  await init();
  startServer();
})();
