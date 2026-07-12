// node --test  web/ai-id/browser-adapter.test.mjs
//
// Tests for Milestone 2 (finding 16): AI-ID browser/Node split.
//
// Assertions:
//   1. The browser-adapter imports NO Node built-ins (node:fs, node:path, etc.)
//      and does NOT import 'sharp'.
//   2. The source fallback ORDER is: live-buffer → pyramid → embedded-preview → master → RAW.
//   3. sidecar + manifest are tied to stable asset identity (makeAssetId) and
//      the privacy policy (keep/strip-gps/strip-all from ExportService).
//   4. pure proxy logic (encodeProxyJpeg / resolveProxy) has zero Node imports.
//   5. pure source constructors (liveBufferSource, pyramidLevelSource,
//      masterDecodeSource, rawDecodeSource) have zero Node imports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));

// ── 1. browser-adapter.js must not import any Node built-ins ─────────────────

test("browser-adapter.js contains no node: imports and no 'sharp' import", () => {
  const src = readFileSync(join(__dir, "browser-adapter.js"), "utf-8");
  // Only match actual import statements (start of line, not in comments).
  const importLines = src.split("\n").filter((l) => /^\s*import\b/.test(l));
  assert.equal(
    importLines.some((l) => /['"]node:/.test(l)), false,
    "browser-adapter.js must not import any node: module",
  );
  assert.equal(
    importLines.some((l) => /['"]sharp['"]/.test(l)), false,
    "browser-adapter.js must not import sharp",
  );
});

// ── 2. proxy.mjs pure core has no Node imports ───────────────────────────────

test("proxy.mjs pure logic has no node: imports and no 'sharp' import", () => {
  const src = readFileSync(join(__dir, "proxy.mjs"), "utf-8");
  const importLines = src.split("\n").filter((l) => /^\s*import\b/.test(l));
  assert.equal(
    importLines.some((l) => /['"]node:/.test(l)), false,
    "proxy.mjs must not import node: modules",
  );
  assert.equal(
    importLines.some((l) => /['"]sharp['"]/.test(l)), false,
    "proxy.mjs must not import sharp (moved to node-adapter.mjs)",
  );
});

// ── 3. sources.mjs pure exports have no Node imports ─────────────────────────

test("sources.mjs has no node: or sharp imports (embeddedPreviewSource moved to node-adapter)", () => {
  const src = readFileSync(join(__dir, "sources.mjs"), "utf-8");
  const importLines = src.split("\n").filter((l) => /^\s*import\b/.test(l));
  assert.equal(
    importLines.some((l) => /['"]node:/.test(l)), false,
    "sources.mjs must not import node: modules",
  );
  assert.equal(
    importLines.some((l) => /['"]sharp['"]/.test(l)), false,
    "sources.mjs must not import sharp",
  );
  // embedded-preview.mjs uses node:fs, must not be statically imported here
  assert.equal(
    importLines.some((l) => /['"]\.\/embedded-preview\.mjs['"]/.test(l)), false,
    "sources.mjs must not statically import embedded-preview.mjs (Node-only)",
  );
});

// ── 4. Source fallback ORDER exposed from browser-adapter ────────────────────

test("browser-adapter.js exports makeBrowserSources function", async () => {
  const mod = await import("./browser-adapter.js");
  assert.equal(typeof mod.makeBrowserSources, "function",
    "browser-adapter.js must export makeBrowserSources()");
});

test("makeBrowserSources fallback order: live-buffer → pyramid → master → raw", async () => {
  const { makeBrowserSources } = await import("./browser-adapter.js");
  // Build with only required injections stubbed.
  const sources = makeBrowserSources({
    liveRgba: new Uint8Array(4 * 4 * 4),
    liveW: 4, liveH: 4,
    getJxlPyramidBytes: async () => null,
    getMasterBytes: async () => null,
    decodeJxl: async (b) => ({ data: new Uint8Array(2 * 2 * 4), width: 2, height: 2 }),
    decodeRaw: async () => ({ rgb: new Uint8Array(2 * 2 * 3), width: 2, height: 2 }),
    rgbToRgba: (rgb) => new Uint8Array(2 * 2 * 4),
    assetPath: "P001.ORF",
  });
  const labels = sources.map((s) => s.label);
  // live-buffer must come first
  assert.equal(labels[0], "buffer", "first source must be live-buffer");
  // pyramid must come before master
  const pyramidIdx = labels.indexOf("pyramid");
  const masterIdx = labels.indexOf("master");
  const rawIdx = labels.indexOf("raw");
  assert.ok(pyramidIdx !== -1, "sources must include pyramid");
  assert.ok(masterIdx !== -1, "sources must include master");
  assert.ok(rawIdx !== -1, "sources must include raw");
  assert.ok(pyramidIdx < masterIdx, "pyramid must come before master");
  assert.ok(masterIdx < rawIdx, "master must come before raw");
});

test("makeBrowserSources live-buffer source returns pixels when present", async () => {
  const { makeBrowserSources } = await import("./browser-adapter.js");
  const rgba = new Uint8Array(4 * 4 * 4);
  const sources = makeBrowserSources({
    liveRgba: rgba, liveW: 4, liveH: 4,
    getJxlPyramidBytes: async () => null,
    getMasterBytes: async () => null,
    decodeJxl: async () => ({ data: new Uint8Array(4), width: 2, height: 2 }),
    decodeRaw: async () => ({ rgb: new Uint8Array(4), width: 2, height: 2 }),
    rgbToRgba: (rgb) => new Uint8Array(4),
    assetPath: "P001.ORF",
  });
  const bufSrc = sources.find((s) => s.label === "buffer");
  const result = await bufSrc.get();
  assert.equal(result.rgba, rgba);
  assert.equal(result.w, 4);
  assert.equal(result.h, 4);
});

test("makeBrowserSources pyramid source returns null when bytes unavailable", async () => {
  const { makeBrowserSources } = await import("./browser-adapter.js");
  const sources = makeBrowserSources({
    liveRgba: null, liveW: 0, liveH: 0,
    getJxlPyramidBytes: async () => null,
    getMasterBytes: async () => null,
    decodeJxl: async () => ({ data: new Uint8Array(4), width: 2, height: 2 }),
    decodeRaw: async () => ({ rgb: new Uint8Array(4), width: 2, height: 2 }),
    rgbToRgba: (rgb) => new Uint8Array(4),
    assetPath: "P001.ORF",
  });
  const pyr = sources.find((s) => s.label === "pyramid");
  assert.equal(await pyr.get(), null);
});

// ── 5. sidecar tied to stable assetId + privacy policy ───────────────────────

test("buildSidecarForAsset applies strip-gps policy: geo is null in output", async () => {
  const { buildSidecarForAsset } = await import("./browser-adapter.js");
  const sc = buildSidecarForAsset({
    assetId: "abc123:P001.ORF",
    filename: "P001.ORF", sha256: "deadbeef", bytes: 1000, format: "cr2",
    width: 6000, height: 4000, orientationApplied: true,
    datetimeExif: "2026:07:12 10:00:00",
    decoded: { has_gps: true, gps_lat: -25.85, gps_lon: 28.19, gps_alt: 1300 },
    metadataPolicy: "strip-gps",
  });
  assert.equal(sc.geo, null, "strip-gps policy must null geo");
  assert.equal(sc.source.sha256, "deadbeef");
});

test("buildSidecarForAsset keeps geo under 'keep' policy", async () => {
  const { buildSidecarForAsset } = await import("./browser-adapter.js");
  const sc = buildSidecarForAsset({
    assetId: "abc123:P001.ORF",
    filename: "P001.ORF", sha256: "deadbeef", bytes: 1000, format: "cr2",
    width: 6000, height: 4000, orientationApplied: true,
    datetimeExif: "2026:07:12 10:00:00",
    decoded: { has_gps: true, gps_lat: -25.85, gps_lon: 28.19, gps_alt: 1300 },
    metadataPolicy: "keep",
  });
  assert.notEqual(sc.geo, null, "keep policy must retain geo");
  assert.equal(sc.geo.lat, -25.85);
});

test("buildSidecarForAsset strip-all nulls both geo and datetime", async () => {
  const { buildSidecarForAsset } = await import("./browser-adapter.js");
  const sc = buildSidecarForAsset({
    assetId: "abc123:P001.ORF",
    filename: "P001.ORF", sha256: "deadbeef", bytes: 1000, format: "cr2",
    width: 6000, height: 4000, orientationApplied: true,
    datetimeExif: "2026:07:12 10:00:00",
    decoded: { has_gps: true, gps_lat: -25.85, gps_lon: 28.19, gps_alt: 1300 },
    metadataPolicy: "strip-all",
  });
  assert.equal(sc.geo, null, "strip-all must null geo");
  assert.equal(sc.datetime, null, "strip-all must null datetime");
});
