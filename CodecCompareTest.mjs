import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initCodecCompareJxl, loadTargetRgba, perceptualComparer, makeJxlAdapter } from "./benchmark/codec-compare-jxl.mjs";
import { ADAPTERS } from "./benchmark/codec-adapters.mjs";
import { searchQuality } from "./benchmark/butteraugli-search.mjs";
import { buildCodecToon } from "./benchmark/codec-compare-serialize.mjs";

const N_ROUNDS = 5;
const TARGET = 1920;
const TOL = 0.15;
const MAX_ITERS = 8;
const median = (a) => { const s = [...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
async function timeMs(fn) { const t0 = performance.now(); const out = await fn(); return { ms: performance.now() - t0, out }; }
async function roundsOf(n, fn) { const out = []; for (let i = 0; i < n; i++) out.push((await timeMs(fn)).ms); return out; }

// verbatim from StandardMultifileTest.mjs:124-151
const TEST_ROOT = String.raw`C:\Foo\raw-converter\tests`;
const GOB_ROOT = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const TIMING_SOURCE = String.raw`.timing-source`;
const FILES_CONFIG = [
  { name: "small_file.jpg", paths: [join(TEST_ROOT, "small_file.jpg")] },
  { name: "P1110226 windows.jpg", paths: [join(TEST_ROOT, "P1110226 windows.jpg")] },
  { name: "PXL_20260527_180319603.RAW-02.ORIGINAL.dng", paths: [join(TEST_ROOT, "PXL_20260527_180319603.RAW-02.ORIGINAL.dng"), join(TIMING_SOURCE, "PXL_20260527_180319603.RAW-02.ORIGINAL.dng"), String.raw`C:\Foo\raw-converter-wasm\.timing-source\PXL_20260527_180319603.RAW-02.ORIGINAL.dng`] },
  { name: "PXL_20260501_093507165.RAW-02.ORIGINAL.dng", paths: [join(TEST_ROOT, "PXL_20260501_093507165.RAW-02.ORIGINAL.dng"), String.raw`C:\Foo\raw-converter-wasm\.timing-source\PXL_20260501_093507165.RAW-02.ORIGINAL.dng`] },
  { name: "P1110226.ORF", paths: [join(TEST_ROOT, "P1110226.ORF")] },
  { name: "P2200474.ORF", paths: [join(GOB_ROOT, "P2200474.ORF")] },
  { name: "_MG_1750.CR2", paths: [join(TEST_ROOT, "_MG_1750.CR2")] },
  { name: "ADH 1248.CR2", paths: [join(TEST_ROOT, "ADH 1248.CR2")] },
];
function resolveFile(cfg) { for (const p of cfg.paths) if (existsSync(p)) return p; return null; }

async function main() {
  const batchName = process.argv[2] || "general";
  const runTimestamp = new Date().toISOString();
  await initCodecCompareJxl();
  const FILES = FILES_CONFIG.map(c => ({ name: c.name, path: resolveFile(c) })).filter(f => f.path);
  if (FILES.length === 0) throw new Error("No standard files resolved — check TEST_ROOT paths");
  console.log(`⚡ CodecCompareTest — ${FILES.length} files, target butteraugli anchored to JXL@d1.0`);
  const jxl = makeJxlAdapter();
  const rows = [];

  for (const f of FILES) {
    const { rgba, tgtW, tgtH, file } = await loadTargetRgba(f.path);
    const pc = perceptualComparer(rgba, tgtW, tgtH);
    const npx = tgtW * tgtH;

    // Anchor: our JXL @ d1.0
    const jxlEnc = await jxl.encodeAnchor(rgba, tgtW, tgtH);
    const jxlDec = await jxl.decode(jxlEnc);
    const targetButter = pc.butteraugli(jxlDec.data);
    const jxlEncMs = median(await roundsOf(N_ROUNDS, () => jxl.encodeAnchor(rgba, tgtW, tgtH)));
    const jxlDecMs = median(await roundsOf(N_ROUNDS, () => jxl.decode(jxlEnc)));
    rows.push({ file, codec: "jxl", runtime: "wasm", quality: null, target_butter: targetButter,
      achieved_butter: targetButter, converged: true, ssim: pc.ssim(jxlDec.data),
      enc_ms: jxlEncMs, dec_ms: jxlDecMs, ttfp_ms: jxlDec.firstFrameMs, ttfp_kind: "progressive",
      bytes: jxlEnc.length, bpp: (jxlEnc.length * 8) / npx });

    for (const a of ADAPTERS) {
      if (a.lossless) {
        const bytes = await a.encode(rgba, tgtW, tgtH);
        const dec = await a.decode(bytes);
        const encMs = median(await roundsOf(N_ROUNDS, () => a.encode(rgba, tgtW, tgtH)));
        const decMs = median(await roundsOf(N_ROUNDS, () => a.decode(bytes)));
        rows.push({ file, codec: a.key, runtime: a.runtime, quality: null, target_butter: targetButter,
          achieved_butter: pc.butteraugli(dec.data), converged: true, ssim: pc.ssim(dec.data),
          enc_ms: encMs, dec_ms: decMs, ttfp_ms: decMs, ttfp_kind: "full",
          bytes: bytes.length, bpp: (bytes.length * 8) / npx });
        continue;
      }
      const measure = async (q) => { const b = await a.encode(rgba, tgtW, tgtH, q); const d = await a.decode(b); return pc.butteraugli(d.data); };
      const sr = await searchQuality({ measure, target: targetButter, tol: TOL, maxIters: MAX_ITERS });
      const bytes = await a.encode(rgba, tgtW, tgtH, sr.quality);
      const dec = await a.decode(bytes);
      const encMs = median(await roundsOf(N_ROUNDS, () => a.encode(rgba, tgtW, tgtH, sr.quality)));
      const decMs = median(await roundsOf(N_ROUNDS, () => a.decode(bytes)));
      if (!sr.converged) console.warn(`  [!] ${file} ${a.key}: not converged (target ${targetButter.toFixed(2)}, got ${sr.achieved.toFixed(2)} @q${sr.quality})`);
      rows.push({ file, codec: a.key, runtime: a.runtime, quality: sr.quality, target_butter: targetButter,
        achieved_butter: sr.achieved, converged: sr.converged, ssim: pc.ssim(dec.data),
        enc_ms: encMs, dec_ms: decMs, ttfp_ms: decMs, ttfp_kind: "full",
        bytes: bytes.length, bpp: (bytes.length * 8) / npx });
    }
    pc.free();
    console.log(`✓ ${file}`);
  }

  const toon = buildCodecToon({ rows, batchName, runTimestamp, target: TARGET });
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const OUT_DIR = join(scriptDir, "docs", "outputs", "timing tests");
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const stamp = runTimestamp.replace(/[:.]/g, "-");
  const outPath = join(OUT_DIR, `${stamp}-CodecCompare-${batchName}.toon`);
  writeFileSync(outPath, toon);
  console.log("Wrote", outPath);
}

main().then(() => setTimeout(() => process.exit(0), 500)).catch(e => { console.error(e); process.exit(1); });
