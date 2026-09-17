"""直接 POST vxdev.php 拿 m3u8，验证服务端解析可行。"""
import re
import urllib.request
import urllib.parse

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
EMBED = "https://yun.92cj.com/yunbox/?type=vxdev&vid=1071_0bc3liagwaaazean7nkk2fvc6wqennnaa22a&referer=https%3A%2F%2Fwww.lmm85.com%2Fplay%2F8164_1_1.html"

# 1) 拉播放器页拿 vid/t/token
req = urllib.request.Request(EMBED, headers={"User-Agent": UA, "Referer": "https://www.lmm85.com/"})
with urllib.request.urlopen(req, timeout=40) as resp:
    html = resp.read().decode("utf-8", "replace")

vid = re.search(r'var vid = "([^"]+)"', html).group(1)
t = re.search(r'var t = "([^"]+)"', html).group(1)
token = re.search(r'var token = "([^"]+)"', html).group(1)
act = re.search(r'var act = "([^"]+)"', html).group(1)
play = re.search(r'var play = "([^"]+)"', html).group(1)
print(f"vid={vid}\nt={t}\ntoken={token[:40]}...\nact={act} play={play}")

# getc(token) 在外部 JS 里定义，先试直接传原 token
# 外部脚本: //work-order.b0.upaiyun.com/.../0787be2392bf2c49eeede49cfe447333.js
js_url = "https://work-order.b0.upaiyun.com/2026-09/2026-09-01/qq156_workorder_attachement/0787be2392bf2c49eeede49cfe447333.js"
req2 = urllib.request.Request(js_url, headers={"User-Agent": UA})
with urllib.request.urlopen(req2, timeout=30) as resp2:
    js = resp2.read().decode("utf-8", "replace")
print(f"\n外部 JS ({len(js)}B):")
print(js[:1500])
