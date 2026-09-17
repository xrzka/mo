// 检查并清理错误的 KV key，然后重新写入正确的 key
import fs from 'fs';

async function main() {
  // 先获取现有的所有 key
  const res = await fetch('https://mo-stats.werneruszcb71.workers.dev/api/admin/novel-cache', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: '__list__', blocks: [] })
  });
  // 这个接口不支持 list，所以直接重新写入正确的 key
  
  const BASE = process.cwd() + '/cache';
  const files = fs.readdirSync(BASE).filter(f => f.endsWith('.json')).sort();
  
  for (const file of files) {
    const record = JSON.parse(fs.readFileSync(BASE + '/' + file, 'utf8'));
    const key = record.key;  // 去掉 "novel:" 前缀
    console.log(`写入 ${key}...`);
    const r = await fetch('https://mo-stats.werneruszcb71.workers.dev/api/admin/novel-cache', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, blocks: record.paras || record.blocks })
    });
    const result = await r.json();
    console.log(`  HTTP ${r.status} ${JSON.stringify(result)}`);
  }
  
  // 清理旧的 key（带 novel: 前缀的）
  console.log('\n清理旧 key...');
  const oldFiles = ['4649_332058', '5360_334725'];
  for (const oldKey of oldFiles) {
    const r = await fetch('https://mo-stats.werneruszcb71.workers.dev/api/admin/novel-cache/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'novel:' + oldKey })
    });
    console.log(`删除 ${oldKey}: HTTP ${r.status}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });