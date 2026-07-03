import { detectMonotone, computePsnrVsFinal, computeSsimVsFinal, computePsnrSsimFused } from './jxl-progressive-quality.js';
import { createButteraugliComparer } from './jxl-butteraugli.js';  // for buildSeries helper (cohesion)

export const RECOGNIZABLE_DB = 20;
export const PREVIEW_DB = 30;
export const GOOD_BUTTER = 1.0;
export const SSIM_GOOD = 0.8;
export const BUTTER_MONOTONE_TOL = 0.1;
export const SSIM_MONOTONE_TOL = 0.01; // SSIM is 0..1, not dB — needs its own tolerance scale

/**
 * Decide whether to invoke Butteraugli (expensive) for this cutoff index/bytes.
 * Reduces calls vs pure reactive (i%2 || >100k || psnrDelta>0.5).
 * Phase 1: safe early skip (<25% bytes, post-first).
 * Phase 2/3: use sparse measured samples for linear slope + curvature to predict crossings.
 * Never skips i=0 or final. Nulls remain valid for summarize.
 */
function decideButterCompute(i, b, byteSizes, psnrDelta, measuredButters) {
  const n = byteSizes.length;
  if (!n) return false;
  const lastB = byteSizes[n - 1] || b;
  const isLast = i === n - 1;
  if (i === 0 || isLast) return true;
  if (b < lastB * 0.25) return false;
  if ((i % 2 === 0) || b > 100 * 1024 || psnrDelta > 0.5) return true;
  if (measuredButters.length >= 2) {
    const m = measuredButters;
    const l = m[m.length - 1];
    const p = m[m.length - 2];
    const dx = Math.max(1, l.bytes - p.bytes);
    const slope = (l.butter - p.butter) / dx;
    const predB = l.butter + slope * (b - l.bytes);
    if (measuredButters.length >= 3) {
      const p2 = m[m.length - 3];
      const dx0 = Math.max(1, p.bytes - p2.bytes);
      const slope0 = (p.butter - p2.butter) / dx0;
      const curv = Math.abs(slope - slope0) / Math.max(1, (dx0 + dx) / 2);
      if (predB < GOOD_BUTTER - 0.2 && curv < 5e-6 && Math.abs(slope) < 5e-5) return false;
    } else if (predB < GOOD_BUTTER - 0.3 && Math.abs(slope) < 1e-4) {
      return false;
    }
    if (Math.abs(predB - GOOD_BUTTER) < 0.5) return true;
  }
  return false;
}

export function classifyByteCutoffFrame({ bytes, events = [], error = null }) {
  const frames = events.filter((event) => event && (event.type === 'progress' || event.type === 'final'));
  const last = frames.at(-1);
  return {
    bytes,
    painted: frames.length > 0,
    frameCount: frames.length,
    isFinal: frames.some((event) => event.type === 'final'),
    stage: last?.stage ?? last?.type ?? null,
    error,
  };
}

export function summarizeByteCutoffResults(results, totalBytes, { qualitySeries = null, butterSeries = null, ssimSeries = null, goodButter = GOOD_BUTTER } = {}) {
  const sorted = ensureSorted(results);
  const painted = sorted.filter((result) => result.painted);
  const firstPaint = painted[0] ?? null;
  const final = sorted.find((result) => result.isFinal) ?? sorted.at(-1) ?? null;
  const maxFrameCount = sorted.reduce((max, result) => Math.max(max, result.frameCount ?? 0), 0);

  let firstRecognizableBytes = null;
  let previewBytes = null;
  let finalPsnr = null;
  let monotone = null;
  let regressions = [];

  if (Array.isArray(qualitySeries) && qualitySeries.length > 0) {
    const sortedSeries = ensureSorted(qualitySeries);
    firstRecognizableBytes = sortedSeries.find((entry) => entry.psnr >= RECOGNIZABLE_DB)?.bytes ?? null;
    previewBytes = sortedSeries.find((entry) => entry.psnr >= PREVIEW_DB)?.bytes ?? null;
    finalPsnr = sortedSeries.at(-1)?.psnr ?? null;
    const monotoneResult = detectMonotone(sortedSeries);
    monotone = monotoneResult.monotone;
    regressions = monotoneResult.regressions;
  } else {
    previewBytes = pickPreviewCutoffBytesOnly(painted, totalBytes);
  }

  // Sort butterSeries once; reused by both the preview fallback and the perceptual block below.
  const hasButter = Array.isArray(butterSeries) && butterSeries.length > 0;
  const sortedButter = hasButter ? ensureSorted(butterSeries) : null;

  // perceptual-aware preview if butterSeries present (even without qualitySeries)
  if (previewBytes == null && hasButter) {
    previewBytes = sortedButter.find((e) => e.butter != null && e.butter <= goodButter)?.bytes ?? sortedButter.at(-1)?.bytes ?? null;
  }

  let firstPerceptuallyGoodBytes = null;
  let firstPerceptuallyGoodPercent = null;
  let firstPerceptuallyGoodConfidence = null;
  let finalButter = null;
  let butterMonotone = null;
  let butterRegressions = [];

  if (hasButter) {
    const ss = sortedButter;
    firstPerceptuallyGoodBytes = ss.find((e) => e.butter != null && e.butter <= goodButter)?.bytes ?? null;
    firstPerceptuallyGoodPercent = percent(firstPerceptuallyGoodBytes, totalBytes);
    finalButter = ss.at(-1)?.butter ?? null;
    // entries already carry {bytes, butter} — pass directly via valueKey, no array re-materialization
    const m = detectMonotone(ss, BUTTER_MONOTONE_TOL, { valueKey: 'butter', lowerIsBetter: true });
    butterMonotone = m.monotone;
    butterRegressions = m.regressions;
    // Confidence model (handoff item 4): rough proxy from sample density near threshold + distance to GOOD_BUTTER.
    // 1.0 = dense samples + on/below threshold; lower when sparse or far extrapolation.
    if (firstPerceptuallyGoodBytes != null) {
      const cross = ss.find((e) => e.bytes === firstPerceptuallyGoodBytes && e.butter != null) ||
                    ss.find((e) => e.butter != null && e.butter <= goodButter);
      const nearCount = ss.filter((e) => e.butter != null && Math.abs((e.bytes || 0) - (firstPerceptuallyGoodBytes || 0)) <= totalBytes * 0.15).length;
      let c = 0.65;
      if (cross && typeof cross.butter === 'number') {
        const dist = Math.abs(cross.butter - goodButter);
        c = Math.max(0.55, Math.min(0.97, 0.88 - dist * 0.25 + Math.min(0.12, nearCount * 0.04)));
      }
      firstPerceptuallyGoodConfidence = Number(c.toFixed(2));
    }
  }

  // ssimSeries support for symmetry (higher-better like psnr); fields added if present
  let firstGoodSsimBytes = null, finalSsim = null, ssimMonotone = null, ssimRegressions = [];
  if (Array.isArray(ssimSeries) && ssimSeries.length > 0) {
    const ss = ensureSorted(ssimSeries);
    firstGoodSsimBytes = ss.find((e) => e.ssim != null && e.ssim >= SSIM_GOOD)?.bytes ?? null;
    finalSsim = ss.at(-1)?.ssim ?? null;
    // BUG FIX: ssim is higher-better with key 'ssim'; without valueKey detectMonotone read entry.psnr
    // (undefined) → every entry skipped → ssimMonotone always trivially true. Pass valueKey + ssim tol.
    const m = detectMonotone(ss, SSIM_MONOTONE_TOL, { valueKey: 'ssim' });
    ssimMonotone = m.monotone;
    ssimRegressions = m.regressions;
  }

  return {
    totalBytes,
    firstPaintBytes: firstPaint?.bytes ?? null,
    firstPaintPercent: percent(firstPaint?.bytes, totalBytes),
    firstRecognizableBytes,
    firstRecognizablePercent: percent(firstRecognizableBytes, totalBytes),
    previewBytes,
    previewPercent: percent(previewBytes, totalBytes),
    finalBytes: final?.bytes ?? null,
    finalPercent: percent(final?.bytes, totalBytes),
    finalPsnr,
    paintedCutoffs: painted.length,
    maxFrameCount,
    usefulEarlyPaint: !!firstPaint && firstPaint.bytes < totalBytes,
    monotone,
    regressions,
    firstPerceptuallyGoodBytes,
    firstPerceptuallyGoodPercent,
    firstPerceptuallyGoodConfidence,
    finalButter,
    butterMonotone,
    butterRegressions,
    firstGoodSsimBytes,
    finalSsim,
    ssimMonotone,
    ssimRegressions,
  };
}

function ensureSorted(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return arr || [];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i].bytes < arr[i - 1].bytes) return [...arr].sort((a, b) => a.bytes - b.bytes);
  }
  return arr;
}

function pickPreviewCutoffBytesOnly(painted, totalBytes) {
  if (painted.length === 0) return null;
  const nonFinal = painted.filter((result) => !result.isFinal && result.bytes < totalBytes);
  if (nonFinal.length === 0) return painted[0]?.bytes ?? null;
  const threshold = Math.min(50 * 1024, Math.max(1, totalBytes * 0.7));
  return (nonFinal.find((result) => result.bytes >= threshold) ?? nonFinal.at(-1))?.bytes ?? null;
}

function percent(bytes, totalBytes) {
  if (bytes == null || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  return Math.round((bytes / totalBytes) * 1000) / 10;
}

/**
 * Async buildSeries variant. Accepts a pre-inited comparator (e.g. ButteraugliComparator from
 * facade.ts) to reuse ref-cached WASM state across calls. Falls back to JS createButteraugliComparer
 * when opts.comparator not provided. Supports WASM PSNR/SSIM hooks via opts.psnrFn/ssimFn.
 *
 * opts.comparator  — object with .compare(pixels) → number (sync)
 * opts.fusedFn     — async (test, ref, w, h) → { psnr, ssim } | null  (WASM fused PSNR+SSIM; preferred over psnrFn+ssimFn)
 * opts.psnrFn      — async (test, ref, w, h) → number | null  (WASM PSNR; used only when fusedFn absent)
 * opts.ssimFn      — async (test, ref, w, h) → number | null  (WASM SSIM; used only when fusedFn absent)
 * opts.postDecodeTransform — same signature as buildSeries
 *
 * Memory: same contract as buildSeries. WASM comparator path further reduces per-compare JS-side floats.
 */
export async function buildSeriesAsync(refPixels, cutoffPixelsList, byteSizes, width, height, opts = {}) {
  if (!Array.isArray(cutoffPixelsList) || !Array.isArray(byteSizes) || cutoffPixelsList.length !== byteSizes.length) {
    throw new Error('cutoffPixelsList and byteSizes must be parallel arrays');
  }
  const n = width * height;
  if (!n || refPixels.length !== n * 4) return { qualitySeries: [], butterSeries: [], ssimSeries: [], timing: { psnrMs: 0, butterMs: 0, ssimMs: 0, totalMs: 0 } };

  performance.mark('buildSeriesAsync-start');
  try {
    const { comparator = null, postDecodeTransform = null, psnrFn = null, ssimFn = null, fusedFn = null } = opts;
    // comparator: ButteraugliComparator (has .compare method) or null → fall back to JS createButteraugliComparer (returns callable)
    const cmp = comparator ?? createButteraugliComparer(refPixels, width, height);
    const callCmp = typeof cmp === 'function' ? cmp : (p) => cmp.compare(p);

    const qualitySeries = [], butterSeries = [], ssimSeries = [];
    const timing = { psnrMs: 0, butterMs: 0, ssimMs: 0, fusedMs: 0, totalMs: 0 };
    let prevPsnr = null; // scalar carry — avoids re-indexing qualitySeries[len-1] each iteration (blueprint Ch1)
    const measuredButters = []; // for trajectory prediction inside decideButterCompute

    for (let i = 0; i < cutoffPixelsList.length; i++) {
      let p = cutoffPixelsList[i];
      const b = byteSizes[i];
      if (!p || p.length !== n * 4) continue;
      if (postDecodeTransform) {
        const transformed = postDecodeTransform(p, { bytes: b, width, height, index: i, layer: i >> 1 });
        if (transformed && transformed.length === p.length) p = transformed;
      }

      // PSNR + SSIM: fused hook (WASM) → per-metric hooks → JS fused fallback (one scan, Blueprint Ch6).
      let currentPsnr, currentSsim;
      if (fusedFn) {
        const t0 = performance.now();
        const fused = (await fusedFn(p, refPixels, width, height)) ?? computePsnrSsimFused(p, refPixels, width, height);
        timing.fusedMs += performance.now() - t0;
        currentPsnr = fused.psnr; currentSsim = fused.ssim;
      } else if (psnrFn || ssimFn) {
        let t0 = performance.now();
        currentPsnr = psnrFn
          ? (await psnrFn(p, refPixels, width, height) ?? computePsnrVsFinal(p, refPixels))
          : computePsnrVsFinal(p, refPixels);
        timing.psnrMs += performance.now() - t0;
        t0 = performance.now();
        currentSsim = ssimFn
          ? (await ssimFn(p, refPixels, width, height) ?? computeSsimVsFinal(p, refPixels, width, height))
          : computeSsimVsFinal(p, refPixels, width, height);
        timing.ssimMs += performance.now() - t0;
      } else {
        const t0 = performance.now();
        ({ psnr: currentPsnr, ssim: currentSsim } = computePsnrSsimFused(p, refPixels, width, height));
        timing.fusedMs += performance.now() - t0;
      }

      const psnrDelta = prevPsnr != null ? Math.abs(currentPsnr - prevPsnr) : Infinity;
      const doFull = decideButterCompute(i, b, byteSizes, psnrDelta, measuredButters);
      qualitySeries.push({ bytes: b, psnr: currentPsnr });
      prevPsnr = currentPsnr;

      const t = performance.now();
      let butterVal = null;
      if (doFull) {
        butterVal = callCmp(p);
        measuredButters.push({ bytes: b, butter: butterVal });
      }
      butterSeries.push({ bytes: b, butter: butterVal });
      timing.butterMs += performance.now() - t;
      ssimSeries.push({ bytes: b, ssim: currentSsim });
    }
    timing.totalMs = timing.psnrMs + timing.butterMs + timing.ssimMs + timing.fusedMs;
    return { qualitySeries, butterSeries, ssimSeries, timing };
  } finally {
    performance.measure('buildSeriesAsync', 'buildSeriesAsync-start');
  }
}

// Layer5 / Lens12/16/18: Pass butterSeries (or ssimSeries) computed from external model/recog score
// (e.g. plant classifier logit or embedding dist on cutoff pixels) for task-aware early term instead of
// pure fidelity. Pairs with new color constancy in Rust LookRenderer for illum-invariant AR.

// buildSeries: auto producer helper. ref + list of cutoff pixel bufs + parallel byteSizes -> ready series for summarize.
// Uses comparer for butter speed (layer1/2 cohesion win). No final needed if using self-stability or external.
//
// Memory contract (audit per handoff):
// - cutoffPixelsList: caller owns the Uint8Array RGBA buffers. We read-only scan + pass views into cmp/psnr/ssim.
// - No additional full-frame copies inside (except postDecodeTransform result if provided and same length).
// - Comparer (JS) allocates ref XYB + small per-call test XYB once on create; reused across the list.
// - For large images (e.g. 6k×4k ~96 MB/frame) keep list lifetime short; callers clear after summarize.
// - Preferring views/reuse: we use scalar carry for prevPsnr, shared measuredButters, no per-iter alloc in decide.
export function buildSeries(refPixels, cutoffPixelsList, byteSizes, width, height, postDecodeTransform = null) {
  if (!Array.isArray(cutoffPixelsList) || !Array.isArray(byteSizes) || cutoffPixelsList.length !== byteSizes.length) {
    throw new Error('cutoffPixelsList and byteSizes must be parallel arrays');
  }
  const n = width * height;
  if (!n || refPixels.length !== n * 4) return { qualitySeries: [], butterSeries: [], ssimSeries: [], timing: { psnrMs: 0, butterMs: 0, ssimMs: 0, totalMs: 0 } };
  performance.mark('buildSeries-start');
  try {
    const cmp = createButteraugliComparer(refPixels, width, height);
    const qualitySeries = [];
    const butterSeries = [];
    const ssimSeries = [];
    // Per-metric timing accumulators — zero-overhead performance.now() pairs; visible in DevTools Timeline.
    const timing = { psnrMs: 0, butterMs: 0, ssimMs: 0, fusedMs: 0, totalMs: 0 };
    let prevPsnr = null; // scalar carry — avoids re-indexing qualitySeries[len-1] each iteration (blueprint Ch1)
    const measuredButters = []; // for trajectory prediction inside decideButterCompute
    for (let i = 0; i < cutoffPixelsList.length; i++) {
      let p = cutoffPixelsList[i];
      const b = byteSizes[i];
      if (!p || p.length !== n * 4) continue;
      if (postDecodeTransform) {
        // Layer 2/5: support for post layer transform (e.g. perceptual constancy) before expensive butter.
        // Allows early exit sampling + vision hooks without full cost every cutoff. More hooks for Cursor layer.
        const transformed = postDecodeTransform(p, { bytes: b, width, height, index: i, layer: i >> 1 });
        if (transformed && transformed.length === p.length) p = transformed;
      }
      // Fused single-pass PSNR + SSIM (Blueprint Ch6): one pixel scan instead of two.
      let t = performance.now();
      const { psnr: currentPsnr, ssim: currentSsim } = computePsnrSsimFused(p, refPixels, width, height);
      timing.fusedMs += performance.now() - t;
      const psnrDelta = prevPsnr != null ? Math.abs(currentPsnr - prevPsnr) : Infinity;
      const doFull = decideButterCompute(i, b, byteSizes, psnrDelta, measuredButters);
      qualitySeries.push({ bytes: b, psnr: currentPsnr });
      prevPsnr = currentPsnr;
      t = performance.now();
      let butterVal = null;
      if (doFull) {
        butterVal = cmp(p);
        measuredButters.push({ bytes: b, butter: butterVal });
      }
      butterSeries.push({ bytes: b, butter: butterVal });
      timing.butterMs += performance.now() - t;
      ssimSeries.push({ bytes: b, ssim: currentSsim });
    }
    timing.totalMs = timing.psnrMs + timing.butterMs + timing.ssimMs + timing.fusedMs;
    return { qualitySeries, butterSeries, ssimSeries, timing };
  } finally {
    performance.measure('buildSeries', 'buildSeries-start');
  }
}


