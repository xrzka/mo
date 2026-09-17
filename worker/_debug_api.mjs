// 直接调用 Worker API 看返回内容
async function main() {
  const chapters = ['4649/332058', '5360/334725'];
  
  for (const chap of chapters) {
    const [novelId, chapterId] = chap.split('/');
    const url = `https://mo-stats.werneruszcb71.workers.dev/api/watch/novel?action=chapter&novel=${novelId}&chapter=${chapterId}`;
    
    console.log(`\n=== ${chap} ===`);
    console.log(`URL: ${url}`);
    
    try {
      const res = await fetch(url);
      const body = await res.json();
      
      console.log(`HTTP ${res.status}, 段落数: ${body.blocks?.length || 0}`);
      if (body.blocks?.length > 0) {
        console.log(`首段: ${body.blocks[0].text?.slice(0, 50)}`);
        console.log(`末段: ${body.blocks[body.blocks.length-1].text?.slice(0, 50)}`);
      }
    } catch(e) {
      console.log(`API 失败: ${e.message}`);
    }
  }
}

main();