#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 linovelib 抓取完整章节内容（浏览器渲染），支持分页，输出 JSON 供 Worker 缓存。"""
import re, sys, json, time
from pathlib import Path
from playwright.sync_api import sync_playwright

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
BASE_URL = "https://www.linovelib.com"

def strip_tags(text):
    text = re.sub(r"<script[\s\S]*?</script>", " ", text, flags=re.I)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()

def extract_paragraphs(html):
    m = re.search(r'id="mlfy_main_text"[^>]*>([\s\S]*?)$', html, re.I)
    if not m:
        return []
    return [strip_tags(x) for x in re.findall(r"<p[^>]*>([\s\S]*?)</p>", m.group(0), re.I) if strip_tags(x)]

def find_next_page_link(html, novel_id, chapter_id):
    patterns = [
        rf'href=["\'](/novel/{novel_id}/{chapter_id}_\d+\.html)["\'][^>]*>(?:下一頁|下一页|下一章)',
        rf'href=["\'](/novel/{novel_id}/{chapter_id}_\d+\.html)["\']',
    ]
    for pat in patterns:
        m = re.search(pat, html, re.I)
        if m:
            return m.group(1)
    return None

def fetch_chapter_with_pagination(novel_id, chapter_id):
    all_paragraphs = []
    current_path = f"/novel/{novel_id}/{chapter_id}.html"
    visited = set()

    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-setuid-sandbox"])
        ctx = b.new_context(user_agent=UA, locale="zh-CN")
        page = ctx.new_page()

        page_count = 0
        while current_path and current_path not in visited:
            visited.add(current_path)
            page_count += 1
            url = BASE_URL + current_path
            print(f"  抓取第 {page_count} 页: {url}", file=sys.stderr)

            # 改用 domcontentloaded 避免 networkidle 超时
            page.goto(url, wait_until="domcontentloaded", timeout=120000)
            page.wait_for_timeout(5000)  # 等 JS 完成重组
            html = page.evaluate("document.documentElement.outerHTML")

            paras = extract_paragraphs(html)
            all_paragraphs.extend(paras)
            print(f"    本页 {len(paras)} 段，累计 {len(all_paragraphs)} 段", file=sys.stderr)

            current_path = find_next_page_link(html, novel_id, chapter_id)

        b.close()

    return all_paragraphs, page_count

def main():
    if len(sys.argv) < 2:
        print("用法: python _fetch_paragraphs.py <novel_id>/<chapter_id>")
        sys.exit(1)

    key = sys.argv[1]
    novel_id, chapter_id = key.split("/")

    print(f"抓取: {key} (novel={novel_id}, chapter={chapter_id})")
    start = time.time()
    paras, pages = fetch_chapter_with_pagination(novel_id, chapter_id)
    elapsed = time.time() - start

    print(f"完成: {len(paras)} 段 ({pages} 页), 耗时 {elapsed:.1f}s")
    if paras:
        print(f"首段: {paras[0][:60]}")
        print(f"末段: {paras[-1][:60]}")

    result = {
        "key": key,
        "url": f"{BASE_URL}/novel/{key}.html",
        "blocks": paras,
        "pages": pages,
        "count": len(paras),
        "ts": int(time.time())
    }
    print(f"\n---JSON_START---")
    print(json.dumps(result, ensure_ascii=False))
    print(f"---JSON_END---")

    cache_dir = Path("D:/local_translate_tool/mo_site/worker/cache")
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"{key.replace('/', '_')}.json"
    with open(cache_file, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"缓存已写入: {cache_file}")

if __name__ == "__main__":
    main()
