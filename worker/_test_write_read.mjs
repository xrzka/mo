// 直接写入 KV 并读取
console.log('写入...');
const wp = await fetch('https://mo-stats.werneruszcb71.workers.dev/api/admin/novel-cache', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key: '4649/332058', blocks: ['测试段落1', '测试段落2', '测试段落3'] })
});
console.log('写入结果:', await wp.text());

console.log('\n读取...');
const r = await fetch('https://mo-stats.werneruszcb71.workers.dev/api/watch/novel?action=chapter&novel=4649&chapter=332058');
const body = await r.json();
console.log('段落数:', body.blocks?.length);
console.log('首段:', body.blocks?.[0]?.text || body.blocks?.[0]);
