const { chromium } = require("playwright");
const fs = require("fs");
const LOCAL = "http://127.0.0.1:8799";
(async () => {
  const browser = await chromium.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true, args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  await page.route("**/mo-stats.pages.dev/**", async (route) => {
    const req = route.request();
    try {
      const up = await fetch(req.url(), { headers: { "user-agent": "Mozilla/5.0", origin: "https://xrzka.github.io" } });
      await route.fulfill({
        status: up.status,
        headers: { "content-type": up.headers.get("content-type") || "application/octet-stream", "access-control-allow-origin": LOCAL },
        body: Buffer.from(await up.arrayBuffer()),
      });
    } catch (e) { errs.push("route:" + e.message); await route.abort(); }
  });
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  await page.goto(LOCAL + "/index.html", { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.evaluate(() => [...document.querySelectorAll(".tab-btn")].find((b) => b.textContent.trim().startsWith("观看"))?.click());
  await page.waitForTimeout(1500);
  await page.evaluate(() => [...document.querySelectorAll(".watch-tab")].find((b) => b.textContent.trim() === "小说")?.click());
  await page.waitForTimeout(8000);
  const state1 = await page.evaluate(() => ({
    cards: document.querySelectorAll(".watch-card").length,
    status: document.querySelector("[data-watch-status]")?.textContent,
    watchHidden: document.querySelector("[data-watch-panel]")?.hidden,
  }));
  await page.locator(".watch-card").first().click();
  await page.waitForTimeout(32000);
  const state2 = await page.evaluate(() => {
    const body = document.querySelector("[data-watch-viewer-body]");
    return {
      viewerTitle: document.querySelector("[data-watch-viewer-title]")?.textContent,
      bodyText: (body?.innerText || "").replace(/\s+/g, " ").slice(0, 200),
      chapterBtns: document.querySelectorAll(".watch-chapter-open").length,
      resumePresent: !!document.querySelector(".watch-resume"),
      anyBtn: document.querySelectorAll("[data-watch-viewer-body] button").length,
    };
  });
  fs.writeFileSync("D:\\local_translate_tool\\mo_site\\_dbg2.json", JSON.stringify({ state1, state2, errs }, null, 2), "utf8");
  await browser.close();
})();
