// Comprehensive UNATTENDED codec-paper run. Fault-tolerant (per-image + per-codec try/catch),
// checkpoints after every image, regenerates figures from whatever completed, copies to Jose.
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { fetchKodak } from "./scripts/fetch-kodak.mjs";
import { initCodecCompareJxl, loadTargetRgba, perceptualComparer, butteraugliDistance, makeJxlAdapter } from "./benchmark/codec-compare-jxl.mjs";
import { ADAPTERS, jxlOrigLossless, jxlOrigDecode } from "./benchmark/codec-adapters.mjs";
import { sweepQualityLadder } from "./benchmark/rd-sweep.mjs";
import { searchQuality } from "./benchmark/butteraugli-search.mjs";
import { bdRate } from "./benchmark/bd-rate.mjs";
import { writeFiguresFull, writeGalleryFull, bdMatrix, byFamily, avg } from "./benchmark/codec-paper-figures-full.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(scriptDir, "docs", "outputs", "codec-paper-full");
const JOSE = String.raw`C:\Foo\Jose\Submissions\JXL\Comparison with other formats\full`;
const TIMED_LADDER = [40, 60, 80];
const N_TIME = 2;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const timeMs = async (fn) => { const t = performance.now(); await fn(); return performance.now() - t; };
const medMs = async (n, fn) => { const o = []; for (let i = 0; i < n; i++) o.push(await timeMs(fn)); return median(o); };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const TEST_ROOT = String.raw`C:\Foo\raw-converter\tests`, GOB_ROOT = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const RAW_FILES = [
  join(TEST_ROOT, "P1110226.ORF"), join(GOB_ROOT, "P2200474.ORF"),
  join(TEST_ROOT, "_MG_1750.CR2"), join(TEST_ROOT, "ADH 1248.CR2"),
  join(TEST_ROOT, "PXL_20260527_180319603.RAW-02.ORIGINAL.dng"), join(TEST_ROOT, "PXL_20260501_093507165.RAW-02.ORIGINAL.dng"),
].filter(existsSync);

const CAPABILITY = [
  { format: "JPEG XL (ours & libjxl)", eightbit: "✓", sixteenbit: "✓ (+float)", alpha: "✓", progressive: "✓", lossless: "✓" },
  { format: "AVIF", eightbit: "✓", sixteenbit: "✓ (10/12-bit)", alpha: "✓", progressive: "—", lossless: "✓" },
  { format: "WebP", eightbit: "✓", sixteenbit: "—", alpha: "✓", progressive: "—", lossless: "✓" },
  { format: "JPEG", eightbit: "✓", sixteenbit: "—", alpha: "—", progressive: "✓", lossless: "rare" },
  { format: "PNG", eightbit: "✓", sixteenbit: "✓", alpha: "✓", progressive: "interlace", lossless: "✓" },
];

async function loadCorpus() {
  const corpus = [];
  let kodak = [];
  try { kodak = await fetchKodak({ log }); } catch (e) { log("Kodak fetch failed:", e.message); }
  for (const p of kodak) {
    try { const { data, info } = await sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); corpus.push({ id: basename(p, ".png"), class: "standard", rgba: new Uint8Array(data), width: info.width, height: info.height }); }
    catch (e) { log("skip", basename(p), e.message); }
  }
  for (const p of RAW_FILES) {
    try { const r = await loadTargetRgba(p); corpus.push({ id: r.file, class: "raw", rgba: r.rgba, width: r.tgtW, height: r.tgtH }); }
    catch (e) { log("skip RAW", basename(p), e.message); }
  }
  return corpus;
}

// True-lossless encoders. Each: { enc(rgba,w,h)->bytes, dec(bytes)->{data} } for verification.
// jxl uses reference libjxl (@jsquash lossless:true) — our facade has no true-lossless path (verified butteraugli 0.37).
const sharpRaw = (rgba, w, h) => sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width: w, height: h, channels: 4 } });
const sharpDecRgba = async (bytes) => { const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { data: new Uint8Array(data), width: info.width, height: info.height }; };
const LOSSLESS = {
  jxl:         { rt: "wasm",   enc: (r, w, h) => jxlOrigLossless(r, w, h),                                    dec: (b) => jxlOrigDecode(b) },
  webp_native: { rt: "native", enc: async (r, w, h) => new Uint8Array(await sharpRaw(r, w, h).webp({ lossless: true }).toBuffer()), dec: sharpDecRgba },
  avif_native: { rt: "native", enc: async (r, w, h) => new Uint8Array(await sharpRaw(r, w, h).avif({ lossless: true }).toBuffer()), dec: sharpDecRgba },
  png_native:  { rt: "native", enc: async (r, w, h) => new Uint8Array(await sharpRaw(r, w, h).png().toBuffer()),                     dec: sharpDecRgba },
};

function emitAndDeliver(data, corpus, runTimestamp) {
  const { sweep, timed, fixed, lossless } = data;
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    const { files } = writeFiguresFull({ outDir: OUT_DIR, sweep, timed, fixed, lossless, corpus });
    // per-file table at fixed point
    const perFile = corpus.map(img => {
      const j = fixed.filter(p => p.image === img.id && p.codec === "jxl");
      const jp = fixed.filter(p => p.image === img.id && p.codec === "jpeg_native");
      const all = fixed.filter(p => p.image === img.id);
      const best = all.length ? all.reduce((a, b) => a.bytes < b.bytes ? a : b).codec : null;
      const jkb = j.length ? Math.round(avg(j, x => x.bytes) / 1024) : null;
      const jpkb = jp.length ? Math.round(avg(jp, x => x.bytes) / 1024) : null;
      return { image: img.id, class: img.class, jxl_kb: jkb, jpeg_kb: jpkb, saving: (jkb != null && jpkb) ? (100 * (1 - jkb / jpkb)).toFixed(0) + "%" : null, jxl_enc: j.length ? Math.round(avg(j, x => x.enc_ms)) : null, jxl_dec: j.length ? Math.round(avg(j, x => x.dec_ms)) : null, best };
    });
    const baselines = ["jpeg_native", "webp_native", "avif_native"];
    const bdRows = bdMatrix(sweep, corpus, baselines, bdRate);
    const ours = fixed.filter(p => p.codec === "jxl"), orig = fixed.filter(p => p.codec === "jxl_orig");
    const pct = (a, b, k) => avg(a, r => r[k]) / avg(b, r => r[k]) * 100;
    const oursVsOrig = (ours.length && orig.length) ? { size: pct(ours, orig, "bytes"), encX: 100 / pct(ours, orig, "enc_ms"), decX: 100 / pct(ours, orig, "dec_ms") } : null;
    writeGalleryFull({ outDir: OUT_DIR, files, perFile, bdRows, baselines, oursVsOrig, capability: CAPABILITY, corpusInfo: `Corpus: ${corpus.filter(c => c.class === "standard").length} Kodak photographic + ${corpus.filter(c => c.class === "raw").length} RAW-derived (ORF/CR2/DNG @1920)` });
    // data toon (compact) + full JSON dump (enables regen + new metrics without re-running)
    const stamp = runTimestamp.replace(/[:.]/g, "-");
    writeFileSync(join(OUT_DIR, `${stamp}-CodecPaperFull-general.toon`), `TestName: CodecPaperFull - general\nRunTimestamp: ${runTimestamp}\nsweep_rows: ${sweep.length}\ntimed_rows: ${timed.length}\nfixed_rows: ${fixed.length}\nlossless_rows: ${lossless.length}\n`);
    writeFileSync(join(OUT_DIR, "data.json"), JSON.stringify({ runTimestamp, sweep, timed, fixed, lossless }));
    // deliver to Jose
    try {
      mkdirSync(join(JOSE, "figures"), { recursive: true });
      for (const f of files) copyFileSync(join(OUT_DIR, "figures", f), join(JOSE, "figures", f));
      copyFileSync(join(OUT_DIR, "figures.html"), join(JOSE, "figures.html"));
      log("delivered", files.length, "figures + gallery to", JOSE);
    } catch (e) { log("Jose copy failed:", e.message); }
    log("emitted figures:", files.length);
  } catch (e) { log("emit failed:", e.message, e.stack); }
}

async function main() {
  const runTimestamp = new Date().toISOString();
  await initCodecCompareJxl();
  const jxl = makeJxlAdapter();
  let corpus = await loadCorpus();
  const LIMIT = +process.env.LIMIT || 0;
  if (LIMIT) corpus = corpus.slice(0, LIMIT);
  if (!corpus.length) throw new Error("empty corpus");
  log(`START ${corpus.length} images, ${ADAPTERS.length + 1} codecs`);
  const jxlShim = { key: "jxl", runtime: "wasm", encode: (r, w, h, q) => jxl.encode(r, w, h, q), decode: (b) => jxl.decode(b) };
  const allCodecs = [jxlShim, ...ADAPTERS];
  const data = { sweep: [], timed: [], fixed: [], lossless: [] };

  for (let i = 0; i < corpus.length; i++) {
    const img = corpus[i];
    let pc;
    try { pc = perceptualComparer(img.rgba, img.width, img.height); } catch (e) { log("comparer fail", img.id, e.message); continue; }
    const npx = img.width * img.height;
    const metrics = async (d) => ({ butteraugli: await butteraugliDistance(img.rgba, d.data, img.width, img.height), ssim: pc.ssim(d.data), psnr: pc.psnr(d.data) });
    for (const c of allCodecs) {
      try {
        if (c.key === "png_native") {
          const b = await c.encode(img.rgba, img.width, img.height); const m = await metrics(await c.decode(b));
          data.sweep.push({ image: img.id, class: img.class, codec: c.key, runtime: c.runtime, quality: 100, bytes: b.length, bpp: b.length * 8 / npx, ...m });
        } else {
          const pts = await sweepQualityLadder(c, { rgba: img.rgba, width: img.width, height: img.height, npx, metrics });
          for (const p of pts) data.sweep.push({ image: img.id, class: img.class, ...p });
          // timed sweep (reduced ladder)
          for (const q of TIMED_LADDER) {
            const b = await c.encode(img.rgba, img.width, img.height, q); const d = await c.decode(b);
            const enc_ms = await medMs(N_TIME, () => c.encode(img.rgba, img.width, img.height, q));
            const dec_ms = await medMs(N_TIME, () => c.decode(b));
            data.timed.push({ image: img.id, class: img.class, codec: c.key, runtime: c.runtime, quality: q, butteraugli: await butteraugliDistance(img.rgba, d.data, img.width, img.height), bpp: b.length * 8 / npx, enc_ms, dec_ms });
          }
          // fixed point ~butteraugli 1.5
          const measure = async (q) => { const b = await c.encode(img.rgba, img.width, img.height, q); const d = await c.decode(b); return butteraugliDistance(img.rgba, d.data, img.width, img.height); };
          const sr = await searchQuality({ measure, target: 1.5, tol: 0.15, maxIters: 8 });
          const fb = await c.encode(img.rgba, img.width, img.height, sr.quality); const fd = await c.decode(fb); const fm = await metrics(fd);
          const enc_ms = await medMs(N_TIME, () => c.encode(img.rgba, img.width, img.height, sr.quality));
          const dec_ms = await medMs(N_TIME, () => c.decode(fb));
          const ttfp = (c.key === "jxl" && fd.firstFrameMs != null) ? fd.firstFrameMs : dec_ms;
          data.fixed.push({ image: img.id, class: img.class, codec: c.key, runtime: c.runtime, quality: sr.quality, butteraugli: fm.butteraugli, bytes: fb.length, bpp: fb.length * 8 / npx, enc_ms, dec_ms, ttfp_ms: ttfp });
        }
      } catch (e) { log("codec fail", img.id, c.key, e.message); }
    }
    // lossless pass (verified: only kept if decoded butteraugli < 0.05 = truly lossless)
    for (const [key, L] of Object.entries(LOSSLESS)) {
      try {
        const b = await L.enc(img.rgba, img.width, img.height);
        const d = await L.dec(b);
        const bt = await butteraugliDistance(img.rgba, d.data, img.width, img.height);
        if (bt > 0.05) { log("lossless verify FAIL", img.id, key, bt.toFixed(3)); continue; }
        const enc_ms = await medMs(N_TIME, () => L.enc(img.rgba, img.width, img.height));
        data.lossless.push({ image: img.id, class: img.class, codec: key, runtime: L.rt, bytes: b.length, bpp: b.length * 8 / npx, enc_ms });
      } catch (_) { /* lossless not supported / failed — skip */ }
    }
    try { pc.free(); } catch (_) {}
    log(`✓ ${i + 1}/${corpus.length} ${img.id}`);
    // CHECKPOINT: regenerate everything from what we have so far
    emitAndDeliver(data, corpus.slice(0, i + 1), runTimestamp);
  }
  log("DONE");
}

main().then(() => setTimeout(() => process.exit(0), 500)).catch(e => { console.error("FATAL", e); process.exit(1); });
