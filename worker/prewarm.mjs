// 批量推送本地缓存章节到 Worker KV
import fs from 'fs';
import path from 'path';

const BASE = path.join(process.cwd(), "cache");
const BATCH = 10;
const BATCH_MS = 800;

async function main() {
  const files = fs.readdirSync(BASE)
    .filter(f => f.endsWith(".json"))
    .sort();

  if (!files.length) {
    console.error(`目录 ${BASE} 为空`);
    process.exit(1);
  }

  for (let start = 0; start < files.length; start += BATCH) {
    const batch = files.slice(start, start + BATCH);
    console.log(`批次 ${start + 1}/${files.length}`);
    for (const file of batch) {
      const record = JSON.parse(fs.readFileSync(path.join(BASE, file), "utf8"));
      const key = record.key;
      const res = await fetch("https://mo-stats.werneruszcb71.workers.dev/api/admin/novel-cache", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, blocks: record.paras || record.blocks }),
      });
      const result = await res.json();
      console.log(`${file}: HTTP ${res.status} ${JSON.stringify(result)}`);
      if (!res.ok) throw new Error(`写入失败: ${file}`);
      await new Promise(r => setTimeout(r, BATCH_MS));
    }
  }
  console.log("所有章节已写入 KV 缓存");
}

main().catch(e => { console.error(e); process.exit(1); });