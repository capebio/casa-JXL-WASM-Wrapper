// Process the test ORF through wasm at all-zero look controls and write a
// PNG so we can eyeball the baseline against the camera's embedded JPEG.

import init, { process_orf, downscale_rgb } from "./pkg/raw_converter_wasm.js";
import { readFileSync } from "node:fs";
import sharp from "sharp";

const ORF = process.argv[2] ?? String.raw`c:\Foo\raw-converter\tests\P1110226.ORF`;
const OUT = process.argv[3] ?? String.raw`c:\foo\raw-converter-wasm\baseline-out.png`;

const wasmBytes = readFileSync(
    new URL("./pkg/raw_converter_wasm_bg.wasm", import.meta.url),
);
await init({ module_or_path: wasmBytes });

const data = readFileSync(ORF);
const t0 = performance.now();
// All zero controls — baseline only.
const r = process_orf(
    new Uint8Array(data),
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0,
);
const took = performance.now() - t0;

console.log(`process_orf: ${took.toFixed(0)} ms`);
console.log(`  decompress ${r.decompress_ms.toFixed(0)} ms`);
console.log(`  demosaic   ${r.demosaic_ms.toFixed(0)} ms`);
console.log(`  tonemap    ${r.tonemap_ms.toFixed(0)} ms`);
console.log(`  orient     ${r.orient_ms.toFixed(0)} ms`);
console.log(`dims: ${r.width} × ${r.height}, orientation ${r.orientation}`);
console.log(`make/model: ${r.make} / ${r.model}`);
console.log(`WB used: R=${r.wb_r_used.toFixed(3)}  B=${r.wb_b_used.toFixed(3)}`);

const rgb = r.take_rgb();
console.log(`rgb buffer: ${(rgb.length / 1024 / 1024).toFixed(1)} MB`);

const h1200 = Math.round((r.height * 1200) / r.width);
const rgbSmall = downscale_rgb(rgb, r.width, r.height, 1200, h1200);

await sharp(rgbSmall, { raw: { width: 1200, height: h1200, channels: 3 } })
    .png({ compressionLevel: 6 })
    .toFile(OUT);

console.log(`wrote ${OUT}`);
