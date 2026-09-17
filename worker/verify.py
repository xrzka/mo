# -*- coding: utf-8 -*-
"""验证 linovelib 章节：纯 HTTP 的 #TextContent 顺序是否与真实浏览器一致。"""
import re
import sys
import urllib.request
from playwright.sync_api import sync_playwright

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
URL = "https://www.linovelib.com/novel/4649/332058.html"


def strip_tags(text):
    text = re.sub(r"<script[\s\S]*?</script>", " ", text, flags=re.I)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def extract_text_content(html):
    match = re.search(r'id=["\']TextContent["\'][^>]*>([\s\S]*?)</(?:div|article)>', html, flags=re.I)
    if not match:
        return []
    return [
        strip_tags(item)
        for item in re.findall(r"<p[^>]*>([\s\S]*?)</p>", match.group(1), flags=re.I)
        if strip_tags(item)
    ]


def extract_main_text(html):
    # 找 #mlfy_main_text 容器及其所有子孙 div 中的 p 标签
    match = re.search(r'id=["\']mlfy_main_text["\'][^>]*>([\s\S]*?)$', html, flags=re.I)
    if not match:
        return []
    # 找到匹配的结束标签
    full_text = match.group(0)
    return [
        strip_tags(item)
        for item in re.findall(r"<p[^>]*>([\s\S]*?)</p>", full_text, flags=re.I)
        if strip_tags(item)
    ]


def main():
    # 纯 HTTP
    request = urllib.request.Request(
        URL,
        headers={
            "User-Agent": UA,
            "Accept": "text/html",
            "Referer": "https://www.linovelib.com/",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        http_html = response.read().decode("utf-8", "ignore")

    http_paragraphs = extract_text_content(http_html)
    print(f"纯 HTTP #TextContent：{len(http_paragraphs)} 段")
    print("前 10 段：")
    for index, paragraph in enumerate(http_paragraphs[:10]):
        print(f"  [{index}] {paragraph[:80]}")

    # 浏览器
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=False,
            args=["--start-minimized", "--window-position=-32000,-32000", "--window-size=1280,900"],
        )
        context = browser.new_context(user_agent=UA, locale="zh-CN")
        page = context.new_page()
        page.goto(URL, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(8000)
        browser_html = page.evaluate("document.documentElement.outerHTML")
        browser.close()

    browser_paragraphs = extract_main_text(browser_html)
    print(f"\n真实浏览器 #mlfy_main_text：{len(browser_paragraphs)} 段")
    print("前 10 段：")
    for index, paragraph in enumerate(browser_paragraphs[:10]):
        print(f"  [{index}] {paragraph[:80]}")

    # 对比
    matched = 0
    for index in range(min(10, len(http_paragraphs), len(browser_paragraphs))):
        same = http_paragraphs[index] == browser_paragraphs[index]
        if same:
            matched += 1
        marker = "一致" if same else "不一致"
        print(
            f"  前 {index + 1} 段：{marker} | HTTP={http_paragraphs[index][:30]} | "
            f"浏览器={browser_paragraphs[index][:30]}"
        )

    print(f"\n前 10 段一致：{matched}/10")

    # 检查纯 HTTP 的所有段落是否都在浏览器中按顺序出现
    browser_positions = {}
    for index, paragraph in enumerate(browser_paragraphs):
        key = paragraph[:30]
        if key not in browser_positions:
            browser_positions[key] = []
        browser_positions[key].append(index)

    missing = []
    for index, paragraph in enumerate(http_paragraphs):
        positions = browser_positions.get(paragraph[:30], [])
        if not positions:
            missing.append(index)

    print(f"纯 HTTP 段落均在浏览器中出现：{'是' if not missing else '否'}")
    if missing:
        print("缺失位置：" + ", ".join(map(str, missing[:20])))


if __name__ == "__main__":
    main()
