import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sourceKeyForPath,
  catalogIdForContent,
  fingerprint,
  quickHash,
  isFresh,
  detectRelink,
  type SourceFingerprint,
} from "../src/source-identity";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "src-identity-"));
}

// ─────────────────────────────────────────────────────────────────────────────
// sourceKey — path-derived change-detection key. Distinct paths must NOT collide.
// ─────────────────────────────────────────────────────────────────────────────

test("same basename in different directories yields DIFFERENT sourceKeys (no collision)", async () => {
  const a = await sourceKeyForPath("/library/2024/january/DSC_0001.orf");
  const b = await sourceKeyForPath("/library/2024/february/DSC_0001.orf");
  expect(a).not.toBe(b);
  expect(a).toHaveLength(16);
  expect(b).toHaveLength(16);
});

test("sourceKey normalizes equivalent path spellings to the same key", async () => {
  const a = await sourceKeyForPath("a/b/master.orf");
  const b = await sourceKeyForPath("a/./b/master.orf");
  expect(a).toBe(b);
});

test("sourceKey Unicode-normalizes (NFC/NFD) equivalent paths to the same key", async () => {
  // "é" as single codepoint (NFC, U+00E9) vs "e" + combining acute (NFD, U+0065 U+0301)
  const nfc = "/lib/cafeé/master.orf";
  const nfd = "/lib/cafeé/master.orf";
  expect(nfc.normalize("NFC")).toBe(nfd.normalize("NFC"));
  const a = await sourceKeyForPath(nfc);
  const b = await sourceKeyForPath(nfd);
  expect(a).toBe(b);
});

// ─────────────────────────────────────────────────────────────────────────────
// catalogId — persistent CONTENT identity, stable across moves.
// NOT the per-level content hash (that hashes encoded JXL level bytes).
// ─────────────────────────────────────────────────────────────────────────────

test("catalogId is derived from content, stable across a move (same bytes, new path)", () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const idAtPathA = catalogIdForContent(bytes);
  const idAtPathB = catalogIdForContent(bytes); // same content, imagine moved
  expect(idAtPathA).toBe(idAtPathB);
  expect(idAtPathA).toHaveLength(16);
});

test("catalogId differs for different content", () => {
  const a = catalogIdForContent(new Uint8Array([1, 2, 3]));
  const b = catalogIdForContent(new Uint8Array([1, 2, 4]));
  expect(a).not.toBe(b);
});

// ─────────────────────────────────────────────────────────────────────────────
// fingerprint / quickHash — cheap change-detection sample.
// ─────────────────────────────────────────────────────────────────────────────

test("fingerprint captures byteLength, mtimeMs and a quickHash", async () => {
  const dir = await tmp();
  const p = join(dir, "m.orf");
  const bytes = new Uint8Array(2048).fill(7);
  await writeFile(p, bytes);
  const fp = await fingerprint(p);
  expect(fp.byteLength).toBe(2048);
  expect(typeof fp.mtimeMs).toBe("number");
  expect(fp.quickHash).toHaveLength(16);
});

test("quickHash samples large files without reading every byte, yet detects a mid-file edit", async () => {
  // 4 MiB buffers differing only in the middle: a head+tail-only sampler would MISS this;
  // the sampler MUST include an interior sample so replaced-interior-bytes are detected.
  const n = 4 * 1024 * 1024;
  const a = new Uint8Array(n).fill(9);
  const b = new Uint8Array(n).fill(9);
  b[Math.floor(n / 2)] = 8; // single interior byte flipped
  expect(quickHash(a, a.length)).not.toBe(quickHash(b, b.length));
});

// ─────────────────────────────────────────────────────────────────────────────
// isFresh — freshness / staleness decision.
// ─────────────────────────────────────────────────────────────────────────────

test("isFresh: identical fingerprint is fresh (fast path, no content hash needed)", () => {
  const fp: SourceFingerprint = { byteLength: 100, mtimeMs: 111, quickHash: "aaaaaaaaaaaaaaaa" };
  expect(isFresh(fp, { ...fp })).toBe(true);
});

test("isFresh: changed mtime with same size+quickHash is treated as fresh (touch, no content change)", () => {
  const existing: SourceFingerprint = { byteLength: 100, mtimeMs: 111, quickHash: "aaaaaaaaaaaaaaaa" };
  const observed: SourceFingerprint = { byteLength: 100, mtimeMs: 222, quickHash: "aaaaaaaaaaaaaaaa" };
  expect(isFresh(existing, observed)).toBe(true);
});

test("isFresh: replaced bytes with PRESERVED mtime is STALE (mtime alone must not certify freshness)", () => {
  // The classic trap: an editor rewrites content but restores the original mtime.
  // size same, mtime same, but quickHash differs -> MUST be stale.
  const existing: SourceFingerprint = { byteLength: 100, mtimeMs: 111, quickHash: "aaaaaaaaaaaaaaaa" };
  const observed: SourceFingerprint = { byteLength: 100, mtimeMs: 111, quickHash: "bbbbbbbbbbbbbbbb" };
  expect(isFresh(existing, observed)).toBe(false);
});

test("isFresh: different byteLength is STALE even if mtime unchanged", () => {
  const existing: SourceFingerprint = { byteLength: 100, mtimeMs: 111, quickHash: "aaaaaaaaaaaaaaaa" };
  const observed: SourceFingerprint = { byteLength: 200, mtimeMs: 111, quickHash: "aaaaaaaaaaaaaaaa" };
  expect(isFresh(existing, observed)).toBe(false);
});

test("isFresh: ambiguity (quickHash differs but full contentHash matches) is fresh", () => {
  // A quickHash collision-miss or benign metadata edit that leaves the true content identical:
  // when BOTH fingerprints carry a full contentHash and those match, the file is fresh despite
  // a quickHash mismatch (the full hash is authoritative).
  const existing: SourceFingerprint = { byteLength: 100, mtimeMs: 111, quickHash: "aaaaaaaaaaaaaaaa", contentHash: "cccccccccccccccc" };
  const observed: SourceFingerprint = { byteLength: 100, mtimeMs: 111, quickHash: "dddddddddddddddd", contentHash: "cccccccccccccccc" };
  expect(isFresh(existing, observed)).toBe(true);
});

test("isFresh: full contentHash mismatch is authoritative STALE (even if quickHash matched)", () => {
  const existing: SourceFingerprint = { byteLength: 100, mtimeMs: 111, quickHash: "aaaaaaaaaaaaaaaa", contentHash: "cccccccccccccccc" };
  const observed: SourceFingerprint = { byteLength: 100, mtimeMs: 111, quickHash: "aaaaaaaaaaaaaaaa", contentHash: "eeeeeeeeeeeeeeee" };
  expect(isFresh(existing, observed)).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// detectRelink — explicit move/relink operation. NEVER silently merge catalogs.
// ─────────────────────────────────────────────────────────────────────────────

test("detectRelink: moved-unchanged file (same catalogId, new sourceKey) is a relink", async () => {
  const dir = await tmp();
  await mkdir(join(dir, "old"), { recursive: true });
  await mkdir(join(dir, "new"), { recursive: true });
  const bytes = new Uint8Array([10, 20, 30, 40, 50]);
  const oldPath = join(dir, "old", "photo.orf");
  const newPath = join(dir, "new", "photo.orf");
  await writeFile(oldPath, bytes);
  await rename(oldPath, newPath);

  const catalogId = catalogIdForContent(bytes);
  const oldKey = await sourceKeyForPath(oldPath);
  const known = [{ catalogId, sourceKey: oldKey }];

  const rep = await detectRelink(newPath, bytes, known);
  expect(rep.kind).toBe("relink");
  expect(rep.catalogId).toBe(catalogId);
  expect(rep.fromSourceKey).toBe(oldKey);
  expect(rep.toSourceKey).toBe(await sourceKeyForPath(newPath));
});

test("detectRelink: brand-new content at a new path is a fresh entry (not a relink)", async () => {
  const dir = await tmp();
  const p = join(dir, "brand-new.orf");
  const bytes = new Uint8Array([99, 98, 97]);
  await writeFile(p, bytes);
  const known = [{ catalogId: "0000000000000000", sourceKey: "1111111111111111" }];
  const rep = await detectRelink(p, bytes, known);
  expect(rep.kind).toBe("new");
});

test("detectRelink: two files sharing metadata but not content get DISTINCT catalogIds (no merge)", async () => {
  const dir = await tmp();
  const bytesA = new Uint8Array(512).fill(1);
  const bytesB = new Uint8Array(512).fill(2); // same byteLength, different content
  const pA = join(dir, "a.orf");
  const pB = join(dir, "b.orf");
  await writeFile(pA, bytesA);
  await writeFile(pB, bytesB);

  const catA = catalogIdForContent(bytesA);
  const known = [{ catalogId: catA, sourceKey: await sourceKeyForPath(pA) }];
  // B shares metadata (same size) with A but is different content: must NOT be seen as a relink of A.
  const rep = await detectRelink(pB, bytesB, known);
  expect(rep.kind).toBe("new");
  expect(catalogIdForContent(bytesB)).not.toBe(catA);
});

test("detectRelink: same content already known at same sourceKey is unchanged (no spurious relink)", async () => {
  const dir = await tmp();
  const p = join(dir, "same.orf");
  const bytes = new Uint8Array([5, 5, 5, 5]);
  await writeFile(p, bytes);
  const key = await sourceKeyForPath(p);
  const catalogId = catalogIdForContent(bytes);
  const known = [{ catalogId, sourceKey: key }];
  const rep = await detectRelink(p, bytes, known);
  expect(rep.kind).toBe("unchanged");
  expect(rep.catalogId).toBe(catalogId);
});
