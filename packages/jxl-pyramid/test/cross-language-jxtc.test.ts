// Cross-language JXTC offset contract (Packet-1 finding 60).
//
// INVARIANT: every JXTC index offset is an ABSOLUTE byte offset from byte zero of
// the complete JXTC file. The canonical C++ writer (bridge.cpp:1925-1931) writes
// `cursor = 32 + tileCount*8` as the first offset and stores the absolute cursor
// per tile. Readers must (a) treat the stored value as absolute and (b) reject
// offsets that land inside the header/index or whose checked `offset + length`
// runs past EOF.
//
// HISTORY: Task 1 pinned this as RED. The TypeScript reader in tiling.ts used to
// treat the stored offset as RELATIVE to the end of the header+index table
// (`dataBase = 32 + numTiles*8; container.subarray(dataBase + off, ...)`), which
// double-added the base and seeked past the fixture's tile payload. Task 3 removed
// the `dataBase + off` rebasing so `JxtcTileIndex.offsets` are absolute and extract
// uses overflow-safe checked bounds — these assertions are now GREEN.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseJxtcHeader,
  getOrParseJxtcTileIndex,
  extractTileBitstream,
  isJxtcContainer,
} from "../src/tiling.js";

// Fixtures live in the pyramid-ingest package (the persisted-contract owner).
const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "..", "..", "pyramid-ingest", "test", "fixtures", "contracts");
const readFixture = (name: string) => new Uint8Array(readFileSync(join(FIX, name)));

const HEADER_BYTES = 32;
const INDEX_ENTRY_BYTES = 8;

test("jxtc-v1 fixture is a JXTC container with a valid v1 header", () => {
  const bytes = readFixture("jxtc-v1.bin");
  expect(isJxtcContainer(bytes)).toBe(true);
  const h = parseJxtcHeader(bytes);
  expect(h.version).toBe(1);
  expect(h.imageW).toBe(1024);
  expect(h.imageH).toBe(512);
  expect(h.tileSize).toBe(512);
  expect(h.tilesX).toBe(2);
  expect(h.tilesY).toBe(1);
});

test("first ABSOLUTE index offset equals 32 + tileCount*8", () => {
  const bytes = readFixture("jxtc-v1.bin");
  const h = parseJxtcHeader(bytes);
  const tileCount = h.tilesX * h.tilesY;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Read the raw stored offset for tile 0 directly from the index table.
  const rawFirstOffset = view.getUint32(HEADER_BYTES, true);
  expect(rawFirstOffset).toBe(HEADER_BYTES + tileCount * INDEX_ENTRY_BYTES); // 32 + 2*8 = 48
});

test("the fixture has two DIFFERENT tile lengths (16 and 24)", () => {
  const bytes = readFixture("jxtc-v1.bin");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len0 = view.getUint32(HEADER_BYTES + 4, true);
  const len1 = view.getUint32(HEADER_BYTES + INDEX_ENTRY_BYTES + 4, true);
  expect(len0).toBe(16);
  expect(len1).toBe(24);
  expect(len0).not.toBe(len1);
});

test("the reader exposes ABSOLUTE offsets (no data-base rebasing)", () => {
  // CONTRACT: the parsed index offsets are absolute from byte zero. Task 3 makes
  // this true. Today the reader stores raw offsets in `offsets` and a separate
  // `dataBase`, and extract does `dataBase + off` — so `offsets[0]` is 48 but the
  // reader ADDS dataBase (48) again on extract. This assertion documents the
  // target: offsets[0] is absolute AND extract does not rebase.
  const bytes = readFixture("jxtc-v1.bin");
  const h = parseJxtcHeader(bytes);
  const idx = getOrParseJxtcTileIndex(bytes, h);
  const tileCount = h.tilesX * h.tilesY;
  const absFirst = HEADER_BYTES + tileCount * INDEX_ENTRY_BYTES; // 48
  // Absolute offset of tile 0 = 48; tile 1 = 48 + 16 = 64.
  expect(idx.offsets[0]).toBe(absFirst);
  expect(idx.offsets[1]).toBe(absFirst + 16);
});

test("extractTileBitstream returns each tile's exact absolute payload", () => {
  const bytes = readFixture("jxtc-v1.bin");
  const h = parseJxtcHeader(bytes);
  // Tile 0 covers x in [0,512), tile 1 covers x in [512,1024).
  const t0 = extractTileBitstream(bytes, { x: 0, y: 0, w: 512, h: 512 }, h);
  const t1 = extractTileBitstream(bytes, { x: 512, y: 0, w: 512, h: 512 }, h);
  expect(t0.length).toBe(16);
  expect(t1.length).toBe(24);
  // Payload filler is (tileIndex+1) in every byte (see generate-fixtures.mjs).
  expect([...new Set(t0)]).toEqual([1]);
  expect([...new Set(t1)]).toEqual([2]);
});

// ── Malformed containers: readers reject ─────────────────────────────────────

test("offset pointing inside the header/index is rejected", () => {
  const bytes = readFixture("jxtc-offset-inside-index.bin");
  const h = parseJxtcHeader(bytes);
  expect(() => extractTileBitstream(bytes, { x: 0, y: 0, w: 512, h: 512 }, h)).toThrow();
});

test("checked offset + length beyond EOF is rejected", () => {
  const bytes = readFixture("jxtc-overflow.bin");
  const h = parseJxtcHeader(bytes);
  // Tile 1 (x in [512,1024)) has an overflowing offset+length.
  expect(() => extractTileBitstream(bytes, { x: 512, y: 0, w: 512, h: 512 }, h)).toThrow();
});

// ── Cross-language absolute-offset golden (Task 3) ───────────────────────────
//
// The SAME on-disk fixture bytes are the shared contract for THREE readers:
//   - C++    DecodeRgba8TileContainerRegion (bridge.cpp:1940-1988)
//   - TS     extractTileBitstream           (tiling.ts)
//   - Rust   jxtc_tile_stream               (jxl_casadecoder.rs)
// Every reader treats each index offset as ABSOLUTE from byte 0, and rejects
// offsets inside the header/index and (overflow-safely) offset+length past EOF.
//
// The two writers produce byte-identical layout:
//   C++  bridge.cpp:1925  cursor = header_bytes + index_bytes; index[i]=cursor; cursor+=len
//   Rust build_jxtc       payload_start = HEADER + tiles*ENTRY;  off = cursor; cursor += len
// so this single fixture stands in for a C++-produced AND a Rust-produced file.
// The Rust reader is exercised against these identical bytes in
// crates/raw-pipeline/src/jxl_casadecoder.rs (test module: cross_language_*).
//
// OVERFLOW-SAFE GUARD (carry-forward from Task-1 review): the upper-bound check
// must never add `offset + length` in a fixed-width type, because on wasm32
// `size_t` is 32-bit and 0xFFFFFFF0 + 24 WRAPS to 0x8 (< input_size) — sneaking a
// malformed tile past the guard. After the lower-bound check (offset >= indexEnd,
// which guarantees offset <= input_size once offset is in range), the safe form is:
//     length > input_size - offset      // no addition that can wrap
// C++  : if (offset < indexEnd || length > input_size - offset)   → reject
// TS   : if (offset < indexEnd || length > byteLength - offset)   → reject  (JS numbers don't wrap, but we mirror the shape)
// Rust : off.checked_add(len) ... end > container.len()           → checked_add can't wrap
test("the fixture layout matches BOTH the C++ and Rust writer formulas (absolute)", () => {
  const bytes = readFixture("jxtc-v1.bin");
  const h = parseJxtcHeader(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tileCount = h.tilesX * h.tilesY;
  const payloadStart = HEADER_BYTES + tileCount * INDEX_ENTRY_BYTES;
  // Walk the index exactly as each writer built it: absolute cursor from payloadStart.
  let cursor = payloadStart;
  for (let i = 0; i < tileCount; i++) {
    const off = view.getUint32(HEADER_BYTES + i * INDEX_ENTRY_BYTES, true);
    const len = view.getUint32(HEADER_BYTES + i * INDEX_ENTRY_BYTES + 4, true);
    expect(off).toBe(cursor); // ABSOLUTE, not relative to payloadStart
    cursor += len;
  }
  expect(cursor).toBe(bytes.byteLength); // no trailing/short bytes
});

test("TS reader extracts byte-identical absolute payloads for every tile", () => {
  // Golden bytes for the shared fixture: filler is (tileIndex+1) repeated.
  const bytes = readFixture("jxtc-v1.bin");
  const h = parseJxtcHeader(bytes);
  const idx = getOrParseJxtcTileIndex(bytes, h);
  const tileCount = h.tilesX * h.tilesY;
  for (let i = 0; i < tileCount; i++) {
    const off = idx.offsets[i]!; // absolute
    const len = idx.lengths[i]!;
    const payload = bytes.subarray(off, off + len);
    // Every byte equals (i+1) — the deterministic filler in generate-fixtures.mjs.
    expect([...new Set(payload)]).toEqual([i + 1]);
    expect(payload.length).toBe(i === 0 ? 16 : 24);
  }
});

test("overflow fixture: offset+length is caught by the overflow-SAFE upper bound", () => {
  // jxtc-overflow.bin sets tile 1 offset = 0xFFFFFFF0, length = 24.
  // A naive `offset + length > byteLength` in 32-bit arithmetic WRAPS
  // (0xFFFFFFF0 + 24 = 0x8) and passes — the bug. The safe check
  // `length > byteLength - offset` rejects it (offset itself already exceeds EOF).
  const bytes = readFixture("jxtc-overflow.bin");
  const h = parseJxtcHeader(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const off = view.getUint32(HEADER_BYTES + INDEX_ENTRY_BYTES, true); // tile 1 offset
  expect(off).toBe(0xfffffff0);
  // The reader must throw (does not silently wrap into a valid-looking range).
  expect(() => extractTileBitstream(bytes, { x: 512, y: 0, w: 512, h: 512 }, h)).toThrow();
});
