// web/lightbox/tiled-decode-worker.js
// Tiled-decode worker for the jxl-pyramid pool. Speaks the versioned v:1 protocol
// (see packages/jxl-pyramid/src/worker-protocol.ts).
//
// Protocol:
//   ← {v:1,type:'ready'}                                       (posted on startup)
//   → {v:1,type:'load',bytesId,bytes}                          store whole container, no reply
//   → {v:1,type:'load',bytesId,sab,byteLength}                 store SAB-backed container view, no reply
//   → {v:1,type:'load',bytesId,ranges:[{offset,length,bytes}]} store per-tile ranges (finding 79)
//   → {v:1,type:'decode',id,bytesId,region:{x,y,w,h},format}   decode a region
//   ← {v:1,type:'decode-reply',id,ok:true,pixels,w,h}          transfer [pixels.buffer]
//   ← {v:1,type:'decode-reply',id,ok:false,error:{code,message,stack}}
//   → {v:1,type:'unload',bytesId}                              release stored bytes for bytesId
//   ← {v:1,type:'unload-ack',bytesId}
//   → {v:1,type:'cancel',id}                                   best-effort no-op
//
// Bytes are stored once per bytesId and reused across many decode requests. A byte budget
// with LRU eviction bounds the worker's retained memory (finding 80); explicit unload frees
// eagerly. SAB-backed loads are held BY REFERENCE (no .slice() into ownership — finding 80).

import { decodeTileContainerRegionRgba8, decodeTileContainerRegionRgba16, preloadJxlModule } from '../../packages/jxl-wasm/dist/index.js';
import { createWorkerStore } from './worker-store.js';

try { preloadJxlModule(); } catch { /* optional warm-up */ }

const JXTC_MAGIC = 0x4354584a; // 'JXTC' little-endian

// Store with the production 256 MiB budget. Logic lives in worker-store.js so tests
// can exercise eviction with a small budget without real large allocations.
const _ws = createWorkerStore();
const store = _ws.store; // read-only ref used by decode path to look up entries
function touch(bytesId) { _ws.touch(bytesId); }

self.postMessage({ v: 1, type: 'ready' });

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (!msg || msg.v !== 1) return;

  if (msg.type === 'load') {
    // Delegates to worker-store.js (SAB zero-copy, range carrier, whole-buffer — findings 79, 80).
    _ws.loadMessage(msg);
    return; // no reply for load
  }

  if (msg.type === 'unload') {
    // Delegates to worker-store.js; decrements refcount, frees when → 0.
    _ws.unloadMessage(msg.bytesId);
    self.postMessage({ v: 1, type: 'unload-ack', bytesId: msg.bytesId });
    return;
  }

  if (msg.type === 'cancel') {
    // decoder.push() is synchronous; cancellation between requests is implicit. No-op.
    return;
  }

  if (msg.type === 'decode') {
    const { id, bytesId, region, format } = msg;
    const entry = store.get(bytesId);
    if (!entry) {
      self.postMessage({
        v: 1, type: 'decode-reply', id, ok: false,
        error: { code: 'UNKNOWN_BYTES_ID', message: `no bytes for bytesId ${bytesId}` },
      });
      return;
    }
    touch(bytesId);
    try {
      const fn = format === 'rgba16' ? decodeTileContainerRegionRgba16 : decodeTileContainerRegionRgba8;
      let container;
      if (entry.kind === 'ranges') {
        // Reconstruct a minimal single-tile JXTC container around the requested grid tile's
        // bitstream so the existing region decoder works unchanged. The pool aligns decode
        // requests to grid tiles, so exactly one stored range backs this region.
        const bits = format === 'rgba16' ? 16 : 8;
        const tileBits = pickTileBitstream(entry, region);
        container = wrapSingleTile(tileBits, region.w, region.h, bits);
        const out = await fn(container, { x: 0, y: 0, w: region.w, h: region.h });
        self.postMessage(
          { v: 1, type: 'decode-reply', id, ok: true, pixels: out.pixels, w: out.width, h: out.height },
          [out.pixels.buffer],
        );
      } else {
        // whole / sab: decode the region straight from the (viewed) container.
        const out = await fn(entry.whole, { x: region.x, y: region.y, w: region.w, h: region.h });
        self.postMessage(
          { v: 1, type: 'decode-reply', id, ok: true, pixels: out.pixels, w: out.width, h: out.height },
          [out.pixels.buffer],
        );
      }
    } catch (err) {
      self.postMessage({
        v: 1, type: 'decode-reply', id, ok: false,
        error: {
          code: classifyError(err),
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
      });
    }
    return;
  }
};

/** Choose the stored tile bitstream for a grid-aligned decode region by its grid origin. */
function pickTileBitstream(entry, region) {
  const exact = entry.ranges.get(`${region.x},${region.y}`);
  if (exact) return exact;
  if (entry.ranges.size === 1) return entry.ranges.values().next().value; // sole tile
  throw new Error(`no tile bitstream stored for grid region ${region.x},${region.y}`);
}

/** Build a valid 1×1-tile JXTC container wrapping a single standalone tile bitstream. */
function wrapSingleTile(tileBits, w, h, bits) {
  const dataBase = 32 + 8; // header + one (offset,length) index entry
  const total = dataBase + tileBits.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, JXTC_MAGIC, true);
  view.setUint32(4, 1, true);                 // version
  view.setUint32(8, w, true);                 // imageW
  view.setUint32(12, h, true);                // imageH
  view.setUint32(16, Math.max(w, h), true);   // tileSize (single tile covers the image)
  view.setUint32(20, 1, true);                // tilesX
  view.setUint32(24, 1, true);                // tilesY
  view.setUint32(28, bits === 16 ? 2 : 0, true); // flags (bit1 = 16-bit)
  view.setUint32(32, dataBase, true);         // tile[0] offset
  view.setUint32(36, tileBits.byteLength, true); // tile[0] length
  out.set(tileBits, dataBase);
  return out;
}

function classifyError(err) {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (m.includes('region') || m.includes('bounds')) return 'BAD_REGION';
  if (m.includes('parse') || m.includes('jxtc') || m.includes('container') || m.includes('magic')) return 'JXTC_PARSE';
  if (m.includes('memory') || m.includes('alloc') || m.includes('oom')) return 'OOM';
  return 'INTERNAL';
}
