"""把播放器页面完整脚本存下来，找它请求 m3u8 的接口。"""
import re
import urllib.request
from pathlib import Path

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
EMBED = "https://yun.92cj.com/yunbox/?type=vxdev&vid=1071_0bc3liagwaaazean7nkk2fvc6wqennnaa22a&referer=https%3A%2F%2Fwww.lmm85.com%2Fplay%2F8164_1_1.html"

req = urllib.request.Request(EMBED, headers={"User-Agent": UA, "Referer": "https://www.lmm85.com/"})
with urllib.request.urlopen(req, timeout=40) as resp:
    html = resp.read().decode("utf-8", "replace")

Path("_player_dump.html").write_text(html, encoding="utf-8")
m = re.search(r"<script[^>]*>([\s\S]{200,}?)</script>", html)
if m:
    print(m.group(1))
