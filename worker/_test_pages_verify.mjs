// 验证 pages.dev KV 命中
async function test() {
  const res = await fetch('https://mo-stats.pages.dev/api/watch/novel?action=chapter&novel=4649&chapter=332058');
  const d = await res.json();
  console.log(`HTTP: ${res.status}, paragraphs: ${d.blocks?.length}`);
  console.log(`first: ${(d.blocks[0] || {}).text || d.blocks[0]}`);
}
test().catch(console.error);