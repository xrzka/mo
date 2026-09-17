#!/usr/bin/env node
// 批量将本地缓存的章节写入 Worker KV。
const fs = require("fs");
const path = require("path");

const BASE = path.join(__dirname, "cache");
const BATCH = 20;
const BATCH_MS = 1200;
const workerUrl = process.env.WORKER_URL || "https://mo-stats.pages.dev";
const cachePrefix = "novel:";

async function main() {
  const files = fs.readdirSync(BASE)
    .filter((file) => file.endsWith(".json"))
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
      const key = cachePrefix + record.key;
      const res = await fetch(workerUrl + "/api/admin/novel-cache", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, blocks: record.paras || record.blocks }),
      });
      const result = await res.json();
      console.log(`${file}: HTTP ${res.status} ${JSON.stringify(result)}`);
      if (!res.ok) throw new Error(`写入失败: ${file}`);
      await new Promise((resolve) => setTimeout(resolve, BATCH_MS));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
