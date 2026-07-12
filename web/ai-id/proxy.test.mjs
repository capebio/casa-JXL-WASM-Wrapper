import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeProxyJpeg, resolveProxy } from "./proxy.mjs";

// Fakes: identity downscale that records the requested dims; stub encoder returns a tagged buffer.
function fakeDeps() {
  const calls = [];
  return {
    downscaleRgba: (rgba, sw, sh, dw, dh) => { calls.push([sw, sh, dw, dh]); return new Uint8Array(dw * dh * 4); },
    encodeJpeg: async (rgba, w, h, q) => new Uint8Array([0xff, 0xd8, w & 0xff, h & 0xff, q]),
    calls,
  };
}

test("encodeProxyJpeg downscales to 768 long-edge preserving aspect, encodes 4:2:0", async () => {
  const d = fakeDeps();
  const src = new Uint8Array(6000 * 4000 * 4);
  const out = await encodeProxyJpeg(src, 6000, 4000, { maxEdge: 768, quality: 80, downscaleRgba: d.downscaleRgba, encodeJpeg: d.encodeJpeg });
  assert.deepEqual(d.calls[0], [6000, 4000, 768, 512]); // 768/6000*4000 = 512
  assert.equal(out.w, 768);
  assert.equal(out.h, 512);
  assert.equal(out.jpeg[0], 0xff);
});

test("encodeProxyJpeg does not upscale a small source", async () => {
  const d = fakeDeps();
  const out = await encodeProxyJpeg(new Uint8Array(400 * 300 * 4), 400, 300, { maxEdge: 768, quality: 80, downscaleRgba: d.downscaleRgba, encodeJpeg: d.encodeJpeg });
  assert.equal(d.calls.length, 0); // no downscale call
  assert.equal(out.w, 400);
  assert.equal(out.h, 300);
});

test("resolveProxy returns the first non-null source and its label", async () => {
  const d = fakeDeps();
  const sources = [
    { label: "buffer", get: async () => null },
    { label: "pyramid", get: async () => ({ rgba: new Uint8Array(100 * 100 * 4), w: 100, h: 100 }) },
    { label: "raw", get: async () => { throw new Error("should not reach"); } },
  ];
  const out = await resolveProxy(sources, { maxEdge: 768, quality: 80, downscaleRgba: d.downscaleRgba, encodeJpeg: d.encodeJpeg });
  assert.equal(out.source, "pyramid");
  assert.equal(out.w, 100);
});

test("resolveProxy throws when all sources are null", async () => {
  const d = fakeDeps();
  const sources = [{ label: "a", get: async () => null }, { label: "b", get: async () => null }];
  await assert.rejects(
    () => resolveProxy(sources, { maxEdge: 768, quality: 80, downscaleRgba: d.downscaleRgba, encodeJpeg: d.encodeJpeg }),
    /no proxy source available/,
  );
});

// ── BUG 3: encodeJpeg is required (no dangling nodeEncodeJpeg fallback) ───────

test("encodeProxyJpeg throws a clear error (not ReferenceError) when encodeJpeg is missing", async () => {
  // The browser proxy path passes no encodeJpeg fallback; a missing injected
  // encoder must surface as a clear, actionable Error — never a ReferenceError
  // from a removed Node symbol.
  await assert.rejects(
    () => encodeProxyJpeg(new Uint8Array(4 * 4 * 4), 4, 4, { quality: 80 }),
    (e) => {
      assert.ok(e instanceof Error, "must be an Error");
      assert.ok(!(e instanceof ReferenceError), "must NOT be a ReferenceError (dangling nodeEncodeJpeg)");
      assert.match(e.message, /encodeJpeg is required/i);
      return true;
    },
  );
});

test("resolveProxy throws a clear error when encodeJpeg is missing but a source yields pixels", async () => {
  const sources = [{ label: "px", get: async () => ({ rgba: new Uint8Array(4 * 4 * 4), w: 4, h: 4 }) }];
  await assert.rejects(
    () => resolveProxy(sources, { quality: 80 }), // no encodeJpeg injected
    (e) => {
      assert.ok(!(e instanceof ReferenceError), "must NOT be a ReferenceError");
      assert.match(e.message, /encodeJpeg is required/i);
      return true;
    },
  );
});

test("encodeProxyJpeg works when encodeJpeg is provided (small source, no downscale)", async () => {
  const d = fakeDeps();
  const out = await encodeProxyJpeg(new Uint8Array(4 * 4 * 4), 4, 4, { quality: 80, encodeJpeg: d.encodeJpeg });
  assert.equal(out.w, 4);
  assert.equal(out.h, 4);
  assert.equal(out.jpeg[0], 0xff);
});
