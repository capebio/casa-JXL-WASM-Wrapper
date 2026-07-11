import { readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseManifest, makeProducedBy, CURRENT_MANIFEST_SCHEMA } from "./schema.js";
import { pMapLimit, readFileOrNull } from "./ingest.js";
import { acquireImageWriteLock } from "./lock.js";
// ─────────────────────────────────────────────────────────────────────────────
// Additive v1..v4 → v5 migration (Task 4, findings 61-75).
// ─────────────────────────────────────────────────────────────────────────────
// Operates on the RAW parsed JSON object so unknown fields survive (MIG-2). Additive:
//   - orientation string "baked"|"source" → OrientationDescriptor { exif: 1, pixels }
//     (exif defaults to 1 because no EXIF orientation was recorded pre-v5; a real EXIF
//      value is only known at ingest, never reconstructable from an old manifest).
//   - master.sourceFormat := master.format when absent (finding 64 carry-forward: provenance
//     must not vanish on migrate). Never overwrites an existing sourceFormat.
//   - level.tiling v4 grid { tileSize, cols, rows } → TilingDescriptor
//     { container:"jxtc", version:1, tileSize, bitsPerSample:<level bps>, offsetBase:"file" }.
//   - all other fields (metadata, layout, convergedByteEnd, qualityCurve, unknown extensions)
//     are carried through verbatim.
// Refuses to migrate a FUTURE major schema (> CURRENT_MANIFEST_SCHEMA): never silently
// reinterpret bytes written by a newer tool.
const V5_ORIENTATION_PIXELS = new Set(["source", "baked-upright"]);
/** Pure, filesystem-free additive migration of a raw manifest object to schema 5. */
export function migrateManifestToV5(raw) {
    const from = typeof raw?.schema === "number" ? raw.schema : 1;
    if (from > CURRENT_MANIFEST_SCHEMA) {
        throw new Error(`cannot migrate schema ${from} (newer than current ${CURRENT_MANIFEST_SCHEMA}); refusing to reinterpret`);
    }
    // shallow clone; deep-clone only the sub-objects we rewrite so unknown fields ride along.
    const out = { ...raw, schema: 5 };
    // orientation: map the old string; leave an existing descriptor untouched.
    // M-2: orientation is REQUIRED on v5, so an absent/unrecognised source orientation is defaulted
    // to { exif: 1, pixels: "baked-upright" } (exif 1 = no rotation recorded pre-v5). This guarantees
    // migration always emits a valid OrientationDescriptor, matching the writer and both readers.
    const o = raw.orientation;
    if (typeof o === "string") {
        const pixels = o === "source" ? "source" : "baked-upright";
        out.orientation = { exif: 1, pixels };
    }
    else if (o && typeof o === "object" && typeof o.exif === "number" && V5_ORIENTATION_PIXELS.has(o.pixels)) {
        out.orientation = { ...o };
    }
    else {
        out.orientation = { exif: 1, pixels: "baked-upright" };
    }
    // master.sourceFormat: default from format; never clobber.
    if (raw.master && typeof raw.master === "object") {
        const master = { ...raw.master };
        if (master.sourceFormat === undefined && typeof master.format === "string") {
            master.sourceFormat = master.format;
        }
        out.master = master;
    }
    // levels: upgrade a v4 tiling grid to a v5 TilingDescriptor; preserve everything else.
    if (Array.isArray(raw.levels)) {
        out.levels = raw.levels.map((lv) => {
            if (!lv || typeof lv !== "object")
                return lv;
            const t = lv.tiling;
            const isV4Grid = t && typeof t === "object" && t.container === undefined && typeof t.tileSize === "number";
            if (lv.tiled === true && isV4Grid) {
                return {
                    ...lv,
                    tiling: {
                        container: "jxtc",
                        version: 1,
                        tileSize: t.tileSize,
                        bitsPerSample: lv.bitsPerSample === 16 ? 16 : 8,
                        offsetBase: "file",
                    },
                };
            }
            return { ...lv };
        });
    }
    return out;
}
async function atomicWriteJson(path, obj) {
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(obj, null, 2));
    await rename(tmp, path).catch(async (e) => {
        if (e && e.code === "EEXIST") {
            await unlink(tmp).catch(() => { });
        }
        else {
            throw e;
        }
    });
}
/** Shared manifest-migration walk (MIG-4): validate, preserve unknown fields via raw JSON,
 *  per-image write lock (skip on failure — never write unlocked), atomic write, bounded-parallel.
 *  `shouldMigrate`/`transform` operate on the RAW parsed JSON so fields zod would strip survive. */
async function migrateManifests(outDir, shouldMigrate, transform, opts) {
    const imagesDir = join(outDir, "images");
    const report = { migrated: 0, skipped: 0, errors: [] };
    let ids = [];
    try {
        ids = await readdir(imagesDir);
    }
    catch {
        return report;
    }
    await pMapLimit(ids, 8, async (id) => {
        const mpath = join(imagesDir, id, "manifest.json");
        const txt = await readFileOrNull(mpath);
        if (txt === null)
            return;
        try {
            const parsed = parseManifest(txt); // validate current manifest (throws on invalid)
            // MIG-2: preserve fields the zod schema would strip. Only JSON manifests can carry extra
            // fields; the binary format encodes only known fields, so the decoded object is complete.
            const raw = txt[0] === 0x7b /* '{' */ ? JSON.parse(new TextDecoder().decode(txt)) : parsed;
            if (!shouldMigrate(raw)) {
                report.skipped++;
                return;
            }
            // MIG-1: per-image write lock; a failure to acquire must NOT fall through to an unlocked write.
            let iLock = null;
            if (!opts.dryRun) {
                try {
                    iLock = await acquireImageWriteLock(outDir, id);
                }
                catch (e) {
                    report.errors.push({ path: mpath, error: `lock: ${e?.message || String(e)}` });
                    report.skipped++;
                    return;
                }
            }
            try {
                if (!opts.dryRun)
                    await atomicWriteJson(mpath, transform(raw));
                report.migrated++;
            }
            finally {
                if (iLock)
                    await iLock.release().catch(() => { });
            }
        }
        catch (e) {
            report.errors.push({ path: mpath, error: e?.message || String(e) });
            report.skipped++;
        }
    });
    return report;
}
const SUPPORTED_SCHEMA_TARGETS = [2, 4, 5];
export async function migrateSchema(outDir, targetVersion, opts = {}) {
    // MIG-3: only known schema literals are valid targets; reject unsupported up front.
    if (!SUPPORTED_SCHEMA_TARGETS.includes(targetVersion)) {
        return {
            migrated: 0,
            skipped: 0,
            errors: [{ path: outDir, error: `unsupported --migrate-schema ${targetVersion} (supported: ${SUPPORTED_SCHEMA_TARGETS.join(", ")})` }],
        };
    }
    // Target 5 needs the additive v5 mapping (orientation descriptor, sourceFormat, tiling
    // descriptor). Targets 2/4 keep the historical bump-the-number transform.
    const transform = targetVersion === 5
        ? (raw) => ({ ...migrateManifestToV5(raw), producedBy: makeProducedBy() })
        : (raw) => ({ ...raw, schema: targetVersion, producedBy: makeProducedBy() });
    return migrateManifests(outDir, (raw) => (raw.schema ?? 1) < targetVersion, // MIG-3: upgrade-only; no downgrade, no producedBy churn on no-op
    transform, opts);
}
// M2: wire --migrate-layout sharded-2 (records layout in manifests for index/compat).
export async function migrateLayout(outDir, target, opts = {}) {
    return migrateManifests(outDir, (raw) => raw.layout !== target, (raw) => ({ ...raw, layout: target }), opts);
}
//# sourceMappingURL=migrate.js.map