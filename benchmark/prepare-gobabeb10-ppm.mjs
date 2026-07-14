// Develop 10 ORFs from tests/Gobabeb 10 → full-res RGB8 PPM for codec compare.
// Run: node benchmark/prepare-gobabeb10-ppm.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import initRaw, { process_orf_with_flags } from '../pkg/raw_converter_wasm.js';

await initRaw({ module_or_path: readFileSync(new URL('../pkg/raw_converter_wasm_bg.wasm', import.meta.url)) });

const GOB = String.raw`C:\Foo\raw-converter\tests\Gobabeb 10`;
const OUT = String.raw`C:\Foo\raw-converter\tests\fractal_gen\_compress_probe\bench\gobabeb10`;
mkdirSync(OUT, { recursive: true });

const FULL = 1;
const ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

const orfs = readdirSync(GOB)
  .filter((f) => f.toLowerCase().endsWith('.orf'))
  .sort();

if (orfs.length !== 10) {
  console.error(`expected 10 ORFs in ${GOB}, found ${orfs.length}`);
  process.exit(1);
}

const manifest = [];
for (const name of orfs) {
  const path = join(GOB, name);
  const stem = basename(name, '.ORF').replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const outPpm = join(OUT, `${stem}.ppm`);
  if (existsSync(outPpm)) {
    console.log(`  skip existing ${stem}.ppm`);
    manifest.push({ stem, src: name, ppm: outPpm, reused: true });
    continue;
  }
  console.log(`develop ${name} ...`);
  const t0 = performance.now();
  const raw = new Uint8Array(readFileSync(path));
  const dec = process_orf_with_flags(raw, FULL, ...ARGS);
  let w = dec.width, h = dec.height;
  let rgb = Buffer.from(dec.take_rgb());
  dec.free();
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
  console.log(`  ${stem}: ${w}x${h} (${ms} ms)`);
  manifest.push({ stem, src: name, ppm: outPpm, w, h, develop_ms: +ms });
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\n${manifest.length} PPMs in ${OUT}`);
