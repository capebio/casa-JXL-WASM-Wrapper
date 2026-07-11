import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPreview } from "./embedded-preview.mjs";

const CR2 = "c:/Foo/raw-converter/tests/ADH 1248.CR2";

test("extractPreview picks the largest viewable JPEG from a CR2, skipping lossless raw", () => {
  const { buffer, w, h, sof } = extractPreview(CR2);
  assert.ok(buffer.length > 0);
  assert.equal(w, 6000);          // full baseline preview, not the 160x120 thumb
  assert.equal(h, 4000);
  assert.equal([0xc0, 0xc1, 0xc2].includes(sof), true); // viewable, not C3 lossless
});
