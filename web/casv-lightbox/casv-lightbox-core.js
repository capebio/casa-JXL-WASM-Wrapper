// casv-lightbox-core — DOM-free logic for the CASAVA video lightbox.
//
// Kept free of `window`/`document`/Tauri so it is unit-testable under
// `node --test`. The UI (casv-lightbox.js) and platform adapter
// (casv-platform.js) import from here; nothing here imports them.

/** JOLT / archive encode presets. Mirrors JoltPreset + CasaVideoOptions in
 *  crates/raw-pipeline/src/casa_video.rs. Distances are butteraugli. */
export const PRESETS = {
  realtime: { label: 'Realtime', rate: 'lossy', distance: 2.0, effort: 1, skip: 'tile', tile: 32,
    hint: 'Fastest encode, largest of the lossy files. Good for live capture and quick previews.' },
  balanced: { label: 'Balanced', rate: 'lossy', distance: 1.0, effort: 3, skip: 'tile', tile: 32,
    hint: 'Recommended. Near-transparent quality at a sensible size and speed.' },
  quality: { label: 'Quality', rate: 'lossy', distance: 0.5, effort: 4, skip: 'bbox', tile: 32,
    hint: 'Higher quality, slower encode, bigger files. For showcase clips.' },
  archive: { label: 'Lossless archive', rate: 'lossless', distance: 0, effort: 7, skip: 'none', tile: 32,
    hint: 'Mathematically lossless — every pixel preserved. Largest files; decodes on desktop only.' },
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

const basename = (path) => String(path || '').split(/[\\/]/).pop() || String(path || '');
const extOf = (path) => {
  const m = String(path || '').toLowerCase().match(/\.([^.\\/]+)$/);
  return m ? m[1] : '';
};
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp', 'exr', 'ppm', 'jxl']);
const ENCODE_EXTS = new Set([...VIDEO_EXTS, ...IMAGE_EXTS]);

export function shouldHandleEncodeDrop(namesOrPaths) {
  const all = Array.isArray(namesOrPaths) ? namesOrPaths.filter(Boolean).map(String) : [];
  return all.some((p) => ENCODE_EXTS.has(extOf(p)));
}

export function classifyDroppedEncodePaths(paths, preferredSourceKind = 'video') {
  const all = Array.isArray(paths) ? paths.filter(Boolean).map(String) : [];
  const videos = all.filter((p) => VIDEO_EXTS.has(extOf(p)));
  const images = all.filter((p) => IMAGE_EXTS.has(extOf(p)));
  if (videos.length) {
    return { sourceKind: 'video', inputPaths: [videos[0]], label: basename(videos[0]) };
  }
  if (images.length) {
    return {
      sourceKind: 'images',
      inputPaths: images,
      label: `${images.length} image${images.length === 1 ? '' : 's'} selected`,
    };
  }
  const fallback = preferredSourceKind === 'images' ? 'images' : 'video';
  return { sourceKind: fallback, inputPaths: [], label: 'none selected' };
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
 * form: { sourceKind, inputPaths[], rate, distance, effort, gop, skip, tile,
 *         thresh?, dim?, autoFps?, fpsNum, fpsDen, outputPath? }
 * Throws Error (with .code) on invalid input so the UI can surface it.
 */
export function buildEncodeRequest(form) {
  const paths = Array.isArray(form.inputPaths) ? form.inputPaths.filter(Boolean) : [];
  const sourceKind = form.sourceKind === 'video' ? 'video' : 'images';
  if (paths.length === 0) {
    const e = new Error(sourceKind === 'video'
      ? 'Pick an MP4, WEBM, MOV, or MKV to encode.'
      : 'Pick at least one image to encode.');
    e.code = 'NO_INPUT';
    throw e;
  }
  if (sourceKind === 'video' && paths.length !== 1) {
    const e = new Error('Pick exactly one video to encode.');
    e.code = 'BAD_INPUT';
    throw e;
  }
  const rate = form.rate === 'lossless' ? 'lossless' : 'lossy';
  const skip = ['none', 'bbox', 'tile'].includes(form.skip) ? form.skip : 'none';
  const distance = rate === 'lossless' ? 0 : CLAMP(form.distance, 0.1, 15, 1.0);
  const effort = Math.round(CLAMP(form.effort, 1, 10, rate === 'lossless' ? 7 : 3));
  const gop = Math.round(CLAMP(form.gop, 1, 600, 24));
  const tile = Math.round(CLAMP(form.tile, 8, 512, 32));
  const autoFps = sourceKind === 'video' && form.autoFps !== false;
  const fpsNum = autoFps ? 0 : Math.round(CLAMP(form.fpsNum, 1, 240000, 24));
  const fpsDen = Math.round(CLAMP(form.fpsDen, 1, 1001, 1));
  const thresh = form.thresh == null || form.thresh === ''
    ? defaultThreshForDistance(distance)
    : Math.round(CLAMP(form.thresh, 0, 255, 0));
  const dim = sourceKind === 'video'
    ? (['exact', '2160', '1440', '1080', '720', '512'].includes(String(form.dim)) ? String(form.dim) : 'exact')
    : null;

  return {
    sourceKind,
    inputPaths: paths,
    rate, distance, effort, gop, skip, tile, thresh,
    fpsNum, fpsDen, dim,
    outputPath: form.outputPath || null,
  };
}
