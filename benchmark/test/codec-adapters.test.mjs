import { test } from "node:test";
import assert from "node:assert/strict";
import { ADAPTERS } from "../codec-adapters.mjs";

const w = 48, h = 48;
const rgba = new Uint8Array(w * h * 4);
for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 80; rgba[i+1] = 160; rgba[i+2] = 40; rgba[i+3] = 255; }

test("every non-jxl adapter round-trips rgba at correct dims + 4ch", async () => {
  for (const a of ADAPTERS.filter(x => x.key !== "jxl")) {
    const q = a.lossless ? undefined : 60;
    const bytes = await a.encode(rgba, w, h, q);
    assert.ok(bytes.length > 0, `${a.key} produced empty output`);
    const back = await a.decode(bytes);
    assert.equal(back.width, w, `${a.key} width`);
    assert.equal(back.height, h, `${a.key} height`);
    assert.equal(back.data.length, w * h * 4, `${a.key} channels`);
  }
});

test("adapter keys are unique and runtime-tagged", () => {
  const keys = ADAPTERS.map(a => a.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const a of ADAPTERS) assert.ok(a.runtime === "native" || a.runtime === "wasm");
});
