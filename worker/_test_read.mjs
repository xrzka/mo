// 测试正确的章节 API
async function main() {
  const target = 'https://mo-stats.werneruszcb71.workers.dev/api/watch/novel?action=chapter&novel=4649&chapter=332058';
  console.log('测试:', target);

  const res = await fetch(target);
  console.log('HTTP:', res.status);
  const body = await res.json();
  console.log('结果:', JSON.stringify(body).slice(0, 500));
}

main().catch(e => { console.error(e); process.exit(1); });