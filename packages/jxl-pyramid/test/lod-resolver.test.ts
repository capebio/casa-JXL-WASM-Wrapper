import { expect, test, describe } from "bun:test";
import { resolveLod, LodResolveError } from "../src/lod-resolver.js";
import type { PyramidManifest, PyramidLevel } from "../src/manifest.js";
import type { LodRequest, DecodeCapabilities } from "../src/runtime.js";

// ---------------------------------------------------------------------------
// Fixtures — a manifest with a thumb, a mid level, a full whole level, and a
// tiled (JXTC) full level; plus a quality-curve carrying level.
// ---------------------------------------------------------------------------

const RANGE_OK: DecodeCapabilities = { workers: true, sharedMemory: true, rangeRequests: true, rgba16: true };
const RANGE_OFF: DecodeCapabilities = { workers: true, sharedMemory: true, rangeRequests: false, rgba16: true };

function lvl(over: Partial<PyramidLevel> & Pick<PyramidLevel, "w" | "h" | "bytes" | "contenthash">): PyramidLevel {
  return {
    size: Math.max(over.w, over.h),
    bitsPerSample: 8,
    tiled: false,
    ...over,
  } as PyramidLevel;
}

function manifest(levels: PyramidLevel[], over: Partial<PyramidManifest> = {}): PyramidManifest {
  const maxW = Math.max(...levels.map((l) => l.w));
  const maxH = Math.max(...levels.map((l) => l.h));
  return {
    schema: 2,
    imageId: "img-1",
    master: { name: "x.orf", format: "orf", mtimeMs: 1 },
    orientation: "baked",
    width: maxW,
    height: maxH,
    aspect: maxW / maxH,
    levels,
    ...over,
  };
}

const THUMB = lvl({ size: 256, w: 256, h: 192, bytes: 4000, contenthash: "thumb0000000000" });
const MID = lvl({ size: 1024, w: 1024, h: 768, bytes: 60000, contenthash: "mid00000000000000" });
const FULL = lvl({ size: "full", w: 4000, h: 3000, bytes: 900000, contenthash: "full0000000000000" });

const WHOLE_MANIFEST = manifest([THUMB, MID, FULL]);

describe("resolveLod — resolution axis (whole-level)", () => {
  test("grid thumb: small target picks the smallest level whole", () => {
    const req: LodRequest = { targetLongEdge: 200, dpr: 1 };
    const r = resolveLod(WHOLE_MANIFEST, req, RANGE_OK);
    expect(r.kind).toBe("whole-level");
    expect(r.contenthash).toBe(THUMB.contenthash);
    expect(r.width).toBe(256);
    expect(r.height).toBe(192);
    if (r.kind === "whole-level") {
      expect(r.bytes).toBe(4000);
      expect(r.range).toEqual({ start: 0, end: 4000 });
    }
  });

  test("viewer: mid target picks smallest level whose long edge >= target", () => {
    const req: LodRequest = { targetLongEdge: 600, dpr: 1 };
    const r = resolveLod(WHOLE_MANIFEST, req, RANGE_OK);
    expect(r.kind).toBe("whole-level");
    expect(r.contenthash).toBe(MID.contenthash);
  });

  test("dpr multiplies the effective target long edge", () => {
    // targetLongEdge 300 * dpr 2 = 600 effective -> MID (long 1024 >= 600), not THUMB.
    const r = resolveLod(WHOLE_MANIFEST, { targetLongEdge: 300, dpr: 2 }, RANGE_OK);
    expect(r.contenthash).toBe(MID.contenthash);
  });

  test("final export / oversized target picks the largest level", () => {
    const r = resolveLod(WHOLE_MANIFEST, { targetLongEdge: 99999, dpr: 1 }, RANGE_OK);
    expect(r.kind).toBe("whole-level");
    expect(r.contenthash).toBe(FULL.contenthash);
  });
});

describe("resolveLod — region axis (jxtc-ranges)", () => {
  // A tiled full level: 4000x3000, tileSize 512 -> tilesX=8, tilesY=6.
  const TILED_FULL = lvl({
    size: "full", w: 4000, h: 3000, bytes: 900000, contenthash: "tiledfull00000000",
    tiled: true,
    tiling: { container: "jxtc", version: 1, tileSize: 512, bitsPerSample: 8, offsetBase: "file" },
  });
  // Provide the JXTC tile index for the tiled level (absolute file offsets + lengths).
  // 8x6 = 48 tiles. Header 32 + index 48*8=384 => data starts at 416.
  const tilesX = 8, tilesY = 6, numTiles = tilesX * tilesY;
  const offsets = new Uint32Array(numTiles);
  const lengths = new Uint32Array(numTiles);
  let cursor = 416;
  for (let i = 0; i < numTiles; i++) {
    lengths[i] = 100 + i; // distinct
    offsets[i] = cursor;
    cursor += lengths[i]!;
  }
  const TILED_MANIFEST = manifest([THUMB, MID, TILED_FULL]);
  const tileIndexByHash = { [TILED_FULL.contenthash]: { offsets, lengths, tileSize: 512, tilesX, tilesY, imageW: 4000, imageH: 3000 } };

  test("zoomed ROI on a tiled level yields the overlapping tile byte ranges", () => {
    // Region (600,600,300,300) overlaps tiles tx=1..1, ty=1..1 -> tile (1,1) => idx 1*8+1=9.
    const req: LodRequest = { targetLongEdge: 4000, dpr: 1, region: { x: 600, y: 600, width: 300, height: 300 } };
    const r = resolveLod(TILED_MANIFEST, req, RANGE_OK, { tileIndex: tileIndexByHash });
    expect(r.kind).toBe("jxtc-ranges");
    if (r.kind === "jxtc-ranges") {
      expect(r.contenthash).toBe(TILED_FULL.contenthash);
      expect(r.ranges.length).toBe(1);
      const idx = 1 * 8 + 1;
      expect(r.ranges[0]).toEqual({ start: offsets[idx]!, end: offsets[idx]! + lengths[idx]! });
      expect(r.tiles.length).toBe(1);
    }
  });

  test("ROI spanning a tile boundary yields multiple ranges (one per tile)", () => {
    // Region straddling x=512 boundary and y=512 boundary -> 2x2 = 4 tiles.
    const req: LodRequest = { targetLongEdge: 4000, dpr: 1, region: { x: 500, y: 500, width: 40, height: 40 } };
    const r = resolveLod(TILED_MANIFEST, req, RANGE_OK, { tileIndex: tileIndexByHash });
    expect(r.kind).toBe("jxtc-ranges");
    if (r.kind === "jxtc-ranges") {
      expect(r.ranges.length).toBe(4);
    }
  });

  test("region on a tiled level WITHOUT range support falls back to whole level", () => {
    const req: LodRequest = { targetLongEdge: 4000, dpr: 1, region: { x: 600, y: 600, width: 300, height: 300 } };
    const r = resolveLod(TILED_MANIFEST, req, RANGE_OFF, { tileIndex: tileIndexByHash });
    expect(r.kind).toBe("whole-level");
    expect(r.contenthash).toBe(TILED_FULL.contenthash);
  });

  test("region on a NON-tiled level ignores the region and returns whole level", () => {
    const req: LodRequest = { targetLongEdge: 4000, dpr: 1, region: { x: 600, y: 600, width: 300, height: 300 } };
    const r = resolveLod(WHOLE_MANIFEST, req, RANGE_OK);
    expect(r.kind).toBe("whole-level");
    expect(r.contenthash).toBe(FULL.contenthash);
  });
});

describe("resolveLod — quality axis (progressive-prefix)", () => {
  const CURVE_FULL = lvl({
    size: "full", w: 4000, h: 3000, bytes: 900000, contenthash: "curvefull000000",
    convergedByteEnd: 400000,
    qualityCurve: [
      { bytes: 120000, butteraugli: 3.0 },
      { bytes: 300000, butteraugli: 1.5 },
      { bytes: 550000, butteraugli: 1.0 },
    ],
  });
  const CURVE_MANIFEST = manifest([THUMB, MID, CURVE_FULL]);

  test("quality 'preview' fraction picks a byte prefix < full", () => {
    const req: LodRequest = { targetLongEdge: 4000, dpr: 1, quality: "preview" };
    const r = resolveLod(CURVE_MANIFEST, req, RANGE_OK);
    expect(r.kind).toBe("progressive-prefix");
    if (r.kind === "progressive-prefix") {
      expect(r.contenthash).toBe(CURVE_FULL.contenthash);
      expect(r.byteEnd).toBeGreaterThan(0);
      expect(r.byteEnd).toBeLessThan(CURVE_FULL.bytes);
      expect(r.range).toEqual({ start: 0, end: r.byteEnd });
    }
  });

  test("quality 'final' delivers the whole level (no truncation)", () => {
    const req: LodRequest = { targetLongEdge: 4000, dpr: 1, quality: "final" };
    const r = resolveLod(CURVE_MANIFEST, req, RANGE_OK);
    expect(r.kind).toBe("whole-level");
    expect(r.contenthash).toBe(CURVE_FULL.contenthash);
  });

  test("quality prefix without range support falls back to whole level", () => {
    const req: LodRequest = { targetLongEdge: 4000, dpr: 1, quality: "preview" };
    const r = resolveLod(CURVE_MANIFEST, req, RANGE_OFF);
    expect(r.kind).toBe("whole-level");
  });

  test("quality on a level with no curve and no convergedByteEnd falls back to whole", () => {
    const req: LodRequest = { targetLongEdge: 4000, dpr: 1, quality: "preview" };
    const r = resolveLod(WHOLE_MANIFEST, req, RANGE_OK);
    expect(r.kind).toBe("whole-level");
  });
});

describe("resolveLod — prefetch + cache hit", () => {
  test("prefetch (near-ring) resolves the same level as visible for the same target", () => {
    // A prefetch is the SAME resolution demand issued at a lower priority; the resolver is
    // priority-agnostic (priority is a scheduler concern), so it maps to the same level.
    const req: LodRequest = { targetLongEdge: 600, dpr: 1 };
    const a = resolveLod(WHOLE_MANIFEST, req, RANGE_OK);
    const b = resolveLod(WHOLE_MANIFEST, req, RANGE_OK);
    expect(a.contenthash).toBe(b.contenthash);
    expect(a.kind).toBe("whole-level");
  });

  test("cache hit: repeated identical requests are deterministic (same kind, level, ranges)", () => {
    const req: LodRequest = { targetLongEdge: 200, dpr: 1 };
    const first = resolveLod(WHOLE_MANIFEST, req, RANGE_OK);
    const second = resolveLod(WHOLE_MANIFEST, req, RANGE_OK);
    expect(second).toEqual(first);
  });
});

describe("resolveLod — precedence", () => {
  const TILED_CURVE = lvl({
    size: "full", w: 4000, h: 3000, bytes: 900000, contenthash: "tiledcurve00000",
    tiled: true,
    tiling: { container: "jxtc", version: 1, tileSize: 512, bitsPerSample: 8, offsetBase: "file" },
  });
  const M = manifest([THUMB, MID, TILED_CURVE]);
  const idx = (() => {
    const tilesX = 8, tilesY = 6, n = tilesX * tilesY;
    const offsets = new Uint32Array(n), lengths = new Uint32Array(n);
    let c = 416; for (let i = 0; i < n; i++) { lengths[i] = 100; offsets[i] = c; c += 100; }
    return { [TILED_CURVE.contenthash]: { offsets, lengths, tileSize: 512, tilesX, tilesY, imageW: 4000, imageH: 3000 } };
  })();

  test("region wins over quality when both set on a tiled range-capable asset", () => {
    const req: LodRequest = { targetLongEdge: 4000, dpr: 1, region: { x: 10, y: 10, width: 20, height: 20 }, quality: "preview" };
    const r = resolveLod(M, req, RANGE_OK, { tileIndex: idx });
    expect(r.kind).toBe("jxtc-ranges");
  });
});

describe("resolveLod — errors", () => {
  test("empty levels throws LodResolveError", () => {
    const m = manifest([THUMB]);
    (m as any).levels = [];
    expect(() => resolveLod(m, { targetLongEdge: 100, dpr: 1 }, RANGE_OK)).toThrow(LodResolveError);
  });

  test("invalid target throws", () => {
    expect(() => resolveLod(WHOLE_MANIFEST, { targetLongEdge: 0, dpr: 1 }, RANGE_OK)).toThrow(LodResolveError);
    expect(() => resolveLod(WHOLE_MANIFEST, { targetLongEdge: NaN, dpr: 1 }, RANGE_OK)).toThrow(LodResolveError);
  });
});
