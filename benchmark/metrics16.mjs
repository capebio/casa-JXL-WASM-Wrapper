// Pure-JS 16-bit distortion metrics over interleaved RGBA16 (Uint16Array, alpha ignored).
// PSNR peak = 65535. SSIM on 16-bit luma, 8x8 non-overlapping windows (edge windows clipped).
const PEAK = 65535;
const L2 = PEAK * PEAK;
const C1 = (0.01 * PEAK) ** 2;
const C2 = (0.03 * PEAK) ** 2;

function assertShape(ref, test, w, h) {
  if (ref.length !== w * h * 4 || test.length !== w * h * 4)
    throw new Error(`metrics16: expected ${w * h * 4} samples, got ref=${ref.length} test=${test.length}`);
}

export function psnr16(ref, test, w, h) {
  assertShape(ref, test, w, h);
  let sse = 0;
  const n = w * h;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    for (let c = 0; c < 3; c++) { const d = ref[i + c] - test[i + c]; sse += d * d; }
  }
  if (sse === 0) return Infinity;
  const mse = sse / (n * 3);
  return 10 * Math.log10(L2 / mse);
}

function luma16(buf, w, h) {
  const out = new Float64Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    out[p] = 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2];
  }
  return out;
}

export function ssim16(ref, test, w, h) {
  assertShape(ref, test, w, h);
  const a = luma16(ref, w, h), b = luma16(test, w, h);
  let sum = 0, wins = 0;
  for (let by = 0; by < h; by += 8) {
    for (let bx = 0; bx < w; bx += 8) {
      const x1 = Math.min(bx + 8, w), y1 = Math.min(by + 8, h);
      let ma = 0, mb = 0, cnt = 0;
      for (let y = by; y < y1; y++) for (let x = bx; x < x1; x++) { const k = y * w + x; ma += a[k]; mb += b[k]; cnt++; }
      ma /= cnt; mb /= cnt;
      let va = 0, vb = 0, cov = 0;
      for (let y = by; y < y1; y++) for (let x = bx; x < x1; x++) { const k = y * w + x; const da = a[k] - ma, db = b[k] - mb; va += da * da; vb += db * db; cov += da * db; }
      va /= cnt; vb /= cnt; cov /= cnt;
      const s = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      sum += s; wins++;
    }
  }
  return wins ? sum / wins : 1;
}
