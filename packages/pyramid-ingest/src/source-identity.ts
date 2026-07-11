import { stat } from "node:fs/promises";
import { fnv1a64Hex, normalizePath } from "./hash.js";

// ─────────────────────────────────────────────────────────────────────────────
// Source identity vs freshness (finding 66, Packet-1 Task 5)
// ─────────────────────────────────────────────────────────────────────────────
//
// THREE distinct notions, deliberately NOT conflated:
//
//   catalogId   — PERSISTENT catalog identity. Derived from the master's CONTENT, so it is stable
//                 when a file MOVES (same bytes, new path → same catalogId). This is what a durable
//                 catalog row keys on. It is NOT the per-level `contenthash` (which hashes the encoded
//                 JXL bytes of one pyramid level); it is the identity of the SOURCE master as a whole.
//
//   sourceKey   — PATH-derived change-detection key. Locates the file on disk. Same basename in two
//                 directories yields DIFFERENT sourceKeys (no collision). Normalized (realpath + NFC)
//                 so equivalent spellings coincide. This changes on a move; catalogId does not.
//
//   fingerprint — CHEAP freshness sample: byteLength + mtimeMs + quickHash (a sparse content sample),
//                 with an OPTIONAL full contentHash for ambiguous cases. Answers "did the bytes at
//                 this path change since we last ingested?" — never used as durable identity.
//
// Neither catalogId, sourceKey, nor quickHash/contentHash here is the per-level content hash
// (`contentHash16` in hash.ts, used for level filenames).

/** Persistent catalog identity (stable across moves) + on-disk change-detection key. */
export type SourceIdentity = {
  /** Stable across moves; content-derived identity of the source master. */
  catalogId: string;
  /** Path-derived; locates the file, changes on move. */
  sourceKey: string;
};

/** Cheap change-detection sample for a source file. `contentHash` is filled only when the fast path
 *  (size + mtime + quickHash) is ambiguous and a full read is warranted. */
export type SourceFingerprint = {
  byteLength: number;
  mtimeMs: number;
  /** Sparse content sample (head + interior + tail). Cheap; not collision-proof on its own. */
  quickHash: string;
  /** Full-content hash. Authoritative when present on BOTH sides of a comparison. */
  contentHash?: string;
};

const TRUNC = 16; // 16 hex chars = 64-bit, matching imageId / contenthash namespaces.

// quickHash sampling: for files larger than this, sample three windows (head, interior, tail) rather
// than hashing every byte. The interior sample is what catches a replaced middle that a head+tail-only
// probe would miss. Small files are hashed in full.
const QUICK_SAMPLE_THRESHOLD = 256 * 1024; // 256 KiB
const QUICK_WINDOW = 64 * 1024; // 64 KiB per window

/** Path-derived change-detection key. Normalized (realpath + NFC) so equivalent spellings coincide;
 *  distinct real paths (e.g. same basename in different directories) never collide. */
export async function sourceKeyForPath(p: string, truncateHex = TRUNC): Promise<string> {
  return fnv1a64Hex(await normalizePath(p)).slice(0, truncateHex);
}

/** Persistent catalog identity, derived from the master CONTENT (stable across moves). Distinct from
 *  the per-level content hash: this identifies the SOURCE master, not an encoded pyramid level. */
export function catalogIdForContent(bytes: Uint8Array, truncateHex = TRUNC): string {
  return fnv1a64Hex(bytes).slice(0, truncateHex);
}

/** Cheap sparse content sample. For large buffers, hashes head + interior + tail windows plus the
 *  total length, so a replaced interior byte still changes the hash without a full read. `byteLength`
 *  is the true file size (may exceed `bytes.length` if a caller passes a partial buffer). */
export function quickHash(bytes: Uint8Array, byteLength = bytes.length, truncateHex = TRUNC): string {
  if (bytes.length <= QUICK_SAMPLE_THRESHOLD) {
    // small: hash the whole thing, salted with length to disambiguate truncations
    return fnv1a64Hex(`${byteLength}:`).slice(0, 4) + fnv1a64Hex(bytes).slice(0, truncateHex - 4);
  }
  const n = bytes.length;
  const mid = Math.floor(n / 2 - QUICK_WINDOW / 2);
  const head = bytes.subarray(0, QUICK_WINDOW);
  const interior = bytes.subarray(mid, mid + QUICK_WINDOW);
  const tail = bytes.subarray(n - QUICK_WINDOW);
  const combined = `${byteLength}|${fnv1a64Hex(head)}|${fnv1a64Hex(interior)}|${fnv1a64Hex(tail)}`;
  return fnv1a64Hex(combined).slice(0, truncateHex);
}

/** Build a fingerprint for a file on disk. Reads the file once for size + quickHash; `contentHash`
 *  is left undefined here (the full hash is computed lazily only when a comparison is ambiguous). */
export async function fingerprint(
  p: string,
  opts: { withContentHash?: boolean } = {},
): Promise<SourceFingerprint> {
  const { readFile } = await import("node:fs/promises");
  const s = await stat(p);
  const bytes = await readFile(p);
  const fp: SourceFingerprint = {
    byteLength: s.size,
    mtimeMs: s.mtimeMs,
    quickHash: quickHash(bytes, s.size),
  };
  if (opts.withContentHash) fp.contentHash = catalogIdForContent(bytes);
  return fp;
}

/** Build a fingerprint from bytes already in memory (avoids a re-read on the ingest hot path). */
export function fingerprintFromBytes(
  bytes: Uint8Array,
  mtimeMs: number,
  byteLength = bytes.length,
  opts: { withContentHash?: boolean } = {},
): SourceFingerprint {
  const fp: SourceFingerprint = {
    byteLength,
    mtimeMs,
    quickHash: quickHash(bytes, byteLength),
  };
  if (opts.withContentHash) fp.contentHash = catalogIdForContent(bytes);
  return fp;
}

/**
 * Freshness decision. `existing` is what we recorded at last ingest; `observed` is the file now.
 *
 * Authority order:
 *  1. If BOTH sides carry a full `contentHash`, that is authoritative (equal → fresh, differ → stale).
 *     This handles benign metadata edits and quickHash collision-misses correctly.
 *  2. Otherwise use the fast path: byteLength AND quickHash must match. mtime is deliberately NOT a
 *     freshness signal on its own — a preserved mtime after a byte replacement must still read STALE,
 *     and a bumped mtime after a pure `touch` (same size+quickHash) must still read FRESH.
 */
export function isFresh(existing: SourceFingerprint, observed: SourceFingerprint): boolean {
  if (existing.contentHash !== undefined && observed.contentHash !== undefined) {
    return existing.contentHash === observed.contentHash;
  }
  return existing.byteLength === observed.byteLength && existing.quickHash === observed.quickHash;
}

/** A known catalog entry: its persistent identity paired with the sourceKey it was last seen at. */
export type KnownEntry = { catalogId: string; sourceKey: string };

/** Result of reconciling a freshly-seen file against the known catalog. Never merges two catalog rows:
 *  a content match with a *different* known sourceKey is reported as an explicit `relink`, leaving the
 *  merge/move decision to the caller (migration report). */
export type RelinkReport =
  | { kind: "new"; catalogId: string; toSourceKey: string }
  | { kind: "unchanged"; catalogId: string; toSourceKey: string }
  | { kind: "relink"; catalogId: string; fromSourceKey: string; toSourceKey: string };

/**
 * Reconcile a freshly-observed file (its path + content) against the known catalog.
 *
 *  - `unchanged` : this catalogId is already known at this exact sourceKey.
 *  - `relink`    : this catalogId is known, but at a DIFFERENT sourceKey → the file moved. We report
 *                  the move explicitly (from → to). We NEVER silently merge two catalog entries.
 *  - `new`       : content not present in the catalog → a brand-new entry.
 *
 *  Matching is by catalogId (content), never by metadata: two files that merely share size/mtime but
 *  differ in content get distinct catalogIds and are therefore never mistaken for a relink of each other.
 */
export async function detectRelink(
  path: string,
  bytes: Uint8Array,
  known: readonly KnownEntry[],
): Promise<RelinkReport> {
  const catalogId = catalogIdForContent(bytes);
  const toSourceKey = await sourceKeyForPath(path);
  const matches = known.filter((k) => k.catalogId === catalogId);
  if (matches.length === 0) {
    return { kind: "new", catalogId, toSourceKey };
  }
  if (matches.some((m) => m.sourceKey === toSourceKey)) {
    return { kind: "unchanged", catalogId, toSourceKey };
  }
  // Known content, new location → an explicit relink. Report the first known location as the source.
  return { kind: "relink", catalogId, fromSourceKey: matches[0]!.sourceKey, toSourceKey };
}
