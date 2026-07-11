import { test } from "node:test";
import assert from "node:assert/strict";
import { initWasm, decodeRaw } from "./decode.mjs";

test("decodeRaw returns oriented RGB + dims + metadata getters for a CR2", async () => {
  await initWasm();
  const d = await decodeRaw("c:/Foo/raw-converter/tests/ADH 1248.CR2");
  assert.equal(d.width, 6000);
  assert.equal(d.height, 4000);
  assert.equal(d.rgb.length, 6000 * 4000 * 3);
  assert.equal(typeof d.result.datetime, "string");
  assert.equal(typeof d.result.has_gps, "boolean");
});
