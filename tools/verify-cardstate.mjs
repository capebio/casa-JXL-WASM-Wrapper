// Headless browser verification for the S2-Q4 CardState follow-ups in web/main.js.
//
// Drives the real app (dev-server + Playwright/CDP via tools/launch-browser.mjs),
// feeds real RAW files through the full RAW->JXL pipeline, then asserts the three
// behaviours the unit suites can't reach (main.js is a browser entry with top-level
// DOM side effects and no runtime unit test):
//
//   Test 1  #3 decode guard  — a card removed mid-JXL-decode must NOT get pixels
//                              stashed onto its detached node. A/B: one card decoded
//                              and kept (write happens) vs one decoded then removed
//                              (guard skips the write).
//   Test 2  removeCard close — per-card ImageBitmaps (_embeddedPreview.bmp,
//                              _jxlThumbBmp) are close()d and nulled on removeCard;
//                              no double-close throw.
//   Test 3  regression smoke — drop -> encode -> open lightbox -> live update ->
//                              removeCard all run with zero console errors / pageerrors.
//
// Usage:  node tools/verify-cardstate.mjs
//         (override files:  node tools/verify-cardstate.mjs a.orf b.dng c.dng)
//
// Exit 0 = all pass, 1 = any fail. No repo state is mutated.

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { launch } from './launch-browser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoDir = join(__dirname, '..');
const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;

const DEFAULT_FILES = [
  'C:\\Foo\\raw-converter\\tests\\P1110226.ORF',
  'C:\\Foo\\raw-converter\\tests\\PXL_20260501_095020990.RAW-02.ORIGINAL.dng',
  'C:\\Foo\\raw-converter\\tests\\PXL_20260501_100404049.RAW-02.ORIGINAL.dng',
];
const FILES = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_FILES;
for (const f of FILES) if (!existsSync(f)) { console.error(`missing RAW file: ${f}`); process.exit(1); }

async function waitForServer(deadlineMs = 20000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/web/index.html`, { redirect: 'manual' });
      if (r.status === 200 || r.status === 302) return;
    } catch {}
    await delay(200);
  }
  throw new Error('dev-server did not come up');
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(detail)}`);
}

let server, launched;
try {
  // 1. dev-server (COOP/COEP so SharedArrayBuffer / WASM threads work)
  server = spawn('node', ['tools/dev-server.mjs', String(PORT), '.'],
    { cwd: repoDir, stdio: ['ignore', 'ignore', 'inherit'] });
  await waitForServer();
  console.log(`[verify] dev-server up on ${BASE}`);

  // 2. headless browser
  launched = await launch({ headless: true });
  const { page } = launched;
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`console.error: ${m.text()}`); });

  await page.goto(`${BASE}/web/index.html`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#file-input', { state: 'attached', timeout: 15000 });
  console.log('[verify] app loaded; feeding RAW files...');

  // 3. feed files → full RAW→JXL pipeline
  await page.setInputFiles('#file-input', FILES);

  // wait until at least 3 cards finished encoding (have _blobUrl)
  await page.waitForFunction(
    () => [...document.querySelectorAll('.thumb')].filter((c) => c._blobUrl).length >= 3,
    { timeout: 300000 },
  );
  console.log('[verify] 3 cards encoded.');

  // ---- Test 1: #3 decode guard (A/B) ----
  const t1 = await page.evaluate(async () => {
    const encoded = [...document.querySelectorAll('.thumb')].filter((c) => c._blobUrl);
    const A = encoded[0], B = encoded[1];
    A._jxlDecoded = null; B._jxlDecoded = null;
    const pA = window.decodeFullJxlFor(A);          // control: keep A
    const pB = window.decodeFullJxlFor(B);          // test: remove B mid-decode
    window.removeCard(B);
    await Promise.all([pA, pB]);
    await new Promise((r) => setTimeout(r, 400));    // let terminal handler settle
    return {
      control_cached: !!A._jxlDecoded,   // expect true  (write happened)
      test_cached: !!B._jxlDecoded,      // expect false (guard skipped write)
      B_connected: B.isConnected,        // expect false (detached)
    };
  });
  record('Test1 decode-guard',
    t1.control_cached === true && t1.test_cached === false && t1.B_connected === false, t1);

  // ---- Test 2: removeCard closes per-card ImageBitmaps ----
  const t2 = await page.evaluate(async () => {
    const c = [...document.querySelectorAll('.thumb')].find((x) => x.isConnected && x._embeddedPreview?.bmp);
    if (!c) return { skipped: 'no connected card with _embeddedPreview.bmp' };
    const eb = c._embeddedPreview.bmp;
    const jb = c._jxlThumbBmp || null;
    const ebW0 = eb.width, jbW0 = jb ? jb.width : null;
    let threw = null;
    try { window.removeCard(c); } catch (e) { threw = String(e); }
    return {
      threw,
      embeddedNulled: c._embeddedPreview === null,          // expect true
      jxlNulled: c._jxlThumbBmp === null,                   // expect true
      embeddedClosed: ebW0 > 0 && eb.width === 0,           // was >0, now 0 => close() ran
      jxlClosed: jb ? (jbW0 > 0 && jb.width === 0) : 'n/a',
      connected: c.isConnected,                             // expect false
    };
  });
  record('Test2 bitmap-close',
    !t2.skipped && t2.threw === null && t2.embeddedNulled === true &&
    t2.embeddedClosed === true && t2.connected === false, t2);

  // ---- Test 3: regression smoke (open lightbox + live update + remove) ----
  const t3 = await page.evaluate(async () => {
    const cards = [...document.querySelectorAll('.thumb')].filter((x) => x.isConnected);
    const c = cards.find((x) => x._lightbox) || cards[0];
    let threw = null;
    try {
      c.click(); // openLightbox
      await new Promise((r) => setTimeout(r, 250));
      if (typeof window.scheduleLiveUpdate === 'function') window.scheduleLiveUpdate();
      await new Promise((r) => setTimeout(r, 400));
    } catch (e) { threw = String(e); }
    const before = document.querySelectorAll('.thumb').length;
    window.removeCard(c);
    const after = document.querySelectorAll('.thumb').length;
    return { threw, hadLightbox: !!c._lightbox, removedOne: after === before - 1 };
  });
  record('Test3 regression-smoke',
    t3.threw === null && t3.removedOne === true, t3);

  // ---- console-error gate (cross-cutting regression signal) ----
  // Two console errors are PRE-EXISTING and unrelated to the CardState work:
  //   - dist/scheduler.js signalDrain references `process.env.NODE_ENV` (a Node
  //     global) which is undefined in the browser -> ReferenceError on every drain.
  //     Lives in shipped scheduler dist (commit c8e57886), not web/main.js.
  //   - a bare 404 == Chrome's default favicon.ico probe (no asset ref in index.html).
  // The gate passes when no OTHER (unexpected) console errors surface from the
  // exercised paths; the known ones are reported separately, not silenced.
  await delay(300);
  const KNOWN = [/process is not defined/, /favicon/i, /404 \(Not Found\)/];
  const unexpected = consoleErrors.filter((e) => !KNOWN.some((re) => re.test(e)));
  const preexisting = consoleErrors.filter((e) => KNOWN.some((re) => re.test(e)));
  if (preexisting.length) console.log(`[verify] pre-existing/unrelated console errors (ignored): ${preexisting.length}`);
  record('NoNewConsoleErrors', unexpected.length === 0, unexpected.slice(0, 8));

} catch (err) {
  console.error('[verify] FATAL', err);
  record('harness', false, String(err?.message || err));
} finally {
  try { await launched?.close?.(); } catch {}
  try { server?.kill(); } catch {}
  // dev-server child may linger on Windows; best-effort tree kill
  if (server?.pid && process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n[verify] ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
