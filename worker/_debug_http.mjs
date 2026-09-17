// 测试：纯 HTTP vs Playwright 渲染的小说段落数量和内容
import fs from 'fs';
import { execSync } from 'child_process';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const BASE = 'https://www.linovelib.com';

function stripTags(s) {
  return s.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ').trim();
}

function countParagraphs(html) {
  // 检查 mlfy_main_text
  const mainMatch = html.match(/id=["']mlfy_main_text["'][^>]*>/i);
  const textMatch = html.match(/id=["']TextContent["'][^>]*>/i);
  
  const mainParaCount = (html.match(/<p\b[^>]*>/gi) || []).length;
  const textParaCount = (html.match(/<p\b[^>]*>/gi) || []).length;
  
  // 更精确地统计
  const mainContent = html.slice(html.indexOf('id="mlfy_main_text"'));
  const textContent = html.slice(html.indexOf('id="TextContent"'));
  
  const mainParas = (mainContent.match(/<p\b[^>]*>([\s\S]*?)<\/p>/gi) || []).length;
  const textParas = (textContent ? textContent.slice(0, textContent.indexOf('</div>')) : '').match(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)?.length || 0;
  
  return { mainParaCount, textParaCount, mainParas, textParas, mainContentLen: mainContent?.length || 0 };
}

(async () => {
  const chapters = ['4649/332058', '5360/334725'];
  
  for (const chap of chapters) {
    const url = `${BASE}/novel/${chap}.html`;
    console.log(`\n=== ${chap} ===`);
    
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html',
          'Referer': `${BASE}/`,
        }
      });
      const html = await res.text();
      const stats = countParagraphs(html);
      
      console.log(`HTTP ${res.status}: mlfy_main_text段落=${stats.mainParas}, TextContent段落=${stats.textParas}`);
      console.log(`页面总大小: ${html.length} bytes`);
      
      // 检查 mlfy_main_text 内容
      const mainIdx = html.indexOf('id="mlfy_main_text"');
      if (mainIdx >= 0) {
        const mainSlice = html.slice(mainIdx, mainIdx + 500);
        console.log(`mlfy_main_text 片段: ${mainSlice.slice(0, 200)}`);
      } else {
        console.log('mlfy_main_text NOT FOUND');
      }
      
    } catch(e) {
      console.log(`HTTP 失败: ${e.message}`);
    }
  }
})();