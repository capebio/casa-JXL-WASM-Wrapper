import * as JxlWasmNS from "@casabio/jxl-wasm";
const JW = JxlWasmNS;
/** Packed LE RGB u16 (6 bytes/pixel) → RGBA16 interleaved (alpha = 65535). */
export function packedRgb16ToRgba16(packed, width, height) {
    const need = width * height * 6;
    if (packed.length < need) {
        throw new Error(`packedRgb16 too small: ${packed.length} < ${need}`);
    }
    const n = width * height;
    const out = new Uint16Array(n * 4);
    // DataView for explicit LE (matches "packed LE"); profile vs direct ![] if JIT prefers.
    // True zero-copy win is WASM binding from Rust 16-bit output (see lens20 pointer move + boundary).
    const dv = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
    for (let i = 0; i < n; i++) {
        const o = i * 6;
        const o16 = i * 4;
        out[o16] = dv.getUint16(o, true);
        out[o16 + 1] = dv.getUint16(o + 2, true);
        out[o16 + 2] = dv.getUint16(o + 4, true);
        out[o16 + 3] = 65535;
    }
    return out;
}
export function targetDimsForLongEdge(width, height, longEdge) {
    if (longEdge < 1)
        throw new Error(`longEdge must be >=1, got ${longEdge}`);
    const le = Math.max(width, height);
    if (longEdge >= le)
        return { w: width, h: height };
    if (width >= height) {
        const lw = longEdge;
        return { w: lw, h: Math.max(1, Math.round((height * lw) / width)) };
    }
    const lh = longEdge;
    return { w: Math.max(1, Math.round((width * lh) / height)), h: lh };
}
/**
 * Encode RAW big levels {2048, full} as true 16-bit JXL via WASM downscale + encode.
 * Master full always from original buffer; 2048+ sidecars downscale from it (desc).
 * linear?: true reserves path for non-Riemannian / perceptual constancy (lens17) and photogram linear reflectance.
 * Currently forwarded as no-op (encode path unchanged); when engine lands in Rust LookRenderer, plumb here.
 */
export async function encodeBigLevelsRgba16(packedRgb16, masterW, masterH, plan, linear) {
    let rgba16 = packedRgb16ToRgba16(packedRgb16, masterW, masterH);
    let curW = masterW;
    let curH = masterH;
    const masterLong = Math.max(masterW, masterH);
    const targets = [
        { longEdge: masterLong, distance: plan.fullDistance },
    ];
    const bigSidecars = plan.sidecars
        .filter((sc) => sc.size >= 2048 && sc.size < masterLong)
        .sort((a, b) => b.size - a.size);
    for (const sc of bigSidecars) {
        targets.push({ longEdge: sc.size, distance: sc.distance });
    }
    const levels = [];
    for (const t of targets) {
        const dst = targetDimsForLongEdge(masterW, masterH, t.longEdge);
        if (dst.w > curW || dst.h > curH) {
            throw new Error(`rgb16 encode order violation: dst ${dst.w}x${dst.h} > cur ${curW}x${curH} (must be <=)`);
        }
        if (dst.w !== curW || dst.h !== curH) {
            rgba16 = await JW.downscaleRgba16(rgba16, curW, curH, dst.w, dst.h);
            curW = dst.w;
            curH = dst.h;
        }
        const enc = await JW.encodeRgba16(rgba16, curW, curH, {
            distance: t.distance,
            effort: plan.effort,
            hasAlpha: false,
        });
        levels.push({
            data: enc.data,
            width: enc.width,
            height: enc.height,
            bitsPerSample: 16,
        });
    }
    return levels;
}
//# sourceMappingURL=rgb16.js.map