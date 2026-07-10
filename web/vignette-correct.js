// Self-contained vignette correction for RAW renders that lack embedded lens-correction
// data (e.g. Nikon COOLPIX NRW). The camera's own corrected preview JPEG is used as a
// radial flat-field reference: resample both to a common grid, linearize, take the
// per-pixel luma ratio jpeg/raw (scene content cancels), radial-median, and fit a
// monotonic non-decreasing gain curve. Superzoom bodies vignette differently per zoom,
// so this is derived PER SHOT from that shot's own JPEG — no external lens profiles.
//
// The derivation is confidence-gated: it only returns a curve when the fit is a genuine
// centre-flat, edge-rising vignette shape, so an uncooperative scene yields a no-op
// rather than an artifact. Applied in linear light on the rendered RGB.

const GW = 192, GH = 144, NRINGS = 20;
const GAIN_CAP = 3.2;        // clamp runaway extreme-corner ratios
const MID_FRAC = 0.6;        // rings within this radius fraction are the "mid-frame"

const srgbToLinear = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const linearToSrgb = (l) => { l = l <= 0 ? 0 : l; const c = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, Math.round(c * 255))); };

// Box-downsample an interleaved RGB(A) byte source to a GWxGH grid of linear luma.
function toSmallLinearLuma(src, sw, sh, colors) {
  const out = new Float64Array(GW * GH);
  for (let ty = 0; ty < GH; ty++) {
    const y0 = (ty * sh / GH) | 0, y1 = Math.max(y0 + 1, ((ty + 1) * sh / GH) | 0);
    for (let tx = 0; tx < GW; tx++) {
      const x0 = (tx * sw / GW) | 0, x1 = Math.max(x0 + 1, ((tx + 1) * sw / GW) | 0);
      let s = 0, n = 0;
      for (let y = y0; y < y1 && y < sh; y++) {
        for (let x = x0; x < x1 && x < sw; x++) {
          const i = (y * sw + x) * colors;
          s += 0.2126 * srgbToLinear(src[i]) + 0.7152 * srgbToLinear(src[i + 1]) + 0.0722 * srgbToLinear(src[i + 2]);
          n++;
        }
      }
      out[ty * GW + tx] = n ? s / n : 0;
    }
  }
  return out;
}

// Pool-adjacent-violators: least-squares monotonic non-decreasing fit (weighted).
function pava(y, w) {
  const v = y.slice(), ww = w.slice(), idx = y.map((_, i) => [i, i]);
  let i = 0;
  while (i < v.length - 1) {
    if (v[i] > v[i + 1] + 1e-12) {
      const nw = ww[i] + ww[i + 1];
      v[i] = (v[i] * ww[i] + v[i + 1] * ww[i + 1]) / nw; ww[i] = nw; idx[i][1] = idx[i + 1][1];
      v.splice(i + 1, 1); ww.splice(i + 1, 1); idx.splice(i + 1, 1);
      if (i > 0) i--;
    } else i++;
  }
  const out = new Array(y.length);
  for (let k = 0; k < v.length; k++) for (let j = idx[k][0]; j <= idx[k][1]; j++) out[j] = v[k];
  return out;
}

/**
 * Derive a radial vignette gain curve from a RAW render + the camera's corrected JPEG.
 * Both are interleaved byte buffers (RGB or RGBA). Returns
 *   { curve:number[NRINGS], confidence:'HIGH'|'MED'|'LOW' } or null when not derivable.
 * A LOW-confidence result returns null so callers no-op safely.
 */
export function deriveVignetteCurve(rawRgb, rw, rh, rawColors, jpgRgb, jw, jh, jpgColors) {
  if (!rawRgb || !jpgRgb || rw < 16 || rh < 16 || jw < 16 || jh < 16) return null;
  const rawLin = toSmallLinearLuma(rawRgb, rw, rh, rawColors);
  const jpgLin = toSmallLinearLuma(jpgRgb, jw, jh, jpgColors);
  const cx = (GW - 1) / 2, cy = (GH - 1) / 2, hd = Math.hypot(cx, cy);
  const rings = Array.from({ length: NRINGS }, () => []);
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const rl = rawLin[y * GW + x], jl = jpgLin[y * GW + x];
      if (rl > 0.002 && jl > 0.002) {
        const r = Math.hypot(x - cx, y - cy) / hd;
        rings[Math.min(NRINGS - 1, (r * NRINGS) | 0)].push(jl / rl);
      }
    }
  }
  const med = rings.map((a) => { if (a.length < 3) return null; a.sort((u, v) => u - v); return a[a.length >> 1]; });
  const c0 = med[0]; if (!c0 || c0 <= 0) return null;
  const norm = med.map((v) => (v == null ? null : v / c0));
  const rel = [];
  for (let i = 0; i < NRINGS; i++) if (norm[i] != null) rel.push([i, Math.max(1, Math.min(GAIN_CAP, norm[i]))]);
  if (rel.length < NRINGS * 0.6) return null;
  const iso = pava(rel.map((x) => x[1]), rel.map((x) => x[0] + 0.5));
  const curve = new Array(NRINGS).fill(1);
  for (let k = 0; k < rel.length; k++) curve[rel[k][0]] = iso[k];
  for (let i = 1; i < NRINGS; i++) if (curve[i] < curve[i - 1]) curve[i] = curve[i - 1]; // fill gaps monotonically
  const midMax = Math.max(...curve.slice(0, Math.floor(NRINGS * MID_FRAC)));
  const edge = curve[NRINGS - 1];
  const confidence = (edge > 1.3 && midMax < 1.15) ? 'HIGH' : (edge > 1.15 && midMax < 1.35) ? 'MED' : 'LOW';
  if (confidence === 'LOW') return null;
  return { curve, confidence };
}

/** Linear interpolation into the ring curve at normalised radius r in [0,1]. */
function gainAt(curve, r) {
  const t = Math.min(NRINGS - 1, Math.max(0, r * NRINGS - 0.5));
  const i = t | 0, f = t - i;
  return i + 1 < NRINGS ? curve[i] * (1 - f) + curve[i + 1] * f : curve[NRINGS - 1];
}

/**
 * Apply a radial gain curve to an interleaved RGB(A) render, in-place, in linear light.
 * `colors` = 3 (RGB) or 4 (RGBA). Mutates and returns `rgb`.
 */
export function applyVignetteCurve(rgb, w, h, colors, curve) {
  if (!curve) return rgb;
  const cx = (w - 1) / 2, cy = (h - 1) / 2, hd = Math.hypot(cx, cy);
  // per-row radius cache of the x-term is cheap; compute per pixel (smooth, one sqrt).
  for (let y = 0; y < h; y++) {
    const dy2 = (y - cy) * (y - cy);
    for (let x = 0; x < w; x++) {
      const r = Math.sqrt((x - cx) * (x - cx) + dy2) / hd;
      const g = gainAt(curve, r);
      if (g <= 1.0001) continue;
      const i = (y * w + x) * colors;
      rgb[i] = linearToSrgb(srgbToLinear(rgb[i]) * g);
      rgb[i + 1] = linearToSrgb(srgbToLinear(rgb[i + 1]) * g);
      rgb[i + 2] = linearToSrgb(srgbToLinear(rgb[i + 2]) * g);
    }
  }
  return rgb;
}

export const _internals = { GW, GH, NRINGS, GAIN_CAP, toSmallLinearLuma, pava, gainAt };
