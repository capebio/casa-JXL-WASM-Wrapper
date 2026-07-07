// packages/jxl-progressive/test/manifest.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateManifest,
  lookupTier,
  checkHash,
  migrateManifest,
  ManifestValidationError,
  ManifestStaleError,
  type ProgressiveManifest,
} from "../src/progressive-manifest.js";

const validManifest: ProgressiveManifest = {
  version: 1,
  source: { width: 4000, height: 3000, hasAlpha: false, orientation: 1 },
  jxl: { bytes: 1843921, sha256: "a".repeat(64) },
  encoder: { name: "cjxl", libjxlVersion: "0.11.0", flags: ["--progressive"] },
  tiers: [
    { name: "dc", byteStart: 0, byteEnd: 156320, progressionIndex: 1, intendedUse: "thumbnail" },
    { name: "preview", byteStart: 0, byteEnd: 642112, progressionIndex: 3, intendedUse: "visible-card" },
    { name: "full", byteStart: 0, byteEnd: 1843921, progressionIndex: "final", intendedUse: "zoom-export" },
  ],
};

describe("validateManifest", () => {
  it("accepts a valid manifest", () => {
    const m = validateManifest(validManifest);
    assert.equal(m.version, 1);
    assert.equal(m.tiers.length, 3);
  });

  it("throws on null", () => {
    assert.throws(() => validateManifest(null), ManifestValidationError);
  });

  it("accepts version 2 (S6 schema)", () => {
    const m = validateManifest({ ...validManifest, version: 2 });
    assert.equal(m.version, 2);
  });

  it("throws on a newer-than-reader version", () => {
    assert.throws(
      () => validateManifest({ ...validManifest, version: 3 }),
      (e: unknown) => e instanceof ManifestValidationError && e.field === "version",
    );
  });

  it("throws when tiers is empty", () => {
    assert.throws(
      () => validateManifest({ ...validManifest, tiers: [] }),
      (e: unknown) => e instanceof ManifestValidationError && e.field === "tiers",
    );
  });

  it("throws on invalid tier name", () => {
    const bad = {
      ...validManifest,
      tiers: [{ name: "bad", byteStart: 0, byteEnd: 100, progressionIndex: 1, intendedUse: "x" }],
    };
    assert.throws(
      () => validateManifest(bad),
      (e: unknown) => e instanceof ManifestValidationError && /tiers\[0\]\.name/.test(e.field),
    );
  });

  it("throws on missing jxl.sha256", () => {
    const bad = { ...validManifest, jxl: { bytes: 100 } };
    assert.throws(
      () => validateManifest(bad),
      (e: unknown) => e instanceof ManifestValidationError && /jxl\.sha256/.test(e.field),
    );
  });

  it("accepts optional saliency field", () => {
    const m = validateManifest({
      ...validManifest,
      saliency: { enabled: true, centerX: 0.5, centerY: 0.4, confidence: 0.9, method: "attention" },
    });
    assert.equal(m.saliency?.enabled, true);
  });
});

describe("lookupTier", () => {
  it("finds dc tier", () => {
    const t = lookupTier(validManifest, "dc");
    assert.equal(t?.byteEnd, 156320);
  });

  it("finds full tier", () => {
    const t = lookupTier(validManifest, "full");
    assert.equal(t?.progressionIndex, "final");
  });

  it("returns undefined for missing tier", () => {
    const m: ProgressiveManifest = { ...validManifest, tiers: [validManifest.tiers[2]!] };
    assert.equal(lookupTier(m, "dc"), undefined);
  });
});

describe("checkHash", () => {
  it("returns true when hash matches manifest sha256", async () => {
    // Build a buffer whose SHA-256 we know
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    // Compute expected sha256 via SubtleCrypto
    const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    const expectedHex = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const m: ProgressiveManifest = { ...validManifest, jxl: { bytes: 4, sha256: expectedHex } };
    assert.equal(await checkHash(m, bytes), true);
  });

  it("returns false when hash does not match", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const m: ProgressiveManifest = { ...validManifest, jxl: { bytes: 4, sha256: "0".repeat(64) } };
    assert.equal(await checkHash(m, bytes), false);
  });
});

describe("migrateManifest", () => {
  it("passes through version 1 unchanged", () => {
    const m = migrateManifest(validManifest);
    assert.equal(m.version, 1);
  });

  it("passes through version 2 (S6 schema)", () => {
    const m = migrateManifest({ ...validManifest, version: 2 });
    assert.equal(m.version, 2);
  });

  it("throws on a newer-than-reader version (future, unsupported)", () => {
    assert.throws(
      () => migrateManifest({ ...validManifest, version: 3 }),
      ManifestValidationError,
    );
  });
});
