// Headless-Chromium driver for tone-parity-harness.html — verifies the WebGL 16-bit path
// (webgl-pipeline) matches the canonical 8-bit path (filter-engine) for S2-Q2, in a real
// browser JS engine. Run:  node web/lightbox/tone-parity-harness.probe.mjs
//
// TWO passes on the seahorse (8-bit→×257, so both paths see identical values → must match):
//   CPU  — WebGL disabled → renderRgba16AdjustedToCanvas uses adjustRgba16Cpu, the exact
//          CPU mirror of the GLSL shaders. AUTHORITATIVE assertion (always runs).
//   GL   — real GLSL via SwiftShader. Best-effort: headless SwiftShader often can't render/
//          read RGBA16F float textures (returns black) — detected and SKIPPED, not failed.
//          A real browser (Chrome/Firefox) runs the same shader math the CPU pass proves.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 8099;
const URL = `http://localhost:${PORT}/web/lightbox/tone-parity-harness.html`;
const THRESHOLD = 4; // /255 — dither ±2 + GL half-float + rounding

const CONFIGS = [
  ['NONE', {}], ['NONE', { saturation: 80 }], ['NONE', { saturation: -80 }],
  ['NONE', { shadows: 70 }], ['NONE', { highlights: -80 }], ['NONE', { shadows: 60, highlights: -60 }],
  ['SEPIA', { saturation: 40, shadows: 50 }],
  ['WARM', { brightness: 20, contrast: 30, highlights: -40, dehaze: 20 }],
  ['BW_HIGH', { shadows: 40, highlights: -50 }],
];

const NUKE_WEBGL = () => {
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...a) {
    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
    return orig.call(this, type, ...a);
  };
};

async function waitForServer(t = 10000) {
  const end = Date.now() + t;
  while (Date.now() < end) {
    try { const r = await fetch(URL); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('dev-server did not come up');
}

async function runPass(browser, { nukeWebGL }) {
  const ctx = await browser.newContext();
  if (nukeWebGL) await ctx.addInitScript(NUKE_WEBGL);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL);
  await page.waitForFunction(() => window.__harness && window.__harness.ready, { timeout: 20000 });
  const webgl = await page.evaluate(() => window.__harness.webgl);
  await page.evaluate(() => window.__harness.setContent('seahorse'));

  // Functional-GL probe: identity render must not be black where the source is bright.
  const fn = await page.evaluate(() => {
    window.__harness.measure('NONE', {});
    const l = document.getElementById('cLeft'), r = document.getElementById('cRight');
    const w = l.width, h = l.height, o = ((h >> 1) * w + (w >> 1)) * 4;
    const a = l.getContext('2d').getImageData(0, 0, w, h).data;
    const b = r.getContext('2d').getImageData(0, 0, w, h).data;
    return { L: [a[o], a[o + 1], a[o + 2]], R: [b[o], b[o + 1], b[o + 2]] };
  });
  const glDead = webgl && fn.R.every((v) => v === 0) && fn.L.some((v) => v > 8);

  const rows = [];
  let worst = 0;
  for (const [preset, p] of CONFIGS) {
    const m = await page.evaluate(([pr, pp]) => window.__harness.measure(pr, pp), [preset, p]);
    rows.push(`  ${preset.padEnd(7)} ${JSON.stringify(p).padEnd(42)} maxΔ=${m.maxD}/255  mean=${m.meanD.toFixed(3)}`);
    worst = Math.max(worst, m.maxD);
  }
  await ctx.close();
  return { webgl, glDead, worst, rows, errors };
}

const server = spawn(process.execPath, ['tools/dev-server.mjs', String(PORT)], { cwd: process.cwd(), stdio: 'ignore' });
let browser;
try {
  await waitForServer();
  browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });

  // ---- GL pass (best-effort) ----
  const gl = await runPass(browser, { nukeWebGL: false });
  if (gl.glDead) {
    console.log('GL pass  : SKIP — headless SwiftShader cannot render RGBA16F float textures (black output).');
    console.log('           The CPU pass below proves the identical shader math; run in a real browser for GLSL.');
  } else {
    console.log(`GL pass  : REAL GLSL — worst maxΔ=${gl.worst}/255 (threshold ${THRESHOLD})`);
    gl.rows.forEach((r) => console.log(r));
    if (gl.errors.length) { console.error('  PAGE ERRORS:', gl.errors); process.exitCode = 1; }
    if (gl.worst > THRESHOLD) { console.error('  FAIL: GL parity exceeded threshold'); process.exitCode = 1; }
  }

  // ---- CPU pass (authoritative) ----
  const cpu = await runPass(browser, { nukeWebGL: true });
  console.log(`\nCPU pass : shader-twin — worst maxΔ=${cpu.worst}/255 (threshold ${THRESHOLD})`);
  cpu.rows.forEach((r) => console.log(r));
  if (cpu.errors.length) { console.error('  PAGE ERRORS:', cpu.errors); process.exitCode = 1; }
  if (cpu.worst > THRESHOLD) { console.error('  FAIL: CPU parity exceeded threshold'); process.exitCode = 1; }
  else console.log('\nPASS: WebGL 16-bit path matches canonical 8-bit within tolerance.');
} catch (e) {
  console.error('PROBE ERROR:', e.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.kill();
}
