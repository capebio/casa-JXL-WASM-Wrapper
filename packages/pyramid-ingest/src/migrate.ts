import { readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseManifest, makeProducedBy } from "./schema.js";
import { pMapLimit, readFileOrNull } from "./ingest.js";
import { acquireImageWriteLock, type AdvisoryLock } from "./lock.js";

// M1/M2/M4 per plan (unlocked by WU-6 + V3 + locks).
// M1 schema migrate: re-emit with current producedBy + target schema.
// M2 layout: record layout marker in manifests for index/compat.
// Suggestions integrated via validate report.

export interface MigrationReport {
  migrated: number;
  skipped: number; // already at target, no-op, or per-image error
  errors: Array<{ path: string; error: string }>;
}

async function atomicWriteJson(path: string, obj: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2));
  await rename(tmp, path).catch(async (e: any) => {
    if (e && e.code === "EEXIST") {
      await unlink(tmp).catch(() => {});
    } else {
      throw e;
    }
  });
}

/** Shared manifest-migration walk (MIG-4): validate, preserve unknown fields via raw JSON,
 *  per-image write lock (skip on failure — never write unlocked), atomic write, bounded-parallel.
 *  `shouldMigrate`/`transform` operate on the RAW parsed JSON so fields zod would strip survive. */
async function migrateManifests(
  outDir: string,
  shouldMigrate: (raw: any) => boolean,
  transform: (raw: any) => any,
  opts: { dryRun?: boolean },
): Promise<MigrationReport> {
  const imagesDir = join(outDir, "images");
  const report: MigrationReport = { migrated: 0, skipped: 0, errors: [] };

  let ids: string[] = [];
  try { ids = await readdir(imagesDir); } catch { return report; }

  await pMapLimit(ids, 8, async (id) => {
    const mpath = join(imagesDir, id, "manifest.json");
    const txt = await readFileOrNull(mpath);
    if (txt === null) return;

    try {
      const parsed = parseManifest(txt); // validate current manifest (throws on invalid)
      // MIG-2: preserve fields the zod schema would strip. Only JSON manifests can carry extra
      // fields; the binary format encodes only known fields, so the decoded object is complete.
      const raw = txt[0] === 0x7b /* '{' */ ? JSON.parse(new TextDecoder().decode(txt)) : parsed;
      if (!shouldMigrate(raw)) { report.skipped++; return; }

      // MIG-1: per-image write lock; a failure to acquire must NOT fall through to an unlocked write.
      let iLock: AdvisoryLock | null = null;
      if (!opts.dryRun) {
        try {
          iLock = await acquireImageWriteLock(outDir, id);
        } catch (e: any) {
          report.errors.push({ path: mpath, error: `lock: ${e?.message || String(e)}` });
          report.skipped++;
          return;
        }
      }
      try {
        if (!opts.dryRun) await atomicWriteJson(mpath, transform(raw));
        report.migrated++;
      } finally {
        if (iLock) await iLock.release().catch(() => {});
      }
    } catch (e: any) {
      report.errors.push({ path: mpath, error: e?.message || String(e) });
      report.skipped++;
    }
  });

  return report;
}

const SUPPORTED_SCHEMA_TARGETS = [2, 4];

export async function migrateSchema(
  outDir: string,
  targetVersion: number,
  opts: { dryRun?: boolean } = {},
): Promise<MigrationReport> {
  // MIG-3: only known schema literals are valid targets; reject unsupported up front.
  if (!SUPPORTED_SCHEMA_TARGETS.includes(targetVersion)) {
    return {
      migrated: 0,
      skipped: 0,
      errors: [{ path: outDir, error: `unsupported --migrate-schema ${targetVersion} (supported: ${SUPPORTED_SCHEMA_TARGETS.join(", ")})` }],
    };
  }
  return migrateManifests(
    outDir,
    (raw) => (raw.schema ?? 1) < targetVersion,   // MIG-3: upgrade-only; no downgrade, no producedBy churn on no-op
    (raw) => ({ ...raw, schema: targetVersion, producedBy: makeProducedBy() }),
    opts,
  );
}

// M2: wire --migrate-layout sharded-2 (records layout in manifests for index/compat).
export async function migrateLayout(
  outDir: string,
  target: "sharded-2",
  opts: { dryRun?: boolean } = {},
): Promise<MigrationReport> {
  return migrateManifests(
    outDir,
    (raw) => raw.layout !== target,
    (raw) => ({ ...raw, layout: target }),
    opts,
  );
}
