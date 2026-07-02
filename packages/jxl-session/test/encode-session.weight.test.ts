import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeEncodeWeight } from "../src/encode-session.js";

describe("computeEncodeWeight", () => {
  it("computes width*height*bpp per format", () => {
    assert.equal(computeEncodeWeight({ width: 100, height: 100, format: "rgba8" }), 100 * 100 * 4);
    assert.equal(computeEncodeWeight({ width: 100, height: 100, format: "rgb8" }), 100 * 100 * 3);
    assert.equal(computeEncodeWeight({ width: 100, height: 100, format: "rgba16" }), 100 * 100 * 8);
  });
  it("returns undefined for hostile/overflowing dims (gate applies its default)", () => {
    assert.equal(computeEncodeWeight({ width: 2 ** 30, height: 2 ** 30, format: "rgba16" }), undefined);
  });
});
