// 决定性 e2e：①刷新后继续阅读（按徽标唯一定位卡片，排除重排竞态） ③插图百分比进度
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
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/.test(m.text())) errs.push("console: " + m.text().slice(0, 140)); });

  const report = { steps: [] };
  const gotoCatalogue = async () => {
    await page.goto(LOCAL + "/index.html", { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(1200);
    await page.evaluate(() => [...document.querySelectorAll(".tab-btn")].find((b) => b.textContent.trim().startsWith("观看"))?.click());
    await page.waitForTimeout(1200);
    await page.evaluate(() => [...document.querySelectorAll(".watch-tab")].find((b) => b.textContent.trim() === "小说")?.click());
    await page.waitForFunction(() => document.querySelectorAll(".watch-card").length > 0, { timeout: 45000 });
  };
  const openSavedCard = async () => {
    // 只有保存过进度的那本书有徽标 → 唯一定位，杜绝 first() 重排竞态
    await page.waitForSelector(".watch-card.has-progress", { timeout: 60000 });
    await page.locator(".watch-card.has-progress").first().click();
    await page.waitForFunction(() => document.querySelectorAll(".watch-chapter-open").length > 5, { timeout: 120000 });
    await page.waitForTimeout(1500);
  };
  const readResume = () => page.evaluate(() => ({
    resume: document.querySelector(".watch-resume-text")?.textContent || "",
    currentRow: !!document.querySelector(".watch-chapter-row.is-current"),
    btn: !!document.querySelector(".watch-resume-btn"),
  }));

  // 第一轮：读第 6 章（333600，纯文字）
  await gotoCatalogue();
  await page.locator(".watch-card").first().click();
  await page.waitForFunction(() => document.querySelectorAll(".watch-chapter-open").length > 5, { timeout: 120000 });
  await page.locator(".watch-chapter-name", { hasText: "第2話 童年（2）" }).first().click();
  await page.waitForTimeout(20000);
  report.readTitle = await page.evaluate(() => document.querySelector("[data-watch-viewer-title]")?.textContent || "");
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("返回目录"))?.click());
  await page.waitForTimeout(20000);
  report.inSession = await readResume();
  report.steps.push(`会话内：${report.inSession.resume}`);

  // 第二轮：刷新 → 按徽标定位同一本书 → 继续阅读条必须在
  await gotoCatalogue();
  await openSavedCard();
  report.afterReload = await readResume();
  report.steps.push(`刷新后：${report.afterReload.resume || "【失败】无进度条"}`);

  // 第三轮：点「继续阅读 →」按钮真的跳章
  if (report.afterReload.btn) {
    await page.locator(".watch-resume-btn").click();
    await page.waitForTimeout(20000);
    report.afterResumeClick = await page.evaluate(() => document.querySelector("[data-watch-viewer-title]")?.textContent || "");
    report.steps.push(`点继续阅读 → ${report.afterResumeClick}`);
  }

  // 第四轮：返回目录 → 开「Emoji」章（20 张插图）验证百分比进度
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("返回目录"))?.click());
  await page.waitForTimeout(20000);
  await page.locator(".watch-chapter-name", { hasText: "Emoji" }).first().click();
  await page.waitForTimeout(9000);
  report.progressEarly = await page.evaluate(() => {
    const wraps = [...document.querySelectorAll(".img-progress-wrap")];
    return {
      total: wraps.length,
      loaded: wraps.filter((w) => w.classList.contains("is-loaded")).length,
      failed: wraps.filter((w) => w.classList.contains("is-failed")).length,
      barVisible: wraps.filter((w) => w.querySelector(".img-progress")).length,
      samplePct: wraps.slice(0, 4).map((w) => w.querySelector(".img-progress-pct")?.textContent || "-"),
    };
  });
  // 等全部图收口（loaded 或 failed 各占其一）
  try {
    await page.waitForFunction(() => {
      const wraps = [...document.querySelectorAll(".img-progress-wrap")];
      return wraps.length > 0 && wraps.every((w) => w.classList.contains("is-loaded") || w.classList.contains("is-failed"));
    }, { timeout: 90000 });
  } catch { /* 落报告再判 */ }
  report.progressFinal = await page.evaluate(() => {
    const wraps = [...document.querySelectorAll(".img-progress-wrap")];
    return {
      total: wraps.length,
      loaded: wraps.filter((w) => w.classList.contains("is-loaded")).length,
      failed: wraps.filter((w) => w.classList.contains("is-failed")).length,
      imgVisible: wraps.filter((w) => w.querySelector("img") && !w.querySelector("img").hidden).length,
    };
  });
  report.steps.push(`Emoji 进度：壳 ${report.progressFinal.total}，loaded ${report.progressFinal.loaded}，failed ${report.progressFinal.failed}（早期采样 bar可见=${report.progressEarly.barVisible} pct=${report.progressEarly.samplePct.join("/")}）`);

  report.errors = [...new Set(errs)].slice(0, 8);
  fs.writeFileSync("D:\\local_translate_tool\\mo_site\\_fx4_result.json", JSON.stringify(report, null, 2), "utf8");
  await browser.close();
})().catch((e) => { fs.writeFileSync("D:\\local_translate_tool\\mo_site\\_fx4_result.json", JSON.stringify({ fatal: String(e.stack || e) }), "utf8"); process.exit(1); });
