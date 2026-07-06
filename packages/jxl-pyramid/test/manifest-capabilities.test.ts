import { expect, test, describe } from "bun:test";
import { parsePyramidManifest, ManifestValidationError } from "../src/manifest-validate.js";

// S6 (additive): pyramid manifests gain optional LodCapabilities on levels + the asset.
// v1/v2 manifests without them parse unchanged (back-compat); manifests with them round-trip.

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

describe("S6 pyramid capabilities (additive)", () => {
  test("manifest without capabilities parses unchanged (back-compat)", () => {
    const m = parsePyramidManifest(baseManifest());
    expect(m.capabilities).toBeUndefined();
    expect(m.levels[0]!.capabilities).toBeUndefined();
  });

  test("asset-level capabilities round-trip", () => {
    const m = parsePyramidManifest(baseManifest({ capabilities: { resolution: true, region: false } }));
    expect(m.capabilities).toEqual({ resolution: true, region: false });
  });

  test("per-level capabilities round-trip", () => {
    const levels = [
      { size: 512, w: 512, h: 384, bytes: 50000, bitsPerSample: 8, contenthash: "aabbcc", tiled: false, capabilities: { region: false } },
      {
        size: "full", w: 4608, h: 3456, bytes: 2000000, bitsPerSample: 8, contenthash: "ddeeff",
        tiled: true, tiling: { tileSize: 512, cols: 9, rows: 7 },
        capabilities: { region: true, quality: true },
      },
    ];
    const m = parsePyramidManifest(baseManifest({ levels }));
    expect(m.levels[0]!.capabilities).toEqual({ region: false });
    expect(m.levels[1]!.capabilities).toEqual({ region: true, quality: true });
  });

  test("schema 1 with capabilities still normalizes to 2 and keeps them", () => {
    const m = parsePyramidManifest(baseManifest({ schema: 1, capabilities: { resolution: true } }));
    expect(m.schema).toBe(2);
    expect(m.capabilities).toEqual({ resolution: true });
  });

  test("non-boolean capability value throws", () => {
    let thrown: unknown;
    try { parsePyramidManifest(baseManifest({ capabilities: { region: "yes" } })); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ManifestValidationError);
    expect((thrown as ManifestValidationError).path).toContain("capabilities.region");
  });
});
