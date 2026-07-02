// web/perceptual-color.mjs
// Pure, DOM-free perceptual-colour maths for the lightbox Perceptual Lens + Colour Probe + Selector.
// Opponent space = CIELAB (D65) for v1, behind the five canonical operators so XYB/Rust can swap in later.
// Spec: docs/superpowers/specs/2026-06-11-perceptual-lens-colour-probe-design.md

// --- sRGB transfer function (component in [0,1]) ---
export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
export function linearToSrgb(l) {
  const v = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  return Math.min(1, Math.max(0, v));
}

// --- linear sRGB <-> XYZ (D65) ---
export function linearRgbToXyz([r, g, b]) {
  return [
    0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    0.2126729 * r + 0.7151522 * g + 0.0721750 * b,
    0.0193339 * r + 0.1191920 * g + 0.9503041 * b,
  ];
}
export function xyzToLinearRgb([x, y, z]) {
  return [
     3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.9692660 * x + 1.8760108 * y + 0.0415560 * z,
     0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ];
}

// --- XYZ <-> CIELAB (D65 white) ---
export const D65_XYZ = [0.95047, 1.0, 1.08883];
const DELTA = 6 / 29;
const fLab = (t) => (t > DELTA ** 3 ? Math.cbrt(t) : t / (3 * DELTA * DELTA) + 4 / 29);
const fLabInv = (t) => (t > DELTA ? t ** 3 : 3 * DELTA * DELTA * (t - 4 / 29));

export function xyzToLab([x, y, z]) {
  const fx = fLab(x / D65_XYZ[0]), fy = fLab(y / D65_XYZ[1]), fz = fLab(z / D65_XYZ[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export function labToXyz([L, a, b]) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  return [D65_XYZ[0] * fLabInv(fx), D65_XYZ[1] * fLabInv(fy), D65_XYZ[2] * fLabInv(fz)];
}

// --- XYZ <-> LMS (Bradford cone response, for chromatic adaptation) ---
export function xyzToLms([x, y, z]) {
  return [
     0.8951 * x + 0.2664 * y - 0.1614 * z,
    -0.7502 * x + 1.7135 * y + 0.0367 * z,
     0.0389 * x - 0.0685 * y + 1.0296 * z,
  ];
}
export function lmsToXyz([l, m, s]) {
  return [
     0.9869929 * l - 0.1470543 * m + 0.1599627 * s,
     0.4323053 * l + 0.5183603 * m + 0.0492912 * s,
    -0.0085287 * l + 0.0400428 * m + 0.9684867 * s,
  ];
}

export const CANONICAL_WHITE_LMS = xyzToLms(D65_XYZ);
export const srgbU8ToLinear = (u8) => srgbToLinear(u8 / 255);

// LMS' = LMS * lerp(1, canonical/scene, sigma)  (von Kries diagonal adaptation)
export function vonKriesAdapt(lms, sceneWhiteLms, sigma) {
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const g = CANONICAL_WHITE_LMS[i] / Math.max(sceneWhiteLms[i], 1e-6);
    out[i] = lms[i] * ((1 - sigma) + sigma * g);
  }
  return out;
}

// Scene white = blend of gray-world mean LMS and the mean LMS of the brightest non-clipped ~2%.
export function estimateSceneWhiteLms(rgbaU8, w, h) {
  const n = w * h;
  // One pass: compute XYZ/luma, the clipped predicate (once), gray-world mean, and the
  // non-clipped index list. Then an O(n) three-way quickselect picks the brightest ~2%
  // instead of an O(n log n) full sort. Three-way partitioning stays O(n) even on flat
  // regions (near-constant luma). Result matches the sorted-top-2% mean to f64 reassoc.
  const xyzs = new Float64Array(n * 3);
  const lumas = new Float64Array(n);
  const nonClipped = new Int32Array(n);
  let nc = 0;
  let meanX = 0, meanY = 0, meanZ = 0, count = 0;
  for (let i = 0; i < n; i++) {
    const i4 = i * 4;
    const r = srgbU8ToLinear(rgbaU8[i4]), g = srgbU8ToLinear(rgbaU8[i4 + 1]), b = srgbU8ToLinear(rgbaU8[i4 + 2]);
    const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
    const Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    const Z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
    const i3 = i * 3;
    xyzs[i3] = X; xyzs[i3 + 1] = Y; xyzs[i3 + 2] = Z; lumas[i] = Y;
    const clipped = rgbaU8[i4] >= 254 || rgbaU8[i4 + 1] >= 254 || rgbaU8[i4 + 2] >= 254;
    if (!clipped) { meanX += X; meanY += Y; meanZ += Z; count++; nonClipped[nc++] = i; }
  }
  count = Math.max(count, 1);
  const grayWorld = [meanX / count, meanY / count, meanZ / count];

  const topN = Math.max(1, Math.floor(nc * 0.02));
  const arr = nonClipped.subarray(0, nc);
  quickselectBrightest(arr, lumas, topN - 1);
  let bX = 0, bY = 0, bZ = 0;
  for (let k = 0; k < topN; k++) { const i = arr[k], i3 = i * 3; bX += xyzs[i3]; bY += xyzs[i3 + 1]; bZ += xyzs[i3 + 2]; }
  const bright = [bX / topN, bY / topN, bZ / topN];

  const blendXyz = [
    0.5 * grayWorld[0] + 0.5 * bright[0],
    0.5 * grayWorld[1] + 0.5 * bright[1],
    0.5 * grayWorld[2] + 0.5 * bright[2],
  ];
  return xyzToLms(blendXyz).map((v) => Math.max(v, 1e-4));
}

// In-place quickselect (three-way / Dutch-flag) so the k-th order statistic in DESCENDING
// luma order is in place and all higher-luma entries are to its left. Three-way partition
// keeps it O(n) even when many luma keys tie (flat sky / blown highlights).
function quickselectBrightest(arr, lumas, k) {
  const med3 = (i, j, m) => {
    const a = lumas[arr[i]], b = lumas[arr[j]], c = lumas[arr[m]];
    if (a < b) { if (b < c) return j; return a < c ? m : i; }
    if (a < c) return i; return b < c ? m : j;
  };
  const swap = (i, j) => { const t = arr[i]; arr[i] = arr[j]; arr[j] = t; };
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const pivVal = lumas[arr[med3(lo, (lo + hi) >> 1, hi)]];
    let lt = lo, i = lo, gt = hi;
    while (i <= gt) {
      const v = lumas[arr[i]];
      if (v > pivVal) { swap(lt, i); lt++; i++; }       // larger luma -> left
      else if (v < pivVal) { swap(i, gt); gt--; }       // smaller luma -> right
      else i++;
    }
    if (k < lt) hi = lt - 1;
    else if (k > gt) lo = gt + 1;
    else return; // k falls within the equal-to-pivot block
  }
}

// --- non-Riemannian chroma damping (Phi) + the five canonical operators ---
export const C_KNEE = 30; // Lab chroma units where compression bites (tunable)
export function phi(c, cKnee = C_KNEE) { return cKnee * Math.log(1 + c / cKnee); }

export function dampChroma(L, a, b, sigma, { cKnee = C_KNEE } = {}) {
  const c = Math.hypot(a, b);
  if (c < 1e-9) return { L, a, b };
  const cOut = (1 - sigma) * c + sigma * phi(c, cKnee);
  const k = cOut / c;
  return { L, a: a * k, b: b * k };
}

export const neutralOf = ([L]) => [L, 0, 0];
export const hueClassOf = ([, a, b]) => Math.atan2(b, a) * 180 / Math.PI;
export const saturationOf = ([, a, b]) => phi(Math.hypot(a, b));
export const lightnessOf = ([L]) => L;
export function phiDampedDistance(labA, labB) {
  const d = Math.hypot(labA[0] - labB[0], labA[1] - labB[1], labA[2] - labB[2]);
  return phi(d);
}

// --- shoulder-aware lightness spread-compression (never brightens highlights) ---
function shoulder(L, Lshoulder) {
  if (L <= Lshoulder) return 1;
  return Math.max(0, 1 - (L - Lshoulder) / (100 - Lshoulder + 1e-6));
}
export function compressLightness(L, { Lmid, Lshoulder, k = 0.3 }, sigma) {
  return L - sigma * k * (L - Lmid) * shoulder(L, Lshoulder);
}
export function estimateLightnessStats(rgbaU8, w, h) {
  const n = w * h, Ls = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = srgbU8ToLinear(rgbaU8[i * 4]), g = srgbU8ToLinear(rgbaU8[i * 4 + 1]), b = srgbU8ToLinear(rgbaU8[i * 4 + 2]);
    Ls[i] = xyzToLab(linearRgbToXyz([r, g, b]))[0];
  }
  // TypedArray sort is numeric-ascending by default — no boxed JS array, no
  // comparator calls. Ordering matches Array.from(...).sort((a,b)=>a-b) for
  // the finite L values here (ties are equal values), so the percentile picks
  // are value-identical.
  const sorted = Ls.slice().sort();
  const pct = (p) => sorted[Math.min(n - 1, Math.floor(p * n))];
  return { Lmid: pct(0.5), Lshoulder: pct(0.85), k: 0.3 };
}

// --- Lens render: sRGB -> linear -> XYZ -> LMS -> von Kries -> Lab -> damp + compress -> sRGB ---
export function applyLens(rgbaU8, w, h, { strength = 1, lightness = true, cKnee = C_KNEE } = {}) {
  const sigma = strength;
  const out = new Uint8ClampedArray(rgbaU8.length);
  const sceneWhite = estimateSceneWhiteLms(rgbaU8, w, h);
  const Lstats = estimateLightnessStats(rgbaU8, w, h);
  const n = w * h;

  // Hoist the loop-invariant von Kries diagonal factors and inline the whole transform
  // chain as flat scalars — no per-pixel array/object allocations. Bit-identical output.
  const f0 = (1 - sigma) + sigma * (CANONICAL_WHITE_LMS[0] / Math.max(sceneWhite[0], 1e-6));
  const f1 = (1 - sigma) + sigma * (CANONICAL_WHITE_LMS[1] / Math.max(sceneWhite[1], 1e-6));
  const f2 = (1 - sigma) + sigma * (CANONICAL_WHITE_LMS[2] / Math.max(sceneWhite[2], 1e-6));
  const Lmid = Lstats.Lmid, Lshoulder = Lstats.Lshoulder, kComp = Lstats.k;
  const DELTA3 = DELTA ** 3, c33 = 3 * DELTA * DELTA, c429 = 4 / 29;
  const D0 = D65_XYZ[0], D1 = D65_XYZ[1], D2 = D65_XYZ[2];

  for (let i = 0; i < n; i++) {
    const i4 = i * 4;
    const r = srgbU8ToLinear(rgbaU8[i4]), g = srgbU8ToLinear(rgbaU8[i4 + 1]), b = srgbU8ToLinear(rgbaU8[i4 + 2]);
    const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
    const Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    const Z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
    let l = 0.8951 * X + 0.2664 * Y - 0.1614 * Z;
    let m = -0.7502 * X + 1.7135 * Y + 0.0367 * Z;
    let s = 0.0389 * X - 0.0685 * Y + 1.0296 * Z;
    l *= f0; m *= f1; s *= f2;
    const X2 = 0.9869929 * l - 0.1470543 * m + 0.1599627 * s;
    const Y2 = 0.4323053 * l + 0.5183603 * m + 0.0492912 * s;
    const Z2 = -0.0085287 * l + 0.0400428 * m + 0.9684867 * s;
    const tx = X2 / D0, ty = Y2 / D1, tz = Z2 / D2;
    const fx = tx > DELTA3 ? Math.cbrt(tx) : tx / c33 + c429;
    const fy = ty > DELTA3 ? Math.cbrt(ty) : ty / c33 + c429;
    const fz = tz > DELTA3 ? Math.cbrt(tz) : tz / c33 + c429;
    let labL = 116 * fy - 16;
    let labA = 500 * (fx - fy);
    let labB = 200 * (fy - fz);

    // dampChroma
    const c = Math.hypot(labA, labB);
    if (c >= 1e-9) {
      const cOut = (1 - sigma) * c + sigma * (cKnee * Math.log(1 + c / cKnee));
      const k = cOut / c;
      labA *= k; labB *= k;
    }

    // compressLightness (shoulder)
    if (lightness) {
      const sh = labL <= Lshoulder ? 1 : Math.max(0, 1 - (labL - Lshoulder) / (100 - Lshoulder + 1e-6));
      labL = labL - sigma * kComp * (labL - Lmid) * sh;
    }

    // lab -> xyz
    const fyy = (labL + 16) / 116, fxx = fyy + labA / 500, fzz = fyy - labB / 200;
    const Xo = D0 * (fxx > DELTA ? fxx ** 3 : c33 * (fxx - c429));
    const Yo = D1 * (fyy > DELTA ? fyy ** 3 : c33 * (fyy - c429));
    const Zo = D2 * (fzz > DELTA ? fzz ** 3 : c33 * (fzz - c429));

    // xyz -> linear rgb
    const Rl = 3.2404542 * Xo - 1.5371385 * Yo - 0.4985314 * Zo;
    const Gl = -0.9692660 * Xo + 1.8760108 * Yo + 0.0415560 * Zo;
    const Bl = 0.0556434 * Xo - 0.2040259 * Yo + 1.0572252 * Zo;

    out[i4] = Math.round(linearToSrgb(Rl) * 255);
    out[i4 + 1] = Math.round(linearToSrgb(Gl) * 255);
    out[i4 + 2] = Math.round(linearToSrgb(Bl) * 255);
    out[i4 + 3] = rgbaU8[i4 + 3];
  }
  return out;
}

// --- selection core (probe + global colour-range selector share labBuf) ---
export function normalizedLabBuffer(rgbaU8, w, h, sceneWhiteLms) {
  const n = w * h, buf = new Float32Array(n * 3);
  // sigma is fixed at 1 here, so the von Kries diagonal factor is loop-invariant
  // (g = canonical/scene). Precompute it once and inline the transform chain as flat
  // scalars — no per-pixel array allocations. Bit-identical to the tuple-based path.
  const f0 = CANONICAL_WHITE_LMS[0] / Math.max(sceneWhiteLms[0], 1e-6);
  const f1 = CANONICAL_WHITE_LMS[1] / Math.max(sceneWhiteLms[1], 1e-6);
  const f2 = CANONICAL_WHITE_LMS[2] / Math.max(sceneWhiteLms[2], 1e-6);
  const DELTA3 = DELTA ** 3, c33 = 3 * DELTA * DELTA, c429 = 4 / 29;
  const D0 = D65_XYZ[0], D1 = D65_XYZ[1], D2 = D65_XYZ[2];
  for (let i = 0; i < n; i++) {
    const i4 = i * 4;
    const r = srgbU8ToLinear(rgbaU8[i4]), g = srgbU8ToLinear(rgbaU8[i4 + 1]), b = srgbU8ToLinear(rgbaU8[i4 + 2]);
    const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
    const Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    const Z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
    let l = 0.8951 * X + 0.2664 * Y - 0.1614 * Z;
    let m = -0.7502 * X + 1.7135 * Y + 0.0367 * Z;
    let s = 0.0389 * X - 0.0685 * Y + 1.0296 * Z;
    l *= f0; m *= f1; s *= f2;
    const X2 = 0.9869929 * l - 0.1470543 * m + 0.1599627 * s;
    const Y2 = 0.4323053 * l + 0.5183603 * m + 0.0492912 * s;
    const Z2 = -0.0085287 * l + 0.0400428 * m + 0.9684867 * s;
    const tx = X2 / D0, ty = Y2 / D1, tz = Z2 / D2;
    const fx = tx > DELTA3 ? Math.cbrt(tx) : tx / c33 + c429;
    const fy = ty > DELTA3 ? Math.cbrt(ty) : ty / c33 + c429;
    const fz = tz > DELTA3 ? Math.cbrt(tz) : tz / c33 + c429;
    const i3 = i * 3;
    buf[i3] = 116 * fy - 16;
    buf[i3 + 1] = 500 * (fx - fy);
    buf[i3 + 2] = 200 * (fy - fz);
  }
  return buf;
}

export function selectByColour(labBuf, w, h, seedLab, tolerance, cKnee = C_KNEE) {
  // phi(c) = cKnee*log(1 + c/cKnee) is strictly increasing, so phiDampedDistance(d) = phi(d) <= tol
  // <=> d <= cKnee*(exp(tol/cKnee) - 1) <=> d^2 <= dThr^2. Precompute the raw squared threshold
  // once and compare squared distance — no per-pixel array, no per-pixel log/sqrt. Bit-identical mask.
  const n = w * h, mask = new Uint8Array(n);
  const dThr = cKnee * (Math.exp(tolerance / cKnee) - 1);
  const dThrSq = dThr * dThr;
  const s0 = seedLab[0], s1 = seedLab[1], s2 = seedLab[2];
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    const d0 = labBuf[i3] - s0, d1 = labBuf[i3 + 1] - s1, d2 = labBuf[i3 + 2] - s2;
    if (d0 * d0 + d1 * d1 + d2 * d2 <= dThrSq) mask[i] = 1;
  }
  return mask;
}

export function unionMask(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] || b[i]) ? 1 : 0;
  return out;
}

export function maskBorder(mask, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!mask[i]) continue;
    const up = y > 0 && mask[i - w], dn = y < h - 1 && mask[i + w], lf = x > 0 && mask[i - 1], rt = x < w - 1 && mask[i + 1];
    if (!(up && dn && lf && rt)) out[i] = 1; // touches an unselected/edge neighbour
  }
  return out;
}

export function maskCoverage(mask) {
  let count = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) count++;
  return { fraction: count / Math.max(mask.length, 1), regionCount: count };
}

// patch-mean probe over labBuf -> operator readout
export function probe(labBuf, w, h, x, y, radius = 3) {
  let L = 0, a = 0, b = 0, c = 0;
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    const px = x + dx, py = y + dy;
    if (px < 0 || py < 0 || px >= w || py >= h) continue;
    const i = py * w + px; L += labBuf[i * 3]; a += labBuf[i * 3 + 1]; b += labBuf[i * 3 + 2]; c++;
  }
  const lab = [L / c, a / c, b / c];
  return { hueDeg: hueClassOf(lab), chroma: Math.hypot(lab[1], lab[2]), dampedSaturation: saturationOf(lab), lightness: lightnessOf(lab) };
}
