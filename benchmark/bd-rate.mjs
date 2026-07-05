// Linear (trapezoidal) BD-rate. ref/test = [{bpp, butteraugli}, ...].
// Returns percent change in rate of `test` vs `ref` at equal distortion,
// integrated over the overlapping butteraugli range. Negative = test smaller.
// Returns null if the curves share no distortion overlap or have <2 points.
function sortByDist(curve) {
  // ascending distortion (butteraugli). Use log10(bpp) for the rate integral.
  return [...curve].filter(p => p.bpp > 0 && Number.isFinite(p.butteraugli))
    .sort((a, b) => a.butteraugli - b.butteraugli)
    .map(p => ({ d: p.butteraugli, r: Math.log10(p.bpp) }));
}
function interpRate(pts, d) {
  // linear interpolation of rate at distortion d; pts ascending in d.
  if (d <= pts[0].d) return pts[0].r;
  if (d >= pts.at(-1).d) return pts.at(-1).r;
  for (let i = 1; i < pts.length; i++) {
    if (d <= pts[i].d) {
      const t = (d - pts[i-1].d) / (pts[i].d - pts[i-1].d);
      return pts[i-1].r + t * (pts[i].r - pts[i-1].r);
    }
  }
  return pts.at(-1).r;
}
export function bdRate(ref, test) {
  const R = sortByDist(ref), T = sortByDist(test);
  if (R.length < 2 || T.length < 2) return null;
  const lo = Math.max(R[0].d, T[0].d);
  const hi = Math.min(R.at(-1).d, T.at(-1).d);
  if (!(hi > lo)) return null;
  // integrate (rate_test - rate_ref) d(distortion) via trapezoid on a fine grid, then average.
  const N = 100;
  let acc = 0;
  for (let i = 0; i < N; i++) {
    const d0 = lo + (hi - lo) * (i / N);
    const d1 = lo + (hi - lo) * ((i + 1) / N);
    const f0 = interpRate(T, d0) - interpRate(R, d0);
    const f1 = interpRate(T, d1) - interpRate(R, d1);
    acc += 0.5 * (f0 + f1) * (d1 - d0);
  }
  const avgLogRatio = acc / (hi - lo);       // mean log10(rate_test/rate_ref)
  return (Math.pow(10, avgLogRatio) - 1) * 100;
}
