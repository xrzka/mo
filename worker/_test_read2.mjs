const res = await fetch('https://mo-stats.werneruszcb71.workers.dev/api/watch/novel?action=chapter&novel=5360&chapter=334725');
const body = await res.json();
console.log('HTTP:', res.status);
console.log('段落数:', body.blocks?.length || 0);
console.log('首段:', body.blocks?.[0]?.text?.slice(0, 60));
console.log('末段:', body.blocks?.[body.blocks?.length - 1]?.text?.slice(0, 60));