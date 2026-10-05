import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { initWasm, decodeRaw } from "./decode.mjs";
import { ensureJxlTileDecoder } from "../dng-jxl-libjxl.js";

test("decodeRaw returns oriented RGB + dims + metadata getters for a CR2", async () => {
  await initWasm();
  const d = await decodeRaw("c:/Foo/raw-converter/tests/ADH 1248.CR2");
  assert.equal(d.width, 6000);
  assert.equal(d.height, 4000);
  assert.equal(d.rgb.length, 6000 * 4000 * 3);
  assert.equal(typeof d.result.datetime, "string");
  assert.equal(typeof d.result.has_gps, "boolean");
});

// Needs no rebuilt pkg: a stand-in module checks that the shared helper loads
// the real libjxl once per module, and never for a non-JXL file.
test("ensureJxlTileDecoder installs libjxl once, only for JPEG XL DNGs", async () => {
  const wasmBinary = readFileSync(new URL("../../packages/jxl-wasm/dist/jxl-core.dec.simd.wasm", import.meta.url));
  let isJxl = false, loads = 0;
  const installed = [];
  const mod = { dng_uses_jxl: () => isJxl, set_jxl_tile_decoder: (f) => installed.push(f) };
  const opts = () => (loads++, { wasmBinary });
  await ensureJxlTileDecoder(mod, new Uint8Array(4), opts);
  assert.equal(loads, 0);
  isJxl = true;
  await Promise.all([ensureJxlTileDecoder(mod, new Uint8Array(4), opts), ensureJxlTileDecoder(mod, new Uint8Array(4), opts)]);
  await ensureJxlTileDecoder(mod, new Uint8Array(4), opts);
  assert.equal(loads, 1);
  assert.equal(installed.length, 1);
  assert.equal(typeof installed[0], "function");
  // An older pkg without the binding: no load, no throw.
  await ensureJxlTileDecoder({}, new Uint8Array(4), opts);
  assert.equal(loads, 1);
});

// JPEG XL ProRAW (iOS 17+): lossless iPhone 17 Pro, lossy IMG_2025.
const JXL_PRORAW = ["iphone17pro_IMG_0104.DNG", "iphone_proraw_jxl_IMG_2025.DNG"]
  .map((n) => `c:/Foo/raw-converter/tests/raw-pixls/${n}`);
for (const f of JXL_PRORAW) {
  test(`decodeRaw renders JPEG XL ProRAW ${f.split("/").pop()}`, { skip: !existsSync(f) && "fixture missing" }, async (t) => {
    const raw = await initWasm();
    if (typeof raw.dng_uses_jxl !== "function") return t.skip("OWED: pkg predates dng_uses_jxl (needs the rebuilt pkg)");
    const d = await decodeRaw(f);
    assert.ok(d.width > 0 && d.height > 0);
    assert.equal(d.rgb.length, d.width * d.height * 3);
    const mean = d.rgb.reduce((s, v) => s + v, 0) / d.rgb.length;
    assert.ok(mean > 20 && mean < 235, `mean ${mean}`);
    d.result.free();
  });
}
