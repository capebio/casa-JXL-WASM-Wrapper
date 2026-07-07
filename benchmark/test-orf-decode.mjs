import { existsSync, readFileSync } from "node:fs";
import initRaw, { process_orf_with_flags } from "./pkg/raw_converter_wasm.js";

await initRaw({ module_or_path: readFileSync(new URL("./pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });

const OUTPUT_FULL_RGB = 1 | 2 | 4;
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

// Test P1110226.ORF decode
const orfPath = "C:\\Foo\\raw-converter\\tests\\P1110226.ORF";
const raw = new Uint8Array(readFileSync(orfPath));

console.log(`Testing P1110226.ORF (${raw.byteLength} bytes)`);
const decoded = process_orf_with_flags(raw, OUTPUT_FULL_RGB, ...PROCESS_ARGS);

console.log(`Width: ${decoded.width}`);
console.log(`Height: ${decoded.height}`);
console.log(`Buffer size: ${decoded.width * decoded.height * 4} bytes`);

const rgb = decoded.take_rgb();
console.log(`RGB buffer size: ${rgb.byteLength} bytes`);

// Check for null/invalid pixels (first 100 pixels)
let nullCount = 0;
let minVal = 255, maxVal = 0;
for (let i = 0; i < Math.min(100 * 3, rgb.byteLength); i++) {
  if (rgb[i] === 0) nullCount++;
  minVal = Math.min(minVal, rgb[i]);
  maxVal = Math.max(maxVal, rgb[i]);
}
console.log(`First 100 RGB values - null: ${nullCount}, min: ${minVal}, max: ${maxVal}`);

// Check for overall value distribution
const buckets = new Array(256).fill(0);
for (let i = 0; i < Math.min(10000, rgb.byteLength); i++) {
  buckets[rgb[i]]++;
}
const nonZeroBuckets = buckets.filter(c => c > 0).length;
console.log(`Value distribution in first 10k bytes: ${nonZeroBuckets} distinct values`);
console.log(`Zero values: ${buckets[0]}, 255 values: ${buckets[255]}`);

decoded.free();
console.log("\nDecoding appears valid.");
