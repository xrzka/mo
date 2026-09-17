# Find where extra paragraphs come from
import re, sys
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding="utf-8")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"

def strip(s): return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', s)).strip()
def paras(html):
    idx=html.find('id="mlfy_main_text"')
    if idx<0: return []
    raw=html[idx:]
    pIdx=raw.find('class="mlfy_page"')
    if pIdx>0: raw=raw[:pIdx]
    return [strip(m.group(1)) for m in re.finditer(r'<p[^>]*>([\s\S]*?)</p>', raw)]

import urllib.request
req=urllib.request.Request("https://www.linovelib.com/novel/4649/332058.html",
    headers={"User-Agent":UA,"Accept":"text/html","Referer":"https://www.linovelib.com/"})
html_http=urllib.request.urlopen(req, timeout=30).read().decode("utf-8","ignore")
pa=paras(html_http)

with sync_playwright() as p:
    browser=p.chromium.launch(headless=False, args=["--start-minimized","--window-position=-32000,-32000","--window-size=1280,900"])
    ctx=browser.new_context(user_agent=UA, locale="zh-CN")
    page=ctx.new_page()
    page.goto("https://www.linovelib.com/novel/4649/332058.html", wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(10000)

    outer=page.evaluate("document.documentElement.outerHTML")
    po=paras(outer)
    print(f"Pure HTTP: {len(pa)} paras, Browser outerHTML: {len(po)} paras")

    http_set=set(pa)
    po_set=set(po)
    only_http=http_set-po_set
    only_browser=po_set-http_set
    print(f"\nOnly in HTTP: {len(only_http)} paras")
    print(f"Only in browser: {len(only_browser)} paras")
    print("\n=== Browser-only paras (first 10) ===")
    for t in list(only_browser)[:10]:
        print(f"  \"{t[:80]}\"")

    # Check HTML source for hidden content
    print("\n=== Possible hidden content in HTML ===")
    for kw in ["<!--", "<textarea", "<script", "json", "content"]:
        idx=html_http.find(kw)
        if idx>=0:
            seg=html_http[idx:idx+200].replace('\n',' ')
            if any(x in seg.lower() for x in ['p>','paragraph','chapter','content']):
                print(f"  [{kw}] ...{seg[:120]}...")

    # Check all possible containers
    extra=page.evaluate("""() => {
      const candidates = ['#o','#TextContent','#content','#article','.novel-content','.chapter-content','#chapter-content'];
      const found = [];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el) found.push({sel, text: (el.textContent||'').trim().slice(0,60), childP: el.querySelectorAll('p').length});
      }
      return found;
    }""")
    print("\n=== Content containers ===")
    for f in extra:
        print(f"  {f['sel']}: {f['childP']} <p>, \"{f['text']}\"")

    # Check all <p> attributes
    all_attrs=page.evaluate("""() => {
      const root=document.querySelector('#mlfy_main_text')||document.body;
      const ps=[...root.querySelectorAll('p')];
      const info=[];
      for (const p of ps) {
        const attrs=[];
        for(const a of p.attributes) attrs.push(a.name);
        info.push({attrs, txt:(p.textContent||'').trim().slice(0,20)});
      }
      return info;
    }""")
    print(f"\n=== <p> attributes (first 20) ===")
    for i,a in enumerate(all_attrs[:20]):
        print(f"  [{i}] attrs={a['attrs']} txt={a['txt']}")

    browser.close()