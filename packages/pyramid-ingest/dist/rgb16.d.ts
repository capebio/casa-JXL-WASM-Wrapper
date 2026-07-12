import type { PyramidEncodeOptions, PyramidLevelBytes } from "./backends.js";
/** Packed LE RGB u16 (6 bytes/pixel) → RGBA16 interleaved (alpha = 65535). */
export declare function packedRgb16ToRgba16(packed: Uint8Array, width: number, height: number): Uint16Array;
export declare function targetDimsForLongEdge(width: number, height: number, longEdge: number): {
    w: number;
    h: number;
};
/**
 * Encode RAW big levels {2048, full} as true 16-bit JXL via WASM downscale + encode.
 * Master full always from original buffer; 2048+ sidecars downscale from it (desc).
 * linear?: true reserves path for non-Riemannian / perceptual constancy (lens17) and photogram linear reflectance.
 * Currently forwarded as no-op (encode path unchanged); when engine lands in Rust LookRenderer, plumb here.
 */
export declare function encodeBigLevelsRgba16(packedRgb16: Uint8Array, masterW: number, masterH: number, plan: PyramidEncodeOptions, linear?: boolean): Promise<PyramidLevelBytes[]>;
//# sourceMappingURL=rgb16.d.ts.map