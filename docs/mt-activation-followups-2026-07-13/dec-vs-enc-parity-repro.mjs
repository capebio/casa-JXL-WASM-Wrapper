// Repro: the shipped decode-only `dec.<tier>` and encoder-superset `enc.<tier>` WASM
// builds do NOT decode to the same pixels — a uniform ±1-LSB divergence on ~24% of
// channels, including lossless inputs. `dec.<tier>` agrees with the monolithic `<tier>`;
// `enc.<tier>` (the module the facade decoder actually loads) is the outlier.
//
// Standalone: instantiates the generated Emscripten artifacts straight from
// packages/jxl-wasm/dist/, so it needs no node_modules and no facade build.
//
//   node docs/mt-activation-followups-2026-07-13/dec-vs-enc-parity-repro.mjs
//
// PASS criterion (after a build reconciliation): every fixture reports MATCH.
// Today it reports "3-way DIFF" (enc differs from dec == mono).
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const DIST = new URL("../../packages/jxl-wasm/dist/", import.meta.url);
const FIX = new URL("../../packages/jxl-test-corpus/fixtures/", import.meta.url);
const BENCH = new URL("../Benchmark results/P2200619-prog-p6-q85.jxl", import.meta.url);

async function inst(artifact) {
  const mod = await import(new URL(`jxl-core.${artifact}.js`, DIST).href);
  const wasmBinary = await readFile(new URL(`jxl-core.${artifact}.wasm`, DIST));
  return mod.default({ wasmBinary, locateFile: (p) => fileURLToPath(new URL(p, DIST)) });
}

function decode(m, input) {
  const ptr = m._malloc(input.length);
  m.HEAPU8.set(input, ptr);
  let handle = 0;
  try {
    handle = m._jxl_wasm_decode_rgba8(ptr, input.length, 1);
    if (handle === 0) return { err: "null handle" };
    const b = handle >>> 2, h = m.HEAPU32;
    const dataPtr = h[b], size = h[b + 1], w = h[b + 2], ht = h[b + 3], errCode = h[b + 6];
    if (!dataPtr || !size) return { err: "empty (" + errCode + ")" };
    return { px: m.HEAPU8.slice(dataPtr, dataPtr + size), w, h: ht, size };
  } finally {
    if (handle) m._jxl_wasm_buffer_free(handle);
    m._free(ptr);
  }
}

function fnv(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
  return ("0000000" + h.toString(16)).slice(-8);
}

function delta(a, b) {
  let max = 0, sum = 0, n = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { n++; sum += d; if (d > max) max = d; } }
  return { max, mean: n ? sum / n : 0, n, total: a.length };
}

const TIER = process.argv[2] || "simd"; // pass "simd-mt" in a browser; pthreads won't run under plain Node
const enc = await inst(`enc.${TIER}`);
const dec = await inst(`dec.${TIER}`);
const mono = await inst(TIER);

for (const a of [`enc.${TIER}`, `dec.${TIER}`, TIER]) {
  const st = await stat(new URL(`jxl-core.${a}.wasm`, DIST));
  console.log(`${a.padEnd(12)} bytes=${st.size}`);
}
console.log("");

const fixtures = ["srgb-8bit.jxl", "srgb-alpha-8bit.jxl", "lossless-16bit.jxl", "multiview-a.jxl", "adobe-rgb-16bit.jxl", "gray-ramp-16bit.jxl"];
let anyDiff = false;
for (const f of fixtures) {
  let input; try { input = await readFile(new URL(f, FIX)); } catch { console.log(`${f}: (missing)`); continue; }
  const re = decode(enc, input), rd = decode(dec, input), rm = decode(mono, input);
  if (re.err || rd.err || rm.err) { console.log(`${f.padEnd(22)} err enc=${re.err} dec=${rd.err} mono=${rm.err}`); continue; }
  const he = fnv(re.px), hd = fnv(rd.px), hm = fnv(rm.px);
  const match = he === hd && he === hm;
  if (!match) anyDiff = true;
  const d = delta(re.px, rd.px);
  console.log(`${f.padEnd(22)} enc=${he} dec=${hd} mono=${hm}  ${match ? "MATCH" : "3-way DIFF"}  encVsDec: maxΔ=${d.max} ±1@${(100 * d.n / d.total).toFixed(1)}%`);
}

try {
  const input = await readFile(BENCH);
  const re = decode(enc, input), rd = decode(dec, input);
  const d = delta(re.px, rd.px);
  console.log(`\n${"P2200619 (1.1MB q85)".padEnd(22)} ${re.w}x${re.h}  encVsDec: maxΔ=${d.max} meanΔ=${d.mean.toFixed(2)} ±diff@${(100 * d.n / d.total).toFixed(1)}%`);
} catch { /* bench optional */ }

console.log(`\n=> ${anyDiff ? "DIVERGENT (build reconciliation needed before wiring dec.<tier> into decode)" : "all builds agree"}`);
process.exitCode = anyDiff ? 3 : 0;
