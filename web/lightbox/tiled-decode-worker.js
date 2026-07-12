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

try { preloadJxlModule(); } catch { /* optional warm-up */ }

const JXTC_MAGIC = 0x4354584a; // 'JXTC' little-endian

/** Retained-byte budget for this worker's store. LRU-evicted above this (finding 80). */
const BYTE_BUDGET = 256 * 1024 * 1024; // 256 MiB

/**
 * @typedef {Object} StoreEntry
 * @property {'whole'|'sab'|'ranges'} kind
 * @property {Uint8Array} [whole]                          resolved container bytes (whole/sab)
 * @property {Map<string, Uint8Array>} [ranges]            "gx,gy" -> standalone tile bitstream
 * @property {Set<number>} [offsets]                       resident tile offsets (dedup on reload)
 * @property {number} bytes                                bytes counted toward the budget
 * @property {number} refs                                 outstanding load references (refcount)
 */

/** @type {Map<number, StoreEntry>} bytesId -> entry (insertion order = LRU recency) */
const store = new Map();
let storeBytes = 0;

self.postMessage({ v: 1, type: 'ready' });

/** Mark an entry most-recently-used (Map preserves insertion order → reinsert to move to end). */
function touch(bytesId) {
  const e = store.get(bytesId);
  if (e) { store.delete(bytesId); store.set(bytesId, e); }
}

function dropEntry(bytesId) {
  const e = store.get(bytesId);
  if (!e) return;
  storeBytes -= e.bytes;
  store.delete(bytesId);
}

/** Evict LRU entries with no outstanding refs until under budget. */
function evictToBudget() {
  if (storeBytes <= BYTE_BUDGET) return;
  for (const [id, e] of store) {
    if (storeBytes <= BYTE_BUDGET) break;
    if (e.refs > 0) continue; // never evict a referenced entry
    dropEntry(id);
  }
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (!msg || msg.v !== 1) return;

  if (msg.type === 'load') {
    if (msg.sab !== undefined) {
      // Hold a zero-copy VIEW over the SharedArrayBuffer — no .slice() into ownership
      // (finding 80). The SAB is immutable for our purposes; the container writer never
      // mutates it after load, so a live view is safe and costs no per-worker copy.
      const view = new Uint8Array(msg.sab, 0, msg.byteLength);
      upsertWhole(msg.bytesId, 'sab', view, msg.byteLength);
    } else if (msg.ranges !== undefined) {
      // Range carrier: merge the transferred tile bitstreams into the per-tile store, keyed by
      // grid origin so a decode `region` (grid-aligned) addresses the exact tile.
      let entry = store.get(msg.bytesId);
      if (!entry || entry.kind !== 'ranges') {
        entry = { kind: 'ranges', ranges: new Map(), offsets: new Set(), bytes: 0, refs: 0 };
        store.set(msg.bytesId, entry);
      }
      for (const r of msg.ranges) {
        if (entry.offsets.has(r.offset)) continue;
        const b = r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes);
        entry.ranges.set(`${r.gx},${r.gy}`, b);
        entry.offsets.add(r.offset);
        entry.bytes += b.byteLength;
        storeBytes += b.byteLength;
      }
      entry.refs += 1;
      touch(msg.bytesId);
      evictToBudget();
    } else {
      const b = msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(msg.bytes);
      upsertWhole(msg.bytesId, 'whole', b, b.byteLength);
    }
    return; // no reply for load
  }

  if (msg.type === 'unload') {
    const e = store.get(msg.bytesId);
    if (e) {
      e.refs -= 1;
      if (e.refs <= 0) dropEntry(msg.bytesId);
    }
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

function upsertWhole(bytesId, kind, view, byteLen) {
  const prev = store.get(bytesId);
  if (prev) storeBytes -= prev.bytes;
  const entry = { kind, whole: view, bytes: byteLen, refs: (prev?.refs ?? 0) + 1 };
  store.set(bytesId, entry);
  storeBytes += byteLen;
  touch(bytesId);
  evictToBudget();
}

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
