import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initCodecCompareJxl, makeJxlAdapter16 } from "../codec-compare-jxl.mjs";

// synthetic 16x16 RGBA16 gradient
function grad(w, h) {
  const out = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    out[i] = (x * 65535 / (w - 1)) | 0; out[i+1] = (y * 65535 / (h - 1)) | 0;
    out[i+2] = ((x + y) * 65535 / (w + h - 2)) | 0; out[i+3] = 0xFFFF;
  }
  return out;
}

before(async () => { await initCodecCompareJxl(); });

test("jxl16 adapter round-trips RGBA16 near-lossless", async () => {
  const w = 16, h = 16, src = grad(w, h);
  const a = makeJxlAdapter16();
  const bytes = await a.encode(src, w, h, 98);
  assert.ok(bytes.length > 0);
  const dec = await a.decode(bytes);
  assert.equal(dec.width, w); assert.equal(dec.height, h);
  assert.ok(dec.data instanceof Uint16Array, "decoded data must be Uint16Array");
  assert.equal(dec.data.length, w * h * 4);
  let e = 0; for (let i = 0; i < src.length; i++) e += Math.abs(src[i] - dec.data[i]);
  const mae = e / src.length;
  assert.ok(mae < 2000, `jxl16 mae=${mae}`);
});
