// Packet-1 contract fixtures: pins the manifest schema/version policy and the
// read/migrate/reject decision for every committed fixture. These fixtures are
// consumed unchanged by later tasks (Rust, C++, TypeScript, ingest, browser).
//
// EXPECTED INITIAL STATE (Task 1 pins INTENT, not implementation):
//   Some assertions FAIL against the current readers. That is correct — the v5
//   additive schema (TilingDescriptor / OrientationDescriptor) and the version
//   policy constants are not implemented until Task 4. Do NOT "fix" the readers
//   here.

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseManifest } from "../src/schema";
import {
  CURRENT_MANIFEST_SCHEMA,
  READABLE_MANIFEST_SCHEMAS,
} from "../src/schema";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "contracts");

function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIX, name)));
}
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function textOf(name: string): string {
  return new TextDecoder().decode(readFixture(name));
}

// ── Pinned fixture SHA-256 (regenerate with generate-fixtures.mjs) ────────────
// If any of these change, a fixture's bytes changed — every downstream language
// binding that pins the same hash must be updated in lockstep.
const FIXTURE_SHA256: Record<string, string> = {
  "manifest-v1.json": "d479cc3d96f68f4cd54f041e3d1fa1325fe6675ba457c9cee6211e30fa1161e1",
  "manifest-v2.json": "cd5a539273020f334f9cd23bbf6f8c7c77635b0f4928f913e4310e0d2f0dddf2",
  "manifest-v4.json": "a7a67ec169478ba90cd7393644a4d4513f5503f5eecb4c44286d4f0b005b2fdf",
  "manifest-v5.json": "319a2dcb532bcf06a6e1a225ed035d710d7a8088e0a6f2dee726d32dbf431ebb",
  "manifest-unsupported-schema.json": "3b6a32f341cd078eb51809f94891ad6b4c284a81526c4361436cded8a79f2849",
  "manifest-invalid-orientation.json": "6005dac7a5feaeb98c3d2593f6cdb5e3719bd31342311bbc1bf6b688b0a4619f",
  "manifest-missing-tiling.json": "553c6faa5a7f80fa76fd557105f4465336ded0e45bbed19ae6ec63587f0c2605",
  "jxtc-v1.bin": "7d45aff08c6069493718257587a447ecdbe9dc600f29d7ff5debfaf1404bcaa5",
  "jxtc-offset-inside-index.bin": "63aa83c45835a7e0571fb8c00f2748b1962ad4319452ccd4608ed2545d9c23f9",
  "jxtc-overflow.bin": "97534c00bf8472411673e79e3b01a7f10be856fb4da7385ec876253a4c80283b",
};

test("every committed fixture matches its pinned SHA-256", () => {
  for (const [name, expected] of Object.entries(FIXTURE_SHA256)) {
    expect(sha256(readFixture(name))).toBe(expected);
  }
});

// ── Version policy constants (single owner in schema.ts) ─────────────────────

test("schema.ts owns the current schema and the readable-versions list", () => {
  expect(CURRENT_MANIFEST_SCHEMA).toBe(5);
  expect([...READABLE_MANIFEST_SCHEMAS]).toEqual([1, 2, 4, 5]);
});

// ── Read decisions: historical schemas parse (read/migrate) ──────────────────

test("v1 fixture reads (accepted, no migration needed)", () => {
  const m = parseManifest(textOf("manifest-v1.json"));
  expect(m.schema).toBe(1);
  expect(m.imageId).toBe("9f86d081884c7d65");
  expect(m.master.name).toBe("P2200566.ORF");
});

test("v2 fixture reads (accepted)", () => {
  const m = parseManifest(textOf("manifest-v2.json"));
  expect(m.schema).toBe(2);
  expect(m.proxy).toBe(true);
});

test("v4 fixture reads with tiling grid, layout, and qualityCurve preserved", () => {
  const m = parseManifest(textOf("manifest-v4.json"));
  expect(m.schema).toBe(4);
  const full = m.levels?.find((l) => l.size === "full");
  expect(full?.tiled).toBe(true);
  expect(full?.qualityCurve?.length).toBe(2);
});

test("v5 fixture reads (current schema) with OrientationDescriptor and TilingDescriptor", () => {
  const m = parseManifest(textOf("manifest-v5.json")) as any;
  expect(m.schema).toBe(CURRENT_MANIFEST_SCHEMA);
  // OrientationDescriptor: exact EXIF value + baked/source flag.
  expect(m.orientation).toEqual({ exif: 6, pixels: "baked-upright" });
  // Provenance is decoupled from decoder capability (finding 64).
  expect(m.master.sourceFormat).toBe("rw2");
  // TilingDescriptor persisted on the tiled level.
  const full = m.levels?.find((l: any) => l.size === "full");
  expect(full.tiling).toEqual({
    container: "jxtc",
    version: 1,
    tileSize: 512,
    bitsPerSample: 8,
    offsetBase: "file",
  });
});

// ── Reject decisions: malformed siblings must throw ──────────────────────────

test("unsupported schema (3) is rejected", () => {
  expect(() => parseManifest(textOf("manifest-unsupported-schema.json"))).toThrow();
});

test("invalid orientation (exif=9, out of 1-8) is rejected", () => {
  expect(() => parseManifest(textOf("manifest-invalid-orientation.json"))).toThrow();
});

test("tiled level missing its tiling descriptor is rejected", () => {
  expect(() => parseManifest(textOf("manifest-missing-tiling.json"))).toThrow();
});
