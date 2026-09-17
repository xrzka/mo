// 多请求取并集方案：服务端随机截断，请求多次合并所有段落
// 验证能否凑出完整 143 段且顺序正确
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
function stripTags(s) { return String(s||"").replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim(); }
function tcParas(html) {
  const m = html.match(/id=["']TextContent["'][^>]*>([\s\S]*?)<\/(?:div|article)>/i);
  if (!m) return [];
  return [...m[1].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(x=>stripTags(x[1])).filter(Boolean);
}

(async () => {
  const allParas = new Map(); // text -> first occurrence index
  let maxLen = 0;
  let bestHtml = "";

  for (let i = 0; i < 8; i++) {
    try {
      const res = await fetch("https://www.linovelib.com/novel/4649/332058.html", {
        headers: {
          "Accept":"text/html","User-Agent":DESKTOP_UA,
          "Accept-Language":"zh-CN,zh;q=0.9",
          "Sec-Ch-Ua":'"Not/A)Brand";v="99", "Chromium";v="148"',
          "Sec-Ch-Ua-Mobile":"?0","Sec-Ch-Ua-Platform":"\"Windows\"",
          "Referer":"https://www.linovelib.com/",
          "Cache-Control":"no-cache",
        }
      });
      const html = await res.text();
      const paras = tcParas(html);
      console.log(`请求${i+1}: ${paras.length} 段`);
      if (paras.length > maxLen) { maxLen = paras.length; bestHtml = html; }
      paras.forEach((p, idx) => {
        if (!allParas.has(p)) allParas.set(p, idx);
      });
    } catch(e) {
      console.log(`请求${i+1}: ERR ${e.message}`);
    }
    await new Promise(r=>setTimeout(r, 800));
  }

  console.log(`\n合并后唯一段落数: ${allParas.size}`);
  console.log(`最大单次段落数: ${maxLen}`);
  console.log("\n=== 合并后前 20 段 ===");
  let count = 0;
  for (const [text, idx] of allParas) {
    if (count >= 20) break;
    console.log(`  [${count}] ${text.slice(0, 70)}`);
    count++;
  }
})();