#!/usr/bin/env node
// Visual colour-fidelity gallery: an HTML grid, columns = files, rows = pipeline
// stages (top → bottom): embedded camera JPEG (or placeholder) · our decode ·
// LibRaw decode · final JXL (our decode round-tripped through JXL). Filename +
// extension is captioned under the top cell of each column.
//
// Renders come from the real pipeline in headless Chromium (as in
// colour-verify-corpus.mjs); the JXL round-trip is @jsquash/jxl in node; PNGs via sharp.
//
// Usage: node tools/colour-corpus-gallery.mjs   (ONLY=<substr> / LIMIT=n to subset)

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, relative, normalize, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';
import jxlEncode, { init as jxlEncInit } from '@jsquash/jxl/encode.js';
import jxlDecode, { init as jxlDecInit } from '@jsquash/jxl/decode.js';

const REPO = normalize(join(fileURLToPath(import.meta.url), '..', '..'));
const TESTS = process.env.CORPUS_DIR || 'C:/Foo/raw-converter/tests';
const THUMB = 220;

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
  for (const n of EXPLICIT) { const p = join(TESTS, n); if (existsSync(p)) out.push(p); }
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
import initRaw, { process_orf_with_flags, process_cr2_with_flags, process_dng_with_flags, process_raw_mosaic_with_flags, initThreadPool } from '/web/pkg/raw_converter_wasm.js';
import { decodeWithLibRaw } from '/web/libraw-decode.js';
const THUMB = ${THUMB};
function rgbToThumb(rgb, w, h){
  const rgba = new Uint8ClampedArray(w*h*4);
  for (let i=0,j=0;i<rgb.length && j<rgba.length;i+=3,j+=4){ rgba[j]=rgb[i];rgba[j+1]=rgb[i+1];rgba[j+2]=rgb[i+2];rgba[j+3]=255; }
  const src = document.createElement('canvas'); src.width=w; src.height=h; src.getContext('2d').putImageData(new ImageData(rgba,w,h),0,0);
  const s=Math.min(1,THUMB/Math.max(w,h)); const tw=Math.max(1,Math.round(w*s)), th=Math.max(1,Math.round(h*s));
  const cv=document.createElement('canvas'); cv.width=tw; cv.height=th; const cx=cv.getContext('2d'); cx.drawImage(src,0,0,tw,th);
  const rgbaThumb = cx.getImageData(0,0,tw,th).data;
  let b=''; for(let i=0;i<rgbaThumb.length;i++) b+=String.fromCharCode(rgbaThumb[i]);
  return { png: cv.toDataURL('image/png'), rgbaB64: btoa(b), tw, th };
}
function fromRes(res){ const rgb=res.take_rgb(); const w=res.width,h=res.height; if(res.free) res.free(); return rgbToThumb(rgb,w,h); }
async function ourDecode(kind, bytes, name){
  if (kind==='orf') return fromRes(process_orf_with_flags(bytes, ${OUT_FULL_RGB8}, 0,0,0,0,0,0, 0,0, 0,0, NaN,NaN, 0,0));
  if (kind==='cr2') return fromRes(process_cr2_with_flags(bytes, ${OUT_FULL_RGB8}, 0,0,0,0,0,0, 0,0, 0,0, NaN,NaN, 0,0));
  if (kind==='dng') return fromRes(process_dng_with_flags(bytes, ${OUT_FULL_RGB8}, 0,0,0,0,0,0, 0,0, 0,0, NaN,NaN, 0,0));
  const p = await decodeWithLibRaw(bytes, name);
  return fromRes(process_raw_mosaic_with_flags(p.raw, p.width, p.height, p.cfaPhase, p.black, p.white, p.wbR, p.wbB, p.orientation, new Float32Array(p.colorMatrix||[]), ${OUT_FULL_RGB8}, 0,0,0,0,0,0, 0,0, 0,0, 0,0));
}
async function librawThumb(bytes){
  const LibRawClass = (await import('/web/vendor/libraw-wasm/index.js')).default;
  const raw = new LibRawClass();
  try {
    await raw.open(bytes, { outputBps:8, useCameraWb:true, outputColor:1, noAutoBright:true });
    const img = await raw.imageData(); const d = img && (img.data || img); const colors = img.colors||3;
    // pack to RGB
    const n = Math.floor(d.length/colors); const rgb = new Uint8Array(n*3);
    for (let i=0,j=0;i<n;i++,j+=3){ rgb[j]=d[i*colors]; rgb[j+1]=d[i*colors+1]; rgb[j+2]=d[i*colors+2]; }
    return rgbToThumb(rgb, img.width, img.height);
  } finally { if (raw.dispose) raw.dispose(); }
}
async function embeddedJpegB64(bytes){
  const LibRawClass = (await import('/web/vendor/libraw-wasm/index.js')).default;
  const raw = new LibRawClass();
  try {
    await raw.open(bytes, { useCameraWb:true });
    const t = await raw.thumbnailData(); const data = t && (t.data || (t.length? t : null));
    if (!data || !data.length) return null;
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const bmp = await createImageBitmap(new Blob([u8], { type:'image/jpeg' }));
    const s=Math.min(1,THUMB/Math.max(bmp.width,bmp.height)); const tw=Math.max(1,Math.round(bmp.width*s)), th=Math.max(1,Math.round(bmp.height*s));
    const cv=document.createElement('canvas'); cv.width=tw; cv.height=th; cv.getContext('2d').drawImage(bmp,0,0,tw,th);
    return cv.toDataURL('image/jpeg', 0.85);
  } finally { if (raw.dispose) raw.dispose(); }
}
window.__init = (async () => { await initRaw(); try { if (typeof initThreadPool==='function' && self.crossOriginIsolated) await Promise.race([initThreadPool(navigator.hardwareConcurrency), new Promise((_,rej)=>setTimeout(()=>rej(0),20000))]); } catch{} return 1; })();
window.__capture = async (path, kind, name) => {
  const out = { ours:null, lib:null, emb:null, ourRgbaB64:null, tw:0, th:0, err:null };
  const fetchBytes = async () => new Uint8Array((await (await fetch('/__img?p='+encodeURIComponent(path))).arrayBuffer()));
  try { const t = await ourDecode(kind, await fetchBytes(), name); out.ours=t.png; out.ourRgbaB64=t.rgbaB64; out.tw=t.tw; out.th=t.th; } catch(e){ out.err='ours:'+String(e&&(e.message||e)).slice(0,70); }
  try { out.lib = (await librawThumb(await fetchBytes())).png; } catch(e){ out.libErr = String(e&&(e.message||e)).slice(0,60); }
  try { out.emb = await embeddedJpegB64(await fetchBytes()); } catch(e){ out.embErr = String(e&&(e.message||e)).slice(0,60); }
  return out;
};
</script></body>`;

const startServer = () => new Promise((resolve) => {
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/') { res.writeHead(200, HEADERS('text/html')); res.end(PAGE); return; }
    if (u.pathname === '/__img') { try { const b = readFileSync(u.searchParams.get('p')); res.writeHead(200, HEADERS('application/octet-stream')); res.end(b); } catch (e) { res.writeHead(404, HEADERS('text/plain')); res.end(String(e)); } return; }
    const full = normalize(join(REPO, decodeURIComponent(u.pathname).replace(/^\/+/, '')));
    if (relative(REPO, full).startsWith('..')) { res.writeHead(403, HEADERS('text/plain')); res.end('no'); return; }
    try { const body = readFileSync(full); res.writeHead(200, HEADERS(MIME.get(extname(full).toLowerCase()) ?? 'application/octet-stream')); res.end(body); }
    catch { res.writeHead(404, HEADERS('text/plain')); res.end('404'); }
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

async function jxlRoundtripPng(rgbaB64, w, h) {
  try {
    const rgba = Uint8Array.from(Buffer.from(rgbaB64, 'base64'));
    const jxl = await jxlEncode({ data: new Uint8ClampedArray(rgba.buffer), width: w, height: h }, { quality: 90 });
    const img = await jxlDecode(jxl);
    const out = Buffer.from(img.data.buffer);
    const png = await sharp(out, { raw: { width: img.width, height: img.height, channels: 4 } }).png().toBuffer();
    return 'data:image/png;base64,' + png.toString('base64');
  } catch (e) { return { err: String(e && (e.message || e)).slice(0, 80) }; }
}

// @jsquash fetches its codec wasm by default (node fetch can't do file://) — provide it from fs.
try {
  const JQ = join(REPO, 'node_modules', '@jsquash', 'jxl', 'codec');
  await jxlEncInit(await WebAssembly.compile(readFileSync(join(JQ, 'enc', 'jxl_enc.wasm'))));
  await jxlDecInit(await WebAssembly.compile(readFileSync(join(JQ, 'dec', 'jxl_dec.wasm'))));
} catch (e) { console.warn('JXL init warning:', String(e.message || e).slice(0, 100)); }

let images = listImages();
if (process.env.ONLY) images = images.filter(p => p.toLowerCase().includes(process.env.ONLY.toLowerCase()));
if (process.env.LIMIT) images = images.slice(0, +process.env.LIMIT);
console.log(`gallery: ${images.length} images`);
const { server, port } = await startServer();
const browser = await chromium.launch({ headless: true, args: ['--enable-features=SharedArrayBuffer'] });
const rows = [];
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(150000);
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.evaluate(() => window.__init);
  for (const p of images) {
    const kind = kindOf(p), name = basename(p);
    process.stdout.write(`  ${name} ... `);
    let cap;
    try { cap = await page.evaluate(([pp, kk, nn]) => window.__capture(pp, kk, nn), [p, kind, name]); }
    catch (e) { cap = { err: 'evaluate:' + String(e).slice(0, 80) }; }
    let jxl = null;
    if (cap.ourRgbaB64) { const j = await jxlRoundtripPng(cap.ourRgbaB64, cap.tw, cap.th); jxl = typeof j === 'string' ? j : null; if (!jxl) cap.jxlErr = j && j.err; }
    rows.push({ name, kind, emb: cap.emb || null, ours: cap.ours || null, lib: cap.lib || null, jxl, err: cap.err || null });
    console.log(cap.err ? 'ERR ' + cap.err : `emb:${cap.emb ? 'y' : 'n'} ours:${cap.ours ? 'y' : 'n'} lib:${cap.lib ? 'y' : 'n'} jxl:${jxl ? 'y' : 'n'}`);
  }
} finally { await browser.close(); server.close(); }

const outDir = join(REPO, 'docs', 'outputs', 'corpus-colour-verify');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const cell = (src, ph) => src ? `<img src="${src}" loading="lazy">` : `<div class="ph">${ph}</div>`;
const STAGES = [['Embedded JPEG', 'emb'], ['Our decode', 'ours'], ['LibRaw decode', 'lib'], ['Final JXL', 'jxl']];
let html = `<!doctype html><meta charset=utf8><title>RAW corpus colour stages</title><style>
body{background:#222;color:#ddd;font:12px system-ui;margin:0;padding:12px}
h1{font-size:15px;font-weight:600}
.grid{display:grid;grid-auto-flow:column;grid-template-rows:auto repeat(4,auto);gap:4px;overflow-x:auto;padding-bottom:12px}
.rowlab{position:sticky;left:0;background:#222;writing-mode:horizontal-tb;font-weight:600;color:#9cf;display:flex;align-items:center;padding:0 8px;white-space:nowrap}
.cap{grid-row:1;font:11px monospace;color:#ffd479;padding:2px 4px;max-width:${THUMB}px;word-break:break-all;text-align:center}
img,.ph{width:${THUMB}px;height:auto;display:block;background:#111;border:1px solid #333}
.ph{height:${Math.round(THUMB * 0.66)}px;display:flex;align-items:center;justify-content:center;color:#666;font-style:italic}
</style><h1>RAW corpus — colour at each stage (embedded JPEG → our decode → LibRaw → JXL). ${rows.length} files, ${stamp}.</h1>
<div class="grid">`;
// left row-label column (rows 2..5); caption cell reserved on row 1 via empty
html += `<div class="cap"></div>`;
for (const [lab] of STAGES) html += `<div class="rowlab">${lab}</div>`;
for (const r of rows) {
  html += `<div class="cap">${r.name}</div>`;
  html += cell(r.emb, r.emb === null ? 'no embedded JPEG' : 'placeholder');
  html += cell(r.ours, r.err ? 'decode failed' : '—');
  html += cell(r.lib, 'n/a');
  html += cell(r.jxl, 'n/a');
}
html += `</div>`;
const outFile = join(outDir, `corpus-gallery-${stamp}.html`);
writeFileSync(outFile, html);
console.log(`\nGallery: ${outFile}`);
process.exit(0);
