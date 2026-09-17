// 全面验证
async function test() {
  // 1. 两个章节
  for (const chap of ['4649/332058', '5360/334725']) {
    const [n, c] = chap.split('/');
    const res = await fetch(`https://mo-stats.pages.dev/api/watch/novel?action=chapter&novel=${n}&chapter=${c}`);
    const d = await res.json();
    console.log(`章节 ${chap}: HTTP ${res.status}, ${d.blocks?.length} 段`);
    console.log(`  首段: ${(d.blocks[0] || {}).text || d.blocks[0]}`);
  }

  // 2. 热门排行
  console.log('\n=== 热门排行 ===');
  const ranking = await fetch('https://mo-stats.pages.dev/api/stats/ranking');
  const rData = await ranking.json();
  console.log(`HTTP ${ranking.status}: ${JSON.stringify(rData).slice(0, 300)}`);

  // 3. 小说详情
  console.log('\n=== 小说详情 (novelId=4649) ===');
  const detail = await fetch('https://mo-stats.pages.dev/api/watch/novel?action=detail&novel=4649');
  const dData = await detail.json();
  console.log(`HTTP ${detail.status}: ${JSON.stringify(dData).slice(0, 300)}`);
}

test().catch(console.error);