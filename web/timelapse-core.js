// timelapse-core — DOM-free logic for the RAW time-lapse studio (K4).
//
// Kept free of `window`/`document`/Tauri and of the WASM pkg so it is unit-
// testable under `node --test`. The UI (timelapse.js) imports from here.
//
// The studio turns a sorted sequence of RAW stills (ORF / DNG / CR2) into a
// CASAVA (.casv) time-lapse by driving the native `casv_encode --raw-frames`
// sidecar (see crates/raw-pipeline/src/bin/casv_encode.rs). Browser-side full-
// sequence encode is infeasible — each 20 MP frame needs tens of MB of WASM
// heap and libjxl video encode is native-only — so encoding is a desktop
// (Tauri) capability; the browser build previews + documents the CLI.

import { defaultThreshForDistance } from './casv-lightbox/casv-lightbox-core.js';

/** RAW extensions the WASM decoder + RawVideoSource actually support. */
export const RAW_EXTS = new Set(['orf', 'dng', 'cr2']);

const basename = (path) => String(path || '').split(/[\\/]/).pop() || String(path || '');

export function extOf(path) {
  const m = String(path || '').toLowerCase().match(/\.([^.\\/]+)$/);
  return m ? m[1] : '';
}

/** True when `name` looks like a RAW still we can decode (by extension). */
export function isRawName(name) {
  return RAW_EXTS.has(extOf(name));
}

/**
 * Sort RAW file paths alphabetically by basename (case-insensitive, numeric-
 * aware), preserving capture order for the typical `PxxxxNNNN.ORF` naming. The
 * comparison is stable and does not mutate the input. Non-RAW entries are kept
 * (the caller decides whether to filter) but sorted alongside.
 */
export function sortRawPaths(paths) {
  const arr = (Array.isArray(paths) ? paths : []).filter(Boolean).map(String);
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return arr.slice().sort((a, b) => coll.compare(basename(a), basename(b)));
}

/** Suggested output filename for a sequence: `<first-stem>-timelapse.casv`. */
export function suggestTimelapseName(paths) {
  const first = basename((Array.isArray(paths) && paths[0]) || '');
  const stem = first.replace(/\.[^.]+$/, '') || 'timelapse';
  return `${stem}-timelapse.casv`;
}

const CLAMP = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
};

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** Valid `dim` (longest-edge cap) values the sidecar accepts (`exact` = native). */
export const DIM_CHOICES = ['exact', '2160', '1440', '1080', '720', '512'];

/**
 * Validate + normalize a time-lapse encode form into the request object the UI
 * hands to the native command (and, ultimately, `rawFramesSidecarArgs`). Pure:
 * no I/O, no DOM. Paths are sorted here so the request order == capture order.
 *
 * form: { inputPaths[], rate?, distance?, effort?, gop?, skip?, tile?, thresh?,
 *         dim?, fpsNum?, fpsDen?, outputPath? }
 * Throws Error (with `.code`) on invalid input so the UI can surface it.
 */
export function buildRawEncodeRequest(form) {
  const inputPaths = sortRawPaths(Array.isArray(form.inputPaths) ? form.inputPaths : []);
  if (inputPaths.length === 0) {
    throw err('NO_INPUT', 'Add at least one ORF, DNG, or CR2 file.');
  }
  const rate = form.rate === 'lossless' ? 'lossless' : 'lossy';
  // Lossy streams only through bbox/tile REPLACE (skip=none lossy is rejected by
  // the encoder — VarDCT whole-frame residual is invalid). Lossless routes to the
  // batch encoder, which accepts none/bbox/tile.
  const skip = rate === 'lossless'
    ? (['none', 'bbox', 'tile'].includes(form.skip) ? form.skip : 'bbox')
    : (['bbox', 'tile'].includes(form.skip) ? form.skip : 'tile');
  const distance = rate === 'lossless' ? 0 : CLAMP(form.distance, 0.1, 15, 1.0);
  const effort = Math.round(CLAMP(form.effort, 1, 10, rate === 'lossless' ? 7 : 3));
  const gop = Math.round(CLAMP(form.gop, 1, 600, 24));
  const tile = Math.round(CLAMP(form.tile, 8, 512, 32));
  const fpsNum = Math.round(CLAMP(form.fpsNum, 1, 240, 24));
  const fpsDen = Math.round(CLAMP(form.fpsDen, 1, 1001, 1));
  const thresh = form.thresh == null || form.thresh === ''
    ? null // → sidecar `auto` (= default_thresh_for_distance)
    : Math.round(CLAMP(form.thresh, 0, 255, defaultThreshForDistance(distance)));
  const dim = DIM_CHOICES.includes(String(form.dim)) ? String(form.dim) : 'exact';

  return {
    sourceKind: 'raw',
    inputPaths,
    rate, distance, effort, gop, skip, tile, thresh,
    fpsNum, fpsDen, dim,
    outputPath: form.outputPath || null,
    outputName: suggestTimelapseName(inputPaths),
  };
}

/**
 * The exact `casv_encode` argv for a request — the single source of truth for
 * the RAW time-lapse CLI. Mirrors `run_raw_frames_mode` in
 * crates/raw-pipeline/src/bin/casv_encode.rs:
 *
 *   casv_encode --raw-frames <out> <fps_num> <fps_den> <rate> <distance>
 *               <effort> <gop> <skip> <tile> <thresh|auto> <dim> <file...>
 *
 * `outPath` is where the sidecar writes the `.casv` (chosen by the native save
 * dialog on the desktop side). Returned as an array so the Tauri command can
 * spawn it without shell-quoting pitfalls.
 */
export function rawFramesSidecarArgs(request, outPath) {
  const thresh = request.thresh == null ? 'auto' : String(request.thresh);
  return [
    '--raw-frames',
    String(outPath),
    String(request.fpsNum),
    String(request.fpsDen),
    request.rate,
    String(request.distance),
    String(request.effort),
    String(request.gop),
    request.skip,
    String(request.tile),
    thresh,
    request.dim,
    ...request.inputPaths,
  ];
}

/** Human-readable one-line CLI for display / copy (quotes paths with spaces). */
export function rawFramesCliString(request, outPath = 'out.casv') {
  const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
  return ['casv_encode', ...rawFramesSidecarArgs(request, outPath)].map(q).join(' ');
}

// ── Selected-asset timelapse helpers (Finding 15) ───────────────────────────
// Pure logic for sequential reads, memory budget, cancellation, per-asset edits.
// No DOM, no WASM import — all injectable so the unit tests can drive without
// a browser or built pkg.

/**
 * Filter and sort cards to just the selected subset, in capture order (numeric-
 * aware by name so the sequence matches `sortRawPaths`).
 *
 * @param {Array<{ assetId: string, name: string, selected?: boolean }>} cards
 * @returns {Array}
 */
export function filterSelectedAssets(cards) {
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return (Array.isArray(cards) ? cards : [])
    .filter((c) => c.selected)
    .slice()
    .sort((a, b) => coll.compare(a.name, b.name));
}

/**
 * Map a look-params object from the per-asset edit store to the **14-element**
 * positional f32 array that the WASM RAW decoders (`process_orf` /
 * `process_dng` / `process_cr2`) accept, in `src/lib.rs` order (identical to
 * `web/worker.js` RAW_NEUTRAL and to the neutral call in `decodeRawNeutralRgb`):
 *
 *   0 exposure_ev  1 contrast   2 highlights  3 shadows  4 whites   5 blacks
 *   6 saturation   7 vibrance   8 temp        9 tint     10 wb_r    11 wb_b
 *   12 texture     13 clarity
 *
 * Look-edit field names mirror `panels.js` LOOK_PARAMS (`exposureEv`, not
 * `exposure`). WB overrides (slots 10, 11) default to NaN = use each file's
 * embedded camera white balance — the right default for a locked time-lapse
 * where WB is consistent across the run. Fields with no decoder slot (there is no
 * `hue`/`sharpness`/`denoise`/`wbG` decoder param) are ignored.
 *
 * @param {{ exposureEv?: number, contrast?: number, highlights?: number,
 *            shadows?: number, whites?: number, blacks?: number,
 *            saturation?: number, vibrance?: number, temp?: number, tint?: number,
 *            wbR?: number, wbB?: number, texture?: number, clarity?: number }} look
 * @returns {number[]} 14-element positional array
 */
export function applyLookToDecodeArgs(look = {}) {
  const g = (k, dflt) => {
    const v = look[k];
    return (v !== undefined && v !== null && typeof v === 'number') ? v : dflt;
  };
  return [
    g('exposureEv',  0),   // 0  exposure_ev
    g('contrast',    0),   // 1  contrast
    g('highlights',  0),   // 2  highlights
    g('shadows',     0),   // 3  shadows
    g('whites',      0),   // 4  whites
    g('blacks',      0),   // 5  blacks
    g('saturation',  0),   // 6  saturation
    g('vibrance',    0),   // 7  vibrance
    g('temp',        0),   // 8  temp
    g('tint',        0),   // 9  tint
    g('wbR',         NaN), // 10 wb_r_override (NaN → camera WB)
    g('wbB',         NaN), // 11 wb_b_override (NaN → camera WB)
    g('texture',     0),   // 12 texture
    g('clarity',     0),   // 13 clarity
  ];
}

/**
 * Create a lightweight cancel token.
 * @returns {{ cancel(): void, isCancelled(): boolean }}
 */
export function makeTimelapseCancelToken() {
  let cancelled = false;
  return {
    cancel: () => { cancelled = true; },
    isCancelled: () => cancelled,
  };
}

/**
 * Async generator: yield `{ assetId, name, bytes }` for each card, one at a
 * time, honouring the memory budget and cancel token.
 *
 * - Reads cards sequentially (never starts the next read until the current frame
 *   has been consumed by the caller), so peak memory is one frame at a time and a
 *   byte budget is intrinsically satisfied — no gate needed. `maxBytesInFlight`
 *   is accepted for call-site compatibility but is deliberately NOT used to drop
 *   frames: dropping a valid frame would silently corrupt the time-lapse.
 * - Skips cards where `readBytes` returns null or undefined (Tauri fs unavailable,
 *   no file attached, etc.).
 *
 * @param {Array<{ assetId: string, name: string }>} cards
 * @param {(card: object) => Promise<Uint8Array|null>} readBytes
 * @param {{ isCancelled?: () => boolean, maxBytesInFlight?: number }} opts
 */
export async function* buildSequentialFrames(cards, readBytes, {
  isCancelled = () => false,
} = {}) {
  for (const card of cards) {
    if (isCancelled()) return;
    // Strictly sequential: we do not start the next read until the caller has
    // consumed (yielded) the current frame, so only one frame is ever in flight.
    const bytes = await readBytes(card);
    if (!bytes) continue;
    yield { assetId: card.assetId, name: card.name, bytes, look: card.look ?? {} };
  }
}

/**
 * Build an ExportService request from selected timelapse cards.
 *
 * @param {Array<{ assetId: string }>} cards
 * @param {{ output?: string, metadata?: string }} opts
 * @returns {{ assetIds: string[], output: string, metadata: string, resolution: string }}
 */
export function buildTimelapseExportRequest(cards, opts = {}) {
  return {
    assetIds: (Array.isArray(cards) ? cards : []).map((c) => c.assetId),
    output:   opts.output   ?? 'jxl',
    metadata: opts.metadata ?? 'keep',
    resolution: 'full',
  };
}

// ── Pure-web (no-sidecar) FableBraid encode ─────────────────────────────────
// These take the initialised WASM module as an argument (dependency injection),
// so this file stays free of a hard `./pkg` import and remains node-testable.

/** Pick the WASM RAW decoder export for a filename (by extension). */
export function pickRawDecoder(mod, name) {
  switch (extOf(name)) {
    case 'orf': return mod.process_orf;
    case 'dng': return mod.process_dng;
    case 'cr2': return mod.process_cr2;
    default: throw err('UNSUPPORTED_RAW', 'unsupported RAW: ' + name);
  }
}

/**
 * Decode one RAW still to oriented full-res **neutral** RGB8 `{ rgb, w, h }`.
 * Positional look args mirror `src/lib.rs` (all sliders 0; WB `NaN` = keep each
 * file's metadata white balance, constant for a locked time-lapse). Moves the RGB
 * out and frees the `ProcessResult`.
 */
export function decodeRawNeutralRgb(mod, bytes, name) {
  const fn = pickRawDecoder(mod, name);
  const r = fn(bytes, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
  try {
    return { rgb: r.take_rgb(), w: r.width, h: r.height };
  } finally {
    r.free();
  }
}

/**
 * Encode a RAW still sequence to a **FableBraid lossless** `.casv`, entirely
 * in-process via the WASM `FableVideoEncoder` — the pure-web (no native sidecar)
 * time-lapse path. `frames` is `[{ bytes: Uint8Array, name }]` in capture order;
 * every frame must decode to the same dimensions (locked time-lapse). Returns the
 * `.casv` bytes (Uint8Array). `onProgress(done, total)` fires per encoded frame.
 *
 * Lossless-only: the FableBraid tier ignores rate/distance/effort (those are the
 * libjxl tiers, native-only). Memory note: compressed frames accumulate in WASM
 * memory until `finish()`, so cap the count or pre-downscale very long / full-res
 * clips to stay under the heap ceiling.
 */
export function encodeFableTimelapse(mod, frames, opts = {}, onProgress = () => {}) {
  const list = Array.isArray(frames) ? frames : [];
  if (list.length === 0) throw err('NO_INPUT', 'no frames to encode');
  if (typeof mod.FableVideoEncoder !== 'function') {
    throw err('NO_ENCODER', 'this WASM build has no FableVideoEncoder (rebuild web/pkg)');
  }
  const fpsNum = Math.round(CLAMP(opts.fpsNum, 1, 240, 24));
  const fpsDen = Math.round(CLAMP(opts.fpsDen, 1, 1001, 1));
  const gop = Math.round(CLAMP(opts.gop, 1, 600, 24));

  const first = decodeRawNeutralRgb(mod, list[0].bytes, list[0].name);
  const { w, h } = first;
  let enc = new mod.FableVideoEncoder(w, h, fpsNum, fpsDen, gop);
  try {
    enc.push_rgb8(first.rgb);
    onProgress(1, list.length);
    for (let i = 1; i < list.length; i++) {
      const f = decodeRawNeutralRgb(mod, list[i].bytes, list[i].name);
      if (f.w !== w || f.h !== h) {
        throw err('DIM_MISMATCH',
          `frame ${i} (${list[i].name}) is ${f.w}x${f.h}, expected ${w}x${h} — time-lapse frames must match`);
      }
      enc.push_rgb8(f.rgb);
      onProgress(i + 1, list.length);
    }
    const out = enc.finish(); // consumes the encoder
    enc = null;
    return out;
  } finally {
    if (enc) { try { enc.free(); } catch (_) { /* not yet consumed */ } }
  }
}
