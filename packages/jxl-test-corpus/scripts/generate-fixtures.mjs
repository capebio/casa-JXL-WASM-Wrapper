#!/usr/bin/env node
import { mkdir, writeFile, cp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { createEncoder, setForcedTier } from "../../jxl-wasm/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const srcFixturesDir = join(packageRoot, "fixtures");
const distFixturesDir = join(packageRoot, "dist", "fixtures");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function encodeJxl(rgbaBytes, options) {
  const encoder = createEncoder(options);
  const chunks = [];
  const chunkPromise = (async () => {
    for await (const chunk of encoder.chunks()) {
      chunks.push(chunk);
    }
  })();
  
  await encoder.pushPixels(rgbaBytes);
  await encoder.finish();
  await chunkPromise;
  await encoder.dispose();

  let totalLen = 0;
  for (const c of chunks) totalLen += c.byteLength;
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    const arr = new Uint8Array(c.buffer || c, c.byteOffset, c.byteLength);
    out.set(arr, offset);
    offset += arr.byteLength;
  }
  return out;
}

// Render deterministic sRGB 8-bit RGBA gradient
function renderSrgb8(width, height) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      rgba[idx] = Math.round((x / (width - 1)) * 255); // R
      rgba[idx + 1] = Math.round((y / (height - 1)) * 255); // G
      rgba[idx + 2] = 128; // B
      rgba[idx + 3] = 255; // A
    }
  }
  return rgba;
}

// Render deterministic sRGB 8-bit RGBA alpha gradient
function renderSrgbAlpha8(width, height) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      rgba[idx] = Math.round((x / (width - 1)) * 255); // R
      rgba[idx + 1] = 128; // G
      rgba[idx + 2] = Math.round((y / (height - 1)) * 255); // B
      rgba[idx + 3] = Math.round((x / (width - 1)) * 255); // A
    }
  }
  return rgba;
}

// Render deterministic Adobe RGB 16-bit RGBA (wide-gamut) ramp
function renderAdobeRgb16(width, height) {
  const rgba = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      rgba[idx] = Math.round((x / (width - 1)) * 65535); // R
      rgba[idx + 1] = Math.round((y / (height - 1)) * 65535); // G
      rgba[idx + 2] = 32768; // B
      rgba[idx + 3] = 65535; // A
    }
  }
  return new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
}

// Render deterministic gray ramp (16-bit)
function renderGrayRamp16(width, height) {
  const rgba = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const val = Math.round((x / (width - 1)) * 65535);
      rgba[idx] = val; // R
      rgba[idx + 1] = val; // G
      rgba[idx + 2] = val; // B
      rgba[idx + 3] = 65535; // A
    }
  }
  return new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
}

// Render deterministic saturated green (16-bit)
function renderSaturatedGreen16(width, height) {
  const rgba = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      rgba[idx] = 0; // R
      rgba[idx + 1] = Math.round((x / (width - 1)) * 65535); // G
      rgba[idx + 2] = 0; // B
      rgba[idx + 3] = 65535; // A
    }
  }
  return new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
}

// Render deterministic lossless 16-bit
function renderLossless16(width, height) {
  const rgba = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      rgba[idx] = Math.round((x / (width - 1)) * 65535);
      rgba[idx + 1] = Math.round((y / (height - 1)) * 65535);
      rgba[idx + 2] = Math.round(((x + y) / (width + height - 2)) * 65535);
      rgba[idx + 3] = 65535;
    }
  }
  return new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
}

// Render deterministic multiview A and B
function renderMultiview(width, height, offset) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const dist = Math.hypot(x - (50 + offset), y - 50);
      const isInsideCircle = dist < 20;
      rgba[idx] = isInsideCircle ? 255 : 0;
      rgba[idx + 1] = 128;
      rgba[idx + 2] = 128;
      rgba[idx + 3] = 255;
    }
  }
  return rgba;
}

async function main() {
  // Force single-threaded SIMD WASM tier under Node to avoid ReferenceError: Worker is not defined
  setForcedTier("simd");

  await rm(srcFixturesDir, { recursive: true, force: true });
  await rm(distFixturesDir, { recursive: true, force: true });
  await mkdir(srcFixturesDir, { recursive: true });
  await mkdir(distFixturesDir, { recursive: true });

  const width = 100;
  const height = 100;

  const fixtures = [];

  // Helper to save a fixture
  async function saveFixture(filename, bytes) {
    const srcPath = join(srcFixturesDir, filename);
    const distPath = join(distFixturesDir, filename);
    await writeFile(srcPath, bytes);
    await writeFile(distPath, bytes);
    const hash = sha256(bytes);
    fixtures.push({ filename, hash, size: bytes.byteLength });
    console.log(`[generate-fixtures] Generated ${filename} (${bytes.byteLength} bytes, sha256: ${hash})`);
  }

  // 1. srgb-8bit
  const srgb8Bytes = renderSrgb8(width, height);
  const srgb8Jxl = await encodeJxl(srgb8Bytes, {
    format: "rgba8",
    width,
    height,
    hasAlpha: false,
    iccProfile: null,
    exif: null,
    xmp: null,
    distance: null,
    quality: 90,
    effort: 5,
    progressive: false,
    previewFirst: false,
    chunked: false,
  });
  await saveFixture("srgb-8bit.jxl", srgb8Jxl);

  // 2. srgb-alpha-8bit
  const alpha8Bytes = renderSrgbAlpha8(width, height);
  const alpha8Jxl = await encodeJxl(alpha8Bytes, {
    format: "rgba8",
    width,
    height,
    hasAlpha: true,
    iccProfile: null,
    exif: null,
    xmp: null,
    distance: null,
    quality: 90,
    effort: 5,
    progressive: false,
    previewFirst: false,
    chunked: false,
  });
  await saveFixture("srgb-alpha-8bit.jxl", alpha8Jxl);

  // 3. adobe-rgb-16bit (Adobe RGB, hasIcc, hasExif, hasXmp)
  const adobe16Bytes = renderAdobeRgb16(width, height);
  // ICC/EXIF/XMP metadata boxes. Current libjxl (skcms) validates the ICC profile and rejects a
  // malformed one with encode error 51, so this must be a COMPLETE, valid profile — a stub header
  // is not enough. Bytes below are a standard sRGB ICC profile ('acsp' signature + wtpt/rXYZ/rTRC/…
  // tags) emitted by lcms, which JxlEncoderSetICCProfile accepts.
  const mockIcc = Uint8Array.from(Buffer.from(
    "AAAB4GxjbXMEIAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQAAAAAc2F3c2N0cmwAAAAA" +
    "AAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5keem/Vlo+AbaDI4VVRvdPqgAAAAAAAAAAAAAAAAAAAAAAAAAA" +
    "AAAAAAAAAAAAAAAKZGVzYwAAAPwAAAAkY3BydAAAASAAAAAid3RwdAAAAUQAAAAUY2hhZAAAAVgAAAAs" +
    "clhZWgAAAYQAAAAUZ1hZWgAAAZgAAAAUYlhZWgAAAawAAAAUclRSQwAAAcAAAAAgZ1RSQwAAAcAAAAAg" +
    "YlRSQwAAAcAAAAAgbWx1YwAAAAAAAAABAAAADGVuVVMAAAAIAAAAHABzAFIARwBCbWx1YwAAAAAAAAAB" +
    "AAAADGVuVVMAAAAGAAAAHABDAEMAMAAAWFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDD8AAAXd" +
    "///zJgAAB5AAAP2S///7of///aIAAAPcAADAcVhZWiAAAAAAAABvoAAAOPIAAAOPWFlaIAAAAAAAAGKW" +
    "AAC3iQAAGNpYWVogAAAAAAAAJKAAAA+FAAC2xHBhcmEAAAAAAAMAAAACZmkAAPKnAAANWQAAE9AAAApb",
    "base64",
  ));
  const mockExif = new Uint8Array([69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0, 0, 0]);
  const mockXmp = new Uint8Array(Buffer.from("<x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'></rdf:RDF></x:xmpmeta>", "utf-8"));

  const adobe16Jxl = await encodeJxl(adobe16Bytes, {
    format: "rgba16",
    width,
    height,
    hasAlpha: false,
    iccProfile: mockIcc.buffer,
    exif: mockExif.buffer,
    xmp: mockXmp.buffer,
    distance: null,
    quality: 90,
    effort: 5,
    progressive: false,
    previewFirst: false,
    chunked: false,
  });
  await saveFixture("adobe-rgb-16bit.jxl", adobe16Jxl);

  // 4. truncated-header (truncate srgb-8bit to 32 bytes)
  const truncatedHeaderJxl = srgb8Jxl.slice(0, 32);
  await saveFixture("truncated-header.jxl", truncatedHeaderJxl);

  // 5. gray-ramp-16bit
  const grayRamp16Bytes = renderGrayRamp16(width, height);
  const grayRamp16Jxl = await encodeJxl(grayRamp16Bytes, {
    format: "rgba16",
    width,
    height,
    hasAlpha: false,
    iccProfile: null,
    exif: null,
    xmp: null,
    distance: null,
    quality: 90,
    effort: 5,
    progressive: false,
    previewFirst: false,
    chunked: false,
  });
  await saveFixture("gray-ramp-16bit.jxl", grayRamp16Jxl);

  // 6. saturated-green-16bit
  const green16Bytes = renderSaturatedGreen16(width, height);
  const green16Jxl = await encodeJxl(green16Bytes, {
    format: "rgba16",
    width,
    height,
    hasAlpha: false,
    iccProfile: null,
    exif: null,
    xmp: null,
    distance: null,
    quality: 90,
    effort: 5,
    progressive: false,
    previewFirst: false,
    chunked: false,
  });
  await saveFixture("saturated-green-16bit.jxl", green16Jxl);

  // 7. progressive-dc-truncated JXL
  const progressiveJxl = await encodeJxl(srgb8Bytes, {
    format: "rgba8",
    width,
    height,
    hasAlpha: false,
    iccProfile: null,
    exif: null,
    xmp: null,
    distance: null,
    quality: 85,
    effort: 5,
    progressive: true,
    progressiveDc: 1,
    previewFirst: false,
    chunked: false,
  });
  // Truncate progressive JXL to 35% of its total size or 400 bytes, whichever is smaller.
  const truncSize = Math.min(400, Math.floor(progressiveJxl.byteLength * 0.35));
  const progressiveDcTruncatedJxl = progressiveJxl.slice(0, truncSize);
  await saveFixture("progressive-dc-truncated.jxl", progressiveDcTruncatedJxl);

  // 8. lossless-16bit
  const lossless16Bytes = renderLossless16(width, height);
  const lossless16Jxl = await encodeJxl(lossless16Bytes, {
    format: "rgba16",
    width,
    height,
    hasAlpha: false,
    iccProfile: null,
    exif: null,
    xmp: null,
    distance: 0, // distance 0 specifies lossless (VarDCT cannot do lossless directly, but distance 0 auto-selects modular lossless)
    quality: null,
    effort: 5,
    progressive: false,
    previewFirst: false,
    chunked: false,
    modular: 1, // Modular mode 1 with distance 0 guarantees lossless
  });
  await saveFixture("lossless-16bit.jxl", lossless16Jxl);

  // 9. multiview-a
  const multiviewABytes = renderMultiview(width, height, -5);
  const multiviewAJxl = await encodeJxl(multiviewABytes, {
    format: "rgba8",
    width,
    height,
    hasAlpha: false,
    iccProfile: null,
    exif: null,
    xmp: null,
    distance: null,
    quality: 90,
    effort: 5,
    progressive: false,
    previewFirst: false,
    chunked: false,
  });
  await saveFixture("multiview-a.jxl", multiviewAJxl);

  // 10. multiview-b
  const multiviewBBytes = renderMultiview(width, height, 5);
  const multiviewBJxl = await encodeJxl(multiviewBBytes, {
    format: "rgba8",
    width,
    height,
    hasAlpha: false,
    iccProfile: null,
    exif: null,
    xmp: null,
    distance: null,
    quality: 90,
    effort: 5,
    progressive: false,
    previewFirst: false,
    chunked: false,
  });
  await saveFixture("multiview-b.jxl", multiviewBJxl);

  console.log("\nCopy-paste these SHA-256 hashes into src/manifest.ts:\n");
  for (const f of fixtures) {
    console.log(`  id: "${f.filename.replace(".jxl", "")}", sha256: "${f.hash}"`);
  }
}

main().catch(err => {
  console.error("Failed to generate fixtures:", err);
  process.exit(1);
});
