// AI-ID proxy encoder + source-priority chain.
// Pure: no Node built-ins, no sharp. The Node-only encoder (nodeEncodeJpeg)
// has moved to node-adapter.mjs; the browser encoder lives in browser-adapter.js.

export const DEFAULT_MAX_EDGE = 768;
export const DEFAULT_QUALITY = 80;

/** Downscale target dims for a long-edge cap, preserving aspect. Returns null if no downscale needed. */
function targetDims(w, h, maxEdge) {
  const long = Math.max(w, h);
  if (long <= maxEdge) return null;
  const s = maxEdge / long;
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** Downscale (direct, single-step) to maxEdge then JPEG-encode 4:2:0. */
export async function encodeProxyJpeg(rgba, w, h, opts = {}) {
  const maxEdge = opts.maxEdge ?? DEFAULT_MAX_EDGE;
  const quality = opts.quality ?? DEFAULT_QUALITY;
  const downscaleRgba = opts.downscaleRgba;
  // encodeJpeg is REQUIRED and injected by the caller: browser callers pass a
  // canvas/OffscreenCanvas encoder (browser-adapter.js); Node callers pass
  // node-adapter.nodeEncodeJpeg. This module stays free of Node/sharp/DOM.
  const encodeJpeg = opts.encodeJpeg;
  if (typeof encodeJpeg !== "function") {
    throw new Error(
      "proxy: encodeJpeg is required (browser: canvas/OffscreenCanvas; node: node-adapter.nodeEncodeJpeg)",
    );
  }
  const t = targetDims(w, h, maxEdge);
  let ow = w, oh = h, buf = rgba;
  if (t) {
    if (!downscaleRgba) throw new Error("encodeProxyJpeg: downscaleRgba required to resize");
    buf = downscaleRgba(rgba, w, h, t.w, t.h);
    ow = t.w; oh = t.h;
  }
  const jpeg = await encodeJpeg(buf, ow, oh, quality);
  return { jpeg, w: ow, h: oh };
}

/** Walk ordered sources; encode the first that yields pixels. Throws if none do. */
export async function resolveProxy(sources, opts = {}) {
  for (const src of sources) {
    const r = await src.get();
    if (r && r.rgba) {
      const enc = await encodeProxyJpeg(r.rgba, r.w, r.h, opts);
      return { ...enc, source: src.label };
    }
  }
  throw new Error("no proxy source available");
}
