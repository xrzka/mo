#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 linovelib 抓取完整章节内容（浏览器渲染），输出 JSON 供 Worker 缓存。"""
import re, sys, json, time, hashlib
from pathlib import Path
from playwright.sync_api import sync_playwright

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"

def strip_tags(text):
    text = re.sub(r"<script[\s\S]*?</script>", " ", text, flags=re.I)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()

def extract_paragraphs(html):
    """从 #mlfy_main_text 容器提取所有段落（浏览器 JS 重组后的正确顺序）"""
    m = re.search(r'id="mlfy_main_text"[^>]*>([\s\S]*?)$', html, re.I)
    if not m:
        return []
    return [strip_tags(x) for x in re.findall(r"<p[^>]*>([\s\S]*?)</p>", m.group(0), re.I) if strip_tags(x)]

def fetch_chapter(url):
    """用浏览器渲染抓取单个章节，返回段落列表"""
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-setuid-sandbox"])
        ctx = b.new_context(user_agent=UA, locale="zh-CN")
        page = ctx.new_page()
        page.goto(url, wait_until="networkidle", timeout=60000)
        page.wait_for_timeout(3000)  # 等 JS 完成重组
        html = page.evaluate("document.documentElement.outerHTML")
        b.close()
    return extract_paragraphs(html)

def main():
    if len(sys.argv) < 2:
        print("用法: python _fetch_paragraphs.py <novel_id>/<chapter_id> [url]")
        print("示例: python _fetch_paragraphs.py 4649/332058")
        print("      python _fetch_paragraphs.py 5360/334725")
        sys.exit(1)

    key = sys.argv[1]  # 如 "4649/332058"
    url = sys.argv[2] if len(sys.argv) > 2 else f"https://www.linovelib.com/novel/{key}.html"

    print(f"抓取: {url}")
    start = time.time()
    paras = fetch_chapter(url)
    elapsed = time.time() - start

    print(f"完成: {len(paras)} 段, 耗时 {elapsed:.1f}s")
    if paras:
        print(f"首段: {paras[0][:60]}")
        print(f"末段: {paras[-1][:60]}")

    # 输出 JSON 到 stdout（供缓存脚本捕获）
    result = {
        "key": key,
        "url": url,
        "paras": paras,
        "count": len(paras),
        "ts": int(time.time())
    }
    print(f"\n---JSON_START---")
    print(json.dumps(result, ensure_ascii=False))
    print(f"---JSON_END---")

    # 同时写入缓存文件
    cache_dir = Path("D:/local_translate_tool/mo_site/worker/cache")
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_dir = Path("D:/local_translate_tool/mo_site/worker/cache")
    cache_file = cache_dir / f"{key.replace('/', '_')}.json"
    with open(cache_file, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"缓存已写入: {cache_file}")

if __name__ == "__main__":
    main()
