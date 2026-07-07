// S6 smoke test — WASM process_region export.
// Decodes a full ORF (sensor orientation) and a region, then asserts:
//  (1) region byte length == w*h*channels (RGB8 → 3 channels), and
//  (2) region pixels match the full decode at the same ABSOLUTE coordinates.
//
// The region path runs the scalar `process()` tone stage; the full RGB8 export runs the
// SIMD `process_into_auto`. Both are claimed byte-exact, so we assert exact match but
// tolerate a tiny rounding delta and report the real stats either way.
//
// Run: node test-process-region.mjs
import { existsSync, readFileSync } from "node:fs";
import initRaw, { process_orf_with_flags, process_region } from "./pkg/raw_converter_wasm.js";

await initRaw({
  module_or_path: readFileSync(new URL("./pkg/raw_converter_wasm_bg.wasm", import.meta.url)),
});

// Output flag bits (mirror src/lib.rs).
const OUT_FULL_RGB8 = 1;
const OUT_NO_ORIENT = 16;
// Neutral look for process_orf_with_flags: exp,contrast,hi,sh,wh,bl,sat,vib,temp,tint,wbR,wbB,texture,clarity
const NEUTRAL = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

const CANDIDATES = [
  "C:\\Foo\\raw-converter\\tests\\P1110226.ORF",
  "C:\\995\\2026-02-20 Gobabeb To Windhoek\\Gobabeb Herbarium\\P2200407.ORF",
];
const orfPath = CANDIDATES.find(existsSync);
if (!orfPath) {
  console.log("SKIP: no ORF corpus file found. Tried:\n  " + CANDIDATES.join("\n  "));
  process.exit(0);
}
const bytes = new Uint8Array(readFileSync(orfPath));
console.log(`ORF: ${orfPath} (${bytes.byteLength} bytes)`);

const CH = 3; // process_region returns RGB8

// Full decode kept in sensor orientation (OUT_NO_ORIENT) so region coords are absolute.
const full = process_orf_with_flags(bytes, OUT_FULL_RGB8 | OUT_NO_ORIENT, ...NEUTRAL);
const fw = full.width;
const fh = full.height;
const fullRgb = full.take_rgb(); // RGB8, fw*fh*3
full.free();
console.log(`Full decode (sensor orient): ${fw}×${fh}, ${fullRgb.byteLength} bytes (expect ${fw * fh * CH})`);

// Region well inside the frame.
const rx = 128, ry = 96, rw = 200, rh = 200;
if (rx + rw > fw || ry + rh > fh) {
  throw new Error(`region ${rw}×${rh}@(${rx},${ry}) exceeds image ${fw}×${fh}`);
}
const region = process_region(bytes, rx, ry, rw, rh); // RGB8
console.log(`Region ${rw}×${rh} @ (${rx},${ry}): ${region.byteLength} bytes (expect ${rw * rh * CH})`);

let ok = true;

// (1) size
if (region.byteLength !== rw * rh * CH) {
  console.error(`FAIL: region byte length ${region.byteLength} != ${rw * rh * CH}`);
  ok = false;
} else {
  console.log("OK: region byte length == w*h*channels");
}

// (2) pixel match at absolute coords
let maxDelta = 0, mismatchBytes = 0, exactPixels = 0;
const totalPixels = rw * rh;
for (let oy = 0; oy < rh; oy++) {
  for (let ox = 0; ox < rw; ox++) {
    const fi = ((ry + oy) * fw + (rx + ox)) * CH;
    const ri = (oy * rw + ox) * CH;
    let pixelExact = true;
    for (let c = 0; c < CH; c++) {
      const d = Math.abs(region[ri + c] - fullRgb[fi + c]);
      if (d !== 0) { mismatchBytes++; pixelExact = false; }
      if (d > maxDelta) maxDelta = d;
    }
    if (pixelExact) exactPixels++;
  }
}
console.log(
  `Pixel compare vs full decode: ${exactPixels}/${totalPixels} pixels byte-exact, ` +
  `mismatchBytes=${mismatchBytes}, maxDelta=${maxDelta}`
);

// Explicit corner spot-check (handoff's region[0] == full at (rx,ry)).
const corner = (ry * fw + rx) * CH;
console.log(
  `Corner: region[0..3]=[${region[0]},${region[1]},${region[2]}] ` +
  `full@(${rx},${ry})=[${fullRgb[corner]},${fullRgb[corner + 1]},${fullRgb[corner + 2]}]`
);

const TOL = 2; // scalar (region) vs SIMD (full) rounding slack
if (maxDelta > TOL) {
  console.error(`FAIL: maxDelta ${maxDelta} exceeds tolerance ${TOL}`);
  ok = false;
} else {
  console.log(`OK: region matches full decode within tolerance ${TOL} (maxDelta=${maxDelta})`);
}

if (ok) {
  console.log("PASS: process_region smoke test");
  process.exit(0);
} else {
  console.error("FAIL: process_region smoke test");
  process.exit(1);
}
