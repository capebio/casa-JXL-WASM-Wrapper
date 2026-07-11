// AI-ID proxy encoder + source-priority chain.
import sharp from "sharp";

export const DEFAULT_MAX_EDGE = 768;
export const DEFAULT_QUALITY = 80;

/** Node JPEG encoder: RGBA raw → JPEG q, 4:2:0. */
export async function nodeEncodeJpeg(rgba, w, h, quality) {
  const buf = await sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width: w, height: h, channels: 4 } })
    .jpeg({ quality, chromaSubsampling: "4:2:0" })
    .toBuffer();
  return new Uint8Array(buf);
}

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
  const encodeJpeg = opts.encodeJpeg ?? nodeEncodeJpeg;
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
