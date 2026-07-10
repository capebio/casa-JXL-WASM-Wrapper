// Google Lens client — BEST EFFORT, unreliable by design.
// Lens has no documented automation interface. We drive lens.google.com with a
// headful Chromium (Playwright). The DOM is undocumented and changes without
// notice; expect breakage, consent walls, and occasional CAPTCHA (manual solve).
// On any failure we save a screenshot under work/ for debugging and return an error.

export const meta = { id: "lens", label: "Google Lens", scope: "everything", needsKey: null };

export async function identify({ filePath, filename, workDir, signal, timeoutMs = 45000 }) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: false });
  const tag = (filename || filePath || "run").replace(/\.[^.]+$/, "").replace(/[^\w-]/g, "_");
  const shotBase = `${workDir}/lens-${tag}`;
  try {
    const ctx = await browser.newContext({ acceptDownloads: false, locale: "en-US" });
    const page = await ctx.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.goto("https://lens.google.com/", { waitUntil: "domcontentloaded" });

    // Dismiss consent if present (best effort; selectors vary by region).
    for (const sel of ['button:has-text("Accept all")', 'button:has-text("I agree")', 'button:has-text("Reject all")']) {
      const b = page.locator(sel).first();
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break; }
    }

    // Lens's "upload a file" link opens a native file chooser — drive it via the
    // filechooser event (setInputFiles on the hidden input alone is ignored).
    let uploaded = false;
    try {
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: timeoutMs }),
        page.getByText(/upload a file/i).first().click(),
      ]);
      await chooser.setFiles(filePath);
      uploaded = true;
    } catch { /* fall through to direct input set */ }
    if (!uploaded) {
      const inputs = page.locator('input[type="file"]');
      const nInputs = await inputs.count().catch(() => 0);
      for (let k = 0; k < nInputs; k++) await inputs.nth(k).setInputFiles(filePath).catch(() => {});
    }

    // Results land on lens.google.com/search or google.com/search?...&udm/sbi.
    await page.waitForURL(/\/search/, { timeout: timeoutMs }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});
    await page.waitForTimeout(4000);

    // Lens shows an "About this image / results" panel with candidate labels.
    const candidates = await page.evaluate(() => {
      const out = [];
      const push = (t) => { t = (t || "").trim().replace(/\s+/g, " "); if (t && t.length > 1 && t.length < 120) out.push(t); };
      // Result cards carry aria-labels; the "exact/visual matches" list items and headings.
      document.querySelectorAll('[role="listitem"] a[aria-label], [role="listitem"] [aria-label], a[aria-label][role="link"], h1, h2, [data-attrid] span').forEach((e) => {
        if (out.length < 20) push(e.getAttribute?.("aria-label") || e.textContent);
      });
      const nav = /^(Gmail|Images|Google apps|Sign in|Search|Search for Images|About|Settings)$/i;
      return out.filter((t) => !nav.test(t)).filter((t, i, a) => a.indexOf(t) === i).slice(0, 8);
    });

    const shot = `${shotBase}.png`;
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});

    // Detect Google's anti-bot wall (reCAPTCHA / "unusual traffic").
    const blocked = await page.evaluate(() => {
      const t = document.body?.innerText || "";
      return /unusual traffic|not a robot|verify once there are none|select all (images|squares)/i.test(t)
        || !!document.querySelector('iframe[src*="recaptcha"], iframe[title*="recaptcha" i]');
    }).catch(() => false);
    if (blocked) throw new Error(`Google anti-bot CAPTCHA/traffic block (needs human solve; screenshot: ${shot})`);

    const results = candidates.map((name) => ({ name, common: null, score: null }));
    if (!results.length) throw new Error(`no result text scraped (screenshot: ${shot})`);
    return { results, raw: { candidates, screenshot: shot } };
  } finally {
    await browser.close().catch(() => {});
  }
}
