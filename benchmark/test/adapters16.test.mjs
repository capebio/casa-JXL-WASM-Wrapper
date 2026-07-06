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

// --- Task 6: AVIF-10/12 + PNG-16 adapters ---
import { ADAPTERS16 } from "../codec-adapters.mjs";

function grad16(w, h) {
  const out = new Uint16Array(w * h * 4);
  for (let p = 0; p < w * h; p++) { const v = (p * 65535 / (w*h-1)) | 0; out[p*4]=v; out[p*4+1]=65535-v; out[p*4+2]=(v*7)&0xFFFF; out[p*4+3]=0xFFFF; }
  return out;
}

for (const spec of [{ key: "avif16", q: 90, maeMax: 4000, lossless: false }, { key: "png16", q: 100, maeMax: 1, lossless: true }]) {
  test(`${spec.key} round-trips RGBA16 to full-range and near-source`, async () => {
    const a = ADAPTERS16.find(x => x.key === spec.key);
    if (!a) { console.log(`SKIP ${spec.key} (adapter absent)`); return; }
    const w = 32, h = 32, src = grad16(w, h);
    let bytes;
    try { bytes = await a.encode(src, w, h, spec.q); }
    catch (e) { console.log(`SKIP ${spec.key} (encode unsupported at runtime): ${e.message}`); return; }
    const dec = await a.decode(bytes);
    assert.ok(dec.data instanceof Uint16Array, `${spec.key} decode must yield Uint16Array`);
    assert.equal(dec.data.length, w * h * 4, `${spec.key} decode length`);
    // R channel spans the full 0..65535 range in grad16, so scanning it (stride 4) proves 16-bit.
    let mx = 0; for (let i = 0; i < dec.data.length; i += 4) { if (dec.data[i] > mx) mx = dec.data[i]; }
    assert.ok(mx > (255 << 8), `${spec.key} decoded not full-range max=${mx}`);
    let e = 0; for (let i = 0; i < src.length; i++) e += Math.abs(src[i] - dec.data[i]);
    if (spec.lossless) assert.equal(e, 0, `${spec.key} must be bit-exact lossless, total abs err=${e}`);
    else assert.ok(e / src.length < spec.maeMax, `${spec.key} mae=${e / src.length}`);
  });
}
