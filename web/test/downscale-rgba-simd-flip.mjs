// downscale-rgba-simd-flip — interleaved A/B for the wasm simd128
// downscale_rgba integer fast path (DS-SIMD deferred item):
//
//   A = OLD pkg (scalar integer path)   built from the branch parent
//   B = NEW pkg (u16-lane SIMD path)    built from this branch
//
// Both are wasm-pack nodejs builds loaded into one Node process; rounds
// alternate module call order (start rotation), round 0 dropped, median.
// Pixel identity asserted first (integer sums are order-independent).
//
// Usage: node web/test/downscale-rgba-simd-flip.mjs <old-pkg-dir> <new-pkg-dir>
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const [oldDir, newDir] = process.argv.slice(2);
if (!oldDir || !newDir) {
  console.error("usage: node downscale-rgba-simd-flip.mjs <old-pkg-dir> <new-pkg-dir>");
  process.exit(2);
}
const oldPkg = require(`${oldDir}\\raw_converter_wasm.js`);
const newPkg = require(`${newDir}\\raw_converter_wasm.js`);

const med = (v) => {
  const s = v.slice(1).sort((a, b) => a - b);
  return s[s.length >> 1];
};

// Typical thumbnail cases: pow2 halves + a 6x reduction.
const cases = [
  { sw: 4096, sh: 3072, dw: 2048, dh: 1536 }, // 2x
  { sw: 4096, sh: 3072, dw: 1024, dh: 768 },  // 4x
  { sw: 4096, sh: 3072, dw: 512, dh: 384 },   // 8x
  { sw: 6000, sh: 4020, dw: 1000, dh: 670 },  // 6x
];

console.log("downscale_rgba flipflop   A=old scalar   B=new simd128");
let allOk = true;
for (const { sw, sh, dw, dh } of cases) {
  const src = new Uint8Array(sw * sh * 4);
  let s = 0x9e3779b9 >>> 0;
  for (let i = 0; i < src.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    src[i] = s >>> 24;
  }

  const a0 = oldPkg.downscale_rgba(src, sw, sh, dw, dh);
  const b0 = newPkg.downscale_rgba(src, sw, sh, dw, dh);
  let identical = a0.length === b0.length;
  if (identical) {
    for (let i = 0; i < a0.length; i++) {
      if (a0[i] !== b0[i]) { identical = false; break; }
    }
  }
  if (!identical) allOk = false;

  const rounds = 11;
  const times = [[], []];
  let sink = 0;
  for (let round = 0; round < rounds; round++) {
    for (let k = 0; k < 2; k++) {
      const which = (round + k) % 2;
      const t = performance.now();
      const out = which === 0
        ? oldPkg.downscale_rgba(src, sw, sh, dw, dh)
        : newPkg.downscale_rgba(src, sw, sh, dw, dh);
      times[which].push(performance.now() - t);
      sink += out[out.length >> 1];
    }
  }
  const ma = med(times[0]);
  const mb = med(times[1]);
  const saved = ((ma - mb) / ma) * 100;
  console.log(
    `  ${sw}x${sh} -> ${dw}x${dh} (${sw / dw}x): identical=${identical}  ` +
    `A ${ma.toFixed(2)} ms  B ${mb.toFixed(2)} ms  %saved ${saved >= 0 ? "+" : ""}${saved.toFixed(1)}%  ` +
    `${(ma / mb).toFixed(2)}x  gate(>=5%): ${saved >= 5 ? "PASS" : "FAIL"}  (sink=${sink & 0xff})`
  );
}
process.exit(allOk ? 0 : 1);
