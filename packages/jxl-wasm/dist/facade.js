const DEC_FLAG_SUPPRESS_DUPLICATE_PROGRESS = 1;
const DEC_FLAG_ALLOW_ALPHA_PROGRESSIVE = 2;
const TEXT_ENCODER = new TextEncoder();
export const DOWNSAMPLE_THUMBNAILS = 2;
export const DOWNSAMPLE_GRID = 4;
/**
 * Named constants for common JXL_ENC_FRAME_SETTING_* values.
 * Use with the `advancedFrameSettings` escape hatch for experimental/advanced features
 * (patches, future spline controls, etc.).
 *
 * These are intentionally minimal — the escape hatch exists precisely so we do not
 * need to expose every possible libjxl knob as a first-class option.
 */
export const JxlFrameSetting = {
    /** Enables or disables patches generation. -1 default, 0 disable, 1 enable. */
    PATCHES: 8,
    // Add more known values here as needed (EPF, GABORISH, etc.)
};
function normalizeDecoderOptions(options) {
    const downsample = options.downsample ?? (options.region != null ? pickDownsample(options) : undefined);
    return {
        ...options,
        region: options.region ?? null,
        // Omit the key entirely when undefined (exactOptionalPropertyTypes forbids `downsample: undefined`).
        ...(downsample !== undefined ? { downsample } : {}),
        ...(options.progressiveDetail !== undefined ? { progressiveDetail: options.progressiveDetail } : {}),
        targetWidth: options.targetWidth ?? null,
        targetHeight: options.targetHeight ?? null,
        fitMode: options.fitMode ?? null,
    };
}
function resolveDecoderProgressiveDetail(options) {
    if (options.progressionTarget === "header")
        return 0;
    // Disable progressive only when the caller did not request a detail level and wants
    // a plain final decode (progressionTarget=final, emitEveryPass=false). An explicit
    // progressiveDetail such as lastPasses must still subscribe to libjxl progressive
    // events even when emitEveryPass is false (Single Progressive default).
    if (options.progressiveDetail === undefined && !(options.progressionTarget !== "final" || options.emitEveryPass))
        return 0;
    const detail = options.progressiveDetail
        ?? (options.emitEveryPass || options.progressionTarget === "pass" ? "passes" : "dc");
    switch (detail) {
        case "dc":
            return 1;
        case "lastPasses":
            return 2;
        case "passes":
            return 3;
        case "dcProgressive":
            return 4;
        default:
            return 1;
    }
}
function resolveProgressFrameBudget(options) {
    const maxFrames = options.maxProgressiveFrames;
    if (maxFrames == null)
        return Number.POSITIVE_INFINITY;
    if (!Number.isFinite(maxFrames))
        return Number.POSITIVE_INFINITY;
    return Math.max(0, Math.trunc(maxFrames) - 1);
}
function resolveEncoderBridgeSettings(options) {
    const groupOrder = options.groupOrder ?? 0;
    if (!options.progressive) {
        return { progressiveDc: 0, progressiveAc: 0, qProgressiveAc: 0, buffering: options.chunked ? 2 : 0, groupOrder };
    }
    const acEnabled = options.progressiveFlavor === "ac" || (options.progressiveFlavor !== "dc" && options.previewFirst);
    return {
        progressiveDc: options.progressiveDc ?? 1,
        progressiveAc: options.progressiveAc != null ? options.progressiveAc : (acEnabled ? 1 : 0),
        qProgressiveAc: options.qProgressiveAc != null ? options.qProgressiveAc : (acEnabled ? 1 : 0),
        buffering: 2,
        groupOrder,
    };
}
export class CapabilityMissing extends Error {
    code = "CapabilityMissing";
    cause;
    constructor(message, cause) {
        super(message);
        this.name = "CapabilityMissing";
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}
export function detectTier() {
    if (_cachedDetectedTier !== undefined)
        return _cachedDetectedTier;
    let tier;
    if (typeof WebAssembly === "undefined") {
        tier = "scalar";
    }
    else {
        const hasSimd = probeSimd();
        if (!hasSimd) {
            tier = "scalar";
        }
        else {
            // Threaded WASM needs BOTH: (1) SharedArrayBuffer for shared memory — browsers gate it
            // behind cross-origin isolation (COOP/COEP), else `new WebAssembly.Memory({shared:true})`
            // throws at instantiation; and (2) the web `Worker` constructor to spawn pthreads, since the
            // modules are built `-sENVIRONMENT=web,worker`. Plain Node has SharedArrayBuffer but NO web
            // `Worker`, so the *-mt modules throw "Worker is not defined" at init there — demote to simd.
            const hasSab = typeof SharedArrayBuffer !== "undefined" &&
                (typeof crossOriginIsolated === "undefined" || crossOriginIsolated === true);
            const hasWorker = typeof Worker !== "undefined";
            const hasThreads = hasSab && hasWorker;
            // relaxed-simd-mt is built with HWY_WANT_WASM2 (8-lane EMU256), NOT relaxed-SIMD opcodes.
            // The build gate (assert-no-relaxed-simd.mjs) enforces 0 relaxed opcodes; enc SHA is
            // byte-identical to simd-mt (A/B confirmed 2026-07-03). Safe on all browsers with SAB+Worker.
            if (hasThreads)
                tier = "relaxed-simd-mt";
            else
                tier = "simd";
        }
    }
    _cachedDetectedTier = tier;
    return tier;
}
/**
 * Returns a sensible default effort level for the current WASM tier.
 * Scalar workers get a lower effort to avoid blocking the thread; SIMD-MT
 * workers get full effort since they can use parallel libjxl codepaths.
 */
export function recommendedEffort() {
    const tier = detectTier();
    if (tier === "scalar")
        return 4;
    if (tier === "simd")
        return 6;
    return 7; // simd-mt, relaxed-simd-mt
}
function probeSimd() {
    try {
        return WebAssembly.validate(new Uint8Array([
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
            0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
            0x03, 0x02, 0x01, 0x00,
            0x0a, 0x08, 0x01, 0x06, 0x00,
            0x41, 0x00, 0xfd, 0x0f, 0x0b,
        ]));
    }
    catch {
        return false;
    }
}
function probeRelaxedSimd() {
    try {
        return WebAssembly.validate(new Uint8Array([
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
            0x01, 0x07, 0x01, 0x60, 0x02, 0x7b, 0x7b, 0x01, 0x7b,
            0x03, 0x02, 0x01, 0x00,
            0x0a, 0x0b, 0x01, 0x09, 0x00,
            0x20, 0x00, 0x20, 0x01, 0xfd, 0x80, 0x02, 0x0b,
        ]));
    }
    catch {
        return false;
    }
}
let modulePromise;
let testModuleFactory = null;
let _forcedTier = null;
let _cachedDetectedTier;
export function setJxlModuleFactoryForTesting(factory) {
    testModuleFactory = factory;
    modulePromise = undefined;
    _a6Checked = false;
}
/**
 * Override the WASM tier used on the next module load.
 * Pass null to restore auto-detection via detectTier().
 * Resets the cached module so the next encode/decode reloads with the new tier.
 */
export function setForcedTier(tier) {
    _forcedTier = tier;
    _cachedDetectedTier = undefined;
    modulePromise = undefined;
    _a6Checked = false;
}
export function getForcedTier() {
    return _forcedTier;
}
export function createDecoder(options) {
    return new LibjxlDecoder(normalizeDecoderOptions(options));
}
// Task 3: 72-byte packed descriptor for WASM FFI (exact layout matches C++ struct WasmExtraChannel sizeof==72).
// Byte layout (no padding; 4B aligned) — MUST match `struct WasmExtraChannel` in bridge.cpp (20 bytes):
//   0:type(u32), 4:bits(u32), 8:distance(f32), 12:plane_ptr(u32), 16:plane_size(u32)
// plane_ptr/plane_size left 0 by serialize; filled by TS caller after separate per-plane _malloc.
// TODO: dimShift / spotColor / name on ExtraChannel are NOT yet wired to the C++ encoder
// (no struct field reads them). They are intentionally not serialized until bridge.cpp grows them.
export const EC_BYTES = 20;
const EXTRA_TYPE_TO_JXL = {
    alpha: 0, depth: 1, selection: 3, spot: 2, thermal: 6,
    reserved0: 7, reserved1: 8, reserved2: 9, reserved3: 10, reserved4: 11, reserved5: 12, reserved6: 13, reserved7: 14,
    unknown: 15,
};
/**
 * Serializes ExtraChannel[] to a 20*N byte ArrayBuffer for the EC encode FFI.
 * Layout matches `struct WasmExtraChannel` in bridge.cpp exactly — the ONLY consumer:
 *   0:type(u32), 4:bits(u32), 8:distance(f32), 12:plane_ptr(u32), 16:plane_size(u32).
 * plane_ptr/plane_size left as 0 (filled by caller after per-plane malloc).
 * Returns { buffer, view } for direct DataView writes of pointers/sizes by caller.
 * NOTE: dimShift / spotColor / name on ExtraChannel are NOT serialized — the C++ struct
 * does not read them yet. Wiring them requires growing WasmExtraChannel in bridge.cpp first.
 */
export function serializeExtraChannelsForWasm(channels) {
    const n = channels.length;
    const buf = new ArrayBuffer(EC_BYTES * n);
    const dv = new DataView(buf);
    let off = 0;
    for (const ch of channels) {
        const t = EXTRA_TYPE_TO_JXL[ch.type] ?? 15;
        dv.setUint32(off + 0, t, true);
        dv.setUint32(off + 4, ch.bitsPerSample >>> 0, true);
        dv.setFloat32(off + 8, ch.distance ?? 0, true);
        // plane_ptr (12) and plane_size (16) filled by caller post-malloc
        off += EC_BYTES;
    }
    return { buffer: buf, view: dv };
}
export function createEncoder(options) {
    return new LibjxlEncoder(options);
}
/**
 * Losslessly transcode a JPEG file to JXL without pixel expansion.
 * The resulting JXL embeds the original JPEG bitstream for round-trip fidelity.
 * Requires a WASM build that includes the #15 bridge (jxl_wasm_transcode_jpeg_to_jxl).
 */
export async function transcodeJpegToJxl(jpeg) {
    const module = await loadLibjxlModule();
    if (!getCapabilities(module).jpegTranscode) {
        throw new CapabilityMissing("JPEG→JXL transcode requires a rebuilt WASM with transcode bridge");
    }
    const view = copyOrBorrowInput(jpeg, false);
    const ptr = module._malloc(view.byteLength);
    if (ptr === 0)
        throw new Error("WASM malloc failed for JPEG transcode input");
    try {
        module.HEAPU8.set(view, ptr);
        const handle = module._jxl_wasm_transcode_jpeg_to_jxl(ptr, view.byteLength);
        return takeBuffer(module, handle, "transcode").data;
    }
    finally {
        module._free(ptr);
    }
}
/**
 * Compute Butteraugli perceptual distance between two RGBA8 images.
 * Both pixel buffers must represent the same width×height image in RGBA8 format.
 * Returns the p3 Butteraugli distance (0 = identical, ~1.0 = imperceptible, >2.0 = noticeable).
 * Requires a WASM build with the butteraugli bridge (jxl_wasm_butteraugli_compare).
 */
export async function computeButteraugli(pixels1, pixels2, width, height) {
    const module = await loadLibjxlModule();
    if (!module._jxl_wasm_butteraugli_compare) {
        throw new CapabilityMissing("Butteraugli requires a rebuilt WASM with butteraugli bridge");
    }
    const pixelSize = width * height * 4;
    const view1 = copyOrBorrowInput(pixels1, false);
    const view2 = copyOrBorrowInput(pixels2, false);
    if (view1.byteLength < pixelSize || view2.byteLength < pixelSize) {
        throw new Error(`computeButteraugli: expected ${pixelSize} bytes for ${width}×${height} RGBA8, got ${view1.byteLength}/${view2.byteLength}`);
    }
    const ptr1 = mallocOrThrow(module, pixelSize, "Butteraugli image A");
    let ptr2 = 0;
    try {
        ptr2 = mallocOrThrow(module, pixelSize, "Butteraugli image B");
        module.HEAPU8.set(view1.subarray(0, pixelSize), ptr1);
        module.HEAPU8.set(view2.subarray(0, pixelSize), ptr2);
        const bits = module._jxl_wasm_butteraugli_compare(ptr1, ptr2, width, height);
        if (bits < 0)
            throw new Error("Butteraugli WASM compare failed");
        return floatFromI32Bits(bits);
    }
    finally {
        module._free(ptr1);
        if (ptr2 !== 0)
            module._free(ptr2);
    }
}
/**
 * Compute Butteraugli perceptual distance between two RGBA16 images.
 * Both pixel buffers must represent the same width×height image in RGBA16 format (8 bytes/px).
 * Returns the p3 Butteraugli distance (0 = identical, ~1.0 = imperceptible, >2.0 = noticeable).
 * Requires a WASM build with the 16-bit butteraugli bridge (jxl_wasm_butteraugli_compare16).
 */
export async function computeButteraugli16(pixels1, pixels2, width, height) {
    const module = await loadLibjxlModule();
    if (!module._jxl_wasm_butteraugli_compare16) {
        throw new CapabilityMissing("Butteraugli16 requires a rebuilt WASM with 16-bit butteraugli bridge");
    }
    const pixelSize = width * height * 4 * 2;
    const view1 = copyOrBorrowInput(pixels1, false);
    const view2 = copyOrBorrowInput(pixels2, false);
    if (view1.byteLength < pixelSize || view2.byteLength < pixelSize) {
        throw new Error(`computeButteraugli16: expected ${pixelSize} bytes for ${width}×${height} RGBA16, got ${view1.byteLength}/${view2.byteLength}`);
    }
    const ptr1 = mallocOrThrow(module, pixelSize, "Butteraugli16 image A");
    let ptr2 = 0;
    try {
        ptr2 = mallocOrThrow(module, pixelSize, "Butteraugli16 image B");
        module.HEAPU8.set(view1.subarray(0, pixelSize), ptr1);
        module.HEAPU8.set(view2.subarray(0, pixelSize), ptr2);
        const bits = module._jxl_wasm_butteraugli_compare16(ptr1, ptr2, width, height);
        if (bits < 0)
            throw new Error("Butteraugli16 WASM compare failed");
        return floatFromI32Bits(bits);
    }
    finally {
        module._free(ptr1);
        if (ptr2 !== 0)
            module._free(ptr2);
    }
}
export class ButteraugliComparator {
    module;
    width;
    height;
    refPtr = 0; // raw pixels in WASM heap (legacy single-shot path)
    refStatePtr = 0; // JxlWasmButterRef* (ref-cached path — only test Image3F built per compare)
    candidatePtr = 0; // reused candidate staging buffer (grow-only across compares)
    candidateCap = 0; // capacity in bytes of candidatePtr
    constructor(module, width, height) {
        this.module = module;
        this.width = width;
        this.height = height;
    }
    static async create(reference, width, height) {
        const module = await loadLibjxlModule();
        const m = module;
        if (!module._jxl_wasm_butteraugli_compare && typeof m._jxl_wasm_butteraugli_ref_create !== "function") {
            throw new CapabilityMissing("Butteraugli comparator requires a rebuilt WASM with butteraugli bridge");
        }
        const pixelSize = butteraugliPixelSize(reference, width, height, "ButteraugliComparator.create");
        const view = copyOrBorrowInput(reference, false);
        const comparator = new ButteraugliComparator(module, width, height);
        if (typeof m._jxl_wasm_butteraugli_ref_create === "function") {
            // Ref-cached path (B2): build Image3F for ref once in C++; compare() only builds test.
            // Temp pixel ptr freed immediately after ref state created.
            const ptr = mallocOrThrow(module, pixelSize, "Butteraugli ref pixels temp");
            try {
                module.HEAPU8.set(view.subarray(0, pixelSize), ptr);
                comparator.refStatePtr = m._jxl_wasm_butteraugli_ref_create(ptr, width, height);
                if (comparator.refStatePtr === 0)
                    throw new Error("jxl_wasm_butteraugli_ref_create failed (OOM)");
            }
            finally {
                module._free(ptr);
            }
        }
        else {
            // Legacy path: keep ref raw pixels in WASM heap; both ref+test gamma-decoded per call.
            comparator.refPtr = mallocOrThrow(module, pixelSize, "Butteraugli reference");
            try {
                module.HEAPU8.set(view.subarray(0, pixelSize), comparator.refPtr);
            }
            catch (error) {
                comparator.dispose();
                throw error;
            }
        }
        return comparator;
    }
    compare(candidate) {
        if (this.refStatePtr === 0 && this.refPtr === 0) {
            throw new Error("ButteraugliComparator has been disposed");
        }
        const pixelSize = butteraugliPixelSize(candidate, this.width, this.height, "ButteraugliComparator.compare");
        // Reuse one candidate staging buffer across compares (width×height are fixed at
        // construction, so pixelSize is constant; grow-only handles oversized inputs).
        // Removes a malloc/free pair per compare — meaningful for progressive paints and
        // parameter sweeps that compare many candidates against one reference.
        if (this.candidatePtr === 0 || pixelSize > this.candidateCap) {
            if (this.candidatePtr !== 0)
                this.module._free(this.candidatePtr);
            this.candidatePtr = mallocOrThrow(this.module, pixelSize, "Butteraugli candidate");
            this.candidateCap = pixelSize;
        }
        const ptr = this.candidatePtr;
        const view = copyOrBorrowInput(candidate, false);
        this.module.HEAPU8.set(view.subarray(0, pixelSize), ptr);
        if (this.refStatePtr !== 0) {
            const bits = this.module._jxl_wasm_butteraugli_ref_compare(this.refStatePtr, ptr);
            if (bits < 0)
                throw new Error("Butteraugli WASM compare failed");
            return floatFromI32Bits(bits);
        }
        else {
            const bits = this.module._jxl_wasm_butteraugli_compare(this.refPtr, ptr, this.width, this.height);
            if (bits < 0)
                throw new Error("Butteraugli WASM compare failed");
            return floatFromI32Bits(bits);
        }
    }
    dispose() {
        if (this.refStatePtr !== 0) {
            this.module._jxl_wasm_butteraugli_ref_free(this.refStatePtr);
            this.refStatePtr = 0;
        }
        if (this.refPtr !== 0) {
            this.module._free(this.refPtr);
            this.refPtr = 0;
        }
        if (this.candidatePtr !== 0) {
            this.module._free(this.candidatePtr);
            this.candidatePtr = 0;
            this.candidateCap = 0;
        }
    }
}
/**
 * WASM PSNR between two RGBA8 images. Returns dB (Infinity = identical).
 * Requires rebuilt WASM with jxl_wasm_psnr_compare (Task B3). Returns null if unavailable.
 */
export async function computePsnrWasm(pixels1, pixels2, width, height) {
    const module = await loadLibjxlModule();
    const fn = module._jxl_wasm_psnr_compare;
    if (typeof fn !== "function")
        return null;
    const pixelSize = width * height * 4;
    const v1 = copyOrBorrowInput(pixels1, false);
    const v2 = copyOrBorrowInput(pixels2, false);
    const ptr1 = mallocOrThrow(module, pixelSize, "PSNR image A");
    let ptr2 = 0;
    try {
        ptr2 = mallocOrThrow(module, pixelSize, "PSNR image B");
        module.HEAPU8.set(v1.subarray(0, pixelSize), ptr1);
        module.HEAPU8.set(v2.subarray(0, pixelSize), ptr2);
        return floatFromI32Bits(fn(ptr1, ptr2, width, height));
    }
    finally {
        module._free(ptr1);
        if (ptr2 !== 0)
            module._free(ptr2);
    }
}
/**
 * WASM SSIM between two RGBA8 images. Returns [0,1] (1 = identical).
 * Requires rebuilt WASM with jxl_wasm_ssim_compare (Task B4). Returns null if unavailable.
 */
export async function computeSsimWasm(pixels1, pixels2, width, height) {
    const module = await loadLibjxlModule();
    const fn = module._jxl_wasm_ssim_compare;
    if (typeof fn !== "function")
        return null;
    const pixelSize = width * height * 4;
    const v1 = copyOrBorrowInput(pixels1, false);
    const v2 = copyOrBorrowInput(pixels2, false);
    const ptr1 = mallocOrThrow(module, pixelSize, "SSIM image A");
    let ptr2 = 0;
    try {
        ptr2 = mallocOrThrow(module, pixelSize, "SSIM image B");
        module.HEAPU8.set(v1.subarray(0, pixelSize), ptr1);
        module.HEAPU8.set(v2.subarray(0, pixelSize), ptr2);
        return floatFromI32Bits(fn(ptr1, ptr2, width, height));
    }
    finally {
        module._free(ptr1);
        if (ptr2 !== 0)
            module._free(ptr2);
    }
}
/**
 * Extract embedded JPEG reconstruction from JXL container (if present).
 * Container JXLs (created with encodeTileContainerRgba8/JXTC) may embed
 * the original JPEG bitstream for fast native preview. Scans container
 * header for jbrd (JPEG Reconstruction) box.
 * Returns a copied Uint8Array, or null if no embedded JPEG or not a container JXL.
 */
export function extractJpegReconstructionFromJxl(jxlData) {
    const view = jxlData instanceof Uint8Array ? jxlData : new Uint8Array(jxlData);
    // JXTC magic: 0x4354584A ('JXTC' little-endian at offset 0)
    const isJxtc = view.byteLength >= 4 &&
        view[0] === 0x4A && view[1] === 0x58 && view[2] === 0x54 && view[3] === 0x43;
    if (!isJxtc)
        return null;
    const scanRanges = jxtcNonTileRanges(view);
    if (scanRanges.length === 0)
        return null;
    for (const [start, end] of scanRanges) {
        const jpeg = scanForValidJpeg(view, start, end);
        if (jpeg !== null)
            return jpeg;
    }
    return null;
}
/**
 * Legacy tiled multi-frame JXL encode.
 * Each tile becomes one JXL frame with layer_info.have_crop = JXL_TRUE.
 * Keep this only for compatibility with older callers. Prefer the JXTC tile
 * container path (`encodeTileContainerRgba8` / `decodeTileContainerRegionRgba8`)
 * for new work; it avoids the frame-walk overhead in libjxl and is much faster
 * for crop/ROI benchmarks.
 *
 * Requires a WASM build that includes the tile bridge
 * (jxl_wasm_encode_tiled_rgba8).
 *
 * @param tileSize must match the value passed to decodeTiledRegionRgba8.
 */
export async function encodeTiledRgba8(pixels, width, height, options) {
    const module = await loadLibjxlModule();
    if (!module._jxl_wasm_encode_tiled_rgba8) {
        throw new CapabilityMissing("Tiled encode requires a rebuilt WASM with tile bridge");
    }
    const tileSize = options.tileSize;
    if (!Number.isInteger(tileSize) || tileSize < 16) {
        throw new Error(`tileSize must be an integer ≥ 16, got ${tileSize}`);
    }
    const distance = options.distance ?? 1.0;
    const effort = options.effort ?? 3;
    const hasAlpha = options.hasAlpha !== false;
    const view = copyOrBorrowInput(pixels, false);
    const expectedBytes = width * height * 4;
    if (view.byteLength < expectedBytes) {
        throw new Error(`Pixel buffer too small: ${view.byteLength} < ${expectedBytes}`);
    }
    const ptr = module._malloc(view.byteLength);
    if (ptr === 0)
        throw new Error("WASM malloc failed for tiled encode input");
    try {
        module.HEAPU8.set(view, ptr);
        const handle = module._jxl_wasm_encode_tiled_rgba8(ptr, width, height, tileSize, distance, effort, hasAlpha ? 1 : 0);
        return takeBuffer(module, handle, "tiled encode").data;
    }
    finally {
        module._free(ptr);
    }
}
/**
 * Legacy ROI decode for tiled multi-frame JXL produced by encodeTiledRgba8.
 * Prefer decodeTileContainerRegionRgba8 for new code; the JXTC container
 * avoids the frame-header walk that makes the tiled path significantly slower.
 * Only the JXL frames whose layer bounds overlap the region are decompressed;
 * other frames are skipped via JxlDecoderSkipFrames (header-only walk).
 *
 * Returns clamped region dimensions — caller should pre-clamp if exact size
 * is required.
 */
export async function decodeTiledRegionRgba8(jxlBytes, options) {
    const module = await loadLibjxlModule();
    if (!module._jxl_wasm_decode_region_tiled_rgba8) {
        throw new CapabilityMissing("Tiled region decode requires a rebuilt WASM with tile bridge");
    }
    const { tileSize, x, y, w, h, onMetric } = options;
    if (!Number.isInteger(tileSize) || tileSize < 16) {
        throw new Error(`tileSize must be an integer ≥ 16, got ${tileSize}`);
    }
    const tStart = performance.now();
    const view = copyOrBorrowInput(jxlBytes, false);
    const t1 = performance.now();
    onMetric?.("tiled_region_input_prep", t1 - tStart);
    const t2 = performance.now();
    const ptr = module._malloc(view.byteLength);
    if (ptr === 0)
        throw new Error("WASM malloc failed for tiled decode input");
    const tMalloc = performance.now() - t2;
    onMetric?.("tiled_region_malloc", tMalloc);
    try {
        const t3 = performance.now();
        module.HEAPU8.set(view, ptr);
        const tHeapSet = performance.now() - t3;
        onMetric?.("tiled_region_heap_set", tHeapSet);
        const t4 = performance.now();
        const handle = module._jxl_wasm_decode_region_tiled_rgba8(ptr, view.byteLength, tileSize, x, y, w, h);
        const tWasmDecode = performance.now() - t4;
        onMetric?.("tiled_region_wasm_decode", tWasmDecode);
        const t5 = performance.now();
        const buf = takeBuffer(module, handle, "tiled region decode");
        const tBufferRead = performance.now() - t5;
        onMetric?.("tiled_region_buffer_read", tBufferRead);
        const tTotal = performance.now() - tStart;
        const estTilesX = Math.ceil((x + w) / tileSize) - Math.floor(x / tileSize);
        const estTilesY = Math.ceil((y + h) / tileSize) - Math.floor(y / tileSize);
        const estTilesNeeded = estTilesX * estTilesY;
        onMetric?.("tiled_region_total", tTotal);
        return { pixels: buf.data, width: buf.width, height: buf.height };
    }
    finally {
        module._free(ptr);
    }
}
/**
 * Encode RGBA8 as a JXTC tile container — N independent standalone JXL bitstreams
 * plus a byte-offset index. Decode with decodeTileContainerRegionRgba8 to retrieve
 * any rectangular region with zero frame-walk overhead.
 *
 * Compared to encodeTiledRgba8 (multi-frame JXL):
 *   - Same tile granularity
 *   - Slightly larger output (~5-10% overhead from per-tile JXL headers)
 *   - Vastly faster ROI decode in libjxl ≤0.11.x where SkipFrames doesn't skip work
 *
 * Output is NOT a standard JXL — it's a custom container format. Magic 'JXTC'.
 */
export async function encodeTileContainerRgba8(pixels, width, height, options) {
    return encodeTileContainer(pixels, width, height, options, "rgba8");
}
/**
 * Encode RGBA16 as a JXTC tile container — N independent standalone JXL bitstreams
 * plus a byte-offset index. Decode with decodeTileContainerRegionRgba16 to retrieve
 * any rectangular region with zero frame-walk overhead.
 */
export async function encodeTileContainerRgba16(pixels, width, height, options) {
    return encodeTileContainer(pixels, width, height, options, "rgba16");
}
// Zero/lower-copy planar RGB16 encode support.
// Accepts three separate Uint16Arrays (or WASM heap pointers) for R/G/B planes.
// Useful after planar demosaic + planar downscale or SoA tone to avoid allocating/copying a full interleaved buffer on the JS side.
// The bridge interleaves in C++ then encodes.
export async function encodeRgb16Planar(r, g, b, width, height, distance = 1.0, effort = 7, progressiveDc = 0, progressiveAc = 0, qProgressiveAc = 0, buffering = 0, groupOrder = 0, resampling = 1) {
    const module = await loadLibjxlModule();
    const m = module;
    const rPtr = (typeof r === 'number') ? r : ensureU16Heap(m, r);
    const gPtr = (typeof g === 'number') ? g : ensureU16Heap(m, g);
    const bPtr = (typeof b === 'number') ? b : ensureU16Heap(m, b);
    if (typeof m._jxl_wasm_encode_rgb16_planar !== 'function') {
        if (typeof r !== 'number')
            m._free(rPtr);
        if (typeof g !== 'number')
            m._free(gPtr);
        if (typeof b !== 'number')
            m._free(bPtr);
        throw new CapabilityMissing('encodeRgb16Planar requires jxl-wasm bridge rebuilt with planar support');
    }
    const handle = m._jxl_wasm_encode_rgb16_planar(rPtr, gPtr, bPtr, width, height, distance, effort, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling);
    if (typeof r !== 'number')
        m._free(rPtr);
    if (typeof g !== 'number')
        m._free(gPtr);
    if (typeof b !== 'number')
        m._free(bPtr);
    return takeBuffer(module, handle, "encodeRgb16Planar").data;
}
// Copy a Uint16Array R/G/B plane into the WASM heap and return its pointer.
// Used by encodeRgb16Planar when callers pass arrays rather than pre-allocated heap pointers.
function ensureU16Heap(module, arr) {
    const bytes = arr.byteLength;
    const ptr = mallocOrThrow(module, bytes, "RGB16 plane");
    module.HEAPU8.set(new Uint8Array(arr.buffer, arr.byteOffset, bytes), ptr);
    return ptr;
}
async function encodeTileContainer(pixels, width, height, options, format) {
    const module = await loadLibjxlModule();
    const encodeFn = format === "rgba16"
        ? module._jxl_wasm_encode_tile_container_rgba16
        : module._jxl_wasm_encode_tile_container_rgba8;
    if (!encodeFn) {
        throw new CapabilityMissing("Tile container encode requires a rebuilt WASM with JXTC bridge");
    }
    const tileSize = options.tileSize;
    if (!Number.isInteger(tileSize) || tileSize < 1) {
        throw new Error(`tileSize must be a positive integer, got ${tileSize}`);
    }
    const distance = options.distance ?? 1.0;
    const effort = options.effort ?? 3;
    const hasAlpha = options.hasAlpha !== false;
    const onMetric = options.onMetric;
    // Per-phase encode sub-timers (marshal vs libjxl core-compress). Mirrors the
    // decodeTileContainerRegion split so the benchmark TOON Enc*Ms fields get real
    // numbers without a WASM rebuild — enc_wasm_encode is the full synchronous FFI
    // call into libjxl, i.e. the EncCoreCompressMs the ~90% claim is about.
    const tStart = performance.now();
    const view = copyOrBorrowInput(pixels, false);
    const expectedBytes = width * height * 4 * bytesPerChannelForFormat(format);
    if (view.byteLength < expectedBytes) {
        throw new Error(`Pixel buffer too small: ${view.byteLength} < ${expectedBytes}`);
    }
    onMetric?.("enc_input_prep", performance.now() - tStart);
    const t2 = performance.now();
    const ptr = module._malloc(view.byteLength);
    if (ptr === 0)
        throw new Error("WASM malloc failed for tile container encode");
    onMetric?.("enc_malloc", performance.now() - t2);
    try {
        const t3 = performance.now();
        module.HEAPU8.set(view, ptr);
        onMetric?.("enc_heap_set", performance.now() - t3);
        const t4 = performance.now();
        const handle = encodeFn(ptr, width, height, tileSize, distance, effort, hasAlpha ? 1 : 0);
        onMetric?.("enc_wasm_encode", performance.now() - t4);
        const t5 = performance.now();
        const out = takeBuffer(module, handle, "tile container encode").data;
        onMetric?.("enc_buffer_read", performance.now() - t5);
        return out;
    }
    finally {
        const tFree = performance.now();
        module._free(ptr);
        onMetric?.("enc_free", performance.now() - tFree);
    }
}
/**
 * Decode a rectangular region from a JXTC tile container produced by
 * encodeTileContainerRgba8. Each overlapping tile is decoded as a standalone
 * JXL bitstream — zero frame-walk overhead. Performance is linear in number
 * of overlapping tiles, regardless of total image size.
 */
export async function decodeTileContainerRegionRgba8(containerBytes, options) {
    return decodeTileContainerRegion(containerBytes, options, "rgba8");
}
/**
 * Decode a rectangular region from a JXTC tile container produced by
 * encodeTileContainerRgba16. Each overlapping tile is decoded as a standalone
 * JXL bitstream — zero frame-walk overhead. Performance is linear in number
 * of overlapping tiles, regardless of total image size.
 */
export async function decodeTileContainerRegionRgba16(containerBytes, options) {
    return decodeTileContainerRegion(containerBytes, options, "rgba16");
}
async function decodeTileContainerRegion(containerBytes, options, format) {
    const module = await loadLibjxlModule();
    const decodeFn = format === "rgba16"
        ? module._jxl_wasm_decode_tile_container_region_rgba16
        : module._jxl_wasm_decode_tile_container_region_rgba8;
    if (!decodeFn) {
        throw new CapabilityMissing("Tile container decode requires a rebuilt WASM with JXTC bridge");
    }
    const { x, y, w, h, onMetric } = options;
    const tStart = performance.now();
    const view = copyOrBorrowInput(containerBytes, false);
    const t1 = performance.now();
    onMetric?.("jxtc_input_prep", t1 - tStart);
    const t2 = performance.now();
    const ptr = module._malloc(view.byteLength);
    if (ptr === 0)
        throw new Error("WASM malloc failed for tile container decode");
    const tMalloc = performance.now() - t2;
    onMetric?.("jxtc_malloc", tMalloc);
    try {
        const t3 = performance.now();
        module.HEAPU8.set(view, ptr);
        const tHeapSet = performance.now() - t3;
        onMetric?.("jxtc_heap_set", tHeapSet);
        const t4 = performance.now();
        const handle = decodeFn(ptr, view.byteLength, x, y, w, h);
        const tWasmDecode = performance.now() - t4;
        onMetric?.("jxtc_wasm_decode", tWasmDecode);
        const t5 = performance.now();
        const buf = takeBuffer(module, handle, "tile container region decode");
        const tBufferRead = performance.now() - t5;
        onMetric?.("jxtc_buffer_read", tBufferRead);
        const tTotal = performance.now() - tStart;
        onMetric?.("jxtc_total", tTotal);
        return { pixels: buf.data, width: buf.width, height: buf.height };
    }
    finally {
        module._free(ptr);
    }
}
/** Start loading the WASM module immediately. Call during app startup to hide cold-start latency. */
export function preloadJxlModule() {
    void loadLibjxlModule();
}
export function getWrapperCapabilities() {
    return {
        regionDecode: true,
        exactSizeDecode: true,
        progressiveRegionDecode: false,
        tileAlignedRegionDecode: false,
        arbitraryRegionDecode: true,
        availableDownsampleFactors: [1, 2, 4, 8],
    };
}
export function getDecodeGridInfo() {
    return {};
}
export function decodeViewport(options) {
    return createDecoder({
        format: options.format,
        region: options.region ?? null,
        downsample: pickDownsample(options),
        progressionTarget: options.progressionTarget ?? "final",
        emitEveryPass: options.emitEveryPass ?? false,
        preserveIcc: options.preserveIcc ?? true,
        preserveMetadata: options.preserveMetadata ?? false,
        targetWidth: options.targetWidth ?? null,
        targetHeight: options.targetHeight ?? null,
        fitMode: options.fitMode ?? null,
        ...(options.progressiveDetail !== undefined ? { progressiveDetail: options.progressiveDetail } : {}),
        ...(options.progressivePaintTarget !== undefined ? { progressivePaintTarget: options.progressivePaintTarget } : {}),
        ...(options.maxProgressiveFrames !== undefined ? { maxProgressiveFrames: options.maxProgressiveFrames } : {}),
    });
}
export function decodeRegionLod(options) {
    return createDecoder({
        format: options.format,
        region: options.region ?? null,
        downsample: 1,
        progressionTarget: "final",
        emitEveryPass: false,
        preserveIcc: false,
        preserveMetadata: false,
        targetWidth: options.targetLongEdge,
        targetHeight: options.targetLongEdge,
        fitMode: "contain",
    });
}
export function normalizedToPixelExtent(norm, imageWidth, imageHeight) {
    return {
        x: Math.round(norm.x * imageWidth),
        y: Math.round(norm.y * imageHeight),
        w: Math.max(1, Math.round(norm.w * imageWidth)),
        h: Math.max(1, Math.round(norm.h * imageHeight)),
    };
}
export function pixelToNormalizedExtent(region, imageWidth, imageHeight) {
    return {
        x: region.x / imageWidth,
        y: region.y / imageHeight,
        w: region.w / imageWidth,
        h: region.h / imageHeight,
    };
}
// Shared zero-length sentinel used to null out pixelChunks slots during progressive WASM copy.
const EMPTY_U8 = new Uint8Array(0);
class LibjxlDecoder {
    options;
    // null sentinel = input closed
    chunkQueue = [];
    readIndex = 0;
    queuedBytes = 0;
    wakeResolve = null;
    cancelled = false;
    closed = false;
    eventsStarted = false;
    constructor(options) {
        this.options = options;
    }
    push(chunk) {
        if (this.cancelled || this.closed)
            return;
        // ArrayBuffer callers (primary path: worker receives transferred chunks via postMessage)
        // are always zero-copy — new Uint8Array(ab) is a view, not a copy. Uint8Array callers
        // may reuse the underlying buffer, so we copy unless copyInput=false.
        const view = copyOrBorrowInput(chunk, this.options.copyInput !== false);
        this.queuedBytes += view.byteLength;
        this.chunkQueue.push(view);
        this.wake();
    }
    close() {
        if (this.cancelled || this.closed)
            return;
        this.closed = true;
        this.chunkQueue.push(null);
        this.wake();
    }
    wake() {
        const resolve = this.wakeResolve;
        if (resolve !== null) {
            this.wakeResolve = null;
            resolve();
        }
    }
    waitForQueueItem() {
        if (this.chunkQueue.length > this.readIndex)
            return Promise.resolve();
        return new Promise((resolve) => { this.wakeResolve = resolve; });
    }
    compactQueue() {
        if (this.readIndex >= this.chunkQueue.length) {
            this.chunkQueue.length = 0;
            this.readIndex = 0;
        }
        else if (this.readIndex > 64 && this.readIndex * 2 > this.chunkQueue.length) {
            this.chunkQueue.copyWithin(0, this.readIndex);
            this.chunkQueue.length -= this.readIndex;
            this.readIndex = 0;
        }
    }
    async *events() {
        if (this.eventsStarted) {
            yield { type: "error", code: "InvalidState", message: "Decoder events() may only be consumed once." };
            return;
        }
        this.eventsStarted = true;
        try {
            if (this.cancelled)
                return;
            const module = await loadLibjxlModule();
            const caps = getCapabilities(module);
            if (this.options.format !== "rgba8" && !caps.progressiveDecode) {
                const decFn = this.options.format === "rgba16" ? "_jxl_wasm_decode_rgba16" : "_jxl_wasm_decode_rgbaf32";
                if (typeof module[decFn] !== "function") {
                    throw new CapabilityMissing(`${this.options.format} decode requires a rebuilt WASM with multi-format bridge`);
                }
            }
            if (caps.progressiveDecode) {
                yield* this.eventsProgressive(module);
            }
            else {
                yield* this.eventsOneShot(module);
            }
        }
        catch (error) {
            yield {
                type: "error",
                code: error instanceof CapabilityMissing ? error.code : "DecodeFailed",
                message: error instanceof Error ? error.message : String(error),
            };
        }
        finally {
            this.chunkQueue = [];
            this.readIndex = 0;
            this.queuedBytes = 0;
            this.cancelled = true;
        }
    }
    async *eventsProgressive(module) {
        const fmtIndex = this.options.format === "rgbaf32" ? 2 : this.options.format === "rgba16" ? 1 : 0;
        const progressiveDetail = resolveDecoderProgressiveDetail(this.options);
        const decFlags = (this.options.suppressDuplicateProgress ? DEC_FLAG_SUPPRESS_DUPLICATE_PROGRESS : 0)
            | (this.options.allowAlphaProgressive ? DEC_FLAG_ALLOW_ALPHA_PROGRESSIVE : 0);
        const dec = module._jxl_wasm_dec_create_x
            ? module._jxl_wasm_dec_create_x(fmtIndex, progressiveDetail, decFlags)
            : module._jxl_wasm_dec_create(fmtIndex, progressiveDetail);
        if (dec === 0)
            throw new Error("JXL progressive decoder creation failed");
        // Paint-cadence control: when set, ask libjxl for ~N evenly spaced AC paints
        // instead of one per encoded pass (kPasses detail). Requires the rebuilt
        // bridge; older modules without the symbol silently keep per-pass pausing.
        const paintTarget = this.options.progressivePaintTarget;
        if (paintTarget != null && paintTarget > 0 &&
            typeof module._jxl_wasm_dec_set_paint_target === "function") {
            module._jxl_wasm_dec_set_paint_target(dec, paintTarget);
        }
        // Cache bridge fn refs once — avoids repeated property lookup on module per iteration.
        const decPush = module._jxl_wasm_dec_push;
        const decWidth = module._jxl_wasm_dec_width;
        const decHeight = module._jxl_wasm_dec_height;
        const decError = module._jxl_wasm_dec_error;
        const decTakeFlushed = module._jxl_wasm_dec_take_flushed;
        const decTakeFinal = module._jxl_wasm_dec_take_final;
        const decCloseInput = module._jxl_wasm_dec_close_input;
        const decFree = module._jxl_wasm_dec_free;
        let chunkBufPtr = 0;
        let chunkBufCap = 0;
        // Rank #2: Deferred-release buffer reuse (zero-copy pixel emission).
        let reusablePixelBuf = null;
        let reusablePixelCap = 0; // capacity in bytes
        // Rank #2: Defer pixel buffer allocation until actual image dimensions are known.
        // A fixed 1920×1080×4 pre-allocation would throw for images larger than HD (e.g. 4K = 33 MB).
        // Instead, allocate (or grow) lazily on first use inside preparePixelsForEmit.
        try {
            // Rank #6: Pre-allocate chunk buffer upfront if expectedBytes provided.
            // Inside the try so an OOM here still frees the decoder in the finally
            // (it used to run before the try and leak `dec` on throw).
            if (this.options.expectedBytes != null && this.options.expectedBytes > 0) {
                const tMalloc0 = performance.now();
                chunkBufPtr = module._malloc(this.options.expectedBytes);
                if (chunkBufPtr === 0) {
                    throw new Error("WASM Memory Allocation OOM during pre-allocation for progressive stream");
                }
                chunkBufCap = this.options.expectedBytes;
                this.options.onMetric?.("malloc_prealloc_ms", performance.now() - tMalloc0);
            }
            let headerEmitted = false;
            let info;
            let gotRealFlush = false;
            let done = false;
            // Count flushed intermediate frames: first flush is the DC pass,
            // subsequent flushes are AC refinement passes.
            let flushCount = 0;
            const buildInfo = (w, h, bitsPerSample = normalizeBitsPerSample(bpc * 8), hasAlpha = true) => {
                info ??= { width: w, height: h, bitsPerSample, hasAlpha, hasAnimation: false, jpegReconstructionAvailable: false };
                return info;
            };
            const bpc = fmtIndex === 2 ? 4 : fmtIndex === 1 ? 2 : 1;
            const pixelStride = 4 * bpc;
            const fmt = this.options.format;
            let resolvedDownsample = this.options.downsample ?? 1;
            // Set once the header is known: true when the rebuilt bridge will crop+downsample this
            // decode in C++ (dec_set_region called), so takeAndWrap must NOT re-crop in JS.
            let cppRoi = false;
            let resizePlan = null;
            let progressiveSequence = 0;
            let progFramePrepMs = 0;
            let progFrameCount = 0;
            const progressFrameBudget = resolveProgressFrameBudget(this.options);
            let emittedProgressFrames = 0;
            // P0 probe (docs/Boundaries and Pipelines/traversal-report.md #2): isolate the
            // region-crop + downsample cost (a subset of take_frame_ms) and the resize cost
            // out of the aggregate prog_frame_prep_ms. Sizes the "move progressive crop to C++"
            // migration decision — region_crop_ms is exactly the JS work that move would replace.
            let regionCropMs = 0;
            let progResizeMs = 0;
            // Helper: emit with deferred-release or normal transfer
            // Modifies pixData in-place: when deferredRelease=true, copies into reusablePixelBuf.
            // Returns the pixels to emit (shared ref if deferredRelease, otherwise original array).
            const preparePixelsForEmit = (pixData) => {
                if (this.options.deferredRelease) {
                    // Grow the reusable buffer if needed (first use or image larger than previous frame).
                    if (reusablePixelBuf === null || pixData.byteLength > reusablePixelCap) {
                        reusablePixelBuf = new ArrayBuffer(pixData.byteLength);
                        reusablePixelCap = pixData.byteLength;
                        this.options.onMetric?.("deferred_release_alloc_bytes", pixData.byteLength);
                    }
                    // Copy from source array into reusable buffer.
                    // Caller will copy again if needed; transparent to session layer.
                    const dstView = new Uint8Array(reusablePixelBuf, 0, pixData.byteLength);
                    dstView.set(pixData);
                    return reusablePixelBuf; // shared reference, not transferred
                }
                return pixData; // standard transfer (will be detached by postMessage if used)
            };
            const takeAndWrap = (handle) => {
                if (handle === 0)
                    return null;
                const buf = retainBufferView(module, handle, "decode");
                try {
                    let pixels;
                    if (cppRoi) {
                        // C++ already cropped + nearest-downsampled to output dims (byte-exact with the JS
                        // path). Copy out of the borrowed WASM view — roi_buf is reused across paints.
                        pixels = { data: new Uint8Array(buf.data), width: buf.width, height: buf.height };
                        if (this.options.region != null)
                            pixels.region = { x: 0, y: 0, w: buf.width, h: buf.height };
                    }
                    else {
                        const tCrop0 = performance.now();
                        pixels = applyRegionAndDownsample(buf.data, buf.width, buf.height, this.options.region ?? null, resolvedDownsample, bpc);
                        regionCropMs += performance.now() - tCrop0;
                        if (pixels.data === buf.data) {
                            pixels = { ...pixels, data: new Uint8Array(buf.data) };
                        }
                    }
                    // evInfo: full image dims live in the memoized `info` (set at header). buildInfo
                    // memoizes on first call, so it always returns the full-dim object; when the output
                    // is cropped/downsampled, override width/height with the actual pixel dims.
                    const baseInfo = buildInfo(buf.width, buf.height, buf.bitsPerSample, buf.hasAlpha);
                    const fullW = info ? info.width : buf.width;
                    const fullH = info ? info.height : buf.height;
                    const evInfo = (pixels.width !== fullW || pixels.height !== fullH)
                        ? { ...baseInfo, width: pixels.width, height: pixels.height }
                        : baseInfo;
                    return { pixels, evInfo };
                }
                finally {
                    buf.release();
                }
            };
            const hasRegion = this.options.region != null;
            const onMetric = this.options.onMetric;
            let fallbackMetricEmitted = false;
            let drainPending = false;
            let inputClosed = false;
            // IMPROVEMENT-7: Batch all queued data chunks into one WASM write per tick.
            // IMPROVEMENT-9: Guard dec_width/dec_height calls behind !headerEmitted — skip 2 WASM
            // FFI calls per chunk once the header has been emitted.
            while (!done && !this.cancelled) {
                if (!drainPending && this.chunkQueue.length <= this.readIndex) {
                    await this.waitForQueueItem();
                    if (this.cancelled)
                        return;
                }
                let result = 0;
                if (drainPending) {
                    result = decPush(dec, 0, 0);
                    if (result < 0)
                        throw new Error(`JXL decode error: ${decError(dec)}`);
                }
                else if (this.chunkQueue.length > this.readIndex && this.chunkQueue[this.readIndex] === null) {
                    // Close sentinel — flush remaining decoder state, then keep draining until done.
                    this.readIndex++;
                    this.compactQueue();
                    decCloseInput(dec);
                    inputClosed = true;
                    result = decPush(dec, 0, 0);
                    if (result < 0)
                        throw new Error(`JXL decode error: ${decError(dec)}`);
                }
                else {
                    // Pending byte count maintained incrementally — no scan needed.
                    const batchBytes = this.queuedBytes;
                    if (batchBytes <= 0)
                        continue;
                    if (batchBytes > chunkBufCap) {
                        const tMalloc0 = performance.now();
                        if (chunkBufPtr !== 0)
                            module._free(chunkBufPtr);
                        chunkBufPtr = module._malloc(batchBytes);
                        if (chunkBufPtr === 0) {
                            throw new Error("WASM Memory Allocation OOM during progressive stream push");
                        }
                        chunkBufCap = batchBytes;
                        this.options.onMetric?.("malloc_grow_ms", performance.now() - tMalloc0);
                    }
                    let woff = 0;
                    const tHeapSet0 = performance.now();
                    while (this.chunkQueue.length > this.readIndex && this.chunkQueue[this.readIndex] !== null) {
                        const chunk = this.chunkQueue[this.readIndex];
                        // Null slot immediately so GC can reclaim the Uint8Array after the HEAPU8.set copy.
                        this.chunkQueue[this.readIndex++] = null;
                        this.queuedBytes -= chunk.byteLength;
                        module.HEAPU8.set(chunk, chunkBufPtr + woff);
                        woff += chunk.byteLength;
                    }
                    this.options.onMetric?.("heap_set_ms", performance.now() - tHeapSet0);
                    this.compactQueue();
                    result = decPush(dec, chunkBufPtr, batchBytes);
                    if (result < 0)
                        throw new Error(`JXL decode error: ${decError(dec)}`);
                }
                if (!headerEmitted) {
                    const w = decWidth(dec);
                    const h = decHeight(dec);
                    if (w > 0 && h > 0) {
                        headerEmitted = true;
                        if (this.options.downsample == null) {
                            resolvedDownsample = pickDownsample({
                                region: this.options.region ?? null,
                                targetWidth: this.options.targetWidth ?? null,
                                targetHeight: this.options.targetHeight ?? null,
                                sourceWidth: w,
                                sourceHeight: h,
                            });
                        }
                        const targetW = this.options.targetWidth;
                        const targetH = this.options.targetHeight;
                        const fitMode = this.options.fitMode ?? "contain";
                        if (targetW != null && targetH != null && targetW > 0 && targetH > 0) {
                            const scaledW = Math.max(1, Math.ceil(w / resolvedDownsample));
                            const scaledH = Math.max(1, Math.ceil(h / resolvedDownsample));
                            resizePlan = buildResizePlan(scaledW, scaledH, targetW, targetH, fitMode, bpc);
                        }
                        // C++-side progressive ROI crop: when the rebuilt bridge exposes dec_set_region and
                        // there is real crop/downsample work, do it in C++ (byte-exact with the JS
                        // applyRegionAndDownsample fallback) so the per-paint JS crop loop is skipped and
                        // only the cropped pixels cross to JS. Absent symbol => JS fallback unchanged.
                        const needsCrop = this.options.region != null || resolvedDownsample > 1;
                        if (needsCrop && typeof module._jxl_wasm_dec_set_region === "function") {
                            const r = this.options.region;
                            const rx = r ? Math.max(0, Math.trunc(r.x)) : 0;
                            const ry = r ? Math.max(0, Math.trunc(r.y)) : 0;
                            const rw = r ? Math.max(1, Math.trunc(r.w)) : w;
                            const rh = r ? Math.max(1, Math.trunc(r.h)) : h;
                            module._jxl_wasm_dec_set_region(dec, rx, ry, rw, rh, resolvedDownsample);
                            cppRoi = true;
                        }
                        yield { type: "header", info: buildInfo(w, h) };
                        if (this.options.progressionTarget === "header")
                            return;
                    }
                }
                if (result === 1) {
                    drainPending = true;
                    gotRealFlush = true;
                    flushCount++;
                    const stage = flushCount === 1 ? "dc" : "pass";
                    // Skip intermediate frame processing when consumer only wants the final frame.
                    // Must still consume the WASM buffer handle to unblock the decoder.
                    if (!this.options.emitEveryPass && this.options.progressionTarget === "final") {
                        const h = decTakeFlushed(dec);
                        if (h !== 0)
                            module._jxl_wasm_buffer_free(h);
                        continue;
                    }
                    if (this.options.progressionTarget === "final" && emittedProgressFrames >= progressFrameBudget) {
                        const h = decTakeFlushed(dec);
                        if (h !== 0)
                            module._jxl_wasm_buffer_free(h);
                        continue;
                    }
                    const tFramePrep0 = performance.now();
                    const tTake0 = performance.now();
                    const wrapped = takeAndWrap(decTakeFlushed(dec));
                    this.options.onMetric?.("take_frame_ms", performance.now() - tTake0);
                    if (wrapped !== null) {
                        const { pixels: rawPixels, evInfo } = wrapped;
                        // P4: emit region_fallback_full_frame metric once when progressive + region active.
                        if (hasRegion && !fallbackMetricEmitted && onMetric) {
                            onMetric("region_fallback_full_frame", 1);
                            fallbackMetricEmitted = true;
                        }
                        // P1: apply bilinear resize if target dims set.
                        const targetW = this.options.targetWidth;
                        const targetH = this.options.targetHeight;
                        const fitMode = this.options.fitMode ?? "contain";
                        let outPixels = rawPixels;
                        if (targetW != null && targetH != null && targetW > 0 && targetH > 0) {
                            const tResize0 = performance.now();
                            const resized = applyTargetResize(rawPixels.data, rawPixels.width, rawPixels.height, targetW, targetH, fitMode, bpc, resizePlan);
                            progResizeMs += performance.now() - tResize0;
                            outPixels = { data: resized.data, width: resized.width, height: resized.height, ...(rawPixels.region !== undefined ? { region: rawPixels.region } : {}) };
                        }
                        progFramePrepMs += performance.now() - tFramePrep0;
                        progFrameCount++;
                        const outInfo = (outPixels.width !== evInfo.width || outPixels.height !== evInfo.height)
                            ? { ...evInfo, width: outPixels.width, height: outPixels.height }
                            : evInfo;
                        const ev = {
                            type: "progress",
                            stage,
                            info: outInfo,
                            pixels: preparePixelsForEmit(outPixels.data),
                            format: fmt,
                            pixelStride,
                            sourceScale: resolvedDownsample,
                            progressiveRegion: false,
                            progressiveSequence: ++progressiveSequence,
                            passOrdinal: flushCount - 1,
                        };
                        if (hasRegion)
                            ev.regionFallback = "full-frame-then-crop";
                        if (outPixels.region !== undefined)
                            ev.region = outPixels.region;
                        emittedProgressFrames++;
                        yield ev;
                        if (this.options.progressionTarget !== "final" && !this.options.emitEveryPass)
                            return;
                    }
                    continue;
                }
                drainPending = false;
                if (result === 2) {
                    done = true;
                }
                else if (inputClosed) {
                    throw new Error(`JXL decode error: ${decError(dec)}`);
                }
            }
            if (done) {
                const tFinalPrep0 = performance.now();
                const wrapped = takeAndWrap(decTakeFinal(dec));
                if (wrapped !== null) {
                    const { pixels: rawPixels, evInfo } = wrapped;
                    // P5: emit decode metrics on final frame.
                    if (onMetric) {
                        onMetric("decode_scale_used", resolvedDownsample);
                        // info is memoized full-frame dims from buildInfo; fall back to rawPixels if header not yet seen.
                        const fullW = info?.width ?? rawPixels.width;
                        const fullH = info?.height ?? rawPixels.height;
                        onMetric("source_pixels_decoded", fullW * fullH);
                        if (hasRegion && this.options.region != null) {
                            onMetric("decode_region_area", this.options.region.w * this.options.region.h);
                        }
                    }
                    // P1: apply bilinear resize if target dims set.
                    const targetW = this.options.targetWidth;
                    const targetH = this.options.targetHeight;
                    const fitMode = this.options.fitMode ?? "contain";
                    let outPixels = rawPixels;
                    if (targetW != null && targetH != null && targetW > 0 && targetH > 0) {
                        const tResize0 = performance.now();
                        const resized = applyTargetResize(rawPixels.data, rawPixels.width, rawPixels.height, targetW, targetH, fitMode, bpc, resizePlan);
                        progResizeMs += performance.now() - tResize0;
                        outPixels = { data: resized.data, width: resized.width, height: resized.height, ...(rawPixels.region !== undefined ? { region: rawPixels.region } : {}) };
                    }
                    progFramePrepMs += performance.now() - tFinalPrep0;
                    progFrameCount++;
                    if (onMetric) {
                        onMetric("prog_frame_prep_ms", progFramePrepMs);
                        onMetric("prog_frame_count", progFrameCount);
                        // P0 breakdown: region_crop_ms ⊆ take_frame_ms; resize is the remainder of prep.
                        onMetric("region_crop_ms", regionCropMs);
                        onMetric("prog_frame_resize_ms", progResizeMs);
                    }
                    const outInfo = (outPixels.width !== evInfo.width || outPixels.height !== evInfo.height)
                        ? { ...evInfo, width: outPixels.width, height: outPixels.height }
                        : evInfo;
                    if (!gotRealFlush && (this.options.emitEveryPass || this.options.progressionTarget === "dc" || this.options.progressionTarget === "pass")) {
                        const stage = this.options.progressionTarget === "dc" ? "dc" : "pass";
                        const ev = {
                            type: "progress",
                            stage,
                            info: outInfo,
                            pixels: preparePixelsForEmit(outPixels.data),
                            format: fmt,
                            pixelStride,
                            sourceScale: resolvedDownsample,
                            progressiveRegion: false,
                            progressiveSequence: ++progressiveSequence,
                            passOrdinal: flushCount,
                        };
                        if (hasRegion)
                            ev.regionFallback = "full-frame-then-crop";
                        if (outPixels.region !== undefined)
                            ev.region = outPixels.region;
                        yield ev;
                        if (this.options.progressionTarget !== "final")
                            return;
                    }
                    const ev = {
                        type: "final",
                        info: outInfo,
                        pixels: preparePixelsForEmit(outPixels.data),
                        format: fmt,
                        pixelStride,
                        sourceScale: resolvedDownsample,
                        progressiveRegion: false,
                        progressiveSequence: ++progressiveSequence,
                        passOrdinal: flushCount,
                    };
                    if (hasRegion)
                        ev.regionFallback = "full-frame-then-crop";
                    if (outPixels.region !== undefined)
                        ev.region = outPixels.region;
                    yield ev;
                }
            }
        }
        finally {
            if (chunkBufPtr !== 0)
                module._free(chunkBufPtr);
            decFree(dec);
        }
    }
    async *eventsOneShot(module) {
        // Drain all chunks until input closed
        const allChunks = [];
        while (!this.cancelled) {
            await this.waitForQueueItem();
            if (this.cancelled)
                return;
            const item = this.chunkQueue[this.readIndex++];
            this.compactQueue();
            if (item === null || item === undefined)
                break;
            this.queuedBytes -= item.byteLength;
            allChunks.push(item);
        }
        if (this.cancelled)
            return;
        const fmt = this.options.format;
        const bpc = fmt === "rgbaf32" ? 4 : fmt === "rgba16" ? 2 : 1;
        const pixelStride = 4 * bpc;
        // Rank #2: Reusable pixel buffer for deferredRelease mode (symmetric with eventsProgressive).
        // Allocated lazily on first use so the exact image size drives the allocation; a fixed
        // 1920×1080×4 pre-allocation would throw for any image larger than HD (e.g. 4K = 33 MB).
        let reusablePixelBuf = null;
        let reusablePixelCap = 0; // capacity in bytes
        // Helper: emit with deferred-release or normal transfer
        const preparePixelsForEmit = (pixData) => {
            if (this.options.deferredRelease) {
                // Grow the reusable buffer if needed (first use or image larger than previous frame).
                if (reusablePixelBuf === null || pixData.byteLength > reusablePixelCap) {
                    reusablePixelBuf = new ArrayBuffer(pixData.byteLength);
                    reusablePixelCap = pixData.byteLength;
                    this.options.onMetric?.("deferred_release_alloc_bytes_oneshot", pixData.byteLength);
                }
                // Copy from source array into reusable buffer.
                const dstView = new Uint8Array(reusablePixelBuf, 0, pixData.byteLength);
                dstView.set(pixData);
                return reusablePixelBuf; // shared reference, not transferred
            }
            return pixData; // standard transfer (will be detached by postMessage if used)
        };
        // Write all chunks directly into a single WASM heap buffer — no intermediate JS allocation.
        const totalSize = allChunks.reduce((s, c) => s + c.byteLength, 0);
        const inputPtr = module._malloc(totalSize);
        if (inputPtr === 0 && totalSize > 0) {
            throw new Error("WASM malloc failed for one-shot decode input");
        }
        let decodedHandle = 0;
        try {
            let woff = 0;
            for (const chunk of allChunks) {
                module.HEAPU8.set(chunk, inputPtr + woff);
                woff += chunk.byteLength;
            }
            allChunks.length = 0;
            // #10: pass region to callDecodeFromPtr — if C++ region bridge present it crops in WASM,
            // avoiding shipping full-image pixels to JS. JS fallback still works via applyRegionAndDownsample.
            const regionForDecode = this.options.region;
            const cppDidCrop = regionForDecode !== null && ((fmt === "rgba8" && !!module._jxl_wasm_decode_rgba8_region) ||
                (fmt === "rgba16" && !!module._jxl_wasm_decode_rgba16_region) ||
                (fmt === "rgbaf32" && !!module._jxl_wasm_decode_rgbaf32_region));
            const tWasmDec0 = performance.now();
            const decoded = callDecodeFromPtr(module, inputPtr, totalSize, this.options.downsample ?? 1, fmt, cppDidCrop ? regionForDecode : null);
            decodedHandle = decoded.handle;
            this.options.onMetric?.("shot_wasm_ms", performance.now() - tWasmDec0);
            // If C++ did the crop, decoded.width/height already reflect the region; no further JS crop.
            // Otherwise, scale region into downsampled coords and apply in JS.
            const ds = this.options.downsample ?? 1;
            const tTransform0 = performance.now();
            const scaledRegion = (!cppDidCrop && regionForDecode != null) ? {
                x: Math.trunc(regionForDecode.x / ds),
                y: Math.trunc(regionForDecode.y / ds),
                w: Math.ceil(regionForDecode.w / ds),
                h: Math.ceil(regionForDecode.h / ds),
            } : null;
            const pixels = applyRegionAndDownsample(decoded.data, decoded.width, decoded.height, scaledRegion, 1, bpc);
            // C++ crop path skips applyRegionAndDownsample's region-setter; restore it to match JS path.
            if (cppDidCrop)
                pixels.region = { x: 0, y: 0, w: pixels.width, h: pixels.height };
            // P1: apply bilinear resize to exact target size if requested.
            const targetW = this.options.targetWidth;
            const targetH = this.options.targetHeight;
            const fitMode = this.options.fitMode ?? "contain";
            let outPixels = pixels;
            if (targetW != null && targetH != null && targetW > 0 && targetH > 0) {
                const resized = applyTargetResize(pixels.data, pixels.width, pixels.height, targetW, targetH, fitMode, bpc);
                outPixels = { data: resized.data, width: resized.width, height: resized.height, ...(pixels.region !== undefined ? { region: pixels.region } : {}) };
            }
            const info = {
                width: outPixels.width,
                height: outPixels.height,
                bitsPerSample: decoded.bitsPerSample,
                hasAlpha: decoded.hasAlpha,
                hasAnimation: false,
                jpegReconstructionAvailable: false,
            };
            // P5: emit decode metrics via onMetric callback.
            const actualScale = this.options.downsample ?? 1;
            const onMetric = this.options.onMetric;
            if (onMetric) {
                onMetric("shot_transform_ms", performance.now() - tTransform0);
                onMetric("decode_scale_used", actualScale);
                onMetric("source_pixels_decoded", decoded.width * decoded.height);
                if (this.options.region != null) {
                    onMetric("decode_region_area", this.options.region.w * this.options.region.h);
                }
            }
            yield { type: "header", info };
            if (this.options.progressionTarget === "header")
                return;
            if (this.options.emitEveryPass || this.options.progressionTarget === "dc" || this.options.progressionTarget === "pass") {
                const ev = {
                    type: "progress",
                    stage: this.options.progressionTarget === "dc" ? "dc" : "pass",
                    info,
                    pixels: preparePixelsForEmit(outPixels.data),
                    format: fmt,
                    pixelStride,
                    sourceScale: actualScale,
                    progressiveRegion: false,
                };
                if (outPixels.region !== undefined)
                    ev.region = outPixels.region;
                yield ev;
                if (this.options.progressionTarget !== "final")
                    return;
            }
            const ev = {
                type: "final",
                info,
                pixels: preparePixelsForEmit(outPixels.data),
                format: fmt,
                pixelStride,
                sourceScale: actualScale,
                progressiveRegion: false,
            };
            if (outPixels.region !== undefined)
                ev.region = outPixels.region;
            yield ev;
        }
        finally {
            module._free(inputPtr);
            if (decodedHandle !== 0)
                module._jxl_wasm_buffer_free(decodedHandle);
        }
    }
    cancel(_reason) {
        this.cancelled = true;
        this.wake();
    }
    dispose() {
        this.chunkQueue = [];
        this.readIndex = 0;
        this.queuedBytes = 0;
        this.cancelled = true;
        this.wake();
    }
}
class LibjxlEncoder {
    options;
    // Buffered path fallback (used when streaming input not available or sidecars active)
    pixelChunks = [];
    finished = false;
    cancelled = false;
    finishResolve = null;
    sortedSidecarSizes;
    encodeStats = null;
    chunksStarted = false;
    queuedPixelBytes = 0;
    pixelByteTotal;
    // #16: Streaming input — module loaded on first pushPixels, state allocated immediately.
    // JS never accumulates pixelChunks[] when this path is active.
    wasmModule = null;
    wasmEncState = 0;
    streamingInputActive = false;
    moduleInitPromise = null;
    pendingPushPromise = Promise.resolve();
    pendingPushError = null;
    advIdsPtr = 0;
    advValuesPtr = 0;
    // Profiling accumulators (for console summary + optional onMetric if wired)
    tCreateStart = 0;
    tPushTotal = 0;
    tFinishStart = 0;
    tTakeTotal = 0;
    tMallocCopy = 0;
    constructor(options) {
        this.options = options;
        this.sortedSidecarSizes = options.sidecarSizes ? [...options.sidecarSizes].sort((a, b) => a - b) : [];
        this.pixelByteTotal = expectedPixelBytes(options.width, options.height, options.format);
    }
    async pushPixels(chunk, region) {
        if (this.cancelled || this.finished)
            return;
        if (region !== undefined) {
            throw new CapabilityMissing("libjxl WASM facade does not support chunked region encode yet");
        }
        const view = copyOrBorrowInput(chunk, this.options.copyInput !== false);
        if (this.queuedPixelBytes + view.byteLength > this.pixelByteTotal) {
            throw new Error(`JXL encode received too many pixel bytes: expected ${this.pixelByteTotal}, got at least ${this.queuedPixelBytes + view.byteLength}`);
        }
        this.queuedPixelBytes += view.byteLength;
        const pushTask = this.pendingPushPromise.then(async () => {
            const tPush0 = performance.now();
            const module = await this.ensureModule();
            if (this.cancelled)
                return;
            if (this.streamingInputActive) {
                if (module._jxl_wasm_enc_pixels_ptr && module._jxl_wasm_enc_advance_written) {
                    const t0 = performance.now();
                    const ptr = module._jxl_wasm_enc_pixels_ptr(this.wasmEncState, view.byteLength);
                    if (ptr === 0)
                        throw new Error("JXL streaming pixel push failed (0)");
                    const tEncHeapSet0 = performance.now();
                    module.HEAPU8.set(view, ptr);
                    this.options.onMetric?.("enc_heap_set_ms", performance.now() - tEncHeapSet0);
                    const rc = module._jxl_wasm_enc_advance_written(this.wasmEncState, view.byteLength);
                    if (rc !== 0)
                        throw new Error(`JXL streaming pixel push failed (${rc})`);
                    this.tMallocCopy += performance.now() - t0;
                }
                else {
                    // Back-compat with older WASM bridge: temp copy into WASM, then bridge memcpy.
                    const t0 = performance.now();
                    const ptr = module._malloc(view.byteLength);
                    if (ptr === 0)
                        throw new Error("WASM malloc failed for streaming pixel push");
                    try {
                        module.HEAPU8.set(view, ptr);
                        const rc = module._jxl_wasm_enc_push_chunk(this.wasmEncState, ptr, view.byteLength);
                        if (rc !== 0)
                            throw new Error(`JXL streaming pixel push failed (${rc})`);
                        this.tMallocCopy += performance.now() - t0;
                    }
                    finally {
                        module._free(ptr);
                    }
                }
            }
            else {
                this.pixelChunks.push(view);
            }
            this.tPushTotal += performance.now() - tPush0;
        });
        this.pendingPushPromise = pushTask.catch((error) => {
            this.pendingPushError = error;
        });
        await pushTask;
    }
    ensureModule() {
        this.moduleInitPromise ??= this.initModule();
        return this.moduleInitPromise;
    }
    async initModule() {
        const t0 = performance.now();
        const module = await loadLibjxlModule();
        this.wasmModule = module;
        if (this.cancelled)
            return module;
        this.tCreateStart = performance.now() - t0; // includes first load if cold
        const caps = getCapabilities(module);
        // Use streaming input only when sidecars are not requested — sidecar path takes
        // a complete RGBA8 pixel pointer and cannot be fed incrementally.
        // Also skip streaming input when metadata (ICC/EXIF/XMP) is present: the
        // streaming input path calls enc_finish → EncodeRgba which has no metadata
        // parameter. Fall back to the buffered path which routes through
        // encode_rgba8_with_metadata so metadata is preserved for all pixel formats.
        const wantSidecars = this.sortedSidecarSizes.length > 0 && caps.sidecars;
        const hasMetadataOpts = this.options.iccProfile !== null || this.options.exif !== null || this.options.xmp !== null;
        if (!wantSidecars && !hasMetadataOpts && caps.streamingInput) {
            const distance = this.options.distance ?? distanceFromQuality(this.options.quality);
            const fmtIndex = this.options.format === "rgbaf32" ? 2 : this.options.format === "rgba16" ? 1 : this.options.format === "rgb8" ? 3 : 0;
            const { progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder } = resolveEncoderBridgeSettings(this.options);
            const o = this.options;
            const resampling = o.resampling ?? 1;
            // Photon-noise progressive path: the JXL Noise frame feature is a VarDCT-only
            // tool (it has no representation in the Modular sub-codec). When photonNoiseIso>0
            // the encoder can only emit VarDCT, so pin modular=0 explicitly instead of leaving
            // it at -1 (auto). This removes the rejected-Modular auto-trial the encoder would
            // otherwise evaluate per decision point, and guarantees bridge.cpp:644
            // JXL_ENC_FRAME_SETTING_PHOTON_NOISE is actually honored (Modular ignores it).
            const photonActive = (o.photonNoiseIso ?? 0) > 0;
            const modularDefault = photonActive ? 0 : -1;
            const needsZ = caps.streamingInputZ && (o.orientation != null || o.intrinsicWidth != null || o.intrinsicHeight != null || o.disablePerceptualHeuristics != null || o.codestreamLevel != null || o.centerX != null || o.centerY != null);
            const needsY = !needsZ && caps.streamingInputY && (o.epf != null || o.gaborish != null || o.dots != null || o.colorTransform != null);
            const needsX = !needsZ && !needsY && caps.streamingInputX && (o.modular != null || o.brotliEffort != null || o.decodingSpeed != null || o.photonNoiseIso != null);
            const needsAdv = !needsZ && !needsY && !needsX && !!module._jxl_wasm_enc_create_image_adv && !!o.advancedFrameSettings?.length;
            if (needsZ) {
                this.wasmEncState = module._jxl_wasm_enc_create_image_z(o.width, o.height, distance, o.effort, fmtIndex, o.hasAlpha ? 1 : 0, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, o.modular ?? modularDefault, o.brotliEffort ?? -1, o.decodingSpeed ?? -1, o.photonNoiseIso ?? 0, resampling, o.epf ?? -1, o.gaborish ?? -1, o.dots ?? -1, 0, o.colorTransform ?? -1, o.orientation ?? 1, o.centerX ?? 0, o.centerY ?? 0, 0, 0, 0, 0, 0, -1);
                if (this.wasmEncState !== 0) {
                    if ((o.intrinsicWidth ?? 0) > 0 && (o.intrinsicHeight ?? 0) > 0) {
                        module._jxl_wasm_enc_set_intrinsic_size?.(this.wasmEncState, o.intrinsicWidth, o.intrinsicHeight);
                    }
                    if (o.disablePerceptualHeuristics != null) {
                        module._jxl_wasm_enc_set_frame_flags?.(this.wasmEncState, o.disablePerceptualHeuristics);
                    }
                    if (o.codestreamLevel != null && o.codestreamLevel !== -1) {
                        module._jxl_wasm_enc_set_codestream_level?.(this.wasmEncState, o.codestreamLevel);
                    }
                }
            }
            else if (needsY) {
                this.wasmEncState = module._jxl_wasm_enc_create_image_y(o.width, o.height, distance, o.effort, fmtIndex, o.hasAlpha ? 1 : 0, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, o.modular ?? modularDefault, o.brotliEffort ?? -1, o.decodingSpeed ?? -1, o.photonNoiseIso ?? 0, resampling, o.epf ?? -1, o.gaborish ?? -1, o.dots ?? -1, 0, o.colorTransform ?? -1, 0, 0, 0, 0, 0, 0, 0, -1);
            }
            else if (needsX) {
                this.wasmEncState = module._jxl_wasm_enc_create_image_x(o.width, o.height, distance, o.effort, fmtIndex, o.hasAlpha ? 1 : 0, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, o.modular ?? modularDefault, o.brotliEffort ?? -1, o.decodingSpeed ?? -1, o.photonNoiseIso ?? 0, resampling, 0, 0, 0, 0, 0, -1);
            }
            else if (needsAdv) {
                const adv = this.prepareAdvancedSettings(module);
                this.advIdsPtr = adv.idsPtr;
                this.advValuesPtr = adv.valuesPtr;
                try {
                    if (adv.count > 0) {
                        this.wasmEncState = module._jxl_wasm_enc_create_image_adv(o.width, o.height, distance, o.effort, fmtIndex, o.hasAlpha ? 1 : 0, progressiveDc, progressiveAc, qProgressiveAc, buffering, adv.idsPtr, adv.valuesPtr, adv.count);
                    }
                    else {
                        this.wasmEncState = module._jxl_wasm_enc_create_image(o.width, o.height, distance, o.effort, fmtIndex, o.hasAlpha ? 1 : 0, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling);
                    }
                }
                finally {
                    adv.free();
                    this.advIdsPtr = 0;
                    this.advValuesPtr = 0;
                }
            }
            else {
                this.wasmEncState = module._jxl_wasm_enc_create_image(o.width, o.height, distance, o.effort, fmtIndex, o.hasAlpha ? 1 : 0, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling);
            }
            if (this.wasmEncState === 0)
                throw new Error("JXL streaming encoder: pixel buffer allocation failed");
            this.streamingInputActive = true;
        }
        return module;
    }
    finish() {
        this.finished = true;
        this.finishResolve?.();
        this.finishResolve = null;
    }
    async *chunks() {
        if (this.chunksStarted) {
            throw new Error("Encoder chunks() may only be consumed once.");
        }
        this.chunksStarted = true;
        await this.waitUntilFinished();
        if (this.cancelled)
            return;
        await this.pendingPushPromise;
        if (this.pendingPushError !== null)
            throw this.pendingPushError;
        // Module may not be loaded yet if no pixels were pushed (zero-byte edge case).
        const module = this.wasmModule ?? await loadLibjxlModule();
        if (this.queuedPixelBytes !== this.pixelByteTotal) {
            throw new Error(`JXL encode expected ${this.pixelByteTotal} bytes for ${this.options.format}, got ${this.queuedPixelBytes}`);
        }
        let compressedBytes = 0;
        if (this.streamingInputActive && this.wasmEncState !== 0) {
            // #16: Streaming input path — pixels already in WASM pixel buffer.
            // enc_finish runs the encode; enc_take_chunk drains the output.
            try {
                const tFin0 = performance.now();
                const rc = module._jxl_wasm_enc_finish(this.wasmEncState);
                if (rc !== 0)
                    throw new Error(`JXL streaming encode finish failed (${rc})`);
                this.tFinishStart = performance.now() - tFin0;
                let chunkHandle;
                while ((chunkHandle = module._jxl_wasm_enc_take_chunk(this.wasmEncState)) !== 0) {
                    const tTake0 = performance.now();
                    const chunk = takeBuffer(module, chunkHandle, "encode");
                    this.tTakeTotal += performance.now() - tTake0;
                    compressedBytes += chunk.data.byteLength;
                    yield chunk.data;
                }
                // C++ uses MakeBufferBorrowed (zero-copy into outbuf), but the chunks() consumer accumulates
                // chunks and the `finally` below runs enc_free (frees outbuf) once the generator completes —
                // so a borrowed subarray would dangle. takeBuffer copies each chunk (HEAPU8.slice) so the
                // yielded bytes outlive enc_free. (Multi-chunk outputs >256 KB corrupted with the old borrow.)
            }
            finally {
                this.freeWasmState(); // handles advanced pointers + enc_free
            }
        }
        else {
            // Buffered path — accumulate pixelChunks in JS, copy to WASM, then encode.
            // Write pixel chunks directly into WASM heap — no concatBytes allocation.
            // Release each JS chunk reference immediately after copying to reduce peak JS heap overlap.
            if (this.options.format === "rgba16" || this.options.format === "rgbaf32") {
                const encFn = this.options.format === "rgba16" ? "_jxl_wasm_encode_rgba16" : "_jxl_wasm_encode_rgbaf32";
                if (typeof module[encFn] !== "function") {
                    throw new CapabilityMissing(`${this.options.format} encode requires a rebuilt WASM with multi-format bridge`);
                }
            }
            const ptr = module._malloc(this.pixelByteTotal);
            if (ptr === 0)
                throw new Error("WASM malloc failed for buffered encode pixels");
            try {
                let offset = 0;
                for (let i = 0; i < this.pixelChunks.length; i++) {
                    const ch = this.pixelChunks[i];
                    module.HEAPU8.set(ch, ptr + offset);
                    offset += ch.byteLength;
                    this.pixelChunks[i] = EMPTY_U8;
                }
                this.pixelChunks = [];
                this.queuedPixelBytes = 0;
                const distance = this.options.distance ?? distanceFromQuality(this.options.quality);
                const hasAlpha = this.options.hasAlpha ? 1 : 0;
                const caps = getCapabilities(module);
                const { progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder } = resolveEncoderBridgeSettings(this.options);
                const resampling = this.options.resampling ?? 1;
                // ICC/EXIF/XMP can only ride the buffered encode_rgba8_with_metadata
                // path — enc_push_pixels (streaming encode) has no metadata parameters
                // and would silently drop the boxes.
                const hasMetadata = this.options.iccProfile !== null || this.options.exif !== null || this.options.xmp !== null;
                // Sidecar thumbnails — yield smallest first for faster first-paint.
                if (this.sortedSidecarSizes.length > 0 && caps.sidecars) {
                    const sortedSizes = this.sortedSidecarSizes;
                    const dimsPtr = module._malloc(sortedSizes.length * 4);
                    if (dimsPtr === 0)
                        throw new Error("WASM malloc failed for sidecar dims");
                    try {
                        // Write uint32[] into WASM heap (HEAPU32 if available, byte-by-byte otherwise)
                        if (module.HEAPU32) {
                            const base32 = dimsPtr >>> 2;
                            for (let i = 0; i < sortedSizes.length; i++)
                                module.HEAPU32[base32 + i] = (sortedSizes[i] ?? 0) >>> 0;
                        }
                        else {
                            for (let i = 0; i < sortedSizes.length; i++) {
                                const v = (sortedSizes[i] ?? 0) >>> 0;
                                module.HEAPU8[dimsPtr + i * 4] = v & 0xff;
                                module.HEAPU8[dimsPtr + i * 4 + 1] = (v >>> 8) & 0xff;
                                module.HEAPU8[dimsPtr + i * 4 + 2] = (v >>> 16) & 0xff;
                                module.HEAPU8[dimsPtr + i * 4 + 3] = (v >>> 24) & 0xff;
                            }
                        }
                        let handle = module._jxl_wasm_encode_rgba8_with_sidecars(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, dimsPtr, sortedSizes.length);
                        while (handle !== 0) {
                            // Capture next pointer before takeBuffer frees handle.
                            const next = module._jxl_wasm_buffer_next(handle);
                            try {
                                const buf = takeBuffer(module, handle, "encode");
                                compressedBytes += buf.data.byteLength;
                                yield buf.data;
                            }
                            catch (err) {
                                // takeBuffer already freed handle; free remaining chain, then rethrow.
                                let cur = next;
                                while (cur !== 0) {
                                    const nxt = module._jxl_wasm_buffer_next(cur);
                                    module._jxl_wasm_buffer_free(cur);
                                    cur = nxt;
                                }
                                throw err;
                            }
                            handle = next;
                        }
                    }
                    finally {
                        module._free(dimsPtr);
                    }
                }
                else if (caps.streamingEncode && !hasMetadata) {
                    // #11: streaming encoder — yields 256 KB chunks, reducing peak JS heap usage.
                    const fmtIndex = this.options.format === "rgbaf32" ? 2 : this.options.format === "rgba16" ? 1 : this.options.format === "rgb8" ? 3 : 0;
                    const encState = module._jxl_wasm_enc_create();
                    try {
                        const rc = module._jxl_wasm_enc_push_pixels(encState, ptr, this.options.width, this.options.height, distance, this.options.effort, fmtIndex, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering);
                        if (rc !== 0)
                            throw new Error(`JXL streaming encode failed (${rc})`);
                        let chunkHandle;
                        while ((chunkHandle = module._jxl_wasm_enc_take_chunk(encState)) !== 0) {
                            const chunk = takeBuffer(module, chunkHandle, "encode");
                            compressedBytes += chunk.data.byteLength;
                            yield chunk.data;
                        }
                    }
                    finally {
                        module._jxl_wasm_enc_free(encState);
                    }
                }
                else {
                    // Standard single-image encode path
                    let handle;
                    // Use metadata path if any metadata is present.
                    // fmt: 0=rgba8, 1=rgba16, 2=rgbaf32, 3=rgb8 — matches bridge parameter order.
                    const fmt = this.options.format === "rgba16" ? 1 : this.options.format === "rgbaf32" ? 2 : this.options.format === "rgb8" ? 3 : 0;
                    if (hasMetadata && module._jxl_wasm_encode_rgba8_with_metadata) {
                        const iccView = this.options.iccProfile ? copyOrBorrowInput(this.options.iccProfile, false) : new Uint8Array(0);
                        const exifView = this.options.exif ? copyOrBorrowInput(this.options.exif, false) : new Uint8Array(0);
                        const xmpView = this.options.xmp ? copyOrBorrowInput(this.options.xmp, false) : new Uint8Array(0);
                        let iccPtr = iccView.byteLength > 0 ? module._malloc(iccView.byteLength) : 0;
                        let exifPtr = exifView.byteLength > 0 ? module._malloc(exifView.byteLength) : 0;
                        let xmpPtr = xmpView.byteLength > 0 ? module._malloc(xmpView.byteLength) : 0;
                        let iccSize = iccView.byteLength;
                        let exifSize = exifView.byteLength;
                        let xmpSize = xmpView.byteLength;
                        // Optional metadata is best-effort: if a buffer can't be allocated,
                        // drop just that metadatum (zero its size; the ptr stays 0 so the
                        // HEAPU8.set below is skipped and the encoder receives size 0) and
                        // still encode the image. Core pixels are mandatory and are guarded
                        // separately at the buffered-pixels malloc above.
                        if (iccSize > 0 && iccPtr === 0) {
                            console.warn("jxl-wasm: dropping ICC profile from encode — WASM malloc failed");
                            iccSize = 0;
                        }
                        if (exifSize > 0 && exifPtr === 0) {
                            console.warn("jxl-wasm: dropping EXIF from encode — WASM malloc failed");
                            exifSize = 0;
                        }
                        if (xmpSize > 0 && xmpPtr === 0) {
                            console.warn("jxl-wasm: dropping XMP from encode — WASM malloc failed");
                            xmpSize = 0;
                        }
                        const adv = this.prepareAdvancedSettings(module);
                        const useAdv = adv.count > 0 && module._jxl_wasm_encode_rgba8_with_metadata_adv;
                        try {
                            if (iccPtr !== 0)
                                module.HEAPU8.set(iccView, iccPtr);
                            if (exifPtr !== 0)
                                module.HEAPU8.set(exifView, exifPtr);
                            if (xmpPtr !== 0)
                                module.HEAPU8.set(xmpView, xmpPtr);
                            if (useAdv) {
                                handle = module._jxl_wasm_encode_rgba8_with_metadata_adv(ptr, this.options.width, this.options.height, distance, this.options.effort, fmt, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling, iccPtr, iccSize, exifPtr, exifSize, xmpPtr, xmpSize, adv.idsPtr, adv.valuesPtr, adv.count);
                            }
                            else {
                                handle = module._jxl_wasm_encode_rgba8_with_metadata(ptr, this.options.width, this.options.height, distance, this.options.effort, fmt, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling, iccPtr, iccSize, exifPtr, exifSize, xmpPtr, xmpSize);
                            }
                        }
                        finally {
                            if (iccPtr !== 0)
                                module._free(iccPtr);
                            if (exifPtr !== 0)
                                module._free(exifPtr);
                            if (xmpPtr !== 0)
                                module._free(xmpPtr);
                            adv.free();
                        }
                    }
                    else {
                        // Fallback: plain encode (no metadata) used when bridge fn absent
                        // or when no metadata was provided.
                        if (this.options.format === "rgba16" && module._jxl_wasm_encode_rgba16) {
                            handle = module._jxl_wasm_encode_rgba16(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling);
                        }
                        else if (this.options.format === "rgbaf32" && module._jxl_wasm_encode_rgbaf32) {
                            handle = module._jxl_wasm_encode_rgbaf32(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling);
                        }
                        else {
                            handle = module._jxl_wasm_encode_rgba8(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling);
                        }
                    }
                    const encoded = takeBuffer(module, handle, "encode");
                    compressedBytes += encoded.data.byteLength;
                    yield encoded.data;
                }
            }
            finally {
                module._free(ptr);
                this.pixelChunks = [];
                this.queuedPixelBytes = 0;
            }
        }
        this.encodeStats = { originalBytes: this.pixelByteTotal, compressedBytes, ratio: this.pixelByteTotal > 0 ? compressedBytes / this.pixelByteTotal : 0 };
    }
    getStats() { return this.encodeStats; }
    cancel(_reason) {
        this.cancelled = true;
        this.freeWasmState();
        this.finishResolve?.();
        this.finishResolve = null;
        if (this.pendingPushError !== null)
            throw this.pendingPushError;
    }
    dispose() {
        this.pixelChunks = [];
        this.queuedPixelBytes = 0;
        this.cancelled = true;
        this.freeWasmState();
        this.finishResolve?.();
        this.finishResolve = null;
    }
    freeWasmState() {
        if (this.wasmModule !== null) {
            if (this.advIdsPtr !== 0)
                this.wasmModule._free(this.advIdsPtr);
            if (this.advValuesPtr !== 0)
                this.wasmModule._free(this.advValuesPtr);
            this.advIdsPtr = 0;
            this.advValuesPtr = 0;
        }
        if (this.wasmEncState !== 0 && this.wasmModule !== null) {
            this.wasmModule._jxl_wasm_enc_free(this.wasmEncState);
            this.wasmEncState = 0;
        }
    }
    /**
     * Allocates advancedFrameSettings (if present) into WASM memory and returns
     * pointers + count. The caller is responsible for calling the returned free()
     * after the encode call (or rely on freeWasmState / dispose).
     */
    prepareAdvancedSettings(module) {
        const adv = this.options.advancedFrameSettings;
        if (!adv || adv.length === 0 || !module._malloc) {
            return { idsPtr: 0, valuesPtr: 0, count: 0, free: () => { } };
        }
        const count = adv.length;
        const ids = new Int32Array(adv.map(s => s.id));
        const values = new Int32Array(adv.map(s => s.value));
        const idsPtr = module._malloc(ids.byteLength);
        const valuesPtr = module._malloc(values.byteLength);
        if (idsPtr === 0 || valuesPtr === 0) {
            if (idsPtr !== 0)
                module._free(idsPtr);
            if (valuesPtr !== 0)
                module._free(valuesPtr);
            throw new Error("WASM OOM: failed to allocate advancedFrameSettings buffers");
        }
        module.HEAP32.set(ids, idsPtr >> 2);
        module.HEAP32.set(values, valuesPtr >> 2);
        const free = () => {
            module._free(idsPtr);
            module._free(valuesPtr);
        };
        return { idsPtr, valuesPtr, count, free };
    }
    waitUntilFinished() {
        if (this.finished || this.cancelled)
            return Promise.resolve();
        return new Promise((resolve) => { this.finishResolve = resolve; });
    }
}
async function loadLibjxlModule() {
    if (modulePromise === undefined) {
        const p = (testModuleFactory ?? loadGeneratedLibjxlModule)();
        modulePromise = p;
        // A rejected module promise must not poison every future call. Clear the cache on
        // failure (identity-guarded so a newer attempt isn't clobbered) so a transient cold-load
        // error — e.g. a failed .wasm fetch — can be retried by the next decode/encode.
        p.catch(() => { if (modulePromise === p)
            modulePromise = undefined; });
    }
    return modulePromise;
}
async function loadGeneratedLibjxlModule() {
    const tier = _forcedTier ?? detectTier();
    // Prefer the split full-feature `enc` module emitted by scripts/build.mjs (it is a superset:
    // decode + encode + planar + perceptual). Fall back to the legacy monolithic artifact when the
    // split isn't present for this tier, so the facade works across the monolithic→split migration.
    const candidates = [`enc.${tier}`, `${tier}`];
    const baseUrl = new URL("./", import.meta.url);
    let factory;
    let chosen;
    let lastErr;
    for (const name of candidates) {
        try {
            const imported = await import(`./jxl-core.${name}.js`);
            if (typeof imported.default === "function") {
                factory = imported.default;
                chosen = name;
                break;
            }
        }
        catch (error) {
            lastErr = error;
        }
    }
    if (typeof factory !== "function" || chosen === undefined) {
        throw new CapabilityMissing("Generated libjxl WASM module is missing default Emscripten factory", lastErr);
    }
    const options = {
        locateFile: (path) => new URL(path, baseUrl).href,
    };
    // Emscripten web output can fetch the .wasm in the browser. Pre-read the
    // binary only in Node/Bun so the same bundle works in both environments.
    if (typeof process !== "undefined" && !!process.versions?.node) {
        try {
            const fsMod = await import("node:fs/promises");
            const urlMod = await import("node:url");
            options["wasmBinary"] = await fsMod.readFile(urlMod.fileURLToPath(new URL(`jxl-core.${chosen}.wasm`, baseUrl)));
        }
        catch {
            // Node/Bun but binary unavailable; let Emscripten resolve it another way.
        }
    }
    return await factory(options);
}
const capabilityCache = new WeakMap();
export function getCapabilities(module) {
    let caps = capabilityCache.get(module);
    if (caps !== undefined)
        return caps;
    caps = {
        progressiveDecode: typeof module._jxl_wasm_dec_create === "function",
        streamingEncode: typeof module._jxl_wasm_enc_create === "function" &&
            typeof module._jxl_wasm_enc_push_pixels === "function" &&
            typeof module._jxl_wasm_enc_take_chunk === "function" &&
            typeof module._jxl_wasm_enc_free === "function",
        streamingInput: typeof module._jxl_wasm_enc_create_image === "function" &&
            typeof module._jxl_wasm_enc_push_chunk === "function" &&
            typeof module._jxl_wasm_enc_finish === "function" &&
            typeof module._jxl_wasm_enc_take_chunk === "function" &&
            typeof module._jxl_wasm_enc_free === "function",
        streamingInputX: typeof module._jxl_wasm_enc_create_image_x === "function",
        streamingInputY: typeof module._jxl_wasm_enc_create_image_y === "function",
        streamingInputZ: typeof module._jxl_wasm_enc_create_image_z === "function",
        sidecars: typeof module._jxl_wasm_encode_rgba8_with_sidecars === "function" &&
            typeof module._jxl_wasm_buffer_next === "function",
        jpegTranscode: typeof module._jxl_wasm_transcode_jpeg_to_jxl === "function",
    };
    capabilityCache.set(module, caps);
    return caps;
}
function callDecodeFromPtr(module, ptr, size, downsample, format, region) {
    let handle = 0;
    try {
        // #10: use C++ region crop when available — avoids shipping full-image pixels to JS.
        if (region != null) {
            if (format === "rgba16" && module._jxl_wasm_decode_rgba16_region) {
                handle = module._jxl_wasm_decode_rgba16_region(ptr, size, region.x, region.y, region.w, region.h, downsample);
            }
            else if (format === "rgbaf32" && module._jxl_wasm_decode_rgbaf32_region) {
                handle = module._jxl_wasm_decode_rgbaf32_region(ptr, size, region.x, region.y, region.w, region.h, downsample);
            }
            else if (module._jxl_wasm_decode_rgba8_region) {
                handle = module._jxl_wasm_decode_rgba8_region(ptr, size, region.x, region.y, region.w, region.h, downsample);
            }
            else {
                handle = callDecodeNoRegion(module, ptr, size, downsample, format);
            }
        }
        else {
            handle = callDecodeNoRegion(module, ptr, size, downsample, format);
        }
        return readBufferView(module, handle, "decode");
    }
    catch (err) {
        // readBufferView does not free on error — we own handle here.
        if (handle !== 0)
            module._jxl_wasm_buffer_free(handle);
        throw err;
    }
}
function callDecodeNoRegion(module, ptr, size, downsample, format) {
    if (format === "rgba16" && module._jxl_wasm_decode_rgba16) {
        return module._jxl_wasm_decode_rgba16(ptr, size, downsample);
    }
    else if (format === "rgbaf32" && module._jxl_wasm_decode_rgbaf32) {
        return module._jxl_wasm_decode_rgbaf32(ptr, size, downsample);
    }
    return module._jxl_wasm_decode_rgba8(ptr, size, downsample);
}
function readBufferFields(module, handle, operation) {
    if (handle === 0)
        throw new Error(`JXL ${operation} failed`);
    assertA6WordSize(module);
    // JxlWasmBuffer: data* (ptr), size (uint32 A6, not size_t), width, height, bits, has_alpha, error.
    // Read first 7 fields via contiguous HEAPU32 (WASM32 layout). Pointer fields are 4B on supported builds.
    let dataPtr, size, width, height, bitsVal, alphaVal, errorCode;
    const h32 = module.HEAPU32;
    // Only use the HEAPU32 direct-read fast path when `handle` looks like a real WASM heap
    // address: 4-byte aligned and above the minimum reserved region. Test fake modules use
    // sequential integers (1, 2, 3…) that would read garbage at the wrong HEAPU32 index.
    if (h32 && (handle & 3) === 0 && handle >= 16) {
        const b = handle >>> 2;
        dataPtr = h32[b] ?? 0;
        size = h32[b + 1] ?? 0;
        width = h32[b + 2] ?? 0;
        height = h32[b + 3] ?? 0;
        bitsVal = h32[b + 4] ?? 0;
        alphaVal = h32[b + 5] ?? 0;
        errorCode = h32[b + 6] ?? 0;
    }
    else {
        dataPtr = module._jxl_wasm_buffer_data(handle);
        size = module._jxl_wasm_buffer_size(handle);
        width = module._jxl_wasm_buffer_width(handle);
        height = module._jxl_wasm_buffer_height(handle);
        bitsVal = module._jxl_wasm_buffer_bits_per_sample(handle);
        alphaVal = module._jxl_wasm_buffer_has_alpha(handle);
        errorCode = module._jxl_wasm_buffer_error?.(handle) ?? 0;
    }
    if (dataPtr === 0 || size === 0) {
        throw new Error(`JXL ${operation} failed${errorCode === 0 ? "" : ` (${errorCode})`}`);
    }
    return { dataPtr, size, width, height, bitsVal, alphaVal };
}
// Read buffer metadata without freeing handle. Caller is responsible for freeing.
function readBufferView(module, handle, operation) {
    const { dataPtr, size, width, height, bitsVal, alphaVal } = readBufferFields(module, handle, operation);
    return {
        handle,
        data: module.HEAPU8.slice(dataPtr, dataPtr + size),
        width,
        height,
        bitsPerSample: normalizeBitsPerSample(bitsVal),
        hasAlpha: alphaVal !== 0,
    };
}
// A6: called from buffer view paths to assert 32-bit pointers at first use (after module load).
let _a6Checked = false;
function assertA6WordSize(module) {
    if (_a6Checked)
        return;
    _a6Checked = true;
    const fn = module._jxl_wasm_pointer_size;
    if (typeof fn === 'function') {
        const ps = fn();
        if (ps !== 4) {
            throw new Error(`JxlWasm A6: pointer size ${ps} != 4 — WASM64 drift for JxlWasmBuffer FFI`);
        }
    }
}
// Read buffer and always free handle (in finally), whether success or failure.
function takeBuffer(module, handle, operation) {
    try {
        return readBufferView(module, handle, operation);
    }
    finally {
        if (handle !== 0)
            module._jxl_wasm_buffer_free(handle);
    }
}
function retainBufferView(module, handle, operation) {
    const { dataPtr, size, width, height, bitsVal, alphaVal } = readBufferFields(module, handle, operation);
    let released = false;
    return {
        handle,
        data: module.HEAPU8.subarray(dataPtr, dataPtr + size),
        width,
        height,
        bitsPerSample: normalizeBitsPerSample(bitsVal),
        hasAlpha: alphaVal !== 0,
        release() {
            if (!released && handle !== 0) {
                released = true;
                module._jxl_wasm_buffer_free(handle);
            }
        },
    };
}
// Same-tick zero-copy take (A4). Uses HEAPU8.subarray (no copy) instead of .slice.
// Returned .data view is only valid for synchronous use in the same tick before any
// further WASM malloc/grow/realloc (which can invalidate subarray views into the heap).
// Callers must not retain the view across awaits, yields, or additional bridge calls.
// Intended for enc chunk drains (small, immediate yield) and progress snapshots where
// consumer draws/hashes/posts immediately. Long-lived pixel retention should copy.
function takeBufferView(module, handle, operation) {
    try {
        const { dataPtr, size, width, height, bitsVal, alphaVal } = readBufferFields(module, handle, operation);
        return {
            handle,
            data: module.HEAPU8.subarray(dataPtr, dataPtr + size),
            width,
            height,
            bitsPerSample: normalizeBitsPerSample(bitsVal),
            hasAlpha: alphaVal !== 0,
        };
    }
    finally {
        if (handle !== 0)
            module._jxl_wasm_buffer_free(handle);
    }
}
function normalizeBitsPerSample(value) {
    if (value === 16 || value === 32)
        return value;
    return 8;
}
function bytesPerChannelForFormat(format) {
    return format === "rgbaf32" ? 4 : format === "rgba16" ? 2 : 1;
}
const MAX_PIXEL_BYTES = 1024 * 1024 * 1024; // 1 GiB hard limit before WASM malloc
function expectedPixelBytes(width, height, format, maxBytes = MAX_PIXEL_BYTES) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new Error(`Invalid image dimensions: ${width} × ${height}`);
    }
    const bpc = bytesPerChannelForFormat(format);
    const channels = format === "rgb8" ? 3 : 4;
    const bytes = width * height * channels * bpc;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
        throw new Error(`Pixel byte size overflow for ${width} × ${height} ${format}`);
    }
    if (bytes > maxBytes) {
        throw new Error(`Image too large for WASM encode: ${bytes} bytes exceeds limit ${maxBytes}`);
    }
    return bytes;
}
function distanceFromQuality(quality) {
    if (quality === null)
        return 1;
    if (!Number.isFinite(quality))
        throw new Error(`Invalid JXL quality: ${quality}`);
    const q = Math.max(0, Math.min(100, quality));
    return ((100 - q) * 15) / 100;
}
// Borrow or copy input depending on caller's ownership. ArrayBuffer is always zero-copy (view only).
function copyOrBorrowInput(value, copy) {
    if (value instanceof ArrayBuffer)
        return new Uint8Array(value);
    return copy ? value.slice() : value;
}
function mallocOrThrow(module, size, label) {
    const ptr = module._malloc(size);
    if (ptr === 0)
        throw new Error(`WASM malloc failed for ${label}`);
    return ptr;
}
// Reused scratch for int32-bits→float reinterpret. JS workers are single-threaded, so a
// shared 4-byte view is safe and avoids 3 allocations (ArrayBuffer + 2 typed arrays) per call.
const _f32ScratchBuf = new ArrayBuffer(4);
const _f32ScratchI32 = new Int32Array(_f32ScratchBuf);
const _f32ScratchF32 = new Float32Array(_f32ScratchBuf);
function floatFromI32Bits(bits) {
    _f32ScratchI32[0] = bits;
    return _f32ScratchF32[0];
}
function butteraugliPixelSize(pixels, width, height, operation) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new Error(`${operation}: invalid dimensions ${width}×${height}`);
    }
    const pixelSize = width * height * 4;
    const view = copyOrBorrowInput(pixels, false);
    if (!Number.isSafeInteger(pixelSize) || pixelSize <= 0) {
        throw new Error(`${operation}: pixel byte size overflow for ${width}×${height}`);
    }
    if (view.byteLength < pixelSize) {
        throw new Error(`${operation}: expected ${pixelSize} bytes for ${width}×${height} RGBA8, got ${view.byteLength}`);
    }
    return pixelSize;
}
function jxtcNonTileRanges(view) {
    if (view.byteLength < 40)
        return [];
    const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
    const version = dv.getUint32(4, true);
    const tilesX = dv.getUint32(20, true);
    const tilesY = dv.getUint32(24, true);
    if (version !== 1 || tilesX === 0 || tilesY === 0)
        return [];
    const tileCount = tilesX * tilesY;
    if (!Number.isSafeInteger(tileCount) || tileCount <= 0)
        return [];
    const indexEnd = 32 + tileCount * 8;
    if (indexEnd > view.byteLength)
        return [];
    const intervals = [];
    for (let i = 0; i < tileCount; i++) {
        const offset = dv.getUint32(32 + i * 8, true);
        const length = dv.getUint32(32 + i * 8 + 4, true);
        const end = offset + length;
        if (length === 0 || offset < indexEnd || end > view.byteLength || end < offset)
            return [];
        intervals.push([offset, end]);
    }
    intervals.sort((a, b) => a[0] - b[0]);
    const ranges = [];
    let cursor = indexEnd;
    for (const [start, end] of intervals) {
        if (start > cursor)
            ranges.push([cursor, start]);
        cursor = Math.max(cursor, end);
    }
    if (cursor < view.byteLength)
        ranges.push([cursor, view.byteLength]);
    return ranges;
}
function scanForValidJpeg(view, start, end) {
    for (let offset = start; offset < end - 3; offset++) {
        if (view[offset] !== 0xff || view[offset + 1] !== 0xd8)
            continue;
        const jpegEnd = findValidJpegEnd(view, offset, end);
        if (jpegEnd !== 0)
            return view.slice(offset, jpegEnd);
    }
    return null;
}
function findValidJpegEnd(view, soi, limit) {
    let offset = soi + 2;
    let segments = 0;
    while (offset + 1 < limit) {
        if (view[offset] !== 0xff)
            return 0;
        while (offset < limit && view[offset] === 0xff)
            offset++;
        if (offset >= limit)
            return 0;
        const marker = view[offset++];
        if (marker === 0xd9)
            return segments >= 2 ? offset : 0;
        // SOS (0xDA) marks the Start of Scan, followed by entropy-encoded data.
        // Skip SOS header, then scan entropy data for the next marker.
        if (marker === 0xda) {
            if (offset + 2 > limit)
                return 0;
            const sosLength = (view[offset] << 8) | view[offset + 1];
            if (sosLength < 2 || offset + sosLength > limit)
                return 0;
            offset += sosLength;
            segments++;
            // Scan entropy data: 0xFF followed by non-zero, non-RST marker stops entropy.
            while (offset < limit) {
                if (view[offset] === 0xff) {
                    if (offset + 1 >= limit)
                        return 0;
                    const nextByte = view[offset + 1];
                    // 0x00 is an escaped 0xFF in entropy data, 0xD0-0xD7 are RST markers (allowed in entropy).
                    if (nextByte !== 0x00 && (nextByte < 0xd0 || nextByte > 0xd7)) {
                        // Found next marker (0xFF nextByte). We'll reprocess the 0xFF in the next loop.
                        break;
                    }
                    offset += 2;
                }
                else {
                    offset++;
                }
            }
            continue;
        }
        if (!isValidJpegHeaderMarker(marker) || offset + 2 > limit)
            return 0;
        const length = (view[offset] << 8) | view[offset + 1];
        if (length < 2 || offset + length > limit)
            return 0;
        offset += length;
        segments++;
    }
    return 0;
}
function isValidJpegHeaderMarker(marker) {
    return ((marker >= 0xe0 && marker <= 0xef) ||
        marker === 0xdb ||
        marker === 0xc4 ||
        marker === 0xdd ||
        marker === 0xfe ||
        (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc8 && marker !== 0xcc));
}
export function applyRegionAndDownsample(data, width, height, region, downsample, bytesPerChannel = 1) {
    // IMPROVEMENT-8: Hottest path — no crop, no downsample — skip normalizeRegion entirely.
    if (downsample === 1 && region === null)
        return { data, width, height };
    const stride = 4 * bytesPerChannel;
    const sourceRegion = normalizeRegion(region, width, height);
    // Secondary fast path: region present but maps to full image after clamping
    if (downsample === 1 && sourceRegion.x === 0 && sourceRegion.y === 0 && sourceRegion.w === width && sourceRegion.h === height) {
        const result = { data, width, height };
        if (region !== null)
            result.region = { x: 0, y: 0, w: width, h: height };
        return result;
    }
    const outWidth = Math.max(1, Math.ceil(sourceRegion.w / downsample));
    const outHeight = Math.max(1, Math.ceil(sourceRegion.h / downsample));
    const out = new Uint8Array(outWidth * outHeight * stride);
    if (downsample === 1) {
        // Crop-only: copy whole rows at once — much faster than per-pixel copy.
        for (let y = 0; y < outHeight; y++) {
            const srcStart = ((sourceRegion.y + y) * width + sourceRegion.x) * stride;
            out.set(data.subarray(srcStart, srcStart + outWidth * stride), y * outWidth * stride);
        }
    }
    else {
        // Downsample (nearest): walk source by a fixed pixel/row step with linear pointer
        // advancement. The per-pixel Math.min clamps the old path carried are mathematically
        // unreachable — outWidth = ceil(w/ds) ⇒ (outWidth-1)*ds ≤ w-1 (same for height) — so
        // x*ds / y*ds never exceed the region, and the bounds checks are dropped.
        const sourceOffset = (sourceRegion.y * width + sourceRegion.x) * stride;
        const rowStepBytes = width * stride * downsample;
        const pixelStepBytes = stride * downsample;
        if ((data.byteOffset & 3) === 0) {
            // Aligned fast path: copy whole RGBA pixels as 32-bit words (1/2/4 words per pixel
            // for rgba8/rgba16/rgbaf32). Little-endian word copy is byte-identical to the
            // element-by-element copy it replaces, and removes the per-pixel subarray() alloc.
            const wordsPerPixel = stride >>> 2;
            const sourceWords = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >>> 2);
            const outputWords = new Uint32Array(out.buffer);
            const rowStep = rowStepBytes >>> 2;
            const pixelStep = pixelStepBytes >>> 2;
            let sourceRow = sourceOffset >>> 2;
            let outputRow = 0;
            if (wordsPerPixel === 1) {
                for (let y = 0; y < outHeight; y++, sourceRow += rowStep, outputRow += outWidth) {
                    let src = sourceRow;
                    let dst = outputRow;
                    for (let x = 0; x < outWidth; x++, src += pixelStep, dst++) {
                        outputWords[dst] = sourceWords[src];
                    }
                }
            }
            else if (wordsPerPixel === 2) {
                for (let y = 0; y < outHeight; y++, sourceRow += rowStep, outputRow += outWidth * 2) {
                    let src = sourceRow;
                    let dst = outputRow;
                    for (let x = 0; x < outWidth; x++, src += pixelStep, dst += 2) {
                        outputWords[dst] = sourceWords[src];
                        outputWords[dst + 1] = sourceWords[src + 1];
                    }
                }
            }
            else {
                for (let y = 0; y < outHeight; y++, sourceRow += rowStep, outputRow += outWidth * 4) {
                    let src = sourceRow;
                    let dst = outputRow;
                    for (let x = 0; x < outWidth; x++, src += pixelStep, dst += 4) {
                        outputWords[dst] = sourceWords[src];
                        outputWords[dst + 1] = sourceWords[src + 1];
                        outputWords[dst + 2] = sourceWords[src + 2];
                        outputWords[dst + 3] = sourceWords[src + 3];
                    }
                }
            }
        }
        else {
            // Unaligned fallback (source not 4-byte aligned): per-byte copy with linear advance.
            let sourceRow = sourceOffset;
            let outputRow = 0;
            for (let y = 0; y < outHeight; y++, sourceRow += rowStepBytes, outputRow += outWidth * stride) {
                let src = sourceRow;
                let dst = outputRow;
                for (let x = 0; x < outWidth; x++, src += pixelStepBytes, dst += stride) {
                    for (let b = 0; b < stride; b++)
                        out[dst + b] = data[src + b];
                }
            }
        }
    }
    const result = {
        data: out,
        width: outWidth,
        height: outHeight,
    };
    if (region !== null) {
        result.region = { x: 0, y: 0, w: outWidth, h: outHeight };
    }
    return result;
}
export function buildResizeAxis(srcSize, dstSize, srcStart = 0, srcSpan = srcSize) {
    const i0 = new Int32Array(dstSize);
    const i1 = new Int32Array(dstSize);
    const t = new Float32Array(dstSize);
    const scale = srcSpan / dstSize;
    for (let d = 0; d < dstSize; d++) {
        const f = srcStart + (d + 0.5) * scale - 0.5;
        const base = Math.max(0, Math.floor(f));
        i0[d] = base;
        i1[d] = Math.min(srcSize - 1, base + 1);
        t[d] = f - base;
    }
    return { i0, i1, t };
}
// 8.8 fixed-point interpolation weights ((t*256)|0), cached on the axis so a plan
// reused across every progressive paint truncates the float weights only once.
// Identical values to the per-call computation it replaces, hence byte-exact.
function fixedResizeWeights256(axis) {
    let fixed = axis.fixed256;
    if (fixed !== undefined)
        return fixed;
    const t = axis.t;
    fixed = new Int16Array(t.length);
    for (let i = 0; i < fixed.length; i++)
        fixed[i] = (t[i] * 256) | 0;
    axis.fixed256 = fixed;
    return fixed;
}
export function bilinearResize(src, srcW, srcH, dstW, dstH, stride, // 4=rgba8, 8=rgba16, 16=rgbaf32
xAxisIn, yAxisIn) {
    if (srcW === dstW && srcH === dstH)
        return src;
    const dst = new Uint8Array(dstW * dstH * stride);
    const xAxis = xAxisIn ?? buildResizeAxis(srcW, dstW);
    const yAxis = yAxisIn ?? buildResizeAxis(srcH, dstH);
    if (stride === 4) {
        // 8.8 fixed-point weights: eliminates float↔int traffic per channel.
        // Weights sum to exactly 256; +128 before >>8 gives unbiased rounding.
        // Both axes' fixed-point weights are now cached on the axis (column-/row-invariant),
        // so repeated paints over one plan never re-truncate. The 4-channel inner loop is
        // unrolled — same arithmetic per channel, fewer loop-overhead instructions.
        const xtIs = fixedResizeWeights256(xAxis);
        const ytIs = fixedResizeWeights256(yAxis);
        const i0x = xAxis.i0;
        const i1x = xAxis.i1;
        for (let dy = 0; dy < dstH; dy++) {
            const y0 = yAxis.i0[dy];
            const y1 = yAxis.i1[dy];
            const ytI = ytIs[dy];
            const row00 = y0 * srcW * 4;
            const row10 = y1 * srcW * 4;
            const dstRow = dy * dstW * 4;
            for (let dx = 0; dx < dstW; dx++) {
                const x0 = i0x[dx];
                const x1 = i1x[dx];
                const xtI = xtIs[dx];
                const w11 = (xtI * ytI) >> 8;
                const w10 = ytI - w11;
                const w01 = xtI - w11;
                const w00 = 256 - xtI - ytI + w11;
                const topLeft = row00 + x0 * 4;
                const topRight = row00 + x1 * 4;
                const bottomLeft = row10 + x0 * 4;
                const bottomRight = row10 + x1 * 4;
                const dstOff = dstRow + dx * 4;
                dst[dstOff] = (src[topLeft] * w00 + src[topRight] * w01 + src[bottomLeft] * w10 + src[bottomRight] * w11 + 128) >> 8;
                dst[dstOff + 1] = (src[topLeft + 1] * w00 + src[topRight + 1] * w01 + src[bottomLeft + 1] * w10 + src[bottomRight + 1] * w11 + 128) >> 8;
                dst[dstOff + 2] = (src[topLeft + 2] * w00 + src[topRight + 2] * w01 + src[bottomLeft + 2] * w10 + src[bottomRight + 2] * w11 + 128) >> 8;
                dst[dstOff + 3] = (src[topLeft + 3] * w00 + src[topRight + 3] * w01 + src[bottomLeft + 3] * w10 + src[bottomRight + 3] * w11 + 128) >> 8;
            }
        }
    }
    else if (stride === 8) {
        const srcView = new Uint16Array(src.buffer, src.byteOffset, src.byteLength >> 1);
        const dstView = new Uint16Array(dst.buffer);
        const i0x = xAxis.i0;
        const i1x = xAxis.i1;
        const tx = xAxis.t;
        for (let dy = 0; dy < dstH; dy++) {
            const y0 = yAxis.i0[dy];
            const y1 = yAxis.i1[dy];
            const yt = yAxis.t[dy];
            const invYt = 1 - yt;
            const row00 = y0 * srcW * 4;
            const row10 = y1 * srcW * 4;
            const dstRow = dy * dstW * 4;
            for (let dx = 0; dx < dstW; dx++) {
                const x0 = i0x[dx];
                const x1 = i1x[dx];
                const xt = tx[dx];
                const invXt = 1 - xt;
                const w00 = invXt * invYt;
                const w01 = xt * invYt;
                const w10 = invXt * yt;
                const w11 = xt * yt;
                const topLeft = row00 + x0 * 4;
                const topRight = row00 + x1 * 4;
                const bottomLeft = row10 + x0 * 4;
                const bottomRight = row10 + x1 * 4;
                const dstOff = dstRow + dx * 4;
                dstView[dstOff] = Math.max(0, Math.min(65535, Math.round(srcView[topLeft] * w00 + srcView[topRight] * w01 + srcView[bottomLeft] * w10 + srcView[bottomRight] * w11)));
                dstView[dstOff + 1] = Math.max(0, Math.min(65535, Math.round(srcView[topLeft + 1] * w00 + srcView[topRight + 1] * w01 + srcView[bottomLeft + 1] * w10 + srcView[bottomRight + 1] * w11)));
                dstView[dstOff + 2] = Math.max(0, Math.min(65535, Math.round(srcView[topLeft + 2] * w00 + srcView[topRight + 2] * w01 + srcView[bottomLeft + 2] * w10 + srcView[bottomRight + 2] * w11)));
                dstView[dstOff + 3] = Math.max(0, Math.min(65535, Math.round(srcView[topLeft + 3] * w00 + srcView[topRight + 3] * w01 + srcView[bottomLeft + 3] * w10 + srcView[bottomRight + 3] * w11)));
            }
        }
    }
    else {
        const srcView = new Float32Array(src.buffer, src.byteOffset, src.byteLength >> 2);
        const dstView = new Float32Array(dst.buffer);
        const i0x = xAxis.i0;
        const i1x = xAxis.i1;
        const tx = xAxis.t;
        for (let dy = 0; dy < dstH; dy++) {
            const y0 = yAxis.i0[dy];
            const y1 = yAxis.i1[dy];
            const yt = yAxis.t[dy];
            const invYt = 1 - yt;
            const row00 = y0 * srcW * 4;
            const row10 = y1 * srcW * 4;
            const dstRow = dy * dstW * 4;
            for (let dx = 0; dx < dstW; dx++) {
                const x0 = i0x[dx];
                const x1 = i1x[dx];
                const xt = tx[dx];
                const invXt = 1 - xt;
                const w00 = invXt * invYt;
                const w01 = xt * invYt;
                const w10 = invXt * yt;
                const w11 = xt * yt;
                const topLeft = row00 + x0 * 4;
                const topRight = row00 + x1 * 4;
                const bottomLeft = row10 + x0 * 4;
                const bottomRight = row10 + x1 * 4;
                const dstOff = dstRow + dx * 4;
                dstView[dstOff] = srcView[topLeft] * w00 + srcView[topRight] * w01 + srcView[bottomLeft] * w10 + srcView[bottomRight] * w11;
                dstView[dstOff + 1] = srcView[topLeft + 1] * w00 + srcView[topRight + 1] * w01 + srcView[bottomLeft + 1] * w10 + srcView[bottomRight + 1] * w11;
                dstView[dstOff + 2] = srcView[topLeft + 2] * w00 + srcView[topRight + 2] * w01 + srcView[bottomLeft + 2] * w10 + srcView[bottomRight + 2] * w11;
                dstView[dstOff + 3] = srcView[topLeft + 3] * w00 + srcView[topRight + 3] * w01 + srcView[bottomLeft + 3] * w10 + srcView[bottomRight + 3] * w11;
            }
        }
    }
    return dst;
}
function buildResizePlan(srcW, srcH, targetW, targetH, fitMode, bpc) {
    const plan = { srcW, srcH, dstW: targetW, dstH: targetH, fitMode, bpc };
    if (fitMode === "stretch")
        return plan;
    if (fitMode === "contain") {
        const scale = Math.min(targetW / srcW, targetH / srcH);
        plan.dstW = Math.max(1, Math.round(srcW * scale));
        plan.dstH = Math.max(1, Math.round(srcH * scale));
        if (plan.dstW !== srcW || plan.dstH !== srcH) {
            plan.xAxis = buildResizeAxis(srcW, plan.dstW);
            plan.yAxis = buildResizeAxis(srcH, plan.dstH);
        }
        return plan;
    }
    const scale = Math.max(targetW / srcW, targetH / srcH);
    const scaledW = Math.max(targetW, Math.round(srcW * scale));
    const scaledH = Math.max(targetH, Math.round(srcH * scale));
    if (scaledW !== srcW || scaledH !== srcH) {
        const cropX = Math.floor((scaledW - targetW) / 2);
        const cropY = Math.floor((scaledH - targetH) / 2);
        const srcSpanW = targetW * srcW / scaledW;
        const srcSpanH = targetH * srcH / scaledH;
        const srcStartX = cropX * srcW / scaledW;
        const srcStartY = cropY * srcH / scaledH;
        plan.xAxis = buildResizeAxis(srcW, targetW, srcStartX, srcSpanW);
        plan.yAxis = buildResizeAxis(srcH, targetH, srcStartY, srcSpanH);
    }
    return plan;
}
function applyTargetResize(src, srcW, srcH, targetW, targetH, fitMode, bpc, plan) {
    if (srcW === targetW && srcH === targetH) {
        return { data: src, width: srcW, height: srcH };
    }
    const stride = 4 * bpc;
    const activePlan = plan
        && plan.srcW === srcW
        && plan.srcH === srcH
        && plan.dstW === targetW
        && plan.dstH === targetH
        && plan.fitMode === fitMode
        && plan.bpc === bpc
        ? plan
        : null;
    if (fitMode === "stretch") {
        return {
            data: bilinearResize(src, srcW, srcH, targetW, targetH, stride, activePlan?.xAxis, activePlan?.yAxis),
            width: targetW,
            height: targetH,
        };
    }
    if (fitMode === "contain") {
        const dstW = activePlan?.dstW ?? Math.max(1, Math.round(srcW * Math.min(targetW / srcW, targetH / srcH)));
        const dstH = activePlan?.dstH ?? Math.max(1, Math.round(srcH * Math.min(targetW / srcW, targetH / srcH)));
        if (dstW === srcW && dstH === srcH)
            return { data: src, width: srcW, height: srcH };
        return {
            data: bilinearResize(src, srcW, srcH, dstW, dstH, stride, activePlan?.xAxis, activePlan?.yAxis),
            width: dstW,
            height: dstH,
        };
    }
    // cover: map target pixels directly to cropped source span via windowed axes —
    // no intermediate scaled buffer. cropX/Y computed in scaled coords then converted
    // to source coords using scale factor srcW/scaledW so sub-pixel positions are
    // bit-exact with the old two-pass path (scaledW = round(srcW*scale)).
    const scale = Math.max(targetW / srcW, targetH / srcH);
    const scaledW = Math.max(targetW, Math.round(srcW * scale));
    const scaledH = Math.max(targetH, Math.round(srcH * scale));
    const cropX = Math.floor((scaledW - targetW) / 2);
    const cropY = Math.floor((scaledH - targetH) / 2);
    if (scaledW === srcW && scaledH === srcH) {
        const cropped = applyRegionAndDownsample(src, srcW, srcH, { x: cropX, y: cropY, w: targetW, h: targetH }, 1, bpc);
        return { data: cropped.data, width: targetW, height: targetH };
    }
    const srcSpanW = targetW * srcW / scaledW;
    const srcSpanH = targetH * srcH / scaledH;
    const srcStartX = cropX * srcW / scaledW;
    const srcStartY = cropY * srcH / scaledH;
    const xa = activePlan?.xAxis ?? buildResizeAxis(srcW, targetW, srcStartX, srcSpanW);
    const ya = activePlan?.yAxis ?? buildResizeAxis(srcH, targetH, srcStartY, srcSpanH);
    return { data: bilinearResize(src, srcW, srcH, targetW, targetH, stride, xa, ya), width: targetW, height: targetH };
}
function pickDownsample(options) {
    const region = options.region ?? null;
    const targetWidth = options.targetWidth ?? null;
    const targetHeight = options.targetHeight ?? null;
    if (targetWidth == null || targetHeight == null || targetWidth <= 0 || targetHeight <= 0) {
        return 1;
    }
    const sourceWidth = options.sourceWidth ?? null;
    const sourceHeight = options.sourceHeight ?? null;
    const sourceLongEdge = region !== null
        ? Math.max(region.w, region.h)
        : sourceWidth != null && sourceHeight != null && sourceWidth > 0 && sourceHeight > 0
            ? Math.max(sourceWidth, sourceHeight)
            : 1;
    const targetLongEdge = Math.max(targetWidth, targetHeight);
    for (const factor of [8, 4, 2]) {
        if (Math.ceil(sourceLongEdge / factor) >= targetLongEdge)
            return factor;
    }
    return 1;
}
function normalizeRegion(region, width, height) {
    if (region === null)
        return { x: 0, y: 0, w: width, h: height };
    const x = Math.max(0, Math.min(width - 1, Math.trunc(region.x)));
    const y = Math.max(0, Math.min(height - 1, Math.trunc(region.y)));
    const maxW = width - x;
    const maxH = height - y;
    return {
        x,
        y,
        w: Math.max(1, Math.min(maxW, Math.trunc(region.w))),
        h: Math.max(1, Math.min(maxH, Math.trunc(region.h))),
    };
}
export async function getPerceptualConstancySupport() {
    const module = await loadLibjxlModule();
    const m = module;
    return {
        hasScalar: typeof m._perceptual_apply_full === "function",
        hasAvx2Bulk: typeof m._perceptual_apply_full_avx2 === "function",
    };
}
/**
 * Apply the full perceptual constancy transform (B + log geodesic + Molchanov + hybrid spring + f(c))
 * using the fastest available C++ path from the bridge (AVX2 bulk preferred).
 * Expects separate channel SoA buffers (length = numPixels). Mutates outputs in place if provided,
 * otherwise writes to the input arrays.
 * This is the direct JS hook for the lightbox progressive paint path (toggleable, runtime only).
 */
export async function perceptualConstancyApplyBulk(r, g, b, sat, vib, vibZero, outR, outG, outB) {
    const module = await loadLibjxlModule();
    const m = module;
    const n = r.length | 0;
    if ((g.length | 0) !== n || (b.length | 0) !== n) {
        throw new Error("perceptualConstancyApplyBulk: r/g/b must have identical length");
    }
    const targetR = outR ?? r;
    const targetG = outG ?? g;
    const targetB = outB ?? b;
    const fn = m._perceptual_apply_full_avx2;
    if (typeof fn === "function") {
        fn(r, g, b, targetR, targetG, targetB, n, sat, vib, vibZero ? 1 : 0);
        return;
    }
    const fns = m._perceptual_apply_full;
    if (typeof fns === "function") {
        // _perceptual_apply_full_avx2 is absent — scalar JS path not implemented.
        // The transform is skipped (identity copy). Rebuild with AVX2 for real output.
        console.warn("[jxl-wasm] perceptualConstancyApplyBulk: AVX2 bulk fn absent; perceptual transform not applied (identity). Rebuild WASM with AVX2 support.");
        if (targetR !== r)
            targetR.set(r);
        if (targetG !== g)
            targetG.set(g);
        if (targetB !== b)
            targetB.set(b);
        return;
    }
    // No support compiled in: identity
    if (targetR !== r)
        targetR.set(r);
    if (targetG !== g)
        targetG.set(g);
    if (targetB !== b)
        targetB.set(b);
}
//# sourceMappingURL=facade.js.map