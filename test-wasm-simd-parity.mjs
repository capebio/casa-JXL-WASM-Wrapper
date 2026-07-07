// test-wasm-simd-parity.mjs — S4-D2 WASM simd128 parity oracle
//
// Asserts that each perceptual v128 (simd128) kernel in raw-pipeline agrees with
// its independent SCALAR reference, using the wasm-bindgen exports added in
// `src/lib.rs::perceptual_parity_ffi` (forwarding `raw_pipeline::perceptual::parity`).
//
// Two builds are compared:
//   pkg-simd   : built with RUSTFLAGS="-C target-feature=+simd128"  (v128 kernels active)
//   pkg-scalar : built with RUSTFLAGS="-C target-feature=-simd128"  (true scalar, no autovec)
//
// PRIMARY assertion (full two-build fidelity): pkgSimd.*_simd  vs  pkgScalar.*_scalar
// FALLBACK (single build, pkg-simd only): pkgSimd.*_simd  vs  pkgSimd.*_scalar
//
// Integer kernels (ssd, ssim_moments) and pure per-pixel maps (box_blur, xyb) are
// expected BYTE-EXACT. Reduction kernels (scale_err) and the box-downsample
// (add-association) are float-order-sensitive and are checked against a documented
// tolerance rather than bit equality.
//
// Exit 0 = all kernels within their contract; exit 1 = any violation.
// Run: node test-wasm-simd-parity.mjs

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- deterministic input generators (LCG, mirrors the native parity tests) ----
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}
function f32Field(n, seed) {
  const rng = lcg(seed);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = (rng() >>> 8) / 16777216; // [0,1)
  return a;
}
function f32Mask(n, seed) {
  const rng = lcg(seed);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = (rng() >>> 8) / 33554432; // [0,0.5)
  return a;
}
function u8Field(n, seed) {
  const rng = lcg(seed);
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = rng() & 0xff;
  return a;
}
function u8Perturbed(base, seed) {
  const rng = lcg(seed);
  const a = base.slice();
  for (let i = 0; i < a.length; i++) {
    const d = (rng() % 9) - 4; // small +/-4 delta -> nonzero, modest SSD
    a[i] = Math.max(0, Math.min(255, a[i] + d));
  }
  return a;
}

// ---- load a wasm-pack --target web build under Node ----
async function loadBuild(dir) {
  const jsPath = join(dir, 'raw_converter_wasm.js');
  const wasmPath = join(dir, 'raw_converter_wasm_bg.wasm');
  if (!existsSync(jsPath) || !existsSync(wasmPath)) return null;
  const mod = await import('file://' + jsPath.replace(/\\/g, '/'));
  const bytes = readFileSync(wasmPath);
  const init = mod.default;
  try {
    await init({ module_or_path: bytes });
  } catch {
    await init(bytes); // older wasm-bindgen glue
  }
  return mod;
}

// ---- diff helpers ----
function f32bits(f) {
  const b = new ArrayBuffer(4);
  new Float32Array(b)[0] = f;
  return new Uint32Array(b)[0];
}
function diffStats(a, b) {
  if (a.length !== b.length) {
    return { len: -1, mismatchBits: a.length, maxAbs: Infinity, maxRel: Infinity, lenA: a.length, lenB: b.length };
  }
  let mismatchBits = 0, maxAbs = 0, maxRel = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i], bv = b[i];
    if (f32bits(av) !== f32bits(bv)) mismatchBits++;
    const abs = Math.abs(av - bv);
    if (abs > maxAbs) maxAbs = abs;
    const denom = Math.max(Math.abs(av), Math.abs(bv), 1e-30);
    const rel = abs / denom;
    if (rel > maxRel) maxRel = rel;
  }
  return { len: a.length, mismatchBits, maxAbs, maxRel };
}
function scalarDiff(a, b) {
  const abs = Math.abs(a - b);
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-30);
  return { maxAbs: abs, maxRel: abs / denom, mismatchBits: (a === b ? 0 : 1), len: 1 };
}

// ---- kernel definitions ----
// mode: 'exact'  -> require 0 bit mismatches
//       'float'  -> allow tiny reassociation diff up to tol (abs OR rel)
function makeKernels(m) {
  const N_XYB = 50000;
  const pxXyb = u8Field(N_XYB * 4, 0xA1);

  const N_SSD = 256 * 256 * 4;
  const ssdA = u8Field(N_SSD, 0xB2);
  const ssdB = u8Perturbed(ssdA, 0xC3);

  const NP_SSIM = 65536;
  const ssimA = u8Field(NP_SSIM * 4, 0xD4);
  const ssimB = u8Perturbed(ssimA, 0xE5);

  const BB_W = 259, BB_H = 193, BB_R = 4;
  const bbSrc = f32Field(BB_W * BB_H, 0xF6);

  const SE_N = 20000;
  const se = {
    mask: f32Mask(SE_N, 0x11), rx: f32Field(SE_N, 0x22), ry: f32Field(SE_N, 0x33),
    rb: f32Field(SE_N, 0x44), tx: f32Field(SE_N, 0x55), ty: f32Field(SE_N, 0x66),
    tb: f32Field(SE_N, 0x77), kx: 24.0, ky: 12.0, kb: 4.0,
  };

  // downsample: one even-dim case and one odd-dim (exercises clamp tail)
  const dsCases = [
    { w: 258, h: 194 },
    { w: 257, h: 195 },
  ].map((c, i) => ({
    ...c, dw: (c.w >> 1) || 1, dh: (c.h >> 1) || 1,
    src: f32Field(c.w * c.h, 0x800 + i),
  }));

  return [
    {
      name: 'box_blur', mode: 'exact', kind: 'per-pixel map (v128 V-pass, shared scalar H)',
      simd: (M) => M.perc_box_blur_simd(bbSrc, BB_W, BB_H, BB_R),
      scalar: (M) => M.perc_box_blur_scalar(bbSrc, BB_W, BB_H, BB_R),
      cmp: diffStats, note: `${BB_W}x${BB_H} r=${BB_R}`,
    },
    {
      name: 'pixels_to_xyb', mode: 'exact', kind: 'per-pixel LUT map',
      simd: (M) => M.perc_xyb_simd(pxXyb, N_XYB),
      scalar: (M) => M.perc_xyb_scalar(pxXyb, N_XYB),
      cmp: diffStats, note: `n=${N_XYB}`,
    },
    {
      name: 'ssd (psnr)', mode: 'exact', kind: 'integer sum-of-squares',
      simd: (M) => M.perc_ssd_simd(ssdA, ssdB),
      scalar: (M) => M.perc_ssd_scalar(ssdA, ssdB),
      cmp: (a, b) => scalarDiff(a, b), scalar_is_number: true, note: `len=${N_SSD}`,
    },
    {
      name: 'ssim_moments', mode: 'exact', kind: 'integer moments (9 sums)',
      simd: (M) => M.perc_ssim_moments_simd(ssimA, ssimB, NP_SSIM),
      scalar: (M) => M.perc_ssim_moments_scalar(ssimA, ssimB, NP_SSIM),
      cmp: (a, b) => {
        // Float64 sums that hold integers exactly; require exact equality.
        let mism = 0, maxAbs = 0;
        for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d !== 0) mism++; if (d > maxAbs) maxAbs = d; }
        return { len: a.length, mismatchBits: mism, maxAbs, maxRel: maxAbs === 0 ? 0 : maxAbs / Math.max(...a.map(Math.abs), 1) };
      }, note: `np=${NP_SSIM}`,
    },
    {
      name: 'scale_err', mode: 'float', tol: 1e-4, kind: 'p=3 norm reduction (lane-parallel f64 drain)',
      simd: (M) => M.perc_scale_err_simd(se.mask, se.rx, se.ry, se.rb, se.tx, se.ty, se.tb, SE_N, se.kx, se.ky, se.kb),
      scalar: (M) => M.perc_scale_err_scalar(se.mask, se.rx, se.ry, se.rb, se.tx, se.ty, se.tb, SE_N, se.kx, se.ky, se.kb),
      cmp: (a, b) => scalarDiff(a, b), scalar_is_number: true, note: `n=${SE_N}`,
    },
    ...dsCases.map((c, i) => ({
      name: `downsample[${c.w}x${c.h}]`, mode: 'float', tol: 1e-4, kind: '2x box (add-association)',
      simd: (M) => M.perc_downsample_simd(c.src, c.w, c.h, c.dw, c.dh),
      scalar: (M) => M.perc_downsample_scalar(c.src, c.w, c.h, c.dw, c.dh),
      cmp: diffStats, note: `-> ${c.dw}x${c.dh}`,
    })),
  ];
}

// ---- main ----
const pkgSimd = await loadBuild(join(HERE, 'pkg-simd'));
if (!pkgSimd) {
  console.error('FATAL: pkg-simd build not found. Build it first:');
  console.error('  $env:RUSTFLAGS="-C target-feature=+simd128"; wasm-pack build --target web --out-dir pkg-simd --release');
  process.exit(2);
}
const pkgScalar = await loadBuild(join(HERE, 'pkg-scalar'));

const twoBuild = !!pkgScalar;
console.log(`[parity] pkg-simd loaded${twoBuild ? ' + pkg-scalar loaded (two-build cross-check)' : ' (single-build A/B only; pkg-scalar absent)'}`);
console.log(`[parity] simd128 build is source of the v128 (*_simd) path; ${twoBuild ? 'scalar reference from -simd128 build (*_scalar)' : 'scalar reference from same +simd128 build (*_scalar)'}\n`);

const kernels = makeKernels();
const rows = [];
let failures = 0;

for (const k of kernels) {
  let stats, refLabel;
  try {
    const simdOut = k.simd(pkgSimd);
    const scalarOut = twoBuild ? k.scalar(pkgScalar) : k.scalar(pkgSimd);
    refLabel = twoBuild ? 'pkg-scalar(-simd128)' : 'pkg-simd(scalar arm)';
    stats = k.cmp(simdOut, scalarOut);
  } catch (e) {
    rows.push({ name: k.name, verdict: 'ERROR', detail: String(e).slice(0, 120), mode: k.mode, kind: k.kind, note: k.note });
    failures++;
    console.error(`  ${k.name}: ERROR ${e}`);
    continue;
  }

  let verdict, ok;
  if (k.mode === 'exact') {
    ok = stats.mismatchBits === 0 && Number.isFinite(stats.maxAbs);
    verdict = ok ? 'BYTE-EXACT' : 'FAIL';
  } else {
    ok = Number.isFinite(stats.maxAbs) && (stats.maxAbs <= k.tol || stats.maxRel <= k.tol);
    verdict = ok ? 'FLOAT-ORDER-OK' : 'FAIL';
  }
  if (!ok) failures++;

  const detail = k.scalar_is_number
    ? `maxAbs=${stats.maxAbs.toExponential(3)} maxRel=${stats.maxRel.toExponential(3)}`
    : `elems=${stats.len} bitMismatch=${stats.mismatchBits} maxAbs=${stats.maxAbs.toExponential(3)} maxRel=${stats.maxRel.toExponential(3)}`;
  rows.push({ name: k.name, verdict, detail, mode: k.mode, kind: k.kind, note: k.note, refLabel });
  console.log(`  ${k.name.padEnd(20)} ${verdict.padEnd(15)} ${detail}`);
}

console.log('');
console.log(`[parity] ${rows.filter(r => r.verdict === 'BYTE-EXACT').length} byte-exact, ` +
  `${rows.filter(r => r.verdict === 'FLOAT-ORDER-OK').length} float-order-ok, ` +
  `${failures} failing`);

// ---- write markdown results (only when run to completion) ----
const now = new Date().toISOString();
const md = [];
md.push('# S4-D2 — WASM simd128 Parity Oracle: Results');
md.push('');
md.push(`Generated: ${now}`);
md.push('');
md.push(`Comparison mode: **${twoBuild ? 'two-build (pkg-simd +simd128 vs pkg-scalar -simd128)' : 'single-build A/B (pkg-simd only)'}**`);
md.push('');
md.push('| Kernel | Verdict | Diff | Contract | Input |');
md.push('|--------|---------|------|----------|-------|');
for (const r of rows) {
  md.push(`| \`${r.name}\` | ${r.verdict} | ${r.detail || ''} | ${r.kind} | ${r.note || ''} |`);
}
md.push('');
md.push('## Verdict legend');
md.push('- **BYTE-EXACT**: every output bit-identical between the v128 kernel and the scalar oracle. Expected for the integer kernels (`ssd`, `ssim_moments`) and the pure per-pixel maps (`box_blur`, `pixels_to_xyb`).');
md.push('- **FLOAT-ORDER-OK**: results differ only by IEEE-754 reassociation, within tolerance (1e-4 abs/rel). This is expected and correct for the reduction / add-association kernels:');
md.push('  - `scale_err`: the v128 path accumulates four f32 lanes in parallel and drains to f64 periodically, whereas the scalar oracle sums sequentially in f64 — a different (equally valid) summation order for the p=3 norm.');
md.push('  - `downsample`: the v128 path forms `(a+b)+(c+d)` per 2x2 box; the scalar oracle forms `((a+b)+c)+d`. Pure f32 add-association (matches the in-crate note "maxdiff 5.96e-8").');
md.push('- **FAIL**: a byte-exact kernel diverged, or a float-order kernel exceeded tolerance — a real regression.');
md.push('');
md.push('## Coverage');
md.push('All five perceptual kernels that have a wasm32 v128 (simd128) path are covered:');
md.push('`box_blur` (mask blur), `pixels_to_xyb`, `ssd` (PSNR), `ssim_moments` (SSIM), `scale_err` (butteraugli),');
md.push('plus `downsample` (2× box, tested at even and odd dimensions to exercise the clamp tail).');
md.push('Each is exercised via thin `#[wasm_bindgen]` forwarders (`perc_*_simd` / `perc_*_scalar`) over');
md.push('`raw_pipeline::perceptual::parity`, added for this oracle. No SIMD implementation was modified.');
md.push('');
md.push('## Reproduce');
md.push('```powershell');
md.push('# from the worktree root');
md.push('$env:RUSTFLAGS="-C target-feature=+simd128"; wasm-pack build --target web --out-dir pkg-simd   --release');
md.push('$env:RUSTFLAGS="-C target-feature=-simd128"; wasm-pack build --target web --out-dir pkg-scalar --release');
md.push('$env:RUSTFLAGS=""');
md.push('node test-wasm-simd-parity.mjs   # exit 0 = all kernels within contract');
md.push('```');
md.push('If only `pkg-simd` is present the harness falls back to a single-build A/B (v128 `*_simd` vs the');
md.push('same build\'s scalar `*_scalar` arm); with both builds it performs the full two-build cross-check');
md.push('(v128 from +simd128 vs true non-autovectorized scalar from -simd128), which is what the table above reflects.');
md.push('');
md.push(`Result: **${failures === 0 ? 'PASS' : 'FAIL'}** (${failures} violation${failures === 1 ? '' : 's'}).`);
md.push('');
writeFileSync(join(HERE, 'docs', 's4-wasm-simd-parity-results.md'), md.join('\n'));
console.log(`[parity] wrote docs/s4-wasm-simd-parity-results.md`);

process.exit(failures === 0 ? 0 : 1);
