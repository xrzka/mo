"""诊断：1) 动画上游分页有没有更多内容 2) 播放链路（详情→选集→play接口→iframe）哪一环断了。"""
import json
import re
import urllib.parse
import urllib.request

LIVE = "https://mo-stats.pages.dev"
UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"


def api(path, timeout=90):
    req = urllib.request.Request(LIVE + path, headers={"User-Agent": "probe/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode("utf-8", "replace"))
        except Exception:
            return exc.code, {}
    except Exception as exc:
        return "ERR", {"error": str(exc)[:120]}


print("=== 1) 动画列表条数（决定翻页条是否出现：<=24 就隐藏）===")
st, j = api("/api/watch/anime?action=list")
items = j.get("items", [])
print(f"条数 = {len(items)}")

print("\n=== 2) 动画上游直连测试（Worker 视角测不了，本地测连通性）===")
for host in ["https://www.lmm85.com", "https://m.lm6.net"]:
    try:
        req = urllib.request.Request(host + "/", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as resp:
            print(f"  {host} -> {resp.status} {len(resp.read())}B")
    except Exception as exc:
        print(f"  {host} -> ERR {str(exc)[:80]}")

print("\n=== 3) 动画分页 URL 是否存在（/type/dongman/2.html）===")
for path in ["/type/dongman.html", "/type/dongman/2.html", "/type/dongman/3.html", "/type/dongman/page/2.html"]:
    for host in ["https://www.lmm85.com", "https://m.lm6.net"]:
        try:
            req = urllib.request.Request(host + path, headers={"User-Agent": UA, "Referer": host + "/"})
            with urllib.request.urlopen(req, timeout=25) as resp:
                body = resp.read().decode("utf-8", "replace")
                n = len(re.findall(r"/detail/\d+\.html", body))
                # 有没有下一页链接
                nxt = re.search(r"href=[\"']([^\"']*)[\"'][^>]*>[^<]*下一页", body)
                print(f"  {host}{path} -> {resp.status} {len(body)}B 卡片数={n} 下一页={nxt.group(1) if nxt else '无'}")
                break
        except Exception as exc:
            print(f"  {host}{path} -> ERR {str(exc)[:70]}")

print("\n=== 4) 播放链路：详情 → 选集 → play ===")
if items:
    first = items[0]
    print(f"测试动画: {first['title']} (id={first['id']})")
    st, d = api(f"/api/watch/anime?action=detail&anime={first['id']}")
    print(f"详情 HTTP {st}: {json.dumps({k: (v if not isinstance(v, list) else f'{len(v)} 项') for k, v in d.items()}, ensure_ascii=False)[:200]}")
    eps = d.get("episodes", [])
    if eps:
        ep = eps[0]
        print(f"第一集: {ep}")
        st, p = api(f"/api/watch/anime?action=play&anime={first['id']}&episode={ep.get('id', '')}")
        print(f"play HTTP {st}: {json.dumps(p, ensure_ascii=False)[:300]}")
