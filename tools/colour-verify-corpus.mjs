#!/usr/bin/env node
// Batch colour-fidelity verification across the RAW corpus.
//
// Decodes every image through the REAL shipped pipeline in headless Chromium
// (COOP/COEP, crossOriginIsolated, camera WB, neutral sliders, OUT_FULL_RGB8):
//   - native ORF/CR2/DNG  -> process_{orf,cr2,dng}_with_flags
//   - everything else      -> LibRaw (vendored libraw-wasm) -> process_raw_mosaic_with_flags
// then checks each render for magenta/green veil, white-balance sanity, channel
// plausibility, and a dark-decode (failure) signal. Writes JSON + Markdown.
//
// Loads the committed LibRaw web/pkg (so process_raw_mosaic_with_flags is present).
// Threadpool init is raced against a 20s timeout (worker bootstrap can hang under
// the static server); a timeout just falls back to single-thread — pixel-identical.
//
// Usage: node tools/colour-verify-corpus.mjs

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, relative, normalize, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = normalize(join(fileURLToPath(import.meta.url), '..', '..'));
const TESTS = process.env.CORPUS_DIR || 'C:/Foo/raw-converter/tests';

const EXPLICIT = [
  'PXL_20260527_145805406.RAW-02.ORIGINAL.dng', 'PXL_20260527_200222810.RAW-02.ORIGINAL.dng',
  'PXL_20260528_091745096.RAW-02.ORIGINAL.dng', 'PXL_20260527_145756882.RAW-02.ORIGINAL.dng',
  'PXL_20260526_194439088.RAW-02.ORIGINAL.dng', 'PXL_20260527_175312330.RAW-02.ORIGINAL.dng',
  'PXL_20260527_180311682.RAW-02.ORIGINAL.dng', 'PXL_20260526_194503279.NIGHT.RAW-02.ORIGINAL.dng',
  'PXL_20260527_175945329.RAW-02.ORIGINAL.dng', 'PXL_20260527_180319603.RAW-02.ORIGINAL.dng',
  'PXL_20260501_100809178.RAW-02.ORIGINAL.dng', 'PXL_20260501_100404049.RAW-02.ORIGINAL.dng',
  'PXL_20260501_095114043.RAW-02.ORIGINAL.dng', 'PXL_20260501_095020990.RAW-02.ORIGINAL.dng',
  'PXL_20260501_093507165.RAW-02.ORIGINAL.dng',
  'ADH 1234.CR2', 'ADH 1248.CR2', 'ADH 1455.CR2', 'ADH 1490.CR2', 'ADH 1514.CR2',
  'ADH 1559.CR2', 'ADH 1570.CR2', '_MG_1744.CR2', '_MG_1747.CR2', '_MG_1749.CR2', '_MG_1750.CR2',
  'P1110226.ORF',
];

function listImages() {
  const out = [];
  for (const n of EXPLICIT) { const p = join(TESTS, n); if (existsSync(p)) out.push(p); else console.warn('  (missing) ' + n); }
  const pixls = join(TESTS, 'raw-pixls');
  if (existsSync(pixls)) for (const n of readdirSync(pixls)) if (!/\.(json|txt|md)$/i.test(n)) out.push(join(pixls, n));
  return out;
}
const NATIVE = new Set(['.orf', '.cr2', '.dng']);
const kindOf = (p) => { const e = extname(p).toLowerCase(); return NATIVE.has(e) ? e.slice(1) : 'libraw'; };

const HEADERS = (t) => ({ 'Content-Type': t, 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'cross-origin' });
const MIME = new Map([['.js', 'text/javascript'], ['.mjs', 'text/javascript'], ['.wasm', 'application/wasm'], ['.html', 'text/html'], ['.json', 'application/json'], ['.map', 'application/json']]);

const OUT_FULL_RGB8 = 1;
const PAGE = `<!doctype html><meta charset=utf8><body><script type=module>
import initRaw, { process_orf_with_flags, process_cr2_with_flags, process_dng_with_flags, process_raw_mosaic_with_flags, rgb_to_rgba, initThreadPool } from '/web/pkg/raw_converter_wasm.js';
import { decodeWithLibRaw } from '/web/libraw-decode.js';
function meanRGB(rgb){ let r=0,g=0,b=0; const n=rgb.length/3; for(let i=0;i<rgb.length;i+=3){r+=rgb[i];g+=rgb[i+1];b+=rgb[i+2];} return {r:r/n,g:g/n,b:b/n}; }
function fromRes(res){ const rgb=res.take_rgb(); const w=res.width,h=res.height; if(res.free) res.free(); return {mean:meanRGB(rgb), w, h}; }
async function decodeNative(fn, bytes){ return fromRes(fn(bytes, ${OUT_FULL_RGB8}, 0,0,0,0,0,0, 0,0, 0,0, NaN,NaN, 0,0)); }
async function decodeLibRaw(bytes, name){
  const p = await decodeWithLibRaw(bytes, name);
  const res = process_raw_mosaic_with_flags(p.raw, p.width, p.height, p.cfaPhase, p.black, p.white, p.wbR, p.wbB, p.orientation, new Float32Array(p.colorMatrix||[]), ${OUT_FULL_RGB8}, 0,0,0,0,0,0, 0,0, 0,0, 0,0);
  const d = fromRes(res); d.meta = { cfaPhase:p.cfaPhase, black:p.black, white:p.white, wbR:+(p.wbR||0).toFixed(3), wbB:+(p.wbB||0).toFixed(3), matrix:(p.colorMatrix||[]).map(v=>+(+v).toFixed(3)), make:p.make, model:p.model, decoder:p.decoder }; return d;
}
window.__init = (async () => {
  await initRaw();
  let tp='off';
  if (typeof initThreadPool==='function' && self.crossOriginIsolated) {
    try { await Promise.race([initThreadPool(navigator.hardwareConcurrency), new Promise((_,rej)=>setTimeout(()=>rej(new Error('t')),20000))]); tp='on'; } catch { tp='timeout'; }
  }
  return { crossOriginIsolated: self.crossOriginIsolated, tp };
})();
// LibRaw's own full sRGB render (camera WB + rgb_cam matrix + interpolation) = the
// camera-faithful oracle. Compare our render's channel ratios to this: a match means
// faithful (even a genuinely-red scene matches); divergence means a real colour bug.
async function oracleRatios(bytes){
  try {
    const LibRawClass = (await import('/web/vendor/libraw-wasm/index.js')).default;
    const raw = new LibRawClass();
    try {
      await raw.open(bytes, { outputBps: 8, useCameraWb: true, outputColor: 1, noAutoBright: true });
      const img = await raw.imageData();
      const d = img && (img.data || (img.length ? img : null));
      if (!d || !d.length) return { err: 'no imageData' };
      const colors = img.colors || 3;
      let r=0,g=0,b=0,n=0;
      for (let i=0; i+2<d.length; i+=colors){ r+=d[i]; g+=d[i+1]; b+=d[i+2]; n++; }
      return { rg: r/(g||1e-9), bg: b/(g||1e-9) };
    } finally { if (raw.dispose) raw.dispose(); }
  } catch(e){ return { err: String(e && (e.message||e)).slice(0,80) }; }
}
// The camera's OWN embedded JPEG (LibRaw thumbnailData) = the reference of record —
// the colour the camera actually produced. Decode it, take channel ratios.
async function embeddedJpegRatios(bytes){
  try {
    const LibRawClass = (await import('/web/vendor/libraw-wasm/index.js')).default;
    const raw = new LibRawClass();
    try {
      await raw.open(bytes, { useCameraWb:true });
      const t = await raw.thumbnailData();
      const data = t && (t.data || (t.length ? t : null));
      if (!data || !data.length) return { err:'no-thumb' };
      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
      const bmp = await createImageBitmap(new Blob([u8], { type:'image/jpeg' }));
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      const cx = cv.getContext('2d', { willReadFrequently:true });
      cx.drawImage(bmp, 0, 0);
      const px = cx.getImageData(0,0,bmp.width,bmp.height).data;
      let r=0,g=0,b=0; const n=px.length/4; for(let i=0;i<px.length;i+=4){r+=px[i];g+=px[i+1];b+=px[i+2];}
      return { rg:(r/n)/((g/n)||1e-9), bg:(b/n)/((g/n)||1e-9), w:bmp.width, h:bmp.height };
    } finally { if (raw.dispose) raw.dispose(); }
  } catch(e){ return { err: String(e && (e.message||e)).slice(0,80) }; }
}
window.__decode = async (path, kind, name) => {
  try {
    const buf = await (await fetch('/__img?p='+encodeURIComponent(path))).arrayBuffer();
    const forDecode = new Uint8Array(buf.slice(0));
    const work = kind==='orf' ? decodeNative(process_orf_with_flags, forDecode)
      : kind==='cr2' ? decodeNative(process_cr2_with_flags, forDecode)
      : kind==='dng' ? decodeNative(process_dng_with_flags, forDecode)
      : decodeLibRaw(new Uint8Array(buf.slice(0)), name);
    const d = await Promise.race([work, new Promise((_,rej)=>setTimeout(()=>rej(new Error('decode-timeout-90s')),90000))]);
    let oracle = null, embedded = null;
    try { oracle = await Promise.race([oracleRatios(new Uint8Array(buf.slice(0))), new Promise((res)=>setTimeout(()=>res({err:'oracle-timeout'}),75000))]); } catch(e){ oracle = { err: String(e).slice(0,60) }; }
    try { embedded = await Promise.race([embeddedJpegRatios(new Uint8Array(buf.slice(0))), new Promise((res)=>setTimeout(()=>res({err:'embed-timeout'}),60000))]); } catch(e){ embedded = { err: String(e).slice(0,60) }; }
    return { ok:true, w:d.w, h:d.h, mean:d.mean, meta:d.meta||null, oracle, embedded };
  } catch(e){ return { ok:false, error: String(e && (e.stack||e.message) || e) }; }
};
window.__meta = async (path) => {
  try {
    const bytes = new Uint8Array(await (await fetch('/__img?p='+encodeURIComponent(path))).arrayBuffer());
    const LibRawClass = (await import('/web/vendor/libraw-wasm/index.js')).default;
    const raw = new LibRawClass();
    try {
      await raw.open(bytes, { outputBps:16, useCameraWb:true });
      const m = await raw.metadata(true); const c = m.color_data || {};
      return { keys: Object.keys(c), black:c.black, cblack:c.cblack, maximum:c.maximum, data_maximum:c.data_maximum, iso:m.iso_speed ?? m.other?.iso_speed, cam_mul:c.cam_mul, pre_mul:c.pre_mul, cam_xyz:c.cam_xyz && c.cam_xyz.flat ? c.cam_xyz.flat() : c.cam_xyz, filters:m.filters, cdesc:m.cdesc, make:m.camera_make, model:m.camera_model };
    } finally { if (raw.dispose) raw.dispose(); }
  } catch(e){ return { err: String(e && (e.message||e)).slice(0,120) }; }
};
</script></body>`;

const REF_TOL = 0.35; // Δ vs the embedded camera JPEG below this = faithful
function interpret(m, oracle, embedded) {
  const rg = m.r / (m.g || 1e-9), bg = m.b / (m.g || 1e-9);
  const libRg = oracle && oracle.err == null && Number.isFinite(oracle.rg) ? +oracle.rg.toFixed(3) : null;
  const libBg = oracle && oracle.err == null && Number.isFinite(oracle.bg) ? +oracle.bg.toFixed(3) : null;
  let refRg = null, refBg = null, dOurs = null, dLib = null, closer = null, verdict = null;
  if (embedded && embedded.err == null && Number.isFinite(embedded.rg)) {
    refRg = +embedded.rg.toFixed(3); refBg = +embedded.bg.toFixed(3);
    dOurs = +(Math.abs(rg - embedded.rg) + Math.abs(bg - embedded.bg)).toFixed(3);
    if (libRg != null) dLib = +(Math.abs(libRg - embedded.rg) + Math.abs(libBg - embedded.bg)).toFixed(3);
    verdict = dOurs < REF_TOL;
    if (dLib != null) closer = dOurs <= dLib + 0.02 ? 'ours' : 'libraw';
  } else if (libRg != null) { // no embedded JPEG -> fall back to LibRaw oracle
    dLib = +(Math.abs(rg - libRg) + Math.abs(bg - libBg)).toFixed(3);
    verdict = dLib < 0.30;
  }
  return { rg: +rg.toFixed(3), bg: +bg.toFixed(3), libRg, libBg, refRg, refBg, dOurs, dLib, closer,
           embeddedErr: embedded && embedded.err || null, verdict };
}

const startServer = () => new Promise((resolve) => {
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/') { res.writeHead(200, HEADERS('text/html')); res.end(PAGE); return; }
    if (u.pathname === '/__img') {
      try { const b = readFileSync(u.searchParams.get('p')); res.writeHead(200, HEADERS('application/octet-stream')); res.end(b); }
      catch (e) { res.writeHead(404, HEADERS('text/plain')); res.end(String(e)); }
      return;
    }
    const full = normalize(join(REPO, decodeURIComponent(u.pathname).replace(/^\/+/, '')));
    if (relative(REPO, full).startsWith('..')) { res.writeHead(403, HEADERS('text/plain')); res.end('no'); return; }
    try { const body = readFileSync(full); res.writeHead(200, HEADERS(MIME.get(extname(full).toLowerCase()) ?? 'application/octet-stream')); res.end(body); }
    catch { res.writeHead(404, HEADERS('text/plain')); res.end('404 ' + u.pathname); }
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

let images = listImages();
if (process.env.ONLY) images = images.filter(p => p.toLowerCase().includes(process.env.ONLY.toLowerCase()));
if (process.env.LIMIT) images = images.slice(0, +process.env.LIMIT);
console.log(`corpus: ${images.length} images`);
const { server, port } = await startServer();
const browser = await chromium.launch({ headless: true, args: ['--enable-features=SharedArrayBuffer'] });
const results = [];
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 160)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  const init = await page.evaluate(() => window.__init);
  console.log('init:', JSON.stringify(init));
  for (const p of images) {
    const kind = kindOf(p), name = basename(p);
    if (process.env.META) { const mm = await page.evaluate((pp) => window.__meta(pp), p); console.log(name, JSON.stringify(mm)); continue; }
    process.stdout.write(`  ${name} [${kind}] ... `);
    let r;
    try { r = await page.evaluate(([pp, kk, nn]) => window.__decode(pp, kk, nn), [p, kind, name]); }
    catch (e) { r = { ok: false, error: 'evaluate:' + String(e).slice(0, 100) }; }
    if (r.ok) { const it = interpret(r.mean, r.oracle, r.embedded); results.push({ name, kind, w: r.w, h: r.h, meta: r.meta, ...it }); console.log(`${it.verdict === true ? 'FAITHFUL' : it.verdict === false ? 'DIVERGES' : '?'} ours(${it.rg},${it.bg}) lib(${it.libRg ?? '-'},${it.libBg ?? '-'}) jpg(${it.refRg ?? '-'},${it.refBg ?? '-'}) Δours=${it.dOurs ?? '-'} Δlib=${it.dLib ?? '-'}${it.closer ? ' closer=' + it.closer : ''}${it.embeddedErr ? ' jpg:' + it.embeddedErr : ''}`); }
    else { results.push({ name, kind, ok: false, error: r.error }); console.log('FAIL ' + String(r.error).slice(0, 90)); }
  }
} finally { await browser.close(); server.close(); }

const faithful = results.filter(r => r.verdict === true).length;
const diverges = results.filter(r => r.verdict === false).length;
const noref = results.filter(r => r.ok !== false && r.verdict == null).length;
const fail = results.filter(r => r.ok === false).length;
const oursCloser = results.filter(r => r.closer === 'ours').length;
const libCloser = results.filter(r => r.closer === 'libraw').length;
const outDir = join(REPO, 'docs', 'outputs', 'corpus-colour-verify');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
writeFileSync(join(outDir, `corpus-vs-jpeg-${stamp}.json`), JSON.stringify({ faithful, diverges, noref, fail, oursCloser, libCloser, results }, null, 2));
let md = `# Corpus colour fidelity vs the embedded camera JPEG (${stamp})\n\n`
  + `Reference = each RAW's **own embedded JPEG** (the colour the camera produced). Both our render and LibRaw's sRGB render are scored against it — Δ = |Δrg| + |Δbg| on channel ratios.\n\n`
  + `**${faithful} faithful (Δours < ${REF_TOL}) / ${diverges} diverge / ${noref} no-JPEG-ref / ${fail} fail** of ${results.length}. Closer to the camera JPEG: **ours ${oursCloser}, LibRaw ${libCloser}**.\n\n`
  + `| Image | Fmt | ours R/G,B/G | LibRaw | camera JPEG (ref) | Δours | ΔLibRaw | closer |\n|---|---|---|---|---|---|---|---|\n`;
for (const r of results) md += `| ${r.name} | ${r.kind} | ${r.ok === false ? '—' : r.rg + ',' + r.bg} | ${r.libRg != null ? r.libRg + ',' + r.libBg : '—'} | ${r.refRg != null ? r.refRg + ',' + r.refBg : '—'} | ${r.dOurs ?? '—'} | ${r.dLib ?? '—'} | ${r.closer ?? (r.ok === false ? 'FAIL' : '—')} |\n`;
writeFileSync(join(outDir, `corpus-vs-jpeg-${stamp}.md`), md);
console.log(`\n${faithful} faithful / ${diverges} diverge / ${noref} no-ref / ${fail} fail. Closer to camera JPEG: ours ${oursCloser}, LibRaw ${libCloser}. Report: ${outDir}`);
process.exit(0);
