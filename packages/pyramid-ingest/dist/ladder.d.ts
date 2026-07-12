import type { DecodedMaster, JxlBackend, Orientation, PyramidLevelBytes } from "./backends.js";
export interface LadderResult {
    levels: PyramidLevelBytes[];
    orientation: Orientation;
    width: number;
    height: number;
}
/**
 * Per-batch tiling policy (chosen at encode time, e.g. `--tiling`):
 * - "adaptive" (default): whole-frame levels; tile ONLY a massive scan's full level; a JPEG
 *   master's full level is the bit-exact lossless transcode. Faster + lossless full (see the
 *   jpg-full-transcode-vs-jxtc flipflop: transcode ~3.5x faster than JXTC re-encode).
 * - "tile-all" (Phase 3): every level is a JXTC tile container (uniform tile/region random-access
 *   decode; the full level is a lossy re-encode even for JPEG masters).
 */
export type TilingPolicy = "adaptive" | "tile-all";
export declare function buildRawLadder(jxl: JxlBackend, decoded: DecodedMaster, profileConvergence?: boolean, tiling?: TilingPolicy): Promise<LadderResult>;
export declare function buildJpgLadder(jxl: JxlBackend, jpeg: Uint8Array, profileConvergence?: boolean, orientation?: Orientation, tiling?: TilingPolicy): Promise<LadderResult>;
export declare function buildProxyLadder(jxl: JxlBackend, rgba: Uint8Array, width: number, height: number, size: number, orientation: Orientation, profileConvergence?: boolean): Promise<LadderResult>;
//# sourceMappingURL=ladder.d.ts.map