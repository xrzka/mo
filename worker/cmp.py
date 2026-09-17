# Compare pure HTTP #TextContent vs browser #mlfy_main_text
import re, sys, urllib.request
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding="utf-8")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"

def strip(s): return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', s)).strip()

def tc_paras(html):
    idx=html.find('id="TextContent"')
    if idx<0: return []
    raw=html[idx:]
    pIdx=raw.find('</div>')
    if pIdx>0: raw=raw[:pIdx]
    return [strip(m.group(1)) for m in re.finditer(r'<p[^>]*>([\s\S]*?)</p>', raw)]

def main_paras(html):
    idx=html.find('id="mlfy_main_text"')
    if idx<0: return []
    raw=html[idx:]
    pIdx=raw.find('</div>')
    if pIdx>0: raw=raw[:pIdx]
    return [strip(m.group(1)) for m in re.finditer(r'<p[^>]*>([\s\S]*?)</p>', raw)]

req=urllib.request.Request("https://www.linovelib.com/novel/4649/332058.html",
    headers={"User-Agent":UA,"Accept":"text/html","Referer":"https://www.linovelib.com/"})
html_http=urllib.request.urlopen(req, timeout=30).read().decode("utf-8","ignore")
pa=tc_paras(html_http)
print(f"Pure HTTP #TextContent: {len(pa)} paras")

with sync_playwright() as p:
    browser=p.chromium.launch(headless=False, args=["--start-minimized","--window-position=-32000,-32000","--window-size=1280,900"])
    ctx=browser.new_context(user_agent=UA, locale="zh-CN")
    page=ctx.new_page()
    page.goto("https://www.linovelib.com/novel/4649/332058.html", wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(10000)
    outer=page.evaluate("document.documentElement.outerHTML")
    po=main_paras(outer)
    print(f"Browser #mlfy_main_text: {len(po)} paras")
    browser.close()

print("\n=== First 30 paras comparison ===")
match=0
for i in range(min(30, len(pa), len(po))):
    a=pa[i][:25]
    b=po[i][:25]
    ok = a==b
    if ok: match+=1
    print(f"  [{i+1}] {'OK' if ok else 'DIFF'} HTTP=\"{a}\" | BR=\"{b}\"")

print(f"\nFirst 30 match: {match}/30")

print("\n=== Pure HTTP paras -> Browser position ===")
for i in range(0, len(pa), 15):
    t=pa[i][:20]
    pos=next((j for j,v in enumerate(po) if v[:20]==t), -1)
    print(f"  HTTP[{i}] -> BR[{pos+1}]" if pos>=0 else f"  HTTP[{i}] -> MISSING")