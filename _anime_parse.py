"""1) 上游 60 张卡片为什么只解析 20 张 2) embedUrl 浏览器里能否播放。"""
import re
import json
import urllib.request

UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"


def fetch(url, referer=None, timeout=30):
    headers = {"User-Agent": UA, "Accept": "text/html,*/*"}
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


html = fetch("https://www.lmm85.com/type/dongman.html", "https://www.lmm85.com/")

print("=== /detail/ 链接总数 ===")
all_links = re.findall(r"<a[^>]+href=[\"'](\/detail\/(\d+)\.html)[\"'][^>]*>([\s\S]*?)<\/a>", html)
print(f"锚点总数 = {len(all_links)}")
ids = [a[1] for a in all_links]
print(f"去重后 id 数 = {len(set(ids))}")

print("\n=== Worker 的正则复现（限 36 上限）===")
seen = set()
items = []
for m in re.finditer(r"<a[^>]+href=[\"'](\/detail\/(\d+)\.html)[\"'][^>]*>([\s\S]*?)<\/a>", html):
    if m.group(2) in seen:
        continue
    seen.add(m.group(2))
    items.append(m.group(2))
    if len(items) >= 36:
        break
print(f"Worker 正则抓到 = {len(items)}")

print("\n=== 什么结构在截断？看第 20 个之后的锚点 ===")
# 找出正则匹配之外的所有 /detail/ 出现位置
raw_ids = re.findall(r"/detail/(\d+)\.html", html)
print(f"裸 /detail/ 出现次数 = {len(raw_ids)}，去重 = {len(set(raw_ids))}")
print(f"前 40 个 id: {raw_ids[:40]}")
print(f"Anchor 正则抓到的 36 个里第 20 个 id = {items[19] if len(items) > 19 else '-'}")
# anchor 正则要求 <a> 里有内容且闭合，看漏掉的 id
missing = set(raw_ids) - set(items)
print(f"Anchor 正则漏掉的 id 数 = {len(missing)}，例: {list(missing)[:10]}")

print("\n=== 卡片容器的实际类名 ===")
i = html.find("/detail/")
print(html[max(0, i - 500):i + 400].replace("\n", " ")[:900])
