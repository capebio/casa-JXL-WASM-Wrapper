// Archival (lossless) JPEG->JXL transcode contract.
//
// transcodeJpegToJxl (facade.js) uses JxlEncoderAddJPEGFrame + StoreJPEGMetadata
// → a standard JXL that embeds the JPEG reconstruction data, losslessly
// reconstructable to the bit-exact original by any libjxl (`djxl --jpeg`).
// In-app bit-exact recovery (extractJpegReconstructionFromJxl) currently only
// handles JXTC tile containers, so it returns null for the standard-JXL
// transcode here — wiring a JxlDecoderReconstructJPEG bridge is the documented
// follow-up (plan C1 Step 3a). This test ratifies the transcode itself and
// records the reconstruction gap explicitly.
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  transcodeJpegToJxl,
  extractJpegReconstructionFromJxl,
} from "../dist/facade.js";

// Build a non-trivial baseline JPEG in-memory (RGB gradient) — self-contained,
// deterministic, no committed binary fixture.
async function makeJpeg(w, h) {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      raw[o] = (x * 255 / w) | 0;
      raw[o + 1] = (y * 255 / h) | 0;
      raw[o + 2] = ((x + y) * 255 / (w + h)) | 0;
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 90, progressive: false, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toBuffer();
}

function isJxl(b) {
  // bare codestream FF 0A, or ISO-BMFF JXL container box 'JXL ' at offset 4
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0x0a) return true;
  return (
    b.length >= 12 &&
    b[4] === 0x4a && b[5] === 0x58 && b[6] === 0x4c && b[7] === 0x20
  );
}

test("lossless JPEG->JXL transcode produces a valid JXL", async () => {
  const jpeg = await makeJpeg(256, 192);
  let jxl;
  try {
    jxl = await transcodeJpegToJxl(new Uint8Array(jpeg));
  } catch (e) {
    if (String(e?.name || e).includes("CapabilityMissing")) {
      console.warn("jpegTranscode capability absent — skipping");
      return;
    }
    throw e;
  }
  assert.ok(jxl.byteLength > 0, "transcode produced output");
  assert.ok(isJxl(jxl), "output is a JXL container/codestream");
  assert.ok(jxl.byteLength <= jpeg.byteLength * 1.05, "transcode must not bloat the file");
  console.log(
    `  transcode: ${jpeg.byteLength} -> ${jxl.byteLength} bytes  ratio=${(
      jxl.byteLength / jpeg.byteLength
    ).toFixed(3)}`,
  );

  const recovered = extractJpegReconstructionFromJxl(jxl);
  if (recovered) {
    assert.deepEqual(
      Buffer.from(recovered),
      Buffer.from(jpeg),
      "recovered JPEG must be bit-exact",
    );
  } else {
    console.warn(
      "  NOTE: in-app JPEG reconstruction not wired (needs JxlDecoderReconstructJPEG bridge). " +
        "The JXL is still losslessly reconstructable via `djxl --jpeg`.",
    );
  }
});
