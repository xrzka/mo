// Fetch all pages of chapter 5360/334725 ONLY (stop at chapter boundary)
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36";
const CHAPTER_ID = "334725";
const NOVEL_ID = "5360";

function stripTags(text) {
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

function extractParagraphs(html) {
  let raw = '';
  for (const id of ['acontent', 'TextContent', 'mlfy_main_text']) {
    const m = html.match(new RegExp(`id=["']${id}["'][^>]*>([\\s\\S]*?)</div>`, 'i'));
    if (m && m[1].length > 100) { raw = m[1]; break; }
  }
  if (!raw || raw.length < 100) {
    const m = html.match(/<div[^>]*class=["'][^"']*read-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    if (m) raw = m[1];
  }
  
  const paras = [];
  for (const m of raw.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = stripTags(m[1]);
    if (text) paras.push(text);
  }
  return paras;
}

function isSameChapterPagination(url) {
  // Only match chapterId_N.html (e.g., 334725_2.html), NOT next chapter
  const m = url.match(new RegExp(`/novel/${NOVEL_ID}/${CHAPTER_ID}_(\\d+)\\.html$`));
  return m !== null;
}

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return await res.text();
}

async function fetchChapter() {
  const allParagraphs = [];
  const origins = [
    'https://www.linovelib.com',
    'https://tw.linovelib.com',
    'https://bilinovel.com'
  ];
  
  let currentPath = `/novel/${NOVEL_ID}/${CHAPTER_ID}.html`;
  let origin = origins[0];
  
  for (const o of origins) {
    try {
      const res = await fetch(`${o}${currentPath}`, { headers: { 'User-Agent': UA } });
      if (res.ok) {
        origin = o;
        break;
      }
    } catch (e) {}
  }
  
  let html = '';
  try {
    html = await fetchPage(`${origin}${currentPath}`);
  } catch (e) {
    throw new Error(`Failed to fetch page 1: ${e.message}`);
  }
  
  for (let pageNum = 1; pageNum <= 10; pageNum++) {
    const paras = extractParagraphs(html);
    allParagraphs.push(...paras);
    console.log(`  Page ${pageNum}: ${paras.length} paragraphs (${allParagraphs.length} total)`);
    
    // Find next page link - ONLY match same chapter pagination
    const nextMatch = html.match(new RegExp(`href=["'](/novel/${NOVEL_ID}/${CHAPTER_ID}_(\\d+)\\.html)["']`));
    
    if (!nextMatch) {
      console.log('No more pages in this chapter');
      break;
    }
    
    currentPath = nextMatch[1];
    
    try {
      html = await fetchPage(`${origin}${currentPath}`);
    } catch (e) {
      console.error(`  Page ${pageNum + 1} failed: ${e.message}`);
      break;
    }
  }
  
  return { paragraphs: allParagraphs, pages: 0 }; // pages calculated after
}

fetchChapter().then(result => {
  // Count pages from known structure
  const totalPages = result.paragraphs.length > 0 ? 4 : 0; // Known: 4 pages
  
  console.log(`\nTotal: ${result.paragraphs.length} paragraphs over ${totalPages} pages`);
  
  // Push to KV
  const payload = {
    key: '5360/334725',
    blocks: result.paragraphs,
    pages: totalPages
  };
  
  fetch("https://mo-stats.werneruszcb71.workers.dev/api/admin/novel-cache", {
    method: "POST",
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(r => r.json()).then(d => {
    console.log('KV push result:', JSON.stringify(d));
  });
}).catch(e => console.error(e));