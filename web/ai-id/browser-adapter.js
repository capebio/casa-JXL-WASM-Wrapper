// AI-ID browser adapter — browser-only implementations for the AI-ID source chain.
//
// This file contains ZERO Node built-in imports (no node:fs, no node:path, etc.)
// and ZERO 'sharp' imports. It is safe to import from a browser context.
//
// The Node-only equivalents (embedded-preview.mjs, node-adapter.mjs) are NOT
// imported here — they are used exclusively in the CLI / batch Node pipeline.
//
// Exports:
//   makeBrowserSources(opts) → ordered source array for resolveProxy()
//   buildSidecarForAsset(input) → casava-ai/1 sidecar with privacy policy applied

import { liveBufferSource, pyramidLevelSource, masterDecodeSource, rawDecodeSource } from "./sources.mjs";
import { buildSidecar } from "./sidecar.mjs";

// ── makeBrowserSources ───────────────────────────────────────────────────────
//
// Source fallback ORDER (finding 16):
//   1. live-buffer  — already-decoded pixels in the gallery lightbox
//   2. pyramid      — JXL pyramid 1024-px level (OPFS / derived cache)
//   3. master       — sibling .jxl archival master (OPFS / fetch)
//   4. raw          — full RAW re-decode via WASM (last resort)
//
// Note: the browser chain deliberately omits "embedded-preview" (which requires
// node:fs + sharp to parse the binary RAW container from disk). In the browser
// the same role is covered by the pyramid level, which is the browser-native
// low-res source derived at ingest time.

/**
 * Build the browser AI-ID source chain for one asset.
 * All IO is injected so callers (and tests) can stub it.
 *
 * @param {{
 *   liveRgba?: Uint8Array|null, liveW?: number, liveH?: number,
 *   getJxlPyramidBytes: () => Promise<Uint8Array|null>,
 *   getMasterBytes: () => Promise<Uint8Array|null>,
 *   decodeJxl: (bytes: Uint8Array) => Promise<{data: Uint8Array, width: number, height: number}>,
 *   decodeRaw: (path: string) => Promise<{rgb: Uint8Array, width: number, height: number}>,
 *   rgbToRgba: (rgb: Uint8Array) => Uint8Array,
 *   assetPath: string,
 * }} opts
 * @returns {Array<{ label: string, get: () => Promise<{rgba: Uint8Array, w: number, h: number}|null> }>}
 */
export function makeBrowserSources(opts) {
  return [
    liveBufferSource(opts.liveRgba ?? null, opts.liveW ?? 0, opts.liveH ?? 0),
    pyramidLevelSource(opts.getJxlPyramidBytes, opts.decodeJxl),
    masterDecodeSource(opts.getMasterBytes, opts.decodeJxl),
    rawDecodeSource(opts.assetPath, opts.decodeRaw, opts.rgbToRgba),
  ];
}

// ── buildSidecarForAsset ─────────────────────────────────────────────────────
//
// Wraps buildSidecar with the stable asset identity (assetId from makeAssetId,
// P4 T2) and the ExportService metadata privacy policy (keep/strip-gps/strip-all,
// P4 T4 / finding 44).
//
// Policy rules (mirrors applyMetadataPolicy in export-service.js):
//   keep      → geo and datetime are preserved as-is
//   strip-gps → geo is nulled; datetime kept
//   strip-all → both geo and datetime are nulled

/**
 * Build a casava-ai/1 sidecar for a browser asset, applying the privacy policy
 * (keep / strip-gps / strip-all) from the ExportService (finding 44).
 *
 * @param {{
 *   assetId: string,              // stable identity from makeAssetId (P4 T2)
 *   filename: string,
 *   sha256: string,
 *   bytes: number,
 *   format: string,
 *   width: number,
 *   height: number,
 *   orientationApplied: boolean,
 *   datetimeExif: string,
 *   decoded: object,              // { has_gps, gps_lat, gps_lon, gps_alt }
 *   metadataPolicy: 'keep'|'strip-gps'|'strip-all',
 * }} input
 * @returns {object} casava-ai/1 sidecar object
 */
export function buildSidecarForAsset(input) {
  // Build the base sidecar (full geo + datetime).
  const sc = buildSidecar({
    filename: input.filename,
    sha256: input.sha256,
    bytes: input.bytes,
    format: input.format,
    width: input.width,
    height: input.height,
    orientationApplied: input.orientationApplied,
    datetimeExif: input.datetimeExif,
    decoded: input.decoded,
  });

  // Apply privacy policy (finding 44 / ExportService contract).
  const policy = input.metadataPolicy ?? "keep";
  if (policy === "strip-gps" || policy === "strip-all") {
    sc.geo = null;
  }
  if (policy === "strip-all") {
    sc.datetime = null;
  }

  // Embed the stable asset identity so the sidecar can be matched back to the
  // asset-state-store entry (P4 T2) without relying on filename alone.
  sc.source.assetId = input.assetId;

  return sc;
}
