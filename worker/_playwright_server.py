#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Playwright 渲染服务：接收 URL，返回完整 HTML（含 JS 重组后的正文）。

用法:
  python _playwright_server.py [port]

默认端口 50051。请求: POST /render {"url": "..."}
返回: {"html": "...", "status": 200}
"""
import json
import re
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from playwright.sync_api import sync_playwright

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"


def render(url):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-setuid-sandbox"])
        context = browser.new_context(user_agent=UA, locale="zh-CN")
        page = context.new_page()
        page.goto(url, wait_until="networkidle", timeout=60000)
        page.wait_for_timeout(3000)
        html = page.evaluate("document.documentElement.outerHTML")
        browser.close()
    return html


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8", "ignore")
        try:
            data = json.loads(body)
            url = data.get("url")
            if not url:
                self._respond(400, {"error": "missing url"})
                return
            html = render(url)
            self._respond(200, {"html": html})
        except Exception as e:
            self._respond(500, {"error": str(e)})

    def _respond(self, status, payload):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def log_message(self, format, *args):
        sys.stderr.write(f"[playwright-server] {args[0]}\n")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 50051
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(f"Playwright 渲染服务已启动: http://127.0.0.1:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止")
        server.shutdown()


if __name__ == "__main__":
    main()