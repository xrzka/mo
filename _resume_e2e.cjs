// 阅读进度记忆 + ←/→ 翻章 e2e（本地，带 CORS 代理）
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
  page.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) errs.push("console: " + m.text().slice(0, 120)); });

  const report = { steps: [] };
  const gotoCatalogue = async () => {
    await page.evaluate(() => [...document.querySelectorAll(".tab-btn")].find((b) => b.textContent.trim().startsWith("观看"))?.click());
    await page.waitForTimeout(1200);
    await page.evaluate(() => [...document.querySelectorAll(".watch-tab")].find((b) => b.textContent.trim() === "小说")?.click());
    await page.waitForFunction(() => document.querySelectorAll(".watch-card").length > 0, { timeout: 45000 });
  };

  await page.goto(LOCAL + "/index.html", { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1200);
  await gotoCatalogue();
  report.cardCount = await page.locator(".watch-card").count();
  report.steps.push(`小说卡片 ${report.cardCount} 张`);

  // 打开第一本，读到第 6 章
  await page.locator(".watch-card").first().click();
  await page.waitForFunction(() => document.querySelectorAll(".watch-chapter-open").length > 5, { timeout: 90000 });
  const total = await page.locator(".watch-chapter-open").count();
  report.chapterTotal = total;
  await page.locator(".watch-chapter-open").nth(5).click();
  await page.waitForTimeout(22000);
  report.firstRead = await page.evaluate(() => document.querySelector("[data-watch-viewer-title]")?.textContent);
  report.steps.push(`读第 6 章：${report.firstRead}`);

  // ← / → 翻章（内嵌阅读）
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(16000);
  report.afterRight = await page.evaluate(() => document.querySelector("[data-watch-viewer-title]")?.textContent);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(16000);
  report.afterLeft = await page.evaluate(() => document.querySelector("[data-watch-viewer-title]")?.textContent);
  report.steps.push(`方向键：→ ${report.afterRight} ｜ ← ${report.afterLeft}`);

  // 进的章要停在某一章，便于验证记忆
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(16000);
  report.savedChapter = await page.evaluate(() => document.querySelector("[data-watch-viewer-title]")?.textContent);

  // 回目录：应出现「继续阅读」条
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("返回目录"))?.click());
  await page.waitForTimeout(25000);
  report.resumeBanner = await page.evaluate(() => {
    const box = document.querySelector(".watch-resume");
    return {
      present: !!box,
      text: box?.querySelector(".watch-resume-text")?.textContent || "",
      btn: !!box?.querySelector(".watch-resume-btn"),
      currentRow: !!document.querySelector(".watch-chapter-row.is-current"),
    };
  });
  report.steps.push(`继续阅读条：${report.resumeBanner.text || "无"}`);

  // 刷新页面 → 重进同一本，验证进度仍在（localStorage 持久化）
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await gotoCatalogue();
  const badge = await page.evaluate(() => document.querySelector(".watch-card .watch-progress")?.textContent || "");
  report.cardBadge = badge;
  await page.locator(".watch-card").first().click();
  await page.waitForFunction(() => document.querySelectorAll(".watch-chapter-open").length > 5, { timeout: 90000 });
  await page.waitForTimeout(3000);
  report.afterReload = await page.evaluate(() => ({
    resume: document.querySelector(".watch-resume-text")?.textContent || "",
    currentRow: !!document.querySelector(".watch-chapter-row.is-current"),
  }));
  report.steps.push(`刷新后：${report.afterReload.resume || "无进度条"}`);

  // 阅读模式下方向键 + 切章后进度更新
  const modeBtn = page.locator("button", { hasText: "阅读模式" });
  if (await modeBtn.count()) {
    await modeBtn.first().click();
    await page.waitForTimeout(4000);
    const before = await page.evaluate(() => document.querySelector(".read-mode-step")?.textContent);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(5000);
    report.readModeArrows = { before, after: await page.evaluate(() => document.querySelector(".read-mode-step")?.textContent) };
    report.steps.push(`阅读模式方向键：${before} → ${report.readModeArrows.after}`);
  }

  report.errors = [...new Set(errs)].slice(0, 8);
  fs.writeFileSync("D:\\local_translate_tool\\mo_site\\_resume_result.json", JSON.stringify(report, null, 2), "utf8");
  await browser.close();
})();
