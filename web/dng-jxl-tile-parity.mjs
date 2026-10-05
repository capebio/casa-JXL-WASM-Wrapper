// Parity of the app's wasm libjxl tile decoder (dng-jxl-libjxl.js) against
// native libjxl, per sample. Feed it the dir the Rust test
// `jxl_dng_tiles_route_through_installed_decoder` filled under JXL_TILE_DUMP:
//   node web/dng-jxl-tile-parity.mjs <dir>
// Prints, per DNG: tiles, samples, differing samples, max |delta|.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadLibjxlTileDecoder } from './dng-jxl-libjxl.js';

const dir = process.argv[2];
const wasmBinary = readFileSync(new URL('../packages/jxl-wasm/dist/jxl-core.dec.simd.wasm', import.meta.url));
const decode = await loadLibjxlTileDecoder({ wasmBinary });
const stats = new Map();
for (const f of readdirSync(dir).filter(f => f.endsWith('.u16'))) {
  const [, name, i, cps, w, h] = f.match(/^(.+)\.(\d+)\.(\d)\.(\d+)x(\d+)\.u16$/);
  const native = new Uint16Array(readFileSync(join(dir, f)).buffer.slice(0));
  const got = decode(readFileSync(join(dir, `${name}.${i}.jxl`)), +cps);
  if (got.w !== +w || got.h !== +h) throw new Error(`${f}: dims ${got.w}x${got.h}`);
  const s = stats.get(name) ?? { tiles: 0, n: 0, diff: 0, max: 0 };
  s.tiles++; s.n += native.length;
  for (let k = 0; k < native.length; k++) {
    const d = Math.abs(native[k] - got.samples[k]);
    if (d) { s.diff++; if (d > s.max) s.max = d; }
  }
  stats.set(name, s);
}
for (const [name, s] of stats) {
  console.log(`${name}: tiles ${s.tiles}, samples ${s.n}, differing ${s.diff} (${(100 * s.diff / s.n).toFixed(4)}%), max |d| ${s.max}`);
}
