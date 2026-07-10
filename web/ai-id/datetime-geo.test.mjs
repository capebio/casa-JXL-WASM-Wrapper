import { test } from "node:test";
import assert from "node:assert/strict";
import { exifDatetimeToIso, geoBlock } from "./datetime-geo.mjs";

test("exifDatetimeToIso converts EXIF colon date to ISO 8601", () => {
  assert.equal(exifDatetimeToIso("2026:05:27 17:53:12"), "2026-05-27T17:53:12");
});

test("exifDatetimeToIso returns null for empty/blank/garbage", () => {
  assert.equal(exifDatetimeToIso(""), null);
  assert.equal(exifDatetimeToIso("   "), null);
  assert.equal(exifDatetimeToIso("not a date"), null);
});

test("geoBlock returns decimal block when GPS present", () => {
  assert.deepEqual(
    geoBlock({ has_gps: true, gps_lat: -25.85, gps_lon: 28.19, gps_alt: 1300 }),
    { lat: -25.85, lon: 28.19, alt: 1300 },
  );
});

test("geoBlock returns null when GPS absent", () => {
  assert.equal(geoBlock({ has_gps: false, gps_lat: 0, gps_lon: 0, gps_alt: 0 }), null);
});
