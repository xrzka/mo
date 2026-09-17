// 测试实际部署的 Worker 和 GitHub Pages
async function test() {
  // 测试 mo-stats.werneruszcb71.workers.dev
  const r1 = await fetch('https://mo-stats.werneruszcb71.workers.dev/api/watch/novel?action=chapter&novel=4649&chapter=332058');
  const d1 = await r1.json();
  console.log('=== workers.dev ===');
  console.log(`HTTP: ${r1.status}, paragraphs: ${d1.blocks?.length}`);
  if (d1.blocks?.length) {
    console.log(`first: ${(d1.blocks[0] || {}).text || d1.blocks[0]}`);
  }

  // 测试 mo-stats.pages.dev
  const r2 = await fetch('https://mo-stats.pages.dev/api/watch/novel?action=chapter&novel=4649&chapter=332058');
  const d2 = await r2.json();
  console.log('\n=== pages.dev ===');
  console.log(`HTTP: ${r2.status}, paragraphs: ${d2.blocks?.length}`);
  if (d2.blocks?.length) {
    console.log(`first: ${(d2.blocks[0] || {}).text || d2.blocks[0]}`);
  }
}

test().catch(console.error);