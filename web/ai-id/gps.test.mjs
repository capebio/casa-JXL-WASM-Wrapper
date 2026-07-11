import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeGps, gpsFromDecoded } from "./gps.mjs";

test("normalizeGps: signed decimal to 5dp, meters to 1dp", () => {
  assert.deepEqual(
    normalizeGps({ lat: -25.8523456, lon: 28.1911234, elevationM: 1300.44, accuracyM: 4.87 }),
    { lat: -25.85235, lon: 28.19112, accuracy_m: 4.9, elevation_m: 1300.4 },
  );
});

test("normalizeGps: unknown accuracy/elevation → null", () => {
  assert.deepEqual(
    normalizeGps({ lat: 10, lon: 20 }),
    { lat: 10, lon: 20, accuracy_m: null, elevation_m: null },
  );
});

test("normalizeGps: absent or out-of-range → null", () => {
  assert.equal(normalizeGps({ present: false, lat: 1, lon: 2 }), null);
  assert.equal(normalizeGps({ lat: Number.NaN, lon: 2 }), null);
  assert.equal(normalizeGps({ lat: 100, lon: 2 }), null); // |lat| > 90
  assert.equal(normalizeGps({ lat: 2, lon: 200 }), null); // |lon| > 180
});

test("gpsFromDecoded: maps decoded getters; null when no fix", () => {
  assert.deepEqual(
    gpsFromDecoded({ has_gps: true, gps_lat: -25.85, gps_lon: 28.19, gps_alt: 1300 }),
    { lat: -25.85, lon: 28.19, accuracy_m: null, elevation_m: 1300 },
  );
  assert.equal(gpsFromDecoded({ has_gps: false }), null);
});
