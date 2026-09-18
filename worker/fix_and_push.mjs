// Clear KV cache first (invalidation), then fetch fresh + push
console.log('Clearing KV cache for 5360/334725...');
const delRes = await fetch('https://mo-stats.werneruszcb71.workers.dev/api/admin/novel-cache?key=5360/334725', {
  method: 'DELETE',
});
console.log(`KV delete: ${await delRes.text()}`);

// Fetch complete chapter from Worker (force fresh by using cache-busted URL trick)
// then push full result back to KV
import fs from 'fs';

console.log('Fetching 5360/334725 from Worker...');
const r = await fetch('https://mo-stats.pages.dev/api/watch/novel?action=chapter&novel=5360&chapter=334725&_t=' + Date.now());
const d = await r.json();
console.log(`Worker returned: pages=${d.pages}, blocks=${d.blocks?.length}`);
console.log(`Image blocks: ${d.blocks?.filter(b => b.type === 'image').length}`);
console.log(`Text blocks: ${d.blocks?.filter(b => b.type === 'text').length}`);

// Push complete chapter back to KV
const res = await fetch('https://mo-stats.werneruszcb71.workers.dev/api/admin/novel-cache', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key: '5360/334725', blocks: d.blocks, pages: d.pages })
});
const result = await res.json();
console.log(`KV push: ${JSON.stringify(result)}`);