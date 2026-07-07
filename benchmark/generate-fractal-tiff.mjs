// Generate synthetic fractal TIFF test files.
// Mandelbrot-coloured 8-bit RGB at multiple sizes.
// Output: C:\Foo\raw-converter\tests\fractal_<size>.tiff

import sharp from 'sharp';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = String.raw`C:\Foo\raw-converter\tests`;

function mandelbrot(cx, cy, maxIter) {
  let x = 0, y = 0;
  for (let i = 0; i < maxIter; i++) {
    const x2 = x * x, y2 = y * y;
    if (x2 + y2 > 4) return i;
    y = 2 * x * y + cy;
    x = x2 - y2 + cx;
  }
  return maxIter;
}

// Map iteration count to a vivid RGB colour for good channel separation.
function iterToRgb(iter, maxIter) {
  if (iter === maxIter) return [0, 0, 0]; // inside set = black
  const t = iter / maxIter;
  // Cycle through distinct hues: red→yellow→green→cyan→blue→magenta
  // Using a simple palette that avoids grey balance (tests channel separation).
  const h = (t * 6) % 6;
  const s = 0.85 + 0.15 * Math.sin(t * Math.PI * 3);
  // HSV → RGB (integer sector)
  const sector = Math.floor(h);
  const f = h - sector;
  const p = Math.round(255 * (1 - s));
  const q = Math.round(255 * (1 - s * f));
  const tv = Math.round(255 * (1 - s * (1 - f)));
  const v = Math.round(255 * (0.4 + 0.6 * t));
  const vv = Math.round(v * (0.4 + 0.6 * t));
  switch (sector % 6) {
    case 0: return [vv, Math.round(v * (f * 0.6 + 0.2)), p];
    case 1: return [Math.round(v * ((1 - f) * 0.6 + 0.2)), vv, p];
    case 2: return [p, vv, Math.round(v * (f * 0.6 + 0.2))];
    case 3: return [p, Math.round(v * ((1 - f) * 0.6 + 0.2)), vv];
    case 4: return [Math.round(v * (f * 0.6 + 0.2)), p, vv];
    default: return [vv, p, Math.round(v * ((1 - f) * 0.6 + 0.2))];
  }
}

async function generateTiff(width, height) {
  const maxIter = 200;
  const buf = Buffer.alloc(width * height * 3);

  // Mandelbrot view: x in [-2.5, 1.0], y in [-1.25, 1.25]
  const xMin = -2.5, xMax = 1.0;
  const yMin = -1.25, yMax = 1.25;

  for (let py = 0; py < height; py++) {
    const cy = yMin + (py / height) * (yMax - yMin);
    for (let px = 0; px < width; px++) {
      const cx = xMin + (px / width) * (xMax - xMin);
      const iter = mandelbrot(cx, cy, maxIter);
      const [r, g, b] = iterToRgb(iter, maxIter);
      const off = (py * width + px) * 3;
      buf[off] = r; buf[off + 1] = g; buf[off + 2] = b;
    }
  }

  const outPath = join(OUT_DIR, `fractal_${width}x${height}.tiff`);
  await sharp(buf, { raw: { width, height, channels: 3 } })
    .tiff({ compression: 'none' })
    .toFile(outPath);

  console.log(`  Written: ${outPath} (${(buf.byteLength / 1024).toFixed(0)} KB raw, ${width}x${height})`);
  return outPath;
}

console.log('Generating synthetic fractal TIFF test files...');
await generateTiff(512, 512);
await generateTiff(1024, 1024);
await generateTiff(2048, 2048);
console.log('Done.');
