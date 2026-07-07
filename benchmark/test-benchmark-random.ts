import { chromium } from "playwright";

const BROWSER_PATH = String.raw`C:\Users\User\AppData\Local\ms-playwright\chromium_headless_shell-1217\chrome-headless-shell-win64\chrome-headless-shell.exe`;
const URL = "http://localhost:9000/web/jxl-benchmark.html";

const t0 = Date.now();
const mark = (msg: string) => console.log(`[+${String(Date.now() - t0).padStart(6, " ")}ms] ${msg}`);

const browser = await chromium.launch({
    executablePath: BROWSER_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

const ctx = await browser.newContext({
    // COOP/COEP require a "secure" context or same-origin; for localhost this is fine
});
const page = await ctx.newPage();

const consoleLogs: string[] = [];
const pageErrors: string[] = [];

page.on("console", msg => {
    const txt = `[${msg.type()}] ${msg.text()}`;
    consoleLogs.push(txt);
    mark(`CONSOLE: ${txt}`);
});
page.on("pageerror", err => {
    pageErrors.push(err.message);
    mark(`PAGE ERROR: ${err.message}`);
});
page.on("requestfailed", req => {
    mark(`REQUEST FAILED: ${req.url()} — ${req.failure()?.errorText}`);
});

mark("Navigating...");
await page.goto(URL, { waitUntil: "networkidle", timeout: 30_000 });
mark("Page loaded");

// Check initial state of button
const btnText = await page.locator("#load-random").textContent();
const btnDisabled = await page.locator("#load-random").isDisabled();
mark(`Random Gobabeb button: "${btnText?.trim()}" disabled=${btnDisabled}`);

// Check progress status before click
const progressBefore = await page.locator("#progress-status").textContent();
mark(`Progress before: "${progressBefore?.trim()}"`);

// Wait a moment for WASM to init
await page.waitForTimeout(3000);
mark("Waited 3s for WASM init");

// Check console for WASM init message
const wasmLog = consoleLogs.find(l => l.includes("WASM") || l.includes("wasm"));
mark(`WASM log found: ${wasmLog ?? "NONE"}`);

// Click Random Gobabeb
mark("Clicking Random Gobabeb...");
await page.locator("#load-random").click();

// Wait for loading to complete (button returns to "Random Gobabeb" or timeout)
try {
    await page.waitForFunction(
        () => {
            const btn = document.getElementById("load-random") as HTMLButtonElement;
            return btn && !btn.disabled && btn.textContent?.trim() === "Random Gobabeb";
        },
        { timeout: 60_000 }
    );
    mark("Loading finished (button re-enabled)");
} catch {
    mark("Timed out waiting for button re-enable");
}

// Check final state
const progressAfter = await page.locator("#progress-status").textContent();
const selectionAfter = await page.locator("#selection-status").textContent();
mark(`Progress after: "${progressAfter?.trim()}"`);
mark(`Selection after: "${selectionAfter?.trim()}"`);

// Check all console errors
const errors = consoleLogs.filter(l => l.startsWith("[error]"));
if (errors.length) {
    mark("CONSOLE ERRORS:");
    errors.forEach(e => mark(`  ${e}`));
}

if (pageErrors.length) {
    mark("PAGE ERRORS:");
    pageErrors.forEach(e => mark(`  ${e}`));
}

await browser.close();
mark("Done");
