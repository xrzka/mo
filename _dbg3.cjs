// 刷新后进度恢复失败的原因定位
const { chromium } = require("playwright");
const fs = require("fs");
const LOCAL = "http://127.0.0.1:8799";
(async () => {
  const browser = await chromium.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true, args: ["--no-sandbox", "--mute-audio"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.route("**/mo-stats.pages.dev/**", async (route) => {
    try {
      const up = await fetch(route.request().url(), { headers: { "user-agent": "Mozilla/5.0", origin: "https://xrzka.github.io" } });
      await route.fulfill({ status: up.status, headers: { "content-type": up.headers.get("content-type") || "application/octet-stream", "access-control-allow-origin": LOCAL }, body: Buffer.from(await up.arrayBuffer()) });
    } catch { await route.abort(); }
  });
  const out = {};

  const enterNovel = async () => {
    await page.evaluate(() => [...document.querySelectorAll(".tab-btn")].find((b) => b.textContent.trim().startsWith("观看"))?.click());
    await page.waitForTimeout(1500);
    await page.evaluate(() => [...document.querySelectorAll(".watch-tab")].find((b) => b.textContent.trim() === "小说")?.click());
    await page.waitForFunction(() => document.querySelectorAll(".watch-card").length > 0, { timeout: 60000 });
  };

  await page.goto(LOCAL + "/index.html", { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1500);
  await enterNovel();

  // 记录前 3 张卡片的标题，便于对齐
  out.cardTitlesBefore = await page.evaluate(() => [...document.querySelectorAll(".watch-card")].slice(0, 3).map((c) => c.innerText.replace(/\s+/g, " ").slice(0, 40)));

  await page.locator(".watch-card").first().click();
  await page.waitForFunction(() => document.querySelectorAll(".watch-chapter-open").length > 5, { timeout: 90000 });
  out.openedNovel = await page.evaluate(() => document.querySelector("[data-watch-viewer-title]")?.textContent);
  await page.locator(".watch-chapter-open").nth(5).click();
  await page.waitForTimeout(20000);
  out.readTitle = await page.evaluate(() => document.querySelector("[data-watch-viewer-title]")?.textContent);
  out.progressBefore = await page.evaluate(() => localStorage.getItem("mo-watch-progress-v1"));

  // 刷新
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  out.progressAfterReload = await page.evaluate(() => localStorage.getItem("mo-watch-progress-v1"));
  out.hashAfterReload = await page.evaluate(() => location.hash);
  await enterNovel();
  out.cardTitlesAfter = await page.evaluate(() => [...document.querySelectorAll(".watch-card")].slice(0, 3).map((c) => c.innerText.replace(/\s+/g, " ").slice(0, 40)));
  out.firstCardHasBadge = await page.evaluate(() => {
    const c = document.querySelector(".watch-card");
    return { badge: c?.querySelector(".watch-progress")?.textContent || "", text: c?.innerText.replace(/\s+/g, " ").slice(0, 60) };
  });

  await page.locator(".watch-card").first().click();
  await page.waitForFunction(() => document.querySelectorAll(".watch-chapter-open").length > 5, { timeout: 90000 });
  await page.waitForTimeout(2000);
  out.afterReloadOpen = await page.evaluate(() => ({
    viewerTitle: document.querySelector("[data-watch-viewer-title]")?.textContent,
    resumeText: document.querySelector(".watch-resume-text")?.textContent || "",
    resumePresent: !!document.querySelector(".watch-resume"),
    currentRow: !!document.querySelector(".watch-chapter-row.is-current"),
    chapterCount: document.querySelectorAll(".watch-chapter-open").length,
  }));

  fs.writeFileSync("D:\\local_translate_tool\\mo_site\\_dbg3.json", JSON.stringify(out, null, 2), "utf8");
  await browser.close();
})();
