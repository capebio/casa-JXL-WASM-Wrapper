/**
 * dist-provenance.test.ts
 *
 * TDD: RED → GREEN for Finding 23 (P0).
 *
 * Tests are written against the PUBLIC contract defined in
 * packages/jxl-wasm/scripts/provenance.mjs (to be created).
 *
 * Goals:
 *  1. inputDigest is sensitive to every named input (bridge source, exports,
 *     flags, libjxl commit/dirty, toolchain, role, tier, build-script hash,
 *     PGO profile digest).
 *  2. Partial-tier merge is rejected when provenance key differs.
 *  3. Modified-artifact detection (SRI mismatch).
 *  4. Missing required manifest field causes rejection.
 *  5. Release build with dirty source/libjxl is rejected unless explicit
 *     non-release flag records the dirtiness.
 *
 * Stubs/skips:
 *  - No real WASM build artifact is required; digest inputs are plain strings/objects.
 *  - verify-dist.mjs file-I/O tests use in-memory mocks (the verifier exports
 *    a pure verifyManifest function alongside the CLI).
 */

import { expect, test, describe } from "bun:test";
import {
  computeInputDigest,
  type ProvenanceInputs,
  type BuildProvenance,
  buildProvenanceKey,
  validateProvenance,
  type ManifestTierEntry,
  canMergePartialTier,
} from "../scripts/provenance.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_INPUTS: ProvenanceInputs = {
  bridgeSourceHash: "aabbccdd",
  exportsHash: "11223344",
  flags: ["-O3", "-msimd128"],
  libjxlCommit: "332feb17d17311c748445f7ee75c4fb55cc38530",
  libjxlDirty: false,
  toolchain: { emscripten: "4.0.14", node: "20.0.0" },
  role: "enc",
  tier: "simd",
  buildScriptHash: "deadbeef",
  pgoProfileDigest: undefined,
};

function makeProvenance(overrides: Partial<BuildProvenance> = {}): BuildProvenance {
  return {
    inputDigest: computeInputDigest(BASE_INPUTS),
    sourceCommit: "abc123",
    sourceDirty: false,
    libjxlCommit: BASE_INPUTS.libjxlCommit,
    libjxlDirty: false,
    toolchain: { emscripten: "4.0.14", node: "20.0.0" },
    role: "enc",
    tier: "simd",
    flags: ["-O3", "-msimd128"],
    ...overrides,
  };
}

function makeTierEntry(overrides: Partial<ManifestTierEntry> = {}): ManifestTierEntry {
  const provenance = makeProvenance();
  return {
    kind: "enc",
    tier: "simd",
    jsBytes: 7675,
    wasmBytes: 3072372,
    jsSha256: "b1c1b2d9189579e0098fd1b8a8404ebce248dffdae06a59acdea6b3e03f2ca55",
    wasmSha256: "482a538141a83900570f839ae4b53bdff46df090a4377007ebe4588df4a84ff5",
    jsIntegrity: "sha384-IKrbRnNiJebG57FDEYy3OoCW0Y42Q0eOM6QzjFOMYUJT00Ug7v5l5RqcKH7sStP3",
    wasmIntegrity: "sha384-+kHKpP0c/aAvKO/oq5YoUAaYK5/d529nZP/woc5OkklPhOhFTIiR/XD/z1dEkWeR",
    flags: ["-O3", "-msimd128"],
    provenance,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. inputDigest sensitivity — changing ANY input changes the digest
// ---------------------------------------------------------------------------

describe("computeInputDigest — sensitivity", () => {
  test("identical inputs produce identical digests", () => {
    const d1 = computeInputDigest(BASE_INPUTS);
    const d2 = computeInputDigest({ ...BASE_INPUTS });
    expect(d1).toBe(d2);
  });

  test("changing bridgeSourceHash changes inputDigest", () => {
    const d1 = computeInputDigest(BASE_INPUTS);
    const d2 = computeInputDigest({ ...BASE_INPUTS, bridgeSourceHash: "00000000" });
    expect(d1).not.toBe(d2);
  });

  test("changing exportsHash changes inputDigest", () => {
    const d1 = computeInputDigest(BASE_INPUTS);
    const d2 = computeInputDigest({ ...BASE_INPUTS, exportsHash: "ffffffff" });
    expect(d1).not.toBe(d2);
  });

  test("adding a flag changes inputDigest", () => {
    const d1 = computeInputDigest(BASE_INPUTS);
    const d2 = computeInputDigest({ ...BASE_INPUTS, flags: [...BASE_INPUTS.flags, "-flto"] });
    expect(d1).not.toBe(d2);
  });

  test("reordering flags changes inputDigest (order-sensitive build inputs)", () => {
    const d1 = computeInputDigest(BASE_INPUTS);
    const d2 = computeInputDigest({ ...BASE_INPUTS, flags: [...BASE_INPUTS.flags].reverse() });
    expect(d1).not.toBe(d2);
  });

  test("changing libjxlCommit changes inputDigest", () => {
    const d1 = computeInputDigest(BASE_INPUTS);
    const d2 = computeInputDigest({ ...BASE_INPUTS, libjxlCommit: "0000000000000000000000000000000000000000" });
    expect(d1).not.toBe(d2);
  });

  test("changing libjxlDirty changes inputDigest", () => {
    const d1 = computeInputDigest(BASE_INPUTS);
    const d2 = computeInputDigest({ ...BASE_INPUTS, libjxlDirty: true });
    expect(d1).not.toBe(d2);
  });

  test("changing toolchain emscripten version changes inputDigest", () => {
    const d1 = computeInputDigest(BASE_INPUTS);
    const d2 = computeInputDigest({ ...BASE_INPUTS, toolchain: { ...BASE_INPUTS.toolchain, emscripten: "3.1.27" } });
    expect(d1).not.toBe(d2);
  });

  test("adding a toolchain key changes inputDigest", () => {
    const d1 = computeInputDigest(BASE_INPUTS);
    const d2 = computeInputDigest({ ...BASE_INPUTS, toolchain: { ...BASE_INPUTS.toolchain, cmake: "3.27.0" } });
    expect(d1).not.toBe(d2);
  });

  test("changing role changes inputDigest", () => {
    const d1 = computeInputDigest(BASE_INPUTS);
    const d2 = computeInputDigest({ ...BASE_INPUTS, role: "dec" });
    expect(d1).not.toBe(d2);
  });

  test("changing tier changes inputDigest", () => {
    const d1 = computeInputDigest(BASE_INPUTS);
    const d2 = computeInputDigest({ ...BASE_INPUTS, tier: "relaxed-simd-mt" });
    expect(d1).not.toBe(d2);
  });

  test("changing buildScriptHash changes inputDigest", () => {
    const d1 = computeInputDigest(BASE_INPUTS);
    const d2 = computeInputDigest({ ...BASE_INPUTS, buildScriptHash: "cafecafe" });
    expect(d1).not.toBe(d2);
  });

  test("adding pgoProfileDigest changes inputDigest", () => {
    const d1 = computeInputDigest(BASE_INPUTS);
    const d2 = computeInputDigest({ ...BASE_INPUTS, pgoProfileDigest: "abc123profile" });
    expect(d1).not.toBe(d2);
  });

  test("changing pgoProfileDigest changes inputDigest", () => {
    const withPgo = { ...BASE_INPUTS, pgoProfileDigest: "abc123profile" };
    const d1 = computeInputDigest(withPgo);
    const d2 = computeInputDigest({ ...withPgo, pgoProfileDigest: "differentprofile" });
    expect(d1).not.toBe(d2);
  });

  test("digest is a non-empty hex string", () => {
    const d = computeInputDigest(BASE_INPUTS);
    expect(typeof d).toBe("string");
    expect(d.length).toBeGreaterThan(0);
    expect(/^[0-9a-f]+$/i.test(d)).toBe(true);
  });

  test("toolchain key ordering does not affect digest (sorted-key normalization)", () => {
    const d1 = computeInputDigest({
      ...BASE_INPUTS,
      toolchain: { emscripten: "4.0.14", node: "20.0.0" },
    });
    const d2 = computeInputDigest({
      ...BASE_INPUTS,
      toolchain: { node: "20.0.0", emscripten: "4.0.14" },
    });
    expect(d1).toBe(d2);
  });
});

// ---------------------------------------------------------------------------
// 2. buildProvenanceKey — partial-tier merge identity
// ---------------------------------------------------------------------------

describe("buildProvenanceKey", () => {
  test("same provenance produces same key", () => {
    const p = makeProvenance();
    expect(buildProvenanceKey(p)).toBe(buildProvenanceKey(p));
  });

  test("different inputDigest produces different key", () => {
    const p1 = makeProvenance({ inputDigest: "aaaa" });
    const p2 = makeProvenance({ inputDigest: "bbbb" });
    expect(buildProvenanceKey(p1)).not.toBe(buildProvenanceKey(p2));
  });

  test("different sourceCommit produces different key", () => {
    const p1 = makeProvenance({ sourceCommit: "abc" });
    const p2 = makeProvenance({ sourceCommit: "def" });
    expect(buildProvenanceKey(p1)).not.toBe(buildProvenanceKey(p2));
  });

  test("different libjxlCommit produces different key", () => {
    const p1 = makeProvenance({ libjxlCommit: "aaa" });
    const p2 = makeProvenance({ libjxlCommit: "bbb" });
    expect(buildProvenanceKey(p1)).not.toBe(buildProvenanceKey(p2));
  });
});

// ---------------------------------------------------------------------------
// 3. canMergePartialTier — stale partial-tier merge rejection
// ---------------------------------------------------------------------------

describe("canMergePartialTier", () => {
  test("allows merge when provenance key matches", () => {
    const entry = makeTierEntry();
    const incoming = makeTierEntry();
    expect(canMergePartialTier(entry, incoming)).toBe(true);
  });

  test("rejects merge when inputDigest differs (stale partial build)", () => {
    const existing = makeTierEntry({
      provenance: makeProvenance({ inputDigest: "stale-digest" }),
    });
    const incoming = makeTierEntry({
      provenance: makeProvenance({ inputDigest: "fresh-digest" }),
    });
    expect(canMergePartialTier(existing, incoming)).toBe(false);
  });

  test("rejects merge when libjxlCommit differs", () => {
    const existing = makeTierEntry({
      provenance: makeProvenance({ libjxlCommit: "old-commit" }),
    });
    const incoming = makeTierEntry({
      provenance: makeProvenance({ libjxlCommit: "new-commit" }),
    });
    expect(canMergePartialTier(existing, incoming)).toBe(false);
  });

  test("rejects merge when sourceCommit differs", () => {
    const existing = makeTierEntry({
      provenance: makeProvenance({ sourceCommit: "rev-a" }),
    });
    const incoming = makeTierEntry({
      provenance: makeProvenance({ sourceCommit: "rev-b" }),
    });
    expect(canMergePartialTier(existing, incoming)).toBe(false);
  });

  test("rejects merge when existing tier entry has no provenance (legacy)", () => {
    // Entries without provenance are from before this feature; they MUST be
    // considered stale to prevent merging unaudited artifacts.
    const existing = makeTierEntry({ provenance: undefined as unknown as BuildProvenance });
    const incoming = makeTierEntry();
    expect(canMergePartialTier(existing, incoming)).toBe(false);
  });

  test("rejects merge when incoming tier entry has no provenance", () => {
    const existing = makeTierEntry();
    const incoming = makeTierEntry({ provenance: undefined as unknown as BuildProvenance });
    expect(canMergePartialTier(existing, incoming)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. validateProvenance — missing field and dirty-release rejection
// ---------------------------------------------------------------------------

describe("validateProvenance — completeness", () => {
  test("valid provenance passes", () => {
    const p = makeProvenance();
    expect(() => validateProvenance(p, { releaseMode: false })).not.toThrow();
  });

  test("missing inputDigest is rejected", () => {
    const p = makeProvenance({ inputDigest: "" });
    expect(() => validateProvenance(p, { releaseMode: false })).toThrow(/inputDigest/);
  });

  test("missing sourceCommit is rejected", () => {
    const p = makeProvenance({ sourceCommit: "" });
    expect(() => validateProvenance(p, { releaseMode: false })).toThrow(/sourceCommit/);
  });

  test("missing libjxlCommit is rejected", () => {
    const p = makeProvenance({ libjxlCommit: "" });
    expect(() => validateProvenance(p, { releaseMode: false })).toThrow(/libjxlCommit/);
  });

  test("empty toolchain is rejected", () => {
    const p = makeProvenance({ toolchain: {} });
    expect(() => validateProvenance(p, { releaseMode: false })).toThrow(/toolchain/);
  });

  test("missing role is rejected", () => {
    const p = makeProvenance({ role: "" as "enc" });
    expect(() => validateProvenance(p, { releaseMode: false })).toThrow(/role/);
  });

  test("missing tier is rejected", () => {
    const p = makeProvenance({ tier: "" });
    expect(() => validateProvenance(p, { releaseMode: false })).toThrow(/tier/);
  });
});

describe("validateProvenance — dirty-release guard", () => {
  test("dirty source is allowed in non-release mode", () => {
    const p = makeProvenance({ sourceDirty: true });
    expect(() => validateProvenance(p, { releaseMode: false })).not.toThrow();
  });

  test("dirty libjxl is allowed in non-release mode", () => {
    const p = makeProvenance({ libjxlDirty: true });
    expect(() => validateProvenance(p, { releaseMode: false })).not.toThrow();
  });

  test("dirty source in release mode is rejected", () => {
    const p = makeProvenance({ sourceDirty: true });
    expect(() => validateProvenance(p, { releaseMode: true })).toThrow(/dirty.*release|release.*dirty|sourceDirty/i);
  });

  test("dirty libjxl in release mode is rejected", () => {
    const p = makeProvenance({ libjxlDirty: true });
    expect(() => validateProvenance(p, { releaseMode: true })).toThrow(/dirty.*release|release.*dirty|libjxlDirty/i);
  });

  test("clean source+libjxl passes release mode", () => {
    const p = makeProvenance({ sourceDirty: false, libjxlDirty: false });
    expect(() => validateProvenance(p, { releaseMode: true })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. verifyManifest — artifact SRI + provenance completeness
// ---------------------------------------------------------------------------

// Import the pure verifyManifest function (no file I/O — takes data directly).
import {
  verifyManifest,
  type VerifyManifestResult,
} from "../scripts/verify-dist.mjs";

// Build a minimal manifest that passes all checks, using in-memory artifact data.
function makeGoodManifest() {
  const entry = makeTierEntry();
  return {
    buildId: "jxl-wasm-0.1.0",
    libjxlCommit: "332feb17d17311c748445f7ee75c4fb55cc38530",
    tiers: {
      "enc:simd": entry,
    },
  };
}

// Artifact bytes that match the SHA-256 in makeTierEntry()
// We need to create real bytes whose SHA-256 matches the test values.
// Since we control both sides, we'll generate fresh consistent values.
import { createHash } from "node:crypto";

function makeArtifactBytes(label: string): Uint8Array {
  // Deterministic content per label — just needs a SHA-256 we can reference.
  return new TextEncoder().encode(`fake-artifact:${label}`);
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function sri384(data: Uint8Array): string {
  return `sha384-${createHash("sha384").update(data).digest("base64")}`;
}

describe("verifyManifest — artifact integrity", () => {
  test("valid manifest with matching artifact hashes passes", () => {
    const jsData = makeArtifactBytes("js");
    const wasmData = makeArtifactBytes("wasm");
    const entry: ManifestTierEntry = makeTierEntry({
      jsSha256: sha256Hex(jsData),
      wasmSha256: sha256Hex(wasmData),
      jsIntegrity: sri384(jsData),
      wasmIntegrity: sri384(wasmData),
    });

    const manifest = {
      buildId: "jxl-wasm-0.1.0",
      libjxlCommit: "332feb17d17311c748445f7ee75c4fb55cc38530",
      tiers: { "enc:simd": entry },
    };

    const artifacts = new Map<string, Uint8Array>([
      ["enc:simd:js", jsData],
      ["enc:simd:wasm", wasmData],
    ]);

    const result: VerifyManifestResult = verifyManifest(manifest, artifacts);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("modified JS artifact (wrong sha256) is detected", () => {
    const jsData = makeArtifactBytes("js");
    const tamperedJs = makeArtifactBytes("tampered-js");
    const wasmData = makeArtifactBytes("wasm");
    const entry: ManifestTierEntry = makeTierEntry({
      jsSha256: sha256Hex(jsData),  // expected hash for original
      wasmSha256: sha256Hex(wasmData),
      jsIntegrity: sri384(jsData),
      wasmIntegrity: sri384(wasmData),
    });

    const manifest = {
      buildId: "jxl-wasm-0.1.0",
      libjxlCommit: "332feb17d17311c748445f7ee75c4fb55cc38530",
      tiers: { "enc:simd": entry },
    };

    const artifacts = new Map<string, Uint8Array>([
      ["enc:simd:js", tamperedJs],  // tampered
      ["enc:simd:wasm", wasmData],
    ]);

    const result = verifyManifest(manifest, artifacts);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => /enc:simd.*js|jsSha256|jsIntegrity/i.test(e))).toBe(true);
  });

  test("modified WASM artifact (wrong sha256) is detected", () => {
    const jsData = makeArtifactBytes("js");
    const wasmData = makeArtifactBytes("wasm");
    const tamperedWasm = makeArtifactBytes("tampered-wasm");
    const entry: ManifestTierEntry = makeTierEntry({
      jsSha256: sha256Hex(jsData),
      wasmSha256: sha256Hex(wasmData),  // expected hash for original
      jsIntegrity: sri384(jsData),
      wasmIntegrity: sri384(wasmData),
    });

    const manifest = {
      buildId: "jxl-wasm-0.1.0",
      libjxlCommit: "332feb17d17311c748445f7ee75c4fb55cc38530",
      tiers: { "enc:simd": entry },
    };

    const artifacts = new Map<string, Uint8Array>([
      ["enc:simd:js", jsData],
      ["enc:simd:wasm", tamperedWasm],  // tampered
    ]);

    const result = verifyManifest(manifest, artifacts);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => /enc:simd.*wasm|wasmSha256|wasmIntegrity/i.test(e))).toBe(true);
  });

  test("missing artifact data for a tier is detected", () => {
    const jsData = makeArtifactBytes("js");
    const wasmData = makeArtifactBytes("wasm");
    const entry: ManifestTierEntry = makeTierEntry({
      jsSha256: sha256Hex(jsData),
      wasmSha256: sha256Hex(wasmData),
      jsIntegrity: sri384(jsData),
      wasmIntegrity: sri384(wasmData),
    });

    const manifest = {
      buildId: "jxl-wasm-0.1.0",
      libjxlCommit: "332feb17d17311c748445f7ee75c4fb55cc38530",
      tiers: { "enc:simd": entry },
    };

    // Provide no artifacts
    const result = verifyManifest(manifest, new Map());
    expect(result.ok).toBe(false);
  });
});

describe("verifyManifest — provenance completeness", () => {
  test("tier entry without provenance field is flagged", () => {
    const jsData = makeArtifactBytes("js");
    const wasmData = makeArtifactBytes("wasm");
    const entry: ManifestTierEntry = makeTierEntry({
      jsSha256: sha256Hex(jsData),
      wasmSha256: sha256Hex(wasmData),
      jsIntegrity: sri384(jsData),
      wasmIntegrity: sri384(wasmData),
      provenance: undefined as unknown as BuildProvenance,
    });

    const manifest = {
      buildId: "jxl-wasm-0.1.0",
      libjxlCommit: "332feb17d17311c748445f7ee75c4fb55cc38530",
      tiers: { "enc:simd": entry },
    };

    const artifacts = new Map([
      ["enc:simd:js", jsData],
      ["enc:simd:wasm", wasmData],
    ]);

    const result = verifyManifest(manifest, artifacts);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => /provenance/i.test(e))).toBe(true);
  });

  test("tier entry with empty inputDigest in provenance is flagged", () => {
    const jsData = makeArtifactBytes("js");
    const wasmData = makeArtifactBytes("wasm");
    const entry: ManifestTierEntry = makeTierEntry({
      jsSha256: sha256Hex(jsData),
      wasmSha256: sha256Hex(wasmData),
      jsIntegrity: sri384(jsData),
      wasmIntegrity: sri384(wasmData),
      provenance: makeProvenance({ inputDigest: "" }),
    });

    const manifest = {
      buildId: "jxl-wasm-0.1.0",
      libjxlCommit: "332feb17d17311c748445f7ee75c4fb55cc38530",
      tiers: { "enc:simd": entry },
    };

    const artifacts = new Map([
      ["enc:simd:js", jsData],
      ["enc:simd:wasm", wasmData],
    ]);

    const result = verifyManifest(manifest, artifacts);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => /inputDigest/i.test(e))).toBe(true);
  });
});

describe("verifyManifest — pgo field", () => {
  test("pgo.applied field is preserved and accessible in result", () => {
    const jsData = makeArtifactBytes("js");
    const wasmData = makeArtifactBytes("wasm");
    const entry: ManifestTierEntry = makeTierEntry({
      jsSha256: sha256Hex(jsData),
      wasmSha256: sha256Hex(wasmData),
      jsIntegrity: sri384(jsData),
      wasmIntegrity: sri384(wasmData),
    });

    const manifest = {
      buildId: "jxl-wasm-0.1.0",
      libjxlCommit: "332feb17d17311c748445f7ee75c4fb55cc38530",
      tiers: { "enc:simd": entry },
      pgo: { profileDigest: "abc123", applied: true },
    };

    const artifacts = new Map([
      ["enc:simd:js", jsData],
      ["enc:simd:wasm", wasmData],
    ]);

    const result = verifyManifest(manifest, artifacts);
    expect(result.ok).toBe(true);
    expect(result.pgo?.applied).toBe(true);
    expect(result.pgo?.profileDigest).toBe("abc123");
  });
});

// ---------------------------------------------------------------------------
// I-A: release build with unknown sourceCommit is rejected
// ---------------------------------------------------------------------------

describe("validateProvenance — unknown sourceCommit in release mode (I-A)", () => {
  test("sourceCommit='unknown' is rejected in release mode", () => {
    const p = makeProvenance({ sourceCommit: "unknown", sourceDirty: false });
    expect(() => validateProvenance(p, { releaseMode: true })).toThrow(
      /unknown.*release|release.*unknown|sourceCommit.*unknown/i
    );
  });

  test("sourceCommit='unknown' is allowed in non-release mode", () => {
    const p = makeProvenance({ sourceCommit: "unknown", sourceDirty: false });
    expect(() => validateProvenance(p, { releaseMode: false })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// I-B: missing sourceDirty / libjxlDirty fields are rejected
// ---------------------------------------------------------------------------

describe("validateProvenance — missing dirty boolean fields (I-B)", () => {
  test("sourceDirty absent (undefined) is rejected", () => {
    const p = makeProvenance();
    // Delete the field entirely to simulate absent (not present in JSON)
    const pMissing = { ...p } as Record<string, unknown>;
    delete pMissing["sourceDirty"];
    expect(() => validateProvenance(pMissing as BuildProvenance, { releaseMode: false })).toThrow(
      /sourceDirty.*boolean|boolean.*sourceDirty/i
    );
  });

  test("libjxlDirty absent (undefined) is rejected", () => {
    const p = makeProvenance();
    const pMissing = { ...p } as Record<string, unknown>;
    delete pMissing["libjxlDirty"];
    expect(() => validateProvenance(pMissing as BuildProvenance, { releaseMode: false })).toThrow(
      /libjxlDirty.*boolean|boolean.*libjxlDirty/i
    );
  });

  test("sourceDirty=null (non-boolean) is rejected", () => {
    const p = makeProvenance({ sourceDirty: null as unknown as boolean });
    expect(() => validateProvenance(p, { releaseMode: false })).toThrow(
      /sourceDirty.*boolean|boolean.*sourceDirty/i
    );
  });

  test("libjxlDirty=null (non-boolean) is rejected", () => {
    const p = makeProvenance({ libjxlDirty: null as unknown as boolean });
    expect(() => validateProvenance(p, { releaseMode: false })).toThrow(
      /libjxlDirty.*boolean|boolean.*libjxlDirty/i
    );
  });

  test("valid boolean false values for both fields pass", () => {
    const p = makeProvenance({ sourceDirty: false, libjxlDirty: false });
    expect(() => validateProvenance(p, { releaseMode: false })).not.toThrow();
  });

  test("valid boolean true values for both fields pass in non-release mode", () => {
    const p = makeProvenance({ sourceDirty: true, libjxlDirty: true });
    expect(() => validateProvenance(p, { releaseMode: false })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Minor: verifyManifest with zero tiers returns ok:false (not vacuous success)
// ---------------------------------------------------------------------------

describe("verifyManifest — empty tiers guard (minor)", () => {
  test("manifest with zero tiers returns ok:false", () => {
    const result = verifyManifest({ buildId: "jxl-wasm-0.1.0", tiers: {} }, new Map());
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("manifest with no tiers key at all returns ok:false", () => {
    const result = verifyManifest({ buildId: "jxl-wasm-0.1.0" }, new Map());
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
