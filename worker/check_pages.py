# -*- coding: utf-8 -*-
"""检查 linovelib 章节分页结构"""
import re
import sys
import urllib.request
from playwright.sync_api import sync_playwright

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
URL = "https://www.linovelib.com/novel/4649/332058.html"


def main():
    # 1. 纯 HTTP 检查分页链接
    request = urllib.request.Request(
        URL,
        headers={"User-Agent": UA, "Accept": "text/html", "Referer": "https://www.linovelib.com/"}
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        html = response.read().decode("utf-8", "ignore")

    # 找 ReadParams 中的 url_next
    read_params = re.search(r'ReadParams\s*=\s*({[^}]+})', html)
    if read_params:
        print("ReadParams 片段:")
        print(read_params.group(0)[:500])

    # 找分页链接
    pages = re.findall(r'href=["\'](/novel/4649/\d+(_\d+)?\.html)["\']', html)
    print(f"\n找到分页链接: {set(pages[:20])}")

    # 2. 浏览器检查实际 DOM 中的分页结构
    with sync_playwright() as p:
        b = p.chromium.launch(headless=False, args=["--start-minimized","--window-position=-32000,-32000","--window-size=1280,900"])
        ctx = b.new_context(user_agent=UA, locale="zh-CN")
        page = ctx.new_page()
        page.goto(URL, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(5000)

        # 获取 ReadParams
        read_params_js = page.evaluate("""
            () => {
                if (typeof ReadParams !== 'undefined') return JSON.stringify(ReadParams, null, 2);
                return 'ReadParams not found';
            }
        """)
        print(f"\n浏览器 ReadParams:\n{read_params_js[:800]}")

        # 检查分页按钮
        pagination = page.evaluate("""
            () => {
                const links = document.querySelectorAll('a[href*="332058"]');
                return Array.from(links).map(a => ({
                    text: a.textContent.trim(),
                    href: a.href
                }));
            }
        """)
        print(f"\n分页相关链接: {pagination}")

        # 检查是否有 _2.html 链接
        next_page = page.evaluate("""
            () => {
                const links = document.querySelectorAll('a');
                for (const a of links) {
                    if (a.href.includes('_2.html') || a.textContent.includes('下一页') || a.textContent.includes('下一章')) {
                        return { text: a.textContent.trim(), href: a.href };
                    }
                }
                return null;
            }
        """)
        print(f"\n下一页/分页: {next_page}")

        b.close()


if __name__ == "__main__":
    main()
