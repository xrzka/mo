// 验证 KV 命中
async function main() {
  const url = 'https://mo-stats.werneruszcb71.workers.dev/api/watch/novel?action=chapter&novel=4649&chapter=332058';
  const res = await fetch(url);
  const body = await res.json();
  console.log(`HTTP ${res.status}, 段落数: ${body.blocks?.length || 0}`);
  console.log(`首段: ${body.blocks?.[0]?.text?.slice(0, 50)}`);
  console.log(`末段: ${body.blocks?.[body.blocks?.length-1]?.text?.slice(0, 50)}`);
}

main();