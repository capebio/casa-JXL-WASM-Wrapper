import { test } from "node:test";
import assert from "node:assert/strict";
import { exifDatetimeToIso } from "./datetime-geo.mjs";

test("exifDatetimeToIso converts EXIF colon date to ISO 8601", () => {
  assert.equal(exifDatetimeToIso("2026:05:27 17:53:12"), "2026-05-27T17:53:12");
});

test("exifDatetimeToIso returns null for empty/blank/garbage", () => {
  assert.equal(exifDatetimeToIso(""), null);
  assert.equal(exifDatetimeToIso("   "), null);
  assert.equal(exifDatetimeToIso("not a date"), null);
});

