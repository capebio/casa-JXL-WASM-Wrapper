import { expect, test, describe } from "bun:test";
import { parsePyramidManifest, parseGalleryIndex, ManifestValidationError, MANIFEST_SCHEMA_VERSION } from "../src/manifest-validate.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 2,
    imageId: "img-001",
    master: { name: "shot.orf", format: "orf", mtimeMs: 1700000000000 },
    orientation: "baked",
    width: 4608,
    height: 3456,
    aspect: 4608 / 3456,
    levels: [
      { size: 512, w: 512, h: 384, bytes: 50000, bitsPerSample: 8, contenthash: "aabbcc", tiled: false },
      { size: "full", w: 4608, h: 3456, bytes: 2000000, bitsPerSample: 8, contenthash: "ddeeff", tiled: false },
    ],
    ...overrides,
  };
}

function expectValidationError(fn: () => unknown, pathFragment?: string): void {
  let thrown: unknown;
  try { fn(); } catch (e) { thrown = e; }
  expect(thrown).toBeInstanceOf(ManifestValidationError);
  if (pathFragment) {
    expect((thrown as ManifestValidationError).path).toContain(pathFragment);
  }
}

// ── Schema version handling ──────────────────────────────────────────────────

describe("schema versioning", () => {
  test("schema 2 parses correctly", () => {
    const m = parsePyramidManifest(baseManifest());
    expect(m.schema).toBe(2);
    expect(m.imageId).toBe("img-001");
  });

  test("schema 1 normalizes to 2 with stub=false proxy=false defaults", () => {
    const m = parsePyramidManifest(baseManifest({ schema: 1 }));
    expect(m.schema).toBe(2);
    expect(m.stub).toBe(false);
    expect(m.proxy).toBe(false);
  });

  test("schema 0 throws ManifestValidationError", () => {
    expectValidationError(() => parsePyramidManifest(baseManifest({ schema: 0 })), "schema");
  });

  test(`schema ${MANIFEST_SCHEMA_VERSION + 1} throws with "newer than reader" message`, () => {
    let thrown: unknown;
    try { parsePyramidManifest(baseManifest({ schema: MANIFEST_SCHEMA_VERSION + 1 })); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ManifestValidationError);
    expect((thrown as ManifestValidationError).message).toContain("newer than reader");
  });
});

// ── Required fields ──────────────────────────────────────────────────────────

describe("required fields", () => {
  test("missing imageId throws", () => {
    const m = baseManifest(); delete m["imageId"];
    expectValidationError(() => parsePyramidManifest(m), "imageId");
  });

  test("missing master throws", () => {
    const m = baseManifest(); delete m["master"];
    expectValidationError(() => parsePyramidManifest(m), "master");
  });

  test("missing levels throws", () => {
    const m = baseManifest(); delete m["levels"];
    expectValidationError(() => parsePyramidManifest(m), "levels");
  });

  test("empty levels array throws", () => {
    expectValidationError(() => parsePyramidManifest(baseManifest({ levels: [] })), "levels");
  });

  test("level with empty contenthash throws", () => {
    const m = baseManifest({
      levels: [
        { size: "full", w: 100, h: 100, bytes: 1000, bitsPerSample: 8, contenthash: "", tiled: false },
      ],
    });
    expectValidationError(() => parsePyramidManifest(m), "contenthash");
  });
});

// ── Aspect ratio check ───────────────────────────────────────────────────────

describe("aspect ratio", () => {
  test("valid aspect passes", () => {
    const m = parsePyramidManifest(baseManifest());
    expect(m.aspect).toBeCloseTo(4608 / 3456, 5);
  });

  test("aspect inconsistent with width/height throws", () => {
    expectValidationError(() => parsePyramidManifest(baseManifest({ aspect: 2.5 })), "aspect");
  });
});

// ── Finite / bounded top-level dimensions (finding 73) ───────────────────────
// The reader is a trust boundary for untrusted network manifests. Non-finite,
// negative, or absurdly-large top-level width/height/aspect must be rejected so a
// hostile manifest cannot drive downstream allocation/tiling math off a cliff.

describe("finite/bounded top-level dimensions", () => {
  test("NaN width throws", () => {
    expectValidationError(() => parsePyramidManifest(baseManifest({ width: NaN })), "width");
  });

  test("Infinity width throws", () => {
    expectValidationError(() => parsePyramidManifest(baseManifest({ width: Infinity })), "width");
  });

  test("negative width throws", () => {
    // aspect kept negative so the aspect/ratio check does not fire first; width positivity must catch it.
    expectValidationError(() => parsePyramidManifest(baseManifest({ width: -100, aspect: -100 / 3456 })), "width");
  });

  test("negative height throws", () => {
    expectValidationError(() => parsePyramidManifest(baseManifest({ height: -100, aspect: 4608 / -100 })), "height");
  });

  test("absurdly-large width (beyond MAX_DIMENSION) throws", () => {
    expectValidationError(() => parsePyramidManifest(baseManifest({ width: 1e12, height: 1e12, aspect: 1 })), "width");
  });

  test("absurdly-large height (beyond MAX_DIMENSION) throws", () => {
    // width kept in-range so the height cap is what fires; aspect kept consistent.
    expectValidationError(() => parsePyramidManifest(baseManifest({ width: 4608, height: 1e12, aspect: 4608 / 1e12 })), "height");
  });

  test("non-positive aspect throws", () => {
    expectValidationError(() => parsePyramidManifest(baseManifest({ aspect: 0 })), "aspect");
  });

  test("NaN aspect throws", () => {
    expectValidationError(() => parsePyramidManifest(baseManifest({ aspect: NaN })), "aspect");
  });
});

// ── Index entry aspect bounds (finding 73) ───────────────────────────────────

describe("index entry finite/bounded aspect", () => {
  function baseIndex(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schema: 1,
      images: [{ imageId: "img-001", aspect: 1.333, l0: { contenthash: "abc", w: 256, h: 192 } }],
      ...overrides,
    };
  }

  test("NaN entry aspect throws", () => {
    expectValidationError(() => parseGalleryIndex(baseIndex({
      images: [{ imageId: "x", aspect: NaN, l0: { contenthash: "abc", w: 1, h: 1 } }],
    })), "aspect");
  });

  test("non-positive entry aspect throws", () => {
    expectValidationError(() => parseGalleryIndex(baseIndex({
      images: [{ imageId: "x", aspect: 0, l0: { contenthash: "abc", w: 1, h: 1 } }],
    })), "aspect");
  });

  test("absurdly-large l0.w throws", () => {
    expectValidationError(() => parseGalleryIndex(baseIndex({
      images: [{ imageId: "x", aspect: 1, l0: { contenthash: "abc", w: 1e12, h: 1 } }],
    })), "w");
  });
});

// ── Level ordering ───────────────────────────────────────────────────────────

describe("level ordering", () => {
  test("non-ascending sizes throw", () => {
    const m = baseManifest({
      levels: [
        { size: 1024, w: 1024, h: 768, bytes: 100000, bitsPerSample: 8, contenthash: "aaa", tiled: false },
        { size: 512, w: 512, h: 384, bytes: 50000, bitsPerSample: 8, contenthash: "bbb", tiled: false },
        { size: "full", w: 4608, h: 3456, bytes: 2000000, bitsPerSample: 8, contenthash: "ccc", tiled: false },
      ],
    });
    expectValidationError(() => parsePyramidManifest(m), "levels[1].size");
  });

  test('"full" not last throws', () => {
    const m = baseManifest({
      levels: [
        { size: "full", w: 4608, h: 3456, bytes: 2000000, bitsPerSample: 8, contenthash: "aaa", tiled: false },
        { size: 512, w: 512, h: 384, bytes: 50000, bitsPerSample: 8, contenthash: "bbb", tiled: false },
      ],
    });
    expectValidationError(() => parsePyramidManifest(m), "levels[0].size");
  });

  test("strictly ascending numeric sizes pass", () => {
    const m = baseManifest({
      levels: [
        { size: 256, w: 256, h: 192, bytes: 20000, bitsPerSample: 8, contenthash: "a1", tiled: false },
        { size: 512, w: 512, h: 384, bytes: 50000, bitsPerSample: 8, contenthash: "b2", tiled: false },
        { size: "full", w: 4608, h: 3456, bytes: 2000000, bitsPerSample: 8, contenthash: "c3", tiled: false },
      ],
    });
    expect(() => parsePyramidManifest(m)).not.toThrow();
  });
});

// ── tiled requires tiling descriptor ────────────────────────────────────────

describe("tiled level", () => {
  test("tiled=true without tiling descriptor throws", () => {
    const m = baseManifest({
      levels: [
        { size: "full", w: 4608, h: 3456, bytes: 2000000, bitsPerSample: 8, contenthash: "abc", tiled: true },
        // no tiling field
      ],
    });
    expectValidationError(() => parsePyramidManifest(m), "tiling");
  });

  test("tiled=true with valid tiling descriptor passes", () => {
    const m = baseManifest({
      levels: [
        {
          size: "full", w: 4608, h: 3456, bytes: 2000000, bitsPerSample: 8,
          contenthash: "abc", tiled: true,
          tiling: { tileSize: 256, cols: 18, rows: 14 },
        },
      ],
    });
    const result = parsePyramidManifest(m);
    expect(result.levels[0].tiling).toEqual({ tileSize: 256, cols: 18, rows: 14 });
  });
});

// ── convergedByteEnd constraint ──────────────────────────────────────────────

describe("convergedByteEnd", () => {
  test("convergedByteEnd > bytes throws", () => {
    const m = baseManifest({
      levels: [
        { size: "full", w: 4608, h: 3456, bytes: 1000, bitsPerSample: 8, contenthash: "abc", tiled: false, convergedByteEnd: 2000 },
      ],
    });
    expectValidationError(() => parsePyramidManifest(m), "convergedByteEnd");
  });

  test("convergedByteEnd <= bytes passes", () => {
    const m = baseManifest({
      levels: [
        { size: "full", w: 4608, h: 3456, bytes: 2000000, bitsPerSample: 8, contenthash: "abc", tiled: false, convergedByteEnd: 1000000 },
      ],
    });
    expect(() => parsePyramidManifest(m)).not.toThrow();
  });
});

// ── producedBy typing ────────────────────────────────────────────────────────

test("producedBy is parsed with strong types, not any", () => {
  const m = parsePyramidManifest(baseManifest({
    producedBy: { tool: "pyramid-ingest", version: "1.2.3", params: { effort: 7 } },
  }));
  expect(m.producedBy?.tool).toBe("pyramid-ingest");
  expect(m.producedBy?.version).toBe("1.2.3");
  expect(m.producedBy?.params?.["effort"]).toBe(7);
});

// ── v5 contract: OrientationDescriptor + TilingDescriptor + sourceFormat ──────
// The browser/jxl-pyramid reader must accept the SAME schemas (1|2|4|5) as the
// canonical pyramid-ingest parser (finding 72 — no divergent schema-≤2-only reader).

describe("v5 manifest reading", () => {
  function v5Base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schema: 5,
      imageId: "img-v5",
      master: { name: "P1000001.RW2", sourceFormat: "rw2", format: "rw2", mtimeMs: 1717900000000 },
      orientation: { exif: 6, pixels: "baked-upright" },
      width: 5184,
      height: 3888,
      aspect: 5184 / 3888,
      levels: [
        { size: 512, w: 512, h: 384, bytes: 15000, bitsPerSample: 8, contenthash: "abcdef", tiled: false },
        {
          size: "full", w: 5184, h: 3888, bytes: 2400000, bitsPerSample: 8, contenthash: "fedcba",
          tiled: true,
          tiling: { container: "jxtc", version: 1, tileSize: 512, bitsPerSample: 8, offsetBase: "file" },
        },
      ],
      ...overrides,
    };
  }

  test("MANIFEST_SCHEMA_VERSION is 5 (aligned with the canonical contract)", () => {
    expect(MANIFEST_SCHEMA_VERSION).toBe(5);
  });

  test("a v5 manifest with an OrientationDescriptor and TilingDescriptor parses", () => {
    const m = parsePyramidManifest(v5Base());
    expect(m.schema).toBe(5);
    expect(m.orientation).toEqual({ exif: 6, pixels: "baked-upright" });
    expect(m.master.sourceFormat).toBe("rw2");
    const full = m.levels.find((l) => l.size === "full")!;
    expect(full.tiling).toEqual({ container: "jxtc", version: 1, tileSize: 512, bitsPerSample: 8, offsetBase: "file" });
  });

  test("v5 orientation exif out of range (9) throws for its specific reason", () => {
    expectValidationError(() => parsePyramidManifest(v5Base({ orientation: { exif: 9, pixels: "baked-upright" } })), "orientation");
  });

  test("v5 tiled level missing its TilingDescriptor throws for its specific reason", () => {
    const bad = v5Base();
    (bad.levels as any)[1] = { size: "full", w: 5184, h: 3888, bytes: 2400000, bitsPerSample: 8, contenthash: "fedcba", tiled: true };
    expectValidationError(() => parsePyramidManifest(bad), "tiling");
  });

  test("schema 3 (skipped) is rejected", () => {
    expectValidationError(() => parsePyramidManifest(v5Base({ schema: 3 })), "schema");
  });

  test("schema 4 with a v4 tiling grid still parses (back-compat)", () => {
    const m = parsePyramidManifest(baseManifest({
      schema: 4,
      levels: [
        { size: "full", w: 4608, h: 3456, bytes: 2000000, bitsPerSample: 8, contenthash: "abc", tiled: true, tiling: { tileSize: 256, cols: 18, rows: 14 } },
      ],
    }));
    expect(m.schema).toBe(4);
    expect(m.levels[0].tiling).toEqual({ tileSize: 256, cols: 18, rows: 14 });
  });

  // I-2 (finding 64): sourceFormat is decoupled from the closed decoder-capability `format` set.
  // The browser reader must accept ANY non-empty sourceFormat (e.g. a "cr3" the decoder cannot
  // handle) so provenance survives, matching the canonical ingest parser (no cross-parser divergence).
  test("I-2: an out-of-enum master.sourceFormat (cr3) is accepted", () => {
    const m = parsePyramidManifest(v5Base({
      master: { name: "IMG.CR3", sourceFormat: "cr3", format: "unknown", mtimeMs: 1717900000000 },
    }));
    expect(m.master.sourceFormat).toBe("cr3");
    expect(m.master.format).toBe("unknown");
  });
});

// ── GalleryIndex ─────────────────────────────────────────────────────────────

describe("parseGalleryIndex", () => {
  function baseIndex(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schema: 1,
      images: [
        { imageId: "img-001", aspect: 1.333, l0: { contenthash: "abc", w: 256, h: 192 } },
      ],
      ...overrides,
    };
  }

  test("valid index parses", () => {
    const idx = parseGalleryIndex(baseIndex());
    expect(idx.schema).toBe(1);
    expect(idx.images).toHaveLength(1);
    expect(idx.images[0].imageId).toBe("img-001");
  });

  test("wrong schema throws", () => {
    expectValidationError(() => parseGalleryIndex(baseIndex({ schema: 2 })), "schema");
  });

  test("missing imageId throws", () => {
    const idx = baseIndex({ images: [{ aspect: 1.0, l0: { contenthash: "x", w: 1, h: 1 } }] });
    expectValidationError(() => parseGalleryIndex(idx), "imageId");
  });

  test("empty contenthash in l0 throws", () => {
    const idx = baseIndex({ images: [{ imageId: "x", aspect: 1.0, l0: { contenthash: "", w: 1, h: 1 } }] });
    expectValidationError(() => parseGalleryIndex(idx), "contenthash");
  });

  test("optional thumbhash and group are preserved", () => {
    const idx = parseGalleryIndex(baseIndex({
      images: [{ imageId: "x", aspect: 1.0, l0: { contenthash: "abc", w: 1, h: 1 }, thumbhash: "th123", group: "g1" }],
    }));
    expect(idx.images[0].thumbhash).toBe("th123");
    expect(idx.images[0].group).toBe("g1");
  });

  test("optional next pagination cursor preserved", () => {
    const idx = parseGalleryIndex(baseIndex({ next: "page2-token" }));
    expect(idx.next).toBe("page2-token");
  });
});
