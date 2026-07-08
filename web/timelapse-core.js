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
