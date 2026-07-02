// ae5-membench.mjs — A/B verify for AE-5 (RAW input by value, dropped after decompress).
//
// Loads ONE wasm-pack (--target nodejs) build and runs process_orf_with_flags /
// process_dng_with_flags / process_cr2_with_flags over a fixture list, reporting
// per (file × flags):
//   - FNV-1a hashes of take_rgb / take_rgb16_lb / take_rgb16_thumb / take_rgb16_full
//   - wasm linear-memory high-water right after process (monotonic ⇒ true peak)
//
// Run once per build and diff the JSON (hashes must be identical; NEW peak should
// drop by ~ the raw-input footprint on full-res paths):
//   node tools/ae5-membench.mjs <pkgDir> <file> <fmt:orf|dng|cr2> [flags...]
//
// One (file × flags-set) per process so wasm high-water reflects only that call.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [pkgDir, filePath, fmt, ...flagArgs] = process.argv.slice(2);
if (!pkgDir || !filePath || !fmt) {
  console.error('usage: node ae5-membench.mjs <pkgDir> <file> <orf|dng|cr2> [flags...]');
  process.exit(2);
}
const flagsList = flagArgs.length ? flagArgs.map(Number) : [7];

function fnv1a(bytes) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < bytes.length; i++) {
    h = (h ^ BigInt(bytes[i])) & mask;
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}
const MB = (b) => +(b / (1024 * 1024)).toFixed(1);

const raw = readFileSync(resolve(filePath));
const pkgJson = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf8'));
const mod = await import(pathToFileURL(resolve(pkgDir, pkgJson.main)).href);
const wasmBytes = () => mod.__wasm?.memory?.buffer?.byteLength ?? 0;

const entry = {
  orf: mod.process_orf_with_flags,
  dng: mod.process_dng_with_flags,
  cr2: mod.process_cr2_with_flags,
}[fmt];
if (!entry) { console.error(`no entry for fmt ${fmt}`); process.exit(2); }

const results = [];
for (const flags of flagsList) {
  const data = new Uint8Array(raw); // fresh copy per call (entry may consume it)
  const before = wasmBytes();
  const res = entry(data, flags, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
  const afterProcess = wasmBytes();
  const rgb = res.take_rgb();
  const lb = res.take_rgb16_lb();
  const thumb = res.take_rgb16_thumb();
  const full16 = res.take_rgb16_full();
  results.push({
    flags,
    dims: { w: res.width, h: res.height },
    hash: {
      rgb: fnv1a(rgb), lb: fnv1a(lb), thumb: fnv1a(thumb), full16: fnv1a(full16),
    },
    bytes: { rgb: rgb.length, lb: lb.length, thumb: thumb.length, full16: full16.length },
    wasm_linear_MB: { before: MB(before), after_process: MB(afterProcess) },
  });
  res.free?.();
}
console.log(JSON.stringify({ pkg: pkgDir, file: filePath, fmt, results }, null, 2));
