import { access, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { contentHash16, imageIdForPath } from "./hash.js";
import { buildJpgLadder, buildProxyLadder, buildRawLadder } from "./ladder.js";
import { buildIndexEntry, buildManifest, isUpToDate, toEntry, } from "./manifest.js";
import { detectFormatByMagic, makeProducedBy, parseManifest, manifestToJson } from "./schema.js";
function now(b) { return b?.clock?.now?.() ?? Date.now(); }
import { clearCheckpoint, readCheckpoint, writeCheckpoint } from "./checkpoint.js";
import { acquireImageWriteLock } from "./lock.js";
// Extended for WU-5 adversarial: collect + format detect for common raw that may hit Tier 3/5.
const RAW_EXT = {
    ".orf": "orf", ".dng": "dng", ".cr2": "cr2",
    ".nef": "nef", ".arw": "arw", ".raf": "raf", ".rw2": "rw2", ".pef": "pef", ".srw": "srw", ".x3f": "x3f",
};
const MAX_MASTER_BYTES = 512 * 1024 * 1024; // high-master-size-unbounded guard
// low-no-retry-on-ebusy + high-atomic-writes: Windows AV/locker EBUSY retry (3x 50ms).
// Used for tmp writes + renames to guarantee durability without partials on target.
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
async function withEbusyRetry(op, label = "fs-op", attempts = 3, delayMs = 50) {
    let last;
    for (let i = 0; i < attempts; i++) {
        try {
            return await op();
        }
        catch (e) {
            last = e;
            const code = e && (e.code || e.errno);
            if ((code === "EBUSY" || code === "EAGAIN" || code === "EPERM") && i < attempts - 1) {
                await sleep(delayMs);
                continue;
            }
            if (label && e && typeof e.message === "string")
                e.message += ` (${label})`;
            throw e;
        }
    }
    if (last && typeof last.message === "string" && label)
        last.message += ` (${label})`;
    throw last;
}
// atomic tmp writer helper (unique per pid/rand to avoid collision under concurrency).
async function writeFileAtomic(dest, data) {
    const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await withEbusyRetry(() => writeFile(tmp, data), "write-tmp");
    try {
        await withEbusyRetry(() => rename(tmp, dest), "rename-atomic");
    }
    catch (e) {
        if (e && e.code === "EEXIST") {
            // duplicate content-addressed writer won the race (idempotent); safe to drop our tmp
            await unlink(tmp).catch(() => { });
            return;
        }
        await unlink(tmp).catch(() => { });
        throw e;
    }
}
export function formatFromPath(p) {
    const lower = p.toLowerCase();
    const dot = lower.lastIndexOf(".");
    if (dot < 0)
        return null;
    const ext = lower.slice(dot);
    const raw = RAW_EXT[ext];
    if (raw)
        return raw;
    if (ext === ".jpg" || ext === ".jpeg")
        return "jpg";
    return null;
}
export async function fileExists(p) {
    try {
        await access(p);
        return true;
    }
    catch (err) {
        if (err && err.code === "ENOENT")
            return false;
        throw err;
    }
}
/** Read a file as raw bytes, returning null if it does not exist. Collapses the fileExists()+readFile()
 *  double-stat used across the admin commands (cli/validate/migrate/rm) into a single syscall.
 *  Returns bytes (not utf8) so parseManifest/parseGalleryIndex can auto-detect the binary format. */
export async function readFileOrNull(p) {
    try {
        return await readFile(p);
    }
    catch (err) {
        if (err && err.code === "ENOENT")
            return null;
        throw err;
    }
}
// WU-5 Tier3/5 helpers (dynamic exifr to avoid hard dep at load; ratified Q3 use exifr).
// F2: cheap JPEG SOF (FFC0/FFC2) long-edge dim probe. No new deps; ~20 lines.
function getJpegDimensions(bytes) {
    if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
        return null;
    let i = 2;
    while (i + 8 < bytes.length) {
        if (bytes[i] !== 0xff) {
            i++;
            continue;
        }
        const m = bytes[i + 1];
        if (m === 0xc0 || m === 0xc2) {
            // SOF0 / SOF2: skip len(2), precision(1), h(2), w(2)
            const h = (bytes[i + 5] << 8) | bytes[i + 6];
            const w = (bytes[i + 7] << 8) | bytes[i + 8];
            if (w > 0 && h > 0)
                return { w, h };
            return null;
        }
        if (m === 0xda || m === 0xd9)
            break; // SOS / EOI
        if (m === 0xff) {
            i++;
            continue;
        }
        const len = ((bytes[i + 2] << 8) | bytes[i + 3]) + 2;
        i += len;
    }
    return null;
}
// Deduped exifr orientation probe (used by jpg decode path, computeIngestPlan jpg ladder, and embedded Tier3 fallback).
// Returns "baked" only for identity (1); "source" otherwise. Dynamic import keeps exifr optional.
async function probeOrientation(bytes) {
    try {
        const exifrMod = await import("exifr").catch(() => null);
        if (!exifrMod)
            return "source";
        const ex = exifrMod.default || exifrMod;
        const o = await ex.orientation?.(bytes).catch(() => 1);
        return (o === 1 || o == null) ? "baked" : "source";
    }
    catch {
        return "source";
    }
}
async function tryExtractEmbeddedJpeg(bytes) {
    try {
        // dynamic so static module load succeeds even if exifr not yet installed in env
        const exifrMod = await import("exifr").catch(() => null);
        if (!exifrMod)
            return null;
        const exifr = exifrMod.default || exifrMod;
        const cands = [];
        // F1: parse large previews FIRST (JpgFromRaw etc often full-res); thumbnail() last resort.
        const parsed = await exifr.parse?.(bytes, {
            tiff: true,
            ifd1: true,
            pick: ["JpgFromRaw", "JpegFromRaw", "PreviewImage", "Thumbnail"],
            translateKeys: false,
        }).catch(() => null);
        if (parsed) {
            for (const k of ["JpgFromRaw", "JpegFromRaw", "PreviewImage", "Thumbnail"]) {
                let c = parsed[k];
                if (c) {
                    const u8 = c instanceof Uint8Array ? c : new Uint8Array(c);
                    if (u8.length > 4096)
                        cands.push(u8);
                }
            }
        }
        // thumbnail() last
        let t = await exifr.thumbnail?.(bytes);
        if (t) {
            const u8 = t instanceof Uint8Array ? t : new Uint8Array(t);
            if (u8.length > 4096)
                cands.push(u8);
        }
        if (cands.length === 0)
            return null;
        // F1: prefer the *largest* by byte length
        cands.sort((a, b) => b.length - a.length);
        return cands[0];
    }
    catch {
        // exifr absent or corrupt file: fall to Tier5 stub
    }
    return null;
}
async function extractBasicMetadata(bytes, gps = false) {
    try {
        const exifrMod = await import("exifr").catch(() => null);
        if (!exifrMod)
            return {};
        const exifr = exifrMod.default || exifrMod;
        const m = await exifr.parse?.(bytes, { tiff: true, gps: !!gps, xmp: false }).catch(() => null);
        if (!m)
            return {};
        const out = {
            make: m.Make,
            model: m.Model,
            iso: m.ISO,
            exposure: m.ExposureTime,
            fnumber: m.FNumber,
            focal: m.FocalLength,
        };
        const dt = m.DateTimeOriginal || m.CreateDate || m.DateTime;
        if (dt)
            out.datetime = dt;
        if (gps) {
            // exifr gps:true yields normalized .latitude/.longitude or .gps
            const lat = m.latitude ?? (m.gps && m.gps.latitude);
            const lon = m.longitude ?? (m.gps && m.gps.longitude);
            if (lat != null && lon != null)
                out.gps = { latitude: lat, longitude: lon };
            else if (m.gps)
                out.gps = m.gps;
        }
        return out;
    }
    catch {
        return {};
    }
}
function isNativeRawFormat(f) {
    return f === "orf" || f === "dng" || f === "cr2";
}
async function decodeMaster(b, format, bytes) {
    // v1 design boundary (pyramid-gallery-design §8, §11; PyramidAgentHandoff §3, §8):
    // - Full master is decoded into RAM to drive the downscale cascade for grid levels.
    // - Target: masters that fit RAM once (rough ~150-200 MP practical).
    // - Long-edge >~8000 px or >~40 MP → "massive scan": top-level full becomes JXTC tiled container (rgba8 in v1).
    // - True gigapixel source-tiled ingest (streaming decode of master without full buffer) is deferred (Phase 4/5).
    // - No attempt to implement sliding-window / block RAW decode here.
    if (format === "jpg") {
        const fullJxl = await b.jxl.transcodeJpeg(bytes);
        const d = await b.jxl.decodeToRgba8(fullJxl);
        // F6: read EXIF Orientation (1-8); map to "baked" only for identity (upright pixels as-stored).
        // Verification (see verify-f6-orient.mjs): transcode+decodeToRgba8 does NOT bake (lossless JPEG rewrap + stored-layout decode).
        // Pixels for orient!=1 are sideways; "source" signals that. Ladder edit for plumb deferred (Agent 4/L9).
        const orient = await probeOrientation(bytes);
        return { rgba: d.rgba, width: d.width, height: d.height, orientation: orient };
    }
    return b.raw.decode(bytes, format);
}
export async function writeLevelFiles(outDir, levels, masterW, masterH, verifyHash = false, preEntries, existingLevels) {
    const levelsDir = join(outDir, "levels");
    await mkdir(levelsDir, { recursive: true });
    // P5: parallel + index-by-pos (preserve order); optional existing set (one readdir/batch) replaces per-level access
    const outEntries = await Promise.all(levels.map(async (level, i) => {
        const entry = (preEntries && preEntries[i]) ? preEntries[i] : toEntry(level, masterW, masterH);
        const dest = join(levelsDir, `${entry.contenthash}.jxl`);
        let needWrite = true;
        const exists = existingLevels ? existingLevels.has(`${entry.contenthash}.jxl`) : await fileExists(dest);
        if (exists) {
            if (!verifyHash) {
                needWrite = false;
            }
            else {
                const onDisk = await readFile(dest);
                if (contentHash16(onDisk) === entry.contenthash) {
                    needWrite = false;
                }
                // else: bad/truncated; overwrite
            }
        }
        if (needWrite) {
            await writeFileAtomic(dest, level.data);
        }
        return entry;
    }));
    return outEntries;
}
export async function computeIngestPlan(bytes, format, backends, identity, opts, metadata) {
    const b = backends;
    const tel = b.telemetry;
    tel?.stage("compute-plan-start", { imageId: identity.imageId, format, proxy: opts.proxy !== undefined });
    let ladder;
    if (opts.proxy !== undefined) {
        const decoded = await decodeMaster(b, format, bytes);
        tel?.stage("decode-master", { w: decoded.width, h: decoded.height });
        ladder = await buildProxyLadder(b.jxl, decoded.rgba, decoded.width, decoded.height, opts.proxy, decoded.orientation, !!opts.profileConvergence);
    }
    else if (format === "jpg") {
        // F6/L9: jpg decode does not bake EXIF rotation (verified); pass "source" (or real EXIF when plumbed in caller)
        ladder = await buildJpgLadder(b.jxl, bytes, !!opts.profileConvergence, "source", opts.tiling ?? "adaptive");
        if (await probeOrientation(bytes) === "baked") {
            ladder.orientation = "baked";
        }
    }
    else {
        const decoded = await b.raw.decode(bytes, format);
        tel?.stage("decode-master", { w: decoded.width, h: decoded.height });
        ladder = await buildRawLadder(b.jxl, decoded, !!opts.profileConvergence, opts.tiling ?? "adaptive");
    }
    tel?.stage("ladder-built", { levels: ladder.levels.length, w: ladder.width, h: ladder.height });
    const entries = ladder.levels.map((lv) => toEntry(lv, ladder.width, ladder.height));
    const manifest = buildManifest({
        imageId: identity.imageId,
        master: { name: identity.masterName, format, mtimeMs: identity.mtimeMs },
        orientation: ladder.orientation,
        width: ladder.width,
        height: ladder.height,
        levels: entries,
        proxy: opts.proxy !== undefined,
    });
    if (metadata && Object.keys(metadata).length > 0)
        manifest.metadata = metadata;
    tel?.stage("manifest-built", { levels: entries.length });
    return {
        imageId: identity.imageId,
        master: { name: identity.masterName, format, mtimeMs: identity.mtimeMs },
        orientation: ladder.orientation,
        width: ladder.width,
        height: ladder.height,
        levels: ladder.levels,
        entries,
        proxy: opts.proxy !== undefined,
        manifest,
    };
}
export async function applyIngestPlan(plan, backends, opts) {
    const outDir = opts.outDir;
    const imageDir = join(outDir, "images", plan.imageId);
    const manifestPath = join(imageDir, "manifest.json");
    // med-manifesttmp-orphan + B2: clear stale tmp
    await unlink(manifestPath + ".tmp").catch(() => { });
    // write levels (idempotent per contenthash)
    // P5: supply existing set (readdir once per image) to elide per-level access(); staleness ok (idempotent writes)
    const levelsDir = join(outDir, "levels");
    const exFiles = await readdir(levelsDir).catch(() => []);
    const existing = new Set(exFiles.filter((f) => f.endsWith(".jxl")));
    await writeLevelFiles(outDir, plan.levels, plan.width, plan.height, !!opts.verifyHash, plan.entries, existing);
    // write manifest atomically (with EBUSY retry for Windows durability).
    // CANONICAL: JSON on the `.json` path (lossless for the complete schema, unknown fields
    // preserved). The tight binary format is lossy (no v5 descriptors / metadata / unknown fields),
    // so it is no longer written under manifest.json; parseManifest still auto-detects and reads any
    // pre-existing binary manifests for backward compatibility.
    await mkdir(imageDir, { recursive: true });
    const manifestTmp = `${manifestPath}.tmp`;
    try {
        const json = manifestToJson(plan.manifest);
        await withEbusyRetry(() => writeFile(manifestTmp, json), "manifest-tmp");
        await withEbusyRetry(() => rename(manifestTmp, manifestPath), "manifest-rename");
    }
    catch (e) {
        await unlink(manifestTmp).catch(() => { });
        throw e;
    }
    return "written";
}
export async function ingestImage(masterPath, backends, opts) {
    const format = formatFromPath(masterPath);
    const accept = opts.acceptUnsupported !== false; // Q2 default accept-degraded
    // B11: prefer precomputed imageId (passed by batch dispatcher) to avoid duplicate realpath+sha256.
    // B5: support pre-resolved single entry (from job shaping to avoid cloning full statMap per postMessage)
    // idMap extension: lookup by masterPath when provided (avoids per-image hash in hot paths for large batches)
    const anyOpts = opts;
    const imageId = anyOpts.imageId || (anyOpts.idMap && anyOpts.idMap[masterPath]) || await imageIdForPath(masterPath);
    let info;
    if (anyOpts.statEntry) {
        info = anyOpts.statEntry;
    }
    else if (anyOpts.statMap && anyOpts.statMap[masterPath]) {
        info = anyOpts.statMap[masterPath];
    }
    else {
        const s = await stat(masterPath);
        info = { size: s.size, mtimeMs: s.mtimeMs };
    }
    if (info.size > MAX_MASTER_BYTES) {
        throw new Error(`master too large: ${info.size} bytes (>${MAX_MASTER_BYTES})`);
    }
    const imageDir = join(opts.outDir, "images", imageId);
    const manifestPath = join(imageDir, "manifest.json");
    // med-manifesttmp-orphan + B2: clear stale tmp from prior crash before any check/write
    await unlink(manifestPath + ".tmp").catch(() => { });
    if (!opts.force) {
        // ING-5: single read (no fileExists+readFile); a corrupt existing manifest falls through to
        // a clean re-ingest instead of throwing and failing the image.
        // Binary format (−73%) auto-detected by parseManifest; read as binary to support both formats
        try {
            const existing = await readFile(manifestPath).then(buf => parseManifest(buf)).catch(() => null);
            if (existing) {
                const wantProxy = opts.proxy !== undefined;
                // P7: allow proxy manifests to skip on mtime match (previously guarded out); match proxy flag too (no size recorded yet; schema add deferred)
                const uptodate = isUpToDate(existing, info.mtimeMs, wantProxy) || (existing.stub === true && existing.master.mtimeMs === info.mtimeMs);
                if (uptodate)
                    return { outcome: "skipped" };
            }
        }
        catch { /* corrupt/unparseable manifest → re-ingest (overwrite) */ }
    }
    const bytes = await readFile(masterPath); // Buffer satisfies Uint8Array; avoids copy (low-readfile)
    const identity = { imageId, masterName: basename(masterPath), mtimeMs: info.mtimeMs };
    // F4: extract once on master bytes for every ingest (native/jpg/fallback). Cheap vs encode.
    const meta = await extractBasicMetadata(bytes, !opts.stripGps);
    const timeout = opts.timeoutMs;
    let timer;
    const workP = (async () => {
        let plan = null;
        let usedFallback = false;
        const nativeFmt = isNativeRawFormat(format) ? format : null;
        if (nativeFmt) {
            try {
                // Tier 1: native via raw-converter-wasm
                plan = await computeIngestPlan(bytes, nativeFmt, backends, identity, opts, meta);
            }
            catch (err) {
                if (!accept)
                    throw err;
                usedFallback = true;
                plan = await buildFallbackPlan(bytes, format, backends, identity, opts, masterPath, meta);
            }
        }
        else if (format === "jpg") {
            plan = await computeIngestPlan(bytes, "jpg", backends, identity, opts, meta);
        }
        else if (accept) {
            // unknown ext or non-native raw: go straight to Tier3/5 (no native attempt)
            usedFallback = true;
            plan = await buildFallbackPlan(bytes, format, backends, identity, opts, masterPath, meta);
        }
        else {
            throw new Error(`unsupported master format: ${masterPath}`);
        }
        if (opts.dryRun) {
            // F7: bypass apply; caller (CLI) prints plan; return plan under dryRun (P8)
            // Trim heavy level data (the encoded JXL bytes) for memory efficiency on large masters;
            // entries/manifest/sizes/curves remain for explain output.
            if (plan) {
                for (const lv of plan.levels) {
                    lv.data = new Uint8Array(0);
                }
            }
            return { outcome: "written", plan: plan, degraded: usedFallback || undefined };
        }
        await applyIngestPlan(plan, backends, opts);
        const stagedBytes = (plan.levels || []).reduce((s, lv) => s + (lv.stagedBytes || 0), 0);
        // P4: mtimecache deleted (no consumers outside this file; dead RMW race under workers; coordinator epilogue not needed)
        return { outcome: "written", stagedBytes: stagedBytes || undefined, degraded: usedFallback || undefined };
    })();
    try {
        if (timeout && timeout > 0) {
            const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`ingest timeout after ${timeout}ms for ${masterPath}`)), timeout); });
            return await Promise.race([workP, t]);
        }
        else {
            return await workP;
        }
    }
    finally {
        clearTimeout(timer);
        workP.catch(() => { }); // detach loser to avoid unhandled after timeout wins
    }
}
// WU-5: Tier 3 (embedded JPEG via exifr) or Tier 5 (structured stub manifest, no index entry).
async function buildFallbackPlan(bytes, format, backends, identity, opts, pathForTel, metadata) {
    const b = backends;
    const tel = b.telemetry;
    const detected = format || detectFormatByMagic(bytes) || "unknown";
    // Tier 3
    const jpeg = await tryExtractEmbeddedJpeg(bytes);
    if (jpeg && jpeg.length > 0) {
        // F5 event (path threaded from ingestImage)
        tel?.event?.("fallback-tier", { path: pathForTel || "unknown", tier: 3, detected, reason: "embedded-preview" });
        let ladder;
        if (opts.proxy !== undefined) {
            // F3: honor proxy in fallback (native raw failed); decode embedded jpg to rgba then proxy ladder
            const fullJxl = await b.jxl.transcodeJpeg(jpeg);
            const dec = await b.jxl.decodeToRgba8(fullJxl);
            ladder = await buildProxyLadder(b.jxl, dec.rgba, dec.width, dec.height, opts.proxy, "source", !!opts.profileConvergence);
        }
        else {
            ladder = await buildJpgLadder(b.jxl, jpeg, !!opts.profileConvergence, "source", opts.tiling ?? "adaptive");
            // F6 (embedded path): same map as master jpg; ladder override (deferred full plumb)
            if (await probeOrientation(jpeg) === "baked") {
                ladder.orientation = "baked";
            }
        }
        // F2: min-dim gate; if long <1024 mark degraded (proceed; small preview passed 4kB gate)
        const dims = getJpegDimensions(jpeg);
        const longEdge = dims ? Math.max(dims.w, dims.h) : 0;
        const meta = { ...(metadata || {}) };
        if (longEdge > 0 && longEdge < 1024)
            meta.degraded = true;
        const entries = ladder.levels.map((lv) => toEntry(lv, ladder.width, ladder.height));
        const manifest = buildManifest({
            imageId: identity.imageId,
            master: { name: identity.masterName, format: detected, mtimeMs: identity.mtimeMs },
            orientation: ladder.orientation,
            width: ladder.width,
            height: ladder.height,
            levels: entries,
            proxy: opts.proxy !== undefined,
        });
        if (Object.keys(meta).length > 0)
            manifest.metadata = meta;
        return {
            imageId: identity.imageId,
            master: { name: identity.masterName, format: detected, mtimeMs: identity.mtimeMs },
            orientation: ladder.orientation,
            width: ladder.width,
            height: ladder.height,
            levels: ladder.levels,
            entries,
            proxy: opts.proxy !== undefined,
            manifest,
        };
    }
    // Tier 5
    tel?.event?.("fallback-tier", { path: pathForTel || "unknown", tier: 5, detected, reason: "no-usable-preview" });
    const meta = metadata && Object.keys(metadata).length ? metadata : await extractBasicMetadata(bytes, !opts.stripGps);
    const stubBase = {
        schema: 1,
        imageId: identity.imageId,
        master: { name: identity.masterName, format: detected, mtimeMs: identity.mtimeMs },
        orientation: "source",
        width: 1,
        height: 1,
        aspect: 1,
        levels: [],
        stub: true,
        metadata: Object.keys(meta).length ? meta : undefined,
        producedBy: makeProducedBy(),
    };
    const manifest = parseManifest(JSON.stringify(stubBase));
    return {
        imageId: identity.imageId,
        master: { name: identity.masterName, format: detected, mtimeMs: identity.mtimeMs },
        orientation: "source",
        width: 1,
        height: 1,
        levels: [],
        entries: [],
        proxy: false,
        manifest,
    };
}
export async function ingestBatch(files, backends, opts) {
    const result = { written: 0, skipped: 0, failed: [] };
    const tel = backends.telemetry;
    let activeFiles = [...files];
    const total = activeFiles.length;
    // F2 resume: filter using checkpoint (completed skipped; failed skipped unless retryFailed; inFlight will be retried)
    let checkpoint = null;
    if (opts.resume) {
        checkpoint = await readCheckpoint(opts.outDir);
        if (checkpoint) {
            const skip = new Set(checkpoint.completed.map(c => c.path));
            if (!opts.retryFailed) {
                for (const f of checkpoint.failed)
                    skip.add(f.path);
            }
            activeFiles = activeFiles.filter(p => !skip.has(p));
            // note: inFlight from prior will be retried by re-entering the loops
        }
    }
    // B4: compute effective concurrency after resume filter; do not spawn idle workers for a tiny remaining set.
    const remaining = activeFiles.length;
    const conc = Math.max(1, Math.min(opts.concurrency ?? 1, remaining || 1));
    const batchId = checkpoint?.batchId || randomUUID();
    const startedAt = checkpoint?.startedAt || now(backends);
    // local working state (merged with loaded on persist)
    const cpState = checkpoint || { version: "1", batchId, startedAt, inFlight: [], completed: [], failed: [] };
    // B3: inFlight as Set for O(1) includes/add/delete during batch; snapshot to array only on persist.
    const inFlight = new Set(cpState.inFlight || []);
    let completedDirty = false;
    let flushTimer = null;
    async function doPersist(snapInFlight) {
        const toWrite = { ...cpState, inFlight: snapInFlight };
        await writeCheckpoint(opts.outDir, toWrite).catch(() => { });
    }
    async function persistInFlightImmediate() {
        // immediate write on inFlight claim: crash recovery value (see F2)
        await doPersist(Array.from(inFlight)).catch(() => { });
    }
    function scheduleCompletedPersist() {
        completedDirty = true;
        if (flushTimer)
            return;
        flushTimer = setTimeout(async () => {
            flushTimer = null;
            if (completedDirty) {
                completedDirty = false;
                await doPersist(Array.from(inFlight)).catch(() => { });
            }
        }, 1000);
    }
    async function forceFlushCheckpoint() {
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        completedDirty = false;
        await doPersist(Array.from(inFlight)).catch(() => { });
    }
    // Test fakes (synthetic small bytes + patched jxl) must stay in-process; real workers create own backends + force simd.
    const useThreadPool = !backends.__testInProcess;
    if (!useThreadPool) {
        // Legacy in-process (tests, fakes, deterministic). Uses injected backends.
        let next = 0;
        const run = async () => {
            for (;;) {
                if (backends.signal?.aborted)
                    return;
                const idx = next++;
                if (idx >= activeFiles.length)
                    return;
                const path = activeFiles[idx];
                const imageId = opts.imageId || (opts.idMap && opts.idMap[path]) || await imageIdForPath(path);
                // full L3: acquire per-image write lock only for real mutate (skip in dry-run to avoid side-effect dirs; cross-proc for live runs)
                let imgLock = null;
                let lockOk = true;
                if (!opts.dryRun) {
                    try {
                        imgLock = await acquireImageWriteLock(opts.outDir, imageId);
                    }
                    catch (e) {
                        lockOk = false;
                        tel?.event?.("lock-failed", { path, imageId, error: e instanceof Error ? e.message : String(e) });
                    }
                }
                if (!lockOk && !opts.dryRun) {
                    // P9: contention after internal retry/timeout; record failed, never write unlocked (lock purpose)
                    const msg = "failed to acquire image write lock";
                    cpState.failed.push({ path, error: msg });
                    tel?.event?.("image-failed", { path, imageId, error: msg });
                    await forceFlushCheckpoint();
                    result.failed.push({ path, error: msg });
                    continue;
                }
                // F2: track inFlight + persist before work (immediate for crash safety)
                if (!inFlight.has(path)) {
                    inFlight.add(path);
                    await persistInFlightImmediate();
                }
                tel?.progress(idx + 1, total, path);
                tel?.event?.("image-start", { path, imageId, idx: idx + 1, total });
                const t0 = now(backends);
                try {
                    if (opts.chaosTest && Math.random() < 0.25) {
                        throw new Error("chaos-test injected failure (for K2 resume/GC recovery test)");
                    }
                    const callOpts = { ...opts, imageId };
                    const res = await ingestImage(path, backends, callOpts);
                    const outcome = res.outcome;
                    const dur = now(backends) - t0;
                    if (res.degraded)
                        result.degraded = (result.degraded || 0) + 1;
                    // move out of inFlight
                    inFlight.delete(path);
                    if (outcome === "written") {
                        result.written++;
                        cpState.completed.push({ path, outcome: "written", stagedBytes: res.stagedBytes, durationMs: dur });
                    }
                    else {
                        result.skipped++;
                        cpState.completed.push({ path, outcome: "skipped" });
                    }
                    tel?.event?.("image-end", { path, imageId, outcome, durationMs: dur });
                    scheduleCompletedPersist();
                }
                catch (err) {
                    const dur = now(backends) - t0;
                    inFlight.delete(path);
                    const msg = err instanceof Error ? err.message : String(err);
                    const code = err?.code;
                    cpState.failed.push({ path, error: msg, ...(code ? { code: String(code) } : {}) });
                    tel?.event?.("image-failed", { path, imageId, error: msg, code, durationMs: dur });
                    await forceFlushCheckpoint();
                    result.failed.push({ path, error: err instanceof Error ? err : String(err) });
                }
                finally {
                    await imgLock?.release().catch(() => { });
                }
            }
        };
        await Promise.all(Array.from({ length: conc }, () => run()));
        await forceFlushCheckpoint();
        if (!opts.dryRun)
            await clearCheckpoint(opts.outDir).catch(() => { });
        // B10: perImage should reflect only this run's activity (post-resume activeFiles), not prior-run completed from loaded cp.
        const thisRun = new Set(activeFiles);
        result.perImage = [
            ...cpState.completed.filter((c) => thisRun.has(c.path)),
            ...cpState.failed.filter((f) => thisRun.has(f.path)).map(f => ({ path: f.path, outcome: "failed", error: f.error })),
        ];
        const s = cpState.completed.reduce((sum, c) => sum + (c.stagedBytes || 0), 0);
        if (s > 0)
            result.totalStagedBytes = s;
        return result;
    }
    // WU-8: real multi-threaded worker pool. Main only coordinates; each worker does full ingest (decode+encode+fs).
    // Workers are created with forced 'simd' (see ingest-worker.ts). Exactly 1 core per active worker.
    const { Worker } = await import("node:worker_threads");
    const workers = [];
    // B1: per-entry owner + dead set so one worker crash rejects only its jobs and stops dispatching to it.
    const pending = new Map();
    const dead = new Set();
    let jobId = 0;
    let nextFile = 0;
    for (let i = 0; i < conc; i++) {
        const wi = i;
        // B9: .js extension required for plain tsc emit (dist/ingest.js + dist/ingest-worker.js).
        // Tests bypass the real worker pool via __testInProcess; production node run of dist/cli.js resolves the sibling .js.
        // `type: "module"` is the web/bun Worker option; node:worker_threads ignores it (ESM resolved by extension).
        const w = new Worker(new URL("./ingest-worker.js", import.meta.url), { type: "module" });
        w.on("message", (m) => {
            const p = pending.get(m.id);
            if (p) {
                pending.delete(m.id);
                if (m.ok) {
                    // B8: single object shape on the wire (worker always sends {outcome, stagedBytes?, durationMs?})
                    p.resolve({ outcome: m.outcome, stagedBytes: m.stagedBytes, durationMs: m.durationMs });
                }
                else {
                    p.reject(m.error);
                }
            }
        });
        w.on("error", (e) => {
            dead.add(wi);
            for (const [id, p] of pending) {
                if (p.worker === wi) {
                    pending.delete(id);
                    p.reject(e);
                }
            }
        });
        // Follow-up to B1: catch native/thread exits (terminate, OOM kill, etc.) that may not surface as 'error'.
        w.on("exit", (code) => {
            if (code !== 0) {
                dead.add(wi);
                for (const [id, p] of pending) {
                    if (p.worker === wi) {
                        pending.delete(id);
                        p.reject(new Error(`worker ${wi} exited with code ${code}`));
                    }
                }
            }
        });
        // Respawn (original B1 optional) not done: would require re-creating Worker, re-attaching all handlers, replacing slot, + once-guard to avoid loops.
        // Current dead+pending-reject+dispatcher-break + resume/--retry-failed already gives correct isolation + recovery without extra lifecycle in the dumb pool.
        workers.push(w);
    }
    // B7: prompt mid-image abort for the worker pool path (in-process polls between images already).
    if (backends.signal) {
        const onAbort = () => {
            forceFlushCheckpoint().catch(() => { }); // best-effort cp durability on cancel (matches force on error paths)
            for (let wi = 0; wi < workers.length; wi++) {
                dead.add(wi);
                const w = workers[wi];
                if (w)
                    w.terminate().catch(() => { });
            }
            for (const [id, p] of pending) {
                if (dead.has(p.worker)) {
                    pending.delete(id);
                    p.reject(Object.assign(new Error("aborted by signal"), { code: "ABORT_ERR" }));
                }
            }
        };
        if (backends.signal.aborted)
            onAbort();
        else
            backends.signal.addEventListener("abort", onAbort, { once: true });
    }
    const dispatchers = [];
    for (let wi = 0; wi < conc; wi++) {
        const w = workers[wi];
        const runOne = async () => {
            for (;;) {
                if (backends.signal?.aborted)
                    break;
                if (dead.has(wi))
                    break; // B1: stop dispatching to crashed worker; its jobs already rejected in error handler
                const idx = nextFile++;
                if (idx >= activeFiles.length)
                    break;
                const path = activeFiles[idx];
                const imageId = opts.imageId || (opts.idMap && opts.idMap[path]) || await imageIdForPath(path);
                // full L3: per-image write lock held for worker job duration only for real runs (dry-run avoids mkdir side effects)
                let imgLock = null;
                let lockOk = true;
                if (!opts.dryRun) {
                    try {
                        imgLock = await acquireImageWriteLock(opts.outDir, imageId);
                    }
                    catch (e) {
                        lockOk = false;
                        tel?.event?.("lock-failed", { path, imageId, error: e instanceof Error ? e.message : String(e) });
                    }
                }
                if (!lockOk && !opts.dryRun) {
                    // P9: contention after internal retry/timeout; record failed, never write unlocked (lock purpose)
                    const msg = "failed to acquire image write lock";
                    cpState.failed.push({ path, error: msg });
                    tel?.event?.("image-failed", { path, imageId, error: msg });
                    await forceFlushCheckpoint();
                    result.failed.push({ path, error: msg });
                    continue;
                }
                // F2: inFlight + persist (main coordinator side for worker dispatch)
                if (!inFlight.has(path)) {
                    inFlight.add(path);
                    await persistInFlightImmediate();
                }
                tel?.progress(idx + 1, total, path);
                tel?.event?.("image-start", { path, imageId, idx: idx + 1, total });
                const tJob = now(backends);
                try {
                    if (opts.chaosTest && Math.random() < 0.25) {
                        throw new Error("chaos-test injected failure (for K2 resume/GC recovery test)");
                    }
                    // ING-9: claim job + dispatch only after the chaos gate, so an injected failure models a
                    // real pre-work failure instead of wasting a full worker decode/encode then mislabelling it.
                    const id = ++jobId;
                    const p = new Promise((resolve, reject) => pending.set(id, { resolve, reject, worker: wi }));
                    // B5: send only the per-path stat entry (if any); full statMap Record can be large and is pure waste to clone per job.
                    // B11 + idMap: forward single precomputed imageId; strip idMap to avoid shipping full map across postMessage.
                    const preId = opts.imageId || (opts.idMap && opts.idMap[path]) || imageId;
                    const jobOpts = { ...opts, statMap: undefined, statEntry: opts.statMap?.[path], idMap: undefined, imageId: preId };
                    w.postMessage({ id, path, opts: jobOpts });
                    const res = await p;
                    const outcome = res.outcome;
                    const staged = res.stagedBytes;
                    const dur = res.durationMs ?? (now(backends) - tJob);
                    if (res && res.degraded)
                        result.degraded = (result.degraded || 0) + 1;
                    inFlight.delete(path);
                    if (outcome === "written") {
                        result.written++;
                        cpState.completed.push({ path, outcome: "written", ...(staged ? { stagedBytes: staged } : {}), durationMs: dur });
                    }
                    else {
                        result.skipped++;
                        cpState.completed.push({ path, outcome: "skipped" });
                    }
                    tel?.event?.(outcome === "written" || outcome === "skipped" ? "image-end" : "image-failed", { path, imageId, outcome, durationMs: dur });
                    scheduleCompletedPersist();
                }
                catch (err) {
                    const dur = now(backends) - tJob;
                    inFlight.delete(path);
                    const msg = err instanceof Error ? err.message : String(err);
                    const code = err?.code;
                    cpState.failed.push({ path, error: msg, ...(code ? { code: String(code) } : {}) });
                    tel?.event?.("image-failed", { path, imageId, error: msg, code, durationMs: dur });
                    await forceFlushCheckpoint();
                    result.failed.push({ path, error: err instanceof Error ? err : String(err) });
                }
                finally {
                    await imgLock?.release().catch(() => { });
                }
            }
        };
        dispatchers.push(runOne());
    }
    await Promise.all(dispatchers);
    // cleanup
    await forceFlushCheckpoint();
    await Promise.all(workers.map((w) => w.terminate().catch(() => { })));
    if (!opts.dryRun)
        await clearCheckpoint(opts.outDir).catch(() => { });
    // B10: perImage should reflect only this run's activity (post-resume activeFiles), not prior-run completed from loaded cp.
    const thisRunW = new Set(activeFiles);
    result.perImage = [
        ...cpState.completed.filter((c) => thisRunW.has(c.path)),
        ...cpState.failed.filter((f) => thisRunW.has(f.path)).map(f => ({ path: f.path, outcome: "failed", error: f.error })),
    ];
    const s = cpState.completed.reduce((sum, c) => sum + (c.stagedBytes || 0), 0);
    if (s > 0)
        result.totalStagedBytes = s;
    return result;
}
export async function rebuildIndex(outDir, telemetry) {
    const imagesDir = join(outDir, "images");
    const index = { schema: 1, images: [] };
    let imageIds;
    try {
        imageIds = await readdir(imagesDir);
    }
    catch {
        imageIds = [];
    }
    // Parallel bounded for speed on large N (manifest parse is IO+JSON+Zod); sort afterward restores D3 deterministic order.
    await pMapLimit(imageIds, 8, async (id) => {
        const manifestPath = join(imagesDir, id, "manifest.json");
        if (!(await fileExists(manifestPath)))
            return;
        let manifest;
        try {
            // Read as binary to support both JSON and binary formats; parseManifest auto-detects
            manifest = parseManifest(await readFile(manifestPath));
        }
        catch (err) {
            // P11: route via telemetry when available, stderr fallback (rebuild used from cli + standalone)
            const msg = `warning: skipping unreadable manifest ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`;
            if (telemetry?.event) {
                telemetry.event("warning", { message: msg, manifestPath });
            }
            else {
                process.stderr.write(`${msg}\n`);
            }
            return;
        }
        if (manifest.proxy || manifest.stub)
            return; // Q5: stubs excluded from central index
        index.images.push(buildIndexEntry(manifest));
    });
    // INVARIANT (D3): index order deterministic across readdir / fs. Do not remove this sort.
    index.images.sort((a, b) => (a.imageId < b.imageId ? -1 : a.imageId > b.imageId ? 1 : 0));
    // high-atomic-writes + B9: tmp + rename for index.json (reader never sees a partial/truncated file).
    // CANONICAL: JSON on the `.json` path (parseGalleryIndex still auto-detects legacy binary on read).
    const indexPath = join(outDir, "index.json");
    const tmp = `${indexPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    const json = JSON.stringify(index, null, 2);
    await withEbusyRetry(() => writeFile(tmp, json), "write-index-tmp");
    await withEbusyRetry(() => rename(tmp, indexPath), "rename-index");
    return index;
}
export async function removeOrphans(outDir, opts = {}) {
    const levelsDir = join(outDir, "levels");
    const imagesDir = join(outDir, "images");
    const removedLevelFiles = [];
    const removedImageDirs = [];
    // 1. collect all referenced contenthashes from manifests (parallel bounded for large collections)
    const referenced = new Set();
    let parseErrors = 0;
    let ids = [];
    try {
        ids = await readdir(imagesDir);
    }
    catch {
        ids = [];
    }
    await pMapLimit(ids, 8, async (id) => {
        const mp = join(imagesDir, id, "manifest.json");
        const txt = await readFileOrNull(mp);
        if (txt === null)
            return;
        try {
            const m = parseManifest(txt);
            for (const lv of (m.levels || [])) {
                if (lv && lv.contenthash)
                    referenced.add(lv.contenthash);
            }
        }
        catch {
            parseErrors++; /* DATA-SAFETY: a manifest we can't parse may reference live levels */
        }
    });
    // DATA-SAFETY: if any manifest failed to parse, the `referenced` set is incomplete, so blobs that
    // are actually live would look orphaned. Refuse to delete any level files in that case.
    const orphanDeleteSafe = parseErrors === 0;
    // 2. scan levels/ for orphans
    // P6: grace window so levels written by in-flight ingest (pre-manifest-rename) are not GC'd.
    // manifest rename happens after level writes in applyIngestPlan (atomicity); referenced built only from manifests.
    const GRACE_MS = 10 * 60 * 1000;
    let levelFiles = [];
    try {
        levelFiles = await readdir(levelsDir);
    }
    catch {
        levelFiles = [];
    }
    for (const f of levelFiles) {
        if (!f.endsWith(".jxl"))
            continue;
        const h = f.replace(/\.jxl$/, "");
        if (!referenced.has(h)) {
            if (!orphanDeleteSafe)
                continue; // unparseable manifest present — cannot trust orphan judgement
            const full = join(levelsDir, f);
            const st = await stat(full).catch(() => null);
            if (st && Date.now() - st.mtimeMs < GRACE_MS)
                continue; // too fresh to judge (in-flight writer)
            // (optional: also probe images/*/.lock per lock.ts naming for live ingest; read-only, not implemented here to keep GC cheap)
            if (!opts.dryRun) {
                await unlink(full).catch(() => { });
            }
            removedLevelFiles.push(f);
        }
    }
    // 3. empty image dirs (no manifest or empty)
    for (const id of ids) {
        const idDir = join(imagesDir, id);
        const mp = join(idDir, "manifest.json");
        const hasManifest = await fileExists(mp);
        if (!hasManifest) {
            // try remove dir (may have partials)
            try {
                if (!opts.dryRun) {
                    await rm(idDir, { recursive: true, force: true }).catch(() => { });
                }
                removedImageDirs.push(id);
            }
            catch { }
        }
    }
    return { removedLevelFiles, removedImageDirs, parseErrors };
}
// Bounded parallel map for large-gallery maintenance ops (rebuildIndex, removeOrphans).
// N manifests can be 10k+ for biodiversity/photogram collections; serial read+parse is slow wall time.
// Limit prevents excessive concurrent fd/heap during parse. Pushes are safe (Set or sort-after).
export async function pMapLimit(items, limit, fn) {
    let i = 0;
    const runners = Array.from({ length: Math.max(1, limit) }, async () => {
        while (i < items.length) {
            const cur = i++;
            if (cur >= items.length)
                break;
            await fn(items[cur]).catch(() => { });
        }
    });
    await Promise.all(runners);
}
//# sourceMappingURL=ingest.js.map