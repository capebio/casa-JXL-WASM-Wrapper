// Headless-browser probe: open the demo, click the picker, attach an ORF
// programmatically, log every console message, every uncaught error, every
// network failure, until processing completes or 60 s elapse.

import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ORF = process.env.TEST_ORF ?? String.raw`c:\995\2026-01-09 Birthday at Cederberg\P1100085.ORF`;
const URL_ = process.env.PROBE_URL ?? "http://localhost:8090/";
const CHROME = process.env.CHROME_PATH ?? String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const OUT_DIR = dirname(fileURLToPath(import.meta.url)); // screenshots beside the script
const TIMEOUT = Number(process.env.PROBE_TIMEOUT_MS ?? 60000);

const args = process.argv.slice(2).filter(a => !a.startsWith("-"));
const orfs = args.length > 0 ? args : [ORF];

// PR-1: preflight file existence check
for (const file of orfs) {
    if (!existsSync(file)) {
        console.error(`ORF not found: ${file} (set TEST_ORF or pass paths via args)`);
        process.exit(2);
    }
}

// PR-1: preflight server connection check
try {
    await fetch(URL_, { method: "HEAD" });
} catch {
    console.error(`No server at ${URL_} — start the demo server first (set PROBE_URL)`);
    process.exit(2);
}

// PR-1: flexible browser launch options
const launchOptions: any = { headless: true };
if (existsSync(CHROME)) {
    launchOptions.executablePath = CHROME;
} else {
    console.log(`[QOL] Chrome path not found: ${CHROME}. Falling back to Playwright-bundled Chromium.`);
}

const browser = await chromium.launch(launchOptions);
const start = Date.now();

try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // PR-2 & PR-5: timeline prefix and page errors tracking
    let pageErrors = 0;
    page.on("console", (m) => console.log(`[+${Date.now() - start}ms][${m.type()}]`, m.text()));
    page.on("pageerror", (e) => {
        pageErrors++;
        console.log(`[+${Date.now() - start}ms][pageerror]`, e.message);
    });
    page.on("requestfailed", (r) =>
        console.log(`[+${Date.now() - start}ms][netfail]`, r.url(), r.failure()?.errorText),
    );
    page.on("response", (r) => {
        if (r.status() >= 400) console.log(`[+${Date.now() - start}ms][http]`, r.status(), r.url());
    });

    // PR-4: worker lifecycle tracking and crash visibility
    page.on("worker", (w) => {
        console.log(`[+${Date.now() - start}ms][worker+]`, w.url());
        w.on("close", () => console.log(`[+${Date.now() - start}ms][worker-]`, w.url()));
    });
    page.on("crash", () => {
        console.log(`[+${Date.now() - start}ms][CRASH] page crashed`);
        process.exitCode = 1;
    });

    console.log(`[+${Date.now() - start}ms] --- navigating`);
    await page.goto(URL_, { waitUntil: "networkidle" });

    // PR-3: effective tier capability evaluation & warnings
    const env = await page.evaluate(() => ({
        crossOriginIsolated: (self as any).crossOriginIsolated === true,
        sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: (navigator as any).deviceMemory ?? null,
    }));
    console.log(`[+${Date.now() - start}ms] --- page environment:`, JSON.stringify(env));
    if (!env.crossOriginIsolated) {
        console.log(`[+${Date.now() - start}ms] [WARN] page is NOT cross-origin isolated — COOP/COEP headers missing; ` +
                    `WASM will fall back to single-threaded tier (simd). Fix the dev server headers.`);
    }

    console.log(`[+${Date.now() - start}ms] --- screenshot before interaction`);
    await page.screenshot({ path: join(OUT_DIR, "page-initial.png"), fullPage: true });
    const html = await page.content();
    console.log(`[+${Date.now() - start}ms] html length:`, html.length);
    console.log(`[+${Date.now() - start}ms] html head:`, html.slice(0, 300));

    console.log(`[+${Date.now() - start}ms] --- inspecting DOM`);
    const buttonText = await page.locator("#pick").textContent();
    console.log(`[+${Date.now() - start}ms] pick button text:`, buttonText);

    // PR-5: multi-file sequential processing
    for (let i = 0; i < orfs.length; i++) {
        const file = orfs[i]!;
        console.log(`[+${Date.now() - start}ms] --- setting file ${i + 1}/${orfs.length} via input.files: ${file}`);
        await page.locator("#file-input").setInputFiles(file);

        console.log(`[+${Date.now() - start}ms] --- waiting for thumb ${i + 1} (pipeline only)`);
        await page.waitForFunction((idx) => {
            const el = document.querySelectorAll(".thumb")[idx];
            return el && !el.classList.contains("busy");
        }, i, { timeout: TIMEOUT });
        console.log(`[+${Date.now() - start}ms] thumb ${i + 1} visible`);

        console.log(`[+${Date.now() - start}ms] --- waiting for JXL encode complete ${i + 1}`);
        await page.waitForFunction((idx) => {
            const el = document.querySelectorAll(".thumb")[idx];
            return el && !el.classList.contains("busy") && !el.classList.contains("encoding");
        }, i, { timeout: TIMEOUT });
        console.log(`[+${Date.now() - start}ms] JXL ${i + 1} done`);

        const meta = await page.evaluate((idx) => {
            const c = document.querySelectorAll(".thumb")[idx];
            return (c && '_meta' in c) ? (c as any)._meta : null;
        }, i);
        console.log(`[+${Date.now() - start}ms] meta ${i + 1}:`, meta);
    }

    await page.screenshot({ path: join(OUT_DIR, "page-after.png"), fullPage: true });
    console.log(`[+${Date.now() - start}ms] --- screenshot after`);

    // PR-2: set exit code if page errors occurred during happy path
    if (pageErrors > 0) {
        console.log(`[+${Date.now() - start}ms] --- ${pageErrors} pageerror(s) occurred during the run.`);
        process.exitCode = 1;
    }
} catch (err: any) {
    console.log(`[+${Date.now() - start}ms] --- TIMEOUT or FAILURE during probe:`, err.message || err);
    process.exitCode = 1;

    // screenshot failure state
    try {
        const page = (await browser.contexts()[0]?.pages())[0];
        if (page) {
            await page.screenshot({ path: join(OUT_DIR, "page-failure.png"), fullPage: true });
            console.log(`[+${Date.now() - start}ms] --- page-failure.png screenshot saved`);
            const thumbCount = await page.locator(".thumb").count();
            console.log(`[+${Date.now() - start}ms] thumbs in DOM:`, thumbCount);
            if (thumbCount > 0) {
                const cls = await page.locator(".thumb").first().getAttribute("class");
                const innerErr = await page.locator(".thumb").first().getAttribute("data-error");
                console.log(`[+${Date.now() - start}ms] first thumb class:`, cls, "error:", innerErr);
            }
        }
    } catch { /* ignore screenshot failure errors */ }
} finally {
    await browser.close();
}
