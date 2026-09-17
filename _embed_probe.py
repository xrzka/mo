"""验证 embedUrl 能否被 iframe 播：看响应头（X-Frame-Options/CSP）与页面内容。"""
import re
import json
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
LIVE = "https://mo-stats.pages.dev"


def api(path, timeout=90):
    req = urllib.request.Request(LIVE + path, headers={"User-Agent": "probe/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


# 拿一个真实 embedUrl
j = api("/api/watch/anime?action=list")
first = j["items"][0]
d = api(f"/api/watch/anime?action=detail&anime={first['id']}")
ep = d["episodes"][0]
p = api(f"/api/watch/anime?action=play&anime={first['id']}&episode={ep['id']}")
embed = p["embedUrl"]
print(f"动画: {first['title']}  集数: {len(d['episodes'])}")
print(f"embedUrl = {embed}\n")

print("=== 响应头（关键：X-Frame-Options / CSP）===")
req = urllib.request.Request(embed, headers={"User-Agent": UA, "Referer": "https://xrzka.github.io/"})
try:
    with urllib.request.urlopen(req, timeout=40) as resp:
        for k, v in resp.headers.items():
            print(f"  {k}: {v[:100]}")
        body = resp.read().decode("utf-8", "replace")
        print(f"\n页面长度 {len(body)}B")
        # 是不是错误页
        if re.search(r"(拒绝|refused|403|forbidden|blocked|denied)", body, re.I):
            print("  ⚠ 页面含拒绝字样")
        # 找播放器配置（vid、m3u8、直链）
        for pat in [r"m3u8", r"\.mp4", r"player_aaaa", r"video_id", r"unescape\("]:
            m = re.search(pat, body)
            if m:
                print(f"  含 {pat} @ {m.start()}")
                print("   上下文:", body[m.start()-80:m.start()+200].replace("\n", " ")[:280])
                break
except urllib.error.HTTPError as exc:
    print(f"  HTTP {exc.code}")
    for k, v in exc.headers.items():
        print(f"  {k}: {v[:100]}")
    print(exc.read().decode("utf-8", "replace")[:300])
