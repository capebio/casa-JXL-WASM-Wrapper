import { test } from "node:test";
import assert from "node:assert/strict";
import { bdRate } from "../bd-rate.mjs";

// curve = array of {bpp, butteraugli}. Distortion = butteraugli.
const ref = [{ bpp: 1, butteraugli: 4 }, { bpp: 2, butteraugli: 3 }, { bpp: 4, butteraugli: 2 }, { bpp: 8, butteraugli: 1 }];

test("identical curves -> ~0%", () => {
  assert.ok(Math.abs(bdRate(ref, ref)) < 1e-6);
});

test("test curve at half the rate everywhere -> ~ -50%", () => {
  const half = ref.map(p => ({ bpp: p.bpp / 2, butteraugli: p.butteraugli }));
  const bd = bdRate(ref, half); // half uses 50% of ref bytes at equal quality
  assert.ok(bd < -49 && bd > -51, `bd=${bd}`);
});

test("returns null when distortion ranges do not overlap", () => {
  const disjoint = [{ bpp: 1, butteraugli: 10 }, { bpp: 2, butteraugli: 8 }];
  assert.equal(bdRate(ref, disjoint), null);
});
