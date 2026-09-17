// 验证两个章节的 blocks 格式和顺序
async function test() {
  for (const chap of ['4649/332058', '5360/334725']) {
    const [n, c] = chap.split('/');
    const res = await fetch(`https://mo-stats.pages.dev/api/watch/novel?action=chapter&novel=${n}&chapter=${c}`);
    const d = await res.json();
    console.log(`=== ${chap}: ${d.blocks?.length} 段 ===`);
    if (d.blocks?.length > 0) {
      console.log(`首段: ${JSON.stringify(d.blocks[0]).slice(0, 80)}`);
      console.log(`末段: ${JSON.stringify(d.blocks[d.blocks.length-1]).slice(0, 80)}`);
    }
  }
}
test().catch(console.error);