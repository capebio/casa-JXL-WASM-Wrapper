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
/**
 * One tile's standalone JXL bitstream, addressed by its ABSOLUTE offset in the source
 * container (matches the JXTC index-table convention) AND by its grid origin (`gx`,`gy` in image
 * pixels) so a range-carrier worker can pick the exact tile a decode `region` refers to without
 * ever seeing the whole container. Range carriers post ONLY the requested tiles (finding 79)
 * instead of structured-cloning `workers * containerSize`.
 */
export type TileByteRange = {
    offset: number;
    length: number;
    gx: number;
    gy: number;
    bytes: Uint8Array;
};
export type WorkerRequest = {
    v: 1;
    type: 'load';
    bytesId: number;
    bytes: Uint8Array;
} | {
    v: 1;
    type: 'load';
    bytesId: number;
    sab: SharedArrayBuffer;
    byteLength: number;
} | {
    v: 1;
    type: 'load';
    bytesId: number;
    ranges: TileByteRange[];
} | {
    v: 1;
    type: 'decode';
    id: number;
    bytesId: number;
    region: ImageRegion;
    format: 'rgba8' | 'rgba16';
    deadlineMs?: number;
    progressiveStage?: 'dc' | 'final';
    priority?: number;
} | {
    v: 1;
    type: 'unload';
    bytesId: number;
} | {
    v: 1;
    type: 'cancel';
    id: number;
};
export type WorkerReply = {
    v: 1;
    type: 'ready';
} | {
    v: 1;
    type: 'unload-ack';
    bytesId: number;
} | {
    v: 1;
    type: 'decode-reply';
    id: number;
    ok: true;
    pixels: Uint8Array;
    w: number;
    h: number;
} | {
    v: 1;
    type: 'decode-reply';
    id: number;
    ok: false;
    error: {
        code: WorkerErrorCode;
        message: string;
        stack?: string;
    };
};
export type WorkerErrorCode = 'JXTC_PARSE' | 'BAD_REGION' | 'OOM' | 'INTERNAL' | 'TIMEOUT' | 'UNKNOWN_BYTES_ID';
/** Dev-mode assertion mirroring parseWorkerReply. Throws on malformed outbound requests in dev. No-op in production. */
export declare function validateWorkerRequest(req: unknown): void;
//# sourceMappingURL=worker-protocol.d.ts.map