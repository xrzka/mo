// 验证两个章节的 KV 命中和段落顺序
async function test(chap) {
  const [novelId, chapterId] = chap.split('/');
  const url = `https://mo-stats.werneruszcb71.workers.dev/api/watch/novel?action=chapter&novel=${novelId}&chapter=${chapterId}`;
  const res = await fetch(url);
  const body = await res.json();
  console.log(`=== ${chap} ===`);
  console.log(`HTTP: ${res.status}, 段落数: ${body.blocks?.length || 0}`);
  if (body.blocks?.length > 0) {
    console.log(`首段: ${(body.blocks[0] || {}).text?.slice(0, 60) || body.blocks[0]?.slice(0, 60) || body.blocks[0]}`);
    const last = body.blocks[body.blocks.length - 1];
    console.log(`末段: ${(last || {}).text?.slice(0, 60) || last?.slice(0, 60) || last}`);
  }
}

(async () => {
  await test('4649/332058');
  await test('5360/334725');
})();