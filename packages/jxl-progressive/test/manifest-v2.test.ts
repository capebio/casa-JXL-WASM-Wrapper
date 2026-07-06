// packages/jxl-progressive/test/manifest-v2.test.ts
// S6 schema v2 round-trip: v1 manifests still parse; v2 adds per-tier pixel dims + asset
// capabilities, additively. Both survive JSON stringify → validateManifest unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateManifest,
  migrateManifest,
  tierPixelDims,
  PROGRESSIVE_MANIFEST_VERSION,
  type ProgressiveManifest,
} from "../src/progressive-manifest.js";

const v1Manifest: ProgressiveManifest = {
  version: 1,
  source: { width: 4000, height: 3000, hasAlpha: false, orientation: 1 },
  jxl: { bytes: 1843921, sha256: "a".repeat(64) },
  encoder: { name: "cjxl", libjxlVersion: "0.11.0", flags: ["--progressive"] },
  tiers: [
    { name: "dc", byteStart: 0, byteEnd: 156320, progressionIndex: 0, intendedUse: "thumbnail" },
    { name: "full", byteStart: 0, byteEnd: 1843921, progressionIndex: "final", intendedUse: "zoom-export" },
  ],
};

const v2Manifest: ProgressiveManifest = {
  version: 2,
  source: { width: 4000, height: 3000, hasAlpha: false, orientation: 1 },
  jxl: { bytes: 1843921, sha256: "b".repeat(64) },
  encoder: { name: "raw-pipeline", libjxlVersion: "0.12.0", flags: ["progressive"] },
  tiers: [
    { name: "dc", byteStart: 0, byteEnd: 156320, progressionIndex: 0, intendedUse: "thumbnail", pixelWidth: 500, pixelHeight: 375 },
    { name: "preview", byteStart: 0, byteEnd: 642112, progressionIndex: 2, intendedUse: "visible-card", pixelWidth: 2000, pixelHeight: 1500 },
    { name: "full", byteStart: 0, byteEnd: 1843921, progressionIndex: "final", intendedUse: "zoom-export", pixelWidth: 4000, pixelHeight: 3000 },
  ],
  capabilities: { quality: true, resolution: true, region: false },
};

function roundTrip(m: ProgressiveManifest): ProgressiveManifest {
  return validateManifest(JSON.parse(JSON.stringify(m)));
}

describe("schema v2 round-trip", () => {
  it("PROGRESSIVE_MANIFEST_VERSION is 2", () => {
    assert.equal(PROGRESSIVE_MANIFEST_VERSION, 2);
  });

  it("v1 manifest still parses and round-trips unchanged", () => {
    const rt = roundTrip(v1Manifest);
    assert.deepEqual(rt, v1Manifest);
    assert.equal(rt.version, 1);
    // v1 tiers carry no pixel dims.
    assert.equal(rt.tiers[0]!.pixelWidth, undefined);
  });

  it("v2 manifest with per-tier dims + capabilities round-trips unchanged", () => {
    const rt = roundTrip(v2Manifest);
    assert.deepEqual(rt, v2Manifest);
    assert.equal(rt.version, 2);
    assert.equal(rt.tiers[0]!.pixelWidth, 500);
    assert.deepEqual(rt.capabilities, { quality: true, resolution: true, region: false });
  });

  it("migrateManifest passes both versions through", () => {
    assert.equal(migrateManifest(JSON.parse(JSON.stringify(v1Manifest))).version, 1);
    assert.equal(migrateManifest(JSON.parse(JSON.stringify(v2Manifest))).version, 2);
  });

  it("tierPixelDims returns v2 dims when present, source dims as default", () => {
    // v2 tier carries explicit dims.
    assert.deepEqual(tierPixelDims(v2Manifest, v2Manifest.tiers[0]!), { width: 500, height: 375 });
    // v1 tier lacks dims → default-fill from source.
    assert.deepEqual(tierPixelDims(v1Manifest, v1Manifest.tiers[0]!), { width: 4000, height: 3000 });
  });
});

describe("schema v2 validation guards", () => {
  it("rejects a tier pixel dim larger than the source", () => {
    assert.throws(
      () => validateManifest({
        ...v2Manifest,
        tiers: [{ ...v2Manifest.tiers[0]!, pixelWidth: 99999 }, v2Manifest.tiers[2]!],
      }),
      /pixelWidth/,
    );
  });

  it("rejects a non-boolean capability", () => {
    assert.throws(
      () => validateManifest({ ...v2Manifest, capabilities: { quality: "yes" } as unknown as { quality: boolean } }),
      /capabilities\.quality/,
    );
  });

  it("accepts a v1 manifest presented with new optional fields absent (default-fill)", () => {
    const m = validateManifest(JSON.parse(JSON.stringify(v1Manifest)));
    assert.equal(m.capabilities, undefined);
  });
});
