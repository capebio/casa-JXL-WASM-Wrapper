import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeDecodeWeight } from "../src/decode-session.js";

describe("computeDecodeWeight", () => {
  it("uses expectedOutputBytes when provided", () => {
    assert.equal(computeDecodeWeight({ expectedOutputBytes: 5_000_000 }), 5_000_000);
  });
  it("derives width*height*4 from target dims when no explicit bytes", () => {
    assert.equal(computeDecodeWeight({ targetWidth: 256, targetHeight: 256 }), 256 * 256 * 4);
  });
  it("returns undefined when neither is known (gate applies its default)", () => {
    assert.equal(computeDecodeWeight({}), undefined);
  });
  it("ignores non-finite / non-positive values", () => {
    assert.equal(computeDecodeWeight({ expectedOutputBytes: -1, targetWidth: 10, targetHeight: 10 }), 10 * 10 * 4);
    assert.equal(computeDecodeWeight({ expectedOutputBytes: Number.NaN }), undefined);
  });
});
