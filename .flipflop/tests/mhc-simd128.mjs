// mhc-simd128.mjs — P3-T11 (finding 21) OWED perf-acceptance harness.
//
// A/B of the MHC demosaic INTERIOR: scalar column loop vs the wasm SIMD128 (v128) kernel.
// Everything else (borders, tails, edge rows) is identical, so this isolates the kernel win.
//
// STATUS: NOT RUN in the implementing session — env-blocked (no built root `pkg/` and no headless
// browser). The kernel is committed BIT-EXACT behind the OFF-by-default `mhc-simd128` cargo
// feature; this harness makes the owed ≥15%-median run one build away.
//
// ── Predeclared acceptance gate (must hold to flip `mhc-simd128` on in a shipped pkg) ──
//   • ≥15% median improvement of `simd128` vs `scalar` on the representative frames below.
//   • NO small-image regression (the 640×480 / 1280×960 cases must not regress; the kernel
//     falls back to scalar for width<12 / height<5, so these mainly guard fixed overhead).
//   • equal() must be true (bit-exact) — enforced here by the WASM-side `demtone_bench_mhc_equal`
//     check in setup(); a mismatch aborts before any timing is credited.
//
// ── How to run (Node WASM half) ──
//   1. Build the bench pkg WITH the SIMD kernel wired AND the bench exports present:
//        wasm-pack build --target nodejs --out-dir pkg --release -- --features mhc-simd128,bench-exports
//      (The bench exports demtone_bench_mhc_scalar / _simd128 / _equal exist on every build;
//       `--features mhc-simd128` additionally wires the kernel into the production dispatch.)
//   2. node --expose-gc .flipflop/flipflop.mjs .flipflop/tests/mhc-simd128.mjs --print
//
// ── Browser half (flipflopdom) ──
//   Load the same pkg in headless Chrome and call the identical three exports in the page/Worker
//   (initThreadPool optional — the kernel is single-threaded per row; the pool only changes the
//   row fan-out, which is identical for both variants). Same acceptance gate.
//
// NOTE: the flipflop default fractal RGBA corpus does not apply here — the bench operates on a
// synthetic Bayer mosaic seeded inside WASM by demtone_bench_prepare(w, h). We therefore drive
// the timing entirely through the WASM exports and use a WASM-seeded corpus of (w, h) sizes.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..', '..', 'pkg', 'raw_converter_wasm.js');
const WASM = join(HERE, '..', '..', 'pkg', 'raw_converter_wasm_bg.wasm');

export const name = 'mhc-simd128';
export const description =
  'MHC demosaic interior: scalar column loop vs wasm SIMD128 (v128) kernel — bit-exact, ' +
  'OWED >=15% median gate. Times demtone_bench_mhc_scalar vs _simd128 in Node WASM.';

// Representative + small-image frames (width, height). "Representative" = mid/large photo tiles
// where the interior dominates; "small" = guards that the width/height fallback adds no regression.
export const corpus = () => [
  { name: '640x480-small',   kind: 'wh', w: 640,  h: 480,  rounds: 40 },
  { name: '1280x960-small',  kind: 'wh', w: 1280, h: 960,  rounds: 20 },
  { name: '2048x1536-repr',  kind: 'wh', w: 2048, h: 1536, rounds: 12 },
  { name: '4000x3000-repr',  kind: 'wh', w: 4000, h: 3000, rounds: 6  },
];

let wasm = null;

async function ensureWasm() {
  if (wasm) return wasm;
  if (!existsSync(PKG) || !existsSync(WASM)) {
    throw new Error(
      `mhc-simd128: built pkg not found at ${PKG}. Build it first:\n` +
      `  wasm-pack build --target nodejs --out-dir pkg --release -- --features mhc-simd128,bench-exports`
    );
  }
  const mod = await import(PKG);
  // wasm-pack --target nodejs auto-initializes; --target web needs default(init). Handle both.
  if (typeof mod.default === 'function') {
    try { await mod.default({ module_or_path: readFileSync(WASM) }); } catch { /* nodejs target: already init */ }
  }
  wasm = mod;
  // Fail loud if this pkg predates the bench exports (built without the harness patch).
  for (const fn of ['demtone_bench_prepare', 'demtone_bench_mhc_scalar', 'demtone_bench_mhc_simd128', 'demtone_bench_mhc_equal']) {
    if (typeof wasm[fn] !== 'function') {
      throw new Error(`mhc-simd128: pkg missing export ${fn} — rebuild with the P3-T11 patch.`);
    }
  }
  return wasm;
}

// setup: seed the WASM Bayer mosaic for this (w,h) and assert bit-exact BEFORE timing.
export const setup = async (item) => {
  const m = await ensureWasm();
  m.demtone_bench_prepare(item.w, item.h);
  if (!m.demtone_bench_mhc_equal()) {
    throw new Error(`mhc-simd128: NOT bit-exact at ${item.w}x${item.h} — refusing to time.`);
  }
  return item; // pass (w,h) descriptor through to run()
};

export const variants = [
  {
    name: 'scalar',
    baseline: true,
    run(_item, _ctx) {
      // Returns the demosaic checksum (u32) — also serves as the equal() witness.
      return wasm.demtone_bench_mhc_scalar() >>> 0;
    },
  },
  {
    name: 'simd128',
    run(_item, _ctx) {
      return wasm.demtone_bench_mhc_simd128() >>> 0;
    },
  },
];

// Bit-exact guard: both variants must produce the identical demosaic checksum.
export const equal = (a, b) => a === b;
