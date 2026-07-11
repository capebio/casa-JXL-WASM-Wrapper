import { EFFORT, planLadder, planProxy } from "./quality.js";
import { encodeBigLevelsRgba16, packedRgb16ToRgba16, targetDimsForLongEdge } from "./rgb16.js";
import type { DecodedMaster, JxlBackend, Orientation, PyramidLevelBytes } from "./backends.js";
import { throwIfAborted } from "./abort.js";
import { ByteWeightedSemaphore } from "./byte-semaphore.js";

export interface LadderResult {
  levels: PyramidLevelBytes[];
  orientation: Orientation;
  width: number;
  height: number;
}

/** finding 71: options threaded to the ladder builders for bounded convergence profiling. */
export interface LadderOptions {
  /** Byte budget bounding concurrent convergence profiling (each level holds a full-res reference).
   *  Defaults to DEFAULT_PROFILE_MEM_BUDGET when profiling is on and no budget is supplied. */
  profileMemBudgetBytes?: number;
}

const GRID_MAX_LONG = 1024;
const TILE_SIZE = 256;
// Default ceiling on total in-flight profiling reference bytes (finding 71). Chosen so a couple of
// large (e.g. 24MP) references can profile in parallel while still bounding peak memory; the ingest
// caller passes its own --mem-budget-derived value.
const DEFAULT_PROFILE_MEM_BUDGET = 512 * 1024 * 1024;
// Only levels with a long edge >= this are profiled (mirrors attachConverged's small-level skip).
const PROFILE_MIN_LONG = 1024;

// Long-edge / pixel thresholds above which a scan is "massive" (ingest.ts:273): in adaptive
// mode its full level becomes a JXTC tile container for pan/zoom region decode.
const MASSIVE_LONG_EDGE = 8000;
const MASSIVE_PIXELS = 40_000_000;

/**
 * Per-batch tiling policy (chosen at encode time, e.g. `--tiling`):
 * - "never": no level is a JXTC tile container — every level is a monolithic whole-frame JXL
 *   (8-bit via encodePyramid, 16-bit via encodeRgba16). Smallest index; no region random-access.
 * - "adaptive" (default): whole-frame levels; tile ONLY a massive scan's full level; a JPEG
 *   master's full level is the bit-exact lossless transcode. Faster + lossless full (see the
 *   jpg-full-transcode-vs-jxtc flipflop: transcode ~3.5x faster than JXTC re-encode).
 * - "tile-all" (Phase 3, a.k.a. "always"): every level is a JXTC tile container (uniform
 *   tile/region random-access decode; the full level is a lossy re-encode even for JPEG masters).
 *
 * finding 70: the RGB16 path honors this same policy. A 16-bit level is tiled only when the policy
 * asks for it AND a 16-bit tile encoder (encodeTileContainer16) is available; otherwise it falls
 * back to a monolithic 16-bit encode (encodeRgba16) — the 16-bit tile encoder is never mandatory.
 */
export type TilingPolicy = "never" | "adaptive" | "tile-all";

function isMassive(width: number, height: number): boolean {
  return Math.max(width, height) > MASSIVE_LONG_EDGE || width * height > MASSIVE_PIXELS;
}

export async function buildRawLadder(jxl: JxlBackend, decoded: DecodedMaster, profileConvergence = false, tiling: TilingPolicy = "adaptive", signal?: AbortSignal, opts?: LadderOptions): Promise<LadderResult> {
  const { rgba, rgb16, width, height } = decoded;
  const masterLong = Math.max(width, height);
  // finding 71: only hold a per-level reference when profiling actually runs (else it's dead memory).
  const captureRef = profileConvergence;

  if (rgb16 && rgb16.length > 0) {
    // 8-bit grid levels (<=1024) via rgba8 downscale + tile
    // L8: grid from decoded.rgba (post-tonemap 8-bit render of the master); 16-bit big levels (when rgb16 present)
    // derive from the same pre-quantized rgb16 via identical look/params in the raw backend (process + pipeline::process).
    // finding 70: grid levels are always small (<=1024, never massive) so adaptive keeps them whole;
    // tile-all tiles them; never keeps them monolithic 8-bit. Only tile-all tiles the grid.
    const gridTiled = tiling === "tile-all";
    const gridLevels: PyramidLevelBytes[] = [];
    let cur8 = rgba;
    let cw = width, ch = height;
    let lastW = -1, lastH = -1;
    // consume Agent5 master-aware plan (filters <master + near-ratio); subfilter grid bucket
    const gridTargets = planLadder(masterLong).sidecars
      .filter((sc) => sc.size <= GRID_MAX_LONG)
      .sort((a, b) => b.size - a.size); // L1: descend
    for (const sc of gridTargets) {
      throwIfAborted(signal, "encode"); // finding 67: stop between levels on deadline/cancel
      const dst = targetDimsForLongEdge(width, height, sc.size);
      if (dst.w === lastW && dst.h === lastH) continue; // L2: dedup exact dims (e.g. small master)
      if (dst.w !== cw || dst.h !== ch) {
        cur8 = await jxl.downscaleRgba8(cur8, cw, ch, dst.w, dst.h, signal);
        cw = dst.w; ch = dst.h;
      }
      lastW = cw; lastH = ch;
      const stagedBytes = cur8.byteLength;
      const data = gridTiled
        ? await jxl.encodeTileContainer(cur8, cw, ch, { tileSize: TILE_SIZE, distance: sc.distance, effort: EFFORT }, signal)
        : (await jxl.encodePyramid(cur8, cw, ch, { sidecars: [], fullDistance: sc.distance, effort: EFFORT }, signal))[0]!.data;
      // finding 71: capture the RGBA8 reference for profiled grid levels (>=1024) so profiling reuses
      // it instead of re-decoding. downscaleRgba8 returns a fresh buffer, so `cur8` is a stable snapshot.
      const refPixels = captureRef && Math.max(cw, ch) >= PROFILE_MIN_LONG ? cur8 : undefined;
      gridLevels.push({ data, width: cw, height: ch, bitsPerSample: 8, tiled: gridTiled, ...(gridTiled ? { tileSize: TILE_SIZE, tileVersion: 1 as const } : {}), stagedBytes, ...(refPixels ? { refPixels } : {}) });
    }
    gridLevels.reverse(); // L1: restore ascending for manifest/levels output invariant

    // 16-bit levels (2048+) via rgb16 downscale.
    // L3 memory: release full-res sources once converted / after grid consumers done
    let cur16 = packedRgb16ToRgba16(rgb16, width, height);
    (decoded as any).rgb16 = undefined; // packed source dead after conversion
    let cw16 = width, ch16 = height;
    // grid loop finished; release rgba too (grid used it; 16-bit path uses cur16)
    (decoded as any).rgba = undefined;
    // consume Agent5 master-aware plan (already ratio + <master filtered)
    const pBig = planLadder(masterLong);
    const bigSidecars = pBig.sidecars.filter((sc) => sc.size >= 2048);
    const bigTargets = [
      { longEdge: masterLong, distance: pBig.fullDistance },
      ...bigSidecars.map((sc) => ({ longEdge: sc.size, distance: sc.distance })),
    ];
    const bigLevels: PyramidLevelBytes[] = [];
    // finding 70: honor the tiling policy for 16-bit. The 16-bit tile encoder is NEVER mandatory —
    // when a level should be tiled but encodeTileContainer16 is absent, fall back to monolithic 16-bit.
    // encodeRgba16 is only required when a level actually takes the monolithic path (checked per level).
    const enc16 = jxl.encodeTileContainer16;
    const encMono16 = jxl.encodeRgba16;
    const massive = isMassive(width, height);
    let lastW16 = -1, lastH16 = -1;
    for (const t of bigTargets) {
      throwIfAborted(signal, "encode"); // finding 67: stop between 16-bit levels on deadline/cancel
      const dst = targetDimsForLongEdge(width, height, t.longEdge);
      if (dst.w === lastW16 && dst.h === lastH16) continue; // L2 dedup
      if (dst.w !== cw16 || dst.h !== ch16) {
        cur16 = (await jxl.downscaleRgba16!(cur16, cw16, ch16, dst.w, dst.h)) as Uint16Array;
        cw16 = dst.w; ch16 = dst.h;
      }
      lastW16 = cw16; lastH16 = ch16;
      const isFull = cw16 === width && ch16 === height;
      // Policy intent to tile THIS level: tile-all always; adaptive only for a massive full level; never = false.
      const wantTiled = tiling === "tile-all" || (tiling === "adaptive" && isFull && massive);
      const canTile = typeof enc16 === "function";
      const tiled = wantTiled && canTile;
      const stagedBytes = (cur16 as any).byteLength;
      let data: Uint8Array;
      if (tiled) {
        data = await enc16!(cur16 as any, cw16, ch16, { tileSize: TILE_SIZE, distance: t.distance, effort: EFFORT }, signal);
      } else {
        // monolithic 16-bit encode (policy=never, non-massive adaptive level, or tile encoder absent)
        if (typeof encMono16 !== "function") {
          throw new Error("encodeRgba16 required for monolithic 16-bit levels (16-bit tile encoder absent and no monolithic 16-bit encode available)");
        }
        data = (await encMono16(cur16 as any, cw16, ch16, { distance: t.distance, effort: EFFORT }, signal)).data;
      }
      bigLevels.push({ data, width: cw16, height: ch16, bitsPerSample: 16, tiled, ...(tiled ? { tileSize: TILE_SIZE, tileVersion: 1 as const } : {}), stagedBytes });
    }

    let outLevels = [...gridLevels, ...bigLevels];
    // L7: enforce invariant for all consumers (some assume or pick by index assuming order)
    outLevels.sort((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height)); // ascending by long edge
    if (profileConvergence) await attachConverged(jxl, outLevels, opts?.profileMemBudgetBytes ?? DEFAULT_PROFILE_MEM_BUDGET);
    return { levels: outLevels, orientation: decoded.orientation, width, height };
  }

  // 8-bit only path. Adaptive: whole-frame levels, tile only a massive scan's full level.
  // Tile-all (Phase 3): every level is a JXTC tile container.
  const levels: PyramidLevelBytes[] = [];
  let cur = rgba;
  let cw = width, ch = height;
  // consume Agent5: planLadder(master) already applies <master + ratio guard
  const p = planLadder(masterLong);
  const targets = [...p.sidecars, { size: masterLong, distance: p.fullDistance }];
  targets.sort((a, b) => b.size - a.size); // L1: descend for correct cascade (full first)
  const massive = isMassive(width, height);
  let lastW = -1, lastH = -1;
  for (const t of targets) {
    throwIfAborted(signal, "encode"); // finding 67: stop between levels on deadline/cancel
    const dst = targetDimsForLongEdge(width, height, t.size);
    if (dst.w === lastW && dst.h === lastH) continue; // L2
    if (dst.w !== cw || dst.h !== ch) {
      cur = await jxl.downscaleRgba8(cur, cw, ch, dst.w, dst.h, signal);
      cw = dst.w; ch = dst.h;
    }
    lastW = cw; lastH = ch;
    const isFull = cw === width && ch === height;
    // never: nothing tiles. adaptive: tile only a massive full level. tile-all: everything tiles.
    const tiled = tiling === "tile-all" || (tiling === "adaptive" && isFull && massive);
    const stagedBytes = cur.byteLength;
    const data = tiled
      ? await jxl.encodeTileContainer(cur, cw, ch, { tileSize: TILE_SIZE, distance: t.distance, effort: EFFORT }, signal)
      : (await jxl.encodePyramid(cur, cw, ch, { sidecars: [], fullDistance: t.distance, effort: EFFORT }, signal))[0]!.data;
    // finding 71: capture the RGBA8 reference for profiled levels (>=1024). `cur` is a stable snapshot
    // (the full level uses the original `rgba`; downscaleRgba8 returns fresh buffers thereafter).
    const refPixels = captureRef && Math.max(cw, ch) >= PROFILE_MIN_LONG ? cur : undefined;
    levels.push({ data, width: cw, height: ch, bitsPerSample: 8, tiled, ...(tiled ? { tileSize: TILE_SIZE, tileVersion: 1 as const } : {}), stagedBytes, ...(refPixels ? { refPixels } : {}) });
  }
  levels.reverse(); // L1: restore ascending
  // L7
  levels.sort((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height)); // levels are ascending by long edge
  if (profileConvergence) await attachConverged(jxl, levels, opts?.profileMemBudgetBytes ?? DEFAULT_PROFILE_MEM_BUDGET);
  return {
    levels,
    orientation: decoded.orientation,
    width,
    height,
  };
}

async function attachConverged(jxl: JxlBackend, levels: PyramidLevelBytes[], memBudgetBytes = DEFAULT_PROFILE_MEM_BUDGET): Promise<void> {
  // L5: profile levels (Butteraugli/ssim) concurrently — each level is an independent input.
  // finding 71: BOUND that fan-out with a byte-weighted semaphore so the total in-flight reference
  // pixels never exceed the ingest memory budget, and REUSE each level's already-generated reference
  // (lvl.refPixels) so the reference is decoded once, not re-decoded per level.
  const sem = new ByteWeightedSemaphore(memBudgetBytes > 0 ? memBudgetBytes : DEFAULT_PROFILE_MEM_BUDGET);
  const tasks = levels.map(async (lvl) => {
    const mx = Math.max(lvl.width, lvl.height);
    if (mx < PROFILE_MIN_LONG) return;
    // Weight = the reference pixels this task holds live (tight RGBA8), so the budget bounds real
    // peak memory. Fall back to the encoded byte size when no reference was captured.
    const weight = lvl.refPixels?.length ?? (lvl.width * lvl.height * 4);
    const release = await sem.acquire(weight);
    try {
      const ref = lvl.refPixels;
      if (typeof jxl.profileConvergenceCurve === "function") {
        // full curve: persisted to manifest so clients pick any byte/quality cutoff offline
        const prof = await jxl.profileConvergenceCurve(lvl.data, lvl.width, lvl.height, ref);
        if (prof) {
          if (prof.convergedByteEnd != null && prof.convergedByteEnd > 0) lvl.convergedByteEnd = prof.convergedByteEnd;
          if (prof.curve.length > 0) lvl.qualityCurve = prof.curve;
        }
      } else if (typeof jxl.profileConvergence === "function") {
        const ce = await jxl.profileConvergence(lvl.data, lvl.width, lvl.height, ref);
        if (ce != null && ce > 0) lvl.convergedByteEnd = ce;
      }
    } catch {
      // graceful: omit on error, single-pass JXL, or no ssim
    } finally {
      lvl.refPixels = undefined; // drop the reference so its bytes are collectable + never persisted
      release();
    }
  });
  await Promise.all(tasks);
}

export async function buildJpgLadder(
  jxl: JxlBackend,
  jpeg: Uint8Array,
  profileConvergence = false,
  orientation: Orientation = "source",
  tiling: TilingPolicy = "adaptive",
  signal?: AbortSignal,
  opts?: LadderOptions,
): Promise<LadderResult> {
  // Transcode (lossless JPEG->JXL), then decode once for the downscaled sidecar levels.
  throwIfAborted(signal, "decode"); // finding 67: do not begin transcode/decode after the deadline
  const fullJxl = await jxl.transcodeJpeg(jpeg);
  const decoded = await jxl.decodeToRgba8(fullJxl);
  const w = decoded.width, h = decoded.height;
  const masterLong = Math.max(w, h);
  const captureRef = profileConvergence; // finding 71: only hold references when profiling runs
  throwIfAborted(signal, "encode"); // deadline may have fired during transcode/decode

  // consume Agent5: planLadder(master) gives ratio-guarded sidecars (all < master)
  const p = planLadder(masterLong);
  const sidecarTargets = [...p.sidecars].sort((a, b) => b.size - a.size); // L1: descend cascade

  const levels: PyramidLevelBytes[] = [];
  let cur = decoded.rgba;
  let cw = w, ch = h;
  let lastW = -1, lastH = -1;
  for (const t of sidecarTargets) {
    throwIfAborted(signal, "encode"); // finding 67: stop between levels on deadline/cancel
    const dst = targetDimsForLongEdge(w, h, t.size);
    if (dst.w === lastW && dst.h === lastH) continue; // L2
    if (dst.w !== cw || dst.h !== ch) {
      cur = await jxl.downscaleRgba8(cur, cw, ch, dst.w, dst.h, signal);
      cw = dst.w; ch = dst.h;
    }
    lastW = cw; lastH = ch;
    const tiled = tiling === "tile-all";
    const stagedBytes = cur.byteLength;
    const data = tiled
      ? await jxl.encodeTileContainer(cur, cw, ch, { tileSize: TILE_SIZE, distance: t.distance, effort: EFFORT }, signal)
      : (await jxl.encodePyramid(cur, cw, ch, { sidecars: [], fullDistance: t.distance, effort: EFFORT }, signal))[0]!.data;
    const refPixels = captureRef && Math.max(cw, ch) >= PROFILE_MIN_LONG ? cur : undefined; // finding 71
    levels.push({ data, width: cw, height: ch, bitsPerSample: 8, tiled, ...(tiled ? { tileSize: TILE_SIZE, tileVersion: 1 as const } : {}), stagedBytes, ...(refPixels ? { refPixels } : {}) });
  }
  // Full level. Adaptive: reuse the bit-exact lossless transcode (fast + lossless — see the
  // jpg-full-transcode-vs-jxtc flipflop). Tile-all: a lossy JXTC re-encode for uniform tiled decode.
  throwIfAborted(signal, "encode"); // finding 67: before the (heavy) full level
  const fullRef = captureRef && Math.max(w, h) >= PROFILE_MIN_LONG ? decoded.rgba : undefined; // finding 71
  if (tiling === "tile-all") {
    const data = await jxl.encodeTileContainer(decoded.rgba, w, h, { tileSize: TILE_SIZE, distance: p.fullDistance, effort: EFFORT }, signal);
    levels.push({ data, width: w, height: h, bitsPerSample: 8, tiled: true, tileSize: TILE_SIZE, tileVersion: 1, stagedBytes: decoded.rgba.byteLength, ...(fullRef ? { refPixels: fullRef } : {}) });
  } else {
    levels.push({ data: fullJxl, width: w, height: h, bitsPerSample: 8, tiled: false, stagedBytes: decoded.rgba.byteLength, ...(fullRef ? { refPixels: fullRef } : {}) });
  }
  levels.sort((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height)); // L7: ascending by long edge
  if (profileConvergence) await attachConverged(jxl, levels, opts?.profileMemBudgetBytes ?? DEFAULT_PROFILE_MEM_BUDGET);
  return {
    levels,
    orientation,
    width: w,
    height: h,
  };
}

export async function buildProxyLadder(
  jxl: JxlBackend,
  rgba: Uint8Array,
  width: number,
  height: number,
  size: number,
  orientation: Orientation,
  profileConvergence = false,
  signal?: AbortSignal,
  opts?: LadderOptions,
): Promise<LadderResult> {
  throwIfAborted(signal, "encode"); // finding 67: do not begin proxy encode after the deadline
  // L6: proxy is the only path still using encodePyramid (monolithic whole-frame JXL, no tiled:true).
  // All other ladders emit JXTC via encodeTileContainer (tiled:true). The jxl-pyramid decoder
  // (level-source.ts) supports both "whole" and "tiled" LevelSource kinds; prepareDecodePlan
  // requires tiled for region/tile paths but whole is valid for the single small proxy level.
  // Monolithic is intentional here (proxy is one small level; single-shot decode has lower overhead
  // than JXTC tile index for tiny payloads). Documented; no switch to encodeTileContainer.
  const produced = await jxl.encodePyramid(rgba, width, height, planProxy(size), signal);
  const level = produced[0];
  if (!level) throw new Error("proxy encode produced no level");
  const refPixels = profileConvergence && Math.max(width, height) >= PROFILE_MIN_LONG ? rgba : undefined; // finding 71
  const outLevels: PyramidLevelBytes[] = [{ ...level, bitsPerSample: 8, stagedBytes: rgba.byteLength, ...(refPixels ? { refPixels } : {}) }];
  if (profileConvergence) await attachConverged(jxl, outLevels, opts?.profileMemBudgetBytes ?? DEFAULT_PROFILE_MEM_BUDGET);
  return { levels: outLevels, orientation, width, height };
}