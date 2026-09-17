// 深入测试 pages.dev
async function test() {
  console.log('=== pages.dev 详细测试 ===\n');
  
  // 直接测试 chapter API
  const r = await fetch('https://mo-stats.pages.dev/api/watch/novel?action=chapter&novel=4649&chapter=332058');
  const d = await r.json();
  console.log(`HTTP: ${r.status}`);
  console.log(`段落数: ${d.blocks?.length}`);
  console.log(`首段: ${(d.blocks[0] || {}).text || d.blocks[0] || 'N/A'}`);
  
  // 测试 watchNovel 函数是否有 KV 支持
  console.log('\n=== 测试 admin 接口 ===');
  const r2 = await fetch('https://mo-stats.pages.dev/api/admin/novel-cache', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: '__test__', blocks: ['test'] })
  });
  const t2 = await r2.text();
  console.log(`Admin POST: ${r2.status} - ${t2.slice(0, 200)}`);
}

test().catch(console.error);