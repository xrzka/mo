// 重新写入 5360/334725 到 KV（覆盖旧缓存）
import fs from 'fs';
const record = JSON.parse(fs.readFileSync('cache/5360_334725.json', 'utf8'));
const res = await fetch('https://mo-stats.werneruszcb71.workers.dev/api/admin/novel-cache', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key: record.key, blocks: record.blocks, pages: record.pages })
});
const result = await res.json();
console.log(`${res.status}:`, JSON.stringify(result));