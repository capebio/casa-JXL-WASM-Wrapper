// Cross-language JXTC offset contract (Packet-1 finding 60).
//
// INVARIANT: every JXTC index offset is an ABSOLUTE byte offset from byte zero of
// the complete JXTC file. The canonical C++ writer (bridge.cpp:1925-1931) writes
// `cursor = 32 + tileCount*8` as the first offset and stores the absolute cursor
// per tile. Readers must (a) treat the stored value as absolute and (b) reject
// offsets that land inside the header/index or whose checked `offset + length`
// runs past EOF.
//
// EXPECTED INITIAL STATE: the current TypeScript reader in tiling.ts treats the
// stored offset as RELATIVE to the end of the header+index table
// (`dataBase = 32 + numTiles*8; container.subarray(dataBase + off, ...)`), which
// double-adds the base and seeks past the fixture's tile payload. The absolute
// contract assertions below therefore FAIL until Task 3 removes `dataBase + off`.
// That is the point of Task 1: pin intent, not fix the reader.

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
