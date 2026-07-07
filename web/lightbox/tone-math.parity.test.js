// web/lightbox/tone-math.parity.test.js
// S2-Q2 — single-source tone math parity.
//
// The 8-bit preview path and the 16-bit WebGL float path must produce IDENTICAL color for
// identical slider values at the same pixel. This test pins BOTH stages of that contract:
//
//   1. COLOR MATRIX. Both paths consume buildColorMatrix(). The GLSL uniform layout
//      (uM0=[m0,m1,m2] uM1=[m5,m6,m7] uM2=[m10,m11,m12] uOff=[m4,m9,m14]/255) matches the
//      8-bit applicator's index layout across the /255 scale.
//   2. TONE MAP (shadows / highlights). filter-engine.applyToneMapInPlace is canonical:
//      clamp the matrix output, then luma-mask in 0..255 space —
//        shadowMask    = max(0, 128 - luma) / 128
//        highlightMask = max(0, luma - 192) / 63
//        v += shadows * 0.6 * shadowMask  +  highlights * 0.5 * highlightMask
//      The WebGL shaders (FS_300 / FS_100) and their CPU fallback adjustRgba16Cpu() were
//      brought to this exact formula (previously they used a divergent 0.35/0.65 luma ramp).
//
// Canonical 8-bit path = the restored 4×5 matrix API in filter-engine.js
// (buildColorMatrix + applyColorMatrixInPlace + applyToneMapInPlace), as consumed by
// web/tauri-parity-lightbox.js. filter-engine.js is the engine of record and is NOT changed.
//
// GLSL can't run under bun, so the shader is exercised via adjustRgba16Cpu() — the shipped
// CPU fallback that mirrors the shader line-for-line (same matrixUniforms() mapping, same
// tone formula). The full browser-render round-trip (real GLSL + sliders on
// jxl-progressive-gallery.html) remains user-assisted.
//
// The 8-bit side is run on a Float32Array so applyColorMatrixInPlace / applyToneMapInPlace
// keep 0..255 sub-integer precision (no 8-bit rounding) — this makes the comparison exact
// rather than merely within one quantization step, while still using the REAL functions.

import { expect, test } from 'bun:test';
import {
  buildColorMatrix,
  clampAdjustments,
  applyColorMatrixInPlace,
  applyToneMapInPlace,
} from './filter-engine.js';
import { adjustRgba16Cpu } from './webgl-pipeline.js';

const W = 3, H = 1;
const PIXELS_8 = [100, 140, 90, 255, 30, 200, 220, 255, 180, 60, 120, 255]; // 3 RGBA8 px

// Exact 8→16 lift: v16 = v8*257 so v16/65535 === v8/255 exactly (adjustRgba16Cpu
// normalizes /65535, matching the 8-bit path's /255 with no requantization error).
function rgba16BytesFrom8(px8) {
  const u16 = new Uint16Array(px8.length);
  for (let i = 0; i < px8.length; i++) u16[i] = px8[i] * 257;
  return new Uint8Array(u16.buffer);
}

// Canonical 8-bit path in full float precision (0..255), using the REAL filter-engine
// functions. Float32Array input means clampRange stores sub-integer values, so the only
// difference from the GL float path is arithmetic order — well below 0.5/255.
function canonical8bit(px8, preset, adj) {
  const matrix = buildColorMatrix(preset, adj);
  const buf = Float32Array.from(px8); // 0..255
  applyColorMatrixInPlace(buf, W, H, matrix);
  applyToneMapInPlace(buf, W, H, adj.shadows, adj.highlights);
  return buf; // 0..255
}

const CONFIGS = [
  { name: 'neutral', preset: 'NONE', raw: {} },
  { name: 'saturate', preset: 'NONE', raw: { saturation: 80 } },
  { name: 'desaturate', preset: 'NONE', raw: { saturation: -80 } },
  { name: 'clarity+dehaze offset', preset: 'NONE', raw: { clarity: 40, dehaze: 50 } },
  { name: 'shadows lift', preset: 'NONE', raw: { shadows: 70 } },
  { name: 'highlights compress', preset: 'NONE', raw: { highlights: -80 } },
  { name: 'shadows + highlights', preset: 'NONE', raw: { shadows: 60, highlights: -60 } },
  { name: 'SEPIA + saturation + shadows', preset: 'SEPIA', raw: { saturation: 40, shadows: 50 } },
  { name: 'BW_HIGH + highlights (offset+tone)', preset: 'BW_HIGH', raw: { highlights: -70 } },
];

for (const cfg of CONFIGS) {
  test(`tone-math parity: ${cfg.name} — 8-bit == webgl float (matrix + tone)`, () => {
    const adj = clampAdjustments(cfg.raw);
    const matrix = buildColorMatrix(cfg.preset, adj);

    const js = canonical8bit(PIXELS_8, cfg.preset, adj);          // 0..255 float
    const gl = adjustRgba16Cpu(rgba16BytesFrom8(PIXELS_8), W, H, matrix, adj.shadows, adj.highlights); // 0..1

    for (let p = 0; p < W * H; p++) {
      for (let c = 0; c < 3; c++) {
        const jsN = js[p * 4 + c] / 255; // 0..1
        const glN = gl[p * 4 + c];       // 0..1
        // Exact-ish: same formula, only float accumulation order differs. Far tighter than
        // the handoff's ≤ 0.5/255 acceptance criterion.
        expect(Math.abs(jsN - glN)).toBeLessThanOrEqual(0.5 / 255);
      }
    }
  });
}

// The real shipped 8-bit consumer rounds into a Uint8ClampedArray; assert the handoff's
// literal criterion (≤ 0.5/255 per channel) against that exact quantized path too, on a
// config that exercises matrix + offset + both tone knees.
test('tone-math parity: quantized 8-bit path meets ≤ 0.5/255 (handoff criterion)', () => {
  const adj = clampAdjustments({ saturation: 30, shadows: 55, highlights: -45, dehaze: 20 });
  const matrix = buildColorMatrix('WARM', adj);

  const js8 = Uint8ClampedArray.from(PIXELS_8);
  applyColorMatrixInPlace(js8, W, H, matrix);
  applyToneMapInPlace(js8, W, H, adj.shadows, adj.highlights);
  const gl = adjustRgba16Cpu(rgba16BytesFrom8(PIXELS_8), W, H, matrix, adj.shadows, adj.highlights);

  for (let p = 0; p < W * H; p++)
    for (let c = 0; c < 3; c++)
      expect(Math.abs(js8[p * 4 + c] / 255 - gl[p * 4 + c])).toBeLessThanOrEqual(0.5 / 255);
  expect(js8[3]).toBe(255); // alpha untouched
});

// Guard: a deliberately wrong matrix layout (transpose) MUST break parity, so the test can
// never silently pass if adjustRgba16Cpu degrades to an identity/no-op.
test('tone-math parity: transposed matrix is detected as a mismatch', () => {
  const adj = clampAdjustments({ saturation: 30 });
  const matrix = buildColorMatrix('SEPIA', adj);
  const transposed = matrix.slice();
  [transposed[1], transposed[5]] = [transposed[5], transposed[1]];
  [transposed[2], transposed[10]] = [transposed[10], transposed[2]];
  [transposed[7], transposed[11]] = [transposed[11], transposed[7]];

  const js8 = Uint8ClampedArray.from(PIXELS_8);
  applyColorMatrixInPlace(js8, W, H, matrix);
  const glWrong = adjustRgba16Cpu(rgba16BytesFrom8(PIXELS_8), W, H, transposed, 0, 0);

  let maxDiff = 0;
  for (let p = 0; p < W * H; p++)
    for (let c = 0; c < 3; c++)
      maxDiff = Math.max(maxDiff, Math.abs(js8[p * 4 + c] / 255 - glWrong[p * 4 + c]));
  expect(maxDiff).toBeGreaterThan(0.5 / 255); // SEPIA is asymmetric → transpose changes output
});

// Guard: the OLD divergent shader tone (0.35/0.65 luma ramp) must NOT match the canonical
// path — proves the shadows/highlights fix is load-bearing, not cosmetic.
test('tone-math parity: legacy 0.35/0.65 ramp would fail the canonical tone', () => {
  const adj = clampAdjustments({ shadows: 80 });
  const matrix = buildColorMatrix('NONE', adj);
  const js = canonical8bit(PIXELS_8, 'NONE', adj); // canonical (128-knee) tone

  // Reproduce the retired shader formula on the same input.
  const view = new Uint16Array(rgba16BytesFrom8(PIXELS_8).buffer);
  let anyDiff = false;
  for (let p = 0; p < W * H; p++) {
    let r = view[p * 4] / 65535, g = view[p * 4 + 1] / 65535, b = view[p * 4 + 2] / 65535;
    // identity matrix (NONE, no sat) → rgb unchanged by matrix
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const lift = adj.shadows / 100;
    r += lift * Math.max(0, 0.35 - luma);
    const legacyN = Math.min(1, Math.max(0, r));
    if (Math.abs(js[p * 4] / 255 - legacyN) > 0.5 / 255) anyDiff = true;
  }
  expect(anyDiff).toBe(true);
});
