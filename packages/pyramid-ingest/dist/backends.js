import * as JxlWasmNS from "@casabio/jxl-wasm";
const JW = JxlWasmNS;
export function createJxlBackend(telemetry) {
    const tel = telemetry;
    return {
        async encodePyramid(rgba, width, height, opts) {
            const sidecarSizes = opts.sidecars.map((s) => s.size);
            const sidecarDistances = opts.sidecars.map((s) => s.distance);
            const enc = JW.encodeRgba8Pyramid;
            const levels = await enc(rgba, width, height, {
                fullDistance: opts.fullDistance,
                sidecarSizes,
                sidecarDistances,
                effort: opts.effort,
                hasAlpha: false,
                resampling: 1,
            });
            return levels.map((l) => ({ data: l.data, width: l.width, height: l.height }));
        },
        async encodeTileContainer(rgba, width, height, opts) {
            const t0 = Date.now();
            const enc = JW.encodeTileContainerRgba8;
            const data = await enc(rgba, width, height, {
                tileSize: opts.tileSize,
                distance: opts.distance,
                effort: opts.effort,
                hasAlpha: false,
            });
            const ms = Date.now() - t0;
            tel?.stage?.("encode-tile-container", { w: width, h: height, inputBytes: rgba.byteLength, ms });
            return data;
        },
        async encodeTileContainer16(rgba16, width, height, opts) {
            const t0 = Date.now();
            const enc = JW.encodeTileContainerRgba16;
            if (typeof enc !== "function")
                throw new Error("encodeTileContainerRgba16 missing on jxl-wasm module (16-bit JXTC build required)"); // BK-4
            const data = await enc(rgba16, width, height, {
                tileSize: opts.tileSize,
                distance: opts.distance,
                effort: opts.effort,
                hasAlpha: false,
            });
            const ms = Date.now() - t0;
            tel?.stage?.("encode-tile-container-16", { w: width, h: height, inputBytes: rgba16.byteLength, ms });
            return data;
        },
        async downscaleRgba8(rgba, srcW, srcH, dstW, dstH) {
            const t0 = Date.now();
            const ds = JW.downscaleRgba8;
            if (typeof ds !== "function")
                throw new Error("downscaleRgba8 missing on jxl-wasm module");
            const out = await ds(rgba, srcW, srcH, dstW, dstH);
            const ms = Date.now() - t0;
            tel?.stage?.("downscale-rgba8", { srcW, srcH, dstW, dstH, outputBytes: out.byteLength, ms });
            return out;
        },
        async downscaleRgba16(rgba16, srcW, srcH, dstW, dstH) {
            const t0 = Date.now();
            const ds = JW.downscaleRgba16;
            if (typeof ds !== "function")
                throw new Error("downscaleRgba16 missing on jxl-wasm module");
            const out = await ds(rgba16, srcW, srcH, dstW, dstH);
            const ms = Date.now() - t0;
            tel?.stage?.("downscale-rgba16", { srcW, srcH, dstW, dstH, outputBytes: out.byteLength, ms });
            return out;
        },
        async transcodeJpeg(jpeg) {
            const tx = JW.transcodeJpegToJxl;
            return tx(jpeg);
        },
        async decodeToRgba8(jxl) {
            const ref = await decodeFinal(jxl);
            if (!ref)
                throw new Error("decode produced no final frame");
            return { rgba: ref.pixels, width: ref.w, height: ref.h };
        },
        async profileConvergence(jxl, w, h) {
            const t0 = Date.now();
            const prof = await measureConvergenceProfile(jxl, w, h);
            const ms = Date.now() - t0;
            tel?.stage?.("profile-convergence", { w, h, kind: "cutoff", ms, converged: !!prof?.convergedByteEnd });
            return prof?.convergedByteEnd;
        },
        async profileConvergenceCurve(jxl, w, h) {
            const t0 = Date.now();
            const prof = await measureConvergenceProfile(jxl, w, h);
            const ms = Date.now() - t0;
            const curveLen = prof?.curve?.length ?? 0;
            tel?.stage?.("profile-convergence", { w, h, kind: "curve", ms, curveLen, converged: !!prof?.convergedByteEnd });
            return prof;
        },
    };
}
const SSIM_CONVERGED = 0.9995;
const BUTTERAUGLI_CONVERGED = 1.1;
// ssim cache (hoisted: was dynamic import per profile call / per level)
let cachedSsim = undefined;
async function getCachedSsimFn() {
    if (cachedSsim !== undefined)
        return cachedSsim;
    try {
        const ssimMod = await import("ssim.js").catch(() => null);
        const f = ssimMod && (ssimMod.default || ssimMod).ssim;
        cachedSsim = (typeof f === "function") ? f : null;
    }
    catch {
        cachedSsim = null;
    }
    return cachedSsim ?? null; // BK-9: narrow away the `undefined` the module-level let carries
}
// Final-only decode helper (used by decodeToRgba8 and by measure for ref without buffering passes).
// Reuses the same decoder creation + event contract as before.
async function decodeFinal(jxl) {
    if (!jxl || jxl.length === 0)
        return undefined;
    const createDecoder = JW.createDecoder;
    if (typeof createDecoder !== "function")
        return undefined;
    const decoder = createDecoder({
        format: "rgba8",
        progressionTarget: "final",
        emitEveryPass: false,
        preserveIcc: false,
        preserveMetadata: false,
    });
    let result = null;
    const drainP = (async () => {
        for await (const ev of decoder.events()) {
            if (ev.type === "final") {
                const raw = ev.pixels;
                const px = raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(raw);
                result = { pixels: px, w: ev.info?.width ?? 0, h: ev.info?.height ?? 0 };
            }
            else if (ev.type === "error") {
                throw new Error(`final decode ${ev.code}: ${ev.message}`);
            }
        }
    })();
    try {
        await Promise.resolve(decoder.push(jxl));
        await Promise.resolve(decoder.close());
        await drainP;
    }
    finally {
        await Promise.resolve(decoder.dispose?.()).catch(() => { });
    }
    return result || undefined;
}
/** Measure ssim + butteraugli for every progressive pass vs the level's own final.
 *  Butteraugli is computed per pass (not just as ssim fallback) because the curve itself is the
 *  deliverable — persisted to the manifest so clients never measure at download time. Cost is
 *  opt-in behind --profile-convergence. Uses ButteraugliComparator when available (reference
 *  uploaded once) and falls back to per-pass computeButteraugli, then ssim-only.
 *
 *  Streaming optimization: obtain final ref via 1 full decode (no emit), then progressive decode
 *  with emitEveryPass; on each "progress" compute metric immediately vs known ref and drop px.
 *  Result: O(1) full-res pixel buffers live (final + curve metadata) instead of O(#passes).
 *  Trade: 2 decodes vs 1, but eliminates N allocs/copies/GC which dominate for butter on high-MP + many passes.
 *  Retains identical curve pts, converged logic, small-image skip, and error behavior. */
async function measureConvergenceProfile(jxl, w, h) {
    // 1. final ref (no progress events)
    const ref = await decodeFinal(jxl);
    if (!ref)
        return undefined;
    let finalPixels = ref.pixels;
    let useW = ref.w || (w ?? 0);
    let useH = ref.h || (h ?? 0);
    if (!finalPixels || Math.max(useW, useH) < 1024)
        return undefined;
    // SSIM engine: prefer the WASM kernel (_jxl_wasm_ssim_compare) — measured 95-97% faster than
    // ssim.js on synthetic + real camera pixels at 1024/2048/4096 (docs/SSIM-buffer-engine-flipflop-spec-2026-06-19.md,
    // flipflopjournal "ssim-buffer-engine"). It is present in the split enc/dec WASM builds the facade
    // loads first; ssim.js remains the fallback when the build lacks the symbol (returns null).
    // NOTE: WASM SSIM and ssim.js differ by up to ~1-2% (image-dependent), so SSIM_CONVERGED (0.9995)
    // was calibrated to ssim.js — it may need recalibration to the WASM-SSIM scale. butteraugli<=1.1
    // is the primary convergence gate; the ssim gate only shifts (conservatively) until recalibrated.
    const ssimWasm = typeof JW.computeSsimWasm === "function"
        ? JW.computeSsimWasm
        : null;
    const ssimFn = ssimWasm ? null : await getCachedSsimFn();
    const refImg = ssimFn ? { data: Uint8ClampedArray.from(finalPixels), width: useW, height: useH } : null;
    let comparator = null;
    if (JW.ButteraugliComparator && typeof JW.ButteraugliComparator.create === "function") {
        try {
            comparator = await JW.ButteraugliComparator.create(finalPixels, useW, useH);
        }
        catch {
            comparator = null;
        }
    }
    const butterFallback = !comparator && typeof JW.computeButteraugli === "function";
    // 2. progressive decode; metric on-receipt, discard pass pixels immediately
    const createDecoder = JW.createDecoder;
    if (typeof createDecoder !== "function")
        return undefined;
    const decoder = createDecoder({
        format: "rgba8",
        progressionTarget: "final",
        emitEveryPass: true,
        preserveIcc: false,
        preserveMetadata: false,
    });
    const curve = [];
    let bytesPushed = 0;
    const drainP = (async () => {
        for await (const ev of decoder.events()) {
            if (ev.type === "header") {
                useW = ev.info?.width ?? useW;
                useH = ev.info?.height ?? useH;
            }
            else if (ev.type === "progress") {
                const raw = ev.pixels;
                const px = raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(raw);
                // compute immediately vs known final (no buffering of px)
                let ssimVal;
                if (px.length === finalPixels.length) {
                    if (ssimWasm) {
                        try {
                            const v = await ssimWasm(px, finalPixels, useW, useH);
                            if (typeof v === "number" && Number.isFinite(v))
                                ssimVal = Math.round(v * 1e6) / 1e6;
                        }
                        catch { }
                    }
                    else if (ssimFn && refImg) {
                        try {
                            const img1 = { data: Uint8ClampedArray.from(px), width: useW, height: useH };
                            const res = ssimFn(img1, refImg);
                            const v = typeof res === "number" ? res : res && res.mssim;
                            if (typeof v === "number" && Number.isFinite(v))
                                ssimVal = Math.round(v * 1e6) / 1e6;
                        }
                        catch { }
                    }
                }
                let ba;
                if (comparator && px.length === finalPixels.length) {
                    try {
                        const v = comparator.compare(px);
                        if (typeof v === "number" && Number.isFinite(v))
                            ba = Math.round(v * 1e4) / 1e4;
                    }
                    catch { }
                }
                else if (butterFallback && px.length === finalPixels.length) {
                    try {
                        const v = await JW.computeButteraugli(px, finalPixels, useW, useH);
                        if (typeof v === "number" && Number.isFinite(v))
                            ba = Math.round(v * 1e4) / 1e4;
                    }
                    catch { }
                }
                if (ssimVal !== undefined || ba !== undefined) {
                    const pt = { bytes: bytesPushed };
                    if (ssimVal !== undefined)
                        pt.ssim = ssimVal;
                    if (ba !== undefined)
                        pt.butteraugli = ba;
                    const last = curve[curve.length - 1];
                    if (last && last.bytes === pt.bytes)
                        curve[curve.length - 1] = pt;
                    else
                        curve.push(pt);
                }
                // px dropped here
            }
            else if (ev.type === "final") {
                // optional sanity: final should match our ref len
            }
            else if (ev.type === "error") {
                throw new Error(`profile decode ${ev.code}: ${ev.message}`);
            }
        }
    })();
    try {
        const CHUNK = 32768;
        for (let off = 0; off < jxl.length; off += CHUNK) {
            const end = Math.min(off + CHUNK, jxl.length);
            const chunk = jxl.subarray(off, end);
            bytesPushed += chunk.length;
            await Promise.resolve(decoder.push(chunk));
        }
        await Promise.resolve(decoder.close());
        await drainP;
    }
    catch {
        await Promise.resolve(decoder.dispose?.()).catch(() => { });
        return undefined;
    }
    finally {
        await Promise.resolve(decoder.dispose?.()).catch(() => { });
        comparator?.dispose?.();
    }
    if (curve.length === 0)
        return undefined;
    // Legacy convergedByteEnd: first pass meeting saturation, valid only when it saves bytes.
    let convergedByteEnd;
    for (const pt of curve) {
        const meets = (pt.ssim !== undefined && pt.ssim >= SSIM_CONVERGED) ||
            (pt.butteraugli !== undefined && pt.butteraugli <= BUTTERAUGLI_CONVERGED);
        if (meets) {
            if (pt.bytes > 0 && pt.bytes < jxl.length)
                convergedByteEnd = pt.bytes;
            break;
        }
    }
    const prof = convergedByteEnd !== undefined ? { curve, convergedByteEnd } : { curve };
    // tel (if wired at create time; measure called via backend methods that close over tel)
    // stage is best-effort; caller of createJxlBackend may have provided it
    // (light; actual stage emission happens via the profile* wrappers below too)
    return prof;
}
//# sourceMappingURL=backends.js.map