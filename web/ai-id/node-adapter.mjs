// AI-ID Node adapter — Node-only implementations for the AI-ID source chain.
// Imports sharp (native Node module) and embedded-preview.mjs (uses node:fs).
// Do NOT import from a browser context — use browser-adapter.js there.

import sharp from "sharp";
import { extractPreview } from "./embedded-preview.mjs";
import { liveBufferSource, pyramidLevelSource, masterDecodeSource, rawDecodeSource } from "./sources.mjs";
import { buildSidecar } from "./sidecar.mjs";

/** Node JPEG encoder: RGBA Uint8Array → JPEG Uint8Array at quality q, 4:2:0. */
export async function nodeEncodeJpeg(rgba, w, h, quality) {
  const buf = await sharp(
    Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength),
    { raw: { width: w, height: h, channels: 4 } },
  )
    .jpeg({ quality, chromaSubsampling: "4:2:0" })
    .toBuffer();
  return new Uint8Array(buf);
}

/**
 * Camera embedded-preview source (Node-only: reads the RAW file from disk via
 * node:fs, decodes the largest viewable JPEG with sharp).
 * Rejects previews below `minEdge` long-edge (default 768 px).
 */
export function embeddedPreviewSource(path, { minEdge = 768 } = {}) {
  return {
    label: "embedded-preview",
    get: async () => {
      let p;
      try { p = extractPreview(path); } catch { return null; }
      if (Math.max(p.w, p.h) < minEdge) return null;
      const { data, info } = await sharp(Buffer.from(p.buffer))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return {
        rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        w: info.width,
        h: info.height,
      };
    },
  };
}

/**
 * Build the full Node source chain:
 *   live-buffer → pyramid → embedded-preview → master → raw
 *
 * All IO dependencies are injected so tests can stub them.
 *
 * @param {{
 *   liveRgba?: Uint8Array|null, liveW?: number, liveH?: number,
 *   getJxlPyramidBytes: () => Promise<Uint8Array|null>,
 *   getMasterBytes: () => Promise<Uint8Array|null>,
 *   decodeJxl: (bytes: Uint8Array) => Promise<{data: Uint8Array, width: number, height: number}>,
 *   decodeRaw: (path: string) => Promise<{rgb: Uint8Array, width: number, height: number}>,
 *   rgbToRgba: (rgb: Uint8Array) => Uint8Array,
 *   assetPath: string,
 *   minEdge?: number,
 * }} opts
 * @returns {Array<{ label: string, get: () => Promise<{rgba, w, h}|null> }>}
 */
export function makeNodeSources(opts) {
  return [
    liveBufferSource(opts.liveRgba ?? null, opts.liveW ?? 0, opts.liveH ?? 0),
    pyramidLevelSource(opts.getJxlPyramidBytes, opts.decodeJxl),
    embeddedPreviewSource(opts.assetPath, { minEdge: opts.minEdge ?? 768 }),
    masterDecodeSource(opts.getMasterBytes, opts.decodeJxl),
    rawDecodeSource(opts.assetPath, opts.decodeRaw, opts.rgbToRgba),
  ];
}

// Re-export the pure buildSidecar for callers that only need the Node chain.
export { buildSidecar };
