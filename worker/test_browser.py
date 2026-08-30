#!/usr/bin/env python3
"""真浏览器端到端测试：点击计数、排行榜、排序、跨天/跨周分桶、隐私模式降级。

本机模式（不配 statsApi）用真实 localStorage 验证；
全站模式用一个本地 HTTP 桩服务假装 Worker，验证前端的上报与拉取。

跑法（在 mo_site/worker 下）：
    python test_browser.py
"""
import http.server
import json
import socketserver
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

SITE = Path(__file__).resolve().parent.parent
FAIL = []

# 卡片里的链接是 target=_blank 指向真实站点，测试环境不该真去连它们。
# 用只匹配外部 URL 的谓词，而不是 "**/*" catch-all —— catch-all 会盖掉
# 后注册的 config.js 桩路由（Playwright 后注册优先），导致全站模式测试
# 静默退回本机模式，测出来的是假通过。
def is_external(url):
    return not url.startswith("http://127.0.0.1")


def block_external(page):
    page.route(is_external, lambda route: route.abort())


def check(name, ok, extra=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  {extra}" if extra else ""))
    if not ok:
        FAIL.append(name)


class SiteHandler(http.server.SimpleHTTPRequestHandler):
    """静态站点服务。GitHub Pages 也是纯静态，行为一致。"""

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(SITE), **kw)

    def log_message(self, *a):
        pass


class StatsStub(http.server.BaseHTTPRequestHandler):
    """Worker 桩：只实现 /api/stats、/api/hit、/api/visit 三个接口。"""

    hits = {}
    visits = 0
    # 需要各周期人数不同时设成 {"day":3,...}，默认所有周期都回 visits
    per_period = None

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        periods = ["day", "week", "month", "year", "all"]
        visitors = (
            dict(StatsStub.per_period)
            if StatsStub.per_period
            else {p: StatsStub.visits for p in periods}
        )
        body = json.dumps(
            {
                "clicks": {p: dict(StatsStub.hits) for p in periods},
                "visitors": visitors,
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        if self.path == "/api/hit":
            item = (json.loads(raw or b"{}") or {}).get("id")
            if item:
                StatsStub.hits[item] = StatsStub.hits.get(item, 0) + 1
        elif self.path == "/api/visit":
            StatsStub.visits += 1
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def serve(handler):
    class S(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    srv = S(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]
def stub_config(page, api=""):
    """改写 config.js。

    必须显式桩掉：仓库里的 config.js 现在填的是真实地址，本机模式测试若不桩，
    结果会取决于当时能不能连上网 —— 连不上才「碰巧」通过，那是假通过。

    api 可以是字符串或列表，对应 config.js 支持的两种写法。
    """
    body = json.dumps(api if isinstance(api, list) else api)
    page.route(
        "**/config.js*",
        lambda route: route.fulfill(
            status=200,
            content_type="application/javascript",
            body=f"window.MO_CONFIG = {{ statsApi: {body} }};",
        ),
    )


def open_stats(page):
    """展开排行榜面板。默认收起，不展开拿不到里面的节点。"""
    if page.get_attribute("[data-stats-toggle]", "aria-expanded") != "true":
        page.click("[data-stats-toggle]")


def first_card_link(page):
    """展开第一张卡片并返回它的资源 id 与访问链接。"""
    page.click(".feed-card >> nth=0")
    card = page.locator(".feed-card").nth(0)
    return card.get_attribute("data-item-id"), card.locator("a.visit-link").nth(0)


def rank_rows(page):
    return page.eval_on_selector_all(
        "[data-stats-rank] .rank-row",
        "els => els.map(e => ({name: e.querySelector('.rank-name').textContent,"
        " n: parseInt(e.querySelector('.rank-count').textContent)}))",
    )


def test_local_mode(page, base):
    print("\n--- 本机模式 ---")
    stub_config(page, "")
    page.goto(base, wait_until="networkidle")

    open_stats(page)
    scope = page.text_content("[data-stats-scope]")
    check("提示写明是本机统计", "本机统计" in scope, scope.strip())
    check("空榜显示占位文案", page.is_visible("[data-stats-empty]"))
    vis = page.text_content("[data-stats-visitors]")
    check("访问人数说明需要后端", "后端" in vis, vis.strip())

    item_id, link = first_card_link(page)
    block_external(page)
    link.click()
    page.wait_for_timeout(300)

    stored = page.evaluate("() => JSON.parse(localStorage.getItem('mo-hits-v1') || '{}')")
    day_bucket = list(stored.get("day", {}).values())
    check("点击写入 localStorage", bool(day_bucket) and day_bucket[0].get(item_id) == 1, json.dumps(day_bucket)[:120])
    check("五个周期都记了", sorted(stored.keys()) == ["all", "day", "month", "week", "year"], ",".join(sorted(stored.keys())))

    check("卡片出现点击角标", page.is_visible(f'.feed-card[data-item-id="{item_id}"] .hits-pill'))
    rows = rank_rows(page)
    check("排行榜出现该条目", len(rows) == 1 and rows[0]["n"] == 1, json.dumps(rows, ensure_ascii=False)[:120])

    # 再点两次，计数应累加到 3
    link.click()
    link.click()
    page.wait_for_timeout(300)
    rows = rank_rows(page)
    check("重复点击累加到 3", rows and rows[0]["n"] == 3, json.dumps(rows, ensure_ascii=False)[:120])

    # 刷新后仍在（localStorage 持久化）
    page.reload(wait_until="networkidle")
    open_stats(page)
    rows = rank_rows(page)
    check("刷新后计数保留", rows and rows[0]["n"] == 3, json.dumps(rows, ensure_ascii=False)[:120])
    return item_id


def test_sort(page, base, item_id):
    print("\n--- 点击数排序 ---")
    stub_config(page, "")
    page.goto(base, wait_until="networkidle")
    page.select_option('[data-filter="sort"]', "hits-all")
    page.wait_for_timeout(200)
    first = page.get_attribute(".feed-card >> nth=0", "data-item-id")
    check("按累计点击排序后热门条目排第一", first == item_id, f"{first} vs {item_id}")

    page.select_option('[data-filter="sort"]', "hits-day")
    page.wait_for_timeout(200)
    pill = page.text_content(f'.feed-card[data-item-id="{item_id}"] .hits-pill')
    check("角标跟随周期切换", "今日" in pill, pill.strip())

    page.select_option('[data-filter="sort"]', "default")
    page.wait_for_timeout(200)
    check("切回默认排序不报错", page.locator(".feed-card").count() > 0)


def test_bucket_rollover(page, base, item_id):
    print("\n--- 跨天 / 跨周分桶 ---")
    stub_config(page, "")
    page.goto(base, wait_until="networkidle")
    # 直接改 localStorage 模拟历史数据：昨天 5 次，今天 0 次
    page.evaluate(
        """([id]) => {
            const pad = n => String(n).padStart(2,'0');
            const d = new Date(Date.now() - 86400000);
            const yday = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
            const now = new Date();
            const month = `${now.getFullYear()}-${pad(now.getMonth()+1)}`;
            localStorage.setItem('mo-hits-v1', JSON.stringify({
                day:   { [yday]: { [id]: 5 } },
                month: { [month]: { [id]: 5 } },
                all:   { all: { [id]: 5 } },
            }));
        }""",
        [item_id],
    )
    page.reload(wait_until="networkidle")
    open_stats(page)
    check("今日榜不含昨天的点击", page.is_visible("[data-stats-empty]"))

    page.click('[data-stats-tabs] button:has-text("本月")')
    page.wait_for_timeout(200)
    rows = rank_rows(page)
    check("本月榜含昨天的 5 次", rows and rows[0]["n"] == 5, json.dumps(rows, ensure_ascii=False)[:120])

    page.click('[data-stats-tabs] button:has-text("累计")')
    page.wait_for_timeout(200)
    rows = rank_rows(page)
    check("累计榜含 5 次", rows and rows[0]["n"] == 5, json.dumps(rows, ensure_ascii=False)[:120])
def test_jump(page, base, item_id):
    print("\n--- 排行榜定位 ---")
    stub_config(page, "")
    page.goto(base, wait_until="networkidle")
    page.evaluate(
        """([id]) => {
            const pad = n => String(n).padStart(2,'0');
            const d = new Date();
            const day = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
            localStorage.setItem('mo-hits-v1', JSON.stringify({ day: { [day]: { [id]: 9 } } }));
        }""",
        [item_id],
    )
    page.reload(wait_until="networkidle")
    open_stats(page)
    page.click("[data-stats-rank] .rank-name >> nth=0")
    page.wait_for_timeout(600)
    card = page.locator(f'.feed-card[data-item-id="{item_id}"]')
    check("跳转后卡片存在于当前页", card.count() == 1)
    check("跳转后卡片自动展开", card.get_attribute("aria-expanded") == "true")


def test_adult_filter(page, base):
    print("\n--- 未成年模式不漏成人向条目 ---")
    stub_config(page, "")
    page.goto(base, wait_until="networkidle")
    adult_id = page.evaluate(
        """async () => {
            const r = await fetch('data/items.json');
            const d = await r.json();
            const items = Array.isArray(d) ? d : d.items;
            const a = items.find(x => x.adult === true);
            return a ? a.id : null;
        }"""
    )
    if not adult_id:
        check("数据里有成人向条目可测", False, "items.json 里没有 adult:true")
        return
    page.evaluate(
        """([id]) => {
            const pad = n => String(n).padStart(2,'0');
            const d = new Date();
            const day = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
            localStorage.setItem('mo-hits-v1', JSON.stringify({ day: { [day]: { [id]: 99 } } }));
        }""",
        [adult_id],
    )
    page.reload(wait_until="networkidle")
    open_stats(page)
    check("未成年模式下排行榜不显示成人向条目", page.is_visible("[data-stats-empty]"))

    page.click("[data-mode-toggle]")
    page.click("[data-age-confirm]")
    page.wait_for_timeout(300)
    rows = rank_rows(page)
    check("成年模式下才出现", rows and rows[0]["n"] == 99, json.dumps(rows, ensure_ascii=False)[:120])


def test_site_mode(page, base, stub_port):
    print("\n--- 全站模式（Worker 桩） ---")
    StatsStub.hits.clear()
    StatsStub.visits = 0
    # 用路由改写 config.js，指向本地桩，避免依赖真实 Worker
    stub_config(page, f"http://127.0.0.1:{stub_port}")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(500)

    open_stats(page)
    scope = page.text_content("[data-stats-scope]")
    check("提示切到全站统计", "全站统计" in scope, scope.strip())
    check("访问已上报", StatsStub.visits >= 1, f"visits={StatsStub.visits}")
    vis = page.text_content("[data-stats-visitors]")
    check("显示访问人数", "访问人数" in vis and "后端" not in vis, vis.strip()[:80])

    item_id, link = first_card_link(page)
    block_external(page)
    link.click()
    page.wait_for_timeout(600)
    check("点击上报到后端", StatsStub.hits.get(item_id) == 1, json.dumps(StatsStub.hits)[:120])
    check("全站模式不写本机 localStorage",
          page.evaluate("() => localStorage.getItem('mo-hits-v1')") is None)

    # 重新加载：计数应来自后端
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(500)
    open_stats(page)
    rows = rank_rows(page)
    check("重载后从后端读到计数", rows and rows[0]["n"] == 1, json.dumps(rows, ensure_ascii=False)[:120])
    check("同一天不重复计访问人数", StatsStub.visits == 1, f"visits={StatsStub.visits}")


def test_failover(page, base, stub_port):
    """多地址回退：第一个地址不通时，应自动切到第二个而不是退回本机模式。

    这是线上真实配置的形状 —— workers.dev 被墙，pages.dev 兜底。
    """
    print("\n--- 多地址回退 ---")
    StatsStub.hits.clear()
    StatsStub.visits = 0
    stub_config(page, ["http://127.0.0.1:1", f"http://127.0.0.1:{stub_port}"])
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1200)

    open_stats(page)
    scope = page.text_content("[data-stats-scope]")
    check("第一个地址不通时切到第二个", "全站统计" in scope, scope.strip())
    check("访问上报走的是通的那个地址", StatsStub.visits >= 1, f"visits={StatsStub.visits}")

    item_id, link = first_card_link(page)
    block_external(page)
    link.click()
    page.wait_for_timeout(600)
    check("点击上报也走通的地址", StatsStub.hits.get(item_id) == 1, json.dumps(StatsStub.hits)[:120])


def test_retry_round(page, base, stub_port):
    """首轮拉取全失败、第二轮才通时，应最终切到全站模式。

    模拟国内直连 pages.dev 的 TLS 握手偶发超时：前 N 个 /api/stats 请求
    直接掐断，之后放行。app.js 的 pull() 会整轮候选跑完再重试一轮。
    """
    print("\n--- 首轮失败后重试 ---")
    StatsStub.hits.clear()
    StatsStub.visits = 0
    stub_config(page, f"http://127.0.0.1:{stub_port}")

    state = {"aborted": 0}

    def flaky(route):
        if "/api/stats" in route.request.url and state["aborted"] < 1:
            state["aborted"] += 1
            route.abort()
        else:
            route.continue_()

    page.route("**/api/stats", flaky)
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(3000)

    open_stats(page)
    scope = page.text_content("[data-stats-scope]")
    check("首轮失败后重试成功", "全站统计" in scope, scope.strip())
    check("确实掐断过一次请求", state["aborted"] == 1, str(state["aborted"]))


def test_degraded_click_reported(page, base, stub_port):
    """降级到本机模式后，点击仍应补报到后端，不丢数。"""
    print("\n--- 降级后点击补报 ---")
    StatsStub.hits.clear()
    StatsStub.visits = 0
    stub_config(page, f"http://127.0.0.1:{stub_port}")

    # 只掐 /api/stats，让首屏拉取彻底失败进入本机模式；/api/hit 放行
    page.route("**/api/stats", lambda r: r.abort())
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(3500)

    open_stats(page)
    scope = page.text_content("[data-stats-scope]")
    check("确实处于本机模式", "本机统计" in scope, scope.strip())

    item_id, link = first_card_link(page)
    block_external(page)
    link.click()
    page.wait_for_timeout(1200)
    check("降级状态下点击仍上报到后端", StatsStub.hits.get(item_id) == 1,
          json.dumps(StatsStub.hits)[:120])
    check("同时也记了本机一份",
          page.evaluate("() => localStorage.getItem('mo-hits-v1') !== null"))


def stats_tabs(page):
    """返回排行榜周期标签的 (文字, 是否选中) 列表。"""
    return page.eval_on_selector_all(
        "[data-stats-tabs] .stats-tab",
        "els => els.map(e => [e.textContent, e.getAttribute('aria-selected') === 'true'])",
    )


def test_period_tabs(page, base):
    """周期标签切换：高亮要跟着走，榜单数据要跟着换。

    这里盯的是一个真实出过的 bug：点标签只调了 renderStats() 没重画标签栏，
    数据其实换了但高亮还留在「今日」上，看起来像点了没反应。
    """
    print("\n--- 周期标签切换 ---")
    stub_config(page, "")
    page.goto(base, wait_until="networkidle")

    # 造数据：今日 3 次给 A，本月 7 次给 B，两个周期的榜单内容不同
    page.evaluate(
        """() => {
            const pad = n => String(n).padStart(2, '0');
            const d = new Date();
            const day = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
            const month = `${d.getFullYear()}-${pad(d.getMonth()+1)}`;
            localStorage.setItem('mo-hits-v1', JSON.stringify({
                day:   { [day]:   { 'relay-agentrouter': 3 } },
                month: { [month]: { 'relay-kktoken': 7 } },
            }));
        }"""
    )
    page.reload(wait_until="networkidle")
    open_stats(page)

    tabs = stats_tabs(page)
    check("默认选中今日", tabs[0][1] is True and not any(t[1] for t in tabs[1:]),
          str([t for t in tabs]))
    rows = rank_rows(page)
    check("今日榜显示 3 次", rows and rows[0]["n"] == 3, json.dumps(rows, ensure_ascii=False)[:100])

    page.click('[data-stats-tabs] button:has-text("本月")')
    page.wait_for_timeout(300)

    tabs = stats_tabs(page)
    sel = [t[0] for t in tabs if t[1]]
    check("高亮跟着切到本月", sel == ["本月"], str(sel))
    rows = rank_rows(page)
    check("本月榜显示 7 次", rows and rows[0]["n"] == 7, json.dumps(rows, ensure_ascii=False)[:100])

    # 切到没有数据的周期，应显示带周期名的空状态
    page.click('[data-stats-tabs] button:has-text("本周")')
    page.wait_for_timeout(300)
    sel = [t[0] for t in stats_tabs(page) if t[1]]
    check("高亮切到本周", sel == ["本周"], str(sel))
    check("空周期显示占位", page.is_visible("[data-stats-empty]"))
    empty = page.text_content("[data-stats-empty]")
    check("空状态带周期名", "本周" in empty, empty.strip())

    # 五个标签逐个点一遍，确认都能选中
    for label in ["今日", "本周", "本月", "本年", "累计"]:
        page.click(f'[data-stats-tabs] button:has-text("{label}")')
        page.wait_for_timeout(150)
        sel = [t[0] for t in stats_tabs(page) if t[1]]
        check(f"标签「{label}」可选中", sel == [label], str(sel))


def test_visitors_follow_period(page, base, stub_port):
    """访问人数那行要跟着周期变，否则切标签时它一动不动像是坏了。"""
    print("\n--- 访问人数跟随周期 ---")
    StatsStub.hits.clear()
    StatsStub.visits = 0
    StatsStub.per_period = {"day": 3, "week": 11, "month": 25, "year": 40, "all": 55}
    stub_config(page, f"http://127.0.0.1:{stub_port}")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1200)
    open_stats(page)

    txt = page.text_content("[data-stats-visitors]")
    check("默认显示今日人数", "今日访问人数 3 人" in txt, txt.strip()[:70])

    page.click('[data-stats-tabs] button:has-text("累计")')
    page.wait_for_timeout(300)
    txt = page.text_content("[data-stats-visitors]")
    check("切到累计后显示累计人数", "累计访问人数 55 人" in txt, txt.strip()[:70])
    check("仍保留五周期对照", "本月 25" in txt, txt.strip()[-50:])

    StatsStub.per_period = None


def test_api_down(page, base):
    print("\n--- 后端全都不可用时降级 ---")
    # 两个地址都连不上，模拟 Worker 挂掉或整体被网络挡住
    stub_config(page, ["http://127.0.0.1:1", "http://127.0.0.1:2"])
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(800)
    check("页面照常渲染卡片", page.locator(".feed-card").count() > 0)
    check("无未捕获异常", not errors, ";".join(errors)[:200])
    open_stats(page)
    scope = page.text_content("[data-stats-scope]")
    check("退回本机统计", "本机统计" in scope, scope.strip())


def main():
    site_srv, site_port = serve(SiteHandler)
    stub_srv, stub_port = serve(StatsStub)
    base = f"http://127.0.0.1:{site_port}/index.html"
    time.sleep(0.3)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            ctx = browser.new_context()
            page = ctx.new_page()
            item_id = test_local_mode(page, base)
            test_sort(page, base, item_id)
            test_bucket_rollover(page, base, item_id)
            test_jump(page, base, item_id)
            test_adult_filter(page, base)
            ctx.close()

            ctx = browser.new_context()
            test_period_tabs(ctx.new_page(), base)
            ctx.close()

            ctx = browser.new_context()  # 干净的 localStorage
            test_site_mode(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_visitors_follow_period(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_failover(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_retry_round(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_degraded_click_reported(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_api_down(ctx.new_page(), base)
            ctx.close()
        finally:
            browser.close()
            site_srv.shutdown()
            stub_srv.shutdown()

    print(f"\n{len(FAIL)} 项失败：{', '.join(FAIL)}" if FAIL else "\n全部通过")
    raise SystemExit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
