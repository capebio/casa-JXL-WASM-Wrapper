// FableVideoEncodeTest.mjs — end-to-end for the browser (no-sidecar) FableBraid
// RAW→CASV *video* encoder. Drives the wasm `FableVideoEncoder` → `.casv` →
// `FableDeltaSession` round-trip through the real wasm-bindgen boundary, proving the
// shipping browser decode path reproduces every source frame byte-for-byte, and that
// the `encodeFableTimelapse` glue (web/timelapse-core.js) turns real ORF stills into a
// lossless `.casv` with no native sidecar.
//
// Loads the committed threaded build (web/pkg) if present, else a throwaway non-threaded
// pkg-fable (wasm-pack build --target web --out-dir pkg-fable --release). Skips as a
// no-op if neither is built. The ORF-sequence test additionally needs the local corpus.
//
// Run: node --test FableVideoEncodeTest.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeFableTimelapse, decodeRawNeutralRgb } from "./web/timelapse-core.js";

// v1 container constants (casv-format.json — the K6#3 single source of truth).
const CASV_MAGIC = 0x5641_5343;
const CASV_V1_VERSION = 1;
const CASV_PFRAME_FLAG = 0x8000_0000;
const CASV_HDR_FABLE_FLAG = 2;
const HEADER_BYTES = 32;
const INDEX_ENTRY_BYTES = 8;
const V1_LEN_MASK = 0x0fff_ffff; // low 28 bits; top nibble carries flags

// Prefer the committed threaded build; fall back to the throwaway verification build.
const PKG_DIRS = ["./web/pkg/", "./pkg-fable/"];
function resolvePkg() {
  for (const dir of PKG_DIRS) {
    const js = new URL(dir + "raw_converter_wasm.js", import.meta.url);
    const wasm = new URL(dir + "raw_converter_wasm_bg.wasm", import.meta.url);
    if (existsSync(fileURLToPath(js)) && existsSync(fileURLToPath(wasm))) {
      return { jsHref: js.href, wasmPath: fileURLToPath(wasm), dir };
    }
  }
  return null;
}
async function loadMod() {
  const pkg = resolvePkg();
  if (!pkg) return null;
  const mod = await import(pkg.jsHref);
  await mod.default({ module_or_path: readFileSync(pkg.wasmPath) });
  return mod;
}

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

/** Decode a fable `.casv` back to RGB8 frames via the shipping browser session. */
function decodeAll(mod, parsed, casv) {
  const sess = new mod.FableDeltaSession();
  const out = [];
  let prev = null;
  for (let i = 0; i < parsed.fc; i++) {
    const fr = parsed.frames[i];
    const px = fr.keyframe
      ? sess.decode_intra(fr.payload)
      : sess.decode_delta(fr.payload, prev, parsed.w, parsed.h);
    out.push(px);
    prev = px;
  }
  return out;
}

test("FableVideoEncoder → .casv → FableDeltaSession round-trips losslessly (synthetic)", async (t) => {
  const mod = await loadMod();
  if (!mod) { t.skip("no wasm pkg built (web/pkg or pkg-fable)"); return; }
  const { FableVideoEncoder } = mod;

  const w = 48, h = 36, gop = 3, fps = 24, n = 8;
  const source = Array.from({ length: n }, (_, t2) => frame(w, h, t2));

  const enc = new FableVideoEncoder(w, h, fps, 1, gop);
  for (const f of source) enc.push_rgb8(f);
  assert.equal(enc.frame_count(), n, "frame_count");
  const casv = enc.finish();

  const parsed = parseV1(casv);
  assert.equal(parsed.flags & CASV_HDR_FABLE_FLAG, CASV_HDR_FABLE_FLAG, "fable header flag");
  assert.deepEqual([parsed.w, parsed.h, parsed.fc, parsed.fpsNum, parsed.fpsDen], [w, h, n, fps, 1]);

  const decoded = decodeAll(mod, parsed, casv);
  for (let i = 0; i < n; i++) {
    assert.equal(parsed.frames[i].keyframe, i % gop === 0, `frame ${i} GOP schedule`);
    assert.equal(decoded[i].length, w * h * 3, `frame ${i} size`);
    assert.ok(Buffer.from(decoded[i]).equals(Buffer.from(source[i])), `frame ${i} lossless mismatch`);
  }
});

test("FableVideoEncoder rejects a wrong-sized frame", async (t) => {
  const mod = await loadMod();
  if (!mod) { t.skip("no wasm pkg"); return; }
  const enc = new mod.FableVideoEncoder(4, 4, 24, 1, 1);
  assert.throws(() => enc.push_rgb8(new Uint8Array(10)), /expected 48 bytes/);
});

// End-to-end pure-web path: real ORF stills → encodeFableTimelapse → lossless .casv.
const CORPUS_ORF = [
  "C:/995/2026-02-20 Gobabeb To Windhoek/P2200474.ORF",
  "C:/995/2026-02-20 Gobabeb To Windhoek/P2200475 Kissenia capensis.ORF",
];
test("encodeFableTimelapse: real ORF sequence → lossless .casv (no sidecar)", async (t) => {
  const mod = await loadMod();
  if (!mod) { t.skip("no wasm pkg"); return; }
  if (!existsSync(CORPUS_ORF[0])) { t.skip("ORF corpus absent"); return; }

  // The two corpus stills differ in orientation (one portrait, one landscape) — the
  // encoder correctly rejects that (a locked time-lapse has consistent orientation),
  // so repeat one still for a valid real-RAW sequence. Distinct-frame delta content
  // is covered by the synthetic test above.
  const name = CORPUS_ORF[0].split(/[\\/]/).pop();
  const bytes = readFileSync(CORPUS_ORF[0]);
  const frames = [{ bytes, name }, { bytes, name }];
  let progress = 0;
  const casv = encodeFableTimelapse(mod, frames, { fpsNum: 24, fpsDen: 1, gop: 2 }, () => progress++);
  assert.equal(progress, frames.length, "onProgress fired per frame");

  const parsed = parseV1(casv);
  assert.equal(parsed.flags & CASV_HDR_FABLE_FLAG, CASV_HDR_FABLE_FLAG, "fable header flag");
  assert.equal(parsed.fc, frames.length, "frame count");
  assert.ok(parsed.w > 0 && parsed.h > 0, "dims");

  // Losslessness on REAL frames: each decoded frame == a fresh neutral decode of the ORF.
  const decoded = decodeAll(mod, parsed, casv);
  for (let i = 0; i < frames.length; i++) {
    const want = decodeRawNeutralRgb(mod, frames[i].bytes, frames[i].name).rgb;
    assert.equal(decoded[i].length, parsed.w * parsed.h * 3, `frame ${i} size`);
    assert.ok(Buffer.from(decoded[i]).equals(Buffer.from(want)), `frame ${i} not lossless vs source`);
  }
});
