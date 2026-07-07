// Playwright repro for "lightbox sliders don't update live".
// Requires bun serve.ts already running on localhost:5174.

import { chromium } from "playwright";
import { writeFileSync, readFileSync } from "node:fs";

const ORF = String.raw`c:\995\2026-01-09 Birthday at Cederberg\P1110225.ORF`;
const PORT = process.env.PORT || "5174";
const HEADLESS = process.env.HEADFUL !== "1"; // HEADFUL=1 → visible window

console.log(`launching chromium (headless=${HEADLESS}, channel=chrome)`);
const browser = await chromium.launch({
    headless: HEADLESS,
    channel: 'chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
console.log('launched');
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await ctx.newPage();

page.on('console', (m) => {
    const t = m.type();
    const tx = m.text();
    if (t === 'error' || tx.startsWith('[live]') || tx.startsWith('[browser]')) {
        console.log(`[page-${t}] ${tx}`);
    }
});

await page.goto(`http://localhost:${PORT}/web/index.html`);
await page.waitForLoadState('domcontentloaded');
console.log('loaded');

// Surface key callbacks back to Node so we can see flow timing.
await page.exposeFunction('reportNode', (msg: string) => console.log('[browser]', msg));
await page.evaluate(() => {
    // @ts-ignore
    window._origPostMessage = Worker.prototype.postMessage;
    // @ts-ignore
    Worker.prototype.postMessage = function (data, transfer) {
        try {
            if (data && (data.type === 'reprocess_live' || data.type === 'reprocess_thumb_live')) {
                // @ts-ignore
                window.reportNode(`postMessage type=${data.type} id=${data.id ?? ''} keys=${Object.keys(data).join(',')}`);
            }
        } catch (e) {}
        // @ts-ignore
        return window._origPostMessage.call(this, data, transfer);
    };
});

await page.locator('#file-input').setInputFiles(ORF);
console.log('file dropped');

// Wait for full pipeline (JXL link visible)
await page.waitForSelector('a.download[href]:not([hidden])', { timeout: 240_000 });
console.log('jxl ready');

// Open lightbox
await page.locator('.thumb canvas').first().click();
await page.waitForSelector('#lightbox:not([hidden])', { timeout: 5000 });
console.log('lightbox open');

// Grab a 200x200 sample of the lightbox canvas before slider change.
const sample = async (label: string) => {
    const buf: number[] = await page.evaluate(() => {
        const c = document.getElementById('lightbox-canvas') as HTMLCanvasElement;
        const ctx = c.getContext('2d')!;
        const w = c.width, h = c.height;
        const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
        const sw = Math.min(200, w), sh = Math.min(200, h);
        const id = ctx.getImageData(cx - sw / 2 | 0, cy - sh / 2 | 0, sw, sh);
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < id.data.length; i += 4) {
            r += id.data[i]; g += id.data[i+1]; b += id.data[i+2];
        }
        const n = id.data.length / 4;
        return [w, h, r / n | 0, g / n | 0, b / n | 0, n];
    });
    console.log(`${label}: canvas=${buf[0]}x${buf[1]}  centre200 mean R=${buf[2]} G=${buf[3]} B=${buf[4]}`);
    return buf;
};

await sample('before slider');

// Move saturation slider to +100 via fireEvent (Playwright drag is slow; we
// want the same code path the user sees: 'input' event on the range).
console.log('setting saturation +100');
await page.evaluate(() => {
    const el = document.querySelector('input[data-look="saturation"]') as HTMLInputElement;
    el.value = '100';
    el.dispatchEvent(new Event('input', { bubbles: true }));
});

// 200 ms after slider change — should be past the 80ms debounce + pipeline.
await page.waitForTimeout(400);
await sample('after slider +100 (immediate)');
await page.waitForTimeout(800);
await sample('after slider +100 (1.2s)');

// Also probe the look-state by reading the slider back.
const sv = await page.evaluate(() => (document.querySelector('input[data-look="saturation"]') as HTMLInputElement).value);
console.log(`slider value after set: ${sv}`);

// Diagnostic: does the worker pool know about a taskId for this card?
const diag = await page.evaluate(() => {
    // @ts-ignore — pool/cards are file-scoped in main.js (ESM module).  Try to
    // pull them off any exported global; if not exposed, fall back to scraping
    // the DOM card element + dataset.
    const card = document.querySelector('.thumb') as any;
    if (!card) return 'no card';
    return JSON.stringify({
        hasTaskId: '_taskId' in card,
        taskId: card._taskId,
        showJpeg: card._showJpeg,
        hasLightbox: !!card._lightbox,
        lbW: card._lightbox?.w, lbH: card._lightbox?.h,
        hasEmbedded: !!card._embeddedPreview,
    });
});
console.log('card state: ' + diag);

await page.screenshot({ path: 'repro-after.png', fullPage: false });
console.log('screenshot → repro-after.png');

await browser.close();
process.exit(0);
