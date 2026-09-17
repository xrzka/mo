"""实测：真实浏览器（Playwright Chromium）能否直连 lmm85 列表页/详情页。
这决定前端能否用浏览器直连绕开被 403 的 Worker。"""
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport={"width": 1280, "height": 800},
        locale="zh-CN",
    )
    page = ctx.new_page()

    print("=== 直连 lmm85 列表页 ===")
    try:
        resp = page.goto("https://www.lmm85.com/type/dongman.html", timeout=30000, wait_until="domcontentloaded")
        print(f"status = {resp.status if resp else 'None'}")
        page.wait_for_timeout(6000)
        html = page.content()
        print(f"len = {len(html)}")
        if "Just a moment" in html:
            print(">> 被 CF challenge 拦截")
        elif "/detail/" in html:
            print(">> 直连成功，拿到列表（未走 Worker）!")
        else:
            print(">> 其它", html[:80].replace("\n", " "))
    except Exception as exc:
        print(">> 异常:", str(exc)[:120])

    print("\n=== 直连 lmm85 详情页（试真实 id）===")
    try:
        resp = page.goto("https://www.lmm85.com/detail/8164.html", timeout=30000, wait_until="domcontentloaded")
        page.wait_for_timeout(5000)
        html = page.content()
        print(f"status={resp.status if resp else 'None'} len={len(html)}")
        print("有选集:" , "/play/" in html, " 有player_aaaa:", "player_aaaa" in html)
    except Exception as exc:
        print(">> 异常:", str(exc)[:120])

    browser.close()
