import { EFFORT, planLadder, planProxy } from "./quality.js";
import { encodeBigLevelsRgba16, packedRgb16ToRgba16, targetDimsForLongEdge } from "./rgb16.js";
const GRID_MAX_LONG = 1024;
const TILE_SIZE = 256;
// Long-edge / pixel thresholds above which a scan is "massive" (ingest.ts:273): in adaptive
// mode its full level becomes a JXTC tile container for pan/zoom region decode.
const MASSIVE_LONG_EDGE = 8000;
const MASSIVE_PIXELS = 40_000_000;
function isMassive(width, height) {
    return Math.max(width, height) > MASSIVE_LONG_EDGE || width * height > MASSIVE_PIXELS;
}
export async function buildRawLadder(jxl, decoded, profileConvergence = false, tiling = "adaptive") {
    const { rgba, rgb16, width, height } = decoded;
    const masterLong = Math.max(width, height);
    if (rgb16 && rgb16.length > 0) {
        // 8-bit grid levels (<=1024) via rgba8 downscale + tile
        // L8: grid from decoded.rgba (post-tonemap 8-bit render of the master); 16-bit big levels (when rgb16 present)
        // derive from the same pre-quantized rgb16 via identical look/params in the raw backend (process + pipeline::process).
        const gridLevels = [];
        let cur8 = rgba;
        let cw = width, ch = height;
        let lastW = -1, lastH = -1;
        // consume Agent5 master-aware plan (filters <master + near-ratio); subfilter grid bucket
        const gridTargets = planLadder(masterLong).sidecars
            .filter((sc) => sc.size <= GRID_MAX_LONG)
            .sort((a, b) => b.size - a.size); // L1: descend
        for (const sc of gridTargets) {
            const dst = targetDimsForLongEdge(width, height, sc.size);
            if (dst.w === lastW && dst.h === lastH)
                continue; // L2: dedup exact dims (e.g. small master)
            if (dst.w !== cw || dst.h !== ch) {
                cur8 = await jxl.downscaleRgba8(cur8, cw, ch, dst.w, dst.h);
                cw = dst.w;
                ch = dst.h;
            }
            lastW = cw;
            lastH = ch;
            const stagedBytes = cur8.byteLength;
            const data = await jxl.encodeTileContainer(cur8, cw, ch, {
                tileSize: TILE_SIZE,
                distance: sc.distance,
                effort: EFFORT,
            });
            gridLevels.push({ data, width: cw, height: ch, bitsPerSample: 8, tiled: true, tileSize: TILE_SIZE, tileVersion: 1, stagedBytes });
        }
        gridLevels.reverse(); // L1: restore ascending for manifest/levels output invariant
        // 16-bit levels (2048+) via rgb16 downscale + encodeTileContainer16
        // L3 memory: release full-res sources once converted / after grid consumers done
        let cur16 = packedRgb16ToRgba16(rgb16, width, height);
        decoded.rgb16 = undefined; // packed source dead after conversion
        let cw16 = width, ch16 = height;
        // grid loop finished; release rgba too (grid used it; 16-bit path uses cur16)
        decoded.rgba = undefined;
        // consume Agent5 master-aware plan (already ratio + <master filtered)
        const pBig = planLadder(masterLong);
        const bigSidecars = pBig.sidecars.filter((sc) => sc.size >= 2048);
        const bigTargets = [
            { longEdge: masterLong, distance: pBig.fullDistance },
            ...bigSidecars.map((sc) => ({ longEdge: sc.size, distance: sc.distance })),
        ];
        const bigLevels = [];
        const enc16 = jxl.encodeTileContainer16;
        if (typeof enc16 !== "function") {
            throw new Error("encodeTileContainer16 required for 16-bit tiled levels (Phase 3)");
        }
        let lastW16 = -1, lastH16 = -1;
        for (const t of bigTargets) {
            const dst = targetDimsForLongEdge(width, height, t.longEdge);
            if (dst.w === lastW16 && dst.h === lastH16)
                continue; // L2 dedup
            if (dst.w !== cw16 || dst.h !== ch16) {
                cur16 = (await jxl.downscaleRgba16(cur16, cw16, ch16, dst.w, dst.h));
                cw16 = dst.w;
                ch16 = dst.h;
            }
            lastW16 = cw16;
            lastH16 = ch16;
            const stagedBytes = cur16.byteLength;
            const data = await enc16(cur16, cw16, ch16, {
                tileSize: TILE_SIZE,
                distance: t.distance,
                effort: EFFORT,
            });
            bigLevels.push({ data, width: cw16, height: ch16, bitsPerSample: 16, tiled: true, tileSize: TILE_SIZE, tileVersion: 1, stagedBytes });
        }
        let outLevels = [...gridLevels, ...bigLevels];
        // L7: enforce invariant for all consumers (some assume or pick by index assuming order)
        outLevels.sort((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height)); // ascending by long edge
        if (profileConvergence)
            await attachConverged(jxl, outLevels);
        return { levels: outLevels, orientation: decoded.orientation, width, height };
    }
    // 8-bit only path. Adaptive: whole-frame levels, tile only a massive scan's full level.
    // Tile-all (Phase 3): every level is a JXTC tile container.
    const levels = [];
    let cur = rgba;
    let cw = width, ch = height;
    // consume Agent5: planLadder(master) already applies <master + ratio guard
    const p = planLadder(masterLong);
    const targets = [...p.sidecars, { size: masterLong, distance: p.fullDistance }];
    targets.sort((a, b) => b.size - a.size); // L1: descend for correct cascade (full first)
    const massive = isMassive(width, height);
    let lastW = -1, lastH = -1;
    for (const t of targets) {
        const dst = targetDimsForLongEdge(width, height, t.size);
        if (dst.w === lastW && dst.h === lastH)
            continue; // L2
        if (dst.w !== cw || dst.h !== ch) {
            cur = await jxl.downscaleRgba8(cur, cw, ch, dst.w, dst.h);
            cw = dst.w;
            ch = dst.h;
        }
        lastW = cw;
        lastH = ch;
        const isFull = cw === width && ch === height;
        const tiled = tiling === "tile-all" || (isFull && massive);
        const stagedBytes = cur.byteLength;
        const data = tiled
            ? await jxl.encodeTileContainer(cur, cw, ch, { tileSize: TILE_SIZE, distance: t.distance, effort: EFFORT })
            : (await jxl.encodePyramid(cur, cw, ch, { sidecars: [], fullDistance: t.distance, effort: EFFORT }))[0].data;
        levels.push({ data, width: cw, height: ch, bitsPerSample: 8, tiled, ...(tiled ? { tileSize: TILE_SIZE, tileVersion: 1 } : {}), stagedBytes });
    }
    levels.reverse(); // L1: restore ascending
    // L7
    levels.sort((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height)); // levels are ascending by long edge
    if (profileConvergence)
        await attachConverged(jxl, levels);
    return {
        levels,
        orientation: decoded.orientation,
        width,
        height,
    };
}
async function attachConverged(jxl, levels) {
    // L5: run profileConvergence (Butteraugli/ssim) in parallel; each level is independent input.
    // (b: pass refPixels to skip backend re-decode is deferred API change touching backends.ts)
    const tasks = levels.map(async (lvl) => {
        const mx = Math.max(lvl.width, lvl.height);
        if (mx < 1024)
            return;
        try {
            if (typeof jxl.profileConvergenceCurve === "function") {
                // full curve: persisted to manifest so clients pick any byte/quality cutoff offline
                const prof = await jxl.profileConvergenceCurve(lvl.data, lvl.width, lvl.height);
                if (prof) {
                    if (prof.convergedByteEnd != null && prof.convergedByteEnd > 0)
                        lvl.convergedByteEnd = prof.convergedByteEnd;
                    if (prof.curve.length > 0)
                        lvl.qualityCurve = prof.curve;
                }
            }
            else if (typeof jxl.profileConvergence === "function") {
                const ce = await jxl.profileConvergence(lvl.data, lvl.width, lvl.height);
                if (ce != null && ce > 0)
                    lvl.convergedByteEnd = ce;
            }
        }
        catch {
            // graceful: omit on error, single-pass JXL, or no ssim
        }
    });
    await Promise.all(tasks);
}
export async function buildJpgLadder(jxl, jpeg, profileConvergence = false, orientation = "source", tiling = "adaptive") {
    // Transcode (lossless JPEG->JXL), then decode once for the downscaled sidecar levels.
    const fullJxl = await jxl.transcodeJpeg(jpeg);
    const decoded = await jxl.decodeToRgba8(fullJxl);
    const w = decoded.width, h = decoded.height;
    const masterLong = Math.max(w, h);
    // consume Agent5: planLadder(master) gives ratio-guarded sidecars (all < master)
    const p = planLadder(masterLong);
    const sidecarTargets = [...p.sidecars].sort((a, b) => b.size - a.size); // L1: descend cascade
    const levels = [];
    let cur = decoded.rgba;
    let cw = w, ch = h;
    let lastW = -1, lastH = -1;
    for (const t of sidecarTargets) {
        const dst = targetDimsForLongEdge(w, h, t.size);
        if (dst.w === lastW && dst.h === lastH)
            continue; // L2
        if (dst.w !== cw || dst.h !== ch) {
            cur = await jxl.downscaleRgba8(cur, cw, ch, dst.w, dst.h);
            cw = dst.w;
            ch = dst.h;
        }
        lastW = cw;
        lastH = ch;
        const tiled = tiling === "tile-all";
        const stagedBytes = cur.byteLength;
        const data = tiled
            ? await jxl.encodeTileContainer(cur, cw, ch, { tileSize: TILE_SIZE, distance: t.distance, effort: EFFORT })
            : (await jxl.encodePyramid(cur, cw, ch, { sidecars: [], fullDistance: t.distance, effort: EFFORT }))[0].data;
        levels.push({ data, width: cw, height: ch, bitsPerSample: 8, tiled, ...(tiled ? { tileSize: TILE_SIZE, tileVersion: 1 } : {}), stagedBytes });
    }
    // Full level. Adaptive: reuse the bit-exact lossless transcode (fast + lossless — see the
    // jpg-full-transcode-vs-jxtc flipflop). Tile-all: a lossy JXTC re-encode for uniform tiled decode.
    if (tiling === "tile-all") {
        const data = await jxl.encodeTileContainer(decoded.rgba, w, h, { tileSize: TILE_SIZE, distance: p.fullDistance, effort: EFFORT });
        levels.push({ data, width: w, height: h, bitsPerSample: 8, tiled: true, tileSize: TILE_SIZE, tileVersion: 1, stagedBytes: decoded.rgba.byteLength });
    }
    else {
        levels.push({ data: fullJxl, width: w, height: h, bitsPerSample: 8, tiled: false, stagedBytes: decoded.rgba.byteLength });
    }
    levels.sort((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height)); // L7: ascending by long edge
    if (profileConvergence)
        await attachConverged(jxl, levels);
    return {
        levels,
        orientation,
        width: w,
        height: h,
    };
}
export async function buildProxyLadder(jxl, rgba, width, height, size, orientation, profileConvergence = false) {
    // L6: proxy is the only path still using encodePyramid (monolithic whole-frame JXL, no tiled:true).
    // All other ladders emit JXTC via encodeTileContainer (tiled:true). The jxl-pyramid decoder
    // (level-source.ts) supports both "whole" and "tiled" LevelSource kinds; prepareDecodePlan
    // requires tiled for region/tile paths but whole is valid for the single small proxy level.
    // Monolithic is intentional here (proxy is one small level; single-shot decode has lower overhead
    // than JXTC tile index for tiny payloads). Documented; no switch to encodeTileContainer.
    const produced = await jxl.encodePyramid(rgba, width, height, planProxy(size));
    const level = produced[0];
    if (!level)
        throw new Error("proxy encode produced no level");
    const outLevels = [{ ...level, bitsPerSample: 8, stagedBytes: rgba.byteLength }];
    if (profileConvergence)
        await attachConverged(jxl, outLevels);
    return { levels: outLevels, orientation, width, height };
}
//# sourceMappingURL=ladder.js.map