"""探测 MacCMS 模板的动画分页与其它动画分类。"""
import re
import urllib.request

UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
BASE = "https://www.lmm85.com"


def fetch(path, referer=BASE + "/", timeout=25):
    req = urllib.request.Request(BASE + path, headers={"User-Agent": UA, "Referer": referer})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def count(html):
    return len(set(re.findall(r"/detail/(\d+)\.html", html)))


print("=== 各种候选分页 URL ===")
for path in [
    "/type/dongman.html",
    "/vod/show/id/1.html",
    "/vod/show/id/1/page/2.html",
    "/vod/show/id/1/by/time/page/2.html",
    "/type/dongman/page/2.html",
    "/type/dongman-2.html",
    "/vod/show/area/日本/id/1.html",
    "/type/dongman/周日.html",
]:
    try:
        html = fetch(path)
        nxt = re.search(r"href=[\"']([^\"']*page[^\"']*)[\"']", html)
        print(f"  {path:42s} -> 200 卡片={count(html)} 分页链接={nxt.group(1) if nxt else '无'}")
    except Exception as exc:
        print(f"  {path:42s} -> {str(exc)[:60]}")

print("\n=== dongman 页里的分页控件长什么样 ===")
html = fetch("/type/dongman.html")
m = re.search(r"(pagination|page)[\s\S]{0,900}?<\/nav>|<\/ul>", html)
seg = html[html.find("pagination"):]
if seg:
    print(seg[:800])
else:
    # 找 page 相关链接
    for mm in re.finditer(r"<a[^>]+href=[\"']([^\"']*(?:page|-\d+)[^\"']*)[\"'][^>]*>([^<]{0,20})<\/a>", html):
        print(f"  链接: {mm.group(1)}  文字: {mm.group(2)}")
    print("  （没找到 pagination 关键字）")
    # 看看页面底部有没有"没有更多"
    tail = html[-2000:]
    if "没有更多" in tail or "no more" in tail.lower():
        print("  页尾提示: 没有更多")

print("\n=== 全站还有哪些分类（看导航）===")
home = fetch("/")
for mm in re.finditer(r"href=[\"'](/(?:type|vod/show)[^\"']*)[\"'][^>]*>\s*([^<]{1,12})\s*<", home):
    print(f"  {mm.group(1):44s} {mm.group(2)}")
