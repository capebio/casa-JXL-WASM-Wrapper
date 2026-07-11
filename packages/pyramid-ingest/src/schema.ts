import { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let cachedVersion: string | null = null;

function getVersion(): string {
  if (cachedVersion) return cachedVersion;
  const url = new URL("../package.json", import.meta.url);
  const txt = readFileSync(fileURLToPath(url), "utf8");
  const pkg = JSON.parse(txt) as { version: string };
  cachedVersion = pkg.version;
  return cachedVersion;
}

export const producedBySchema = z.object({
  tool: z.literal("pyramid-ingest"),
  version: z.string(),
  encoder: z.object({
    libjxl: z.string().optional(),
    effort: z.number().int().positive(),
    quality: z.object({
      grid: z.number().int().min(30).max(100),
      big: z.number().int().min(30).max(100),
      proxy: z.number().int().min(30).max(100),
    }),
  }),
});

export const levelSizeSchema = z.union([z.number().int().positive(), z.literal("full")]);

/** Encode-time progressive quality curve point (measured once at ingest; read-only for clients). */
export const qualityCurvePointSchema = z.object({
  bytes: z.number().int().positive(),
  ssim: z.number().min(0).max(1).optional(),
  butteraugli: z.number().nonnegative().optional(),
});

export const levelEntrySchema = z.object({
  size: levelSizeSchema,
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
  bitsPerSample: z.union([z.literal(8), z.literal(16)]),
  contenthash: z.string().length(16),
  tiled: z.boolean(),
  convergedByteEnd: z.number().int().positive().optional(),
  qualityCurve: z.array(qualityCurvePointSchema).optional(),
});

export const masterInfoSchema = z.object({
  name: z.string(),
  // SCH-1: keep in sync with ingest RAW_EXT — pef/srw/x3f are advertised there, so a manifest with
  // those formats must validate (otherwise parseManifest throws and the image is lost).
  format: z.enum(["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]),
  mtimeMs: z.number(),
});

export const manifestSchemaV1 = z.object({
  schema: z.literal(1),
  imageId: z.string().regex(/^[0-9a-f]{16}$/),
  master: masterInfoSchema,
  orientation: z.enum(["baked", "source"]).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  aspect: z.number().finite().positive().optional(),
  levels: z.array(levelEntrySchema).optional(),
  // M2: on-disk layout marker (set by `migrate --migrate-layout`). Optional + additive so it
  // round-trips through parseManifest instead of being stripped (which would cause re-migrate loops).
  layout: z.string().optional(),
  proxy: z.literal(true).optional(),
  stub: z.literal(true).optional(),
  metadata: z.record(z.unknown()).optional(),
  producedBy: producedBySchema
    .refine((p) => {
      // SCH-5: accept majors up to the running tool's own major (was hard-pinned to "0", which would
      // make every manifest written by a 1.x release fail its own parseManifest). Still rejects
      // forward-incompatible manifests written by a newer major than this tool.
      const maj = Number((p.version || "0").split(".")[0]);
      if (!Number.isFinite(maj) || maj < 0) return false;
      const curMaj = Number((getVersion() || "0").split(".")[0]);
      return maj <= (Number.isFinite(curMaj) ? curMaj : 0);
    }, { message: "unsupported producedBy major version" })
    .optional(),
});

// V3 (Phase2): v2 stub (additive for now; layout etc in M). discriminated for safe bumps.
// V4/M: index norm etc (additive optional for future, e.g. more index fields; norm in rebuild for consistency)
export const manifestSchemaV2Base = manifestSchemaV1.extend({ schema: z.literal(2) });
export const manifestSchemaV4Base = manifestSchemaV2Base.extend({ schema: z.literal(4) }); // v4 additive
export const manifestSchema = z.discriminatedUnion("schema", [manifestSchemaV1, manifestSchemaV2Base, manifestSchemaV4Base]);
export type ManifestV2 = z.infer<typeof manifestSchemaV2Base>;
export type ManifestV4 = z.infer<typeof manifestSchemaV4Base>;

// ─────────────────────────────────────────────────────────────────────────────
// MANIFEST SCHEMA VERSION POLICY — single source of truth (Packet-1, finding 65)
// ─────────────────────────────────────────────────────────────────────────────
//
// This block RECORDS the approved v5 policy for Packet 1. It does NOT yet
// implement v5 parsing or migration — that lands in Task 4. Until then the
// discriminated union above still tops out at schema 4, so the v5 contract
// fixtures (packages/pyramid-ingest/test/fixtures/contracts) intentionally do not
// yet parse; contract-compat.test.ts pins that intent.
//
// Compatibility table:
//   schema  status     notes
//   ------  ---------  --------------------------------------------------------
//   1       readable   earliest; geometry/levels optional. Migrate → 5.
//   2       readable   V3 Phase2 discriminated bump (current writer output pre-v5).
//   3       skipped    never emitted; reject as unsupported.
//   4       readable   index-norm additive (tiling grid, layout, qualityCurve).
//   5       current    additive: OrientationDescriptor + TilingDescriptor,
//                      sourceFormat decoupled from decoder capability.
//   >5      reject     future major written by a newer tool; refuse, never
//                      silently reinterpret bytes.
//
// v5 ADDITIVE shape (target; implemented in Task 4 — do not add here yet):
//   - master.sourceFormat: detected provenance, independent of decoder support.
//   - orientation: OrientationDescriptor { exif: 1..8; pixels: "source"|"baked-upright" }
//     (replaces the v1-v4 "baked"|"source" string; migration maps the old string
//      to { exif: 1, pixels: <string> } when no EXIF orientation is recorded).
//   - level.tiling: TilingDescriptor
//     { container: "jxtc"; version: 1|2; tileSize; bitsPerSample: 8|16; offsetBase: "file" }
//     (JXTC index offsets are ABSOLUTE from byte zero of the file — see
//      packages/jxl-pyramid/src/tiling.ts and bridge.cpp:1925-1931).
//   - Migration is additive and MUST preserve unknown fields (migrate.ts MIG-2).

/** The schema version this tool writes today. */
export const CURRENT_MANIFEST_SCHEMA = 5 as const;

/** Every schema version this tool can READ (and additively migrate forward). */
export const READABLE_MANIFEST_SCHEMAS = [1, 2, 4, 5] as const;

export const indexEntrySchema = z.object({
  imageId: z.string().regex(/^[0-9a-f]{16}$/),
  aspect: z.number().finite().positive(),
  l0: z.object({
    contenthash: z.string().length(16),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
  }),
  // V4: optional for v2+ manifests (decoder etc not needed in index)
  schema: z.number().optional(),
});

export const galleryIndexSchema = z.object({
  schema: z.literal(1),  // index stays v1 for compat; entries tolerate v2 manifests
  images: z.array(indexEntrySchema),
});

export type Manifest = z.infer<typeof manifestSchemaV1> | ManifestV2 | ManifestV4;
export type IndexEntry = z.infer<typeof indexEntrySchema>;
export type GalleryIndex = z.infer<typeof galleryIndexSchema>;
export type LevelEntry = z.infer<typeof levelEntrySchema>;
export type LevelSize = z.infer<typeof levelSizeSchema>;
export type MasterInfo = z.infer<typeof masterInfoSchema>;
export type ProducedBy = z.infer<typeof producedBySchema>;

// O/M/I/K/C/T per-image events + runlog (unlocked by WU-6 + V3 + locks + checkpoint)
export const imageRecordSchema = z.object({
  path: z.string(),
  imageId: z.string().regex(/^[0-9a-f]{16}$/).optional(),
  outcome: z.enum(["written", "skipped", "failed"]),
  error: z.string().optional(),
  durationMs: z.number().optional(),
});
export type ImageRecord = z.infer<typeof imageRecordSchema>;

export const runRecordSchema = z.object({
  runId: z.string(),
  startedAt: z.number(),
  endedAt: z.number(),
  producedBy: producedBySchema,
  args: z.array(z.string()),
  summary: z.object({
    written: z.number(),
    skipped: z.number(),
    failed: z.number(),
    stagedBytes: z.number().optional(),
  }),
  images: z.array(imageRecordSchema).optional(),
  failures: z.array(z.object({ path: z.string(), error: z.string() })).optional(),
  // complete for O: stages etc if -vv
  stages: z.array(z.object({ name: z.string(), ts: z.number(), fields: z.record(z.unknown()).optional() })).optional(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

// Exact Event per plan O1 for --json (batch + per-image + stages for -vv)
export type CliEvent =
  | { type: "batch-start"; runId: string; totalFiles: number; concurrency: number }
  | { type: "image-start"; runId: string; path: string; imageId: string }
  | { type: "image-done"; runId: string; path: string; outcome: "written" | "skipped"; durationMs: number }
  | { type: "image-failed"; runId: string; path: string; error: { message: string; stack?: string; code?: string } }
  | { type: "batch-end"; runId: string; written: number; skipped: number; failed: number; durationMs: number }
  | { type: "stage"; runId: string; name: string; ts: number; fields?: Record<string, unknown> }
  | { type: "gc-result" | "validate-result" | "rm-result" | "migrate-result"; [k: string]: unknown };

export function parseManifest(text: string | Uint8Array): Manifest {
  // V3: accepts v1/v2 JSON or binary format (−73% size via manifestToBinary)
  // Binary format detected: buffer not starting with '{' (Uint8Array first byte != '{'.charCodeAt(0) = 123)
  if (text instanceof Uint8Array) {
    if (text[0] !== 123) {
      // Binary format: lazy-import to avoid circular dep with manifest.ts
      const { binaryToManifest } = require("./manifest.js");
      return binaryToManifest(text);
    }
    // Fallback: treat as UTF-8 JSON if somehow starts with '{'
    text = new TextDecoder().decode(text);
  }

  // JSON path: text[0] should be '{' for valid manifests
  return manifestSchema.parse(JSON.parse(text)) as Manifest;
}

export function parseGalleryIndex(text: string | Uint8Array): GalleryIndex {
  // Auto-detect binary format (first byte != '{') or JSON
  if (text instanceof Uint8Array) {
    if (text[0] !== 123) {
      // Binary format: lazy-import to avoid circular dep
      const { binaryToGalleryIndex } = require("./manifest.js");
      return binaryToGalleryIndex(text);
    }
    text = new TextDecoder().decode(text);
  }

  return galleryIndexSchema.parse(JSON.parse(text));
}

const EFFORT = 3;
const GRID_QUALITY = 85;
const BIG_QUALITY = 95;
const PROXY_QUALITY = 85;

export function makeProducedBy(): ProducedBy {
  return {
    tool: "pyramid-ingest",
    version: getVersion(),
    encoder: {
      effort: EFFORT,
      quality: {
        grid: GRID_QUALITY,
        big: BIG_QUALITY,
        proxy: PROXY_QUALITY,
      },
    },
  };
}

export const cliArgsSchema = z.object({
  out: z.string(),
  proxy: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : strictPositiveInt("proxy", v))),
  force: z.boolean().optional().default(false),
  concurrency: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : strictPositiveInt("concurrency", v))),
  "mem-budget-mb": z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 4096 : strictPositiveInt("mem-budget-mb", v))),
  shard: z
    .string()
    .optional()
    .refine((v) => !v || /^\d+\/\d+$/.test(v), {
      message: '--shard must be "i/N" (0-based)',
    }),
  tier: z.enum(["simd", "scalar", "auto"]).optional().default("simd"),
  tiling: z.enum(["adaptive", "tile-all"]).optional().default("adaptive"),
  "reindex-only": z.boolean().optional().default(false),
  "encoder-threads": z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : strictPositiveInt("encoder-threads", v))),
  verbose: z.boolean().optional().default(false),
  "verify-hash": z.boolean().optional().default(false),
  "dry-run": z.boolean().optional().default(false),
  explain: z.string().optional(),
  "timeout-ms": z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : strictPositiveInt("timeout-ms", v))),
  "accept-unsupported": z.boolean().optional().default(true),
  "profile-convergence": z.boolean().optional().default(false),
  // WU-6 prereqs (F1/F5/F6/F2) + L locks: flag + subcmd support (gc/validate/rm/resume).
  // rm as string (like explain) for --rm <imageId|path> or subcmd positional.
  gc: z.boolean().optional().default(false),
  validate: z.boolean().optional().default(false),
  rm: z.string().optional(),
  resume: z.boolean().optional().default(false),
  migrate: z.boolean().optional().default(false),
  "migrate-layout": z.string().optional(),
  "migrate-schema": z.string().optional(),
  "suggest-migrations": z.boolean().optional().default(false),
  // K2: chaos injection for testing resume/GC under failure (unlocked by surface + locks + checkpoint)
  "chaos-test": z.boolean().optional().default(false),
  // B6: allow retrying prior failures recorded in checkpoint (transient errors like EBUSY/OOM during previous run)
  "retry-failed": z.boolean().optional().default(false),
  config: z.string().optional(),
  // O1/O6 Phase2: structured output + bounded runlog
  json: z.boolean().optional().default(false),
  "runlog-keep": z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 100 : strictPositiveInt("runlog-keep", v))),
});

function strictPositiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`--${name} must be a positive integer; got "${raw}"`);
  }
  return n;
}

export type CliArgs = z.infer<typeof cliArgsSchema>;

/** Magic-byte signatures for adversarial unknown-RAW detection (colocated with Zod per Q6). // WU-5-8 handoff safe-concurrency

 *  Used only for Tier-3/5 fallback when native Tier-1 decode fails or ext unknown.
 *  Prefix matches (order: more specific first if needed).
 */
export const RAW_MAGIC_SIGNATURES: Array<{ format: string; bytes: number[]; offset: number }> = [
  { format: "cr2", bytes: [0x49, 0x49, 0x2a, 0x00], offset: 0 }, // II*\0 (tiff) + CR2 maker later
  { format: "orf", bytes: [0x49, 0x49, 0x52, 0x4f], offset: 0 }, // IIRO (Olympus)
  { format: "dng", bytes: [0x49, 0x49, 0x2a, 0x00], offset: 0 },
  { format: "nef", bytes: [0x4d, 0x4d, 0x00, 0x2a], offset: 0 }, // MM\0* or II variant + Nikon
  { format: "arw", bytes: [0x49, 0x49, 0x2a, 0x00], offset: 0 }, // Sony (tiff base)
  { format: "raf", bytes: [0x46, 0x55, 0x4a, 0x49], offset: 0 }, // FUJI start
];

export function detectFormatByMagic(bytes: Uint8Array): string | null {
  for (const sig of RAW_MAGIC_SIGNATURES) {
    const off = sig.offset | 0;
    if (bytes.length >= off + sig.bytes.length) {
      let ok = true;
      for (let i = 0; i < sig.bytes.length; i++) {
        if (bytes[off + i] !== sig.bytes[i]) { ok = false; break; }
      }
      if (ok) return sig.format;
    }
  }
  return null;
}
