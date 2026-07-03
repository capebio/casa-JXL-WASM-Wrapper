// casv-lightbox-core — DOM-free logic for the CASAVA video lightbox.
//
// Kept free of `window`/`document`/Tauri so it is unit-testable under
// `node --test`. The UI (casv-lightbox.js) and platform adapter
// (casv-platform.js) import from here; nothing here imports them.

/** JOLT / archive encode presets. Mirrors JoltPreset + CasaVideoOptions in
 *  crates/raw-pipeline/src/casa_video.rs. Distances are butteraugli. */
export const PRESETS = {
  realtime: { label: 'Realtime', rate: 'lossy', distance: 2.0, effort: 1, skip: 'tile', tile: 64 },
  balanced: { label: 'Balanced', rate: 'lossy', distance: 1.0, effort: 3, skip: 'tile', tile: 64 },
  quality: { label: 'Quality', rate: 'lossy', distance: 0.5, effort: 4, skip: 'bbox', tile: 64 },
  archive: { label: 'Lossless archive', rate: 'lossless', distance: 0, effort: 7, skip: 'none', tile: 64 },
};

/** Auto threshold for near-static skip: distance*4, clamped to 16.
 *  Matches default_thresh_for_distance() in casa_video.rs. */
export function defaultThreshForDistance(distance) {
  const t = Math.round((Number(distance) || 0) * 4);
  return Math.max(0, Math.min(16, t));
}

/** Short badge for a frame's container entry (from casv-web CasvFrameEntry). */
export function frameKindLabel(entry) {
  if (!entry || !entry.isPFrame) return 'I';
  const kind = entry.isTile ? 'tile' : entry.isBbox ? 'bbox' : 'full';
  return entry.isReplace ? `P·${kind}·replace` : `P·${kind}`;
}

/** Human-readable rate summary from a casv-web CasvRate. */
export function formatRate(rate) {
  if (!rate) return 'unknown';
  if (rate.fable) return 'FableBraid (lossless, native-only decode)';
  if (!rate.lossy) return 'lossless';
  const d = rate.distance == null ? '?' : rate.distance.toFixed(1);
  const e = rate.effort || '?';
  return `lossy · d=${d} · effort ${e}`;
}

/** Frames-per-second from a header (fpsNum/fpsDen), guarding zero. */
export function fpsOf(header) {
  if (!header || !header.fpsDen) return 0;
  return header.fpsNum / header.fpsDen;
}

/** mm:ss.mmm for a frame index at a given fps (0 fps → frame count only). */
export function timecode(frameIndex, fps) {
  if (!fps || fps <= 0) return `#${frameIndex}`;
  const t = frameIndex / fps;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** Suggested export filename from an optional source name. */
export function suggestExportName(sourceName) {
  if (!sourceName) return 'casava-export.casv';
  const base = String(sourceName).replace(/\.[^.]+$/, '');
  return `${base || 'casava-export'}.casv`;
}

const CLAMP = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
};

/**
 * Validate + normalize an encode form into the argument object passed to the
 * Tauri `encode_casv_video` command. Pure: no I/O, no DOM.
 *
 * form: { inputPaths[], rate, distance, effort, gop, skip, tile, thresh?,
 *         fpsNum, fpsDen, outputPath? }
 * Throws Error (with .code) on invalid input so the UI can surface it.
 */
export function buildEncodeRequest(form) {
  const paths = Array.isArray(form.inputPaths) ? form.inputPaths.filter(Boolean) : [];
  if (paths.length === 0) {
    const e = new Error('Pick at least one image to encode.');
    e.code = 'NO_INPUT';
    throw e;
  }
  const rate = form.rate === 'lossless' ? 'lossless' : 'lossy';
  const skip = ['none', 'bbox', 'tile'].includes(form.skip) ? form.skip : 'none';
  const distance = rate === 'lossless' ? 0 : CLAMP(form.distance, 0.1, 15, 1.0);
  const effort = Math.round(CLAMP(form.effort, 1, 10, rate === 'lossless' ? 7 : 3));
  const gop = Math.round(CLAMP(form.gop, 1, 600, 24));
  const tile = Math.round(CLAMP(form.tile, 8, 512, 64));
  const fpsNum = Math.round(CLAMP(form.fpsNum, 1, 240000, 24));
  const fpsDen = Math.round(CLAMP(form.fpsDen, 1, 1001, 1));
  const thresh = form.thresh == null || form.thresh === ''
    ? defaultThreshForDistance(distance)
    : Math.round(CLAMP(form.thresh, 0, 255, 0));

  return {
    inputPaths: paths,
    rate, distance, effort, gop, skip, tile, thresh,
    fpsNum, fpsDen,
    outputPath: form.outputPath || null,
  };
}
