// P2c end-to-end harness (headless): the TWO-MODULE fusion with real pixels.
//   real DNG  ->  RawStreamExporter.band()  (web/pkg RAW-pipeline wasm module)
//             ->  streamEncodeRgb8          (src/stream-fusion.ts)
//             ->  jxl_wasm_encode_rgb8_stream (jxl-wasm bridge module, EM_JS pull)
// Asserts the streamed JXL is byte-identical to a whole-image chunked encode of the same bands,
// i.e. RawStreamExporter's bands cross the module boundary into the bridge encoder correctly.
//
// Uses a SINGLE-THREADED web/pkg (web/pkg-st): bun cannot load the shared-memory parallel-wasm
// module on Windows (mprotect). Parallel vs serial demosaic/tone are byte-identical, so the pixels
// match the shipped parallel build. A browser/Playwright variant would exercise the threaded module.
//
// Setup (all local, none committed):
//   1) wasm-pack build --target web --out-dir web/pkg-st --release      (single-threaded RAW module)
//   2) the shipped packages/jxl-wasm/dist/jxl-core.enc.simd.{js,wasm}    (bridge; already built)
//   3) a raw fixture under .timing-source (same as tests/dng_stream.rs)
//   Run: bun packages/jxl-wasm/test/stream-export-e2e.mjs
// Skips cleanly if any of the three is absent.
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { streamEncodeRgb8 } from "../src/stream-fusion.ts";

const repoRoot = new URL("../../../", import.meta.url); // packages/jxl-wasm/test/ -> repo root
const rawJs = new URL("web/pkg-st/raw_converter_wasm.js", repoRoot);
const encDist = new URL("packages/jxl-wasm/dist/", repoRoot);
const encJs = new URL("jxl-core.enc.simd.js", encDist);
const encWasm = fileURLToPath(new URL("jxl-core.enc.simd.wasm", encDist));
const fixtures = [
  "C:/Foo/rcw-p2-wasm/.timing-source/PXL_20260527_180319603.RAW-02.ORIGINAL.dng",
  fileURLToPath(new URL(".timing-source/PXL_20260527_180319603.RAW-02.ORIGINAL.dng", repoRoot)),
];

async function firstPresent(paths) {
  for (const p of paths) { try { await access(p); return p; } catch {} }
  return null;
}
async function present(p) { try { await access(p); return true; } catch { return false; } }

if (!(await present(fileURLToPath(rawJs)))) { console.log("skip: web/pkg-st not built (wasm-pack build --target web --out-dir web/pkg-st)"); process.exit(0); }
if (!(await present(fileURLToPath(encJs))) || !(await present(encWasm))) { console.log("skip: enc:simd bridge not built"); process.exit(0); }
const dngPath = await firstPresent(fixtures);
if (!dngPath) { console.log("skip: no raw fixture under .timing-source"); process.exit(0); }

// RAW-pipeline module (single-threaded web/pkg-st) + jxl-wasm bridge (enc:simd).
const raw = await import(rawJs.href);
await raw.default();
const bridgeFactory = (await import(encJs.href)).default;
const bridge = await bridgeFactory({ wasmBinary: await readFile(encWasm), locateFile: (p) => new URL(p, encDist).href });

const dng = new Uint8Array(await readFile(dngPath));
const distance = 1.0, effort = 7;

function chunkedEncode(rgb, w, h) {
  const p = bridge._malloc(rgb.length);
  bridge.HEAPU8.set(rgb, p);
  const buf = bridge._jxl_wasm_encode_rgb8_chunked(p, w, h, distance, effort);
  bridge._free(p);
  const err = bridge._jxl_wasm_buffer_error(buf);
  const size = bridge._jxl_wasm_buffer_size(buf);
  const dptr = bridge._jxl_wasm_buffer_data(buf);
  const out = err ? null : bridge.HEAPU8.slice(dptr, dptr + size);
  bridge._jxl_wasm_buffer_free(buf);
  if (err) throw new Error(`chunked encode error ${err}`);
  return out;
}

// Reference: assemble the whole RGB8 by pulling every band from one exporter, then chunked-encode.
const e1 = raw.RawStreamExporter.from_dng(dng, 0);
const w = e1.width, h = e1.height;
const whole = new Uint8Array(w * h * 3);
const B = 256;
for (let y = 0; y < h; y += B) {
  const ys = Math.min(B, h - y);
  whole.set(e1.band(y, ys), y * w * 3);
}
e1.free();
const wholeJxl = chunkedEncode(whole, w, h);

// Streamed: a fresh exporter drives the bridge's streaming encoder band-by-band across the modules.
const e2 = raw.RawStreamExporter.from_dng(dng, 0);
let pulled = 0;
const produceBand = (ypos, ysize) => { pulled++; return e2.band(ypos, ysize); };
const streamedJxl = streamEncodeRgb8(bridge, produceBand, w, h, distance, effort);
e2.free();

const same = wholeJxl.length === streamedJxl.length && wholeJxl.every((b, i) => b === streamedJxl[i]);
console.log(`DNG ${w}x${h} (${(w * h / 1e6).toFixed(1)} MP): whole=${wholeJxl.length}B  streamed=${streamedJxl.length}B  bands_pulled=${pulled}`);
if (same) {
  console.log("PASS: real DNG streamed (web/pkg RawStreamExporter -> streamEncodeRgb8 -> bridge) == whole-image chunked. Two-module fusion works end-to-end.");
} else {
  console.error("FAIL: streamed != whole-image chunked");
  process.exit(1);
}
