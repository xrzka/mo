"""确认 dongman_N.html 各页可用 + 子分类可用 + 看第 2 页内容。"""
import re
import urllib.request

UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
BASE = "https://www.lmm85.com"


def fetch(path, referer=BASE + "/", timeout=30):
    req = urllib.request.Request(BASE + path, headers={"User-Agent": UA, "Referer": referer})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def cards(html):
    """模拟 Worker 的 parseAnimeCards 提取 id+标题。"""
    out, seen = [], set()
    for m in re.finditer(r"<a[^>]+href=[\"'](\/detail\/(\d+)\.html)[\"'][^>]*>([\s\S]*?)<\/a>", html):
        if m.group(2) in seen:
            continue
        seen.add(m.group(2))
        out.append(m.group(2))
    return out


print("=== dongman 各页 ===")
for n in ["", "_2", "_3", "_4", "_5", "_6", "_10", "_20"]:
    try:
        html = fetch(f"/type/dongman{n}.html")
        ids = cards(html)
        title = re.search(r"<title>([^<]+)</title>", html)
        # 页码指示
        active = re.search(r"page-link active disabled\">(\d+)<", html)
        nxt = "有下一页" if re.search(r"href=\"/type/dongman_\d+\.html\"[^>]*>[^<]*下一页|»", html) else ""
        print(f"  dongman{n or '(首页)':10s} 200 卡片={len(ids)} 页码={active.group(1) if active else '?'} {nxt}")
    except Exception as exc:
        print(f"  dongman{n:10s} -> {str(exc)[:60]}")

print("\n=== 各子分类首屏卡片数 ===")
for slug in ["ribendongman", "guochandongman", "oumeidongman", "dongtaiman", "ribendonghuadianying"]:
    try:
        html = fetch(f"/type/{slug}.html")
        print(f"  {slug:22s} 卡片={len(cards(html))}")
    except Exception as exc:
        print(f"  {slug:22s} ERR {str(exc)[:60]}")

print("\n=== 第 2 页的动画和首页不重复？===")
p1 = set(cards(fetch("/type/dongman.html")))
p2 = set(cards(fetch("/type/dongman_2.html")))
print(f"首页 {len(p1)} 部, 第2页 {len(p2)} 部, 重叠 {len(p1 & p2)} 部")
print(f"第 2 页新增 {len(p2 - p1)} 部")

print("\n=== dongman_2 的真实页码指示 ===")
html2 = fetch("/type/dongman_2.html")
for mm in re.finditer(r"page-link active disabled\">(\d+)", html2):
    print("  当前页 =", mm.group(1))
m = re.search(r"/type/dongman_(\d+)\.html\"[^>]*title=\"第(\d+)页\"", html2)
# 最大页码
pages = [int(x) for x in re.findall(r"/type/dongman_(\d+)\.html", html2)]
print(f"  页码链接里最大页 = {max(pages) if pages else '-'}")
