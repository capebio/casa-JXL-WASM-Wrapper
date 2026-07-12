import { type LadderResult, type TilingPolicy } from "./ladder.js";
import { type GalleryIndex, type LevelEntry, type Manifest } from "./manifest.js";
import type { Clock, JxlBackend, MasterFormat, Orientation, RawBackend, Telemetry } from "./backends.js";
export interface Backends {
    raw: RawBackend;
    jxl: JxlBackend;
    signal?: AbortSignal;
    telemetry?: Telemetry;
    clock?: Clock;
}
export interface IngestOptions {
    outDir: string;
    proxy?: number;
    force?: boolean;
    verifyHash?: boolean;
    acceptUnsupported?: boolean;
    profileConvergence?: boolean;
    resume?: boolean;
    retryFailed?: boolean;
    chaosTest?: boolean;
    statMap?: Record<string, {
        size: number;
        mtimeMs: number;
    }>;
    stripGps?: boolean;
    idMap?: Record<string, string>;
    tiling?: TilingPolicy;
}
export type IngestOutcome = "written" | "skipped";
export interface IngestResult {
    outcome: IngestOutcome;
    /** sum of stagedBytes across levels for this image (unlocked copy instrumentation; 0/undef for skipped) */
    stagedBytes?: number;
    /** present on dryRun (P8) */
    plan?: IngestPlan;
    degraded?: boolean;
}
export interface BatchResult {
    written: number;
    skipped: number;
    failed: {
        path: string;
        error: Error | string;
    }[];
    perImage?: Array<{
        path: string;
        outcome: "written" | "skipped" | "failed";
        error?: string;
        stagedBytes?: number;
    }>;
    /** total pixel bytes staged into encoders across all written levels in this batch (unlocked copy instrumentation) */
    totalStagedBytes?: number;
    degraded?: number;
}
export interface IngestPlan {
    imageId: string;
    master: {
        name: string;
        format: MasterFormat;
        mtimeMs: number;
    };
    orientation: Orientation;
    width: number;
    height: number;
    levels: Array<{
        data: Uint8Array;
        width: number;
        height: number;
        bitsPerSample?: 8 | 16;
        tiled?: boolean;
        convergedByteEnd?: number;
        qualityCurve?: Array<{
            bytes: number;
            ssim?: number;
            butteraugli?: number;
        }>;
        stagedBytes?: number;
    }>;
    entries: LevelEntry[];
    proxy: boolean;
    manifest: Manifest;
}
export declare function formatFromPath(p: string): string | null;
export declare function fileExists(p: string): Promise<boolean>;
/** Read a file as raw bytes, returning null if it does not exist. Collapses the fileExists()+readFile()
 *  double-stat used across the admin commands (cli/validate/migrate/rm) into a single syscall.
 *  Returns bytes (not utf8) so parseManifest/parseGalleryIndex can auto-detect the binary format. */
export declare function readFileOrNull(p: string): Promise<Uint8Array | null>;
export declare function writeLevelFiles(outDir: string, levels: LadderResult["levels"], masterW: number, masterH: number, verifyHash?: boolean, preEntries?: LevelEntry[], existingLevels?: Set<string>): Promise<LevelEntry[]>;
export declare function computeIngestPlan(bytes: Uint8Array, format: MasterFormat, backends: Backends, identity: {
    imageId: string;
    masterName: string;
    mtimeMs: number;
}, opts: IngestOptions, metadata?: Record<string, unknown>): Promise<IngestPlan>;
export declare function applyIngestPlan(plan: IngestPlan, backends: Backends, opts: IngestOptions): Promise<IngestOutcome>;
export declare function ingestImage(masterPath: string, backends: Backends, opts: IngestOptions & {
    dryRun?: boolean;
    timeoutMs?: number;
}): Promise<IngestResult>;
export declare function ingestBatch(files: readonly string[], backends: Backends, opts: IngestOptions & {
    concurrency?: number;
    dryRun?: boolean;
    timeoutMs?: number;
    resume?: boolean;
}): Promise<BatchResult>;
export declare function rebuildIndex(outDir: string, telemetry?: Telemetry): Promise<GalleryIndex>;
export interface GcResult {
    removedLevelFiles: string[];
    removedImageDirs: string[];
    /** Number of manifests that failed to parse. When > 0, orphan-level deletion is skipped
     *  (their referenced hashes are unknown, so deleting "unreferenced" blobs could destroy live data). */
    parseErrors?: number;
}
export declare function removeOrphans(outDir: string, opts?: {
    dryRun?: boolean;
}): Promise<GcResult>;
export declare function pMapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void>;
//# sourceMappingURL=ingest.d.ts.map