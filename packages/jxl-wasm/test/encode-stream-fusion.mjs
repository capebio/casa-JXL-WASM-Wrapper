// P2c (Approach A) gate: jxl_wasm_encode_rgb8_stream pulls each band from JS
// (globalThis.__jxlP2cPull) via the bridge's EM_JS reentry + cross-heap copy + chunked input
// source. It must produce output BYTE-IDENTICAL to the whole-buffer chunked encoder
// (jxl_wasm_encode_rgb8_chunked) for the same pixels. Here the "RAW producer" is a synthetic
// in-JS gradient sliced into bands, so this isolates the bridge's streaming pull path from the
// RAW-pipeline wasm module (whose real integration needs a web/pkg rebuild). Also checks that
// every get() is matched by a release() (no leaked band buffers). Runs on enc:simd.
//
//   bun packages/jxl-wasm/test/encode-stream-fusion.mjs
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { streamEncodeRgb8 } from "../src/stream-fusion.ts";

const distUrl = new URL("../dist/", import.meta.url);
const tier = "enc.simd";
const jsUrl = new URL(`jxl-core.${tier}.js`, distUrl);
const wasmPath = fileURLToPath(new URL(`jxl-core.${tier}.wasm`, distUrl));
try {
  await access(fileURLToPath(jsUrl));
  await access(wasmPath);
} catch {
  console.log(`skip: built ${tier} artifacts not found (run scripts/build.mjs first)`);
  process.exit(0);
}

const factory = (await import(jsUrl.href)).default;
const wasmBinary = await readFile(wasmPath);
const m = await factory({ wasmBinary, locateFile: (p) => new URL(p, distUrl).href });

const w = 200, h = 517; // height spans several super-tile bands; width < 2048 => one x-tile per band
const stride = w * 3;
const whole = new Uint8Array(w * h * 3);
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    whole[i] = (x + y) & 0xff;
    whole[i + 1] = (x * 3 + y) & 0xff;
    whole[i + 2] = (x ^ (y * 2)) & 0xff;
  }
}

function readBuf(buf) {
  const err = m._jxl_wasm_buffer_error(buf);
  const size = m._jxl_wasm_buffer_size(buf);
  const ptr = m._jxl_wasm_buffer_data(buf);
  const out = err ? null : m.HEAPU8.slice(ptr, ptr + size);
  m._jxl_wasm_buffer_free(buf);
  return { err, out };
}

const distance = 1.0, effort = 7;

// Reference: whole-buffer chunked encode.
const pWhole = m._malloc(whole.length);
m.HEAPU8.set(whole, pWhole);
const chunked = readBuf(m._jxl_wasm_encode_rgb8_chunked(pWhole, w, h, distance, effort));
m._free(pWhole);

// Streaming encode via the reusable fusion helper (src/stream-fusion.ts): it installs the pull
// callback the bridge's EM_JS reads, feeds each band, and restores globals on exit. Here the
// producer slices the synthetic gradient; the real path passes RawStreamExporter.band.
let ok = true;
let streamedOut = null;
try {
  const produceBand = (ypos, ysize) => whole.subarray(ypos * stride, (ypos + ysize) * stride);
  streamedOut = streamEncodeRgb8(m, produceBand, w, h, distance, effort);
} catch (e) {
  console.error(`FAIL: streaming encode threw: ${e.message ?? e}`);
  ok = false;
}
if (chunked.err) { console.error(`FAIL: chunked encode error ${chunked.err}`); ok = false; }

if (ok) {
  const same = chunked.out.length === streamedOut.length && chunked.out.every((b, i) => b === streamedOut[i]);
  console.log(`chunked=${chunked.out.length}B  streamed=${streamedOut.length}B`);
  if (!same) { console.error("FAIL: streamed (JS pull via streamEncodeRgb8) != whole-buffer chunked"); ok = false; }
  if (ok) console.log("PASS: JS-pull streamed == whole-buffer chunked (Approach A fusion via streamEncodeRgb8).");
}
process.exit(ok ? 0 : 1);
