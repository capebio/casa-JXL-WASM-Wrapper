/* tslint:disable */
/* eslint-disable */

/**
 * Timing results for the decompress + demosaic stages only.
 * Skips tonemap, downscale, and orientation — isolates raw decode cost.
 */
export class DecodeBench {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly decompress_ms: number;
    readonly demosaic_ms: number;
    readonly height: number;
    readonly width: number;
}

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
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly peak_bytes: number;
    readonly pixels: number;
    readonly retained_bytes: number;
}

/**
 * Decoded non-RAW image handed to JS. One of the take_* buffers is non-empty,
 * selected by `bit_depth` (8 -> take_rgba8, 16 -> take_rgba16_le, 32 -> take_rgba_f32).
 */
export class DecodedImage {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * RGBA16 packed little-endian, 8 bytes/px (bit_depth == 16). Empty otherwise.
     */
    take_rgba16_le(): Uint8Array;
    /**
     * RGBA8 (bit_depth == 8). Empty otherwise.
     */
    take_rgba8(): Uint8Array;
    /**
     * RGBA f32 (bit_depth == 32). Returned as Float32Array. Empty otherwise.
     */
    take_rgba_f32(): Float32Array;
    /**
     * Display-ready RGBA8 regardless of source depth (f32 -> linear->sRGB).
     */
    to_display_rgba8(): Uint8Array;
    readonly bit_depth: number;
    readonly height: number;
    readonly width: number;
}

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
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Decode a temporal-delta fable frame against `prev` (the RGB8 this session
     * returned for the previous frame). `w`/`h` are the current frame dims.
     */
    decode_delta(bytes: Uint8Array, prev: Uint8Array, w: number, h: number): Uint8Array;
    /**
     * Decode an intra (keyframe) fable frame; caches its planes for subsequent
     * `decode_delta` calls. Updates `width`/`height`. Returns interleaved RGB8.
     */
    decode_intra(bytes: Uint8Array): Uint8Array;
    constructor();
    readonly height: number;
    readonly width: number;
}

/**
 * Browser (no-sidecar) **FableBraid RAW→CASV video** encoder — the libjxl-free
 * lossless timelapse path. Decode each RAW still in JS (`process_orf`/`process_dng`/
 * `process_cr2` → RGB8), `push_rgb8` them in order, then `finish()` for the `.casv`
 * bytes. Output is byte-identical to the native `casv_encode --raw-frames` fable tier
 * (`raw_pipeline::fable_video` `parity_with_native_streaming` test), so the shipping
 * browser player (casv-web `playFable` + `FableDeltaSession`) plays it unchanged.
 * Uses only the FableBraid codec + the container writer — no libjxl bridge.
 */
export class FableVideoEncoder {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Assemble the `.casv` bytes (consumes the encoder). Errors if no frames pushed.
     */
    finish(): Uint8Array;
    /**
     * Frames pushed so far.
     */
    frame_count(): number;
    /**
     * New encoder: `width`×`height` frames at `fps_num/fps_den`, keyframe every
     * `gop_len` frames (clamped ≥1).
     */
    constructor(width: number, height: number, fps_num: number, fps_den: number, gop_len: number);
    /**
     * Encode + append one RGB8 frame (`len == width*height*3`). I-frame on GOP
     * boundaries, else a P-frame delta vs the previous pushed frame.
     */
    push_rgb8(rgb: Uint8Array): void;
}

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
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Construct from a packed u16-LE buffer (6 bytes per pixel, as returned by
     * `take_rgb16_lb` / `take_rgb16_thumb`), dims, EXIF orientation, and a
     * 9-element row-major colour matrix.  Pass a slice of length != 9 to use
     * the built-in `CAM_TO_SRGB` fallback.
     */
    constructor(rgb16_bytes: Uint8Array, width: number, height: number, orientation: number, color_matrix_flat: Float32Array);
    /**
     * Variant of `new` that lets the caller opt out of CPU rotation in
     * `render()`. When `apply_rotation` is `false`, `render()` returns
     * sensor-orientation RGB8 (same dims as `rgb16` source) and the JS side
     * must apply the EXIF rotation at display time (canvas/CSS transform).
     * Saves a full-buffer transpose per slider tick for non-identity orientations.
     */
    static new_with_options(rgb16_bytes: Uint8Array, width: number, height: number, orientation: number, color_matrix_flat: Float32Array, apply_rotation: boolean, black: number, white: number): LookRenderer;
    /**
     * Apply look parameters and return an RGB8 buffer (post-orientation).
     * Only the output RGB8 crosses the WASM boundary on each call.
     */
    render(wb_r: number, wb_b: number, exposure_ev: number, contrast: number, highlights: number, shadows: number, whites: number, blacks: number, saturation: number, vibrance: number, temp: number, tint: number, texture: number, clarity: number): Uint8Array;
    /**
     * K6#1: named-object look API. `look` is a plain JS object (camelCase fields —
     * see `LookOverrides::from_js`); unknown key → error, missing key → neutral.
     * Preferred over the 14-positional-arg `render`, which remains for back-compat.
     */
    render_look(look: any): Uint8Array;
    readonly native_height: number;
    /**
     * Source-buffer dimensions (sensor orientation, pre-rotation).
     */
    readonly native_width: number;
    /**
     * EXIF orientation tag (1..8) stored at construction. Consumers using
     * `apply_rotation=false` read this to drive display-time rotation.
     */
    readonly orientation: number;
}

/**
 * EXIF metadata extracted without demosaic/tonemap.  Use for gallery thumbnails,
 * batch preflight, and sort-by-date/lens/GPS without a full decode.
 */
export class OrfMetadata {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly gps_lat: number;
    readonly gps_lon: number;
    readonly has_gps: boolean;
    readonly height: number;
    readonly iso: number;
    readonly orientation: number;
    readonly width: number;
    readonly datetime: string;
    readonly lens: string;
    readonly make: string;
    readonly model: string;
}

export class PerceptualComparer {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Copying convenience path: pass RGBA, get {butteraugli, ssim, psnr} as a JS object.
     */
    all(test_rgba: Uint8Array): any;
    /**
     * Compute all three metrics over the `len` bytes previously written into the
     * staging buffer via `input_ptr`.
     */
    all_at(len: number): any;
    butteraugli(test_rgba: Uint8Array): number;
    /**
     * Zero-copy: returns a pointer into the wasm heap staging buffer of `len`
     * bytes. JS writes the test RGBA straight here (no ArrayBuffer copy across
     * the boundary), then calls `all_at(len)`. Grows the buffer if needed; the
     * returned pointer is valid until the next `input_ptr` call.
     */
    input_ptr(len: number): number;
    constructor(ref_rgba: Uint8Array, width: number, height: number);
    psnr(test_rgba: Uint8Array): number;
    ssim(test_rgba: Uint8Array): number;
}

/**
 * Result of processing an ORF: RGB8 buffer + dims (post-orientation).
 */
export class ProcessResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Return the color matrix used (9 floats, row-major).
     */
    color_matrix_used(): Float32Array;
    /**
     * Mode 3 (single-decompress preview-first): finish the full-resolution RGB8
     * output FROM the raw mosaic retained by a phase-1 `OUT_RETAIN_RAW` decode —
     * demosaic + tone (+ optional disp16 / orientation) only, NO second
     * decompress. Byte-identical to a fresh `OUT_FULL_RGB8` decode because both
     * go through `finish_from_raw`. After this returns, `take_rgb()` yields the
     * full RGB8 and `width`/`height`/`orient_ms`/`demosaic_ms`/`tonemap_ms`
     * reflect the full-res render. Errors (JsError) if the result was not
     * produced with `OUT_RETAIN_RAW`. The 14 look args match the trailing
     * arguments of `process_orf_with_flags`, in the same order.
     */
    finish_full_rgb8(output_flags: number, exposure_ev: number, contrast: number, highlights: number, shadows: number, whites: number, blacks: number, saturation: number, vibrance: number, temp: number, tint: number, wb_r: number, wb_b: number, texture: number, clarity: number): void;
    /**
     * Borrow the RGB buffer; copies into a fresh JS `Uint8Array`.
     */
    rgb(): Uint8Array;
    /**
     * Borrow the RGBA8 buffer (copies).
     */
    rgba(): Uint8Array;
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
     */
    take_lightbox_renderer(): LookRenderer;
    /**
     * Move the RGB buffer out as a `Uint8Array`.  Caller owns the bytes.
     */
    take_rgb(): Uint8Array;
    /**
     * Display-referred, oriented, full-res RGB16 (interleaved, [0,65535]). Empty after first call
     * or if OUT_FULL_DISP16 was not requested.
     */
    take_rgb16_disp(): Uint16Array;
    /**
     * Move the full-resolution 16-bit buffer out, packed to LE bytes (M3 16-bit path).
     * Packed 6 bytes per pixel LE (r g b u16). Only non-empty if OUT_FULL_16 was requested.
     * A-5: the master is held as Vec<u16> and packed here (not eagerly during process), so
     * no second full-res buffer coexists with the live rgb16 during tone. Byte-identical to
     * the former eager pack — same pack_rgb16_full over the same pre-unsharp data.
     */
    take_rgb16_full(): Uint8Array;
    /**
     * Move the lightbox-sized packed u16 LE buffer out.  Caller owns the bytes.
     */
    take_rgb16_lb(): Uint8Array;
    /**
     * Move the thumb-sized packed u16 LE buffer out.  Caller owns the bytes.
     */
    take_rgb16_thumb(): Uint8Array;
    /**
     * Move the RGBA8 buffer out. Caller owns the bytes.
     * Performs RGB→RGBA conversion inside WASM using the same tight loop as the
     * JS-facing rgb_to_rgba, then transfers ownership. This still avoids the
     * JS-side 3x buffer allocation that the old take_rgb + rgb_to_rgba pattern
     * required for "encode only" paths.
     */
    take_rgba(): Uint8Array;
    /**
     * S1 seam twin of [`take_lightbox_renderer`] for the 360 px thumbnail preview.
     * Moves `rgb16_thumb` out; independent of the lightbox buffer, so the two may be
     * called in either order.
     */
    take_thumb_renderer(): LookRenderer;
    /**
     * Black pedestal subtracted by the pipeline (per-format). The live
     * LookRenderer must use this same value or slider edits revert to the
     * black=0 magenta cast. Olympus = OLYMPUS_BLACK_LEVEL; CR2/DNG = file tag.
     */
    readonly black_used: number;
    readonly color_matrix_from_mn: boolean;
    readonly decompress_ms: number;
    readonly demosaic_ms: number;
    readonly disp16_h: number;
    readonly disp16_w: number;
    readonly exposure_den: number;
    readonly exposure_num: number;
    readonly fast_preview: boolean;
    readonly fnumber_den: number;
    readonly fnumber_num: number;
    readonly focal_length_35: number;
    readonly focal_length_den: number;
    readonly focal_length_num: number;
    readonly full16_h: number;
    readonly full16_w: number;
    readonly gps_alt: number;
    readonly gps_lat: number;
    readonly gps_lon: number;
    readonly has_gps: boolean;
    readonly height: number;
    readonly iso: number;
    readonly lb_h: number;
    readonly lb_w: number;
    readonly orient_ms: number;
    readonly orientation: number;
    readonly preview_demosaic_ms: number;
    readonly preview_downscale_ms: number;
    readonly quality: number;
    readonly thumb_h: number;
    readonly thumb_w: number;
    readonly tonemap_ms: number;
    readonly wb_b_used: number;
    readonly wb_from_camera: boolean;
    /**
     * Olympus WhiteBalance2 mode tag (MakerNote 0x0500).
     * `0xFFFF` = absent / unknown — JS callers must check for this sentinel before
     * interpreting the value (e.g. to decide whether to show a WB-mode label).
     * For DNG and CR2 files this field is always `0xFFFF` (no per-shot WB mode tag).
     */
    readonly wb_mode: number;
    readonly wb_r_used: number;
    /**
     * White level the pipeline normalised by (per-format: Olympus 4095, CR2/DNG
     * from the file tag ~15300). The live LookRenderer MUST use this same white or
     * the preview blows out — CR2/DNG 14-bit data ÷ the Olympus 4095 default is a
     * ~3.7× over-exposure. Twin of `black_used`.
     */
    readonly white_used: number;
    readonly width: number;
    readonly datetime: string;
    readonly lens: string;
    readonly make: string;
    readonly model: string;
}

export class RawStreamExporter {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Materialize the RGB8 band `[ypos, ypos+ysize)` and return it tightly packed
     * (stride = width*3 ⇒ ysize*width*3 bytes). Bands MUST be pulled top-to-bottom with
     * monotonic `ypos` and stay within `[0, height)` (the libjxl chunked pull already does),
     * since rows below the request are dropped. wasm-bindgen copies into a JS-owned Uint8Array,
     * so only one band exists at a time on each side.
     */
    band(ypos: number, ysize: number): Uint8Array;
    /**
     * Build from DNG container bytes (comp=7 tiled or comp=1 uncompressed).
     */
    static from_dng(bytes: Uint8Array, nr_strength: number): RawStreamExporter;
    /**
     * Build from ORF container bytes. `nr_strength` (0 = off) + `params.texture/clarity` drive
     * the spatial (look-adjusted) band-halo path; all-zero keeps the tone-only fast path.
     */
    static from_orf(bytes: Uint8Array, nr_strength: number): RawStreamExporter;
    readonly height: number;
    readonly width: number;
}

/**
 * Rotated RGB8 buffer with updated dimensions.
 */
export class RotateResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    take_rgb(): Uint8Array;
    readonly height: number;
    readonly width: number;
}

/**
 * Re-apply tonemap + orientation to a cached lightbox-sized rgb16 buffer.
 *
 * `rgb16_src` is flat RGB16 (3 u16 per pixel, interleaved).  For repeated slider
 * edits prefer `LookRenderer`, which owns the buffer inside WASM and avoids the
 * JS→WASM transfer on each call.
 * `color_matrix_flat` is 9 f32s row-major; pass a slice of len != 9 to use the
 * built-in fallback.
 */
export function apply_look(rgb16_src: Uint16Array, width: number, height: number, orientation: number, wb_r: number, wb_b: number, color_matrix_flat: Float32Array, exposure_ev: number, contrast: number, highlights: number, shadows: number, whites: number, blacks: number, saturation: number, vibrance: number, temp: number, tint: number, texture: number, clarity: number): Uint8Array;

/**
 * Benchmark ORF decompress + demosaic without tonemap/downscale/orientation.
 * Use to measure decoder cost in isolation when tuning WASM flags or algorithms.
 */
export function bench_decode_orf(data: Uint8Array): DecodeBench;

/**
 * Decode an OpenEXR image to RGBA f32 (linear HDR preserved).
 */
export function decode_exr(bytes: Uint8Array): DecodedImage;

/**
 * Decode a JPEG to RGBA8 for the developed-image edit path (mirrors
 * `decode_tiff`/`decode_exr`). The lossless archival transcode is a separate
 * facade path (`transcodeJpegToJxl`); this is the editable-pixels decode.
 */
export function decode_jpeg(bytes: Uint8Array): DecodedImage;

/**
 * Decode a general RGB(A) TIFF (u8 or u16) to RGBA.
 */
export function decode_tiff(bytes: Uint8Array): DecodedImage;

export function decompress_bench_byteloop(): number;

export function decompress_bench_equal(): boolean;

export function decompress_bench_prepare(w: number, h: number, seed: number): void;

export function decompress_bench_wide(): number;

export function demosaic_bench_equal(): boolean;

export function demosaic_bench_first_diff(): number;

export function demosaic_bench_planar_equal(): boolean;

export function demosaic_bench_planar_first_diff(): number;

export function demosaic_bench_planar_scalar(): number;

export function demosaic_bench_planar_simd(): number;

export function demosaic_bench_prepare(w: number, h: number): void;

export function demosaic_bench_scalar(): number;

export function demosaic_bench_shuffle_equal(): boolean;

export function demosaic_bench_shuffle_first_diff(): number;

export function demosaic_bench_shuffle_simd(): number;

export function demosaic_bench_simd(): number;

export function demtone_bench_mhc(): number;

export function demtone_bench_prepare(w: number, h: number): void;

export function demtone_bench_tone(): number;

/**
 * Box-filter downscale an RGB8 buffer.  Useful for thumbnail generation.
 *
 * Fast path: when src dims are exact integer multiple of dst (common for 1/2, 1/4, 1/8 thumbs),
 * uses a much faster integer stepping loop with no f32 math or edge cases.
 */
export function downscale_rgb(src: Uint8Array, src_w: number, src_h: number, dst_w: number, dst_h: number): Uint8Array;

/**
 * Box-filter downscale a 16-bit RGB buffer (u16 interleaved, 3 channels).
 * Returns a `Uint16Array`-compatible `Vec<u16>` from JS.
 */
export function downscale_rgb16_pub(src: Uint16Array, src_w: number, src_h: number, dst_w: number, dst_h: number): Uint16Array;

/**
 * Box-filter downscale an RGBA8 buffer.  Useful for thumbnail generation.
 *
 * Fast path: when src dims are exact integer multiple of dst (common for 1/2, 1/4, 1/8 thumbs),
 * uses a much faster integer stepping loop with no f32 math or edge cases.
 */
export function downscale_rgba(src: Uint8Array, src_w: number, src_h: number, dst_w: number, dst_h: number): Uint8Array;

/**
 * Project the decode peak/retained working set for `width`×`height` (active-area,
 * pre-orientation) pixels and the given `output_flags` bitset (same bits as
 * `process_orf_with_flags` / `process_dng_with_flags`). Pure — allocates nothing
 * beyond the tiny result and touches no image data.
 */
export function estimate_decode_peak(width: number, height: number, output_flags: number): DecodePeakEstimate;

/**
 * Convenience scalar form: the transient peak-bytes projection only. Matches the
 * `estimate_decode_peak_bytes()` name from the Wave-2 strategic map.
 */
export function estimate_decode_peak_bytes(width: number, height: number, output_flags: number): number;

export function fable_decode_rgb8(bytes: Uint8Array): Uint8Array;

export function fable_decode_rgb8_delta(bytes: Uint8Array, prev: Uint8Array, width: number, height: number): Uint8Array;

export function fable_encode_rgb8(rgb: Uint8Array, width: number, height: number): Uint8Array;

export function fable_encode_rgb8_delta(cur: Uint8Array, prev: Uint8Array, width: number, height: number): Uint8Array;

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
 */
export function frame_stats(pixels: Uint8Array, width: number, height: number): any;

/**
 * Exact byte-FNV kernel over a buffer passed across the boundary (wasm-bindgen copies
 * `pixels` into wasm linear memory on every call). Isolates the copy cost vs resident.
 */
export function fstats_copy(pixels: Uint8Array, width: number, height: number): any;

/**
 * Scan the resident buffer with the fast word-hash + ILP kernel (no per-call copy).
 */
export function fstats_fast(): any;

/**
 * Fill the resident buffer with the same LCG byte stream the JS harness uses:
 *   s = s*1103515245 + 12345 (wrapping u32); byte = s & 0xff
 */
export function fstats_prepare(w: number, h: number): void;

/**
 * Scan the resident buffer with the exact byte-FNV kernel (no per-call copy).
 */
export function fstats_scalar(): any;

/**
 * Scan the resident buffer with the hand-written v128 kernel (no per-call copy).
 */
export function fstats_simd(): any;

/**
 * Bench probe for the production exact-hash SIMD kernel (resident buffer, no copy).
 */
export function fstats_simd_exact(): any;

export function initThreadPool(num_threads: number): Promise<any>;

/**
 * Parse ORF EXIF metadata only — no decompress, no demosaic, no tonemap.
 * Returns camera, lens, exposure, GPS for batch ingest and gallery views.
 */
export function parse_orf_metadata(data: Uint8Array): OrfMetadata;

export function perc_box_blur_scalar(src: Float32Array, w: number, h: number, r: number): Float32Array;

export function perc_box_blur_simd(src: Float32Array, w: number, h: number, r: number): Float32Array;

export function perc_downsample_scalar(src: Float32Array, w: number, h: number, dw: number, dh: number): Float32Array;

export function perc_downsample_simd(src: Float32Array, w: number, h: number, dw: number, dh: number): Float32Array;

export function perc_scale_err_scalar(mask: Float32Array, rx: Float32Array, ry: Float32Array, rb: Float32Array, tx: Float32Array, ty: Float32Array, tb: Float32Array, n: number, kx: number, ky: number, kb: number): number;

export function perc_scale_err_simd(mask: Float32Array, rx: Float32Array, ry: Float32Array, rb: Float32Array, tx: Float32Array, ty: Float32Array, tb: Float32Array, n: number, kx: number, ky: number, kb: number): number;

export function perc_ssd_scalar(a: Uint8Array, b: Uint8Array): number;

export function perc_ssd_simd(a: Uint8Array, b: Uint8Array): number;

export function perc_ssim_moments_scalar(a: Uint8Array, b: Uint8Array, np: number): Float64Array;

export function perc_ssim_moments_simd(a: Uint8Array, b: Uint8Array, np: number): Float64Array;

export function perc_xyb_scalar(px: Uint8Array, n: number): Float32Array;

export function perc_xyb_simd(px: Uint8Array, n: number): Float32Array;

export function pipeline_bench_equal(): boolean;

export function pipeline_bench_pipelined(): number;

export function pipeline_bench_prepare(w: number, h: number, seed: number): void;

export function pipeline_bench_sequential(): number;

/**
 * Parse + decode a Canon CR2 file blob.
 *
 * Always generates full RGB8, 1800 px lightbox RGB16, and 360 px thumbnail RGB16.
 * Use `process_cr2_with_flags` to skip unused outputs.
 */
export function process_cr2(data: Uint8Array, exposure_ev: number, contrast: number, highlights: number, shadows: number, whites: number, blacks: number, saturation: number, vibrance: number, temp: number, tint: number, wb_r_override: number, wb_b_override: number, texture: number, clarity: number): ProcessResult;

/**
 * Variant of `process_cr2` with explicit output flags.
 *
 * `output_flags` bitmask: 1 = full RGB8, 2 = 1800 px lightbox RGB16, 4 = 360 px thumb RGB16, 8 = full RGB16 (M3).
 * Pass `7` for classic; 15 for M3 full16 too.
 */
export function process_cr2_with_flags(data: Uint8Array, output_flags: number, exposure_ev: number, contrast: number, highlights: number, shadows: number, whites: number, blacks: number, saturation: number, vibrance: number, temp: number, tint: number, wb_r_override: number, wb_b_override: number, texture: number, clarity: number): ProcessResult;

/**
 * K6#1: named-object look API for CR2 (see [`process_orf_with_look`]).
 */
export function process_cr2_with_look(data: Uint8Array, output_flags: number, look: any): ProcessResult;

/**
 * Parse + decode a DNG file blob. Returns an error string on failure.
 * (Rayon when parallel-wasm feature active.) Look params: LR-style (-1..+1), except
 * exposure_ev in stops.  Pass NaN/≤0 for wb_r_override/wb_b_override to use defaults.
 *
 * Always generates full RGB8, 1800 px lightbox RGB16, and 360 px thumbnail RGB16.
 * Use `process_dng_with_flags` to skip unused outputs (e.g. batch JXL encoding
 * only needs full RGB8, not lb/thumb).
 */
export function process_dng(data: Uint8Array, exposure_ev: number, contrast: number, highlights: number, shadows: number, whites: number, blacks: number, saturation: number, vibrance: number, temp: number, tint: number, wb_r_override: number, wb_b_override: number, texture: number, clarity: number): ProcessResult;

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
 */
export function process_dng_with_flags(data: Uint8Array, output_flags: number, exposure_ev: number, contrast: number, highlights: number, shadows: number, whites: number, blacks: number, saturation: number, vibrance: number, temp: number, tint: number, wb_r_override: number, wb_b_override: number, texture: number, clarity: number): ProcessResult;

/**
 * K6#1: named-object look API for DNG (see [`process_orf_with_look`]).
 */
export function process_dng_with_look(data: Uint8Array, output_flags: number, look: any): ProcessResult;

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
 */
export function process_orf(data: Uint8Array, exposure_ev: number, contrast: number, highlights: number, shadows: number, whites: number, blacks: number, saturation: number, vibrance: number, temp: number, tint: number, wb_r_override: number, wb_b_override: number, texture: number, clarity: number): ProcessResult;

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
 */
export function process_orf_with_flags(data: Uint8Array, output_flags: number, exposure_ev: number, contrast: number, highlights: number, shadows: number, whites: number, blacks: number, saturation: number, vibrance: number, temp: number, tint: number, wb_r_override: number, wb_b_override: number, texture: number, clarity: number): ProcessResult;

/**
 * K6#1: named-object look API. `look` is a plain JS object (camelCase fields —
 * see `LookOverrides::from_js`); unknown key → error, missing key → neutral
 * default. Preferred over the 14-positional-arg `process_orf_with_flags`, which
 * remains for back-compat.
 */
export function process_orf_with_look(data: Uint8Array, output_flags: number, look: any): ProcessResult;

export function process_raw_mosaic_with_flags(raw: Uint16Array, width: number, height: number, cfa_phase: number, black: number, white: number, wb_r: number, wb_b: number, orientation: number, color_matrix_flat: Float32Array, output_flags: number, exposure_ev: number, contrast: number, highlights: number, shadows: number, whites: number, blacks: number, saturation: number, vibrance: number, temp: number, tint: number, texture: number, clarity: number): ProcessResult;

/**
 * S6 — decode only a rectangular region of an Olympus ORF file.
 *
 * Parses + decompresses + MHC-demosaics the ORF to full-resolution, pre-tonemapped RGB16
 * in **sensor orientation**, then runs the per-pixel tone/colour pipeline over the rect
 * `[x, x+w) × [y, y+h)` via the native [`raw_pipeline::pipeline::process_region`] at
 * `lod = 1` (native detail). Returns the region as interleaved **RGB8** (`w*h*3` bytes) —
 * matching the native `RegionResult.rgb8` shape (3 channels, not RGBA).
 *
 * The tone/colour stage is per-pixel, so the region is byte-for-byte the crop of the
 * full-frame decode at the same absolute coordinates. Compare against
 * `process_orf_with_flags(bytes, OUT_FULL_RGB8 | OUT_NO_ORIENT, ..neutral)`, which is
 * likewise in sensor orientation and applies a neutral look (no spatial texture/clarity
 * unsharp pre-pass — same as the region path here).
 *
 * Errors (unsupported/corrupt ORF, or a rect outside the frame) are surfaced as a `JsValue`
 * so the caller gets a clean exception instead of a wasm panic/abort.
 */
export function process_region(bytes: Uint8Array, x: number, y: number, w: number, h: number): Uint8Array;

/**
 * Convert interleaved RGB16 → RGBA16 (alpha = 0xFFFF). Returns a `Uint16Array`-compatible
 * `Vec<u16>` from JS. Intended as a source buffer for a 16-bit PNG/JXL encoder.
 * Scalar loop: called once per encode (not a hot path); no SIMD twin until it appears in profiles.
 */
export function rgb16_to_rgba16(rgb: Uint16Array): Uint16Array;

/**
 * Convert interleaved RGB8 → RGBA8 (alpha = 255).  HTML canvas wants RGBA.
 */
export function rgb_to_rgba(rgb: Uint8Array): Uint8Array;

/**
 * Rotate an RGB8 buffer clockwise by `turns` × 90°  (0=0°, 1=90°, 2=180°, 3=270°).
 * Returns the rotated buffer and new (width, height).
 */
export function rotate_rgb8(src: Uint8Array, width: number, height: number, turns: number): RotateResult;

export class wbg_rayon_PoolBuilder {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    build(): void;
    numThreads(): number;
    receiver(): number;
}

export function wbg_rayon_start_worker(receiver: number): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly __wbg_decodebench_free: (a: number, b: number) => void;
    readonly __wbg_decodedimage_free: (a: number, b: number) => void;
    readonly __wbg_fabledeltasession_free: (a: number, b: number) => void;
    readonly __wbg_fablevideoencoder_free: (a: number, b: number) => void;
    readonly __wbg_get_decodebench_decompress_ms: (a: number) => number;
    readonly __wbg_get_decodebench_demosaic_ms: (a: number) => number;
    readonly __wbg_get_decodebench_height: (a: number) => number;
    readonly __wbg_get_decodebench_width: (a: number) => number;
    readonly __wbg_get_decodepeakestimate_peak_bytes: (a: number) => number;
    readonly __wbg_get_orfmetadata_has_gps: (a: number) => number;
    readonly __wbg_get_orfmetadata_iso: (a: number) => number;
    readonly __wbg_get_orfmetadata_orientation: (a: number) => number;
    readonly __wbg_get_processresult_black_used: (a: number) => number;
    readonly __wbg_get_processresult_color_matrix_from_mn: (a: number) => number;
    readonly __wbg_get_processresult_disp16_h: (a: number) => number;
    readonly __wbg_get_processresult_disp16_w: (a: number) => number;
    readonly __wbg_get_processresult_exposure_den: (a: number) => number;
    readonly __wbg_get_processresult_exposure_num: (a: number) => number;
    readonly __wbg_get_processresult_fast_preview: (a: number) => number;
    readonly __wbg_get_processresult_fnumber_den: (a: number) => number;
    readonly __wbg_get_processresult_fnumber_num: (a: number) => number;
    readonly __wbg_get_processresult_focal_length_35: (a: number) => number;
    readonly __wbg_get_processresult_focal_length_den: (a: number) => number;
    readonly __wbg_get_processresult_focal_length_num: (a: number) => number;
    readonly __wbg_get_processresult_full16_h: (a: number) => number;
    readonly __wbg_get_processresult_full16_w: (a: number) => number;
    readonly __wbg_get_processresult_gps_alt: (a: number) => number;
    readonly __wbg_get_processresult_gps_lat: (a: number) => number;
    readonly __wbg_get_processresult_gps_lon: (a: number) => number;
    readonly __wbg_get_processresult_has_gps: (a: number) => number;
    readonly __wbg_get_processresult_height: (a: number) => number;
    readonly __wbg_get_processresult_iso: (a: number) => number;
    readonly __wbg_get_processresult_lb_h: (a: number) => number;
    readonly __wbg_get_processresult_lb_w: (a: number) => number;
    readonly __wbg_get_processresult_orient_ms: (a: number) => number;
    readonly __wbg_get_processresult_orientation: (a: number) => number;
    readonly __wbg_get_processresult_preview_demosaic_ms: (a: number) => number;
    readonly __wbg_get_processresult_preview_downscale_ms: (a: number) => number;
    readonly __wbg_get_processresult_quality: (a: number) => number;
    readonly __wbg_get_processresult_thumb_h: (a: number) => number;
    readonly __wbg_get_processresult_thumb_w: (a: number) => number;
    readonly __wbg_get_processresult_wb_b_used: (a: number) => number;
    readonly __wbg_get_processresult_wb_from_camera: (a: number) => number;
    readonly __wbg_get_processresult_wb_mode: (a: number) => number;
    readonly __wbg_get_processresult_wb_r_used: (a: number) => number;
    readonly __wbg_get_processresult_white_used: (a: number) => number;
    readonly __wbg_get_processresult_width: (a: number) => number;
    readonly __wbg_get_rotateresult_height: (a: number) => number;
    readonly __wbg_get_rotateresult_width: (a: number) => number;
    readonly __wbg_lookrenderer_free: (a: number, b: number) => void;
    readonly __wbg_orfmetadata_free: (a: number, b: number) => void;
    readonly __wbg_perceptualcomparer_free: (a: number, b: number) => void;
    readonly __wbg_processresult_free: (a: number, b: number) => void;
    readonly __wbg_rawstreamexporter_free: (a: number, b: number) => void;
    readonly __wbg_rotateresult_free: (a: number, b: number) => void;
    readonly apply_look: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number) => [number, number, number, number];
    readonly bench_decode_orf: (a: number, b: number) => [number, number, number];
    readonly decode_exr: (a: number, b: number) => [number, number, number];
    readonly decode_jpeg: (a: number, b: number) => [number, number, number];
    readonly decode_tiff: (a: number, b: number) => [number, number, number];
    readonly decodedimage_bit_depth: (a: number) => number;
    readonly decodedimage_height: (a: number) => number;
    readonly decodedimage_take_rgba16_le: (a: number) => [number, number];
    readonly decodedimage_take_rgba8: (a: number) => [number, number];
    readonly decodedimage_take_rgba_f32: (a: number) => [number, number];
    readonly decodedimage_to_display_rgba8: (a: number) => [number, number];
    readonly decodedimage_width: (a: number) => number;
    readonly decompress_bench_byteloop: () => number;
    readonly decompress_bench_equal: () => number;
    readonly decompress_bench_prepare: (a: number, b: number, c: number) => void;
    readonly decompress_bench_wide: () => number;
    readonly demosaic_bench_equal: () => number;
    readonly demosaic_bench_first_diff: () => number;
    readonly demosaic_bench_planar_equal: () => number;
    readonly demosaic_bench_planar_first_diff: () => number;
    readonly demosaic_bench_planar_scalar: () => number;
    readonly demosaic_bench_planar_simd: () => number;
    readonly demosaic_bench_prepare: (a: number, b: number) => void;
    readonly demosaic_bench_scalar: () => number;
    readonly demosaic_bench_shuffle_equal: () => number;
    readonly demosaic_bench_shuffle_first_diff: () => number;
    readonly demosaic_bench_shuffle_simd: () => number;
    readonly demosaic_bench_simd: () => number;
    readonly demtone_bench_mhc: () => number;
    readonly demtone_bench_prepare: (a: number, b: number) => void;
    readonly demtone_bench_tone: () => number;
    readonly downscale_rgb: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly downscale_rgb16_pub: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly downscale_rgba: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly estimate_decode_peak: (a: number, b: number, c: number) => number;
    readonly fable_decode_rgb8: (a: number, b: number) => [number, number, number, number];
    readonly fable_decode_rgb8_delta: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly fable_encode_rgb8: (a: number, b: number, c: number, d: number) => [number, number];
    readonly fable_encode_rgb8_delta: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly fabledeltasession_decode_delta: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly fabledeltasession_decode_intra: (a: number, b: number, c: number) => [number, number, number, number];
    readonly fabledeltasession_height: (a: number) => number;
    readonly fabledeltasession_new: () => number;
    readonly fabledeltasession_width: (a: number) => number;
    readonly fablevideoencoder_finish: (a: number) => [number, number, number, number];
    readonly fablevideoencoder_frame_count: (a: number) => number;
    readonly fablevideoencoder_new: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly fablevideoencoder_push_rgb8: (a: number, b: number, c: number) => [number, number];
    readonly frame_stats: (a: number, b: number, c: number, d: number) => any;
    readonly fstats_copy: (a: number, b: number, c: number, d: number) => any;
    readonly fstats_fast: () => any;
    readonly fstats_prepare: (a: number, b: number) => void;
    readonly fstats_scalar: () => any;
    readonly fstats_simd: () => any;
    readonly fstats_simd_exact: () => any;
    readonly lookrenderer_native_height: (a: number) => number;
    readonly lookrenderer_native_width: (a: number) => number;
    readonly lookrenderer_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly lookrenderer_new_with_options: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number];
    readonly lookrenderer_orientation: (a: number) => number;
    readonly lookrenderer_render: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => [number, number, number, number];
    readonly lookrenderer_render_look: (a: number, b: any) => [number, number, number, number];
    readonly orfmetadata_datetime: (a: number) => [number, number];
    readonly orfmetadata_lens: (a: number) => [number, number];
    readonly orfmetadata_make: (a: number) => [number, number];
    readonly orfmetadata_model: (a: number) => [number, number];
    readonly parse_orf_metadata: (a: number, b: number) => [number, number, number];
    readonly perc_box_blur_scalar: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly perc_box_blur_simd: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly perc_downsample_scalar: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly perc_downsample_simd: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly perc_scale_err_scalar: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number) => number;
    readonly perc_scale_err_simd: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number) => number;
    readonly perc_ssd_scalar: (a: number, b: number, c: number, d: number) => number;
    readonly perc_ssd_simd: (a: number, b: number, c: number, d: number) => number;
    readonly perc_ssim_moments_scalar: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly perc_ssim_moments_simd: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly perc_xyb_scalar: (a: number, b: number, c: number) => [number, number];
    readonly perc_xyb_simd: (a: number, b: number, c: number) => [number, number];
    readonly perceptualcomparer_all: (a: number, b: number, c: number) => any;
    readonly perceptualcomparer_all_at: (a: number, b: number) => any;
    readonly perceptualcomparer_butteraugli: (a: number, b: number, c: number) => number;
    readonly perceptualcomparer_input_ptr: (a: number, b: number) => number;
    readonly perceptualcomparer_new: (a: number, b: number, c: number, d: number) => number;
    readonly perceptualcomparer_psnr: (a: number, b: number, c: number) => number;
    readonly perceptualcomparer_ssim: (a: number, b: number, c: number) => number;
    readonly pipeline_bench_equal: () => number;
    readonly pipeline_bench_pipelined: () => number;
    readonly pipeline_bench_prepare: (a: number, b: number, c: number) => void;
    readonly pipeline_bench_sequential: () => number;
    readonly process_cr2: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => [number, number, number];
    readonly process_cr2_with_flags: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number) => [number, number, number];
    readonly process_cr2_with_look: (a: number, b: number, c: number, d: any) => [number, number, number];
    readonly process_dng: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => [number, number, number];
    readonly process_dng_with_flags: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number) => [number, number, number];
    readonly process_dng_with_look: (a: number, b: number, c: number, d: any) => [number, number, number];
    readonly process_orf: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => [number, number, number];
    readonly process_orf_with_flags: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number) => [number, number, number];
    readonly process_orf_with_look: (a: number, b: number, c: number, d: any) => [number, number, number];
    readonly process_raw_mosaic_with_flags: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number) => [number, number, number];
    readonly process_region: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly processresult_color_matrix_used: (a: number) => [number, number];
    readonly processresult_datetime: (a: number) => [number, number];
    readonly processresult_finish_full_rgb8: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => [number, number];
    readonly processresult_lens: (a: number) => [number, number];
    readonly processresult_make: (a: number) => [number, number];
    readonly processresult_model: (a: number) => [number, number];
    readonly processresult_rgb: (a: number) => [number, number];
    readonly processresult_rgba: (a: number) => [number, number];
    readonly processresult_take_lightbox_renderer: (a: number) => number;
    readonly processresult_take_rgb: (a: number) => [number, number];
    readonly processresult_take_rgb16_disp: (a: number) => [number, number];
    readonly processresult_take_rgb16_full: (a: number) => [number, number];
    readonly processresult_take_rgb16_lb: (a: number) => [number, number];
    readonly processresult_take_rgb16_thumb: (a: number) => [number, number];
    readonly processresult_take_rgba: (a: number) => [number, number];
    readonly processresult_take_thumb_renderer: (a: number) => number;
    readonly rawstreamexporter_band: (a: number, b: number, c: number) => [number, number];
    readonly rawstreamexporter_from_dng: (a: number, b: number, c: number) => [number, number, number];
    readonly rawstreamexporter_from_orf: (a: number, b: number, c: number) => [number, number, number];
    readonly rawstreamexporter_height: (a: number) => number;
    readonly rawstreamexporter_width: (a: number) => number;
    readonly rgb16_to_rgba16: (a: number, b: number) => [number, number];
    readonly rgb_to_rgba: (a: number, b: number) => [number, number];
    readonly rotate_rgb8: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly __wbg_get_decodepeakestimate_pixels: (a: number) => number;
    readonly __wbg_get_decodepeakestimate_retained_bytes: (a: number) => number;
    readonly __wbg_get_orfmetadata_gps_lat: (a: number) => number;
    readonly __wbg_get_orfmetadata_gps_lon: (a: number) => number;
    readonly __wbg_get_orfmetadata_height: (a: number) => number;
    readonly __wbg_get_orfmetadata_width: (a: number) => number;
    readonly __wbg_get_processresult_decompress_ms: (a: number) => number;
    readonly __wbg_get_processresult_demosaic_ms: (a: number) => number;
    readonly __wbg_get_processresult_tonemap_ms: (a: number) => number;
    readonly rotateresult_take_rgb: (a: number) => [number, number];
    readonly __wbg_decodepeakestimate_free: (a: number, b: number) => void;
    readonly estimate_decode_peak_bytes: (a: number, b: number, c: number) => number;
    readonly __wbg_wbg_rayon_poolbuilder_free: (a: number, b: number) => void;
    readonly initThreadPool: (a: number) => any;
    readonly wbg_rayon_poolbuilder_build: (a: number) => void;
    readonly wbg_rayon_poolbuilder_numThreads: (a: number) => number;
    readonly wbg_rayon_poolbuilder_receiver: (a: number) => number;
    readonly wbg_rayon_start_worker: (a: number) => void;
    readonly memory: WebAssembly.Memory;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_thread_destroy: (a?: number, b?: number, c?: number) => void;
    readonly __wbindgen_start: (a: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number }} module - Passing `SyncInitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number } | SyncInitInput, memory?: WebAssembly.Memory): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number }} module_or_path - Passing `InitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number } | InitInput | Promise<InitInput>, memory?: WebAssembly.Memory): Promise<InitOutput>;
