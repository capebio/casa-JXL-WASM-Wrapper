/**
 * Versioned worker protocol for jxl-pyramid tiled decode (Grok 2).
 * Shared types between main-thread pool and web/lightbox/tiled-decode-worker.js.
 * The worker references these via JSDoc @typedef imports.
 *
 * Load bytes once (post with [bytes.buffer] transfer). Decode by bytesId for multiple tiles.
 * Reply pixels: transfer [pixels.buffer] for zero-copy (Lens7/20).
 * progressiveStage + deadlineMs: use 'dc' + tight deadline for low-latency machine-rec/AR first pass (Lens12/16).
 * priority (higher = more urgent): gaming/priority queue, astro tracking, photogram select, attended AR viewport (Lens11/13/14/16).
 *
 * dist/worker-protocol.js is BUILD-ONLY for bundler consumers: no in-repo runtime code
 * imports it directly (tests import this .ts via bun), but `validateWorkerRequest` is
 * re-exported through the package barrel (src/index.ts → dist/index.js), so the compiled
 * dist must be rebuilt (`bun run build`) and committed whenever this file changes — a stale
 * `export {}` would strip the guard from the published @casabio/jxl-pyramid surface.
 */

import type { ImageRegion } from "./tiling.js";

export type { ImageRegion } from "./tiling.js";

export type WorkerRequest =
  | { v: 1; type: 'load'; bytesId: number; bytes: Uint8Array }
  | { v: 1; type: 'load'; bytesId: number; sab: SharedArrayBuffer; byteLength: number }
  | { v: 1; type: 'decode'; id: number; bytesId: number; region: ImageRegion; format: 'rgba8' | 'rgba16'; deadlineMs?: number; progressiveStage?: 'dc' | 'final'; priority?: number }
  | { v: 1; type: 'cancel'; id: number };

export type WorkerReply =
  | { v: 1; type: 'ready' }
  | { v: 1; type: 'decode-reply'; id: number; ok: true; pixels: Uint8Array; w: number; h: number }
  | { v: 1; type: 'decode-reply'; id: number; ok: false; error: { code: WorkerErrorCode; message: string; stack?: string } };

export type WorkerErrorCode = 'JXTC_PARSE' | 'BAD_REGION' | 'OOM' | 'INTERNAL' | 'TIMEOUT' | 'UNKNOWN_BYTES_ID';

const _DEV = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

/** Dev-mode assertion mirroring parseWorkerReply. Throws on malformed outbound requests in dev. No-op in production. */
export function validateWorkerRequest(req: unknown): void {
  if (!_DEV) return;
  if (!req || typeof req !== 'object') throw new Error('[pyramid] WorkerRequest: not an object');
  const r: any = req;
  if (r.v !== 1) throw new Error(`[pyramid] WorkerRequest: expected v=1, got v=${r.v}`);
  if (r.type === 'load') {
    if (typeof r.bytesId !== 'number') throw new Error('[pyramid] WorkerRequest load: bytesId not a number');
    if (r.sab !== undefined) {
      if (typeof SharedArrayBuffer === 'undefined' || !(r.sab instanceof SharedArrayBuffer))
        throw new Error('[pyramid] WorkerRequest load: sab is not a SharedArrayBuffer');
      if (typeof r.byteLength !== 'number' || r.byteLength <= 0)
        throw new Error('[pyramid] WorkerRequest load: byteLength must be positive number');
    } else if (!(r.bytes instanceof Uint8Array)) {
      throw new Error('[pyramid] WorkerRequest load: bytes must be a Uint8Array');
    }
  } else if (r.type === 'decode') {
    if (typeof r.id !== 'number') throw new Error('[pyramid] WorkerRequest decode: id not a number');
    if (typeof r.bytesId !== 'number') throw new Error('[pyramid] WorkerRequest decode: bytesId not a number');
    if (!r.region || typeof r.region.x !== 'number' || typeof r.region.y !== 'number' ||
        typeof r.region.w !== 'number' || typeof r.region.h !== 'number')
      throw new Error('[pyramid] WorkerRequest decode: region must have numeric x,y,w,h');
    if (r.format !== 'rgba8' && r.format !== 'rgba16')
      throw new Error(`[pyramid] WorkerRequest decode: unknown format ${r.format}`);
  } else if (r.type === 'cancel') {
    if (typeof r.id !== 'number') throw new Error('[pyramid] WorkerRequest cancel: id not a number');
  } else {
    throw new Error(`[pyramid] WorkerRequest: unknown type '${r.type}'`);
  }
}
