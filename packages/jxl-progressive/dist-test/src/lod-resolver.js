// packages/jxl-progressive/src/lod-resolver.ts
//
// S6 — one addressing model. A single resolver maps a request in the unified LOD/ROI
// request language `{ level?, region?, quality? }` to concrete byte ranges, choosing the
// mechanism (progressive quality prefix | pyramid resolution level | JXTC spatial tiles)
// per what the stored asset supports. K2's encoder-emitted tier offsets are the quality
// axis.
//
// This module is deliberately DEPENDENCY-FREE: it operates on minimal structural
// interfaces rather than importing the concrete `@casabio/jxl-pyramid` types, so it runs
// under `node --test` and stays decoupled. The adapters at the bottom
// (`fromProgressiveManifest`, `fromPyramidLevels`, `fromJxtcContainer`) build a `LodAsset`
// from the real manifest / container shapes, which are structurally compatible.
//
// It sits BESIDE existing viewers — nothing is rewired to it. Nothing here changes any
// stored bytes; it only computes where to read.
import { tierPixelDims } from "./progressive-manifest.js";
/** Format a single range as an HTTP `Range` header value (inclusive both ends). */
export function toHttpRange(range) {
    return `bytes=${range.start}-${range.end - 1}`;
}
export class LodResolveError extends Error {
    constructor(message) {
        super(message);
        this.name = "LodResolveError";
    }
}
// ── Per-mechanism resolution ────────────────────────────────────────────────────
function longEdge(w, h) {
    return Math.max(w, h);
}
/** Region → the JXTC tiles overlapping the clamped rect, and their byte ranges. */
function resolveRegionJxtc(grid, region) {
    const { imageW, imageH, tileSize, tilesX, tilesY, index } = grid;
    if (!Number.isFinite(region.x) || region.x < 0 ||
        !Number.isFinite(region.y) || region.y < 0 ||
        !Number.isFinite(region.w) || region.w < 0 ||
        !Number.isFinite(region.h) || region.h < 0) {
        throw new LodResolveError("region must have finite non-negative x, y, w, h");
    }
    const rx = Math.min(Math.max(0, region.x), imageW);
    const ry = Math.min(Math.max(0, region.y), imageH);
    const rw = Math.min(region.w, imageW - rx);
    const rh = Math.min(region.h, imageH - ry);
    const ranges = [];
    const tiles = [];
    if (rw <= 0 || rh <= 0) {
        return { mechanism: "jxtc", source: grid.source, ranges, tiles, width: 0, height: 0 };
    }
    const txMin = Math.floor(rx / tileSize);
    const txMax = Math.floor((rx + rw - 1) / tileSize);
    const tyMin = Math.floor(ry / tileSize);
    const tyMax = Math.floor((ry + rh - 1) / tileSize);
    for (let ty = tyMin; ty <= tyMax; ty++) {
        for (let tx = txMin; tx <= txMax; tx++) {
            if (tx < 0 || ty < 0 || tx >= tilesX || ty >= tilesY)
                continue;
            const tileIdx = ty * tilesX + tx;
            const start = index.offsets[tileIdx]; // ABSOLUTE offset from byte 0 — no rebasing.
            const len = index.lengths[tileIdx];
            ranges.push({ start, end: start + len });
            // Image-space overlap of this tile with the clamped region.
            const tileX0 = tx * tileSize;
            const tileY0 = ty * tileSize;
            const ox0 = Math.max(tileX0, rx);
            const oy0 = Math.max(tileY0, ry);
            const ox1 = Math.min(tileX0 + Math.min(tileSize, imageW - tileX0), rx + rw);
            const oy1 = Math.min(tileY0 + Math.min(tileSize, imageH - tileY0), ry + rh);
            tiles.push({ x: ox0, y: oy0, w: ox1 - ox0, h: oy1 - oy0 });
        }
    }
    return { mechanism: "jxtc", source: grid.source, ranges, tiles, width: rw, height: rh };
}
/** Level → smallest pyramid level whose long edge ≥ target, else the largest. */
function resolvePyramidLevel(pyr, targetLongEdge) {
    if (pyr.levels.length === 0)
        throw new LodResolveError("pyramid has no levels");
    const sorted = [...pyr.levels].sort((a, b) => longEdge(a.w, a.h) - longEdge(b.w, b.h));
    let chosen = sorted[sorted.length - 1];
    for (const lv of sorted) {
        if (longEdge(lv.w, lv.h) >= targetLongEdge) {
            chosen = lv;
            break;
        }
    }
    return {
        mechanism: "pyramid",
        source: chosen.source,
        ranges: [{ start: 0, end: chosen.bytes }],
        width: chosen.w,
        height: chosen.h,
    };
}
function tierLongEdge(prog, t) {
    return longEdge(t.pixelWidth ?? prog.width, t.pixelHeight ?? prog.height);
}
/** Quality → the prefix `[0, tier.byteEnd)` for a tier by name / fraction / "full". */
function resolveProgressiveQuality(prog, quality) {
    if (prog.tiers.length === 0)
        throw new LodResolveError("progressive source has no tiers");
    const last = prog.tiers[prog.tiers.length - 1];
    let tier;
    if (typeof quality === "string") {
        tier = quality === "full" ? last : prog.tiers.find((t) => t.name === quality);
        if (!tier)
            throw new LodResolveError(`no progressive tier named "${quality}"`);
    }
    else {
        if (!Number.isFinite(quality) || quality <= 0)
            throw new LodResolveError("quality fraction must be > 0");
        if (quality >= 1) {
            tier = last;
        }
        else {
            // Smallest tier whose prefix covers at least `quality` of the full byte budget.
            const need = quality * prog.bytes;
            tier = prog.tiers.find((t) => t.byteEnd >= need) ?? last;
        }
    }
    return {
        mechanism: "progressive",
        source: prog.source,
        ranges: [{ start: 0, end: tier.byteEnd }],
        width: tier.pixelWidth ?? prog.width,
        height: tier.pixelHeight ?? prog.height,
    };
}
/** Level over a progressive codestream: smallest tier whose intrinsic long edge ≥ target
 *  (uses schema-v2 per-tier pixel dims; falls back to full when tiers carry no dims). */
function resolveProgressiveByLevel(prog, targetLongEdge) {
    if (prog.tiers.length === 0)
        throw new LodResolveError("progressive source has no tiers");
    const last = prog.tiers[prog.tiers.length - 1];
    let tier = last;
    for (const t of prog.tiers) {
        if (tierLongEdge(prog, t) >= targetLongEdge) {
            tier = t;
            break;
        }
    }
    return {
        mechanism: "progressive",
        source: prog.source,
        ranges: [{ start: 0, end: tier.byteEnd }],
        width: tier.pixelWidth ?? prog.width,
        height: tier.pixelHeight ?? prog.height,
    };
}
// ── The resolver ────────────────────────────────────────────────────────────────
/**
 * Map a `{ level?, region?, quality? }` request to a concrete `ByteSource`.
 *
 * Precedence when several axes are set and the asset offers several mechanisms:
 *   1. `region`  → JXTC tiles (spatial is the most specific). If the asset is not tiled,
 *                  the region axis is dropped and resolution/quality/default apply.
 *   2. `level`   → pyramid level; if there is no pyramid but a progressive codestream, the
 *                  smallest tier whose intrinsic resolution meets the target.
 *   3. `quality` → progressive prefix; if there is no progressive stream but a pyramid,
 *                  the largest level (opaque levels have no quality sub-selection).
 *   4. default   → progressive full → pyramid largest → whole JXTC grid.
 *
 * Throws `LodResolveError` only when the asset supports NO mechanism at all.
 */
export function resolveLod(asset, req) {
    if (req.region != null && asset.jxtc) {
        return resolveRegionJxtc(asset.jxtc, req.region);
    }
    if (req.level != null) {
        if (asset.pyramid)
            return resolvePyramidLevel(asset.pyramid, req.level);
        if (asset.progressive)
            return resolveProgressiveByLevel(asset.progressive, req.level);
    }
    if (req.quality != null) {
        if (asset.progressive)
            return resolveProgressiveQuality(asset.progressive, req.quality);
        if (asset.pyramid)
            return resolvePyramidLevel(asset.pyramid, Number.POSITIVE_INFINITY);
    }
    // Defaults (no applicable axis).
    if (asset.progressive)
        return resolveProgressiveQuality(asset.progressive, "full");
    if (asset.pyramid)
        return resolvePyramidLevel(asset.pyramid, Number.POSITIVE_INFINITY);
    if (asset.jxtc) {
        return resolveRegionJxtc(asset.jxtc, { x: 0, y: 0, w: asset.jxtc.imageW, h: asset.jxtc.imageH });
    }
    throw new LodResolveError("asset supports no LOD mechanism (no progressive, pyramid, or jxtc source)");
}
// ── Adapters from the real manifest / container shapes ──────────────────────────
/** Build a progressive `LodAsset` from a `ProgressiveManifest` (K2 tier offsets). */
export function fromProgressiveManifest(manifest, source) {
    const tiers = manifest.tiers.map((t) => {
        const dims = tierPixelDims(manifest, t);
        const tier = { name: t.name, byteEnd: t.byteEnd };
        // Only carry intrinsic dims when the manifest declared them (v2); otherwise leave
        // undefined so `resolveProgressiveByLevel` treats the tier as full-resolution.
        if (t.pixelWidth !== undefined)
            tier.pixelWidth = dims.width;
        if (t.pixelHeight !== undefined)
            tier.pixelHeight = dims.height;
        return tier;
    });
    return {
        width: manifest.source.width,
        height: manifest.source.height,
        progressive: {
            source,
            bytes: manifest.jxl.bytes,
            width: manifest.source.width,
            height: manifest.source.height,
            tiers,
        },
    };
}
/** Build a pyramid `LodAsset` from pyramid levels. `sourceFor` maps a level to its blob id
 *  (default: the level's `contenthash`). */
export function fromPyramidLevels(levels, sourceFor = (l) => l.contenthash) {
    if (levels.length === 0)
        throw new LodResolveError("fromPyramidLevels: empty levels");
    const resLevels = levels.map((l) => {
        const rl = { source: sourceFor(l), w: l.w, h: l.h, bytes: l.bytes };
        if (l.tiled !== undefined)
            rl.tiled = l.tiled;
        if (l.tiling !== undefined)
            rl.tiling = l.tiling;
        return rl;
    });
    let maxW = 0, maxH = 0;
    for (const l of levels) {
        if (longEdge(l.w, l.h) > longEdge(maxW, maxH)) {
            maxW = l.w;
            maxH = l.h;
        }
    }
    return { width: maxW, height: maxH, pyramid: { levels: resLevels } };
}
/** Build a JXTC `LodAsset` from a parsed JXTC header + tile index. */
export function fromJxtcContainer(header, index, source) {
    return {
        width: header.imageW,
        height: header.imageH,
        jxtc: {
            source,
            imageW: header.imageW,
            imageH: header.imageH,
            tileSize: header.tileSize,
            tilesX: header.tilesX,
            tilesY: header.tilesY,
            index,
        },
    };
}
//# sourceMappingURL=lod-resolver.js.map