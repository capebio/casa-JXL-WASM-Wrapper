// Deterministic generator for Packet-1 contract fixtures.
//
// Run: `node generate-fixtures.mjs` from this directory. Regenerates every
// fixture in this folder byte-for-byte. The fixtures are checked in; this
// script exists so the *provenance* of each byte is auditable and the SHA-256
// values pinned in the tests can be reproduced. It writes no random data.
//
// These fixtures encode the Packet-1 target contracts (see
// docs/superpowers/plans/2026-07-11-opportunity-01-contracts-reliability.md and
// packages/pyramid-ingest/src/schema.ts version-policy block):
//   - CURRENT_MANIFEST_SCHEMA = 5, READABLE = [1, 2, 4, 5]
//   - JXTC index offsets are ABSOLUTE byte offsets from byte zero of the file
//     (matches the canonical C++ writer at bridge.cpp:1925-1931).
//
// Historical manifest fixtures (v1/v2/v4) reflect real on-disk shapes emitted by
// pyramid-ingest at those schema versions. The v5 fixture reflects the *target*
// additive shape (TilingDescriptor + OrientationDescriptor). Malformed siblings
// pin the rejection contract.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const out = (name, bytes) => {
  const path = join(HERE, name);
  writeFileSync(path, bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  console.log(`${sha}  ${name}  (${bytes.length} bytes)`);
};

const json = (obj) => Buffer.from(JSON.stringify(obj, null, 2) + "\n", "utf8");

// ── Historical manifests ─────────────────────────────────────────────────────

// v1: earliest shape. orientation "baked"|"source" string; geometry optional but
// present here; producedBy present. Matches manifestSchemaV1 in schema.ts.
out(
  "manifest-v1.json",
  json({
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
    producedBy: {
      tool: "pyramid-ingest",
      version: "0.1.0",
      encoder: { effort: 3, quality: { grid: 85, big: 95, proxy: 85 } },
    },
  }),
);

// v2: discriminated bump (V3 Phase2). Same fields as v1 + schema:2. This is what
// buildManifest emits today.
out(
  "manifest-v2.json",
  json({
    schema: 2,
    imageId: "1122334455667788",
    master: { name: "IMG_4242.CR2", format: "cr2", mtimeMs: 1717700000000 },
    orientation: "baked",
    width: 6000,
    height: 4000,
    aspect: 1.5,
    levels: [
      { size: 512, w: 512, h: 341, bytes: 12000, bitsPerSample: 8, contenthash: "aaaabbbbccccdddd", tiled: false },
      { size: "full", w: 6000, h: 4000, bytes: 1500000, bitsPerSample: 8, contenthash: "1111222233334444", tiled: false },
    ],
    proxy: true,
    producedBy: {
      tool: "pyramid-ingest",
      version: "0.1.0",
      encoder: { effort: 3, quality: { grid: 85, big: 95, proxy: 85 } },
    },
  }),
);

// v4: index-norm additive bump. Adds a tiled top level + tiling grid + layout
// marker + qualityCurve + convergedByteEnd — the richest historical shape.
out(
  "manifest-v4.json",
  json({
    schema: 4,
    imageId: "aabbccddeeff0011",
    master: { name: "DSC09000.ARW", format: "arw", mtimeMs: 1717800000000 },
    orientation: "source",
    width: 9504,
    height: 6336,
    aspect: 1.5,
    layout: "sharded-2",
    levels: [
      { size: 512, w: 512, h: 341, bytes: 12000, bitsPerSample: 8, contenthash: "5555666677778888", tiled: false },
      {
        size: "full",
        w: 9504,
        h: 6336,
        bytes: 3200000,
        bitsPerSample: 8,
        contenthash: "99aabbccddeeff00",
        tiled: true,
        tiling: { tileSize: 512, cols: 19, rows: 13 },
        convergedByteEnd: 2100000,
        qualityCurve: [
          { bytes: 800000, butteraugli: 2.4 },
          { bytes: 2100000, ssim: 0.9996, butteraugli: 1.05 },
        ],
      },
    ],
    producedBy: {
      tool: "pyramid-ingest",
      version: "0.1.0",
      encoder: { effort: 3, quality: { grid: 85, big: 95, proxy: 85 } },
    },
  }),
);

// v5: TARGET additive shape (not yet implemented in schema.ts). Adds an explicit
// TilingDescriptor { container, version, tileSize, bitsPerSample, offsetBase } and
// OrientationDescriptor { exif, pixels }. Pins intent for Task 4.
out(
  "manifest-v5.json",
  json({
    schema: 5,
    imageId: "deadbeefcafef00d",
    master: {
      name: "P1000001.RW2",
      // provenance decoupled from decoder capability (finding 64)
      sourceFormat: "rw2",
      format: "rw2",
      mtimeMs: 1717900000000,
    },
    // OrientationDescriptor: exact EXIF value + whether pixels are baked upright.
    orientation: { exif: 6, pixels: "baked-upright" },
    width: 5184,
    height: 3888,
    aspect: 1.3333,
    levels: [
      { size: 512, w: 512, h: 384, bytes: 15000, bitsPerSample: 8, contenthash: "abcdef0123456789", tiled: false },
      {
        size: "full",
        w: 5184,
        h: 3888,
        bytes: 2400000,
        bitsPerSample: 8,
        contenthash: "fedcba9876543210",
        tiled: true,
        // TilingDescriptor persisted on the level.
        tiling: { container: "jxtc", version: 1, tileSize: 512, bitsPerSample: 8, offsetBase: "file" },
      },
    ],
    producedBy: {
      tool: "pyramid-ingest",
      version: "0.1.0",
      encoder: { effort: 3, quality: { grid: 85, big: 95, proxy: 85 } },
    },
  }),
);

// ── Malformed manifest siblings (rejection contract) ─────────────────────────

// unsupported schema: 3 was skipped historically; 99 is a future major.
out(
  "manifest-unsupported-schema.json",
  json({
    schema: 3,
    imageId: "9f86d081884c7d65",
    master: { name: "x.orf", format: "orf", mtimeMs: 1 },
    orientation: "baked",
    width: 10,
    height: 10,
    aspect: 1,
    levels: [{ size: "full", w: 10, h: 10, bytes: 9, bitsPerSample: 8, contenthash: "a1b2c3d4e5f60718", tiled: false }],
  }),
);

// invalid orientation: exif outside 1-8 (v5 OrientationDescriptor). Must reject.
out(
  "manifest-invalid-orientation.json",
  json({
    schema: 5,
    imageId: "9f86d081884c7d65",
    master: { name: "x.orf", sourceFormat: "orf", format: "orf", mtimeMs: 1 },
    orientation: { exif: 9, pixels: "baked-upright" },
    width: 10,
    height: 10,
    aspect: 1,
    levels: [{ size: "full", w: 10, h: 10, bytes: 9, bitsPerSample: 8, contenthash: "a1b2c3d4e5f60718", tiled: false }],
  }),
);

// missing tiling descriptor: level marked tiled:true but no tiling block. Must reject.
out(
  "manifest-missing-tiling.json",
  json({
    schema: 5,
    imageId: "9f86d081884c7d65",
    master: { name: "x.orf", sourceFormat: "orf", format: "orf", mtimeMs: 1 },
    orientation: { exif: 1, pixels: "source" },
    width: 5184,
    height: 3888,
    aspect: 1.3333,
    levels: [{ size: "full", w: 5184, h: 3888, bytes: 2400000, bitsPerSample: 8, contenthash: "fedcba9876543210", tiled: true }],
  }),
);

// ── JXTC binary fixtures ─────────────────────────────────────────────────────

const JXTC_MAGIC = 0x4354584a; // 'JXTC' little-endian
const HEADER_BYTES = 32;
const INDEX_ENTRY_BYTES = 8;

/**
 * Build a JXTC v1 container with ABSOLUTE index offsets (matches bridge.cpp).
 * tiles: array of { len } — tile payload lengths (payload = filler bytes; the
 * fixture pins the index/offset contract, not JXL decodability).
 */
function buildJxtc({ version, imageW, imageH, tileSize, tilesX, tilesY, flags, tiles, corrupt }) {
  const tileCount = tilesX * tilesY;
  if (tiles.length !== tileCount) throw new Error("tiles length must equal tilesX*tilesY");
  const dataBase = HEADER_BYTES + tileCount * INDEX_ENTRY_BYTES;
  const totalPayload = tiles.reduce((s, t) => s + t.len, 0);
  const buf = Buffer.alloc(dataBase + totalPayload);

  buf.writeUInt32LE(JXTC_MAGIC, 0);
  buf.writeUInt32LE(version, 4);
  buf.writeUInt32LE(imageW, 8);
  buf.writeUInt32LE(imageH, 12);
  buf.writeUInt32LE(tileSize, 16);
  buf.writeUInt32LE(tilesX, 20);
  buf.writeUInt32LE(tilesY, 24);
  buf.writeUInt32LE(flags, 28);

  let cursor = dataBase; // ABSOLUTE: first tile data starts here.
  for (let i = 0; i < tileCount; i++) {
    const len = tiles[i].len;
    let off = cursor; // absolute offset from byte zero.
    if (corrupt === "offset-inside-index" && i === 0) off = HEADER_BYTES + 4; // inside index table
    if (corrupt === "overflow" && i === tileCount - 1) off = 0xfffffff0; // off + len overflows past EOF
    buf.writeUInt32LE(off, HEADER_BYTES + i * INDEX_ENTRY_BYTES);
    buf.writeUInt32LE(len, HEADER_BYTES + i * INDEX_ENTRY_BYTES + 4);
    // deterministic non-zero filler payload (tile index in every byte)
    for (let j = 0; j < len; j++) buf[cursor + j] = (i + 1) & 0xff;
    cursor += len;
  }
  return buf;
}

// Well-formed v1: 2x1 grid, TWO DIFFERENT tile lengths (16 and 24).
// First absolute offset must equal 32 + tileCount*8 = 32 + 16 = 48.
out(
  "jxtc-v1.bin",
  buildJxtc({
    version: 1,
    imageW: 1024,
    imageH: 512,
    tileSize: 512,
    tilesX: 2,
    tilesY: 1,
    flags: 1, // hasAlpha, 8-bit
    tiles: [{ len: 16 }, { len: 24 }],
  }),
);

// Malformed: first tile offset points inside the index table.
out(
  "jxtc-offset-inside-index.bin",
  buildJxtc({
    version: 1,
    imageW: 1024,
    imageH: 512,
    tileSize: 512,
    tilesX: 2,
    tilesY: 1,
    flags: 1,
    tiles: [{ len: 16 }, { len: 24 }],
    corrupt: "offset-inside-index",
  }),
);

// Malformed: last tile offset+length overflows past end of file.
out(
  "jxtc-overflow.bin",
  buildJxtc({
    version: 1,
    imageW: 1024,
    imageH: 512,
    tileSize: 512,
    tilesX: 2,
    tilesY: 1,
    flags: 1,
    tiles: [{ len: 16 }, { len: 24 }],
    corrupt: "overflow",
  }),
);
