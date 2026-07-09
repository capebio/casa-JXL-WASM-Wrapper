// Deterministic fractal test-image generator — browser port of
// crates/raw-pipeline/src/calibration/fractal.rs. Same escape-time math + smooth
// sinusoid palette + splitmix64 dither, so a tile generated here matches the Rust
// side (used for the browser calibration bench + as a known-output oracle).
//
// Note on parity: the escape/palette math is f64 in both Rust and JS; transcendental
// last-ULP differences are possible but wash out under the u8 truncation for the
// small tiles the bench uses. Exact cross-language byte-parity is a documented
// follow-up (would pin a shared golden vector).

const TWO_PI_3 = (2 * Math.PI) / 3;
const FOUR_PI_3 = (4 * Math.PI) / 3;
const LN2 = Math.LN2;

/** @typedef {"Mandelbrot"|"BurningShip"|{Julia:{c_re:number,c_im:number}}} Kind */

/** Named datasets, matching the Rust `Dataset` presets. */
export const DATASETS = [
  "mandelbrot-seahorse",
  "mandelbrot-full",
  "julia-a",
  "julia-b",
  "burning-ship",
];

/** Build the fixed-viewport spec for a named dataset at a given pixel size. */
export function preset(id, width, height) {
  const base = (kind, cx, cy, scale, maxIter, phase) => ({
    kind,
    width,
    height,
    centerRe: cx,
    centerIm: cy,
    scale,
    maxIter,
    palettePhase: phase,
    dither: false,
  });
  switch (id) {
    case "mandelbrot-seahorse":
      return base("Mandelbrot", -0.743643887037, 0.131825904205, 0.005, 512, 0.0);
    case "mandelbrot-full":
      return base("Mandelbrot", -0.5, 0.0, 1.25, 256, 1.0);
    case "julia-a":
      return base({ Julia: { c_re: -0.8, c_im: 0.156 } }, 0.0, 0.0, 1.5, 256, 2.0);
    case "julia-b":
      return base({ Julia: { c_re: 0.285, c_im: 0.01 } }, 0.0, 0.0, 1.5, 256, 3.0);
    case "burning-ship":
      return base("BurningShip", -0.5, -0.5, 0.6, 256, 4.0);
    default:
      throw new Error(`unknown fractal dataset: ${id}`);
  }
}

// splitmix64 finaliser using BigInt for exact 64-bit wrapping (matches Rust u64).
const MASK64 = (1n << 64n) - 1n;
function splitmix64(x) {
  let z = (x + 0x9e3779b97f4a7c15n) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

function ditherPixel(r, g, b, px, py) {
  const base = ((BigInt(px) << 32n) | BigInt(py)) & MASK64;
  const d = (chan) => Number(splitmix64(base ^ (BigInt(chan) << 3n)) & 0x7n) - 3; // -3..+4
  const clamp = (v) => Math.max(0, Math.min(255, v));
  return [clamp(r + d(1)), clamp(g + d(2)), clamp(b + d(3))];
}

function palette(mu, phase) {
  const t = mu * 0.15 + phase;
  const r = (0.5 + 0.5 * Math.sin(t)) * 255.0;
  const g = (0.5 + 0.5 * Math.sin(t + TWO_PI_3)) * 255.0;
  const b = (0.5 + 0.5 * Math.sin(t + FOUR_PI_3)) * 255.0;
  // Rust `as u8` truncates toward zero — match with Math.trunc.
  return [Math.trunc(r), Math.trunc(g), Math.trunc(b)];
}

function escape(spec, cx, cy) {
  let zx, zy, kx, ky;
  if (typeof spec.kind === "object" && spec.kind.Julia) {
    zx = cx;
    zy = cy;
    kx = spec.kind.Julia.c_re;
    ky = spec.kind.Julia.c_im;
  } else {
    zx = 0.0;
    zy = 0.0;
    kx = cx;
    ky = cy;
  }
  const burning = spec.kind === "BurningShip";
  for (let i = 0; i < spec.maxIter; i++) {
    const x2 = zx * zx;
    const y2 = zy * zy;
    if (x2 + y2 > 4.0) {
      const logZn = Math.log(x2 + y2) * 0.5;
      const nu = Math.log(logZn / LN2) / LN2;
      return i + 1.0 - nu;
    }
    if (burning) {
      zx = Math.abs(zx);
      zy = Math.abs(zy);
    }
    const nzx = x2 - y2 + kx;
    zy = 2.0 * zx * zy + ky;
    zx = nzx;
  }
  return null; // inside the set
}

/** Render a spec to a packed RGBA8 Uint8ClampedArray (width*height*4). */
export function renderRgba8(spec) {
  const { width, height } = spec;
  const out = new Uint8ClampedArray(width * height * 4);
  const aspect = width / height;
  const halfH = spec.scale;
  const halfW = spec.scale * aspect;
  for (let py = 0; py < height; py++) {
    const t = (py + 0.5) / height;
    const im = spec.centerIm + (1.0 - 2.0 * t) * halfH;
    for (let px = 0; px < width; px++) {
      const s = (px + 0.5) / width;
      const re = spec.centerRe + (2.0 * s - 1.0) * halfW;
      const idx = (py * width + px) * 4;
      const mu = escape(spec, re, im);
      let rgb = mu === null ? [0, 0, 0] : palette(mu, spec.palettePhase);
      if (spec.dither) rgb = ditherPixel(rgb[0], rgb[1], rgb[2], px, py);
      out[idx] = rgb[0];
      out[idx + 1] = rgb[1];
      out[idx + 2] = rgb[2];
      out[idx + 3] = 255;
    }
  }
  return out;
}
