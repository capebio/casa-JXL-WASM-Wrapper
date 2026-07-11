import { expect, test, describe } from "bun:test";
import {
  levelSize,
  toEntry,
  buildManifest,
  buildIndexEntry,
  isUpToDate,
  type LevelEntry,
} from "../src/manifest";
import {
  parseManifest,
  CURRENT_MANIFEST_SCHEMA,
  manifestToJson,
} from "../src/schema";

test("levelSize reports 'full' only when dims match the master", () => {
  expect(levelSize(4624, 3468, 4624, 3468)).toBe("full");
  expect(levelSize(256, 192, 4624, 3468)).toBe(256);
  expect(levelSize(192, 256, 4624, 3468)).toBe(256);
});

test("toEntry records tiled=true and a v5 TilingDescriptor when the level bytes are a JXTC container", () => {
  const e = toEntry({ data: new Uint8Array(9), width: 10, height: 10, tiled: true, tileSize: 512 }, 10, 10);
  expect(e.tiled).toBe(true);
  expect((e as any).tiling).toEqual({ container: "jxtc", version: 1, tileSize: 512, bitsPerSample: 8, offsetBase: "file" });
});

test("toEntry builds an 8-bit, untiled level entry with a content hash", () => {
  const data = new Uint8Array([9, 8, 7, 6]);
  const e = toEntry({ data, width: 256, height: 192 }, 4624, 3468);
  expect(e.size).toBe(256);
  expect(e.w).toBe(256);
  expect(e.h).toBe(192);
  expect(e.bytes).toBe(4);
  expect(e.bitsPerSample).toBe(8);
  expect(e.tiled).toBe(false);
  expect(e.contenthash).toHaveLength(16);
});

test("toEntry passes qualityCurve through and omits it when empty or absent", () => {
  const curve = [
    { bytes: 1024, ssim: 0.97, butteraugli: 3.2 },
    { bytes: 4096, ssim: 0.9996, butteraugli: 1.05 },
  ];
  const data = new Uint8Array(8192);
  const withCurve = toEntry({ data, width: 2048, height: 1536, tiled: true, convergedByteEnd: 4096, qualityCurve: curve }, 4624, 3468);
  expect(withCurve.qualityCurve).toEqual(curve);
  expect(withCurve.convergedByteEnd).toBe(4096);

  const without = toEntry({ data, width: 2048, height: 1536, tiled: true }, 4624, 3468);
  expect("qualityCurve" in without).toBe(false);

  const empty = toEntry({ data, width: 2048, height: 1536, tiled: true, qualityCurve: [] }, 4624, 3468);
  expect("qualityCurve" in empty).toBe(false);
});

test("manifest schema accepts qualityCurve points and rejects non-positive bytes", () => {
  const level: LevelEntry & { tiling: unknown } = {
    size: 2048, w: 2048, h: 1536, bytes: 8192, bitsPerSample: 8,
    contenthash: "c".repeat(16), tiled: true,
    // v5 requires a TilingDescriptor on tiled levels.
    tiling: { container: "jxtc", version: 1, tileSize: 512, bitsPerSample: 8, offsetBase: "file" },
    qualityCurve: [{ bytes: 1024, butteraugli: 2.5 }, { bytes: 4096, ssim: 0.9996 }],
  };
  const m = buildManifest({
    imageId: "b".repeat(16),
    master: { name: "x.orf", format: "orf", mtimeMs: 1 },
    orientation: "baked", width: 4624, height: 3468, levels: [level],
  });
  const reparsed = parseManifest(JSON.stringify(m));
  expect(reparsed.levels?.[0]?.qualityCurve).toEqual(level.qualityCurve);

  const bad = JSON.parse(JSON.stringify(m));
  bad.levels[0].qualityCurve = [{ bytes: 0, ssim: 0.5 }];
  expect(() => parseManifest(JSON.stringify(bad))).toThrow();
});

test("buildManifest sorts levels ascending by pixel count and rounds aspect to 4dp", () => {
  const big: LevelEntry = { size: "full", w: 4624, h: 3468, bytes: 9, bitsPerSample: 8, contenthash: "f".repeat(16), tiled: false };
  const small: LevelEntry = { size: 256, w: 256, h: 192, bytes: 3, bitsPerSample: 8, contenthash: "a".repeat(16), tiled: false };
  const m = buildManifest({
    imageId: "9f86d081884c7d65",
    master: { name: "P2200566.ORF", format: "orf", mtimeMs: 1717689600000 },
    orientation: "baked",
    width: 4624,
    height: 3468,
    levels: [big, small],
  });
  expect(m.schema).toBe(5);
  expect(m.levels.map((l) => l.size)).toEqual([256, "full"]);
  expect(m.aspect).toBeCloseTo(1.3333, 4);
  expect(m.proxy).toBeUndefined();
  // v5: orientation is an OrientationDescriptor.
  expect((m as any).orientation).toEqual({ exif: 1, pixels: "baked-upright" });
});

test("buildManifest flags proxy and buildIndexEntry inlines L0", () => {
  const small: LevelEntry = { size: 512, w: 512, h: 384, bytes: 3, bitsPerSample: 8, contenthash: "b".repeat(16), tiled: false };
  const proxy = buildManifest({
    imageId: "a".repeat(16), master: { name: "x.jpg", format: "jpg", mtimeMs: 1 },
    orientation: "source", width: 4000, height: 3000, levels: [small], proxy: true,
  });
  expect(proxy.proxy).toBe(true);
  expect((proxy as any).orientation).toEqual({ exif: 1, pixels: "source" });

  const idx = buildIndexEntry(proxy);
  expect(idx.imageId).toBe("a".repeat(16));
  expect(idx.l0).toEqual({ contenthash: "b".repeat(16), w: 512, h: 384 });
});

test("isUpToDate requires matching mtime and proxy flag alignment (non-proxy or proxy)", () => {
  const base = buildManifest({
    imageId: "b".repeat(16), master: { name: "x.orf", format: "orf", mtimeMs: 1000 },
    orientation: "baked", width: 10, height: 10,
    levels: [{ size: "full", w: 10, h: 10, bytes: 1, bitsPerSample: 8, contenthash: "c".repeat(16), tiled: false }],
  });
  expect(isUpToDate(base, 1000)).toBe(true);
  expect(isUpToDate(base, 1000, false)).toBe(true);
  // low-mtime-rounding: exact match (dropped round); 1000.4 no longer matches
  expect(isUpToDate(base, 1000.4)).toBe(false);
  expect(isUpToDate(base, 2000)).toBe(false);
  expect(isUpToDate({ ...base, proxy: true }, 1000)).toBe(false);
  // P7: proxy request matches proxy manifest
  const pxy = { ...base, proxy: true as const };
  expect(isUpToDate(pxy, 1000, true)).toBe(true);
  expect(isUpToDate(pxy, 1000, false)).toBe(false);
});

test("buildManifest produces producedBy and manifestSchemaV1 roundtrips it", () => {
  const m = buildManifest({
    imageId: "9f86d081884c7d65",
    master: { name: "P2200566.ORF", format: "orf", mtimeMs: 1717689600000 },
    orientation: "baked",
    width: 4624,
    height: 3468,
    levels: [{ size: "full", w: 4624, h: 3468, bytes: 9, bitsPerSample: 8, contenthash: "f".repeat(16), tiled: false }],
  });
  expect(m.producedBy?.tool).toBe("pyramid-ingest");
  expect(m.producedBy?.version).toBe("0.1.0");
  expect(m.producedBy?.encoder.effort).toBe(3);
  const reparsed = parseManifest(JSON.stringify(m));
  expect(reparsed.producedBy).toEqual(m.producedBy);
});

test("manifestSchemaV1 / parseManifest rejects bad numeric aspect (div0, NaN, non-positive, Inf)", () => {
  const base = buildManifest({
    imageId: "9f86d081884c7d65",
    master: { name: "t.orf", format: "orf", mtimeMs: 1 },
    orientation: "baked", width: 10, height: 10,
    levels: [{ size: "full", w: 10, h: 10, bytes: 1, bitsPerSample: 8, contenthash: "a".repeat(16), tiled: false }],
  });
  const bads = [
    { ...base, aspect: 0 },
    { ...base, aspect: -1 },
    { ...base, aspect: NaN },
    { ...base, aspect: Infinity },
  ];
  for (const b of bads) {
    expect(() => parseManifest(JSON.stringify(b))).toThrow();
  }
});

test("manifestSchemaV1 / parseManifest rejects non-hex imageId", () => {
  const base = buildManifest({
    imageId: "9f86d081884c7d65",
    master: { name: "t.orf", format: "orf", mtimeMs: 1 },
    orientation: "baked", width: 10, height: 10,
    levels: [{ size: "full", w: 10, h: 10, bytes: 1, bitsPerSample: 8, contenthash: "a".repeat(16), tiled: false }],
  });
  expect(() => parseManifest(JSON.stringify({ ...base, imageId: "zzzzzzzzzzzzzzzz" }))).toThrow();
  expect(() => parseManifest(JSON.stringify({ ...base, imageId: "short" }))).toThrow();
});

test("parseManifest (B10) rejects unknown major producedBy version cleanly", () => {
  const base = buildManifest({
    imageId: "9f86d081884c7d65",
    master: { name: "t.orf", format: "orf", mtimeMs: 1 },
    orientation: "baked", width: 10, height: 10,
    levels: [{ size: "full", w: 10, h: 10, bytes: 1, bitsPerSample: 8, contenthash: "a".repeat(16), tiled: false }],
  });
  const bad = {
    ...base,
    producedBy: { ...base.producedBy!, version: "999.0.0" },
  };
  expect(() => parseManifest(JSON.stringify(bad))).toThrow();
});

// ── v5 additive schema: one lossless contract (Task 4, findings 61-75) ────────

describe("v5 manifest schema (OrientationDescriptor + TilingDescriptor + sourceFormat)", () => {
  // Maximum legal geometry (libjxl JXTC cap 1<<24) with an exact EXIF orientation,
  // format provenance, metadata, a tiled level carrying a TilingDescriptor, and an
  // UNKNOWN extension field. This is the canonical lossless round-trip fixture.
  function v5Manifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schema: 5,
      imageId: "deadbeefcafef00d",
      master: {
        name: "P1000001.RW2",
        sourceFormat: "rw2",
        format: "rw2",
        mtimeMs: 1717900000000,
      },
      orientation: { exif: 6, pixels: "baked-upright" },
      width: 16777215,
      height: 16777215,
      aspect: 1,
      layout: "sharded-2",
      metadata: { gps: { lat: 1.23, lon: 4.56 }, camera: "GX9" },
      levels: [
        { size: 512, w: 512, h: 384, bytes: 15000, bitsPerSample: 8, contenthash: "abcdef0123456789", tiled: false },
        {
          size: "full",
          w: 16777215,
          h: 16777215,
          bytes: 2400000,
          bitsPerSample: 16,
          contenthash: "fedcba9876543210",
          tiled: true,
          tiling: { container: "jxtc", version: 1, tileSize: 512, bitsPerSample: 16, offsetBase: "file" },
        },
      ],
      producedBy: {
        tool: "pyramid-ingest",
        version: "0.1.0",
        encoder: { effort: 3, quality: { grid: 85, big: 95, proxy: 85 } },
      },
      ...extra,
    };
  }

  test("CURRENT_MANIFEST_SCHEMA is 5", () => {
    expect(CURRENT_MANIFEST_SCHEMA).toBe(5);
  });

  test("parses a v5 manifest with OrientationDescriptor and TilingDescriptor", () => {
    const m = parseManifest(JSON.stringify(v5Manifest())) as any;
    expect(m.schema).toBe(5);
    expect(m.orientation).toEqual({ exif: 6, pixels: "baked-upright" });
    expect(m.master.sourceFormat).toBe("rw2");
    const full = m.levels.find((l: any) => l.size === "full");
    expect(full.tiling).toEqual({ container: "jxtc", version: 1, tileSize: 512, bitsPerSample: 16, offsetBase: "file" });
  });

  test("accepts every legal EXIF orientation 1..8 and rejects 0 and 9", () => {
    for (let exif = 1; exif <= 8; exif++) {
      const m = parseManifest(JSON.stringify(v5Manifest({ orientation: { exif, pixels: "source" } }))) as any;
      expect(m.orientation.exif).toBe(exif);
    }
    expect(() => parseManifest(JSON.stringify(v5Manifest({ orientation: { exif: 0, pixels: "source" } })))).toThrow();
    expect(() => parseManifest(JSON.stringify(v5Manifest({ orientation: { exif: 9, pixels: "source" } })))).toThrow();
  });

  test("round-trips geometry, metadata, layout, stub, tiling, and an UNKNOWN extension field losslessly through JSON", () => {
    const src = v5Manifest({ stub: true, futureField: { nested: [1, 2, 3] }, anotherUnknown: "keep-me" });
    const parsed = parseManifest(JSON.stringify(src)) as any;
    const json = manifestToJson(parsed);
    const round = JSON.parse(json);
    // Known fields preserved.
    expect(round.orientation).toEqual({ exif: 6, pixels: "baked-upright" });
    expect(round.master.sourceFormat).toBe("rw2");
    expect(round.layout).toBe("sharded-2");
    expect(round.metadata).toEqual({ gps: { lat: 1.23, lon: 4.56 }, camera: "GX9" });
    expect(round.stub).toBe(true);
    expect(round.width).toBe(16777215);
    expect(round.levels[1].tiling).toEqual({ container: "jxtc", version: 1, tileSize: 512, bitsPerSample: 16, offsetBase: "file" });
    // UNKNOWN extension fields must survive the round trip (finding: never drop unknown fields).
    expect(round.futureField).toEqual({ nested: [1, 2, 3] });
    expect(round.anotherUnknown).toBe("keep-me");
  });

  test("rejects a FUTURE major schema (6) rather than silently reinterpreting bytes", () => {
    expect(() => parseManifest(JSON.stringify(v5Manifest({ schema: 6 })))).toThrow();
  });

  test("rejects skipped schema 3 as unsupported", () => {
    expect(() => parseManifest(JSON.stringify(v5Manifest({ schema: 3 })))).toThrow();
  });

  test("rejects a v5 tiled level that lacks its TilingDescriptor", () => {
    const bad = v5Manifest();
    (bad.levels as any)[1] = { size: "full", w: 5184, h: 3888, bytes: 2400000, bitsPerSample: 8, contenthash: "fedcba9876543210", tiled: true };
    let thrown: unknown;
    try { parseManifest(JSON.stringify(bad)); } catch (e) { thrown = e; }
    expect(thrown).toBeDefined();
    // Must fail for the SPECIFIC reason (tiling missing), not a generic union error.
    expect(String((thrown as Error).message)).toMatch(/tiling/i);
  });

  test("rejects a v5 orientation with exif out of range for its SPECIFIC reason", () => {
    let thrown: unknown;
    try { parseManifest(JSON.stringify(v5Manifest({ orientation: { exif: 9, pixels: "baked-upright" } }))); } catch (e) { thrown = e; }
    expect(thrown).toBeDefined();
    expect(String((thrown as Error).message)).toMatch(/exif|orientation/i);
  });
});