"""看播放器页面内部：引用了什么 JS/CSS，视频地址怎么加载。"""
import re
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
EMBED = "https://yun.92cj.com/yunbox/?type=vxdev&vid=1071_0bc3liagwaaazean7nkk2fvc6wqennnaa22a&referer=https%3A%2F%2Fwww.lmm85.com%2Fplay%2F8164_1_1.html"

req = urllib.request.Request(EMBED, headers={"User-Agent": UA, "Referer": "https://www.lmm85.com/"})
with urllib.request.urlopen(req, timeout=40) as resp:
    html = resp.read().decode("utf-8", "replace")

print(f"长度 {len(html)}B\n")
print("=== 外链资源 ===")
for m in re.finditer(r"(?:src|href)=[\"']([^\"']+)[\"']", html):
    u = m.group(1)
    if not u.startswith("#"):
        print(f"  {u[:110]}")

print("\n=== 脚本关键行 ===")
for m in re.finditer(r"<script[^>]*>([\s\S]*?)</script>", html):
    code = m.group(1).strip()
    if code:
        print(f"--- {len(code)} 字符 ---")
        print(code[:600])
        print()

print("=== 视频/接口线索 ===")
for pat in [r"m3u8", r"\.mp4", r"vid", r"ajax", r"api", r"fetch\(", r"XMLHttpRequest", r"post_message|parent"]:
    for m in re.finditer(pat, html, re.I):
        print(f"  [{pat}] …{html[max(0,m.start()-60):m.start()+120]}…".replace("\n", " ")[:230])
        break
