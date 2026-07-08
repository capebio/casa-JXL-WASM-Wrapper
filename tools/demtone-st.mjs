// Demosaic-MHC + tone SINGLE-THREAD baseline (wasm128, Node, no parallel feature).
// Pairs with the browser MT harness (tools/demtone-mt.html) to quantify how much of the
// "990ms" ORF decode is a threads-off artifact (StandardMultifileTest never initThreadPool).
// Build: $env:RUSTFLAGS="-C target-feature=+simd128"; wasm-pack build --target nodejs --out-dir pkg-bench --release
import { performance } from "node:perf_hooks";
const wasm = (await import("../pkg-bench/raw_converter_wasm.js")).default ?? await import("../pkg-bench/raw_converter_wasm.js");
const { demtone_bench_prepare, demtone_bench_mhc, demtone_bench_tone } = wasm;

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const min = (a) => Math.min(...a);
const t1 = (fn) => { const s = performance.now(); fn(); return performance.now() - s; };

const [w, h] = [5240, 3912]; // real Olympus 20MP sensor
demtone_bench_prepare(w, h);
for (let i = 0; i < 4; i++) { demtone_bench_mhc(); demtone_bench_tone(); } // warm
const iters = 15;
const mhc = [], tone = [];
for (let i = 0; i < iters; i++) { mhc.push(t1(demtone_bench_mhc)); tone.push(t1(demtone_bench_tone)); }
console.log("=== DEMOSAIC-MHC + TONE — SINGLE-THREAD baseline (wasm128, Node, no initThreadPool) ===");
console.log(`  ${w}×${h} (20MP), ${iters} iters`);
console.log(`  demosaic MHC : min ${min(mhc).toFixed(1)}ms  med ${median(mhc).toFixed(1)}ms`);
console.log(`  tone         : min ${min(tone).toFixed(1)}ms  med ${median(tone).toFixed(1)}ms`);
console.log(`  demtone total: med ${(median(mhc) + median(tone)).toFixed(1)}ms  (compare to browser MT w/ initThreadPool)`);
