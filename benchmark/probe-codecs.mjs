// Codec API probe (throwaway). Confirms @jsquash encode/decode signatures + Node WASM init.
// CONFIRMED (Node): @jsquash codecs fetch WASM via fetch() which fails in Node → must precompile
// each codec's enc/dec .wasm from disk and pass the WebAssembly.Module to init(module).
// Quality option key = { quality: 0-100 } for jpeg/webp/avif (jsquash defaults).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import jpegEnc, { init as initJpegEnc } from "@jsquash/jpeg/encode.js";
import jpegDec, { init as initJpegDec } from "@jsquash/jpeg/decode.js";
import webpEnc, { init as initWebpEnc } from "@jsquash/webp/encode.js";
import webpDec, { init as initWebpDec } from "@jsquash/webp/decode.js";
import avifEnc, { init as initAvifEnc } from "@jsquash/avif/encode.js";
import avifDec, { init as initAvifDec } from "@jsquash/avif/decode.js";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const codecWasm = (pkgEntry, rel) => join(dirname(require.resolve(pkgEntry)), rel);
const compile = async (p) => WebAssembly.compile(readFileSync(p));

await initJpegEnc(await compile(codecWasm("@jsquash/jpeg/encode.js", "codec/enc/mozjpeg_enc.wasm")));
await initJpegDec(await compile(codecWasm("@jsquash/jpeg/decode.js", "codec/dec/mozjpeg_dec.wasm")));
await initWebpEnc(await compile(codecWasm("@jsquash/webp/encode.js", "codec/enc/webp_enc.wasm")));
await initWebpDec(await compile(codecWasm("@jsquash/webp/decode.js", "codec/dec/webp_dec.wasm")));
await initAvifEnc(await compile(codecWasm("@jsquash/avif/encode.js", "codec/enc/avif_enc.wasm")));
await initAvifDec(await compile(codecWasm("@jsquash/avif/decode.js", "codec/dec/avif_dec.wasm")));

const w = 64, h = 64;
const data = new Uint8ClampedArray(w * h * 4);
for (let i = 0; i < data.length; i += 4) { data[i] = 100; data[i+1] = 150; data[i+2] = 200; data[i+3] = 255; }
const img = { data, width: w, height: h };

for (const [name, enc, dec] of [
  ["jpeg_wasm", jpegEnc, jpegDec],
  ["webp_wasm", webpEnc, webpDec],
  ["avif_wasm", avifEnc, avifDec],
]) {
  const buf = await enc(img, { quality: 50 });
  const back = await dec(buf);
  console.log(name, "enc bytes", buf.byteLength, "dec", back.width + "x" + back.height, "ch", back.data.length / (back.width * back.height));
}
const sBuf = await sharp(Buffer.from(data), { raw: { width: w, height: h, channels: 4 } }).jpeg({ quality: 50 }).toBuffer();
const sBack = await sharp(sBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
console.log("sharp jpeg", sBuf.length, "dec", sBack.info.width + "x" + sBack.info.height, "ch", sBack.info.channels);
