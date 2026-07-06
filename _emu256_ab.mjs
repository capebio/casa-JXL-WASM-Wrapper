// TEMP: EMU256 (relaxed-simd-mt, 8-lane) vs simd-mt (4-lane) A/B in headless Chrome.
// Measures encoder-output SHA (lane-width byte-exactness) + encode throughput.
// Dec-only modules hang in headless Chrome (pthread deadlock in _jxl_wasm_decode_rgba8);
// dec parity uses monolithic builds instead (the production decode path).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const SEC = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};
const MIME = { '.html': 'text/html', '.mjs': 'application/javascript', '.js': 'application/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };

function startServer() {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/__emu.html') {
      res.writeHead(200, { 'Content-Type': 'text/html', ...SEC });
      return res.end('<!doctype html><meta charset=utf-8><title>emu256</title><body>ready');
    }
    const fp = path.join(ROOT, u);
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404, SEC); return res.end('404');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', ...SEC });
    fs.createReadStream(fp).pipe(res);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

const { srv, port } = await startServer();
const BASE = `http://127.0.0.1:${port}/packages/jxl-wasm/dist/`;
const browser = await chromium.launch({ headless: true, args: ['--enable-features=SharedArrayBuffer'] });

async function freshPage() {
  const page = await browser.newPage();
  page.setDefaultTimeout(120_000);
  page.on('console', m => { if (/error|fail|abort/i.test(m.text())) process.stderr.write('  [page] ' + m.text() + '\n'); });
  page.on('pageerror', e => process.stderr.write('  [pageerror] ' + e.message + '\n'));
  await page.goto(`http://127.0.0.1:${port}/__emu.html`);
  const iso = await page.evaluate(() => self.crossOriginIsolated);
  if (!iso) throw new Error('not cross-origin isolated — SAB unavailable');
  return page;
}

async function loadMod(name, page) {
  const url = BASE + name + '.js';
  process.stderr.write(`[load] ${name}...\n`);
  await page.evaluate(async ({ url, base }) => {
    const { default: create } = await import(url);
    window.__mod = await create({ locateFile: p => base + p });
  }, { url, base: BASE });
  process.stderr.write(`[load] ${name} OK\n`);
}

// In-page enc bench: runs entirely in the browser, returns results directly.
const ENC_BENCH = async ({ base, encName, imgW, imgH, efforts }) => {
  const { default: create } = await import(base + encName + '.js');
  const mod = await create({ locateFile: p => base + p });

  const rgba = new Uint8Array(imgW * imgH * 4);
  for (let y = 0; y < imgH; y++) for (let x = 0; x < imgW; x++) {
    const i = (y * imgW + x) * 4;
    rgba[i] = (x * 255 / (imgW - 1)) | 0;
    rgba[i+1] = (y * 255 / (imgH - 1)) | 0;
    rgba[i+2] = (x + y) & 0xff;
    rgba[i+3] = 255;
  }

  const sha = async bytes => {
    const h = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2,'0')).join('').slice(0,16);
  };
  const enc = effort => {
    const p = mod._malloc(rgba.length); mod.HEAPU8.set(rgba, p);
    const buf = mod._jxl_wasm_encode_rgba8_x(p, imgW, imgH, 1.0, effort, 1, 0, 0, 0, 0, 0, 0, -1, 0, 0, 1);
    mod._free(p);
    const err = mod._jxl_wasm_buffer_error(buf);
    const sz = mod._jxl_wasm_buffer_size(buf), dp = mod._jxl_wasm_buffer_data(buf);
    const out = mod.HEAPU8.slice(dp, dp + sz); mod._jxl_wasm_buffer_free(buf);
    return { out, err };
  };
  const med = a => { const s = [...a].sort((x,y)=>x-y); return s[s.length>>1]; };

  const result = {};
  for (const e of efforts) {
    enc(e); enc(e); // warmup
    const ts = [];
    for (let i = 0; i < 7; i++) { const t = performance.now(); enc(e); ts.push(performance.now()-t); }
    const { out, err } = enc(e);
    result[e] = { sha: await sha(out), sz: out.length, err, medMs: +med(ts).toFixed(2) };
  }
  return result;
};

// Dec bench using monolithic build (production path). JS-side 20s timeout guard.
const DEC_BENCH = async ({ base, modName, jxlB64 }) => {
  const jxl = Uint8Array.from(atob(jxlB64), c => c.charCodeAt(0));
  const { default: create } = await import(base + modName + '.js');
  const mod = await create({ locateFile: p => base + p });

  const sha = async bytes => {
    const h = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2,'0')).join('').slice(0,16);
  };
  const dec = () => {
    const p = mod._malloc(jxl.length); mod.HEAPU8.set(jxl, p);
    const buf = mod._jxl_wasm_decode_rgba8(p, jxl.length, 0); mod._free(p);
    const err = mod._jxl_wasm_buffer_error(buf);
    const sz = mod._jxl_wasm_buffer_size(buf), dp = mod._jxl_wasm_buffer_data(buf);
    const px = mod.HEAPU8.slice(dp, dp + sz); mod._jxl_wasm_buffer_free(buf);
    return { px, err, sz };
  };
  const med = a => { const s = [...a].sort((x,y)=>x-y); return s[s.length>>1]; };

  // Single decode with 20s timeout guard to detect hangs
  const decWithTimeout = () => new Promise((res, rej) => {
    const id = setTimeout(() => rej(new Error('dec timeout — pthread deadlock?')), 20_000);
    try { const r = dec(); clearTimeout(id); res(r); } catch(e) { clearTimeout(id); rej(e); }
  });

  const probe = await decWithTimeout(); // detects hang before full bench
  dec(); dec(); // warmup
  const ts = [];
  for (let i = 0; i < 9; i++) { const t = performance.now(); dec(); ts.push(performance.now()-t); }
  const { px, err, sz } = dec();
  return { sha: await sha(px), sz, err, medMs: +med(ts).toFixed(2) };
};

try {
  process.stderr.write(`[emu256] server port=${port}\n`);

  // --- Enc: relaxed-simd-mt (8-lane HWY_WASM_EMU256) ---
  process.stderr.write('[enc] relaxed-simd-mt...\n');
  const pEncR = await freshPage();
  const encR = await pEncR.evaluate(ENC_BENCH, { base: BASE, encName: 'jxl-core.enc.relaxed-simd-mt', imgW: 512, imgH: 384, efforts: [3, 5, 7] });
  process.stderr.write('[enc] relaxed done\n');
  await pEncR.close();

  // --- Enc: simd-mt (4-lane) ---
  process.stderr.write('[enc] simd-mt...\n');
  const pEncS = await freshPage();
  const encS = await pEncS.evaluate(ENC_BENCH, { base: BASE, encName: 'jxl-core.enc.simd-mt', imgW: 512, imgH: 384, efforts: [3, 5, 7] });
  process.stderr.write('[enc] simd done\n');

  // Extract e3 JXL bytes via base64 (avoid Playwright large-array serialization issue)
  const jxlB64 = await pEncS.evaluate(async ({ base, imgW, imgH }) => {
    const { default: create } = await import(base + 'jxl-core.enc.simd-mt.js');
    const mod = await create({ locateFile: p => base + p });
    const rgba = new Uint8Array(imgW * imgH * 4);
    for (let y = 0; y < imgH; y++) for (let x = 0; x < imgW; x++) {
      const i = (y * imgW + x) * 4;
      rgba[i] = (x*255/(imgW-1))|0; rgba[i+1] = (y*255/(imgH-1))|0;
      rgba[i+2] = (x+y)&0xff; rgba[i+3] = 255;
    }
    const p = mod._malloc(rgba.length); mod.HEAPU8.set(rgba, p);
    const buf = mod._jxl_wasm_encode_rgba8_x(p, imgW, imgH, 1.0, 3, 1, 0, 0, 0, 0, 0, 0, -1, 0, 0, 1);
    mod._free(p);
    const sz = mod._jxl_wasm_buffer_size(buf), dp = mod._jxl_wasm_buffer_data(buf);
    const bytes = mod.HEAPU8.slice(dp, dp + sz); mod._jxl_wasm_buffer_free(buf);
    // base64 encode for safe transfer
    let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }, { base: BASE, imgW: 512, imgH: 384 });
  await pEncS.close();
  process.stderr.write(`[enc] JXL e3 size=${Math.round(atob(jxlB64).length/1024)}KB (base64 transfer OK)\n`);

  // --- Dec: monolithic relaxed-simd-mt (production build, not dec-only split) ---
  process.stderr.write('[dec] relaxed-simd-mt (monolithic)...\n');
  let decR = null;
  try {
    const pDecR = await freshPage();
    decR = await pDecR.evaluate(DEC_BENCH, { base: BASE, modName: 'jxl-core.relaxed-simd-mt', jxlB64 });
    process.stderr.write(`[dec] relaxed done sha=${decR.sha} ${decR.medMs}ms\n`);
    await pDecR.close();
  } catch(e) {
    process.stderr.write(`[dec] relaxed SKIP: ${e.message}\n`);
  }

  // --- Dec: monolithic simd-mt ---
  process.stderr.write('[dec] simd-mt (monolithic)...\n');
  let decS = null;
  try {
    const pDecS = await freshPage();
    decS = await pDecS.evaluate(DEC_BENCH, { base: BASE, modName: 'jxl-core.simd-mt', jxlB64 });
    process.stderr.write(`[dec] simd done sha=${decS.sha} ${decS.medMs}ms\n`);
    await pDecS.close();
  } catch(e) {
    process.stderr.write(`[dec] simd SKIP: ${e.message}\n`);
  }

  // --- Results ---
  const out = {
    encSha: {},
    encTime: {},
    decParity: decR && decS ? { relaxedSha: decR.sha, simdSha: decS.sha, same: decR.sha === decS.sha } : 'skipped',
    decTime: decR && decS ? { relaxedMed: decR.medMs, simdMed: decS.medMs, speedup: +(decS.medMs / decR.medMs).toFixed(3) } : 'skipped',
  };
  for (const e of [3, 5, 7]) {
    out.encSha[e] = { relaxed: encR[e].sha, simd: encS[e].sha, szR: encR[e].sz, szS: encS[e].sz, same: encR[e].sha === encS[e].sha };
  }
  for (const e of [3, 7]) {
    out.encTime[e] = { relaxedMed: encR[e].medMs, simdMed: encS[e].medMs, speedup: +(encS[e].medMs / encR[e].medMs).toFixed(3) };
  }

  console.log(JSON.stringify(out, null, 1));
} finally {
  await browser.close();
  srv.close();
}
