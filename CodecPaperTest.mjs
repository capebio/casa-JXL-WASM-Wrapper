import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { fetchKodak } from "./scripts/fetch-kodak.mjs";
import { initCodecCompareJxl, loadTargetRgba, perceptualComparer, butteraugliDistance, makeJxlAdapter } from "./benchmark/codec-compare-jxl.mjs";
import { ADAPTERS } from "./benchmark/codec-adapters.mjs";
import { sweepQualityLadder } from "./benchmark/rd-sweep.mjs";
import { searchQuality } from "./benchmark/butteraugli-search.mjs";
import { bdRate } from "./benchmark/bd-rate.mjs";
import { buildPaperToon } from "./benchmark/codec-paper-serialize.mjs";
import { writeFigures } from "./benchmark/codec-paper-figures.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(scriptDir, "docs", "outputs", "codec-paper");
const N_TIME = 3;
const median = (a) => { const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
async function timeMs(fn){ const t=performance.now(); await fn(); return performance.now()-t; }
async function medMs(n, fn){ const o=[]; for(let i=0;i<n;i++) o.push(await timeMs(fn)); return median(o); }

// RAW standard files (reuse Part-1 resolution)
const TEST_ROOT = String.raw`C:\Foo\raw-converter\tests`, GOB_ROOT = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const RAW_FILES = [
  join(TEST_ROOT,"P1110226.ORF"), join(GOB_ROOT,"P2200474.ORF"),
  join(TEST_ROOT,"_MG_1750.CR2"), join(TEST_ROOT,"ADH 1248.CR2"),
  join(TEST_ROOT,"PXL_20260527_180319603.RAW-02.ORIGINAL.dng"), join(TEST_ROOT,"PXL_20260501_093507165.RAW-02.ORIGINAL.dng"),
].filter(existsSync);

async function loadCorpus(log) {
  const corpus = [];
  const kodak = await fetchKodak({ log });
  for (const p of kodak) {
    const { data, info } = await sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    corpus.push({ id: basename(p, ".png"), class: "standard", rgba: new Uint8Array(data), width: info.width, height: info.height });
  }
  for (const p of RAW_FILES) {
    const r = await loadTargetRgba(p);
    corpus.push({ id: r.file, class: "raw", rgba: r.rgba, width: r.tgtW, height: r.tgtH });
  }
  return corpus;
}

async function main() {
  const batchName = process.argv[2] || "general";
  const runTimestamp = new Date().toISOString();
  await initCodecCompareJxl();
  const jxl = makeJxlAdapter();
  const corpus = await loadCorpus(console.log);
  if (corpus.length === 0) throw new Error("Empty corpus (Kodak fetch failed + no RAW files)");
  console.log(`⚡ CodecPaper — ${corpus.length} images, ${ADAPTERS.length + 1} codecs`);

  const jxlShim = { key: "jxl", runtime: "wasm", encode: (rgba,w,h,q)=>jxl.encode(rgba,w,h,q), decode: (b)=>jxl.decode(b) };
  const allCodecs = [jxlShim, ...ADAPTERS];

  const sweep = [], fixed = [];
  for (const img of corpus) {
    const pc = perceptualComparer(img.rgba, img.width, img.height);
    const npx = img.width * img.height;
    const metrics = async (decoded) => ({ butteraugli: await butteraugliDistance(img.rgba, decoded.data, img.width, img.height), ssim: pc.ssim(decoded.data) });
    for (const c of allCodecs) {
      if (c.key === "png_native") { // lossless: single point
        const bytes = await c.encode(img.rgba, img.width, img.height);
        const m = await metrics(await c.decode(bytes));
        sweep.push({ image: img.id, class: img.class, codec: c.key, runtime: c.runtime, quality: 100, bytes: bytes.length, bpp: bytes.length*8/npx, butteraugli: m.butteraugli, ssim: m.ssim });
        continue;
      }
      // RD sweep (uses the tested pure module; encodes+decodes once per ladder point)
      const pts = await sweepQualityLadder(c, { rgba: img.rgba, width: img.width, height: img.height, npx, metrics });
      for (const p of pts) sweep.push({ image: img.id, class: img.class, ...p });
      // fixed point ~butteraugli 1.5
      const measure = async (q) => { const b = await c.encode(img.rgba,img.width,img.height,q); const d = await c.decode(b); return butteraugliDistance(img.rgba, d.data, img.width, img.height); };
      const sr = await searchQuality({ measure, target: 1.5, tol: 0.15, maxIters: 8 });
      const fb = await c.encode(img.rgba, img.width, img.height, sr.quality);
      const fm = await metrics(await c.decode(fb));
      const enc_ms = await medMs(N_TIME, () => c.encode(img.rgba, img.width, img.height, sr.quality));
      const dec_ms = await medMs(N_TIME, () => c.decode(fb));
      fixed.push({ image: img.id, class: img.class, codec: c.key, runtime: c.runtime, quality: sr.quality, butteraugli: fm.butteraugli, bytes: fb.length, bpp: fb.length*8/npx, enc_ms, dec_ms });
    }
    pc.free();
    console.log(`✓ ${img.id}`);
  }

  // BD-rate per codec vs jpeg_native, averaged over images
  const bdRates = {};
  const codecs = [...new Set(sweep.map(s=>s.codec))];
  for (const c of codecs) {
    if (c === "jpeg_native") { bdRates[c] = 0; continue; }
    const perImg = [];
    for (const img of corpus) {
      const ref = sweep.filter(s=>s.image===img.id && s.codec==="jpeg_native").map(s=>({bpp:s.bpp, butteraugli:s.butteraugli}));
      const tst = sweep.filter(s=>s.image===img.id && s.codec===c).map(s=>({bpp:s.bpp, butteraugli:s.butteraugli}));
      const bd = bdRate(ref, tst);
      if (bd != null) perImg.push(bd);
    }
    bdRates[c] = perImg.length ? perImg.reduce((a,b)=>a+b,0)/perImg.length : null;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const toon = buildPaperToon({ sweep, fixed, bdRates, batchName, runTimestamp });
  const stamp = runTimestamp.replace(/[:.]/g, "-");
  writeFileSync(join(OUT_DIR, `${stamp}-CodecPaper-${batchName}.toon`), toon);
  const { count } = writeFigures({ outDir: OUT_DIR, sweep, fixed, bdRates });
  console.log(`Wrote ${count} figures + figures.html + toon to ${OUT_DIR}`);
}

main().then(() => setTimeout(() => process.exit(0), 500)).catch(e => { console.error(e); process.exit(1); });
