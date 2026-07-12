import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanCatalog, relinkReport } from "../src/relink";
import { catalogIdForContent } from "../src/source-identity";
import { imageIdForPath } from "../src/hash";

async function tmpOut(): Promise<string> {
  const out = await mkdtemp(join(tmpdir(), "relink-"));
  await mkdir(join(out, "images"), { recursive: true });
  return out;
}

/** Write a minimal-but-valid v5 manifest carrying an imageId + catalogId under out/images/<imageId>/. */
async function writeManifest(out: string, imageId: string, catalogId: string | undefined, name = "m.orf"): Promise<void> {
  const dir = join(out, "images", imageId);
  await mkdir(dir, { recursive: true });
  const man: any = {
    schema: 5,
    imageId,
    ...(catalogId ? { catalogId } : {}),
    master: { name, format: "orf", mtimeMs: 1000 },
    orientation: { exif: 1, pixels: "baked-upright" },
    width: 10,
    height: 10,
    aspect: 1,
    levels: [{ size: "full", w: 10, h: 10, bytes: 4, bitsPerSample: 8, contenthash: "e".repeat(16), tiled: false }],
    producedBy: { tool: "pyramid-ingest", version: "0.1.0", encoder: { effort: 3, quality: { grid: 85, big: 95, proxy: 85 } } },
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(man, null, 2));
}

test("scanCatalog collects catalogId per imageId and flags duplicate catalogIds", async () => {
  const out = await tmpOut();
  await writeManifest(out, "a".repeat(16), "1111111111111111");
  await writeManifest(out, "b".repeat(16), "2222222222222222");
  // legacy manifest with no catalogId contributes an entry but no known-identity
  await writeManifest(out, "c".repeat(16), undefined);
  // two imageIds sharing ONE catalogId -> duplicate (a catalog anomaly)
  await writeManifest(out, "d".repeat(16), "3333333333333333");
  await writeManifest(out, "e".repeat(16), "3333333333333333");

  const scan = await scanCatalog(out);
  expect(scan.entries).toHaveLength(5);
  expect(scan.known).toHaveLength(4); // legacy one excluded
  expect(scan.duplicateCatalogIds).toHaveLength(1);
  expect(scan.duplicateCatalogIds[0]!.catalogId).toBe("3333333333333333");
  expect(scan.duplicateCatalogIds[0]!.imageIds.sort()).toEqual(["d".repeat(16), "e".repeat(16)]);
});

test("relinkReport: unchanged when content is catalogued at the SAME path", async () => {
  const out = await tmpOut();
  const master = join(out, "photo.orf");
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  await writeFile(master, bytes);
  const catalogId = catalogIdForContent(bytes);
  const imageId = await imageIdForPath(master);
  await writeManifest(out, imageId, catalogId);

  const rep = await relinkReport(out, [master]);
  expect(rep.summary).toMatchObject({ unchanged: 1, relink: 0, new: 0, conflict: 0 });
  expect(rep.rows[0]!.kind).toBe("unchanged");
});

test("relinkReport: relink when SAME content is catalogued at a different (old) path", async () => {
  const out = await tmpOut();
  const oldMaster = join(out, "old", "photo.orf");
  const newMaster = join(out, "new", "photo.orf");
  await mkdir(join(out, "new"), { recursive: true });
  const bytes = new Uint8Array([7, 7, 7, 7, 7]);
  // catalogued under the OLD path's imageId; the file now lives at the NEW path.
  const oldImageId = await imageIdForPath(oldMaster);
  const catalogId = catalogIdForContent(bytes);
  await writeManifest(out, oldImageId, catalogId);
  await writeFile(newMaster, bytes);

  const rep = await relinkReport(out, [newMaster]);
  expect(rep.summary).toMatchObject({ relink: 1, unchanged: 0, new: 0, conflict: 0 });
  const row = rep.rows[0]! as any;
  expect(row.kind).toBe("relink");
  expect(row.fromImageId).toBe(oldImageId);
  expect(row.toImageId).toBe(await imageIdForPath(newMaster));
  expect(row.catalogId).toBe(catalogId);
});

test("relinkReport: new when content is not in the catalog", async () => {
  const out = await tmpOut();
  const master = join(out, "brand-new.orf");
  await writeFile(master, new Uint8Array([9, 8, 7]));
  await writeManifest(out, "f".repeat(16), "abababababababab"); // unrelated catalog entry
  const rep = await relinkReport(out, [master]);
  expect(rep.summary).toMatchObject({ new: 1, relink: 0, unchanged: 0, conflict: 0 });
});

test("relinkReport: conflict (content at >1 location) is refused, never merged", async () => {
  const out = await tmpOut();
  const master = join(out, "dupe.orf");
  const bytes = new Uint8Array([3, 3, 3, 3]);
  await writeFile(master, bytes);
  const catalogId = catalogIdForContent(bytes);
  // The SAME catalogId is already present at TWO distinct imageId directories: a relink would have to
  // merge them. The report must flag a conflict and NOT pick one arbitrarily.
  await writeManifest(out, "1".repeat(16), catalogId);
  await writeManifest(out, "2".repeat(16), catalogId);

  const rep = await relinkReport(out, [master]);
  expect(rep.summary.conflict).toBe(1);
  const row = rep.rows[0]! as any;
  expect(row.kind).toBe("conflict");
  expect(row.knownImageIds.sort()).toEqual(["1".repeat(16), "2".repeat(16)]);
});

test("relinkReport: two files sharing metadata but not content get distinct catalogIds (no false relink)", async () => {
  const out = await tmpOut();
  const bytesA = new Uint8Array(64).fill(1);
  const bytesB = new Uint8Array(64).fill(2); // same length, different content
  const pA = join(out, "a.orf");
  const pB = join(out, "b.orf");
  await writeFile(pA, bytesA);
  await writeFile(pB, bytesB);
  // Catalog A only.
  await writeManifest(out, await imageIdForPath(pA), catalogIdForContent(bytesA));

  // B shares byteLength with A but different content -> must be `new`, never a relink of A.
  const rep = await relinkReport(out, [pB]);
  expect(rep.rows[0]!.kind).toBe("new");
});
