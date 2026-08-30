#!/usr/bin/env python3
"""线上冒烟测试：直接打已部署的接口，确认真实链路通。

和 test_browser.py 的区别：那个用本地桩，不碰网络；这个打真接口，
验证 D1 表建对了、CORS 白名单生效、参数校验没被绕过。

默认测 pages.dev（访客实际走的那个）。--api 可指定别的地址，
比如 workers.dev 那个备用入口（国内需要代理）。

会往真实数据库写一条 id 为 live-smoke-<时间戳> 的记录，跑完自己删。

跑法：
    python test_live.py
    python test_live.py --api https://mo-stats.werneruszcb71.workers.dev --proxy http://127.0.0.1:7890
"""
import argparse
import json
import os
import subprocess
import time
import urllib.error
import urllib.request

# 访客实际走的地址。workers.dev 那个在国内被墙，只作备用。
DEFAULT_API = "https://mo-stats.pages.dev"
ORIGIN = "https://xrzka.github.io"
ITEM = f"live-smoke-{int(time.time())}"

# Cloudflare 边缘的机器人防护会用 403 挡掉 Python-urllib 这类默认 UA，
# 挡的是我们代码之前的一层（真实浏览器不受影响）。
# 所以这里必须伪装成常规浏览器 UA，否则测的是防护层不是接口。
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
)

FAIL = []
API = DEFAULT_API


def check(name, ok, extra=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  {extra}" if extra else ""))
    if not ok:
        FAIL.append(name)


def build_opener(proxy):
    handlers = [urllib.request.ProxyHandler({"http": proxy, "https": proxy} if proxy else {})]
    return urllib.request.build_opener(*handlers)


def call(opener, path, method="GET", body=None, origin=ORIGIN, retries=5):
    """返回 (状态码, 解析后的 JSON 或 None)。HTTP 错误码也正常返回，不抛。

    带重试：国内直连 pages.dev 偶发 TLS 握手超时（实测约 5~10% 概率），
    退避重试基本就过。这是网络抖动，不是接口问题 —— 真实访客遇到时
    前端会退回本机模式，下次打开再拉。
    """
    data = json.dumps(body).encode() if body is not None else None
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(API + path, data=data, method=method)
        req.add_header("User-Agent", UA)
        if origin:
            req.add_header("Origin", origin)
        if data:
            req.add_header("Content-Type", "application/json")
        try:
            with opener.open(req, timeout=25) as r:
                return r.status, json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            # HTTP 层的错误码是预期结果之一（403/400/404），不重试
            raw = e.read().decode(errors="replace")
            try:
                return e.code, json.loads(raw)
            except json.JSONDecodeError:
                return e.code, None
        except Exception as e:
            last = e
            if attempt < retries - 1:
                time.sleep(2 + attempt * 2)  # 2s, 4s, 6s, 8s
    raise last


def main():
    global API
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default=DEFAULT_API, help="要测的接口地址")
    ap.add_argument("--proxy", default="", help="workers.dev 在国内需要代理")
    args = ap.parse_args()
    API = args.api.rstrip("/")
    opener = build_opener(args.proxy)

    print(f"目标 {API}")
    print(f"代理 {args.proxy or '直连'}")

    # 1. 读接口
    try:
        status, stats = call(opener, "/api/stats")
    except Exception as e:
        print(f"\n连不上：{e}")
        print("workers.dev 在国内被墙，需要 --proxy；pages.dev 应该可以直连。")
        raise SystemExit(1)

    check("GET /api/stats 返回 200", status == 200, str(status))
    if status != 200 or not stats:
        print("\n读接口不通，后续检查无意义。403 通常是边缘机器人防护挡了非浏览器 UA，")
        print("或者需要代理才能访问 workers.dev。")
        raise SystemExit(1)

    check("响应含 clicks/visitors/buckets", all(k in stats for k in ("clicks", "visitors", "buckets")))
    periods = ["day", "week", "month", "year", "all"]
    check("五个周期齐全", all(p in stats["clicks"] for p in periods))
    check("桶名格式正确", len(stats["buckets"]["day"]) == 10 and "-W" in stats["buckets"]["week"],
          json.dumps(stats["buckets"], ensure_ascii=False))

    before = stats["clicks"]["all"].get(ITEM, 0)

    # 2. 写接口 + 读回
    status, _ = call(opener, "/api/hit", "POST", {"id": ITEM})
    check("POST /api/hit 返回 200", status == 200, str(status))

    time.sleep(1.5)  # D1 写入到读出有短暂延迟
    _, stats = call(opener, "/api/stats")
    check("点击已入库且五个周期都加了",
          all(stats["clicks"][p].get(ITEM, 0) == before + 1 for p in periods),
          json.dumps({p: stats["clicks"][p].get(ITEM) for p in periods}))

    # 3. 安全：Origin 白名单与参数校验
    status, _ = call(opener, "/api/hit", "POST", {"id": "evil-origin-probe"}, origin="https://evil.example.com")
    check("非白名单 Origin 被 403", status == 403, str(status))

    for bad, label in [
        ("", "空 id"),
        ("x; DROP TABLE clicks", "注入串"),
        ("中文id", "非 ASCII"),
        ("y" * 65, "超长 id"),
    ]:
        time.sleep(1)  # 连续快打会触发边缘限速，间隔一下
        status, _ = call(opener, "/api/hit", "POST", {"id": bad})
        check(f"{label} 被 400", status == 400, str(status))

    time.sleep(1)
    status, _ = call(opener, "/api/nope")
    check("未知路径 404", status == 404, str(status))

    # 4. 确认被拒的请求真没写进去
    time.sleep(1)
    _, stats = call(opener, "/api/stats")
    check("被拒请求未污染数据", "evil-origin-probe" not in stats["clicks"]["all"])
    check("表结构完好（仍能正常读）", isinstance(stats["clicks"]["all"], dict))

    # 5. 清理测试数据
    print("\n清理测试数据…")
    # 直接调 wrangler 而不是 wr.sh —— Windows 上 subprocess 跑 .sh 要绕 bash，
    # 而 wr.sh 只是设两个环境变量，这里自己设更省事。
    env = dict(os.environ)
    env["XDG_CONFIG_HOME"] = r"D:\local_translate_tool\wrangler_home"
    env["WRANGLER_LOG_PATH"] = r"D:\local_translate_tool\wrangler_home\logs"
    try:
        r = subprocess.run(
            ["wrangler.cmd", "d1", "execute", "mo-stats", "--remote", "-y",
             "--command", f"DELETE FROM clicks WHERE item = '{ITEM}'"],
            capture_output=True, text=True, timeout=180, env=env,
            # wrangler 输出带颜色转义和 emoji，Windows 默认的 GBK 解不了会抛
            # UnicodeDecodeError，导致 stdout 变成 None
            encoding="utf-8", errors="replace",
        )
        ok = '"changed_db": true' in (r.stdout or "")
        check("测试记录已删除", ok, "" if ok else ((r.stderr or r.stdout or "")[-200:] or "无输出"))
    except Exception as e:
        check("测试记录已删除", False, f"{e}；请手动执行 DELETE FROM clicks WHERE item = '{ITEM}'")

    print(f"\n{len(FAIL)} 项失败：{', '.join(FAIL)}" if FAIL else "\n全部通过")
    raise SystemExit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
