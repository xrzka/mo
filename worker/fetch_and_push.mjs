// Fetch all pages of a chapter from source site, extract text + image blocks in order, push to KV
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const NOVEL_ID = "5360";
const CHAPTER_ID = "334725";

function stripTags(text) {
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

/** 过滤广告/图标类装饰图（logo、icon、ads 等） */
function isNovelDecorationImage(url) {
  try {
    const name = new URL(url).pathname.split('/').pop() || '';
    const path = url.toLowerCase();
    if (/\.svg(?:$|\?)/i.test(path)) return true;
    if (/(^|\/)(?:logo|icon|avatar|sloading|loading|blank|spacer|placeholder)[^/]*$/i.test(path)) return true;
    if (/(?:^|[-_.])(?:logo|icon|avatar|ads?|banner)(?:[-_.]|$)/i.test(name)) return true;
    return false;
  } catch { return false; }
}

/**
 * 深度感知提取 id=container 的内容（正确处理嵌套 div）
 */
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

/**
 * 从 HTML 容器内提取段落 + 图片块（按标签顺序）。
 * 返回 { blocks: [{type:"text",text}|{type:"image",src}], urlNext, page, totalPages }
 */
function extractBlocks(html) {
  // Extract ReadParams
  const rpMatch = html.match(/ReadParams\s*=\s*\{([\s\S]*?)\}/);
  let urlNext = '', page = '', totalPages = 0;
  if (rpMatch) {
    const raw = rpMatch[1];
    const nextM = raw.match(/url_next\s*:\s*['"]([^'"]*)['"]/);
    if (nextM) urlNext = nextM[1];
    const pageM = raw.match(/page\s*:\s*['"]([^'"]*)['"]/);
    if (pageM) page = pageM[1];
    const subidM = raw.match(/subid\s*:\s*['"]([^'"]*)['"]/);
    if (subidM) {
      const m = subidM[1].match(/\/(\d+)/);
      if (m) totalPages = parseInt(m);
    }
  }

  // 用深度感知提取容器内容（处理嵌套 div）
  const containers = ['acontent', 'TextContent', 'mlfy_main_text'];
  let raw = '';
  for (const id of containers) {
    const rawHtml = extractContainerById(html, id);
    if (rawHtml.length > 50) { raw = rawHtml; break; }
  }
  if (!raw || raw.length < 100) {
    const m = html.match(/class=["'][^"']*(acontent|TextContent|read-content)[^"']*["'][^>]*>([\s\S]*?)<\//i);
    if (m) raw = m[2];
  }
  if (!raw || raw.length < 100) {
    const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    raw = m ? m[1] : html;
  }

  // 按标签顺序提取：<img> → 图片块，<p> → 文本块
  const blocks = [];
  const tagRe = /<img[^>]+(?:data-src|src)=["']([^"']+)["'][^>]*>|<p[^>]*>([\s\S]*?)<\/p>/gi;
  let tm;
  while ((tm = tagRe.exec(raw))) {
    if (tm[1]) {
      const imageUrl = tm[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"');
      if (imageUrl && !isNovelDecorationImage(imageUrl)) {
        blocks.push({ type: "image", src: imageUrl });
      }
    } else if (tm[2]) {
      const text = stripTags(tm[2]);
      if (!text) continue;
      if (/^Advertisement$/i.test(text)) continue;
      if (/adsbygoogle|googlesyndication|googleads|pagead/i.test(text)) continue;
      if (text.includes("内容加载失败") || text.includes("內容加載失敗")) continue;
      if (text.includes("加載失敗") || text.includes("加载失败")) continue;
      blocks.push({ type: "text", text });
    }
  }

  // 兜底：完全沒有 <p>/<img> 時，用 <br>/換行切分
  if (blocks.length === 0) {
    const text = raw
      .replace(/<\/p>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
    const parts = text.includes('\n')
      ? text.split('\n')
      : text.split(/\s{2,}/);
    for (const p of parts) {
      const trimmed = p.trim();
      if (trimmed) blocks.push({ type: "text", text: trimmed });
    }
  }

  return { blocks, urlNext, page, totalPages };
}

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return await res.text();
}

async function fetchChapter() {
  const allParagraphs = [];
  let pageCount = 0;
  let totalPages = 0;
  let origin = '';

  const origins = [
    'https://www.linovelib.com',
    'https://tw.linovelib.com',
    'https://bilinovel.com'
  ];

  // 确定可用的 origin
  let html = '';
  for (const o of origins) {
    try {
      html = await fetchPageWithRedirect(`${o}/novel/${NOVEL_ID}/${CHAPTER_ID}.html`);
      origin = o;
      break;
    } catch (e) {
      console.error(`  Origin ${o} failed: ${e.message}`);
    }
  }
  if (!html) throw new Error('All origins failed for page 1');

  // 直接按页号逐页抓取 (1, 2, 3, 4...)，不依赖 url_next
  for (let pageNum = 1; pageNum <= 10; pageNum++) {
    const path = pageNum === 1
      ? `/novel/${NOVEL_ID}/${CHAPTER_ID}.html`
      : `/novel/${NOVEL_ID}/${CHAPTER_ID}_${pageNum}.html`;
    const url = `${origin}${path}`;

    try {
      html = await fetchPage(url);
    } catch (e) {
      console.log(`  Page ${pageNum} not found, stopping`);
      break;
    }

    pageCount++;
    console.log(`Fetching page ${pageCount}: ${url}`);

    const { blocks, totalPages: tp } = extractBlocks(html);
    if (pageCount === 1) totalPages = tp;

    allParagraphs.push(...blocks);
    console.log(`  Got ${blocks.length} blocks (${allParagraphs.length} total)`);
  }

  return { paragraphs: allParagraphs, pages: pageCount, totalPages };
}

fetchChapter().then(result => {
  console.log(`\nTotal: ${result.paragraphs.length} blocks over ${result.pages} pages`);

  // Push to KV
  const payload = {
    key: `${NOVEL_ID}/${CHAPTER_ID}`,
    blocks: result.paragraphs,
    pages: result.pages
  };

  fetch("https://mo-stats.werneruszcb71.workers.dev/api/admin/novel-cache", {
    method: "POST",
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(r => r.json()).then(d => {
    console.log('KV push result:', JSON.stringify(d));
  });
}).catch(e => console.error(e));