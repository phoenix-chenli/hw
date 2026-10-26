import { chromium } from "playwright-core";
import { writeFile } from "node:fs/promises";
import { jatsToHtml } from "./report-render.mjs";

// A disposable process receives only server-generated XML and a server-owned path.
// It never visits a user-provided URL or fetches fonts/assets from the network.
let browser;
let started = false;
let finished = false;
async function close() {
  if (browser) await browser.close().catch(() => {});
}
process.once("disconnect", async () => {
  if (finished) return;
  await close();
  process.exit(1);
});
process.once("SIGTERM", async () => {
  await close();
  process.exit(1);
});
process.on("message", async ({ xml, outputPath, browserKind }) => {
  if (started) return;
  started = true;
  try {
    const html = jatsToHtml(xml);
    browser = await chromium.launch({
      ...(browserKind === "chrome" ? { channel: "chrome" } : {}),
      headless: true,
      timeout: 15000,
    });
    const context = await browser.newContext({
      javaScriptEnabled: false,
      offline: true,
      locale: "zh-CN",
      serviceWorkers: "block",
    });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 15000 });
    await page.emulateMedia({ media: "print" });
    await page.evaluate(() => document.fonts.ready);
    const bytes = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate:
        '<div style="font:9px sans-serif;color:#667785;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      margin: { top: "17mm", bottom: "20mm", left: "18mm", right: "18mm" },
    });
    if (bytes.length > 12 * 1024 * 1024) throw new Error("PDF_TOO_LARGE");
    await writeFile(outputPath, bytes, { mode: 0o600 });
    await close();
    process.send?.({ ok: true });
    finished = true;
    process.disconnect();
  } catch {
    await close();
    process.send?.({ ok: false });
    finished = true;
    process.disconnect();
    process.exitCode = 1;
  }
});
