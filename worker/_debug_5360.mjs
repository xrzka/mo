// 深入调试 5360/334725
async function test() {
  console.log('=== 直接调 Worker API ===');
  const r1 = await fetch('https://mo-stats.werneruszcb71.workers.dev/api/watch/novel?action=chapter&novel=5360&chapter=334725');
  const d1 = await r1.json();
  console.log(`workers.dev: HTTP ${r1.status}, paragraphs: ${d1.blocks?.length}`);
  if (d1.blocks?.length) {
    console.log(`首段: ${(d1.blocks[0] || {}).text || d1.blocks[0]}`);
  } else if (d1.error) {
    console.log(`错误: ${d1.error}`);
  }

  console.log('\n=== 调 Pages API ===');
  const r2 = await fetch('https://mo-stats.pages.dev/api/watch/novel?action=chapter&novel=5360&chapter=334725');
  const d2 = await r2.json();
  console.log(`pages.dev: HTTP ${r2.status}, paragraphs: ${d2.blocks?.length}`);
  if (d2.blocks?.length) {
    console.log(`首段: ${(d2.blocks[0] || {}).text || d2.blocks[0]}`);
  } else if (d2.error) {
    console.log(`错误: ${d2.error}`);
  }

  // 测试纯 HTTP 抓取
  console.log('\n=== 测试纯 HTTP 抓取 ===');
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
  const html = await (await fetch('https://www.linovelib.com/novel/5360/334725.html', {
    headers: { 'User-Agent': UA, 'Referer': 'https://www.linovelib.com/' }
  })).text();
  console.log(`HTML 大小: ${html.length} bytes`);
  
  // 检查 mlfy_main_text
  const mainIdx = html.indexOf('id="mlfy_main_text"');
  console.log(`mlfy_main_text 位置: ${mainIdx >= 0 ? '找到' : '未找到'}`);
  if (mainIdx >= 0) {
    const mainContent = html.slice(mainIdx, mainIdx + 300);
    console.log(`mlfy_main_text 片段: ${mainContent.slice(0, 200)}`);
  }
  
  // 检查 TextContent
  const tcIdx = html.indexOf('id="TextContent"');
  console.log(`TextContent 位置: ${tcIdx >= 0 ? '找到' : '未找到'}`);
  
  // 统计 <p> 标签
  const pMatches = html.match(/<p\b[^>]*>/gi) || [];
  console.log(`<p> 标签数量: ${pMatches.length}`);
}

test().catch(console.error);