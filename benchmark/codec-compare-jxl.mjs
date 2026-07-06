import { readFileSync } from "node:fs";
import { extname, basename } from "node:path";
import sharp from "sharp";

let raw, facade, PerceptualComparer;
export async function initCodecCompareJxl() {
  raw = await import("../pkg/raw_converter_wasm.js");
  await raw.default({ module_or_path: readFileSync(new URL("../pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });
  PerceptualComparer = raw.PerceptualComparer;
  facade = await import("../packages/jxl-wasm/dist/index.js");
}

const TARGET = 1920;
// Verbatim from StandardMultifileTest.mjs:155
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];
const exactBuffer = (u8) => (u8.buffer.byteLength === u8.byteLength ? u8 : u8.slice());
function rgbaToRgb(d, w, h) { const out = new Uint8Array(w*h*3); for (let i=0,s=0,o=0;i<w*h;i++,s+=4,o+=3){ out[o]=d[s]; out[o+1]=d[s+1]; out[o+2]=d[s+2]; } return out; }

export async function loadTargetRgba(path) {
  const ext = extname(path).toLowerCase();
  let rgb, srcW, srcH;
  if (ext === ".jpg" || ext === ".jpeg") {
    const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
    rgb = info.channels === 4 ? rgbaToRgb(data, info.width, info.height) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    srcW = info.width; srcH = info.height;
  } else {
    const bytes = new Uint8Array(readFileSync(path));
    let decoded;
    if (ext === ".orf" || ext === ".raw") decoded = raw.process_orf_with_flags(bytes, 1, ...PROCESS_ARGS);
    else if (ext === ".cr2") decoded = raw.process_cr2_with_flags(bytes, 1, ...PROCESS_ARGS);
    else if (ext === ".dng") decoded = raw.process_dng_with_flags(bytes, 1, ...PROCESS_ARGS);
    else throw new Error(`Unsupported ext ${ext}`);
    rgb = decoded.take_rgb(); srcW = decoded.width; srcH = decoded.height; decoded.free();
  }
  const longEdge = Math.max(srcW, srcH);
  const scale = longEdge > TARGET ? TARGET / longEdge : 1;
  const tgtW = Math.round(srcW * scale), tgtH = Math.round(srcH * scale);
  const rgba = scale < 1 ? raw.rgb_to_rgba(raw.downscale_rgb(rgb, srcW, srcH, tgtW, tgtH)) : raw.rgb_to_rgba(rgb);
  return { rgba: new Uint8Array(rgba), tgtW, tgtH, file: basename(path) };
}

export function perceptualComparer(sourceRgba, w, h) { return new PerceptualComparer(sourceRgba, w, h); }

// Standard-scale (p3) butteraugli via libjxl bridge (0=identical, ~1.0=imperceptible, >2.0=noticeable).
// Used for quality parity; PerceptualComparer.butteraugli is a different, compressed scale (~10x smaller)
// that made tol=0.15 swamp the whole range — see plan Task 8. SSIM still comes from PerceptualComparer.
export async function butteraugliDistance(refRgba, testRgba, w, h) {
  return facade.computeButteraugli(refRgba, testRgba, w, h);
}

// ── 16-bit helpers ──────────────────────────────────────────────────────────

// Load a RAW file and return a display-referred, oriented, full-range RGBA16
// Uint16Array scaled to the long-edge TARGET (1920).
export async function loadTarget16(path) {
  const ext = extname(path).toLowerCase();
  const bytes = new Uint8Array(readFileSync(path));
  let decoded;
  if (ext === ".orf" || ext === ".raw") decoded = raw.process_orf_with_flags(bytes, 32, ...PROCESS_ARGS);
  else if (ext === ".cr2")             decoded = raw.process_cr2_with_flags(bytes, 32, ...PROCESS_ARGS);
  else if (ext === ".dng")             decoded = raw.process_dng_with_flags(bytes, 32, ...PROCESS_ARGS);
  else throw new Error(`loadTarget16: unsupported ext ${ext}`);
  const rgb16 = decoded.take_rgb16_disp();
  const srcW = decoded.disp16_w, srcH = decoded.disp16_h;
  decoded.free();
  const longEdge = Math.max(srcW, srcH);
  const scale = longEdge > TARGET ? TARGET / longEdge : 1;
  const tgtW = Math.round(srcW * scale), tgtH = Math.round(srcH * scale);
  const scaled16 = scale < 1 ? raw.downscale_rgb16_pub(rgb16, srcW, srcH, tgtW, tgtH) : rgb16;
  const rgba16 = raw.rgb16_to_rgba16(scaled16);
  return { rgba16: new Uint16Array(rgba16), tgtW, tgtH, file: basename(path) };
}

// Mirror of makeJxlAdapter but with format:'rgba16'.
// encode() accepts a Uint16Array (RGBA16 LE) and returns Uint8Array JXL bytes.
// decode() returns { data: Uint16Array, width, height, firstFrameMs }.
export function makeJxlAdapter16() {
  // Produce a tight Uint8Array byte-view of a Uint16Array for pushPixels.
  const u16ToBytes = (u16) => {
    const u8 = new Uint8Array(u16.buffer, u16.byteOffset, u16.byteLength);
    return exactBuffer(u8);
  };
  return {
    key: "jxl16", runtime: "wasm", lossless: false,
    async encode(rgba16, w, h, quality) {
      const encoder = facade.createEncoder({
        format: "rgba16", width: w, height: h, hasAlpha: true,
        iccProfile: null, exif: null, xmp: null,
        quality, effort: 3,
        progressive: true, progressiveFlavor: "ac", previewFirst: false, chunked: true,
      });
      const chunks = [];
      const collect = (async () => { for await (const c of encoder.chunks()) chunks.push(c instanceof Uint8Array ? c : new Uint8Array(c)); })();
      await encoder.pushPixels(u16ToBytes(rgba16));
      await encoder.finish();
      await collect;
      await encoder.dispose();
      let n = 0; for (const c of chunks) n += c.length;
      const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    },
    async decode(bytes) {
      const decoder = facade.createDecoder({ format: "rgba16", progressionTarget: "final", emitEveryPass: true, progressiveDetail: "passes", preserveIcc: false, preserveMetadata: false });
      let firstFrameMs = null, pixels = null, width = 0, height = 0;
      const t0 = performance.now();
      const ev = (async () => {
        for await (const e of decoder.events()) {
          if (e.type === "progress" || e.type === "final") {
            if (firstFrameMs === null) firstFrameMs = performance.now() - t0;
            // Dimensions are on e.info, not directly on e (e.width is undefined).
            if (e.pixels) { pixels = e.pixels; width = e.info?.width ?? width; height = e.info?.height ?? height; }
          } else if (e.type === "error") throw new Error(`${e.code}: ${e.message}`);
        }
      })();
      await decoder.push(exactBuffer(bytes));
      await decoder.close();
      await ev;
      await decoder.dispose();
      // pixels is ArrayBuffer | Uint8Array of LE uint16 pairs — wrap as Uint16Array.
      let data;
      if (pixels instanceof ArrayBuffer) {
        data = new Uint16Array(pixels);
      } else {
        data = new Uint16Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 2);
      }
      return { data, width, height, firstFrameMs: firstFrameMs ?? (performance.now() - t0) };
    },
  };
}

// Returns an async function that encodes a gradient at quality 98, decodes it,
// and returns the mean absolute error (per channel value, 0-65535 scale).
// Used by driver scripts and integration tests.
export function roundtripRgba16(adapter) {
  return async (w = 32, h = 32) => {
    const src = new Uint16Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      src[i]   = ((x * 65535 / (w - 1)) | 0);
      src[i+1] = ((y * 65535 / (h - 1)) | 0);
      src[i+2] = (((x + y) * 65535 / (w + h - 2)) | 0);
      src[i+3] = 0xFFFF;
    }
    const bytes = await adapter.encode(src, w, h, 98);
    const dec = await adapter.decode(bytes);
    let e = 0;
    for (let i = 0; i < src.length; i++) e += Math.abs(src[i] - dec.data[i]);
    return e / src.length;
  };
}

// Compute butteraugli distance between two RGBA16 Uint16Arrays.
// Returns null when facade.computeButteraugli16 is absent (not yet shipped)
// or throws CapabilityMissing.
export async function butteraugliDistance16(refRgba16, testRgba16, w, h) {
  if (typeof facade.computeButteraugli16 !== "function") return null;
  try {
    const toBytes = (u16) => new Uint8Array(u16.buffer, u16.byteOffset, u16.byteLength);
    return await facade.computeButteraugli16(toBytes(refRgba16), toBytes(testRgba16), w, h);
  } catch (err) {
    if (err && err.name === "CapabilityMissing") return null;
    throw err;
  }
}

// ── 8-bit adapter ────────────────────────────────────────────────────────────

// JXL adapter — distance 1.0 anchor. Encode/decode settings mirror encodeJxl/decodeJxl in the standard test.
export function makeJxlAdapter() {
  return {
    key: "jxl", runtime: "wasm", lossless: false,
    // Quality-parametric encode for RD sweeps (facade maps quality -> distance, verified monotonic).
    async encode(rgba, w, h, quality) {
      const encoder = facade.createEncoder({
        format: "rgba8", width: w, height: h, hasAlpha: true,
        iccProfile: null, exif: null, xmp: null,
        quality, effort: 3,
        progressive: true, progressiveFlavor: "ac", previewFirst: false, chunked: true,
      });
      const chunks = [];
      const collect = (async () => { for await (const c of encoder.chunks()) chunks.push(c instanceof Uint8Array ? c : new Uint8Array(c)); })();
      await encoder.pushPixels(exactBuffer(rgba));
      await encoder.finish();
      await collect;
      await encoder.dispose();
      let n = 0; for (const c of chunks) n += c.length;
      const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    },
    // Lossless encode (JXL's strength). Tries facade lossless flags; throws if unsupported (caller skips).
    async encodeLossless(rgba, w, h) {
      const opts = { format: "rgba8", width: w, height: h, hasAlpha: true, iccProfile: null, exif: null, xmp: null, effort: 3, chunked: true };
      for (const extra of [{ lossless: true }, { distance: 0 }, { quality: 100, distance: 0 }]) {
        try {
          const encoder = facade.createEncoder({ ...opts, ...extra });
          const chunks = [];
          const collect = (async () => { for await (const c of encoder.chunks()) chunks.push(c instanceof Uint8Array ? c : new Uint8Array(c)); })();
          await encoder.pushPixels(exactBuffer(rgba));
          await encoder.finish();
          await collect;
          await encoder.dispose();
          let n = 0; for (const c of chunks) n += c.length;
          if (n === 0) continue;
          const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
          return out;
        } catch (_) { /* try next flag combo */ }
      }
      throw new Error("facade lossless unsupported");
    },
    async encodeAnchor(rgba, w, h) {
      const encoder = facade.createEncoder({
        format: "rgba8", width: w, height: h, hasAlpha: true,
        iccProfile: null, exif: null, xmp: null,
        distance: 1.0, quality: 85, effort: 3,
        progressive: true, progressiveFlavor: "ac", previewFirst: false, chunked: true,
      });
      const chunks = [];
      const collect = (async () => { for await (const c of encoder.chunks()) chunks.push(c instanceof Uint8Array ? c : new Uint8Array(c)); })();
      await encoder.pushPixels(exactBuffer(rgba));
      await encoder.finish();
      await collect;
      await encoder.dispose();
      let n = 0; for (const c of chunks) n += c.length;
      const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    },
    async decode(bytes) {
      const decoder = facade.createDecoder({ format: "rgba8", progressionTarget: "final", emitEveryPass: true, progressiveDetail: "passes", preserveIcc: false, preserveMetadata: false });
      let firstFrameMs = null, pixels = null, width = 0, height = 0;
      const t0 = performance.now();
      const ev = (async () => {
        for await (const e of decoder.events()) {
          if (e.type === "progress" || e.type === "final") {
            if (firstFrameMs === null) firstFrameMs = performance.now() - t0;
            if (e.pixels) { pixels = e.pixels; width = e.info?.width ?? width; height = e.info?.height ?? height; }
          } else if (e.type === "error") throw new Error(`${e.code}: ${e.message}`);
        }
      })();
      await decoder.push(exactBuffer(bytes));
      await decoder.close();
      await ev;
      await decoder.dispose();
      return { data: new Uint8Array(pixels.buffer ?? pixels), width, height, firstFrameMs: firstFrameMs ?? (performance.now() - t0) };
    },
  };
}
