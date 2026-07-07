// K6#4 smoke test: FableBraid WASM decode session (browser CASV playback path).
//
// Verifies the `FableDeltaSession` wasm export in the freshly-built `pkg/`
// (wasm-pack --target web). The intra/delta frames are REAL fable bitstreams:
// produced by the native encoder via its own wasm forwarder `fable_encode_rgb8`
// / `fable_encode_rgb8_delta`, then decoded back through the stateful session —
// a genuine encode->decode roundtrip, not a fabricated byte blob.
//
// Run:  node test-fable-wasm.mjs
// Exit: 0 = pass, non-zero = fail.

import { readFile } from 'node:fs/promises';

const W = 24;
const H = 16;
const CH = 3; // FableBraid decode returns interleaved RGB8 (3 channels)
const N = W * H;

// ── init the freshly-built --target web pkg in Node (pass the wasm bytes) ──
const pkgJs = new URL('./pkg/raw_converter_wasm.js', import.meta.url);
const pkgWasm = new URL('./pkg/raw_converter_wasm_bg.wasm', import.meta.url);
const wasm = await import(pkgJs.href);
await wasm.default({ module_or_path: await readFile(pkgWasm) });

const {
  FableDeltaSession,
  fable_encode_rgb8,
  fable_encode_rgb8_delta,
} = wasm;

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

assert(typeof FableDeltaSession === 'function', 'FableDeltaSession export present');
assert(typeof fable_encode_rgb8 === 'function', 'fable_encode_rgb8 export present');

// ── synthetic RGB8 frames with a guaranteed non-zero first pixel ──
function makeFrame(seed) {
  const rgb = new Uint8Array(N * CH);
  for (let i = 0; i < N; i++) {
    rgb[i * 3 + 0] = (i * 7 + seed * 3 + 11) & 0xff;   // R (pixel0 = non-zero)
    rgb[i * 3 + 1] = (i * 3 + seed * 5 + 29) & 0xff;   // G
    rgb[i * 3 + 2] = (i * 5 + seed * 2 + 47) & 0xff;   // B
  }
  return rgb;
}

const frame0 = makeFrame(0);
const frame1 = makeFrame(1);
assert(frame0[0] !== 0, 'source first pixel is non-zero');

// ── encode a REAL fable intra keyframe, then decode via the session ──
const intra = fable_encode_rgb8(frame0, W, H);
assert(intra instanceof Uint8Array && intra.length > 8, 'intra bitstream produced');

const sess = new FableDeltaSession();
const out0 = sess.decode_intra(intra);

assert(out0 instanceof Uint8Array, 'decode_intra returns a Uint8Array');
assert(out0.length === N * CH, `decode_intra length ${out0.length} == w*h*3 (${N * CH})`);
assert(out0[0] !== 0, `decode_intra first pixel non-zero (got ${out0[0]})`);
assert(Buffer.compare(Buffer.from(out0), Buffer.from(frame0)) === 0,
  'decode_intra roundtrips byte-exact to source (lossless)');
assert(sess.width === W && sess.height === H,
  `session dims after intra: ${sess.width}x${sess.height} == ${W}x${H}`);

// ── decode a temporal-delta frame against the previous decoded frame ──
const delta = fable_encode_rgb8_delta(frame1, frame0, W, H);
const out1 = sess.decode_delta(delta, out0, W, H);
assert(out1.length === N * CH, `decode_delta length ${out1.length} == w*h*3`);
assert(Buffer.compare(Buffer.from(out1), Buffer.from(frame1)) === 0,
  'decode_delta roundtrips byte-exact to source frame 1');

console.log('PASS: FableDeltaSession wasm export');
console.log(`  intra:  ${intra.length} B bitstream -> ${out0.length} B RGB8 (${W}x${H}x${CH}), px0=[${out0[0]},${out0[1]},${out0[2]}]`);
console.log(`  delta:  ${delta.length} B bitstream -> ${out1.length} B RGB8, byte-exact roundtrip`);
console.log(`  dims:   session reports ${sess.width}x${sess.height}`);
