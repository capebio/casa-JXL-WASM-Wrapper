// Proxy source constructors for the source-priority chain (see proxy.mjs / the spec).
// Each returns a `{ label, get }` source; `get()` yields `{ rgba, w, h }` or null.
import { extractPreview } from "./embedded-preview.mjs";

/** Already-decoded pixels (browser lightbox / batch loop). */
export function liveBufferSource(rgba, w, h) {
  return { label: "buffer", get: async () => (rgba ? { rgba, w, h } : null) };
}

/** JXL pyramid 1024 level. getJxlBytes()->Uint8Array|null; decodeJxl(bytes)->{data,width,height}. */
export function pyramidLevelSource(getJxlBytes, decodeJxl) {
  return {
    label: "pyramid",
    get: async () => {
      const bytes = await getJxlBytes();
      if (!bytes) return null;
      const d = await decodeJxl(bytes);
      return { rgba: d.data, w: d.width, h: d.height };
    },
  };
}

/** Camera embedded preview (no decode). Rejects previews below minEdge long-edge (default 768). */
export function embeddedPreviewSource(path, sharpMod, { minEdge = 768 } = {}) {
  return {
    label: "embedded-preview",
    get: async () => {
      let p;
      try { p = extractPreview(path); } catch { return null; }
      if (Math.max(p.w, p.h) < minEdge) return null;
      const { data, info } = await sharpMod(Buffer.from(p.buffer)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), w: info.width, h: info.height };
    },
  };
}

/** Sibling .jxl archival master. getMasterBytes()->Uint8Array|null; decodeJxl(bytes)->{data,width,height}. */
export function masterDecodeSource(getMasterBytes, decodeJxl) {
  return {
    label: "master",
    get: async () => {
      const bytes = await getMasterBytes();
      if (!bytes) return null;
      const d = await decodeJxl(bytes);
      return { rgba: d.data, w: d.width, h: d.height };
    },
  };
}

/** Full RAW re-decode (last resort). decodeRawFn(path)->{rgb,width,height}; rgbToRgba(rgb)->Uint8Array. */
export function rawDecodeSource(path, decodeRawFn, rgbToRgba) {
  return {
    label: "raw",
    get: async () => {
      const d = await decodeRawFn(path);
      return { rgba: new Uint8Array(rgbToRgba(d.rgb)), w: d.width, h: d.height };
    },
  };
}
