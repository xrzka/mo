#!/usr/bin/env python3
"""真浏览器端到端测试：点击计数、排行榜、排序、跨天/跨周分桶、隐私模式降级。

本机模式（不配 statsApi）用真实 localStorage 验证；
全站模式用一个本地 HTTP 桩服务假装 Worker，验证前端的上报与拉取。

跑法（在 mo_site/worker 下）：
    python test_browser.py
"""
import http.server
import json
import re
import socketserver
import threading
import time
import urllib.parse
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
    """Worker 桩：实现统计三个接口 + 资源帮找三个接口。"""

    hits = {}
    visits = 0
    # 需要各周期人数不同时设成 {"day":3,...}，默认所有周期都回 visits
    per_period = None

    # 后端返回的桶名。真 Worker 按 UTC 算，前端按本地时区算 —— UTC+8 的凌晨
    # 8 小时里两边的 day 不一样，访问去重必须认后端这份。默认给一个和本地
    # 时区不同的日期，好让测试真正走到那条分支。
    buckets = {
        "day": "2026-09-03",
        "week": "2026-W36",
        "month": "2026-09",
        "year": "2026",
        "all": "all",
    }

    # 资源帮找：id -> 条目。next_id 单调递增，模拟 AUTOINCREMENT
    requests = {}
    next_id = 1
    # 下一次写请求强制返回的 (状态码, 响应体)，用来测错误分支
    force_error = None
    # 设成 True 就假装是还没部署 kind 的老后端：summary 回扁平的
    # {open,found,closed}。前端靠这个形状差别决定是否给出失效反馈入口。
    legacy_summary = False

    @classmethod
    def reset_requests(cls):
        cls.requests = {}
        cls.next_id = 1
        cls.force_error = None
        cls.legacy_summary = False

    # ---- 后台编辑 ----
    # 覆盖层：itemId -> {name?, description?, url?, password?, note?, updated}
    overrides = {}
    # 已发出的 session token 集合。真 Worker 存在 D1，这里够用。
    sessions = set()
    admin_password = "correct-horse-battery"
    # 与 Worker 的 OVERRIDE_FIELDS 保持一致。多一项少一项都会让测试测不到实情。
    override_fields = ("name", "description", "url", "password", "note")

    @classmethod
    def reset_admin(cls):
        cls.overrides = {}
        cls.sessions = set()

    def _bearer(self):
        raw = self.headers.get("Authorization") or ""
        m = re.match(r"^Bearer\s+(\S+)$", raw)
        return m.group(1) if m else ""

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        # 后台要带 Authorization，不放行的话浏览器预检就拦了
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def _send(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/api/overrides"):
            # 后台编辑的覆盖层。前端加载时用它盖住 items.json 的原值。
            return self._send({
                "overrides": {k: dict(v) for k, v in StatsStub.overrides.items()},
                "count": len(StatsStub.overrides),
            })

        if self.path.startswith("/api/admin/session"):
            tok = self._bearer()
            ok = bool(tok) and tok in StatsStub.sessions
            return self._send({"ok": ok}, 200 if ok else 401)

        if self.path.startswith("/api/requests"):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            want_kind = (q.get("kind") or [""])[0]
            want_status = (q.get("status") or [""])[0]

            rows = list(StatsStub.requests.values())
            if want_kind in ("want", "broken"):
                rows = [r for r in rows if r.get("kind", "want") == want_kind]
            if want_status in ("open", "found", "closed"):
                rows = [r for r in rows if r["status"] == want_status]
            items = sorted(rows, key=lambda x: (-x["votes"], -x["id"]))

            # 汇总按 kind 分开，与 Worker 的 listRequests() 返回同一形状
            summary = {
                "want": {"open": 0, "found": 0, "closed": 0},
                "broken": {"open": 0, "found": 0, "closed": 0},
            }
            for it in StatsStub.requests.values():
                k = it.get("kind", "want")
                if k in summary and it["status"] in summary[k]:
                    summary[k][it["status"]] += 1

            if StatsStub.legacy_summary:
                # 老后端：不分 kind 的扁平汇总
                flat = {"open": 0, "found": 0, "closed": 0}
                for it in StatsStub.requests.values():
                    if it["status"] in flat:
                        flat[it["status"]] += 1
                return self._send({"items": items, "summary": flat})

            return self._send({"items": items, "summary": summary})

        periods = ["day", "week", "month", "year", "all"]
        visitors = (
            dict(StatsStub.per_period)
            if StatsStub.per_period
            else {p: StatsStub.visits for p in periods}
        )
        # 真 Worker 会回 buckets（UTC 桶名），前端用 buckets.day 做访问去重。
        # 桩必须一起回，否则测不到时区那条路径。
        self._send({
            "clicks": {p: dict(StatsStub.hits) for p in periods},
            "visitors": visitors,
            "buckets": dict(StatsStub.buckets),
        })

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw or b"{}") or {}
        except json.JSONDecodeError:
            body = {}

        if StatsStub.force_error and self.path.startswith("/api/requests"):
            status, payload = StatsStub.force_error
            StatsStub.force_error = None
            return self._send(payload, status)

        # ---- 后台编辑 ----
        if self.path == "/api/admin/login":
            if body.get("password") != StatsStub.admin_password:
                return self._send({"error": "密码不对"}, 401)
            tok = "a" * 64
            StatsStub.sessions.add(tok)
            exp = "2099-01-01T00:00:00.000Z"
            return self._send({"ok": True, "token": tok, "expires": exp})

        if self.path == "/api/admin/logout":
            tok = self._bearer()
            StatsStub.sessions.discard(tok)
            return self._send({"ok": True})

        if self.path == "/api/admin/override":
            tok = self._bearer()
            if not tok or tok not in StatsStub.sessions:
                return self._send({"error": "未登录或登录已过期"}, 401)

            item_id = str(body.get("item_id") or "").strip()
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", item_id):
                return self._send({"error": "缺少有效的资源 id"}, 400)

            fields = body.get("fields")
            if not isinstance(fields, dict):
                return self._send({"error": "fields 必须是对象"}, 400)
            unknown = [k for k in fields if k not in StatsStub.override_fields]
            if unknown:
                return self._send({"error": f"不可编辑的字段：{', '.join(unknown)}"}, 400)

            cur = dict(StatsStub.overrides.get(item_id) or {})
            cur.pop("updated", None)
            for k, v in fields.items():
                if v is None:
                    cur.pop(k, None)          # null 撤销这一项
                elif isinstance(v, str):
                    if k == "url" and v and not re.match(r"^https?://", v, re.I):
                        return self._send({"error": "链接必须以 http:// 或 https:// 开头"}, 400)
                    cur[k] = v
                else:
                    return self._send({"error": f"{k} 必须是字符串或 null"}, 400)

            if cur:
                cur["updated"] = "2026-09-04T10:00:00.000Z"
                StatsStub.overrides[item_id] = cur
            else:
                StatsStub.overrides.pop(item_id, None)   # 全撤销就删整行
            return self._send({"ok": True, "item_id": item_id})

        if self.path == "/api/hit":
            item = body.get("id")
            if item:
                StatsStub.hits[item] = StatsStub.hits.get(item, 0) + 1
        elif self.path == "/api/visit":
            StatsStub.visits += 1
        elif self.path == "/api/requests":
            kind = body.get("kind") if body.get("kind") in ("want", "broken") else "want"
            title = (body.get("title") or "").strip()
            item_id = str(body.get("item_id") or "").strip()

            if kind == "broken":
                # broken 的键是条目 id，标题只用于展示
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", item_id):
                    return self._send({"error": "缺少有效的资源 id"}, 400)
                norm = "item:" + item_id
                display = title or item_id
            else:
                if not title:
                    return self._send({"error": "作品名不能为空"}, 400)
                # 归一化去重：去掉非字母数字，和后端 normalizeTitle 同一思路
                norm = "".join(c for c in title.lower() if c.isalnum())
                display = title

            # 去重键在 (kind, norm) 上，两类互不干扰
            for it in StatsStub.requests.values():
                if it.get("kind", "want") == kind and it["_norm"] == norm:
                    it["votes"] += 1
                    return self._send({"ok": True, "id": it["id"], "merged": True})
            rid = StatsStub.next_id
            StatsStub.next_id += 1
            StatsStub.requests[rid] = {
                "id": rid,
                "kind": kind,
                "item_id": item_id,
                "title": display,
                "note": (body.get("note") or "").strip(),
                "status": "open",
                "votes": 1,
                "reply": "",
                "created": "2026-09-01T00:00:00.000Z",
                "_norm": norm,
            }
            return self._send({"ok": True, "id": rid})
        elif self.path == "/api/requests/vote":
            rid = body.get("id")
            it = StatsStub.requests.get(rid)
            if not it:
                return self._send({"error": "求助不存在"}, 404)
            # 同一条只让投一次，模拟指纹去重
            if it.get("_voted"):
                return self._send({"ok": False, "reason": "already voted"})
            it["_voted"] = True
            it["votes"] += 1
            return self._send({"ok": True})

        self._send({"ok": True})

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


def test_cross_section(page, base):
    """跨区资源（also_in）必须在它列出的每个分区里都出现。

    「XX漫画小说」这类网盘包里小说和漫画都有，只挂小说区的话逛漫画区的人
    根本看不见。点击数与失效反馈都绑在 id 上，所以是一条数据多处露出，
    不是复制成两条。
    """
    print("\n--- 跨区资源在多个分区都出现 ---")
    stub_config(page, "")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(800)

    target = page.evaluate(
        """async () => {
            const r = await fetch('data/items.json');
            const d = await r.json();
            const items = Array.isArray(d) ? d : d.items;
            const x = items.find(i => (i.also_in || []).length && !i.adult);
            return x ? { id: x.id, name: x.name, section: x.section,
                         also: x.also_in.map(a => a.section) } : null;
        }"""
    )
    if not target:
        check("数据里有跨区条目可测", False, "items.json 里没有带 also_in 的非成人条目")
        return
    print(f"    用 {target['id']}：主分区 {target['section']}，也在 {target['also']}")

    def visible_in(section_label):
        page.click(f'[data-tabs] button:has-text("{section_label}")')
        page.wait_for_timeout(400)
        page.fill('[data-filter="q"]', target["name"])
        page.wait_for_timeout(400)
        return page.locator(f'.feed-card[data-item-id="{target["id"]}"]').count()

    SEC_LABEL = {"novel": "小说", "manga": "漫画", "anime": "动画", "game": "游戏"}
    check(f"主分区 {target['section']} 里能找到", visible_in(SEC_LABEL[target["section"]]) == 1)
    for extra in target["also"]:
        if extra in SEC_LABEL:
            check(f"附加分区 {extra} 里也能找到", visible_in(SEC_LABEL[extra]) == 1)

    # 卡片上要标出「也在 X」，让人知道这一份里还有别的内容
    card = page.locator(f'.feed-card[data-item-id="{target["id"]}"]')
    alt = card.locator(".section-pill.alt")
    check("卡片标出了另外那些区", alt.count() == 1 and "也在" in alt.text_content(),
          alt.text_content().strip() if alt.count() else "-")

    # 同一条数据只有一份，不该在同一分区里重复出现
    page.click('[data-tabs] button:has-text("全部")')
    page.wait_for_timeout(400)
    page.fill('[data-filter="q"]', target["name"])
    page.wait_for_timeout(400)
    check("全部分区里不重复",
          page.locator(f'.feed-card[data-item-id="{target["id"]}"]').count() == 1)


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

    # 去重键必须是后端给的 UTC 日期，不是浏览器本地时区算的日期。
    # 桩故意回 2026-09-03，若前端用了本地日期，这里存的就是「今天」。
    stored = page.evaluate("() => localStorage.getItem('mo-visit-utc-day')")
    check("访问去重键用后端 UTC 桶名", stored == StatsStub.buckets["day"],
          f"{stored} vs {StatsStub.buckets['day']}")


def test_visit_bucket_rollover(page, base, stub_port):
    """后端跨到新的 UTC 日时，必须重新计一次访问人数。

    这条盯的是一个真实 bug：前端原本用本地时区的日期做去重键。
    这台机器是 UTC+8，本地 00:00~08:00 时后端还在前一天的桶里 ——
    那 8 小时来的访客把去重键写成了「今天」，等后端跨到今天的桶，
    他们已经算「报过了」，于是当天访问人数永远是 0，而本周/本月有数。
    """
    print("\n--- 访问人数：后端跨天要重新计 ---")
    StatsStub.hits.clear()
    StatsStub.visits = 0
    StatsStub.buckets = dict(StatsStub.buckets, day="2026-09-03")
    stub_config(page, f"http://127.0.0.1:{stub_port}")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1200)
    check("首次访问已上报", StatsStub.visits == 1, f"visits={StatsStub.visits}")

    # 同一个 UTC 日内刷新不重复计
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(1000)
    check("同一 UTC 日刷新不重复计", StatsStub.visits == 1, f"visits={StatsStub.visits}")

    # 后端跨到下一个 UTC 日：同一个浏览器该被重新计一次
    StatsStub.buckets = dict(StatsStub.buckets, day="2026-09-04")
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(1000)
    check("后端跨天后重新计一次", StatsStub.visits == 2, f"visits={StatsStub.visits}")
    stored = page.evaluate("() => localStorage.getItem('mo-visit-utc-day')")
    check("去重键跟着后端更新", stored == "2026-09-04", str(stored))

    StatsStub.buckets = dict(StatsStub.buckets, day="2026-09-03")


def test_visit_legacy_key_migration(page, base, stub_port):
    """老访客带着旧键 mo-visit-day 回来时，必须重新计一次访问。

    这条盯的是修完时区 bug 后残留的第二个问题：旧键存的是**本地日期**，
    新逻辑存 UTC 日期，两者格式一样、值还常常相同。本地凌晨那批访客的旧值
    恰好等于新值，于是整个 UTC 日都被判成「今天已报过」，人数卡在 0 ——
    修了代码线上却毫无变化，就是这个原因。换新键名一次性作废旧值。
    """
    print("\n--- 访问人数：旧去重键要作废 ---")
    StatsStub.hits.clear()
    StatsStub.visits = 0
    StatsStub.buckets = dict(StatsStub.buckets, day="2026-09-04")
    stub_config(page, f"http://127.0.0.1:{stub_port}")

    # 先造出「老访客」：只有旧键，且值等于后端当前的 UTC 日期（最坏情况）
    page.goto(base, wait_until="networkidle")
    page.evaluate(
        """() => {
            localStorage.setItem('mo-visit-day', '2026-09-04');
            localStorage.removeItem('mo-visit-utc-day');
        }"""
    )
    StatsStub.visits = 0

    page.reload(wait_until="networkidle")
    page.wait_for_timeout(1200)
    check("旧键不再挡住上报", StatsStub.visits == 1, f"visits={StatsStub.visits}")
    check("新键已写入",
          page.evaluate("() => localStorage.getItem('mo-visit-utc-day')") == "2026-09-04")
    check("旧键被清掉",
          page.evaluate("() => localStorage.getItem('mo-visit-day')") is None)

    # 迁移后照常去重，不能变成每次刷新都计
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(1000)
    check("迁移后仍然去重", StatsStub.visits == 1, f"visits={StatsStub.visits}")

    StatsStub.buckets = dict(StatsStub.buckets, day="2026-09-03")


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


def open_wanted(page):
    """展开资源帮找面板。默认收起，不展开拿不到里面的节点。"""
    if page.get_attribute("[data-wanted-toggle]", "aria-expanded") != "true":
        page.click("[data-wanted-toggle]")


def wanted_rows(page):
    return page.eval_on_selector_all(
        "[data-wanted-list] .wanted-row",
        "els => els.map(e => ({"
        " title: e.querySelector('.wanted-name').textContent,"
        " note: (e.querySelector('.wanted-note')||{}).textContent || '',"
        " reply: (e.querySelector('.wanted-reply')||{}).textContent || '',"
        " votes: parseInt(e.querySelector('.wanted-vote strong').textContent),"
        " status: e.querySelector('.wanted-status').textContent }))",
    )


def switch_wanted_kind(page, label):
    """切到「想要资源」或「失效反馈」面板。"""
    page.click(f'[data-wanted-kinds] button:has-text("{label}")')
    page.wait_for_timeout(400)


def open_first_card(page):
    """展开第一张有链接的卡片，返回它的 id。失效反馈按钮只在这类卡片上。"""
    card = page.locator(".feed-card").nth(0)
    card.click()
    page.wait_for_timeout(200)
    return card.get_attribute("data-item-id")


def test_wanted_hidden_without_backend(page, base):
    """没有后端时整块必须隐藏 —— 表单点了没反应比没有表单更让人困惑。"""
    print("\n--- 帮找：无后端时隐藏 ---")
    stub_config(page, "")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1200)
    check("本机模式下帮找区隐藏", page.is_hidden("[data-wanted-panel]"))


def test_wanted_submit(page, base, stub_port):
    print("\n--- 帮找：提交与展示 ---")
    StatsStub.reset_requests()
    stub_config(page, f"http://127.0.0.1:{stub_port}")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1200)

    check("有后端时帮找区显示", page.is_visible("[data-wanted-panel]"))
    open_wanted(page)

    page.fill('[data-wanted-input="title"]', "某部很想看的漫画")
    page.fill('[data-wanted-input="note"]', "作者不记得了，大概是韩漫")
    page.click("[data-wanted-submit]")
    page.wait_for_timeout(900)

    msg = page.text_content("[data-wanted-msg]")
    check("提交成功有反馈", "提交成功" in msg, msg.strip())
    check("后端收到了记录", len(StatsStub.requests) == 1, json.dumps(list(StatsStub.requests)))

    rows = wanted_rows(page)
    check("列表出现该条", len(rows) == 1 and rows[0]["title"] == "某部很想看的漫画",
          json.dumps(rows, ensure_ascii=False)[:150])
    check("补充说明显示", "韩漫" in rows[0]["note"], rows[0]["note"])
    check("初始票数 1", rows[0]["votes"] == 1, str(rows[0]["votes"]))
    check("状态标为待找", rows[0]["status"] == "待找", rows[0]["status"])
    check("提交后清空输入框",
          page.input_value('[data-wanted-input="title"]') == "")

    # 空标题不该发请求
    before = len(StatsStub.requests)
    page.click("[data-wanted-submit]")
    page.wait_for_timeout(500)
    check("空标题被前端挡住", len(StatsStub.requests) == before,
          f"{before} -> {len(StatsStub.requests)}")
    check("空标题有提示", "作品名" in page.text_content("[data-wanted-msg]"))


def test_wanted_merge_and_vote(page, base, stub_port):
    print("\n--- 帮找：合并与投票 ---")
    StatsStub.reset_requests()
    stub_config(page, f"http://127.0.0.1:{stub_port}")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1200)
    open_wanted(page)

    page.fill('[data-wanted-input="title"]', "鬼灭之刃")
    page.click("[data-wanted-submit]")
    page.wait_for_timeout(800)

    # 重复提交（带标点差异）应合并成投票，不新建条目
    page.fill('[data-wanted-input="title"]', "鬼灭之刃！！")
    page.click("[data-wanted-submit]")
    page.wait_for_timeout(900)
    msg = page.text_content("[data-wanted-msg]")
    check("重复提交提示已合并", "加了一票" in msg, msg.strip())
    check("后端仍只有 1 条", len(StatsStub.requests) == 1, str(len(StatsStub.requests)))

    rows = wanted_rows(page)
    check("票数涨到 2", rows and rows[0]["votes"] == 2, json.dumps(rows, ensure_ascii=False)[:120])

    # 点 +1 想看
    page.click("[data-wanted-list] .wanted-vote >> nth=0")
    page.wait_for_timeout(700)
    rows = wanted_rows(page)
    check("投票后票数变 3", rows and rows[0]["votes"] == 3, str(rows[0]["votes"]) if rows else "-")
    check("投票按钮标记已投",
          page.eval_on_selector("[data-wanted-list] .wanted-vote",
                                "e => e.classList.contains('voted')"))
    # 投过之后按钮保持禁用 —— 这是防重复投票的正解，所以这里验证禁用状态
    # 而不是再点一次（再点会一直等按钮可用直到超时）
    check("投过后按钮禁用",
          page.eval_on_selector("[data-wanted-list] .wanted-vote", "e => e.disabled"))
    check("按钮提示已记下",
          "已记下" in (page.get_attribute("[data-wanted-list] .wanted-vote", "title") or ""),
          page.get_attribute("[data-wanted-list] .wanted-vote", "title") or "")

    # 重新加载后由后端决定票数，前端不会凭空多算
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(1300)
    open_wanted(page)
    rows = wanted_rows(page)
    check("刷新后票数与后端一致", rows and rows[0]["votes"] == StatsStub.requests[1]["votes"],
          f'{rows[0]["votes"] if rows else "-"} vs {StatsStub.requests[1]["votes"]}')


def test_wanted_status_tabs(page, base, stub_port):
    print("\n--- 帮找：状态标签 ---")
    StatsStub.reset_requests()
    StatsStub.requests = {
        1: {"id": 1, "title": "待找的作品", "note": "", "status": "open", "votes": 5,
            "reply": "", "created": "2026-09-01T00:00:00.000Z", "_norm": "a"},
        2: {"id": 2, "title": "已找到的作品", "note": "", "status": "found", "votes": 3,
            "reply": "已加到小说区", "created": "2026-08-30T00:00:00.000Z", "_norm": "b"},
        3: {"id": 3, "title": "关掉的作品", "note": "", "status": "closed", "votes": 1,
            "reply": "找不到资源", "created": "2026-08-29T00:00:00.000Z", "_norm": "c"},
    }
    StatsStub.next_id = 4
    stub_config(page, f"http://127.0.0.1:{stub_port}")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1300)
    open_wanted(page)

    sub = page.text_content("[data-wanted-sub]")
    check("标题显示待找条数", "1 条待找" in sub, sub.strip())

    tabs = page.eval_on_selector_all(
        "[data-wanted-tabs] .wanted-tab",
        "els => els.map(e => [e.textContent, e.getAttribute('aria-selected') === 'true'])",
    )
    check("默认选中待找", tabs[0][1] is True and not any(t[1] for t in tabs[1:]), str(tabs))

    rows = wanted_rows(page)
    check("待找页只显示 open", len(rows) == 1 and rows[0]["title"] == "待找的作品",
          json.dumps(rows, ensure_ascii=False)[:120])

    page.click('[data-wanted-tabs] button:has-text("已找到")')
    page.wait_for_timeout(400)
    sel = page.eval_on_selector_all(
        "[data-wanted-tabs] .wanted-tab",
        "els => els.filter(e => e.getAttribute('aria-selected')==='true').map(e=>e.textContent)",
    )
    check("高亮切到已找到", len(sel) == 1 and "已找到" in sel[0], str(sel))
    rows = wanted_rows(page)
    check("显示已找到的条目", len(rows) == 1 and rows[0]["title"] == "已找到的作品",
          json.dumps(rows, ensure_ascii=False)[:120])
    check("显示站长回复", "已加到小说区" in rows[0]["reply"], rows[0]["reply"])

    page.click('[data-wanted-tabs] button:has-text("已关闭")')
    page.wait_for_timeout(400)
    rows = wanted_rows(page)
    check("显示已关闭的条目", len(rows) == 1 and rows[0]["title"] == "关掉的作品",
          json.dumps(rows, ensure_ascii=False)[:120])


def test_broken_report(page, base, stub_port):
    """卡片内的失效反馈按钮：必须自动带上条目 id，不靠用户手打名字。"""
    print("\n--- 失效反馈：卡片按钮提交 ---")
    StatsStub.reset_requests()
    stub_config(page, f"http://127.0.0.1:{stub_port}")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1300)

    item_id = open_first_card(page)
    card = page.locator(f'.feed-card[data-item-id="{item_id}"]')
    btn = card.locator(".card-report-btn")
    check("有链接的卡片显示反馈按钮", btn.count() == 1 and btn.is_visible(), item_id)

    btn.click()
    page.wait_for_timeout(900)

    rec = list(StatsStub.requests.values())
    check("后端收到一条记录", len(rec) == 1, str(len(rec)))
    check("kind 是 broken", rec and rec[0]["kind"] == "broken",
          rec[0]["kind"] if rec else "-")
    check("自动带上了条目 id", rec and rec[0]["item_id"] == item_id,
          f'{rec[0]["item_id"] if rec else "-"} vs {item_id}')
    check("提交后按钮禁用", btn.is_disabled())
    check("按钮文案变完成态", "已反馈" in btn.text_content(), btn.text_content().strip())
    check("旁边给出成功提示", "感谢反馈" in card.locator(".card-report-msg").text_content(),
          card.locator(".card-report-msg").text_content().strip())
    # 按钮里 stopPropagation 了，点它不该把卡片折叠回去
    check("点按钮不折叠卡片", card.get_attribute("aria-expanded") == "true")

    stored = page.evaluate("() => JSON.parse(localStorage.getItem('mo-reported-v1') || '[]')")
    check("本机记下已反馈的 id", item_id in stored, json.dumps(stored)[:120])

    # 刷新后按钮仍是完成态 —— 靠 localStorage，不然用户会以为没提交成功
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(1300)
    page.locator(f'.feed-card[data-item-id="{item_id}"]').click()
    page.wait_for_timeout(300)
    btn2 = page.locator(f'.feed-card[data-item-id="{item_id}"] .card-report-btn')
    check("刷新后按钮仍禁用", btn2.is_disabled())
    check("刷新后文案仍是完成态", "已反馈过" in btn2.text_content(), btn2.text_content().strip())


def test_broken_button_on_linkless_item(page, base, stub_port):
    """没给链接的条目也要能报 —— 那是最彻底的「拿不到」，只是文案换成求补档。

    早先这里筛掉了无链接条目，理由是「没链接就无所谓失效」。那个判断是错的：
    该判断的是用户能不能拿到资源，光看 links 字段判断不了。
    """
    print("\n--- 失效反馈：无链接条目也能报 ---")
    StatsStub.reset_requests()
    stub_config(page, f"http://127.0.0.1:{stub_port}")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1300)

    # 数据里挑一条既没 links 也没 url 的
    target = page.evaluate(
        """async () => {
            const r = await fetch('data/items.json');
            const d = await r.json();
            const items = Array.isArray(d) ? d : d.items;
            const x = items.find(i => !(i.links && i.links.length) && !i.url && !i.adult);
            return x ? { id: x.id, name: x.name } : null;
        }"""
    )
    if not target:
        check("数据里有无链接条目可测", False, "items.json 里没有既无 links 也无 url 的条目")
        return

    page.fill('[data-filter="q"]', target["name"])
    page.wait_for_timeout(400)
    card = page.locator(f'.feed-card[data-item-id="{target["id"]}"]')
    check("搜到该条目", card.count() == 1, target["id"])
    card.click()
    page.wait_for_timeout(300)

    btn = card.locator(".card-report-btn")
    check("无链接条目也有反馈按钮", btn.count() == 1 and btn.is_visible(), target["id"])
    check("文案换成求补档", "求补档" in btn.text_content(), btn.text_content().strip())

    btn.click()
    page.wait_for_timeout(900)
    rec = list(StatsStub.requests.values())
    check("能报上去", len(rec) == 1, str(len(rec)))
    check("带的是这条的 id", rec and rec[0]["item_id"] == target["id"],
          f'{rec[0]["item_id"] if rec else "-"} vs {target["id"]}')


def test_broken_button_on_every_item(page, base, stub_port):
    """有链接的条目文案是「链接失效」，且按钮对所有条目都在 —— 打得开不等于内容还在。"""
    print("\n--- 失效反馈：有链接条目文案 ---")
    StatsStub.reset_requests()
    stub_config(page, f"http://127.0.0.1:{stub_port}")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1300)

    cards = page.locator(".feed-card")
    total = cards.count()
    # 当前页每张卡都该有按钮，不管它有没有链接
    with_btn = page.eval_on_selector_all(
        ".feed-card",
        "els => els.filter(e => e.querySelector('.card-report-btn')).length",
    )
    check("当页每张卡都有反馈按钮", with_btn == total, f"{with_btn}/{total}")

    item_id = open_first_card(page)
    btn = page.locator(f'.feed-card[data-item-id="{item_id}"] .card-report-btn')
    check("有链接的文案是链接失效", "链接失效" in btn.text_content(), btn.text_content().strip())
    hint = page.locator(f'.feed-card[data-item-id="{item_id}"] .card-report-hint')
    check("旁边说明不止链接 404", "解压码" in hint.text_content(), hint.text_content().strip())


def test_broken_panel(page, base, stub_port):
    """失效反馈面板：与「想要资源」分开计数，状态叫法也不同（待补档而不是待找）。"""
    print("\n--- 失效反馈：面板与状态叫法 ---")
    StatsStub.reset_requests()
    StatsStub.requests = {
        1: {"id": 1, "kind": "want", "item_id": "", "title": "想看的作品", "note": "",
            "status": "open", "votes": 2, "reply": "",
            "created": "2026-09-01T00:00:00.000Z", "_norm": "a"},
        2: {"id": 2, "kind": "broken", "item_id": "manual-novel-1", "title": "失效的资源",
            "note": "", "status": "open", "votes": 5, "reply": "",
            "created": "2026-09-02T00:00:00.000Z", "_norm": "item:manual-novel-1"},
        3: {"id": 3, "kind": "broken", "item_id": "manual-manga-1", "title": "已补好的资源",
            "note": "", "status": "found", "votes": 1, "reply": "已换新链接",
            "created": "2026-08-31T00:00:00.000Z", "_norm": "item:manual-manga-1"},
    }
    StatsStub.next_id = 4
    stub_config(page, f"http://127.0.0.1:{stub_port}")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1300)
    open_wanted(page)

    sub = page.text_content("[data-wanted-sub]")
    check("说明里两类分开计数", "1 条待找" in sub and "1 条待补档" in sub, sub.strip())

    # 后端支持时，公告才教用户去点卡片里的按钮。
    # 用 inner_text 而不是 text_content —— 后者返回 node.textContent，
    # 把 hidden 的那半句也算进来，断言就测不到可见性了。
    notice = page.locator(".notice-board-sub").inner_text()
    check("公告指向卡片反馈按钮", "反馈按钮" in notice, notice.strip()[:80])

    kinds = page.eval_on_selector_all(
        "[data-wanted-kinds] .wanted-kind",
        "els => els.map(e => [e.textContent, e.getAttribute('aria-selected') === 'true'])",
    )
    check("默认停在想要资源", len(kinds) == 2 and kinds[0][1] is True and kinds[1][1] is False,
          str(kinds))
    check("想要资源下显示表单", page.is_visible("[data-wanted-form]"))
    check("想要资源下不显示引导", page.is_hidden("[data-wanted-broken-hint]"))

    rows = wanted_rows(page)
    check("想要资源只列 want", len(rows) == 1 and rows[0]["title"] == "想看的作品",
          json.dumps(rows, ensure_ascii=False)[:120])

    switch_wanted_kind(page, "失效反馈")
    check("表单在失效反馈下隐藏", page.is_hidden("[data-wanted-form]"))
    check("改为显示卡片引导", page.is_visible("[data-wanted-broken-hint]"))
    hint = page.text_content("[data-wanted-broken-hint]")
    check("引导指向卡片按钮", "卡片" in hint and "反馈按钮" in hint, hint.strip()[:60])

    tabs = page.eval_on_selector_all(
        "[data-wanted-tabs] .wanted-tab",
        "els => els.map(e => e.textContent)",
    )
    check("状态改叫待补档/已补上",
          any("待补档" in t for t in tabs) and any("已补上" in t for t in tabs), str(tabs))

    rows = wanted_rows(page)
    check("待补档只列 broken 的 open", len(rows) == 1 and rows[0]["title"] == "失效的资源",
          json.dumps(rows, ensure_ascii=False)[:120])
    check("票数取后端值", rows and rows[0]["votes"] == 5, str(rows[0]["votes"]) if rows else "-")
    check("状态徽标写待补档", rows and rows[0]["status"] == "待补档",
          rows[0]["status"] if rows else "-")

    page.click('[data-wanted-tabs] button:has-text("已补上")')
    page.wait_for_timeout(400)
    rows = wanted_rows(page)
    check("已补上页列 found", len(rows) == 1 and rows[0]["title"] == "已补好的资源",
          json.dumps(rows, ensure_ascii=False)[:120])
    check("显示补档回复", "已换新链接" in rows[0]["reply"], rows[0]["reply"])

    # 切回想要资源应回到待处理页，否则会停在空列表上
    switch_wanted_kind(page, "想要资源")
    sel = page.eval_on_selector_all(
        "[data-wanted-tabs] .wanted-tab",
        "els => els.filter(e => e.getAttribute('aria-selected')==='true').map(e=>e.textContent)",
    )
    check("换类型回到待处理页", len(sel) == 1 and "待找" in sel[0], str(sel))


def test_broken_merge(page, base, stub_port):
    """同一条资源被多人报失效要合并成票数，不该堆成多条。"""
    print("\n--- 失效反馈：重复反馈合并 ---")
    StatsStub.reset_requests()
    stub_config(page, f"http://127.0.0.1:{stub_port}")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1300)

    item_id = open_first_card(page)
    page.locator(f'.feed-card[data-item-id="{item_id}"] .card-report-btn').click()
    page.wait_for_timeout(800)
    check("第一次反馈入库", len(StatsStub.requests) == 1, str(len(StatsStub.requests)))

    # 换个访客：清掉本机记录再报同一条，后端应合并而不是新建
    page.evaluate("() => localStorage.removeItem('mo-reported-v1')")
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(1300)
    card = page.locator(f'.feed-card[data-item-id="{item_id}"]')
    card.click()
    page.wait_for_timeout(300)
    btn = card.locator(".card-report-btn")
    check("清掉本机记录后按钮恢复可点", not btn.is_disabled())
    btn.click()
    page.wait_for_timeout(900)

    check("仍只有 1 条", len(StatsStub.requests) == 1, str(len(StatsStub.requests)))
    check("票数涨到 2", list(StatsStub.requests.values())[0]["votes"] == 2,
          str(list(StatsStub.requests.values())[0]["votes"]))
    msg = card.locator(".card-report-msg").text_content()
    check("提示说明已合并", "加了一票" in msg, msg.strip())


def test_broken_error_handling(page, base, stub_port):
    """后端拒绝时要说明原因，并且把按钮放回可点状态。"""
    print("\n--- 失效反馈：错误处理 ---")
    StatsStub.reset_requests()
    stub_config(page, f"http://127.0.0.1:{stub_port}")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1300)

    StatsStub.force_error = (429, {"error": "今天已提交 5 条，明天再来吧"})
    item_id = open_first_card(page)
    card = page.locator(f'.feed-card[data-item-id="{item_id}"]')
    btn = card.locator(".card-report-btn")
    btn.click()
    page.wait_for_timeout(900)

    msg = card.locator(".card-report-msg").text_content()
    check("显示后端返回的原因", "明天再来" in msg, msg.strip())
    check("失败后按钮恢复可点", not btn.is_disabled())
    check("失败不写本机记录",
          page.evaluate("() => localStorage.getItem('mo-reported-v1')") in (None, "[]"),
          str(page.evaluate("() => localStorage.getItem('mo-reported-v1')")))

    # 重试一次应该成功（force_error 只生效一次）
    btn.click()
    page.wait_for_timeout(900)
    check("重试后提交成功", len(StatsStub.requests) == 1, str(len(StatsStub.requests)))
    check("重试后按钮变完成态", btn.is_disabled() and "已反馈" in btn.text_content(),
          btn.text_content().strip())


def test_wanted_xss(page, base, stub_port):
    """用户提交的内容必须走 textContent，绝不能被当 HTML 执行。"""
    print("\n--- 帮找：XSS 载荷 ---")
    StatsStub.reset_requests()
    payload = '<img src=x onerror="window.__xss=1">'
    StatsStub.requests = {
        1: {"id": 1, "title": payload, "note": "<script>window.__xss2=1</script>",
            "status": "open", "votes": 1, "reply": "", "created": "2026-09-01T00:00:00.000Z",
            "_norm": "x"},
    }
    StatsStub.next_id = 2
    stub_config(page, f"http://127.0.0.1:{stub_port}")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1300)
    open_wanted(page)
    page.wait_for_timeout(500)

    rows = wanted_rows(page)
    check("载荷按纯文本显示", rows and rows[0]["title"] == payload,
          rows[0]["title"] if rows else "-")
    check("没有注入 img 标签",
          page.eval_on_selector_all("[data-wanted-list] img", "e => e.length") == 0)
    check("onerror 没有执行", page.evaluate("() => window.__xss === undefined"))
    check("script 没有执行", page.evaluate("() => window.__xss2 === undefined"))


def test_wanted_error_handling(page, base, stub_port):
    """后端报错时要把原因说出来，不能静默失败。"""
    print("\n--- 帮找：错误处理 ---")
    StatsStub.reset_requests()
    stub_config(page, f"http://127.0.0.1:{stub_port}")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1200)
    open_wanted(page)

    StatsStub.force_error = (429, {"error": "今天已提交 5 条，明天再来吧"})
    page.fill('[data-wanted-input="title"]', "超额的提交")
    page.click("[data-wanted-submit]")
    page.wait_for_timeout(800)
    msg = page.text_content("[data-wanted-msg]")
    check("显示后端返回的原因", "明天再来" in msg, msg.strip())
    check("失败时不清空输入", page.input_value('[data-wanted-input="title"]') == "超额的提交")
    check("提交按钮恢复可用",
          page.eval_on_selector("[data-wanted-submit]", "e => !e.disabled"))


def test_wanted_notice_jump(page, base, stub_port):
    print("\n--- 帮找：公告入口跳转 ---")
    StatsStub.reset_requests()
    stub_config(page, f"http://127.0.0.1:{stub_port}")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1200)
    check("公告里有帮找入口", page.is_visible("[data-goto-wanted]"))
    page.click("[data-goto-wanted]")
    page.wait_for_timeout(900)
    check("点击后自动展开", page.get_attribute("[data-wanted-toggle]", "aria-expanded") == "true")
    check("表单可见", page.is_visible("[data-wanted-form]"))


def test_broken_hidden_on_legacy_backend(page, base, stub_port):
    """后端还没部署认识 kind 的那版时，失效反馈入口必须整个消失。

    否则点了会在老后端存成一条以资源名为标题的「想要资源」，
    站长看到一堆分不清是求资源还是报失效的条目，得手工清。
    前端先上线、Worker 后部署的窗口期就是这个场景。
    """
    print("\n--- 失效反馈：老后端下不给入口 ---")
    StatsStub.reset_requests()
    StatsStub.legacy_summary = True
    StatsStub.requests = {
        1: {"id": 1, "kind": "want", "item_id": "", "title": "想看的作品", "note": "",
            "status": "open", "votes": 2, "reply": "",
            "created": "2026-09-01T00:00:00.000Z", "_norm": "a"},
    }
    StatsStub.next_id = 2
    stub_config(page, f"http://127.0.0.1:{stub_port}")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1300)

    # 帮找本身还在，只是退回单一「想要资源」形态
    check("帮找区仍显示", page.is_visible("[data-wanted-panel]"))
    open_wanted(page)
    check("类型标签整条隐藏", page.is_hidden("[data-wanted-kinds]"))
    check("表单仍可用", page.is_visible("[data-wanted-form]"))
    check("不显示失效反馈引导", page.is_hidden("[data-wanted-broken-hint]"))

    sub = page.text_content("[data-wanted-sub]")
    check("说明不提失效反馈", "待补档" not in sub and "1 条待找" in sub, sub.strip())
    check("旧的扁平 summary 计到待找", "1 条待找" in sub, sub.strip())

    tabs = page.eval_on_selector_all(
        "[data-wanted-tabs] .wanted-tab",
        "els => els.map(e => e.textContent)",
    )
    check("状态仍叫待找/已找到", any("待找" in t for t in tabs), str(tabs))

    # 卡片里的反馈按钮也不能出现
    open_first_card(page)
    check("卡片没有失效反馈按钮", page.locator(".card-report-btn").count() == 0)

    # 公告也不能教用户去点一个不存在的按钮
    notice = page.locator(".notice-board-sub").inner_text()
    check("公告不提卡片反馈按钮", "反馈按钮" not in notice, notice.strip()[:80])
    check("公告退回反馈群说法", "反馈群" in notice, notice.strip()[:80])

    StatsStub.legacy_summary = False


def admin_login(page, password=None):
    """走 #admin 入口登录后台。"""
    page.evaluate("() => { location.hash = '#admin'; }")
    page.wait_for_timeout(300)
    page.fill("[data-admin-input]", password if password is not None else StatsStub.admin_password)
    page.click("[data-admin-submit]")
    page.wait_for_timeout(700)


def card_editor(page, item_id):
    """展开某张卡片并打开它的编辑表单，返回定位器。"""
    card = page.locator(f'.feed-card[data-item-id="{item_id}"]')
    if card.get_attribute("aria-expanded") != "true":
        card.click()
        page.wait_for_timeout(200)
    btn = card.locator(".card-admin-btn")
    if card.locator(".card-admin-form").is_hidden():
        btn.click()
        page.wait_for_timeout(300)
    return card


def test_admin_hidden_by_default(page, base, stub_port):
    """没有 #admin、没登录时，页面上不该有任何后台痕迹。

    卡片里的编辑入口是 remove 掉而不是 hidden —— DOM 里留着等于告诉访客
    「这里有个后台」，还可能被改 CSS 显示出来（虽然写操作仍会被 401 挡）。
    """
    print("\n--- 后台：默认完全不可见 ---")
    StatsStub.reset_admin()
    stub_config(page, f"http://127.0.0.1:{stub_port}")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1300)

    check("后台面板隐藏", page.is_hidden("[data-admin-panel]"))
    check("卡片里没有编辑按钮", page.locator(".card-admin-btn").count() == 0)
    check("卡片里没有编辑表单", page.locator(".card-admin-form").count() == 0)

    # 加上 #admin 只露出登录框，编辑入口仍然不给
    page.evaluate("() => { location.hash = '#admin'; }")
    page.wait_for_timeout(400)
    check("#admin 时露出登录框", page.is_visible("[data-admin-panel]"))
    check("未登录仍无编辑按钮", page.locator(".card-admin-btn").count() == 0)
    check("退出按钮此时不显示", page.is_hidden("[data-admin-logout]"))


def test_admin_login(page, base, stub_port):
    print("\n--- 后台：登录与退出 ---")
    StatsStub.reset_admin()
    stub_config(page, f"http://127.0.0.1:{stub_port}")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1300)

    admin_login(page, "wrong-password")
    msg = page.text_content("[data-admin-msg]")
    check("密码错有提示", "密码不对" in msg, msg.strip())
    check("密码错不给编辑入口", page.locator(".card-admin-btn").count() == 0)
    check("失败后清空密码框", page.input_value("[data-admin-input]") == "")

    admin_login(page)
    msg = page.text_content("[data-admin-msg]")
    check("登录成功有提示", "登录成功" in msg, msg.strip())
    check("登录后卡片长出编辑按钮", page.locator(".card-admin-btn").count() > 0,
          str(page.locator(".card-admin-btn").count()))
    check("显示退出按钮", page.is_visible("[data-admin-logout]"))
    check("成功后也清空密码框", page.input_value("[data-admin-input]") == "")
    # 密码不该留在 DOM 或 localStorage 里
    check("密码没落 localStorage",
          page.evaluate("() => JSON.stringify(Object.entries(localStorage))").find("horse") < 0)

    page.click("[data-admin-logout]")
    page.wait_for_timeout(600)
    check("退出后编辑入口消失", page.locator(".card-admin-btn").count() == 0)
    check("退出后 session 也清了", len(StatsStub.sessions) == 0, str(len(StatsStub.sessions)))


def test_admin_edit(page, base, stub_port):
    """改标题/简介/链接/提取码，保存后当场生效。"""
    print("\n--- 后台：编辑四项字段 ---")
    StatsStub.reset_admin()
    stub_config(page, f"http://127.0.0.1:{stub_port}")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1300)
    admin_login(page)

    item_id = page.locator(".feed-card").nth(0).get_attribute("data-item-id")
    card = card_editor(page, item_id)
    fields = card.locator(".card-admin-form .admin-field")
    check("表单有 5 个字段", fields.count() == 5, str(fields.count()))

    # 表单初值应是当前显示值，不是空的
    first_input = card.locator(".card-admin-form .admin-field input").nth(0)
    shown_title = card.locator(".card-title").text_content().strip()
    check("标题输入框带当前值", first_input.input_value().strip() == shown_title,
          f"{first_input.input_value()[:24]} vs {shown_title[:24]}")

    NEW_TITLE = "后台改过的标题"
    NEW_DESC = "后台改过的简介"
    NEW_URL = "https://edited.example.com/x"
    NEW_PW = "9527"
    first_input.fill(NEW_TITLE)
    card.locator(".card-admin-form textarea").nth(0).fill(NEW_DESC)
    card.locator(".card-admin-form .admin-field input").nth(1).fill(NEW_URL)
    card.locator(".card-admin-form .admin-field input").nth(2).fill(NEW_PW)
    card.locator(".admin-save").click()
    page.wait_for_timeout(900)

    msg = card.locator(".card-admin-msg").text_content()
    check("保存成功有提示", "已保存" in msg, msg.strip())

    ov = StatsStub.overrides.get(item_id) or {}
    check("后端存了标题", ov.get("name") == NEW_TITLE, str(ov.get("name")))
    check("后端存了简介", ov.get("description") == NEW_DESC, str(ov.get("description")))
    check("后端存了链接", ov.get("url") == NEW_URL, str(ov.get("url")))
    check("后端存了提取码", ov.get("password") == NEW_PW, str(ov.get("password")))

    # 页面当场更新，不用刷新
    card = page.locator(f'.feed-card[data-item-id="{item_id}"]')
    check("卡片标题当场变了", card.locator(".card-title").text_content().strip() == NEW_TITLE,
          card.locator(".card-title").text_content().strip()[:30])

    # 刷新后仍然是改后的值（说明真的来自后端而不是本地状态）
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(1400)
    card = page.locator(f'.feed-card[data-item-id="{item_id}"]')
    check("刷新后仍是新标题",
          card.locator(".card-title").text_content().strip() == NEW_TITLE,
          card.locator(".card-title").text_content().strip()[:30])
    card.click()
    page.wait_for_timeout(300)
    href = card.locator("a.visit-link").nth(0).get_attribute("href")
    check("跳转链接跟着换了", href == NEW_URL, str(href))
    check("提取码跟着换了", NEW_PW in card.locator(".card-detail").inner_text(),
          card.locator(".card-detail").inner_text()[:60].replace("\n", " "))


def test_admin_visitor_sees_edits(page, base, stub_port):
    """访客（未登录）也要看到改后的内容 —— 覆盖层是公开读的。"""
    print("\n--- 后台：访客看到的是改后的值 ---")
    StatsStub.reset_admin()
    StatsStub.overrides["manual-manga-1"] = {
        "name": "访客也能看到的新标题",
        "note": "访客也能看到的新备注",
        "updated": "2026-09-04T10:00:00.000Z",
    }
    stub_config(page, f"http://127.0.0.1:{stub_port}")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1400)

    page.fill('[data-filter="q"]', "访客也能看到的新标题")
    page.wait_for_timeout(500)
    card = page.locator('.feed-card[data-item-id="manual-manga-1"]')
    check("按新标题能搜到", card.count() == 1, str(card.count()))
    check("显示新标题", card.locator(".card-title").text_content().strip() == "访客也能看到的新标题")
    check("访客没有编辑入口", page.locator(".card-admin-btn").count() == 0)
    # 「后台已改」标记只给登录后的自己看，访客不该看到
    check("访客看不到「后台已改」标记",
          "后台已改" not in page.locator("[data-feed]").inner_text())


def test_admin_reset(page, base, stub_port):
    """撤销全部改动后回到 items.json 的原值。"""
    print("\n--- 后台：撤销改动 ---")
    StatsStub.reset_admin()
    stub_config(page, f"http://127.0.0.1:{stub_port}")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1300)

    item_id = page.locator(".feed-card").nth(0).get_attribute("data-item-id")
    original = page.locator(f'.feed-card[data-item-id="{item_id}"] .card-title').text_content().strip()

    admin_login(page)
    card = card_editor(page, item_id)
    card.locator(".card-admin-form .admin-field input").nth(0).fill("临时改的标题")
    card.locator(".admin-save").click()
    page.wait_for_timeout(900)
    card = page.locator(f'.feed-card[data-item-id="{item_id}"]')
    check("先确认改成功", card.locator(".card-title").text_content().strip() == "临时改的标题")

    card = card_editor(page, item_id)
    check("有改动时才显示撤销按钮", card.locator(".admin-reset").is_visible())
    card.locator(".admin-reset").click()
    page.wait_for_timeout(900)

    check("后端删掉了这条覆盖", item_id not in StatsStub.overrides,
          json.dumps(list(StatsStub.overrides)))
    card = page.locator(f'.feed-card[data-item-id="{item_id}"]')
    check("标题回到原值", card.locator(".card-title").text_content().strip() == original,
          f"{card.locator('.card-title').text_content().strip()[:24]} vs {original[:24]}")


def test_admin_session_expired(page, base, stub_port):
    """会话在服务端失效后，前端要提示重新登录，而不是静默失败。"""
    print("\n--- 后台：会话失效 ---")
    StatsStub.reset_admin()
    stub_config(page, f"http://127.0.0.1:{stub_port}")
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1300)
    admin_login(page)

    item_id = page.locator(".feed-card").nth(0).get_attribute("data-item-id")
    card = card_editor(page, item_id)
    # 服务端把会话清掉，模拟 12 小时到期
    StatsStub.sessions.clear()

    card.locator(".card-admin-form .admin-field input").nth(0).fill("过期后改的标题")
    card.locator(".admin-save").click()
    page.wait_for_timeout(900)

    check("没写进后端", item_id not in StatsStub.overrides, json.dumps(list(StatsStub.overrides)))
    # 401 后前端应清掉登录态，编辑入口随之消失
    check("编辑入口消失", page.locator(".card-admin-btn").count() == 0)
    check("提示重新登录", "重新登录" in page.text_content("[data-admin-sub]")
          or page.is_visible("[data-admin-submit]"))


def test_admin_no_backend(page, base):
    """后端整体不可用时，后台面板不能假装能用。"""
    print("\n--- 后台：后端不可用 ---")
    StatsStub.reset_admin()
    stub_config(page, ["http://127.0.0.1:1"])
    page.goto(base, wait_until="networkidle")
    page.wait_for_timeout(1000)
    page.evaluate("() => { location.hash = '#admin'; }")
    page.wait_for_timeout(400)

    page.fill("[data-admin-input]", "any-password")
    page.click("[data-admin-submit]")
    page.wait_for_timeout(900)
    msg = page.text_content("[data-admin-msg]")
    check("给出失败提示而不是静默", msg.strip() != "", msg.strip()[:60])
    check("仍然没有编辑入口", page.locator(".card-admin-btn").count() == 0)


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
            test_cross_section(ctx.new_page(), base)
            ctx.close()

            ctx = browser.new_context()
            test_period_tabs(ctx.new_page(), base)
            ctx.close()

            ctx = browser.new_context()  # 干净的 localStorage
            test_site_mode(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_visit_bucket_rollover(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_visit_legacy_key_migration(ctx.new_page(), base, stub_port)
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

            # ---- 资源帮找 ----
            ctx = browser.new_context()
            test_wanted_hidden_without_backend(ctx.new_page(), base)
            ctx.close()

            ctx = browser.new_context()
            test_wanted_submit(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_wanted_merge_and_vote(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_wanted_status_tabs(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_wanted_xss(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_wanted_error_handling(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_wanted_notice_jump(ctx.new_page(), base, stub_port)
            ctx.close()

            # ---- 失效反馈 ----
            ctx = browser.new_context()
            test_broken_report(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_broken_button_on_linkless_item(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_broken_button_on_every_item(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_broken_panel(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_broken_merge(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_broken_error_handling(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_broken_hidden_on_legacy_backend(ctx.new_page(), base, stub_port)
            ctx.close()

            # ---- 站长后台 ----
            ctx = browser.new_context()
            test_admin_hidden_by_default(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_admin_login(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_admin_edit(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_admin_visitor_sees_edits(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_admin_reset(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_admin_session_expired(ctx.new_page(), base, stub_port)
            ctx.close()

            ctx = browser.new_context()
            test_admin_no_backend(ctx.new_page(), base)
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
