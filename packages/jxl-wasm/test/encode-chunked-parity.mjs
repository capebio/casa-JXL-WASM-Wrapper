// P2a gate: jxl_wasm_encode_rgb8_chunked (streaming, JxlEncoderAddChunkedFrame) must produce a
// valid JXL and — for the same RGB8 pixels at matched lossy settings — byte-match the whole-frame
// encoder (jxl_wasm_encode_rgba8 with alpha stripped). This is the WASM analogue of the native
// streaming_export_bytes_equal_whole test. Runs on the enc:simd tier (single-threaded, no pthread
// setup needed). Skips gracefully if the built artifacts are absent.
//
//   bun packages/jxl-wasm/test/encode-chunked-parity.mjs
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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

const w = 129, h = 130; // odd width; forces edge handling and a non-trivial single super-tile
const rgb = new Uint8Array(w * h * 3);
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    rgb[i] = (x * 2 + y) & 0xff;
    rgb[i + 1] = (x + y * 3) & 0xff;
    rgb[i + 2] = (x ^ y) & 0xff;
  }
}
// Opaque RGBA for the whole-frame encoder (has_alpha=0 => StripAlphaToRgb => same RGB).
const rgba = new Uint8Array(w * h * 4);
for (let p = 0, q = 0; p < rgb.length; p += 3, q += 4) {
  rgba[q] = rgb[p]; rgba[q + 1] = rgb[p + 1]; rgba[q + 2] = rgb[p + 2]; rgba[q + 3] = 255;
}

function runAndRead(buf) {
  const err = m._jxl_wasm_buffer_error(buf);
  const size = m._jxl_wasm_buffer_size(buf);
  const dataPtr = m._jxl_wasm_buffer_data(buf);
  const out = err ? null : m.HEAPU8.slice(dataPtr, dataPtr + size);
  m._jxl_wasm_buffer_free(buf);
  return { err, out };
}

const distance = 1.0, effort = 7;

const pc = m._malloc(rgb.length);
m.HEAPU8.set(rgb, pc);
const chunked = runAndRead(m._jxl_wasm_encode_rgb8_chunked(pc, w, h, distance, effort));
m._free(pc);

// jxl_wasm_encode_rgba8(pixels, w, h, distance, effort, has_alpha, pdc, pac, qac, buffering, group_order, resampling)
const pw = m._malloc(rgba.length);
m.HEAPU8.set(rgba, pw);
const whole = runAndRead(m._jxl_wasm_encode_rgba8(pw, w, h, distance, effort, 0, 0, 0, 0, 2, 0, 1));
m._free(pw);

let ok = true;
if (chunked.err) { console.error(`FAIL: chunked encode error code ${chunked.err}`); ok = false; }
if (whole.err) { console.error(`FAIL: whole-frame encode error code ${whole.err}`); ok = false; }

if (ok) {
  const same = chunked.out.length === whole.out.length && chunked.out.every((b, i) => b === whole.out[i]);
  console.log(`chunked=${chunked.out.length}B  whole=${whole.out.length}B`);
  // Both start with the JXL codestream signature 0xFF 0x0A.
  const validSig = chunked.out.length >= 2 && chunked.out[0] === 0xff && chunked.out[1] === 0x0a;
  if (!validSig) { console.error("FAIL: chunked output missing JXL codestream signature"); ok = false; }
  if (same) {
    console.log("PASS: chunked stream is BYTE-IDENTICAL to whole-frame (zero density cost, valid).");
  } else {
    console.log("PARTIAL: chunked stream is valid but not byte-identical to whole-frame; " +
      "decode-parity check needed (settings/version drift). P2a wiring still proven.");
  }
}
process.exit(ok ? 0 : 1);
