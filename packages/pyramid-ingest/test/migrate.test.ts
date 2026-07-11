import { expect, test, describe } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateManifestToV5, migrateSchema } from "../src/migrate";
import { parseManifest } from "../src/schema";

// ── Pure additive v1..v4 → v5 migration mapping (Task 4, findings 61-75) ──────

describe("migrateManifestToV5 (additive, unknown-preserving)", () => {
  const v1 = {
    schema: 1,
    imageId: "9f86d081884c7d65",
    master: { name: "P2200566.ORF", format: "orf", mtimeMs: 1717689600000 },
    orientation: "baked",
    width: 4624,
    height: 3468,
    aspect: 1.3333,
    levels: [
      { size: 256, w: 256, h: 192, bytes: 5123, bitsPerSample: 8, contenthash: "a1b2c3d4e5f60718", tiled: false },
      { size: "full", w: 4624, h: 3468, bytes: 812345, bitsPerSample: 8, contenthash: "0011223344556677", tiled: false },
    ],
    producedBy: { tool: "pyramid-ingest", version: "0.1.0", encoder: { effort: 3, quality: { grid: 85, big: 95, proxy: 85 } } },
  };

  test('maps orientation "baked" → { exif: 1, pixels: "baked-upright" }', () => {
    const out = migrateManifestToV5(v1);
    expect(out.schema).toBe(5);
    expect(out.orientation).toEqual({ exif: 1, pixels: "baked-upright" });
  });

  test('maps orientation "source" → { exif: 1, pixels: "source" }', () => {
    const out = migrateManifestToV5({ ...v1, orientation: "source" });
    expect(out.orientation).toEqual({ exif: 1, pixels: "source" });
  });

  test("adds master.sourceFormat from master.format so provenance-decoupling does not vanish", () => {
    const out = migrateManifestToV5(v1);
    expect(out.master.sourceFormat).toBe("orf");
    expect(out.master.format).toBe("orf");
  });

  test("does not overwrite an existing master.sourceFormat", () => {
    const out = migrateManifestToV5({ ...v1, master: { ...v1.master, sourceFormat: "dng" } });
    expect(out.master.sourceFormat).toBe("dng");
  });

  test("leaves an already-descriptor orientation untouched (idempotent on v5 input)", () => {
    const v5in = { ...v1, schema: 5, orientation: { exif: 6, pixels: "baked-upright" } };
    const out = migrateManifestToV5(v5in);
    expect(out.orientation).toEqual({ exif: 6, pixels: "baked-upright" });
  });

  test("preserves UNKNOWN top-level and nested fields through migration", () => {
    const withUnknown = { ...v1, futureField: { keep: [1, 2, 3] }, layout: "sharded-2" };
    const out = migrateManifestToV5(withUnknown) as any;
    expect(out.futureField).toEqual({ keep: [1, 2, 3] });
    expect(out.layout).toBe("sharded-2");
  });

  test("upgrades a v4 tiling grid to a TilingDescriptor and keeps a tiled level valid", () => {
    const v4 = {
      schema: 4,
      imageId: "aabbccddeeff0011",
      master: { name: "DSC09000.ARW", format: "arw", mtimeMs: 1717800000000 },
      orientation: "source",
      width: 9504,
      height: 6336,
      aspect: 1.5,
      levels: [
        { size: 512, w: 512, h: 341, bytes: 12000, bitsPerSample: 8, contenthash: "5555666677778888", tiled: false },
        {
          size: "full", w: 9504, h: 6336, bytes: 3200000, bitsPerSample: 8, contenthash: "99aabbccddeeff00",
          tiled: true, tiling: { tileSize: 512, cols: 19, rows: 13 },
          convergedByteEnd: 2100000,
          qualityCurve: [{ bytes: 800000, butteraugli: 2.4 }],
        },
      ],
      producedBy: { tool: "pyramid-ingest", version: "0.1.0", encoder: { effort: 3, quality: { grid: 85, big: 95, proxy: 85 } } },
    };
    const out = migrateManifestToV5(v4) as any;
    const full = out.levels.find((l: any) => l.size === "full");
    expect(full.tiling).toEqual({ container: "jxtc", version: 1, tileSize: 512, bitsPerSample: 8, offsetBase: "file" });
    // convergedByteEnd + qualityCurve preserved.
    expect(full.convergedByteEnd).toBe(2100000);
    expect(full.qualityCurve).toEqual([{ bytes: 800000, butteraugli: 2.4 }]);
  });

  test("the migrated object parses as a valid v5 manifest", () => {
    const out = migrateManifestToV5(v1);
    const parsed = parseManifest(JSON.stringify(out)) as any;
    expect(parsed.schema).toBe(5);
    expect(parsed.orientation).toEqual({ exif: 1, pixels: "baked-upright" });
    expect(parsed.master.sourceFormat).toBe("orf");
  });

  test("refuses to migrate an unsupported FUTURE major schema", () => {
    expect(() => migrateManifestToV5({ ...v1, schema: 6 })).toThrow();
  });
});

describe("migrateSchema (filesystem walk) to schema 5", () => {
  async function seedManifest(obj: any): Promise<string> {
    const out = await mkdtemp(join(tmpdir(), "pyr-migrate-"));
    const dir = join(out, "images", obj.imageId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify(obj, null, 2));
    return out;
  }

  test("migrates an on-disk v1 manifest to v5 additively, preserving an unknown field", async () => {
    const v1 = {
      schema: 1,
      imageId: "9f86d081884c7d65",
      master: { name: "P2200566.ORF", format: "orf", mtimeMs: 1717689600000 },
      orientation: "baked",
      width: 4624,
      height: 3468,
      aspect: 1.3333,
      levels: [{ size: "full", w: 4624, h: 3468, bytes: 812345, bitsPerSample: 8, contenthash: "0011223344556677", tiled: false }],
      producedBy: { tool: "pyramid-ingest", version: "0.1.0", encoder: { effort: 3, quality: { grid: 85, big: 95, proxy: 85 } } },
      futureField: { keepMe: true },
    };
    const out = await seedManifest(v1);
    const rep = await migrateSchema(out, 5, {});
    expect(rep.errors).toEqual([]);
    expect(rep.migrated).toBe(1);

    const written = JSON.parse(await readFile(join(out, "images", v1.imageId, "manifest.json"), "utf8"));
    expect(written.schema).toBe(5);
    expect(written.orientation).toEqual({ exif: 1, pixels: "baked-upright" });
    expect(written.master.sourceFormat).toBe("orf");
    expect(written.futureField).toEqual({ keepMe: true });
    // The written manifest is itself a valid v5 manifest.
    expect(() => parseManifest(JSON.stringify(written))).not.toThrow();
  });

  test("rejects an unsupported schema target", async () => {
    const out = await mkdtemp(join(tmpdir(), "pyr-migrate-bad-"));
    const rep = await migrateSchema(out, 99, {});
    expect(rep.errors.length).toBe(1);
    expect(rep.errors[0]!.error).toMatch(/unsupported/);
  });
});
