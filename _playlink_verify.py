"""端到端验证：浏览器直连 lmm85 play 页 → 解析 player_aaaa → m3u8 可播。
确认"iframe 嵌入原站播放"方案端到端可行。"""
from playwright.sync_api import sync_playwright
import re, time

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport={"width": 1280, "height": 800}, locale="zh-CN",
    )
    page = ctx.new_page()

    # 1) 详情页拿选集列表
    page.goto("https://www.lmm85.com/detail/8164.html", timeout=30000, wait_until="domcontentloaded")
    page.wait_for_timeout(4000)
    html = page.content()
    eps = re.findall(r'https?://www\.lmm85\.com/play/[\w]+\.html|/play/[\w]+\.html', html)
    if not eps:
        eps = re.findall(r'href="(/play/[^"]+)"', html)
    print(f"详情选集链接数 = {len(eps)}")
    if not eps:
        print("  无选集，试首页第一个")
    first_ep = eps[0] if eps else None
    if first_ep and not first_ep.startswith("http"):
        first_ep = "https://www.lmm85.com" + first_ep
    print("第一集:", first_ep)

    # 2) 打开 play 页看真实播放器区
    if first_ep:
        page.goto(first_ep, timeout=30000, wait_until="domcontentloaded")
        page.wait_for_timeout(5000)
        ph = page.content()
        print(f"play页 len={len(ph)}")
        print("  有 iframe 播放器:", "iframe" in ph)
        print("  有 player_aaaa:", "player_aaaa" in ph)
        # 抓 iframe src
        im = re.findall(r'<iframe[^>]+src="([^"]+)"', ph)
        print("  iframe src:", im[:3])
        # 抓 player_aaaa json
        pm = re.search(r'var\s+player_aaaa\s*=\s*(\{[\s\S]*?\})\s*;', ph)
        if pm:
            print("  player_aaaa 前200:", pm.group(1)[:200])
    browser.close()
