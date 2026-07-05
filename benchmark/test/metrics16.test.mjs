import { test } from "node:test";
import assert from "node:assert/strict";
import { psnr16, ssim16 } from "../metrics16.mjs";

// 2x2 RGBA16 opaque
function img(vals) { // vals = 4 pixels x [r,g,b]; alpha auto 0xFFFF
  const out = new Uint16Array(4 * 4);
  for (let p = 0; p < 4; p++) { out[p*4]=vals[p][0]; out[p*4+1]=vals[p][1]; out[p*4+2]=vals[p][2]; out[p*4+3]=0xFFFF; }
  return out;
}
const A = img([[100,100,100],[200,200,200],[300,300,300],[400,400,400]]);

test("psnr16 identical -> Infinity", () => {
  assert.equal(psnr16(A, A, 2, 2), Infinity);
});

test("psnr16 resolves sub-8-bit diffs", () => {
  const B = img([[101,100,100],[200,200,200],[300,300,300],[400,400,400]]); // +1 in 16-bit
  const p = psnr16(A, B, 2, 2);
  // exact answer 107.12 dB; tight window pins the peak constant + n*3 denom (a wrong L2 or denom lands outside)
  assert.ok(Number.isFinite(p) && p > 104 && p < 110, `psnr16=${p}`);
});

test("psnr16 max-diff -> 0 dB (validates peak=65535)", () => {
  const w = 2, h = 2;
  const black = new Uint16Array(w * h * 4); for (let p = 0; p < w * h; p++) black[p*4+3] = 0xFFFF;
  const white = new Uint16Array(w * h * 4); for (let i = 0; i < white.length; i++) white[i] = 0xFFFF;
  const p = psnr16(black, white, w, h);
  assert.ok(Math.abs(p) < 1e-9, `max-diff psnr16 should be 0 dB, got ${p}`);
});

test("ssim16 identical -> ~1", () => {
  const s = ssim16(A, A, 2, 2);
  assert.ok(Math.abs(s - 1) < 1e-9, `ssim16=${s}`);
});

test("ssim16 degrades with noise", () => {
  const B = img([[100,100,100],[200,200,200],[300,300,300],[40000,40000,40000]]);
  const s = ssim16(A, B, 2, 2);
  assert.ok(s < 0.999, `ssim16=${s}`);
});
