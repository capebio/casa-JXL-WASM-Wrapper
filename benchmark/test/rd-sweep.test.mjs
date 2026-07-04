import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepQualityLadder, DEFAULT_LADDER } from "../rd-sweep.mjs";

// fake codec: encode returns q*10 bytes; decode echoes the byte length so metrics can vary by q.
const fake = {
  key: "fake", runtime: "wasm",
  async encode(rgba, w, h, q) { return new Uint8Array(q * 10); },
  async decode(bytes) { return { data: new Uint8Array([bytes.length & 0xff]), width: 2, height: 2, _n: bytes.length }; },
};
// metrics injected: butteraugli falls as bytes rise; ssim fixed.
const metrics = async (decoded) => ({ butteraugli: 1000 / decoded._n, ssim: 0.99 });

test("returns one point per ladder quality with bytes/bpp/butter/ssim from injected metrics", async () => {
  const pts = await sweepQualityLadder(fake, { rgba: new Uint8Array(), width: 2, height: 2, npx: 100, metrics, ladder: [25, 50, 100] });
  assert.equal(pts.length, 3);
  assert.deepEqual(pts.map(p => p.quality), [25, 50, 100]);
  assert.equal(pts[1].bytes, 500);            // q=50 -> 500 bytes
  assert.equal(pts[1].bpp, (500 * 8) / 100);  // bpp = bytes*8/npx
  assert.equal(pts[2].butteraugli, 1000 / 1000); // q=100 -> 1000 bytes -> butter 1.0
  assert.ok(pts.every(p => p.ssim === 0.99 && p.codec === "fake" && p.runtime === "wasm"));
});

test("DEFAULT_LADDER is 8 ascending points in 1..100", () => {
  assert.equal(DEFAULT_LADDER.length, 8);
  assert.deepEqual([...DEFAULT_LADDER].sort((a,b)=>a-b), DEFAULT_LADDER);
  assert.ok(DEFAULT_LADDER[0] >= 1 && DEFAULT_LADDER.at(-1) <= 100);
});
