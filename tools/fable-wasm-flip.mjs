// FableBraid wasm flipflop: scalar vs +simd128 artifacts, interleaved arms.
//
// Usage:
//   node tools/fable-wasm-flip.mjs <ghana.rgb> [frames=16] [reps=12]
//
// Expects two wasm-pack nodejs builds of the root crate:
//   pkg-fbench-scalar/  (built with RUSTFLAGS="" — overrides .cargo/config +simd128)
//   pkg-fbench-simd/    (built with the default .cargo/config +simd128)
//
// Parity gates first (encoded bytes and decoded pixels must be identical across
// the two artifacts and roundtrip to source), then interleaved decode timing in
// A,B,B,A,B,A,A,B rotation — sequential per-arm timing is drift-biased.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const scalar = require('../pkg-fbench-scalar/raw_converter_wasm.js');
const simd = require('../pkg-fbench-simd/raw_converter_wasm.js');

const [, , blobPath, framesArg, repsArg] = process.argv;
if (!blobPath) {
  console.error('usage: node tools/fable-wasm-flip.mjs <ghana.rgb> [frames] [reps]');
  process.exit(2);
}
const W = 1280, H = 720, FLEN = W * H * 3;
const nFrames = Math.min(Number(framesArg ?? 16), 48);
const reps = Number(repsArg ?? 12);

const raw = readFileSync(blobPath);
const frames = [];
for (let i = 0; i < nFrames; i++) frames.push(new Uint8Array(raw.buffer, i * FLEN, FLEN));

// ── encode once per arm, parity-gate the bitstreams ──
function encodeAll(m) {
  const out = [m.fable_encode_rgb8(frames[0], W, H)];
  for (let i = 1; i < nFrames; i++) out.push(m.fable_encode_rgb8_delta(frames[i], frames[i - 1], W, H));
  return out;
}
const encA = encodeAll(scalar);
const encB = encodeAll(simd);
for (let i = 0; i < nFrames; i++) {
  if (Buffer.compare(Buffer.from(encA[i]), Buffer.from(encB[i])) !== 0) {
    console.error(`PARITY FAIL: encoded frame ${i} differs scalar vs simd`);
    process.exit(1);
  }
}

// ── decode chain, parity-gate pixels vs source ──
function decodeChain(m, enc) {
  let prev = m.fable_decode_rgb8(enc[0]);
  const out = [prev];
  for (let i = 1; i < nFrames; i++) {
    prev = m.fable_decode_rgb8_delta(enc[i], prev, W, H);
    out.push(prev);
  }
  return out;
}
const decA = decodeChain(scalar, encA);
const decB = decodeChain(simd, encA);
for (let i = 0; i < nFrames; i++) {
  if (Buffer.compare(Buffer.from(decA[i]), Buffer.from(frames[i])) !== 0
    || Buffer.compare(Buffer.from(decB[i]), Buffer.from(frames[i])) !== 0) {
    console.error(`PARITY FAIL: decoded frame ${i} != source`);
    process.exit(1);
  }
}
const bytes = encA.reduce((a, e) => a + e.length, 0);
console.log(`parity OK: ${nFrames}f, ${(bytes / 1e6).toFixed(1)} MB encoded (${(100 * bytes / (nFrames * FLEN)).toFixed(1)}% of raw)`);

// ── interleaved timing ──
function timeChain(m, enc) {
  const t0 = performance.now();
  decodeChain(m, enc);
  return performance.now() - t0;
}
// warmup both
timeChain(scalar, encA); timeChain(simd, encA);

const pattern = ['A', 'B', 'B', 'A', 'B', 'A', 'A', 'B'];
const tA = [], tB = [];
for (let r = 0; r < reps; r++) {
  const arm = pattern[r % pattern.length];
  const ms = timeChain(arm === 'A' ? scalar : simd, encA);
  (arm === 'A' ? tA : tB).push(ms);
}
const stats = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return { min: s[0], med: s[Math.floor(s.length / 2)] };
};
const a = stats(tA), b = stats(tB);
console.log(`scalar : n=${tA.length} min ${a.min.toFixed(1)} med ${a.med.toFixed(1)} ms/chain (${(a.med / nFrames).toFixed(2)} ms/f)`);
console.log(`simd128: n=${tB.length} min ${b.min.toFixed(1)} med ${b.med.toFixed(1)} ms/chain (${(b.med / nFrames).toFixed(2)} ms/f)`);
console.log(`delta  : med ${(100 * (b.med - a.med) / a.med).toFixed(1)}%  floor ${(100 * (b.min - a.min) / a.min).toFixed(1)}%  (negative = simd faster)`);
