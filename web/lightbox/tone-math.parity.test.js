// web/lightbox/tone-math.parity.test.js
// S2-Q2 — single-source tone math parity.
//
// The 8-bit preview path (filter-engine.applyColorMatrixInPlace, canonical) and the
// 16-bit WebGL float path (webgl-pipeline GLSL shader) must produce IDENTICAL color for
// identical slider values at the same pixel. Both consume buildColorMatrix(). This test
// pins that the GLSL uniform layout matches the 8-bit applicator's index layout across the
// /255 scale difference:
//
//   filter-engine (0..255):   r' = r*m[0]  + g*m[1]  + b*m[2]  + m[4]
//                             g' = r*m[5]  + g*m[6]  + b*m[7]  + m[9]
//                             b' = r*m[10] + g*m[11] + b*m[12] + m[14]
//   webgl uniforms (0..1):   uM0=[m0,m1,m2] uM1=[m5,m6,m7] uM2=[m10,m11,m12]
//                             uOff=[m4,m9,m14]/255   →  same transform at 1/255 scale.
//
// GLSL can't run under bun, so the shader is exercised via adjustRgba16Cpu() — the shipped
// CPU fallback in webgl-pipeline.js that mirrors the shader using the SAME internal
// matrixUniforms() mapping the shader uploads (per handoff step 3: reconstruct the mat4 by
// hand / via the CPU twin to confirm layout). The full browser-render round-trip (real
// GLSL, sliders on jxl-progressive-gallery.html) remains user-assisted.
//
// SCOPE = color matrix only: presets + brightness/contrast/saturation/clarity/dehaze.
// Shadows/highlights tone-mapping DIVERGES by design between the paths
// (filter-engine.applyToneMapInPlace uses piecewise 128/192 luma masks; the shader uses
// 0.35/0.65 luma ramps) — a separate M2-preview vs M3-HDR approximation, out of scope for
// matrix single-sourcing. Every config below uses shadows=0, highlights=0 so the GL tone
// stage is a no-op and only the matrix is compared.

import { expect, test } from 'bun:test';
import { buildColorMatrix, applyColorMatrixInPlace } from './filter-engine.js';
import { adjustRgba16Cpu } from './webgl-pipeline.js';

const W = 3, H = 1;
const PIXELS_8 = [100, 140, 90, 255, 30, 200, 220, 255, 180, 60, 120, 255]; // 3 RGBA8 px

function clamp01(v) { return Math.min(1, Math.max(0, v)); }

// Exact 8→16 lift: v16 = v8*257 so v16/65535 === v8/255 exactly (adjustRgba16Cpu
// normalizes /65535, matching filter-engine's /255 with no requantization error).
function rgba16BytesFrom8(px8) {
  const u16 = new Uint16Array(px8.length);
  for (let i = 0; i < px8.length; i++) u16[i] = px8[i] * 257;
  return new Uint8Array(u16.buffer);
}

const CONFIGS = [
  { name: 'neutral', preset: 'NONE', adj: {} },
  { name: 'saturate', preset: 'NONE', adj: { saturation: 80 } },
  { name: 'desaturate', preset: 'NONE', adj: { saturation: -80 } },
  { name: 'clarity+dehaze offset', preset: 'NONE', adj: { clarity: 40, dehaze: 50 } },
];

for (const cfg of CONFIGS) {
  // Exercises the REAL functions on both sides. JS side rounds into Uint8ClampedArray, so
  // the strict criterion is ≤ 0.5/255 per channel (one 8-bit quantization step).
  test(`tone-math parity: ${cfg.name} — filter-engine 8-bit == webgl float ≤ 0.5/255`, () => {
    const matrix = buildColorMatrix(cfg.preset, cfg.adj);

    const js = Uint8ClampedArray.from(PIXELS_8);
    applyColorMatrixInPlace(js, W, H, matrix);

    const gl = adjustRgba16Cpu(rgba16BytesFrom8(PIXELS_8), W, H, matrix, 0, 0);

    for (let p = 0; p < W * H; p++) {
      for (let c = 0; c < 3; c++) {
        const jsN = js[p * 4 + c] / 255; // 0..1
        const glN = gl[p * 4 + c];       // 0..1
        expect(Math.abs(jsN - glN)).toBeLessThanOrEqual(0.5 / 255 + 1e-9);
      }
    }
    // alpha untouched on the 8-bit side
    expect(js[3]).toBe(255);
  });

  // Pre-quantization proof: the two paths do the IDENTICAL linear algebra (no layout
  // transpose, no scale/offset drift hidden under 8-bit rounding). Reconstruct the 8-bit
  // applicator's matrix math in float and compare to the GL float output near-exactly.
  test(`tone-math parity: ${cfg.name} — identical matrix math (float, 1e-6)`, () => {
    const matrix = buildColorMatrix(cfg.preset, cfg.adj);
    const gl = adjustRgba16Cpu(rgba16BytesFrom8(PIXELS_8), W, H, matrix, 0, 0);
    for (let p = 0; p < W * H; p++) {
      const r = PIXELS_8[p * 4] / 255, g = PIXELS_8[p * 4 + 1] / 255, b = PIXELS_8[p * 4 + 2] / 255;
      const jr = clamp01(r * matrix[0] + g * matrix[1] + b * matrix[2] + matrix[4] / 255);
      const jg = clamp01(r * matrix[5] + g * matrix[6] + b * matrix[7] + matrix[9] / 255);
      const jb = clamp01(r * matrix[10] + g * matrix[11] + b * matrix[12] + matrix[14] / 255);
      expect(gl[p * 4]).toBeCloseTo(jr, 6);
      expect(gl[p * 4 + 1]).toBeCloseTo(jg, 6);
      expect(gl[p * 4 + 2]).toBeCloseTo(jb, 6);
    }
  });
}

// A deliberately wrong layout (transposed matrix) MUST break parity — guards the test from
// silently passing if adjustRgba16Cpu ever degrades to an identity/no-op.
test('tone-math parity: transposed matrix is detected as a mismatch', () => {
  const matrix = buildColorMatrix('SEPIA', { saturation: 30 });
  const transposed = matrix.slice();
  // swap the off-diagonal color terms m[1]<->m[5], m[2]<->m[10], m[7]<->m[11]
  [transposed[1], transposed[5]] = [transposed[5], transposed[1]];
  [transposed[2], transposed[10]] = [transposed[10], transposed[2]];
  [transposed[7], transposed[11]] = [transposed[11], transposed[7]];

  const js = Uint8ClampedArray.from(PIXELS_8);
  applyColorMatrixInPlace(js, W, H, matrix);
  const glWrong = adjustRgba16Cpu(rgba16BytesFrom8(PIXELS_8), W, H, transposed, 0, 0);

  let maxDiff = 0;
  for (let p = 0; p < W * H; p++)
    for (let c = 0; c < 3; c++)
      maxDiff = Math.max(maxDiff, Math.abs(js[p * 4 + c] / 255 - glWrong[p * 4 + c]));
  expect(maxDiff).toBeGreaterThan(0.5 / 255); // SEPIA is asymmetric → transpose changes output
});
