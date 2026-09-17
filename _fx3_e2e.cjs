// 三个需求联测 e2e（本地）：①继续阅读匹配 ②沉浸模式点切 ③图片百分比进度
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
  await page.goto(LOCAL + "/index.html", { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.evaluate(() => [...document.querySelectorAll(".tab-btn")].find((b) => b.textContent.trim().startsWith("观看"))?.click());
  await page.waitForTimeout(1200);
  await page.evaluate(() => [...document.querySelectorAll(".watch-tab")].find((b) => b.textContent.trim() === "小说")?.click());
  await page.waitForFunction(() => document.querySelectorAll(".watch-card").length > 0, { timeout: 45000 });

  // 打开第一本 → 第 6 章（5340 的那章确认有插图）
  await page.locator(".watch-card").first().click();
  await page.waitForFunction(() => document.querySelectorAll(".watch-chapter-open").length > 5, { timeout: 90000 });
  report.resumeBannerAtOpen = await page.evaluate(() => document.querySelector(".watch-resume-text")?.textContent || "");
  await page.locator(".watch-chapter-open").nth(5).click();
  await page.waitForTimeout(20000);

  // ③ 进度图片：插图应有 .img-progress-wrap；读完后应全部 is-loaded（或 is-failed）
  report.progress = await page.evaluate(() => {
    const wraps = [...document.querySelectorAll(".img-progress-wrap")];
    return {
      total: wraps.length,
      loaded: wraps.filter((w) => w.classList.contains("is-loaded")).length,
      failed: wraps.filter((w) => w.classList.contains("is-failed")).length,
      barVisible: wraps.filter((w) => w.querySelector(".img-progress")).length,
      pcts: wraps.slice(0, 6).map((w) => w.querySelector(".img-progress-pct")?.textContent || "-"),
    };
  });
  report.steps.push(`进度壳 ${report.progress.total}（loaded ${report.progress.loaded} / failed ${report.progress.failed}）`);

  // ② 沉浸模式：进阅读模式 → 点正文收起 → 再点叫回
  const modeBtn = page.locator("button", { hasText: "阅读模式" });
  if (await modeBtn.count()) {
    await modeBtn.first().click();
    await page.waitForTimeout(6000);
    const body = await page.locator(".read-mode-body").boundingBox();
    const state = async () => page.evaluate(() => ({
      immersive: !!document.querySelector(".read-mode.is-immersive"),
      topOpacity: getComputedStyle(document.querySelector(".read-mode-top")).opacity,
      topPE: getComputedStyle(document.querySelector(".read-mode-top")).pointerEvents,
      navOpacity: getComputedStyle(document.querySelector(".read-mode-nav")).opacity,
    }));
    report.beforeTap = await state();
    await page.mouse.click(body.x + body.width / 2, body.y + body.height * 0.62);
    await page.waitForTimeout(600);
    report.afterTap1 = await state();
    await page.mouse.click(body.x + body.width / 2, body.y + body.height * 0.62);
    await page.waitForTimeout(600);
    report.afterTap2 = await state();
    report.steps.push(`沉浸切换：${report.beforeTap.immersive} → ${report.afterTap1.immersive} → ${report.afterTap2.immersive}`);
  } else {
    report.steps.push("未找到阅读模式按钮（内嵌正文里可能无此按钮，检查上方）");
  }

  // 退出全屏后返回目录 → ① 继续阅读条应存在且对应当前章
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("关闭") || b.textContent.includes("返回目录"))?.click());
  await page.waitForTimeout(2000);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("返回目录"))?.click());
  await page.waitForTimeout(20000);
  report.resumeAfterRead = await page.evaluate(() => ({
    text: document.querySelector(".watch-resume-text")?.textContent || "",
    currentRow: !!document.querySelector(".watch-chapter-row.is-current"),
  }));
  report.steps.push(`阅读后目录条：${report.resumeAfterRead.text}`);

  report.errors = [...new Set(errs)].slice(0, 8);
  fs.writeFileSync("D:\\local_translate_tool\\mo_site\\_fx3_result.json", JSON.stringify(report, null, 2), "utf8");
  await browser.close();
})().catch((e) => { fs.writeFileSync("D:\\local_translate_tool\\mo_site\\_fx3_result.json", JSON.stringify({ fatal: String(e.stack || e) }), "utf8"); process.exit(1); });
