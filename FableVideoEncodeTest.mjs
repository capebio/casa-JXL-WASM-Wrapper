// FableVideoEncodeTest.mjs — end-to-end for the browser (no-sidecar) FableBraid
// RAW→CASV *video* encoder. Drives the wasm `FableVideoEncoder` → `.casv` →
// `FableDeltaSession` round-trip through the real wasm-bindgen boundary, proving the
// shipping browser decode path reproduces every source frame byte-for-byte.
//
// The Rust side already proves byte-parity with the native encoder + lossless round-trip
// (`raw_pipeline::fable_video` tests); this asserts the JS/WASM marshalling + the actual
// browser decoder (`FableDeltaSession`) agree with it.
//
// Requires the root wasm built to ./pkg-fable (wasm-pack build --target web --out-dir
// pkg-fable --release). Skips as a no-op if that build is absent.
//
// Run: node --test FableVideoEncodeTest.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const JS_URL = new URL("./pkg-fable/raw_converter_wasm.js", import.meta.url);
const WASM_URL = new URL("./pkg-fable/raw_converter_wasm_bg.wasm", import.meta.url);
const JS = fileURLToPath(JS_URL); // fs paths for existsSync
const WASM = fileURLToPath(WASM_URL);

// v1 container constants (casv-format.json — the K6#3 single source of truth).
const CASV_MAGIC = 0x5641_5343;
const CASV_V1_VERSION = 1;
const CASV_PFRAME_FLAG = 0x8000_0000;
const CASV_HDR_FABLE_FLAG = 2;
const HEADER_BYTES = 32;
const INDEX_ENTRY_BYTES = 8;
const V1_LEN_MASK = 0x0fff_ffff; // low 28 bits; top nibble carries flags

/** Deterministic RGB8 frame (moving gradient) — mirrors the Rust test's `frame()`. */
function frame(w, h, t) {
  const v = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      v[o] = (x + t) & 0xff;
      v[o + 1] = (y * 2 + t) & 0xff;
      v[o + 2] = ((x + y) ^ t) & 0xff;
    }
  }
  return v;
}

/** Parse the v1 `.casv` header + packed index (no external deps). */
function parseV1(casv) {
  const dv = new DataView(casv.buffer, casv.byteOffset, casv.byteLength);
  const rd = (o) => dv.getUint32(o, true);
  assert.equal(rd(0), CASV_MAGIC, "magic");
  assert.equal(rd(4), CASV_V1_VERSION, "version");
  const w = rd(8), h = rd(12), fc = rd(16), fpsNum = rd(20), fpsDen = rd(24), flags = rd(28);
  const frames = [];
  for (let i = 0; i < fc; i++) {
    const base = HEADER_BYTES + i * INDEX_ENTRY_BYTES;
    const offset = rd(base);
    const lenFlags = rd(base + 4);
    const len = lenFlags & V1_LEN_MASK;
    const keyframe = ((lenFlags & CASV_PFRAME_FLAG) >>> 0) === 0;
    frames.push({ offset, len, keyframe, payload: casv.subarray(offset, offset + len) });
  }
  return { w, h, fc, fpsNum, fpsDen, flags, frames };
}

test("FableVideoEncoder → .casv → FableDeltaSession round-trips losslessly", async (t) => {
  if (!existsSync(JS) || !existsSync(WASM)) {
    t.skip("pkg-fable not built (wasm-pack build --target web --out-dir pkg-fable --release)");
    return;
  }
  const mod = await import(JS_URL.href);
  await mod.default({ module_or_path: readFileSync(WASM) });
  const { FableVideoEncoder, FableDeltaSession } = mod;

  const w = 48, h = 36, gop = 3, fps = 24, n = 8;
  const source = Array.from({ length: n }, (_, t2) => frame(w, h, t2));

  // Encode through the wasm-bindgen boundary.
  const enc = new FableVideoEncoder(w, h, fps, 1, gop);
  for (const f of source) enc.push_rgb8(f);
  assert.equal(enc.frame_count(), n, "frame_count");
  const casv = enc.finish(); // Uint8Array; consumes the encoder

  // Header sanity: fable flag + dims + count.
  const parsed = parseV1(casv);
  assert.equal(parsed.flags & CASV_HDR_FABLE_FLAG, CASV_HDR_FABLE_FLAG, "fable header flag");
  assert.deepEqual([parsed.w, parsed.h, parsed.fc, parsed.fpsNum, parsed.fpsDen], [w, h, n, fps, 1]);

  // Decode with the SAME session the browser player uses; assert every frame matches.
  const sess = new FableDeltaSession();
  let prev = null;
  for (let i = 0; i < n; i++) {
    const fr = parsed.frames[i];
    assert.equal(fr.keyframe, i % gop === 0, `frame ${i} GOP schedule`);
    const px = fr.keyframe ? sess.decode_intra(fr.payload) : sess.decode_delta(fr.payload, prev, w, h);
    assert.equal(px.length, w * h * 3, `frame ${i} size`);
    assert.ok(Buffer.from(px).equals(Buffer.from(source[i])), `frame ${i} lossless mismatch`);
    prev = px;
  }
});

test("FableVideoEncoder rejects a wrong-sized frame", async (t) => {
  if (!existsSync(JS) || !existsSync(WASM)) {
    t.skip("pkg-fable not built");
    return;
  }
  const mod = await import(JS_URL.href);
  await mod.default({ module_or_path: readFileSync(WASM) });
  const enc = new mod.FableVideoEncoder(4, 4, 24, 1, 1);
  assert.throws(() => enc.push_rgb8(new Uint8Array(10)), /expected 48 bytes/);
});
