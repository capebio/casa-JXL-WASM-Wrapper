// proxy-e2e.test.mjs — end-to-end test using the Node source chain.
// embeddedPreviewSource and nodeEncodeJpeg are now in node-adapter.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { initWasm, getRaw, decodeRaw } from "./decode.mjs";
import { rawDecodeSource } from "./sources.mjs";
import { embeddedPreviewSource, nodeEncodeJpeg } from "./node-adapter.mjs";
import { resolveProxy } from "./proxy.mjs";

test("CR2 → 768px q80 4:2:0 JPEG via the real Node source chain", async () => {
  await initWasm();
  const raw = getRaw();
  const path = "c:/Foo/raw-converter/tests/ADH 1248.CR2";
  const sources = [
    embeddedPreviewSource(path),
    rawDecodeSource(path, decodeRaw, raw.rgb_to_rgba),
  ];
  const out = await resolveProxy(sources, {
    maxEdge: 768, quality: 80,
    downscaleRgba: (rgba, sw, sh, dw, dh) => new Uint8Array(raw.downscale_rgba(rgba, sw, sh, dw, dh)),
    encodeJpeg: nodeEncodeJpeg,
  });
  assert.equal(out.source, "embedded-preview");     // preview wins for CR2
  assert.equal(Math.max(out.w, out.h), 768);
  // Verify it's a real, decodable JPEG at 4:2:0.
  const meta = await sharp(Buffer.from(out.jpeg)).metadata();
  assert.equal(meta.format, "jpeg");
  assert.equal(meta.chromaSubsampling, "4:2:0");
  assert.equal(Math.max(meta.width, meta.height), 768);
});
