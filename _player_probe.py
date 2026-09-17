"""测 yun.92cj.com 播放器对不同 Referer 的反应，找能出播放器的条件。"""
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
EMBED = "https://yun.92cj.com/yunbox/?type=vxdev&vid=1071_0bc3liagwaaazean7nkk2fvc6wqennnaa22a&referer=https%3A%2F%2Fwww.lmm85.com%2Fplay%2F8164_1_1.html"

CASES = [
    ("无 Referer", None),
    ("上游 Referer", "https://www.lmm85.com/"),
    ("上游播放页 Referer", "https://www.lmm85.com/play/8164_1_1.html"),
    ("我们的站", "https://xrzka.github.io/"),
    ("播放器自己的域", "https://yun.92cj.com/"),
]

for label, ref in CASES:
    headers = {"User-Agent": UA}
    if ref:
        headers["Referer"] = ref
    req = urllib.request.Request(EMBED, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read()
            print(f"{label:20s} -> {resp.status} {len(body)}B  {body[:60]!r}")
    except urllib.error.HTTPError as exc:
        print(f"{label:20s} -> HTTP {exc.code} {exc.read()[:60]!r}")
    except Exception as exc:
        print(f"{label:20s} -> ERR {str(exc)[:60]}")
