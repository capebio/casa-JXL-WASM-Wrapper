import { createDecoder, decodeTileContainerRegionRgba8, decodeTileContainerRegionRgba16 } from "@casabio/jxl-wasm";
export const buffersInFlight = new WeakSet();
export const formatFromBits = (bits) => (bits === 16 ? 'rgba16' : 'rgba8');
export const bppOfFormat = (f) => (f === 'rgba16' ? 8 : 4);
// Module-level decoder constants (Grok1)
export const REGION_DECODER_RGBA8 = async (b, r) => {
    const out = await decodeTileContainerRegionRgba8(b, r);
    return { pixels: out.pixels, width: out.width, height: out.height, format: 'rgba8' };
};
export const REGION_DECODER_RGBA16 = async (b, r) => {
    const out = await decodeTileContainerRegionRgba16(b, r);
    return { pixels: out.pixels, width: out.width, height: out.height, format: 'rgba16' };
};
export const pickRegionDecoder = (bits) => bits === 16 ? REGION_DECODER_RGBA16 : REGION_DECODER_RGBA8;
export const WHOLE_DECODE_OPTS = Object.freeze({
    progressionTarget: "final",
    emitEveryPass: false,
    preserveIcc: false,
    preserveMetadata: false,
});
export function clampPositive(x, max) {
    return x <= 0 ? 0 : (x >= max ? max : x);
}
/** longEdge helper (Grok4 micro-opt): ternary, no Math.max call. */
export function longEdge(w, h) {
    return w > h ? w : h;
}
export function assertFiniteRegion(r) {
    // single-expression NaN/Infinity screen: any non-finite member poisons the sum
    if (!Number.isFinite(r.x + r.y + r.w + r.h)) {
        throw new PyramidError('BAD_REGION', `region must have finite x,y,w,h (got ${r.x},${r.y},${r.w},${r.h})`);
    }
}
/** Snap fractional regions to integers: floor the origin, ceil the far edge.
 *  Output always covers the requested rect. Identity (no alloc) for integer input. */
export function snapRegionToIntegers(r) {
    if (Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.w) && Number.isInteger(r.h))
        return r;
    const x = Math.floor(r.x), y = Math.floor(r.y);
    return { x, y, w: Math.ceil(r.x + r.w) - x, h: Math.ceil(r.y + r.h) - y };
}
/** Central clamp (replaces 3 inlined sites: decode-level, pool, tiling). */
export function clampRegion(region, imageW, imageH) {
    assertFiniteRegion(region);
    if (!Number.isFinite(imageW) || !Number.isFinite(imageH) || imageW <= 0 || imageH <= 0) {
        throw new RangeError("imageW/H must be positive finite");
    }
    // Early out for common in-bounds case (Grok4).
    // Callers must not mutate the returned region; it may alias the input.
    if (region.x >= 0 && region.y >= 0 && region.x + region.w <= imageW && region.y + region.h <= imageH) {
        return region;
    }
    const rx = clampPositive(region.x, imageW);
    const ry = clampPositive(region.y, imageH);
    const rw = clampPositive(region.w, imageW - rx);
    const rh = clampPositive(region.h, imageH - ry);
    return { x: rx, y: ry, w: rw, h: rh };
}
/**
 * Write one decoded tile into outBuffer at its offset within viewport.
 * Replaces the parts[] "stitch all" signature (stream-stitch: on-arrival writes).
 * Fast-path stride-aligned kept; fallback row subarray. Indexed loops.
 */
export function stitch(outBuffer, viewport, tile, decoded, bytesPerPixel) {
    // Bounds + exact byte length checks (as implemented for the crop case in stitchCropped).
    const expected = decoded.width * decoded.height * bytesPerPixel;
    if (decoded.pixels.byteLength !== expected) {
        throw new PyramidError('DECODER_OUTPUT_MISMATCH', `decoded tile bytes ${decoded.pixels.byteLength} != ${decoded.width}x${decoded.height}x${bytesPerPixel}`);
    }
    // Hoist (Grok4).
    const vw = viewport.w;
    const vx = viewport.x;
    const vy = viewport.y;
    const dx = tile.x - vx;
    const dy = tile.y - vy;
    if (dx < 0 || dy < 0 || dx + decoded.width > viewport.w || dy + decoded.height > viewport.h) {
        throw new PyramidError('STITCH_OOB', `dst ${decoded.width}x${decoded.height}@(${dx},${dy}) outside viewport ${viewport.w}x${viewport.h}`);
    }
    const dstStride = vw * bytesPerPixel;
    const srcStride = decoded.width * bytesPerPixel;
    if (decoded.width === vw && dx === 0 /* decoded.height + dy <= viewport.h guaranteed by STITCH_OOB guard above */) {
        // Fast path: stride-aligned full-width tile block at this y. The height bound is already enforced by the
        // STITCH_OOB throw immediately prior; omitting the redundant test here removes one branch per aligned tile write.
        outBuffer.set(decoded.pixels, dy * dstStride);
    }
    else {
        let srcOff = 0;
        let dstOff = (dy * vw + dx) * bytesPerPixel;
        for (let row = 0; row < decoded.height; row++) {
            outBuffer.set(decoded.pixels.subarray(srcOff, srcOff + srcStride), dstOff);
            srcOff += srcStride;
            dstOff += dstStride;
        }
    }
}
/**
 * Stitch a sub-rectangle of a decoded full tile into the viewport buffer.
 * srcRect is in image coordinates and must lie within the decoded tile; the decoded tile's
 * top-left in image coordinates is (srcOriginX, srcOriginY) with row stride decodedW·bpp.
 */
export function stitchCropped(outBuffer, viewport, srcRect, decodedPixels, decodedW, decodedH, srcOriginX, srcOriginY, bytesPerPixel) {
    const cropX = srcRect.x - srcOriginX, cropY = srcRect.y - srcOriginY;
    if (cropX < 0 || cropY < 0 || cropX + srcRect.w > decodedW || cropY + srcRect.h > decodedH) {
        throw new PyramidError('STITCH_OOB', `crop ${srcRect.w}x${srcRect.h}@(${cropX},${cropY}) outside decoded ${decodedW}x${decodedH}`);
    }
    const expected = decodedW * decodedH * bytesPerPixel;
    if (decodedPixels.byteLength !== expected) {
        throw new PyramidError('DECODER_OUTPUT_MISMATCH', `decoded tile bytes ${decodedPixels.byteLength} != ${decodedW}x${decodedH}x${bytesPerPixel}`);
    }
    const dx = srcRect.x - viewport.x, dy = srcRect.y - viewport.y;
    if (dx < 0 || dy < 0 || dx + srcRect.w > viewport.w || dy + srcRect.h > viewport.h) {
        throw new PyramidError('STITCH_OOB', `dst ${srcRect.w}x${srcRect.h}@(${dx},${dy}) outside viewport ${viewport.w}x${viewport.h}`);
    }
    const srcStride = decodedW * bytesPerPixel;
    const dstStride = viewport.w * bytesPerPixel;
    const rowBytes = srcRect.w * bytesPerPixel;
    let srcOff = (cropY * decodedW + cropX) * bytesPerPixel;
    let dstOff = (dy * viewport.w + dx) * bytesPerPixel;
    if (rowBytes === srcStride && rowBytes === dstStride) { // full-width, both aligned
        outBuffer.set(decodedPixels.subarray(srcOff, srcOff + rowBytes * srcRect.h), dstOff);
        return;
    }
    for (let row = 0; row < srcRect.h; row++) {
        outBuffer.set(decodedPixels.subarray(srcOff, srcOff + rowBytes), dstOff);
        srcOff += srcStride;
        dstOff += dstStride;
    }
}
/** L10-R4: reverse-trust validation that decoder delivered the exact region/size/bpp requested.
 * Throws DECODER_OUTPUT_MISMATCH on dim or byteLength mismatch.
 */
export function validateDecodedOutput(decoded, expectedRegion, bpp) {
    if (decoded.width !== expectedRegion.w || decoded.height !== expectedRegion.h) {
        throw new PyramidError('DECODER_OUTPUT_MISMATCH', `decoded size ${decoded.width}x${decoded.height} != expected ${expectedRegion.w}x${expectedRegion.h}`);
    }
    const expectedBytes = expectedRegion.w * expectedRegion.h * bpp;
    if (decoded.pixels.byteLength !== expectedBytes) {
        throw new PyramidError('DECODER_OUTPUT_MISMATCH', `decoded bytes ${decoded.pixels.byteLength} != ${expectedBytes} for region ${expectedRegion.w}x${expectedRegion.h}x${bpp}`);
    }
}
export class PyramidError extends Error {
    code;
    cause;
    constructor(code, message, cause) {
        super(message, { cause });
        this.code = code;
        this.cause = cause;
        this.name = 'PyramidError';
    }
}
/**
 * Race a promise against an AbortSignal.
 * - Cleans up listeners on either settlement.
 * - If abort wins, swallows rejection from p to prevent orphaned unhandled rejection.
 * - Pre-aborted signal: swallows p and rejects immediately.
 */
export function raceWithAbort(p, signal) {
    if (!signal)
        return p;
    if (signal.aborted) {
        p.catch(() => { });
        const msg = typeof signal.reason === 'string' ? `decode aborted before start: ${signal.reason}` : 'decode aborted before start';
        return Promise.reject(new PyramidError('ABORTED', msg, signal.reason));
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            signal.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
            if (settled)
                return;
            settled = true;
            cleanup();
            p.catch(() => { }); // prevent orphaned rejection from the raced promise
            const msg = typeof signal.reason === 'string' ? `decode aborted: ${signal.reason}` : 'decode aborted';
            reject(new PyramidError('ABORTED', msg, signal.reason));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        p.then((val) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(val);
        }, (err) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(err);
        });
    });
}
/** High-perf stable string key for a tile (used for LRU cache keys and logs). */
export function tileKey(tile) {
    return `L${tile.level}-C${tile.col}-R${tile.row}`;
}
/** F7: canonical TileId for a (clipped) tile rect — col/row from grid origin. */
export function tileIdOf(rect, tileSize, level) {
    return { level, col: Math.floor(rect.x / tileSize), row: Math.floor(rect.y / tileSize) };
}
export const DEV = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';
/** Packed numeric tile key for hot maps: level ≤ 8190, col/row < 2^20 — keeps value < 2^53 (exact in IEEE double). */
export function tileKeyPacked(tile) {
    // level ≤ 8190, col/row < 2^20 — documented bound tightened from <8192 because
    // 8191 * 2^40 + (2^20-1)*2^20 + (2^20-1) exceeds 2^53-1. Real pyramids use << 32 levels.
    // Dev guard (no prod cost) to catch contract violations early.
    if (DEV) {
        if (!Number.isInteger(tile.level) || tile.level > 8190 || tile.level < 0 ||
            !Number.isInteger(tile.col) || tile.col < 0 || tile.col >= (1 << 20) ||
            !Number.isInteger(tile.row) || tile.row < 0 || tile.row >= (1 << 20)) {
            throw new PyramidError('BAD_REGION', `tileKeyPacked bounds violation: level=${tile.level} col=${tile.col} row=${tile.row} (level≤8190, col/row<2^20)`);
        }
    }
    return tile.level * 0x10000000000 + tile.row * 0x100000 + tile.col;
}
/** L1-3: stable viewport cache key (quality distinguishes dc/final for progressive). */
export function viewportCacheKey(levelId, vp, format, quality) {
    return `${levelId}:${vp.x},${vp.y},${vp.w},${vp.h}:${format}:q${quality}`;
}
/** Agent6-4: once-per-LevelSource lazy capture of ICC (and future metadata) using minimal header decoder + facade.getIccProfile.
 *  Caches on the source object (like bytesId). Shared reference stamped to results (no per-tile copies).
 *  Only runs if options.preserveMetadata. For JXTC the profile lives in the codestream(s); header target is cheap.
 */
const _iccCache = new WeakMap();
export function ensureIccProfile(source, opts) {
    if (!opts?.preserveMetadata)
        return Promise.resolve(null);
    const cached = _iccCache.get(source);
    if (cached !== undefined)
        return cached;
    const p = (async () => {
        try {
            // Dynamic import avoids any potential cycle; facade has the getIccProfile (added for decode states).
            const wasm = await import("@casabio/jxl-wasm");
            const dec = wasm.createDecoder({
                format: 'rgba8',
                progressionTarget: 'header',
                emitEveryPass: false,
                preserveIcc: true,
                preserveMetadata: false,
            });
            // Prefix is sufficient for header + color profile (libjxl emits early).
            const prefixLen = Math.min(256 * 1024, source.bytes.length);
            await dec.push(source.bytes.subarray(0, prefixLen));
            await dec.close();
            let icc = dec.getIccProfile ? dec.getIccProfile() : null;
            if (icc)
                icc = new Uint8Array(icc); // own the bytes
            await Promise.resolve(dec.dispose()).catch(() => { });
            return icc || null;
        }
        catch (err) {
            console.error('ensureIccProfile failed:', err);
            return null;
        }
    })();
    _iccCache.set(source, p);
    return p;
}
export function cacheStore(cache, key, pixels, need) {
    if (!cache || !key)
        return;
    const cap = cache.capacityBytes;
    if (cap !== undefined && need > cap)
        return;
    cache.set(key, pixels.byteLength === need ? pixels : pixels.slice(0, need));
}
export function sortCenterOut(items, viewport, getRect) {
    const cx = viewport.x + viewport.w / 2;
    const cy = viewport.y + viewport.h / 2;
    return items.slice().sort((a, b) => {
        const ra = getRect(a), rb = getRect(b);
        const da = (ra.x + ra.w / 2 - cx) ** 2 + (ra.y + ra.h / 2 - cy) ** 2;
        const db = (rb.x + rb.w / 2 - cx) ** 2 + (rb.y + rb.h / 2 - cy) ** 2;
        return da - db;
    });
}
//# sourceMappingURL=decode-core.js.map