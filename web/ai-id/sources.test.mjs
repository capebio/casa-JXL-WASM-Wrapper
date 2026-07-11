import { test } from "node:test";
import assert from "node:assert/strict";
import { liveBufferSource, pyramidLevelSource, embeddedPreviewSource, rawDecodeSource } from "./sources.mjs";

test("liveBufferSource yields the given pixels, or null when absent", async () => {
  const rgba = new Uint8Array(4 * 4 * 4);
  assert.deepEqual(await liveBufferSource(rgba, 4, 4).get(), { rgba, w: 4, h: 4 });
  assert.equal(await liveBufferSource(null, 0, 0).get(), null);
});

test("pyramidLevelSource decodes level bytes to RGBA; null when no bytes", async () => {
  const decodeJxl = async (b) => ({ data: new Uint8Array(2 * 2 * 4), width: 2, height: 2 });
  const src = pyramidLevelSource(() => new Uint8Array([1, 2, 3]), decodeJxl);
  assert.deepEqual(await src.get(), { rgba: new Uint8Array(2 * 2 * 4), w: 2, h: 2 });
  assert.equal(await pyramidLevelSource(() => null, decodeJxl).get(), null);
});

test("embeddedPreviewSource returns RGBA for a CR2 with a large preview", async () => {
  const sharp = (await import("sharp")).default;
  const src = embeddedPreviewSource("c:/Foo/raw-converter/tests/ADH 1248.CR2", sharp, { minEdge: 768 });
  const r = await src.get();
  assert.equal(r.w, 6000);
  assert.equal(r.rgba.length, r.w * r.h * 4);
});

test("rawDecodeSource decodes a RAW to RGBA via injected fns", async () => {
  const decodeRawFn = async () => ({ rgb: new Uint8Array(2 * 2 * 3), width: 2, height: 2 });
  const rgbToRgba = (rgb) => new Uint8Array(2 * 2 * 4);
  const r = await rawDecodeSource("x.cr2", decodeRawFn, rgbToRgba).get();
  assert.equal(r.w, 2);
  assert.equal(r.rgba.length, 2 * 2 * 4);
});
