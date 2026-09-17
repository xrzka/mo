// 找到了！浏览器里那些额外 112 段，是从另一个容器 #TextContent 里读取的，而不是 mlfy_main_text。
// #TextContent 的子节点包括广告（adsbygoogle），但随后 JS 再次解析并提取 #TextContent 里的 "正文" 段落，填充到 mlfy_main_text 里，重新排序并形成完整 143 段。
// 这正是 linobelib 的"正文恢复"逻辑：JS 检测到 mlfy_main_text 里只有 9 段，认为内容被屏蔽，于是从 #TextContent 里提取全部 <p> 并重新插入 mlfy_main_text 中，生成完整顺序。
// 所以要解决问题，只需模拟这个 JS 逻辑：获取 #TextContent 里的所有 <p>（过滤广告），并按照 mlfy_main_text 的原始顺序补全，生成完整正文数组。

import re, sys
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding="utf-8")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"

def strip(s): return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', s)).strip()
def paras(html):
    idx=html.find('id="mlfy_main_text"')
    if idx<0: return []
    raw=html[idx:]
    pIdx=raw.find('class="mlfy_page"')
    if pIdx>0: raw=raw[:pIdx]
    return [strip(m.group(1)) for m in re.finditer(r'<p[^>]*>([\s\S]*?)</p>', raw)]

// 测试一个章节：获取 mlfy_main_text 里的 9 段 + #TextContent 里的 143 段，合并并去重，验证顺序是否正确
async function testRecovery() {
  const browser = await chromium.launch({headless: false, args: ['--start-minimized', '--window-position=-32000,-32000']});
  const ctx = await browser.newContext({userAgent: UA, locale: 'zh-CN'});
  const page = await ctx.newPage();
  await page.goto('https://www.linovelib.com/novel/4649/332058.html', {waitUntil: 'domcontentloaded', timeout: 45000});
  await page.waitForTimeout(5000);

  const mainParas = await page.evaluate(() => {
    const root = document.querySelector('#mlfy_main_text') || document.body;
    const ps = Array.from(root.querySelectorAll('p'));
    return ps.map(p => (p.textContent || '').trim()).filter(Boolean);
  });

  const textContentParas = await page.evaluate(() => {
    const el = document.querySelector('#TextContent') || document.body;
    const ps = Array.from(el.querySelectorAll('p'));
    return ps.map(p => (p.textContent || '').trim()).filter(Boolean);
  });

  console.log(`mlfy_main_text 里: ${mainParas.length} 段`);
  console.log(`#TextContent 里: ${textContentParas.length} 段`);

  // 合并：优先用 mlfy_main_text 里的段落（它们在 DOM 里是正确的顺序），再用 #TextContent 里的段落补全（可能按文本顺序或原顺序）
  const merged = [...mainParas];
  for (const t of textContentParas) {
    if (!merged.includes(t)) merged.push(t);
  }

  console.log(`合并后总共: ${merged.length} 段`);
  console.log('前 20 段:');
  merged.slice(0,20).forEach((t,i) => console.log(`  [${i}] ${t.slice(0,60)}`));

  // 验证顺序：第1 段包含"最近这段时间"，第3 段包含"总算结束"
  const ok = merged.length >= 3 && merged[0].includes('最近这段时间') && merged[2].includes('总算结束');
  console.log(`顺序验证: ${ok}`);

  await browser.close();
}

async function main() {
  await testRecovery();
  process.exit(0);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
