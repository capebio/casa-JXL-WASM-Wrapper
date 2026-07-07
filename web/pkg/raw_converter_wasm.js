/* @ts-self-types="./raw_converter_wasm.d.ts" */

/**
 * Timing results for the decompress + demosaic stages only.
 * Skips tonemap, downscale, and orientation — isolates raw decode cost.
 */
export class DecodeBench {
    static __wrap(ptr) {
        const obj = Object.create(DecodeBench.prototype);
        obj.__wbg_ptr = ptr;
        DecodeBenchFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DecodeBenchFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_decodebench_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get decompress_ms() {
        const ret = wasm.__wbg_get_decodebench_decompress_ms(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get demosaic_ms() {
        const ret = wasm.__wbg_get_decodebench_demosaic_ms(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get height() {
        const ret = wasm.__wbg_get_decodebench_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get width() {
        const ret = wasm.__wbg_get_decodebench_width(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) DecodeBench.prototype[Symbol.dispose] = DecodeBench.prototype.free;

/**
 * S3 preflight: project the peak / retained working-set of a RAW decode from
 * dimensions + output flags, WITHOUT decoding. Behavior-neutral (changes no
 * decode output). Fields are byte counts as `f64` (exact for all realistic
 * sizes — well under 2^53). Browser callers use `peak_bytes` for pre-decode
 * admission control against the WASM heap / memory budget, and `retained_bytes`
 * for `AssetStore` accounting of the buffers a held `ProcessResult` keeps.
 * See the model derivation in `raw_pipeline::mem_budget` / the memory-budget ADR.
 */
export class DecodePeakEstimate {
    static __wrap(ptr) {
        const obj = Object.create(DecodePeakEstimate.prototype);
        obj.__wbg_ptr = ptr;
        DecodePeakEstimateFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DecodePeakEstimateFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_decodepeakestimate_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get peak_bytes() {
        const ret = wasm.__wbg_get_decodepeakestimate_peak_bytes(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get pixels() {
        const ret = wasm.__wbg_get_decodepeakestimate_pixels(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get retained_bytes() {
        const ret = wasm.__wbg_get_decodepeakestimate_retained_bytes(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) DecodePeakEstimate.prototype[Symbol.dispose] = DecodePeakEstimate.prototype.free;

/**
 * Decoded non-RAW image handed to JS. One of the take_* buffers is non-empty,
 * selected by `bit_depth` (8 -> take_rgba8, 16 -> take_rgba16_le, 32 -> take_rgba_f32).
 */
export class DecodedImage {
    static __wrap(ptr) {
        const obj = Object.create(DecodedImage.prototype);
        obj.__wbg_ptr = ptr;
        DecodedImageFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DecodedImageFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_decodedimage_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get bit_depth() {
        const ret = wasm.decodedimage_bit_depth(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get height() {
        const ret = wasm.decodedimage_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * RGBA16 packed little-endian, 8 bytes/px (bit_depth == 16). Empty otherwise.
     * @returns {Uint8Array}
     */
    take_rgba16_le() {
        const ret = wasm.decodedimage_take_rgba16_le(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * RGBA8 (bit_depth == 8). Empty otherwise.
     * @returns {Uint8Array}
     */
    take_rgba8() {
        const ret = wasm.decodedimage_take_rgba8(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * RGBA f32 (bit_depth == 32). Returned as Float32Array. Empty otherwise.
     * @returns {Float32Array}
     */
    take_rgba_f32() {
        const ret = wasm.decodedimage_take_rgba_f32(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Display-ready RGBA8 regardless of source depth (f32 -> linear->sRGB).
     * @returns {Uint8Array}
     */
    to_display_rgba8() {
        const ret = wasm.decodedimage_to_display_rgba8(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {number}
     */
    get width() {
        const ret = wasm.decodedimage_width(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) DecodedImage.prototype[Symbol.dispose] = DecodedImage.prototype.free;

/**
 * K6#4: stateful FableBraid decode session for browser CASV playback. Mirrors the
 * native `DeltaDecodeSession` (`fable_braid.rs`): decode an intra keyframe, then
 * temporal-delta frames against the previous frame this session returned. The
 * stateless `fable_decode_rgb8*` fns above are pure functions; the fable video
 * tier is a whole-frame temporal chain, so browser playback needs this session.
 *
 * `decode_intra` sets `width`/`height`; `decode_delta` takes the current dims and
 * the previous frame's RGB8 (the value this session last returned).
 */
export class FableDeltaSession {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FableDeltaSessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fabledeltasession_free(ptr, 0);
    }
    /**
     * Decode a temporal-delta fable frame against `prev` (the RGB8 this session
     * returned for the previous frame). `w`/`h` are the current frame dims.
     * @param {Uint8Array} bytes
     * @param {Uint8Array} prev
     * @param {number} w
     * @param {number} h
     * @returns {Uint8Array}
     */
    decode_delta(bytes, prev, w, h) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(prev, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.fabledeltasession_decode_delta(this.__wbg_ptr, ptr0, len0, ptr1, len1, w, h);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v3;
    }
    /**
     * Decode an intra (keyframe) fable frame; caches its planes for subsequent
     * `decode_delta` calls. Updates `width`/`height`. Returns interleaved RGB8.
     * @param {Uint8Array} bytes
     * @returns {Uint8Array}
     */
    decode_intra(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fabledeltasession_decode_intra(this.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * @returns {number}
     */
    get height() {
        const ret = wasm.fabledeltasession_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    constructor() {
        const ret = wasm.fabledeltasession_new();
        this.__wbg_ptr = ret;
        FableDeltaSessionFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    get width() {
        const ret = wasm.fabledeltasession_width(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) FableDeltaSession.prototype[Symbol.dispose] = FableDeltaSession.prototype.free;

/**
 * WASM-resident rendering state for a single image (lightbox or thumbnail).
 *
 * Owns the pre-tonemapped RGB16 buffer.  Slider changes call `render()` without
 * transferring pixel data between JS and WASM — the JS→WASM transfer happens once
 * at construction; every subsequent edit stays inside WASM.
 *
 * When `texture` and `clarity` are both zero (the common case), `render` reads the
 * internal buffer without cloning.  When either is nonzero, a thread-local scratch
 * buffer is reused for in-place sharpening so the cached buffer is never mutated
 * and no per-call Vec::clone occurs.
 */
export class LookRenderer {
    static __wrap(ptr) {
        const obj = Object.create(LookRenderer.prototype);
        obj.__wbg_ptr = ptr;
        LookRendererFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        LookRendererFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_lookrenderer_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get native_height() {
        const ret = wasm.lookrenderer_native_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Source-buffer dimensions (sensor orientation, pre-rotation).
     * @returns {number}
     */
    get native_width() {
        const ret = wasm.lookrenderer_native_width(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Construct from a packed u16-LE buffer (6 bytes per pixel, as returned by
     * `take_rgb16_lb` / `take_rgb16_thumb`), dims, EXIF orientation, and a
     * 9-element row-major colour matrix.  Pass a slice of length != 9 to use
     * the built-in `CAM_TO_SRGB` fallback.
     * @param {Uint8Array} rgb16_bytes
     * @param {number} width
     * @param {number} height
     * @param {number} orientation
     * @param {Float32Array} color_matrix_flat
     */
    constructor(rgb16_bytes, width, height, orientation, color_matrix_flat) {
        const ptr0 = passArray8ToWasm0(rgb16_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(color_matrix_flat, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.lookrenderer_new(ptr0, len0, width, height, orientation, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        LookRendererFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Variant of `new` that lets the caller opt out of CPU rotation in
     * `render()`. When `apply_rotation` is `false`, `render()` returns
     * sensor-orientation RGB8 (same dims as `rgb16` source) and the JS side
     * must apply the EXIF rotation at display time (canvas/CSS transform).
     * Saves a full-buffer transpose per slider tick for non-identity orientations.
     * @param {Uint8Array} rgb16_bytes
     * @param {number} width
     * @param {number} height
     * @param {number} orientation
     * @param {Float32Array} color_matrix_flat
     * @param {boolean} apply_rotation
     * @param {number} black
     * @param {number} white
     * @returns {LookRenderer}
     */
    static new_with_options(rgb16_bytes, width, height, orientation, color_matrix_flat, apply_rotation, black, white) {
        const ptr0 = passArray8ToWasm0(rgb16_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(color_matrix_flat, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.lookrenderer_new_with_options(ptr0, len0, width, height, orientation, ptr1, len1, apply_rotation, black, white);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return LookRenderer.__wrap(ret[0]);
    }
    /**
     * EXIF orientation tag (1..8) stored at construction. Consumers using
     * `apply_rotation=false` read this to drive display-time rotation.
     * @returns {number}
     */
    get orientation() {
        const ret = wasm.lookrenderer_orientation(this.__wbg_ptr);
        return ret;
    }
    /**
     * Apply look parameters and return an RGB8 buffer (post-orientation).
     * Only the output RGB8 crosses the WASM boundary on each call.
     * @param {number} wb_r
     * @param {number} wb_b
     * @param {number} exposure_ev
     * @param {number} contrast
     * @param {number} highlights
     * @param {number} shadows
     * @param {number} whites
     * @param {number} blacks
     * @param {number} saturation
     * @param {number} vibrance
     * @param {number} temp
     * @param {number} tint
     * @param {number} texture
     * @param {number} clarity
     * @returns {Uint8Array}
     */
    render(wb_r, wb_b, exposure_ev, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, texture, clarity) {
        const ret = wasm.lookrenderer_render(this.__wbg_ptr, wb_r, wb_b, exposure_ev, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, texture, clarity);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * K6#1: named-object look API. `look` is a plain JS object (camelCase fields —
     * see `LookOverrides::from_js`); unknown key → error, missing key → neutral.
     * Preferred over the 14-positional-arg `render`, which remains for back-compat.
     * @param {any} look
     * @returns {Uint8Array}
     */
    render_look(look) {
        const ret = wasm.lookrenderer_render_look(this.__wbg_ptr, look);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) LookRenderer.prototype[Symbol.dispose] = LookRenderer.prototype.free;

/**
 * EXIF metadata extracted without demosaic/tonemap.  Use for gallery thumbnails,
 * batch preflight, and sort-by-date/lens/GPS without a full decode.
 */
export class OrfMetadata {
    static __wrap(ptr) {
        const obj = Object.create(OrfMetadata.prototype);
        obj.__wbg_ptr = ptr;
        OrfMetadataFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        OrfMetadataFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_orfmetadata_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get gps_lat() {
        const ret = wasm.__wbg_get_orfmetadata_gps_lat(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get gps_lon() {
        const ret = wasm.__wbg_get_orfmetadata_gps_lon(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {boolean}
     */
    get has_gps() {
        const ret = wasm.__wbg_get_orfmetadata_has_gps(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    get height() {
        const ret = wasm.__wbg_get_orfmetadata_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get iso() {
        const ret = wasm.__wbg_get_orfmetadata_iso(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get orientation() {
        const ret = wasm.__wbg_get_orfmetadata_orientation(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get width() {
        const ret = wasm.__wbg_get_orfmetadata_width(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {string}
     */
    get datetime() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.orfmetadata_datetime(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get lens() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.orfmetadata_lens(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get make() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.orfmetadata_make(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get model() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.orfmetadata_model(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) OrfMetadata.prototype[Symbol.dispose] = OrfMetadata.prototype.free;

export class PerceptualComparer {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PerceptualComparerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_perceptualcomparer_free(ptr, 0);
    }
    /**
     * Copying convenience path: pass RGBA, get {butteraugli, ssim, psnr} as a JS object.
     * @param {Uint8Array} test_rgba
     * @returns {any}
     */
    all(test_rgba) {
        const ptr0 = passArray8ToWasm0(test_rgba, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.perceptualcomparer_all(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Compute all three metrics over the `len` bytes previously written into the
     * staging buffer via `input_ptr`.
     * @param {number} len
     * @returns {any}
     */
    all_at(len) {
        const ret = wasm.perceptualcomparer_all_at(this.__wbg_ptr, len);
        return ret;
    }
    /**
     * @param {Uint8Array} test_rgba
     * @returns {number}
     */
    butteraugli(test_rgba) {
        const ptr0 = passArray8ToWasm0(test_rgba, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.perceptualcomparer_butteraugli(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Zero-copy: returns a pointer into the wasm heap staging buffer of `len`
     * bytes. JS writes the test RGBA straight here (no ArrayBuffer copy across
     * the boundary), then calls `all_at(len)`. Grows the buffer if needed; the
     * returned pointer is valid until the next `input_ptr` call.
     * @param {number} len
     * @returns {number}
     */
    input_ptr(len) {
        const ret = wasm.perceptualcomparer_input_ptr(this.__wbg_ptr, len);
        return ret >>> 0;
    }
    /**
     * @param {Uint8Array} ref_rgba
     * @param {number} width
     * @param {number} height
     */
    constructor(ref_rgba, width, height) {
        const ptr0 = passArray8ToWasm0(ref_rgba, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.perceptualcomparer_new(ptr0, len0, width, height);
        this.__wbg_ptr = ret;
        PerceptualComparerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {Uint8Array} test_rgba
     * @returns {number}
     */
    psnr(test_rgba) {
        const ptr0 = passArray8ToWasm0(test_rgba, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.perceptualcomparer_psnr(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * @param {Uint8Array} test_rgba
     * @returns {number}
     */
    ssim(test_rgba) {
        const ptr0 = passArray8ToWasm0(test_rgba, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.perceptualcomparer_ssim(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
}
if (Symbol.dispose) PerceptualComparer.prototype[Symbol.dispose] = PerceptualComparer.prototype.free;

/**
 * Result of processing an ORF: RGB8 buffer + dims (post-orientation).
 */
export class ProcessResult {
    static __wrap(ptr) {
        const obj = Object.create(ProcessResult.prototype);
        obj.__wbg_ptr = ptr;
        ProcessResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProcessResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_processresult_free(ptr, 0);
    }
    /**
     * Black pedestal subtracted by the pipeline (per-format). The live
     * LookRenderer must use this same value or slider edits revert to the
     * black=0 magenta cast. Olympus = OLYMPUS_BLACK_LEVEL; CR2/DNG = file tag.
     * @returns {number}
     */
    get black_used() {
        const ret = wasm.__wbg_get_processresult_black_used(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {boolean}
     */
    get color_matrix_from_mn() {
        const ret = wasm.__wbg_get_processresult_color_matrix_from_mn(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    get decompress_ms() {
        const ret = wasm.__wbg_get_processresult_decompress_ms(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get demosaic_ms() {
        const ret = wasm.__wbg_get_processresult_demosaic_ms(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get disp16_h() {
        const ret = wasm.__wbg_get_processresult_disp16_h(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get disp16_w() {
        const ret = wasm.__wbg_get_processresult_disp16_w(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get exposure_den() {
        const ret = wasm.__wbg_get_processresult_exposure_den(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get exposure_num() {
        const ret = wasm.__wbg_get_processresult_exposure_num(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {boolean}
     */
    get fast_preview() {
        const ret = wasm.__wbg_get_processresult_fast_preview(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    get fnumber_den() {
        const ret = wasm.__wbg_get_processresult_fnumber_den(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get fnumber_num() {
        const ret = wasm.__wbg_get_processresult_fnumber_num(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get focal_length_35() {
        const ret = wasm.__wbg_get_processresult_focal_length_35(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get focal_length_den() {
        const ret = wasm.__wbg_get_processresult_focal_length_den(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get focal_length_num() {
        const ret = wasm.__wbg_get_processresult_focal_length_num(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get full16_h() {
        const ret = wasm.__wbg_get_processresult_full16_h(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get full16_w() {
        const ret = wasm.__wbg_get_processresult_full16_w(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get gps_alt() {
        const ret = wasm.__wbg_get_processresult_gps_alt(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get gps_lat() {
        const ret = wasm.__wbg_get_processresult_gps_lat(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get gps_lon() {
        const ret = wasm.__wbg_get_processresult_gps_lon(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {boolean}
     */
    get has_gps() {
        const ret = wasm.__wbg_get_processresult_has_gps(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    get height() {
        const ret = wasm.__wbg_get_processresult_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get iso() {
        const ret = wasm.__wbg_get_processresult_iso(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get lb_h() {
        const ret = wasm.__wbg_get_processresult_lb_h(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get lb_w() {
        const ret = wasm.__wbg_get_processresult_lb_w(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get orient_ms() {
        const ret = wasm.__wbg_get_processresult_orient_ms(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get orientation() {
        const ret = wasm.__wbg_get_processresult_orientation(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get preview_demosaic_ms() {
        const ret = wasm.__wbg_get_processresult_preview_demosaic_ms(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get preview_downscale_ms() {
        const ret = wasm.__wbg_get_processresult_preview_downscale_ms(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get quality() {
        const ret = wasm.__wbg_get_processresult_quality(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get thumb_h() {
        const ret = wasm.__wbg_get_processresult_thumb_h(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get thumb_w() {
        const ret = wasm.__wbg_get_processresult_thumb_w(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get tonemap_ms() {
        const ret = wasm.__wbg_get_processresult_tonemap_ms(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get wb_b_used() {
        const ret = wasm.__wbg_get_processresult_wb_b_used(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {boolean}
     */
    get wb_from_camera() {
        const ret = wasm.__wbg_get_processresult_wb_from_camera(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Olympus WhiteBalance2 mode tag (MakerNote 0x0500).
     * `0xFFFF` = absent / unknown — JS callers must check for this sentinel before
     * interpreting the value (e.g. to decide whether to show a WB-mode label).
     * For DNG and CR2 files this field is always `0xFFFF` (no per-shot WB mode tag).
     * @returns {number}
     */
    get wb_mode() {
        const ret = wasm.__wbg_get_processresult_wb_mode(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get wb_r_used() {
        const ret = wasm.__wbg_get_processresult_wb_r_used(this.__wbg_ptr);
        return ret;
    }
    /**
     * White level the pipeline normalised by (per-format: Olympus 4095, CR2/DNG
     * from the file tag ~15300). The live LookRenderer MUST use this same white or
     * the preview blows out — CR2/DNG 14-bit data ÷ the Olympus 4095 default is a
     * ~3.7× over-exposure. Twin of `black_used`.
     * @returns {number}
     */
    get white_used() {
        const ret = wasm.__wbg_get_processresult_white_used(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get width() {
        const ret = wasm.__wbg_get_processresult_width(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Return the color matrix used (9 floats, row-major).
     * @returns {Float32Array}
     */
    color_matrix_used() {
        const ret = wasm.processresult_color_matrix_used(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {string}
     */
    get datetime() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.processresult_datetime(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get lens() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.processresult_lens(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get make() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.processresult_make(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get model() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.processresult_model(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Borrow the RGB buffer; copies into a fresh JS `Uint8Array`.
     * @returns {Uint8Array}
     */
    rgb() {
        const ret = wasm.processresult_rgb(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Borrow the RGBA8 buffer (copies).
     * @returns {Uint8Array}
     */
    rgba() {
        const ret = wasm.processresult_rgba(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * S1 seam: build the lightbox `LookRenderer` directly from the internal packed
     * preview buffer, without round-tripping the bytes out to JS and back into
     * `LookRenderer.new_with_options`. Moves `rgb16_lb` out (empties it, exactly like
     * `take_rgb16_lb`), so the two wasm-bindgen boundary memcpys and the transient JS
     * `Uint8Array` (per decode) are eliminated — the packed bytes never leave wasm linear
     * memory. `apply_rotation=false` matches `makeLiveState`'s Phase-2 wiring;
     * `orientation`/`color_matrix_flat`/`black_used` are read from the same fields the JS
     * path passed back in, so the renderer — and every `render()` output — is byte-identical
     * to the take-then-construct path. Returns an empty-buffer renderer on a second call
     * (ownership transferred, same as `take_rgb16_lb`).
     * @returns {LookRenderer}
     */
    take_lightbox_renderer() {
        const ret = wasm.processresult_take_lightbox_renderer(this.__wbg_ptr);
        return LookRenderer.__wrap(ret);
    }
    /**
     * Move the RGB buffer out as a `Uint8Array`.  Caller owns the bytes.
     * @returns {Uint8Array}
     */
    take_rgb() {
        const ret = wasm.processresult_take_rgb(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Display-referred, oriented, full-res RGB16 (interleaved, [0,65535]). Empty after first call
     * or if OUT_FULL_DISP16 was not requested.
     * @returns {Uint16Array}
     */
    take_rgb16_disp() {
        const ret = wasm.processresult_take_rgb16_disp(this.__wbg_ptr);
        var v1 = getArrayU16FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 2, 2);
        return v1;
    }
    /**
     * Move the full-resolution 16-bit buffer out, packed to LE bytes (M3 16-bit path).
     * Packed 6 bytes per pixel LE (r g b u16). Only non-empty if OUT_FULL_16 was requested.
     * A-5: the master is held as Vec<u16> and packed here (not eagerly during process), so
     * no second full-res buffer coexists with the live rgb16 during tone. Byte-identical to
     * the former eager pack — same pack_rgb16_full over the same pre-unsharp data.
     * @returns {Uint8Array}
     */
    take_rgb16_full() {
        const ret = wasm.processresult_take_rgb16_full(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Move the lightbox-sized packed u16 LE buffer out.  Caller owns the bytes.
     * @returns {Uint8Array}
     */
    take_rgb16_lb() {
        const ret = wasm.processresult_take_rgb16_lb(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Move the thumb-sized packed u16 LE buffer out.  Caller owns the bytes.
     * @returns {Uint8Array}
     */
    take_rgb16_thumb() {
        const ret = wasm.processresult_take_rgb16_thumb(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Move the RGBA8 buffer out. Caller owns the bytes.
     * Performs RGB→RGBA conversion inside WASM using the same tight loop as the
     * JS-facing rgb_to_rgba, then transfers ownership. This still avoids the
     * JS-side 3x buffer allocation that the old take_rgb + rgb_to_rgba pattern
     * required for "encode only" paths.
     * @returns {Uint8Array}
     */
    take_rgba() {
        const ret = wasm.processresult_take_rgba(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * S1 seam twin of [`take_lightbox_renderer`] for the 360 px thumbnail preview.
     * Moves `rgb16_thumb` out; independent of the lightbox buffer, so the two may be
     * called in either order.
     * @returns {LookRenderer}
     */
    take_thumb_renderer() {
        const ret = wasm.processresult_take_thumb_renderer(this.__wbg_ptr);
        return LookRenderer.__wrap(ret);
    }
}
if (Symbol.dispose) ProcessResult.prototype[Symbol.dispose] = ProcessResult.prototype.free;

export class RawStreamExporter {
    static __wrap(ptr) {
        const obj = Object.create(RawStreamExporter.prototype);
        obj.__wbg_ptr = ptr;
        RawStreamExporterFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RawStreamExporterFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rawstreamexporter_free(ptr, 0);
    }
    /**
     * Materialize the RGB8 band `[ypos, ypos+ysize)` and return it tightly packed
     * (stride = width*3 ⇒ ysize*width*3 bytes). Bands MUST be pulled top-to-bottom with
     * monotonic `ypos` and stay within `[0, height)` (the libjxl chunked pull already does),
     * since rows below the request are dropped. wasm-bindgen copies into a JS-owned Uint8Array,
     * so only one band exists at a time on each side.
     * @param {number} ypos
     * @param {number} ysize
     * @returns {Uint8Array}
     */
    band(ypos, ysize) {
        const ret = wasm.rawstreamexporter_band(this.__wbg_ptr, ypos, ysize);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Build from DNG container bytes (comp=7 tiled or comp=1 uncompressed).
     * @param {Uint8Array} bytes
     * @param {number} nr_strength
     * @returns {RawStreamExporter}
     */
    static from_dng(bytes, nr_strength) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rawstreamexporter_from_dng(ptr0, len0, nr_strength);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RawStreamExporter.__wrap(ret[0]);
    }
    /**
     * Build from ORF container bytes. `nr_strength` (0 = off) + `params.texture/clarity` drive
     * the spatial (look-adjusted) band-halo path; all-zero keeps the tone-only fast path.
     * @param {Uint8Array} bytes
     * @param {number} nr_strength
     * @returns {RawStreamExporter}
     */
    static from_orf(bytes, nr_strength) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rawstreamexporter_from_orf(ptr0, len0, nr_strength);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RawStreamExporter.__wrap(ret[0]);
    }
    /**
     * @returns {number}
     */
    get height() {
        const ret = wasm.rawstreamexporter_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get width() {
        const ret = wasm.rawstreamexporter_width(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) RawStreamExporter.prototype[Symbol.dispose] = RawStreamExporter.prototype.free;

/**
 * Rotated RGB8 buffer with updated dimensions.
 */
export class RotateResult {
    static __wrap(ptr) {
        const obj = Object.create(RotateResult.prototype);
        obj.__wbg_ptr = ptr;
        RotateResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RotateResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rotateresult_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get height() {
        const ret = wasm.__wbg_get_rotateresult_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get width() {
        const ret = wasm.__wbg_get_rotateresult_width(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Uint8Array}
     */
    take_rgb() {
        const ret = wasm.rotateresult_take_rgb(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) RotateResult.prototype[Symbol.dispose] = RotateResult.prototype.free;

/**
 * Re-apply tonemap + orientation to a cached lightbox-sized rgb16 buffer.
 *
 * `rgb16_src` is flat RGB16 (3 u16 per pixel, interleaved).  For repeated slider
 * edits prefer `LookRenderer`, which owns the buffer inside WASM and avoids the
 * JS→WASM transfer on each call.
 * `color_matrix_flat` is 9 f32s row-major; pass a slice of len != 9 to use the
 * built-in fallback.
 * @param {Uint16Array} rgb16_src
 * @param {number} width
 * @param {number} height
 * @param {number} orientation
 * @param {number} wb_r
 * @param {number} wb_b
 * @param {Float32Array} color_matrix_flat
 * @param {number} exposure_ev
 * @param {number} contrast
 * @param {number} highlights
 * @param {number} shadows
 * @param {number} whites
 * @param {number} blacks
 * @param {number} saturation
 * @param {number} vibrance
 * @param {number} temp
 * @param {number} tint
 * @param {number} texture
 * @param {number} clarity
 * @returns {Uint8Array}
 */
export function apply_look(rgb16_src, width, height, orientation, wb_r, wb_b, color_matrix_flat, exposure_ev, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, texture, clarity) {
    const ptr0 = passArray16ToWasm0(rgb16_src, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(color_matrix_flat, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.apply_look(ptr0, len0, width, height, orientation, wb_r, wb_b, ptr1, len1, exposure_ev, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, texture, clarity);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * Benchmark ORF decompress + demosaic without tonemap/downscale/orientation.
 * Use to measure decoder cost in isolation when tuning WASM flags or algorithms.
 * @param {Uint8Array} data
 * @returns {DecodeBench}
 */
export function bench_decode_orf(data) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.bench_decode_orf(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return DecodeBench.__wrap(ret[0]);
}

/**
 * Decode an OpenEXR image to RGBA f32 (linear HDR preserved).
 * @param {Uint8Array} bytes
 * @returns {DecodedImage}
 */
export function decode_exr(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decode_exr(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return DecodedImage.__wrap(ret[0]);
}

/**
 * Decode a general RGB(A) TIFF (u8 or u16) to RGBA.
 * @param {Uint8Array} bytes
 * @returns {DecodedImage}
 */
export function decode_tiff(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decode_tiff(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return DecodedImage.__wrap(ret[0]);
}

/**
 * @returns {boolean}
 */
export function demosaic_bench_equal() {
    const ret = wasm.demosaic_bench_equal();
    return ret !== 0;
}

/**
 * @returns {number}
 */
export function demosaic_bench_first_diff() {
    const ret = wasm.demosaic_bench_first_diff();
    return ret;
}

/**
 * @returns {boolean}
 */
export function demosaic_bench_planar_equal() {
    const ret = wasm.demosaic_bench_planar_equal();
    return ret !== 0;
}

/**
 * @returns {number}
 */
export function demosaic_bench_planar_first_diff() {
    const ret = wasm.demosaic_bench_planar_first_diff();
    return ret;
}

/**
 * @returns {number}
 */
export function demosaic_bench_planar_scalar() {
    const ret = wasm.demosaic_bench_planar_scalar();
    return ret >>> 0;
}

/**
 * @returns {number}
 */
export function demosaic_bench_planar_simd() {
    const ret = wasm.demosaic_bench_planar_simd();
    return ret >>> 0;
}

/**
 * @param {number} w
 * @param {number} h
 */
export function demosaic_bench_prepare(w, h) {
    wasm.demosaic_bench_prepare(w, h);
}

/**
 * @returns {number}
 */
export function demosaic_bench_scalar() {
    const ret = wasm.demosaic_bench_scalar();
    return ret >>> 0;
}

/**
 * @returns {boolean}
 */
export function demosaic_bench_shuffle_equal() {
    const ret = wasm.demosaic_bench_shuffle_equal();
    return ret !== 0;
}

/**
 * @returns {number}
 */
export function demosaic_bench_shuffle_first_diff() {
    const ret = wasm.demosaic_bench_shuffle_first_diff();
    return ret;
}

/**
 * @returns {number}
 */
export function demosaic_bench_shuffle_simd() {
    const ret = wasm.demosaic_bench_shuffle_simd();
    return ret >>> 0;
}

/**
 * @returns {number}
 */
export function demosaic_bench_simd() {
    const ret = wasm.demosaic_bench_simd();
    return ret >>> 0;
}

/**
 * Box-filter downscale an RGB8 buffer.  Useful for thumbnail generation.
 *
 * Fast path: when src dims are exact integer multiple of dst (common for 1/2, 1/4, 1/8 thumbs),
 * uses a much faster integer stepping loop with no f32 math or edge cases.
 * @param {Uint8Array} src
 * @param {number} src_w
 * @param {number} src_h
 * @param {number} dst_w
 * @param {number} dst_h
 * @returns {Uint8Array}
 */
export function downscale_rgb(src, src_w, src_h, dst_w, dst_h) {
    const ptr0 = passArray8ToWasm0(src, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.downscale_rgb(ptr0, len0, src_w, src_h, dst_w, dst_h);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Box-filter downscale a 16-bit RGB buffer (u16 interleaved, 3 channels).
 * Returns a `Uint16Array`-compatible `Vec<u16>` from JS.
 * @param {Uint16Array} src
 * @param {number} src_w
 * @param {number} src_h
 * @param {number} dst_w
 * @param {number} dst_h
 * @returns {Uint16Array}
 */
export function downscale_rgb16_pub(src, src_w, src_h, dst_w, dst_h) {
    const ptr0 = passArray16ToWasm0(src, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.downscale_rgb16_pub(ptr0, len0, src_w, src_h, dst_w, dst_h);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU16FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 2, 2);
    return v2;
}

/**
 * Box-filter downscale an RGBA8 buffer.  Useful for thumbnail generation.
 *
 * Fast path: when src dims are exact integer multiple of dst (common for 1/2, 1/4, 1/8 thumbs),
 * uses a much faster integer stepping loop with no f32 math or edge cases.
 * @param {Uint8Array} src
 * @param {number} src_w
 * @param {number} src_h
 * @param {number} dst_w
 * @param {number} dst_h
 * @returns {Uint8Array}
 */
export function downscale_rgba(src, src_w, src_h, dst_w, dst_h) {
    const ptr0 = passArray8ToWasm0(src, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.downscale_rgba(ptr0, len0, src_w, src_h, dst_w, dst_h);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Project the decode peak/retained working set for `width`×`height` (active-area,
 * pre-orientation) pixels and the given `output_flags` bitset (same bits as
 * `process_orf_with_flags` / `process_dng_with_flags`). Pure — allocates nothing
 * beyond the tiny result and touches no image data.
 * @param {number} width
 * @param {number} height
 * @param {number} output_flags
 * @returns {DecodePeakEstimate}
 */
export function estimate_decode_peak(width, height, output_flags) {
    const ret = wasm.estimate_decode_peak(width, height, output_flags);
    return DecodePeakEstimate.__wrap(ret);
}

/**
 * Convenience scalar form: the transient peak-bytes projection only. Matches the
 * `estimate_decode_peak_bytes()` name from the Wave-2 strategic map.
 * @param {number} width
 * @param {number} height
 * @param {number} output_flags
 * @returns {number}
 */
export function estimate_decode_peak_bytes(width, height, output_flags) {
    const ret = wasm.estimate_decode_peak_bytes(width, height, output_flags);
    return ret;
}

/**
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function fable_decode_rgb8(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.fable_decode_rgb8(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * @param {Uint8Array} bytes
 * @param {Uint8Array} prev
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
export function fable_decode_rgb8_delta(bytes, prev, width, height) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(prev, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.fable_decode_rgb8_delta(ptr0, len0, ptr1, len1, width, height);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * @param {Uint8Array} rgb
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
export function fable_encode_rgb8(rgb, width, height) {
    const ptr0 = passArray8ToWasm0(rgb, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.fable_encode_rgb8(ptr0, len0, width, height);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * @param {Uint8Array} cur
 * @param {Uint8Array} prev
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
export function fable_encode_rgb8_delta(cur, prev, width, height) {
    const ptr0 = passArray8ToWasm0(cur, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(prev, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.fable_encode_rgb8_delta(ptr0, len0, ptr1, len1, width, height);
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * PRODUCTION export. Returns the same numeric fields the JS analyzeProgressiveFrame
 * produces (the JS wrapper adds the hex frameHash, byteLength, truncated, validPixels).
 * frameHashInt is the exact FNV-1a value — bit-identical to the shipped JS hash.
 *
 * Uses the hand-v128 word-hash kernel (~4.7x over JS). An audit of every frameHash
 * consumer (web/jxl-single-progressive.js, jxl-progressive-paint.js; nothing in packages/
 * or the cache) confirmed the hash never escapes a single run — it drives only within-run
 * pass-dedup, unique-frame counts, per-session cache keys, and current-run exports, and is
 * always a hex string. So the algorithm is free to change; the 4-lane word-hash is stable
 * and content-sensitive (tail pixels included), which is all those consumers require.
 * frameHashInt therefore differs from the JS FNV value (by design, post-audit).
 * @param {Uint8Array} pixels
 * @param {number} width
 * @param {number} height
 * @returns {any}
 */
export function frame_stats(pixels, width, height) {
    const ptr0 = passArray8ToWasm0(pixels, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.frame_stats(ptr0, len0, width, height);
    return ret;
}

/**
 * Exact byte-FNV kernel over a buffer passed across the boundary (wasm-bindgen copies
 * `pixels` into wasm linear memory on every call). Isolates the copy cost vs resident.
 * @param {Uint8Array} pixels
 * @param {number} width
 * @param {number} height
 * @returns {any}
 */
export function fstats_copy(pixels, width, height) {
    const ptr0 = passArray8ToWasm0(pixels, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.fstats_copy(ptr0, len0, width, height);
    return ret;
}

/**
 * Scan the resident buffer with the fast word-hash + ILP kernel (no per-call copy).
 * @returns {any}
 */
export function fstats_fast() {
    const ret = wasm.fstats_fast();
    return ret;
}

/**
 * Fill the resident buffer with the same LCG byte stream the JS harness uses:
 *   s = s*1103515245 + 12345 (wrapping u32); byte = s & 0xff
 * @param {number} w
 * @param {number} h
 */
export function fstats_prepare(w, h) {
    wasm.fstats_prepare(w, h);
}

/**
 * Scan the resident buffer with the exact byte-FNV kernel (no per-call copy).
 * @returns {any}
 */
export function fstats_scalar() {
    const ret = wasm.fstats_scalar();
    return ret;
}

/**
 * Scan the resident buffer with the hand-written v128 kernel (no per-call copy).
 * @returns {any}
 */
export function fstats_simd() {
    const ret = wasm.fstats_simd();
    return ret;
}

/**
 * Bench probe for the production exact-hash SIMD kernel (resident buffer, no copy).
 * @returns {any}
 */
export function fstats_simd_exact() {
    const ret = wasm.fstats_simd_exact();
    return ret;
}

/**
 * Parse ORF EXIF metadata only — no decompress, no demosaic, no tonemap.
 * Returns camera, lens, exposure, GPS for batch ingest and gallery views.
 * @param {Uint8Array} data
 * @returns {OrfMetadata}
 */
export function parse_orf_metadata(data) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parse_orf_metadata(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return OrfMetadata.__wrap(ret[0]);
}

/**
 * Parse + decode a Canon CR2 file blob.
 *
 * Always generates full RGB8, 1800 px lightbox RGB16, and 360 px thumbnail RGB16.
 * Use `process_cr2_with_flags` to skip unused outputs.
 * @param {Uint8Array} data
 * @param {number} exposure_ev
 * @param {number} contrast
 * @param {number} highlights
 * @param {number} shadows
 * @param {number} whites
 * @param {number} blacks
 * @param {number} saturation
 * @param {number} vibrance
 * @param {number} temp
 * @param {number} tint
 * @param {number} wb_r_override
 * @param {number} wb_b_override
 * @param {number} texture
 * @param {number} clarity
 * @returns {ProcessResult}
 */
export function process_cr2(data, exposure_ev, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, wb_r_override, wb_b_override, texture, clarity) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.process_cr2(ptr0, len0, exposure_ev, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, wb_r_override, wb_b_override, texture, clarity);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ProcessResult.__wrap(ret[0]);
}

/**
 * Variant of `process_cr2` with explicit output flags.
 *
 * `output_flags` bitmask: 1 = full RGB8, 2 = 1800 px lightbox RGB16, 4 = 360 px thumb RGB16, 8 = full RGB16 (M3).
 * Pass `7` for classic; 15 for M3 full16 too.
 * @param {Uint8Array} data
 * @param {number} output_flags
 * @param {number} exposure_ev
 * @param {number} contrast
 * @param {number} highlights
 * @param {number} shadows
 * @param {number} whites
 * @param {number} blacks
 * @param {number} saturation
 * @param {number} vibrance
 * @param {number} temp
 * @param {number} tint
 * @param {number} wb_r_override
 * @param {number} wb_b_override
 * @param {number} texture
 * @param {number} clarity
 * @returns {ProcessResult}
 */
export function process_cr2_with_flags(data, output_flags, exposure_ev, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, wb_r_override, wb_b_override, texture, clarity) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.process_cr2_with_flags(ptr0, len0, output_flags, exposure_ev, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, wb_r_override, wb_b_override, texture, clarity);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ProcessResult.__wrap(ret[0]);
}

/**
 * K6#1: named-object look API for CR2 (see [`process_orf_with_look`]).
 * @param {Uint8Array} data
 * @param {number} output_flags
 * @param {any} look
 * @returns {ProcessResult}
 */
export function process_cr2_with_look(data, output_flags, look) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.process_cr2_with_look(ptr0, len0, output_flags, look);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ProcessResult.__wrap(ret[0]);
}

/**
 * Parse + decode a DNG file blob. Returns an error string on failure.
 * (Rayon when parallel-wasm feature active.) Look params: LR-style (-1..+1), except
 * exposure_ev in stops.  Pass NaN/≤0 for wb_r_override/wb_b_override to use defaults.
 *
 * Always generates full RGB8, 1800 px lightbox RGB16, and 360 px thumbnail RGB16.
 * Use `process_dng_with_flags` to skip unused outputs (e.g. batch JXL encoding
 * only needs full RGB8, not lb/thumb).
 * @param {Uint8Array} data
 * @param {number} exposure_ev
 * @param {number} contrast
 * @param {number} highlights
 * @param {number} shadows
 * @param {number} whites
 * @param {number} blacks
 * @param {number} saturation
 * @param {number} vibrance
 * @param {number} temp
 * @param {number} tint
 * @param {number} wb_r_override
 * @param {number} wb_b_override
 * @param {number} texture
 * @param {number} clarity
 * @returns {ProcessResult}
 */
export function process_dng(data, exposure_ev, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, wb_r_override, wb_b_override, texture, clarity) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.process_dng(ptr0, len0, exposure_ev, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, wb_r_override, wb_b_override, texture, clarity);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ProcessResult.__wrap(ret[0]);
}

/**
 * Variant of `process_dng` with explicit output flags to skip unused pipeline stages.
 *
 * `output_flags` is a bitmask of:
 * - `1`: full-resolution RGB8 (needed for JXL encoding)
 * - `2`: 1800 px lightbox RGB16 cache (needed to construct a `LookRenderer`)
 * - `4`: 360 px thumbnail RGB16 cache (needed to construct a thumb `LookRenderer`)
 *
 * Absent outputs have empty buffers and zero dims in `ProcessResult`.
 * Pass `7` to match the behaviour of `process_dng`.
 * @param {Uint8Array} data
 * @param {number} output_flags
 * @param {number} exposure_ev
 * @param {number} contrast
 * @param {number} highlights
 * @param {number} shadows
 * @param {number} whites
 * @param {number} blacks
 * @param {number} saturation
 * @param {number} vibrance
 * @param {number} temp
 * @param {number} tint
 * @param {number} wb_r_override
 * @param {number} wb_b_override
 * @param {number} texture
 * @param {number} clarity
 * @returns {ProcessResult}
 */
export function process_dng_with_flags(data, output_flags, exposure_ev, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, wb_r_override, wb_b_override, texture, clarity) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.process_dng_with_flags(ptr0, len0, output_flags, exposure_ev, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, wb_r_override, wb_b_override, texture, clarity);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ProcessResult.__wrap(ret[0]);
}

/**
 * K6#1: named-object look API for DNG (see [`process_orf_with_look`]).
 * @param {Uint8Array} data
 * @param {number} output_flags
 * @param {any} look
 * @returns {ProcessResult}
 */
export function process_dng_with_look(data, output_flags, look) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.process_dng_with_look(ptr0, len0, output_flags, look);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ProcessResult.__wrap(ret[0]);
}

/**
 * Parse + decode an ORF file blob.  Returns an error string on failure.
 *
 * All look params are LR-style, zero-centred (-1..+1 normalised), except
 * `exposure_ev` which is in stops.  `wb_r_override` / `wb_b_override`:
 * pass NaN (or ≤0) to use MakerNote / defaults.
 *
 * Always generates full RGB8, 1800 px lightbox RGB16, and 360 px thumbnail RGB16.
 * Use `process_orf_with_flags` to skip unused outputs (e.g. batch JXL encoding
 * only needs full RGB8, not lb/thumb).
 * @param {Uint8Array} data
 * @param {number} exposure_ev
 * @param {number} contrast
 * @param {number} highlights
 * @param {number} shadows
 * @param {number} whites
 * @param {number} blacks
 * @param {number} saturation
 * @param {number} vibrance
 * @param {number} temp
 * @param {number} tint
 * @param {number} wb_r_override
 * @param {number} wb_b_override
 * @param {number} texture
 * @param {number} clarity
 * @returns {ProcessResult}
 */
export function process_orf(data, exposure_ev, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, wb_r_override, wb_b_override, texture, clarity) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.process_orf(ptr0, len0, exposure_ev, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, wb_r_override, wb_b_override, texture, clarity);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ProcessResult.__wrap(ret[0]);
}

/**
 * Variant of `process_orf` with explicit output flags to skip unused pipeline stages.
 *
 * `output_flags` is a bitmask of:
 * - `1` (`OUT_FULL_RGB8`): full-resolution RGB8 (needed for JXL encoding)
 * - `2` (`OUT_LIGHTBOX`): 1800 px lightbox RGB16 cache (needed to construct a `LookRenderer`)
 * - `4` (`OUT_THUMB`): 360 px thumbnail RGB16 cache (needed to construct a thumb `LookRenderer`)
 * - `8` (`OUT_FULL_16`): full-resolution packed u16 LE (6 bytes/pixel) for pyramid big levels
 *   and the 16-bit lightbox/ROI/export path. Grid levels and JPG stay 8-bit.
 * - `16` (`OUT_NO_ORIENT`): skip `apply_orientation` on the RGB8 output. Pixels stay in sensor
 *   orientation; the consumer reads `orientation` to display or encode with JXL basic-info.
 *   Saves the 60–200 MB intermediate rotate when feeding a JXL encoder.
 *   (Note: bit 8 was previously used for `OUT_NO_ORIENT` before `OUT_FULL_16=8` was added;
 *   `OUT_NO_ORIENT` was moved to bit 16 to avoid the collision — commit b2cb8dc9 / 1674aa11.)
 *
 * Absent outputs have empty buffers and zero dims in `ProcessResult`.
 * Pass `7` for classic (no full16). For M3 16-bit big levels pass e.g. 15 (7|8).
 * @param {Uint8Array} data
 * @param {number} output_flags
 * @param {number} exposure_ev
 * @param {number} contrast
 * @param {number} highlights
 * @param {number} shadows
 * @param {number} whites
 * @param {number} blacks
 * @param {number} saturation
 * @param {number} vibrance
 * @param {number} temp
 * @param {number} tint
 * @param {number} wb_r_override
 * @param {number} wb_b_override
 * @param {number} texture
 * @param {number} clarity
 * @returns {ProcessResult}
 */
export function process_orf_with_flags(data, output_flags, exposure_ev, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, wb_r_override, wb_b_override, texture, clarity) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.process_orf_with_flags(ptr0, len0, output_flags, exposure_ev, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, wb_r_override, wb_b_override, texture, clarity);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ProcessResult.__wrap(ret[0]);
}

/**
 * K6#1: named-object look API. `look` is a plain JS object (camelCase fields —
 * see `LookOverrides::from_js`); unknown key → error, missing key → neutral
 * default. Preferred over the 14-positional-arg `process_orf_with_flags`, which
 * remains for back-compat.
 * @param {Uint8Array} data
 * @param {number} output_flags
 * @param {any} look
 * @returns {ProcessResult}
 */
export function process_orf_with_look(data, output_flags, look) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.process_orf_with_look(ptr0, len0, output_flags, look);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ProcessResult.__wrap(ret[0]);
}

/**
 * Convert interleaved RGB16 → RGBA16 (alpha = 0xFFFF). Returns a `Uint16Array`-compatible
 * `Vec<u16>` from JS. Intended as a source buffer for a 16-bit PNG/JXL encoder.
 * Scalar loop: called once per encode (not a hot path); no SIMD twin until it appears in profiles.
 * @param {Uint16Array} rgb
 * @returns {Uint16Array}
 */
export function rgb16_to_rgba16(rgb) {
    const ptr0 = passArray16ToWasm0(rgb, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgb16_to_rgba16(ptr0, len0);
    var v2 = getArrayU16FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 2, 2);
    return v2;
}

/**
 * Convert interleaved RGB8 → RGBA8 (alpha = 255).  HTML canvas wants RGBA.
 * @param {Uint8Array} rgb
 * @returns {Uint8Array}
 */
export function rgb_to_rgba(rgb) {
    const ptr0 = passArray8ToWasm0(rgb, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rgb_to_rgba(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Rotate an RGB8 buffer clockwise by `turns` × 90°  (0=0°, 1=90°, 2=180°, 3=270°).
 * Returns the rotated buffer and new (width, height).
 * @param {Uint8Array} src
 * @param {number} width
 * @param {number} height
 * @param {number} turns
 * @returns {RotateResult}
 */
export function rotate_rgb8(src, width, height, turns) {
    const ptr0 = passArray8ToWasm0(src, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rotate_rgb8(ptr0, len0, width, height, turns);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return RotateResult.__wrap(ret[0]);
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_bce6d499ff0a4aff: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_is_null_2042690d351e14f0: function(arg0) {
            const ret = arg0 === null;
            return ret;
        },
        __wbg___wbindgen_is_undefined_35bb9f4c7fd651d5: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_number_get_f73a1244370fcc2c: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_d109740c0d18f4d7: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_9c31b086c2b26051: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_get_dcf82ab8aad1a593: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_unchecked_1dfe6d05ad91d9b7: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_instanceof_Object_03924e0dbda74bd8: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Object;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Window_faa5cf994f49cca7: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Window;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_WorkerGlobalScope_a93ee1765e6a23bf: function(arg0) {
            let result;
            try {
                result = arg0 instanceof WorkerGlobalScope;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_keys_682010b680c9b1f8: function(arg0) {
            const ret = Object.keys(arg0);
            return ret;
        },
        __wbg_length_2591a0f4f659a55c: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_new_02d162bc6cf02f60: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_now_3cd905700d21a70b: function(arg0) {
            const ret = arg0.now();
            return ret;
        },
        __wbg_now_81363d44c96dd239: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_performance_a22a4e2bf3e69855: function(arg0) {
            const ret = arg0.performance;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_performance_ddd4e7eeef6254f3: function(arg0) {
            const ret = arg0.performance;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_set_a0e911be3da02782: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_static_accessor_GLOBAL_THIS_02344c9b09eb08a9: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_ac6d4ac874d5cd54: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_9b2406c23aeb2023: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_b34d2126934e16ba: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./raw_converter_wasm_bg.js": import0,
    };
}

const DecodeBenchFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_decodebench_free(ptr, 1));
const DecodePeakEstimateFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_decodepeakestimate_free(ptr, 1));
const DecodedImageFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_decodedimage_free(ptr, 1));
const FableDeltaSessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fabledeltasession_free(ptr, 1));
const LookRendererFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_lookrenderer_free(ptr, 1));
const OrfMetadataFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_orfmetadata_free(ptr, 1));
const PerceptualComparerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_perceptualcomparer_free(ptr, 1));
const ProcessResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_processresult_free(ptr, 1));
const RawStreamExporterFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rawstreamexporter_free(ptr, 1));
const RotateResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rotateresult_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU16FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint16ArrayMemory0().subarray(ptr / 2, ptr / 2 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint16ArrayMemory0 = null;
function getUint16ArrayMemory0() {
    if (cachedUint16ArrayMemory0 === null || cachedUint16ArrayMemory0.byteLength === 0) {
        cachedUint16ArrayMemory0 = new Uint16Array(wasm.memory.buffer);
    }
    return cachedUint16ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray16ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 2, 2) >>> 0;
    getUint16ArrayMemory0().set(arg, ptr / 2);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedUint16ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('raw_converter_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
