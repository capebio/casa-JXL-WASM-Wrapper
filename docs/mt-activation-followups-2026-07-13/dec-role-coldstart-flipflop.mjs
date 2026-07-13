// Cold-start A/B for candidate C3 (route the JXL decoder to the decode-only
// `dec.<tier>` artifact instead of the encoder superset `enc.<tier>`).
//
// Interleaved A/B in the flipflop spirit: variants run back-to-back with start-
// rotation so thermal drift cancels; the first WARMUP reps are discarded; medians
// reported. Two measurements:
//   1. instantiate — fresh factory({wasmBinary}) per rep (cold compile+instantiate).
//   2. first-decode — instantiate a fresh module then decode one real JXL through it
//      (the "time to first decoded pixel" cold path a viewer/gallery pays).
//
// Standalone: instantiates the generated Emscripten artifacts directly from
// packages/jxl-wasm/dist/, so it needs no node_modules and no facade build.
//
//   node docs/mt-activation-followups-2026-07-13/dec-role-coldstart-flipflop.mjs
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const DIST = new URL("../../packages/jxl-wasm/dist/", import.meta.url);
const BENCH = new URL("../Benchmark results/P2200619-prog-p6-q85.jxl", import.meta.url);

const VARIANTS = [
  { key: "A_enc.simd", artifact: "enc.simd" }, // current decoder module (superset)
  { key: "B_dec.simd", artifact: "dec.simd" }, // candidate decode-only module
];
const N = 24, WARMUP = 3;

async function loadFactory(artifact) {
  const mod = await import(new URL(`jxl-core.${artifact}.js`, DIST).href);
  const wasmBinary = await readFile(new URL(`jxl-core.${artifact}.wasm`, DIST));
  return { factory: mod.default, wasmBinary };
}
const instantiate = (factory, wasmBinary) => factory({ wasmBinary, locateFile: (p) => fileURLToPath(new URL(p, DIST)) });

function decodeRgba8(m, input) {
  const ptr = m._malloc(input.length); m.HEAPU8.set(input, ptr);
  let handle = 0;
  try {
    handle = m._jxl_wasm_decode_rgba8(ptr, input.length, 1);
    if (handle === 0) throw new Error("null handle");
    const b = handle >>> 2, h = m.HEAPU32;
    const dataPtr = h[b], size = h[b + 1], width = h[b + 2];
    if (!dataPtr || !size) throw new Error("empty buffer");
    return { width, size };
  } finally { if (handle) m._jxl_wasm_buffer_free(handle); m._free(ptr); }
}
const median = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

const bench = await readFile(BENCH);
const loaded = {};
for (const v of VARIANTS) loaded[v.key] = await loadFactory(v.artifact);

const inst = Object.fromEntries(VARIANTS.map((v) => [v.key, []]));
for (let rep = 0; rep < N + WARMUP; rep++) {
  const order = rep % 2 === 0 ? VARIANTS : [...VARIANTS].reverse();
  for (const v of order) {
    const { factory, wasmBinary } = loaded[v.key];
    const t0 = performance.now(); const m = await instantiate(factory, wasmBinary); const t1 = performance.now();
    if (typeof m._malloc !== "function") throw new Error("no _malloc");
    if (rep >= WARMUP) inst[v.key].push(t1 - t0);
  }
}
const first = Object.fromEntries(VARIANTS.map((v) => [v.key, []]));
for (let rep = 0; rep < N + WARMUP; rep++) {
  const order = rep % 2 === 0 ? VARIANTS : [...VARIANTS].reverse();
  for (const v of order) {
    const { factory, wasmBinary } = loaded[v.key];
    const t0 = performance.now(); const m = await instantiate(factory, wasmBinary); const d = decodeRgba8(m, bench); const t1 = performance.now();
    if (d.width <= 0) throw new Error("bad decode");
    if (rep >= WARMUP) first[v.key].push(t1 - t0);
  }
}
const report = (label, data, bytesA, bytesB) => {
  const a = VARIANTS[0].key, b = VARIANTS[1].key, ma = median(data[a]), mb = median(data[b]);
  console.log(`\n== ${label} ==`);
  console.log(`  ${a}: median ${ma.toFixed(3)} ms  mean ${mean(data[a]).toFixed(3)}  (n=${data[a].length})`);
  console.log(`  ${b}: median ${mb.toFixed(3)} ms  mean ${mean(data[b]).toFixed(3)}  (n=${data[b].length})`);
  console.log(`  delta (B-A): ${(mb - ma).toFixed(3)} ms   ${(((mb - ma) / ma) * 100).toFixed(2)}%  (negative = candidate faster)`);
  if (bytesA && bytesB) console.log(`  wasm bytes: A=${bytesA}  B=${bytesB}  (${((bytesB / bytesA - 1) * 100).toFixed(1)}%)`);
};
console.log(`fixture: bench=${bench.length}B`);
report("cold instantiate", inst, loaded[VARIANTS[0].key].wasmBinary.length, loaded[VARIANTS[1].key].wasmBinary.length);
report("cold first-decode (instantiate+decode)", first);
