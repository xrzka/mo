// 测试 Worker API
async function main() {
  const res = await fetch('https://mo-stats.werneruszcb71.workers.dev/api/watch/novel?action=chapter&novel=4649&chapter=332058');
  console.log('HTTP:', res.status);
  const text = await res.text();
  console.log('Body:', text.slice(0, 500));
}

main().catch(e => console.error(e));