// 检查纯 HTTP 响应里 #TextContent 容器是否包含全部 143 段
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
function stripTags(s) { return String(s||"").replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim(); }

(async () => {
  const res = await fetch("https://www.linovelib.com/novel/4649/332058.html", {
    headers: { "Accept":"text/html","User-Agent":DESKTOP_UA,"Referer":"https://www.linovelib.com/" }
  });
  const html = await res.text();
  console.log("HTML 长度:", html.length);

  // 检查 #TextContent 容器
  const tcIdx = html.indexOf('id="TextContent"');
  console.log("#TextContent 位置:", tcIdx);
  if (tcIdx >= 0) {
    // 找到 TextContent 的闭合
    const openMatch = html.slice(tcIdx).match(/id="TextContent"[^>]*>/);
    if (openMatch) {
      const afterOpen = tcIdx + openMatch[0].length;
      // 找下一个同级闭合标签
      let depth = 0, i = afterOpen;
      while (i < html.length) {
        const closeDiv = html.indexOf('</div>', i);
        if (closeDiv < 0) break;
        const openDiv = html.indexOf('<div', i, closeDiv);
        if (openDiv < 0 || openDiv > closeDiv) {
          const tcHtml = html.slice(afterOpen, closeDiv);
          const paras = [...tcHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => stripTags(m[1])).filter(Boolean);
          console.log(`#TextContent 里 <p> 段数: ${paras.length}`);
          console.log("前 10 段:");
          paras.slice(0,10).forEach((t,i)=>console.log(`  [${i}] ${t.slice(0,80)}`));
          break;
        }
        depth++;
        i = closeDiv + 6;
      }
    }
  }

  // 同时检查 mlfy_main_text
  const mIdx = html.indexOf('id="mlfy_main_text"');
  console.log("\n#mlfy_main_text 位置:", mIdx);
  if (mIdx >= 0) {
    const mOpen = html.slice(mIdx).match(/id="mlfy_main_text"[^>]*>/);
    if (mOpen) {
      const after = mIdx + mOpen[0].length;
      const mClose = html.indexOf('</div>', after);
      const mHtml = html.slice(after, mClose);
      const mParas = [...mHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => stripTags(m[1])).filter(Boolean);
      console.log(`#mlfy_main_text 里 <p> 段数: ${mParas.length}`);
      console.log("前 5 段:");
      mParas.slice(0,5).forEach((t,i)=>console.log(`  [${i}] ${t.slice(0,80)}`));
    }
  }
})();