import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSidecar } from "./sidecar.mjs";

const base = {
  filename: "ADH 1248.CR2", sha256: "abc123", bytes: 39416383, format: "cr2",
  width: 6000, height: 4000, orientationApplied: true,
  datetimeExif: "2026:05:27 17:53:12",
  decoded: { has_gps: true, gps_lat: -25.85, gps_lon: 28.19, gps_alt: 1300 },
};

test("buildSidecar produces the casava-ai/1 shape with decimal geo + ISO datetime", () => {
  const s = buildSidecar(base);
  assert.equal(s.schema, "casava-ai/1");
  assert.deepEqual(s.source, { filename: "ADH 1248.CR2", sha256: "abc123", bytes: 39416383, format: "cr2" });
  assert.deepEqual(s.image, { width: 6000, height: 4000, orientation_applied: true });
  assert.deepEqual(s.colour, { space: "sRGB", icc_embedded: false });
  assert.equal(s.datetime, "2026-05-27T17:53:12");
  assert.deepEqual(s.geo, { lat: -25.85, lon: 28.19, accuracy_m: null, elevation_m: 1300 });
  assert.deepEqual(s.proxy, { spec: "768px/q80/4:2:0", stored: false });
  assert.deepEqual(s.generator, { name: "casava-ai", version: 1 });
});

test("buildSidecar sets geo and datetime null when absent", () => {
  const s = buildSidecar({ ...base, datetimeExif: "", decoded: { has_gps: false } });
  assert.equal(s.geo, null);
  assert.equal(s.datetime, null);
});

test("buildSidecar excludes photographic EXIF (no camera/lens/iso/exposure keys)", () => {
  const s = buildSidecar(base);
  for (const k of ["camera", "lens", "iso", "exposure", "fnumber", "focal_length", "capture"]) {
    assert.equal(k in s, false, `unexpected key ${k}`);
  }
});
