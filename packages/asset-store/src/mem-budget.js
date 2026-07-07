// RAW-decode memory preflight — a pure JS mirror of the Rust
// `crates/raw-pipeline/src/mem_budget.rs` model (and its wasm-bindgen export
// `estimate_decode_peak` in `src/lib.rs`).
//
// WHY a JS re-implementation instead of calling the WASM export: the export
// exists in the Rust source but the shipped `web/pkg/raw_converter_wasm.js` was
// NOT rebuilt to surface it (verified 2026-07-07 — the symbol is absent from the
// shipped bindings), and rebuilding WASM is out of scope for this pass. The model
// is pure integer arithmetic (no image data, no alloc), so a faithful port gives
// the browser an admission preflight today; swap it for the WASM export once the
// pkg is rebuilt. Kept in @casabio/asset-store (not the JXL facade) because the
// S3 ADR pairs this estimate with the AssetStore governor, and — like
// `fitWithinBudget` — it is admission math the governor consults. Node-testable,
// no WASM dependency.
//
// The Rust module has a compile-time `assert!` pinning these OUT_* bits to the
// private `OUT_*` in `src/lib.rs`; the parity test (`test/mem-budget.test.js`)
// pins THIS port to the Rust model's documented worked numbers.
//
// See `docs/adr/S3-memory-budget.md` for the derivation and the model-vs-observed
// (~1.3–1.6× RSS) relationship that motivates the admission safety multiplier.

/** Full-resolution RGB8 tone output (u8 × 3ch — the JXL-encode buffer). */
export const OUT_FULL_RGB8 = 1;
/** 1800 px RGB16 lightbox preview (packed LE, 6 B/px). */
export const OUT_LIGHTBOX = 2;
/** 360 px RGB16 thumbnail preview (packed LE, 6 B/px). */
export const OUT_THUMB = 4;
/** Full-resolution RGB16 master (u16 × 3ch). */
export const OUT_FULL_16 = 8;
/** Skip the CPU orientation rotate on the full RGB8 output. */
export const OUT_NO_ORIENT = 16;
/** Full-resolution display-referred RGB16 (u16 × 3ch, oriented). */
export const OUT_FULL_DISP16 = 32;

/** The shipping batch-encode flag set (RGB8 + lightbox + thumbnail) — the Rust
 * model's "shipping 7". This is what the browser RAW pipeline requests for a
 * card decode, so it is the default flag set for a pre-decode preflight. */
export const OUT_BATCH_DEFAULT = OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB;

/** Long-edge target of the lightbox preview (px). Matches `target_dims(_,1800)`. */
const LIGHTBOX_LONG_EDGE = 1800;
/** Long-edge target of the thumbnail preview (px). Matches `target_dims(_,360)`. */
const THUMB_LONG_EDGE = 360;

// Float64 holds integers exactly to 2^53; every product below is exact for real
// image dimensions (n <= ~1e8, peak <= ~21n ≈ 2e9). For absurd dimensions the
// Rust `u64` saturates at u64::MAX; here we clamp to MAX_SAFE_INTEGER so the
// result stays a large finite integer (never wraps to a small value), mirroring
// the "over-reserve is the safe direction" intent.
const SAT = Number.MAX_SAFE_INTEGER;
const clamp = (x) => (x >= SAT ? SAT : x < 0 ? 0 : x);

const has = (flags, bit) => (flags & bit) !== 0;

/**
 * Long-edge preserving downscale target, mirroring `target_dims` / `preview_pixels`
 * in the Rust crate. Returns the preview pixel count `dw * dh` (never upsamples).
 * @param {number} w
 * @param {number} h
 * @param {number} longEdge
 * @returns {number}
 */
function previewPixels(w, h, longEdge) {
  if (w === 0 || h === 0) return 0;
  if (w >= h) {
    const lw = Math.min(w, longEdge);
    const lh = Math.max(Math.floor((h * lw) / w), 1);
    return lw * lh;
  }
  const lh = Math.min(h, longEdge);
  const lw = Math.max(Math.floor((w * lh) / h), 1);
  return lw * lh;
}

/**
 * @typedef {Object} DecodePeakEstimate
 * @property {number} width
 * @property {number} height
 * @property {number} outputFlags
 * @property {number} pixels          `width * height`
 * @property {number} retainedBytes   bytes held in the returned ProcessResult
 * @property {number} peakBytes       transient working-set high-water (>= retainedBytes)
 */

/**
 * Project the decode peak / retained working set for a `width`×`height`
 * (active-area, pre-orientation) frame and the given `outputFlags` bitset. Pure
 * arithmetic — no allocation, no image data. Faithful port of
 * `raw_pipeline::mem_budget::estimate_decode_peak`. Field names are camelCased
 * for JS (`retained_bytes` → `retainedBytes`, `peak_bytes` → `peakBytes`).
 *
 * @param {number} width
 * @param {number} height
 * @param {number} outputFlags
 * @returns {DecodePeakEstimate}
 */
export function estimateDecodePeak(width, height, outputFlags) {
  const w = Math.max(0, Math.floor(width) || 0);
  const h = Math.max(0, Math.floor(height) || 0);
  const flags = outputFlags >>> 0;
  const n = clamp(w * h);

  // Per-buffer byte sizes for a full-frame buffer.
  const raw = clamp(n * 2); //   u16 mosaic
  const rgb16 = clamp(n * 6); // u16 × 3
  const rgb8 = clamp(n * 3); //  u8  × 3

  const wantRgb8 = has(flags, OUT_FULL_RGB8);
  const wantFull16 = has(flags, OUT_FULL_16);
  const wantDisp16 = has(flags, OUT_FULL_DISP16);
  const wantLb = has(flags, OUT_LIGHTBOX);
  const wantThumb = has(flags, OUT_THUMB);
  const needFullRgb = wantRgb8 || wantFull16 || wantDisp16;
  // True EXIF orientation is unknown at preflight; assume a rotate unless the
  // caller explicitly skips orientation. Conservative (over-reserves).
  const rotate = !has(flags, OUT_NO_ORIENT);

  // Retained previews (packed LE, 6 B/px).
  const lbBytes = wantLb ? clamp(previewPixels(w, h, LIGHTBOX_LONG_EDGE) * 6) : 0;
  const thumbBytes = wantThumb ? clamp(previewPixels(w, h, THUMB_LONG_EDGE) * 6) : 0;
  const previewRetained = clamp(lbBytes + thumbBytes);

  // ---- retainedBytes: what survives in ProcessResult ----
  let retained = previewRetained;
  if (wantRgb8) retained = clamp(retained + rgb8);
  if (wantFull16) retained = clamp(retained + rgb16); // Vec<u16> (6n bytes), packed lazily
  if (wantDisp16) retained = clamp(retained + rgb16);

  // ---- peakBytes: max simultaneously-live over the heavy stages ----
  // Stage 1 — decode + demosaic: RAW mosaic + RGB16 coexist whenever any output
  // (full-res or preview) is materialized.
  const stageDecode = needFullRgb || wantLb || wantThumb ? clamp(raw + rgb16) : 0;

  // Stage 2 — render (tone / display-referred / orientation).
  let stageRender = 0;
  if (wantRgb8) {
    const dispTerm = wantDisp16 ? (rotate ? clamp(rgb16 * 2) : rgb16) : 0;
    const duringDisp = clamp(rgb16 + rgb8 + dispTerm);
    // After RGB16 is moved into the full-16 master (or dropped) and disp16 is
    // done, the RGB8 orientation rotate holds src+dst alongside retained buffers.
    const orientRgb8 = rotate ? clamp(rgb8 * 2) : rgb8;
    const full16Ret = wantFull16 ? rgb16 : 0;
    const disp16Ret = wantDisp16 ? rgb16 : 0;
    const afterMove = clamp(orientRgb8 + full16Ret + disp16Ret);
    stageRender = Math.max(duringDisp, afterMove);
  } else if (wantFull16 || wantDisp16) {
    // No RGB8 tone output; RGB16 live, plus a disp16 rotate transient.
    const dispTerm = wantDisp16 ? (rotate ? clamp(rgb16 * 2) : rgb16) : 0;
    stageRender = clamp(rgb16 + dispTerm);
  }

  const peak = clamp(Math.max(stageDecode, stageRender) + previewRetained);

  return {
    width: w,
    height: h,
    outputFlags: flags,
    pixels: n,
    retainedBytes: retained,
    peakBytes: peak,
  };
}

/**
 * Convenience scalar form: the transient peak-bytes projection only. Mirrors the
 * Rust `estimate_decode_peak_bytes()`.
 * @param {number} width
 * @param {number} height
 * @param {number} outputFlags
 * @returns {number} peak bytes
 */
export function estimateDecodePeakBytes(width, height, outputFlags) {
  return estimateDecodePeak(width, height, outputFlags).peakBytes;
}
