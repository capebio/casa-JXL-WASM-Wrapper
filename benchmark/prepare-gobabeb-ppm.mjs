// Develop first 10 Gobabeb ORFs to full-res RGB8 PPM for lossless codec compare.
// Uses our WASM process_orf_with_flags (full-res RGB only). Even-crop width if odd
// so LT2 pack (W//2) is safe.
//
// Run from repo root:
//   node benchmark/prepare-gobabeb-ppm.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import initRaw, { process_orf_with_flags } from '../pkg/raw_converter_wasm.js';

await initRaw({ module_or_path: readFileSync(new URL('../pkg/raw_converter_wasm_bg.wasm', import.meta.url)) });

const GOB = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const OUT = String.raw`C:\Foo\raw-converter\tests\fractal_gen\_compress_probe\bench\gobabeb`;
mkdirSync(OUT, { recursive: true });

const FULL = 1;
const ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

const orfs = readdirSync(GOB)
  .filter((f) => f.toLowerCase().endsWith('.orf'))
  .sort()
  .slice(0, 10);

if (orfs.length < 10) {
  console.error(`only found ${orfs.length} ORFs in ${GOB}`);
  process.exit(1);
}

const manifest = [];
for (const name of orfs) {
  const path = join(GOB, name);
  const stem = basename(name, '.ORF').replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const outPpm = join(OUT, `${stem}.ppm`);
  if (existsSync(outPpm)) {
    const st = readFileSync(outPpm);
    // cheap header parse for resume
    console.log(`  skip existing ${stem}.ppm (${st.length} B)`);
    manifest.push({ stem, src: name, ppm: outPpm, bytes: st.length, reused: true });
    continue;
  }
  console.log(`develop ${name} ...`);
  const t0 = performance.now();
  const raw = new Uint8Array(readFileSync(path));
  const dec = process_orf_with_flags(raw, FULL, ...ARGS);
  let w = dec.width, h = dec.height;
  let rgb = Buffer.from(dec.take_rgb());
  dec.free();
  // even width for LT2 pack
  if (w % 2 === 1) {
    const nw = w - 1;
    const cropped = Buffer.alloc(nw * h * 3);
    for (let y = 0; y < h; y++) {
      rgb.copy(cropped, y * nw * 3, y * w * 3, y * w * 3 + nw * 3);
    }
    rgb = cropped; w = nw;
  }
  const header = Buffer.from(`P6\n${w} ${h}\n255\n`, 'ascii');
  writeFileSync(outPpm, Buffer.concat([header, rgb]));
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`  ${stem}: ${w}x${h} -> ${outPpm} (${rgb.length + header.length} B, ${ms} ms)`);
  manifest.push({ stem, src: name, ppm: outPpm, w, h, bytes: rgb.length + header.length, develop_ms: +ms });
}

writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\n${manifest.length} PPMs ready in ${OUT}`);
