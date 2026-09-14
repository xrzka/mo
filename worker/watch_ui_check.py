"""观看区 UI 回归检查。

用法（Windows，需先装 playwright 并设好浏览器路径）：
    $env:PLAYWRIGHT_BROWSERS_PATH="D:\ms-playwright"
    python worker/watch_ui_check.py

它用真实上游数据（从线上 Worker 取回）在本地起一个静态服务，然后用 Chromium
在桌面 1280 与手机 390 两种宽度下检查观看区的布局不变量：

  - 列表/目录不内嵌滚动（否则 grid 行会被压缩，卡片被裁）
  - 卡片与目录行没有被压扁
  - 「加载更多」确实增加卡片且新卡片高度正常
  - 没有横向溢出
  - 锚点跳转后标题不被粘性导航遮住

这几条都是实际踩过的坑，改 CSS 后跑一遍能立刻发现回退。
"""
import functools
import http.server
import json
import socketserver
import threading
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(r"D:\local_translate_tool\mo_site")
LIVE = "https://mo-stats.pages.dev"
FAILS = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  ' + detail if detail else ''}")
    if not ok:
        FAILS.append(name)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


handler = functools.partial(Quiet, directory=str(ROOT))
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 8803), handler)
httpd.daemon_threads = True
threading.Thread(target=httpd.serve_forever, daemon=True).start()


def live_get(path, timeout=90):
    req = urllib.request.Request(LIVE + path, headers={"User-Agent": "chk/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


FIX = {
    "music": live_get("/api/watch/music?action=getNewestSongsV2"),
    "manga": live_get("/api/watch/manga?action=list&source=manga3r"),
    "manga_detail": live_get("/api/watch/manga?action=detail&comic=1232&source=manga3r"),
    "novel": live_get("/api/watch/novel?action=list"),
    "novel_detail": live_get("/api/watch/novel?action=detail&novel=5291"),
}


def routes(page):
    def h(route):
        url = route.request.url
        if "/api/watch/asset" in url:
            route.continue_()
            return
        if "/api/watch/music" in url:
            body = FIX["music"]
        elif "/api/watch/manga" in url:
            body = FIX["manga_detail"] if "action=detail" in url else FIX["manga"]
        elif "/api/watch/novel" in url:
            body = FIX["novel_detail"] if "action=detail" in url else FIX["novel"]
        elif "/api/" in url:
            body = "{}"
        else:
            route.continue_()
            return
        route.fulfill(status=200, content_type="application/json", body=body)
    page.route("**/*", h)


CARDS = """
() => {
  const list = document.querySelector('[data-watch-list]');
  const cs = getComputedStyle(list);
  const cards = [...document.querySelectorAll('.watch-card')];
  const media = cards.filter((c) => c.querySelector('.watch-card-media'));
  const squashed = media.filter((c) => {
    const m = c.querySelector('.watch-card-media');
    return m.getBoundingClientRect().height > c.getBoundingClientRect().height + 2;
  });
  const first = cards[0];
  return {
    count: cards.length,
    overflowY: cs.overflowY,
    maxHeight: cs.maxHeight,
    cardHeight: first ? Math.round(first.getBoundingClientRect().height) : 0,
    squashed: squashed.length,
    moreVisible: !!document.querySelector('[data-watch-more]') && !document.querySelector('[data-watch-more]').hidden,
    pageInfo: (document.querySelector('[data-watch-page-info]') || {}).textContent || '',
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  };
}
"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    for label, w, h in (("desktop", 1280, 900), ("mobile", 390, 844)):
        page = browser.new_page(viewport={"width": w, "height": h})
        routes(page)
        page.goto("http://127.0.0.1:8803/", wait_until="load")
        page.wait_for_timeout(1500)
        page.locator("[data-tabs] button", has_text="观看").first.click()
        page.wait_for_timeout(2500)

        page.locator("[data-watch-tabs] button", has_text="漫画").first.click()
        page.wait_for_timeout(3500)
        c = page.evaluate(CARDS)
        print(f"\n[{label} 漫画] {json.dumps(c, ensure_ascii=False)}")
        check(f"{label} 列表不内嵌滚动", c["overflowY"] == "visible" and c["maxHeight"] == "none")
        check(f"{label} 卡片未被压扁", c["squashed"] == 0, f"squashed={c['squashed']}")
        check(f"{label} 卡片高度正常", c["cardHeight"] > 250, f"h={c['cardHeight']}")
        check(f"{label} 无横向溢出", not c["overflowX"])

        if c["moreVisible"]:
            page.locator("[data-watch-more-btn]").click()
            page.wait_for_timeout(1500)
            c2 = page.evaluate(CARDS)
            check(f"{label} 翻页后增加", c2["count"] > c["count"], f"{c['count']}→{c2['count']}")
            check(f"{label} 翻页后未压扁", c2["squashed"] == 0)

        # 小说目录
        page.goto("http://127.0.0.1:8803/", wait_until="load")
        page.wait_for_timeout(1500)
        page.locator("[data-tabs] button", has_text="观看").first.click()
        page.wait_for_timeout(2000)
        page.locator("[data-watch-tabs] button", has_text="小说").first.click()
        page.wait_for_timeout(3000)
        page.locator(".watch-card").first.click()
        page.wait_for_timeout(4500)
        rows = page.evaluate("""() => {
          const list = document.querySelector('.watch-chapter-list');
          if (!list) return { exists: false };
          const cs = getComputedStyle(list);
          const items = [...list.querySelectorAll('.watch-chapter-open')];
          const hs = items.slice(0, 10).map((b) => Math.round(b.getBoundingClientRect().height));
          return { exists: true, rows: items.length, minH: hs.length ? Math.min(...hs) : 0,
                   overflowY: cs.overflowY, maxHeight: cs.maxHeight };
        }""")
        print(f"[{label} 小说目录] {json.dumps(rows, ensure_ascii=False)}")
        check(f"{label} 目录渲染", rows.get("exists") and rows.get("rows", 0) > 0, f"rows={rows.get('rows')}")
        check(f"{label} 目录不内嵌滚动", rows.get("overflowY") == "visible" and rows.get("maxHeight") == "none")
        check(f"{label} 目录行未压扁", rows.get("minH", 0) >= 34, f"min={rows.get('minH')}")

        # 粘性导航偏移
        page.goto("http://127.0.0.1:8803/", wait_until="load")
        page.wait_for_timeout(1500)
        page.locator("[data-tabs] button", has_text="观看").first.click()
        page.wait_for_timeout(2000)
        page.evaluate("""() => {
          const s = document.querySelector('[data-watch-panel]');
          if (s) s.scrollIntoView({ block: 'start' });
        }""")
        page.wait_for_timeout(1000)
        nav = page.evaluate("""() => {
          const h = document.querySelector('.site-header').getBoundingClientRect();
          const t = document.querySelector('#watch-title').getBoundingClientRect();
          return { headerBottom: Math.round(h.bottom), titleTop: Math.round(t.top),
                   covered: t.top < h.bottom };
        }""")
        print(f"[{label} 锚点] {json.dumps(nav, ensure_ascii=False)}")
        check(f"{label} 标题不被导航遮挡", not nav["covered"],
              f"nav底={nav['headerBottom']} 标题顶={nav['titleTop']}")
        page.close()
    browser.close()

print(f"\n==== 失败 {len(FAILS)} ====")
for f in FAILS:
    print("  FAIL:", f)
