import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseManifest } from "./schema.js";
import { pMapLimit } from "./ingest.js";
import { imageIdForPath } from "./hash.js";
import {
  catalogIdForContent,
  sourceKeyForPath,
  type KnownEntry,
} from "./source-identity.js";

// ─────────────────────────────────────────────────────────────────────────────
// Identity / relink REPORT (finding 66, Task 5).
// ─────────────────────────────────────────────────────────────────────────────
//
// A read-only reconciliation between the on-disk catalog and a set of master files. It answers
// "which of these files are new, unchanged, or MOVED (relink)?" without ever mutating catalog rows.
//
// On disk, an image lives at out/images/<imageId>/manifest.json, where imageId is the PATH-derived key
// (imageIdForPath === sourceKeyForPath — same FNV-1a of the normalized realpath, truncated to 16 hex).
// The persistent identity is manifest.catalogId (content-derived, stable across moves). This module
// keys the catalog on catalogId and reports relinks by (fromSourceKey → toSourceKey); it NEVER merges
// two entries that share a catalogId — that would silently collapse two catalog rows into one. Such a
// collision is surfaced as a `conflict` for the operator to resolve.

/** One catalog entry as scanned from disk. `imageId` is the on-disk directory (also the sourceKey). */
export type CatalogEntry = {
  imageId: string;
  catalogId?: string; // absent on legacy/pre-Task-5 or stub manifests
  masterName?: string;
};

export type CatalogScan = {
  entries: CatalogEntry[];
  /** Known {catalogId, sourceKey} pairs — the input to detectRelink. Only entries with a catalogId. */
  known: KnownEntry[];
  /** catalogIds that appear on MORE THAN ONE imageId directory — a pre-existing duplicate the catalog
   *  should not have. Reported so a relink never has to guess which of several rows to rebind. */
  duplicateCatalogIds: Array<{ catalogId: string; imageIds: string[] }>;
};

/** Scan out/images for every manifest and collect its identity. Read-only; tolerant of unreadable or
 *  legacy manifests (they simply contribute no catalogId). */
export async function scanCatalog(outDir: string): Promise<CatalogScan> {
  const imagesDir = join(outDir, "images");
  const entries: CatalogEntry[] = [];
  let ids: string[] = [];
  try { ids = await readdir(imagesDir); } catch { return { entries, known: [], duplicateCatalogIds: [] }; }

  await pMapLimit(ids, 8, async (id) => {
    const mpath = join(imagesDir, id, "manifest.json");
    const buf = await readFile(mpath).catch(() => null);
    if (buf === null) return;
    try {
      const man = parseManifest(buf) as any;
      entries.push({
        imageId: man.imageId ?? id,
        catalogId: typeof man.catalogId === "string" ? man.catalogId : undefined,
        masterName: man.master?.name,
      });
    } catch {
      // unreadable/invalid manifest → not a known identity; skip (never throws).
    }
  });

  const byCatalog = new Map<string, string[]>();
  const known: KnownEntry[] = [];
  for (const e of entries) {
    if (e.catalogId === undefined) continue;
    known.push({ catalogId: e.catalogId, sourceKey: e.imageId });
    const arr = byCatalog.get(e.catalogId) ?? [];
    arr.push(e.imageId);
    byCatalog.set(e.catalogId, arr);
  }
  const duplicateCatalogIds = [...byCatalog.entries()]
    .filter(([, imageIds]) => imageIds.length > 1)
    .map(([catalogId, imageIds]) => ({ catalogId, imageIds }));

  return { entries, known, duplicateCatalogIds };
}

/** Per-file relink classification. `conflict` means the operation would merge two distinct catalog
 *  rows (the content is already known at more than one location) — never applied automatically. */
export type RelinkRow =
  | { kind: "new"; path: string; catalogId: string; toImageId: string }
  | { kind: "unchanged"; path: string; catalogId: string; toImageId: string }
  | { kind: "relink"; path: string; catalogId: string; fromImageId: string; toImageId: string }
  | { kind: "conflict"; path: string; catalogId: string; toImageId: string; knownImageIds: string[] }
  | { kind: "error"; path: string; error: string };

export type RelinkReport = {
  rows: RelinkRow[];
  summary: { new: number; unchanged: number; relink: number; conflict: number; error: number };
};

const MAX_MASTER_BYTES = 512 * 1024 * 1024;

/**
 * Classify each master path against the scanned catalog. Pure REPORT — reads files, mutates nothing.
 *
 *  - unchanged : content already catalogued at this exact location (imageId).
 *  - relink    : content catalogued at exactly ONE other location → it moved (from → to).
 *  - new       : content not in the catalog.
 *  - conflict  : content catalogued at MORE THAN ONE location → relinking would merge rows; refuse.
 */
export async function relinkReport(outDir: string, masterPaths: readonly string[]): Promise<RelinkReport> {
  const scan = await scanCatalog(outDir);
  // Index known sourceKeys per catalogId so a relink/conflict can be distinguished precisely.
  const locationsByCatalog = new Map<string, string[]>();
  for (const k of scan.known) {
    const arr = locationsByCatalog.get(k.catalogId) ?? [];
    arr.push(k.sourceKey);
    locationsByCatalog.set(k.catalogId, arr);
  }

  const rows: RelinkRow[] = [];
  for (const path of masterPaths) {
    try {
      const s = await stat(path);
      if (s.size > MAX_MASTER_BYTES) throw new Error(`master too large: ${s.size} bytes`);
      const bytes = await readFile(path);
      const catalogId = catalogIdForContent(bytes);
      const toImageId = await sourceKeyForPath(path); // === imageIdForPath(path)
      const known = locationsByCatalog.get(catalogId) ?? [];

      if (known.length === 0) {
        rows.push({ kind: "new", path, catalogId, toImageId });
      } else if (known.includes(toImageId)) {
        rows.push({ kind: "unchanged", path, catalogId, toImageId });
      } else if (known.length === 1) {
        rows.push({ kind: "relink", path, catalogId, fromImageId: known[0]!, toImageId });
      } else {
        // content already at several locations → relinking would collapse catalog rows. Never auto-merge.
        rows.push({ kind: "conflict", path, catalogId, toImageId, knownImageIds: [...known] });
      }
    } catch (e: any) {
      rows.push({ kind: "error", path, error: e?.message ?? String(e) });
    }
  }

  const summary = { new: 0, unchanged: 0, relink: 0, conflict: 0, error: 0 };
  for (const r of rows) summary[r.kind]++;
  return { rows, summary };
}

/** Re-derive the on-disk imageId for a path (exported for callers that reconcile paths → directories). */
export async function imageIdForMaster(path: string): Promise<string> {
  return imageIdForPath(path);
}
