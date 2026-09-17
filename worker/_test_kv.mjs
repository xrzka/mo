const res = await fetch('https://mo-stats.werneruszcb71.workers.dev/api/admin/novel-cache', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key: 'test', blocks: ['test'] })
});
console.log('HTTP:', res.status);
const body = await res.text();
console.log('Body:', body);