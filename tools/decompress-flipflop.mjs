// ORF decompress refill flip-flop (wasm128, single-thread, Node).
// A/B: byte-loop refill (current wasm production) vs u64 wide refill w/ i8x16.swizzle
// byteswap (WIDE=true). This is the measurement the wide-refill wasm deferral never had
// (Questions_deferred D-wide-refill). TRUE alternation (byteloop,wide,byteloop,wide…) so
// time-varying background load cancels in the ratio. Reports MIN + median. `_equal` pins
// bit-exactness (both refills must decode identically).
//
// Build first (from repo root):
//   $env:RUSTFLAGS="-C target-feature=+simd128"
//   wasm-pack build --target nodejs --out-dir pkg-bench --release
//   node tools/decompress-flipflop.mjs
import { performance } from "node:perf_hooks";

const wasmMod = await import("../pkg-bench/raw_converter_wasm.js");
const wasm = wasmMod.default ?? wasmMod;
const {
  decompress_bench_prepare,
  decompress_bench_byteloop,
  decompress_bench_wide,
  decompress_bench_equal,
} = wasm;

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const min = (a) => Math.min(...a);
const p90 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * 0.9)]; };
const t1 = (fn) => { const s = performance.now(); fn(); return performance.now() - s; };

// 20MP = the real Olympus sensor (5240×3912). Smaller sizes show the trend holds.
const sizes = [[5240, 3912, "20MP-ORF"], [2048, 1536, "3MP"], [1024, 1024, "1MP"]];
console.log("=== ORF DECOMPRESS REFILL FLIP-FLOP (wasm128, single-thread, Node) — alternating byteloop vs wide ===");
console.log("context\tequal\tbl_min\twd_min\tspd(min)\tbl_med\twd_med\tspd(med)\tbl_p90\twd_p90");
let ok = true;
for (const [w, h, label] of sizes) {
  decompress_bench_prepare(w, h, 0x1234);
  if (!decompress_bench_equal()) ok = false;                          // correctness pin
  for (let i = 0; i < 6; i++) { decompress_bench_byteloop(); decompress_bench_wide(); } // warm
  const iters = w >= 5000 ? 30 : 120;
  const bl = [], wd = [];
  for (let i = 0; i < iters; i++) {                                    // TRUE alternation
    bl.push(t1(decompress_bench_byteloop));
    wd.push(t1(decompress_bench_wide));
  }
  const blMin = min(bl), wdMin = min(wd), blMed = median(bl), wdMed = median(wd);
  console.log(
    `${label}\t${decompress_bench_equal()}\t${blMin.toFixed(2)}\t${wdMin.toFixed(2)}\t${(blMin / wdMin).toFixed(3)}` +
    `\t${blMed.toFixed(2)}\t${wdMed.toFixed(2)}\t${(blMed / wdMed).toFixed(3)}\t${p90(bl).toFixed(2)}\t${p90(wd).toFixed(2)}`);
}
if (!ok) { console.error("CORRECTNESS FAIL: wasm128 wide refill != byte-loop"); process.exitCode = 1; }
else console.log("\nspd>1.0 ⇒ wide/SIMD refill wins on wasm → flip WIDE_FILL=true for wasm in decompress.rs");
