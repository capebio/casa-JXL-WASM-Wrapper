import { test, expect } from 'vitest';
import { deriveVignetteCurve, applyVignetteCurve, _internals } from './vignette-correct.js';

const { NRINGS } = _internals;
const s2l = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const l2s = (l) => { const c = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, Math.round(c * 255))); };

const W = 240, H = 180;
const cx = (W - 1) / 2, cy = (H - 1) / 2, hd = Math.hypot(cx, cy);
const rnorm = (x, y) => Math.hypot(x - cx, y - cy) / hd;

// Build a uniform-scene pair: RAW = scene*darkening(r), JPEG = scene (corrected flat).
function makePair(darken, sceneLin = 0.25) {
  const raw = new Uint8Array(W * H * 3);   // RGB
  const jpg = new Uint8Array(W * H * 4);   // RGBA
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const r = rnorm(x, y);
    const rl = l2s(sceneLin * darken(r)), jl = l2s(sceneLin);
    const i3 = (y * W + x) * 3, i4 = (y * W + x) * 4;
    raw[i3] = raw[i3 + 1] = raw[i3 + 2] = rl;
    jpg[i4] = jpg[i4 + 1] = jpg[i4 + 2] = jl; jpg[i4 + 3] = 255;
  }
  return { raw, jpg };
}

test('derives a monotonic centre-flat, edge-rising vignette curve', () => {
  const darken = (r) => 1 - 0.6 * r * r; // ~0.4 at the corner
  const { raw, jpg } = makePair(darken);
  const res = deriveVignetteCurve(raw, W, H, 3, jpg, W, H, 4);
  expect(res).not.toBeNull();
  expect(res.confidence === 'HIGH' || res.confidence === 'MED').toBe(true);
  expect(res.curve[0]).toBeCloseTo(1, 1);                       // centre gain ~1
  for (let i = 1; i < NRINGS; i++) expect(res.curve[i]).toBeGreaterThanOrEqual(res.curve[i - 1] - 1e-9); // monotonic
  expect(res.curve[NRINGS - 1]).toBeGreaterThan(1.6);           // real edge lift (1/0.4 = 2.5, capped 3.2)
});

test('applying the curve flattens the RAW corners toward the JPEG', () => {
  const darken = (r) => 1 - 0.6 * r * r;
  const { raw, jpg } = makePair(darken);
  const res = deriveVignetteCurve(raw, W, H, 3, jpg, W, H, 4);
  const corrected = applyVignetteCurve(raw.slice(), W, H, 3, res.curve);
  // sample a near-corner pixel: corrected linear should be much closer to the flat scene (0.25)
  const px = 4, py = 4, i = (py * W + px) * 3;
  const beforeLin = s2l(raw[i]), afterLin = s2l(corrected[i]);
  expect(afterLin).toBeGreaterThan(beforeLin * 1.5);            // meaningfully lifted
  expect(Math.abs(afterLin - 0.25)).toBeLessThan(Math.abs(beforeLin - 0.25)); // closer to flat
  // centre must be untouched (gain ~1)
  const ci = ((H >> 1) * W + (W >> 1)) * 3;
  expect(Math.abs(corrected[ci] - raw[ci])).toBeLessThanOrEqual(2);
});

test('no vignette (RAW == JPEG) yields null -> caller no-ops', () => {
  const { raw, jpg } = makePair(() => 1); // no darkening
  expect(deriveVignetteCurve(raw, W, H, 3, jpg, W, H, 4)).toBeNull();
});

test('applyVignetteCurve(null) is a safe no-op', () => {
  const buf = new Uint8Array([10, 20, 30, 40, 50, 60]);
  expect(applyVignetteCurve(buf, 1, 2, 3, null)).toBe(buf);
  expect(Array.from(buf)).toEqual([10, 20, 30, 40, 50, 60]);
});
