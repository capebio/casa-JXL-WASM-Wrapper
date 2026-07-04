// Uniform codec interface: each adapter = { key, runtime, lossless?, encode(rgba,w,h,quality)->Uint8Array, decode(bytes)->{data,width,height} }.
// `rgba` is a Uint8Array (4ch). Decoded `data` is a Uint8Array (4ch).
// The jxl adapter lives in codec-compare-jxl.mjs (needs the facade); this file holds native (sharp) + wasm (@jsquash) codecs.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import sharp from "sharp";
import jpegEnc, { init as initJpegEnc } from "@jsquash/jpeg/encode.js";
import jpegDec, { init as initJpegDec } from "@jsquash/jpeg/decode.js";
import webpEnc, { init as initWebpEnc } from "@jsquash/webp/encode.js";
import webpDec, { init as initWebpDec } from "@jsquash/webp/decode.js";
import avifEnc, { init as initAvifEnc } from "@jsquash/avif/encode.js";
import avifDec, { init as initAvifDec } from "@jsquash/avif/decode.js";
import jxlEnc, { init as initJxlEnc } from "@jsquash/jxl/encode.js";
import jxlDec, { init as initJxlDec } from "@jsquash/jxl/decode.js";

const require = createRequire(import.meta.url);
const toU8 = (x) => (x instanceof Uint8Array ? x : new Uint8Array(x.buffer ?? x));

// @jsquash fetches its WASM via fetch() (fails in Node) — precompile each codec's .wasm and init(module) once.
const codecWasm = (pkgEntry, rel) => join(dirname(require.resolve(pkgEntry)), rel);
const compile = (p) => WebAssembly.compile(readFileSync(p));
function onceInit(initFn, pkgEntry, rel) {
  let p = null;
  return () => (p ??= compile(codecWasm(pkgEntry, rel)).then((m) => initFn(m)));
}

// --- sharp native adapters ---
function sharpAdapter(key, format, applyQuality) {
  return {
    key, runtime: "native", lossless: format === "png",
    async encode(rgba, w, h, quality) {
      let pipe = sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width: w, height: h, channels: 4 } });
      pipe = applyQuality(pipe, quality);
      return toU8(await pipe.toBuffer());
    },
    async decode(bytes) {
      const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data: toU8(data), width: info.width, height: info.height };
    },
  };
}

// --- jsquash wasm adapters (lazy Node WASM init) ---
// encOpts = fixed extra encode options merged with quality (e.g. force 4:4:4 chroma for jpeg fairness).
function jsquashAdapter(key, enc, dec, ensureEnc, ensureDec, encOpts = {}, qKey = "quality") {
  return {
    key, runtime: "wasm", lossless: false,
    async encode(rgba, w, h, quality) {
      await ensureEnc();
      const img = { data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width: w, height: h };
      const buf = await enc(img, { [qKey]: quality, ...encOpts });
      return toU8(buf);
    },
    async decode(bytes) {
      await ensureDec();
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const img = await dec(ab);
      return { data: toU8(img.data), width: img.width, height: img.height };
    },
  };
}

const ensureJpegEnc = onceInit(initJpegEnc, "@jsquash/jpeg/encode.js", "codec/enc/mozjpeg_enc.wasm");
const ensureJpegDec = onceInit(initJpegDec, "@jsquash/jpeg/decode.js", "codec/dec/mozjpeg_dec.wasm");
const ensureWebpEnc = onceInit(initWebpEnc, "@jsquash/webp/encode.js", "codec/enc/webp_enc.wasm");
const ensureWebpDec = onceInit(initWebpDec, "@jsquash/webp/decode.js", "codec/dec/webp_dec.wasm");
const ensureAvifEnc = onceInit(initAvifEnc, "@jsquash/avif/encode.js", "codec/enc/avif_enc.wasm");
const ensureAvifDec = onceInit(initAvifDec, "@jsquash/avif/decode.js", "codec/dec/avif_dec.wasm");
const ensureJxlEnc = onceInit(initJxlEnc, "@jsquash/jxl/encode.js", "codec/enc/jxl_enc.wasm");
const ensureJxlDec = onceInit(initJxlDec, "@jsquash/jxl/decode.js", "codec/dec/jxl_dec.wasm");

// Chroma fairness: JPEG forced to 4:4:4 (native + mozjpeg) so its quality isn't capped by default 4:2:0.
// WebP lossy is inherently 4:2:0 in libwebp (no 4:4:4) — left as-is; smartSubsample sharpens chroma edges.
// AVIF defaults to 4:4:4 in both sharp and @jsquash.
export const ADAPTERS = [
  sharpAdapter("jpeg_native", "jpeg", (p, q) => p.jpeg({ quality: q, chromaSubsampling: "4:4:4" })),
  sharpAdapter("webp_native", "webp", (p, q) => p.webp({ quality: q, smartSubsample: true })),
  sharpAdapter("avif_native", "avif", (p, q) => p.avif({ quality: q, chromaSubsampling: "4:4:4" })),
  sharpAdapter("png_native", "png", (p) => p.png()),
  jsquashAdapter("jpeg_wasm", jpegEnc, jpegDec, ensureJpegEnc, ensureJpegDec, { auto_subsample: false, chroma_subsample: 1 }),
  jsquashAdapter("webp_wasm", webpEnc, webpDec, ensureWebpEnc, ensureWebpDec),
  jsquashAdapter("avif_wasm", avifEnc, avifDec, ensureAvifEnc, ensureAvifDec),
  jsquashAdapter("jxl_orig", jxlEnc, jxlDec, ensureJxlEnc, ensureJxlDec, { effort: 3 }),
];
