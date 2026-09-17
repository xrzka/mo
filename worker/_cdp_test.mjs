// 启动 Chrome 远程调试 + CDP 抓取 linovelib 章节
import { WebSocket } from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'node:child_process';

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

function stripTags(s) {
  return String(s||"").replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
}

// 启动 Chrome
const chromePath = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const chromeProc = spawn(chromePath, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-web-security',
  '--disable-blink-features=AutomationControlled',
  '--remote-debugging-port=9222',
  '--user-agent=' + UA,
  '--window-size=1280,900',
  'about:blank'
], { detached: true, windowsHide: true });
chromeProc.stdout.on('data', d => process.stdout.write('[chrome stdout] ' + d));
chromeProc.stderr.on('data', d => process.stderr.write('[chrome stderr] ' + d));
console.log('Chrome 已启动 (pid', chromeProc.pid, ')');

// 等待 Chrome 就绪
async function waitForChrome() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch('http://localhost:9222/json/version');
      if (res.ok) return await res.json();
    } catch {}
    await sleep(1000);
  }
  throw new Error('Chrome not ready');
}

async function newTab(url) {
  const res = await fetch('http://localhost:9222/json/new', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  });
  if (!res.ok) throw new Error(`new tab failed: ${res.status}`);
  return res.json();
}

// 更简洁的 CDP 方式
async function fetchViaCDP(url) {
  const tab = await newTab(url);
  console.log('Tab created:', tab.webSocketDebuggerUrl ? 'OK' : 'NO WS URL');
  
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    let id = 0;
    const responses = [];
    let lastResult = null;
    
    const send = (method, params = {}) => {
      id++;
      ws.send(JSON.stringify({id, method, params}));
      return id;
    };
    
    ws.on('open', () => {
      send('Runtime.enable');
      send('Page.enable');
      // 等待 CF 渲染
      setTimeout(() => {
        const evalId = send('Runtime.evaluate', {
          expression: `({html: document.documentElement.outerHTML, text: document.querySelector('#mlfy_main_text') ? document.querySelector('#mlfy_main_text').innerText : '', paras: Array.from(document.querySelectorAll('#mlfy_main_text p')).map(p => p.textContent.trim())})`,
          returnByValue: true
        });
      }, 8000);
    });
    
    ws.on('message', data => {
      const msg = JSON.parse(data.toString());
      responses.push(msg);
      if (msg.id && msg.result && msg.result.result) {
        lastResult = msg.result.result.value;
      }
      if (msg.id && msg.result && msg.result.result && msg.result.result.value && responses.length > 10) {
        // got the evaluate response
        resolve(lastResult);
        ws.close();
      }
    });
    
    ws.on('error', err => { reject(err); });
    setTimeout(() => { reject(new Error('timeout')); }, 25000);
  });
}

async function main() {
  await waitForChrome();
  console.log('Chrome ready');
  
  // 测试 4649/332058
  const url1 = 'https://www.linovelib.com/novel/4649/332058.html';
  const r1 = await fetchViaCDP(url1);
  console.log(r1.paras.length, '段, innerText', r1.text?.length, '字符');
  console.log('=== 4649/332058 前 15 段 ===');
  r1.paras.slice(0, 15).forEach((t, i) => console.log(`  [${i}] ${t.slice(0, 90)}`));
  
  // 测试 5360/334725
  const url2 = 'https://www.linovelib.com/novel/5360/334725.html';
  const r2 = await fetchViaCDP(url2);
  console.log(r2.paras.length, '段, innerText', r2.text?.length, '字符');
  console.log('=== 5360/334725 前 15 段 ===');
  r2.paras.slice(0, 15).forEach((t, i) => console.log(`  [${i}] ${t.slice(0, 90)}`));
  
  // 关闭 Chrome
  chromeProc.kill();
  process.exit(0);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });