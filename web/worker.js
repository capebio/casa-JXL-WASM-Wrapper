// Per-file Web Worker.
//
// Owns its own wasm instance.  A pool of these runs in the main thread so N
// files convert concurrently across N CPU cores.  JXL encoding is offloaded
// to a separate pool of jxl-worker.js instances (SIMD+MT, spawned from the
// main thread so Emscripten Pthreads bootstrap correctly under COOP/COEP).
//
// Protocol — main thread posts (type strings centralized in
// ./worker-message-types.js as WorkerMsg.*):
//   { id, bytes: Uint8Array, options }
//   { id, type: 'reprocess_live', look }
//   { type: 'reprocess_thumb_live', taskIds: [], look }
//   { id, type: 'release_state' } | { id, type: 'cancel' }
//
// Worker posts (in order, transferring buffers where safe):
//   { id, type: 'thumb',         rgb, w, h, pipelineMs, phaseMs, wbR, wbB, ... }
//   { id, type: 'lightbox',      rgb, w, h }
//   { id, type: 'encode_request', pixels, width, height, ..., pipelineMs?, phaseMs? }
//   { id, type: 'lightbox_live', rgb, w, h, liveMs }
//   { id, type: 'thumb_live',    rgb, w, h }  (one per taskId in batch)
//   { id, type: 'done',          jxl, jxlMs, w, h }
//   { id, type: 'error',         error }
//
// TTFP-4 two-phase RAW split (ORF/DNG): thumb + lightbox post after a
// previews-only WASM call (streaming fast path), encode_request after a second
// full-res call. encode_request carries the split task's summed pipelineMs /
// phaseMs (both phases); on the monolithic paths (CR2, EXR/TIFF) those fields
// are absent and the THUMB-time values remain authoritative. The main thread
// releases the worker slot on encode_request, not lightbox.

// WASM build selection. Only the threaded build (./pkg/) is shipped; it hard-codes
// shared memory and needs SharedArrayBuffer + crossOriginIsolated (COOP/COEP) to
// instantiate. A single-thread fallback (./pkg-st/) is NOT built, so we import ./pkg/
// unconditionally rather than a nonexistent path (which 404'd on non-isolated hosts).
// On a non-isolated host pkg/ will fail to instantiate with a clear WASM/SAB error; we
// warn up front. If a ./pkg-st/ build is ever produced, restore the COI-gated branch.
// Bound lazily in ensureWasm(), before any message handler touches these bindings.
import { detectFormat, detectRawKind } from './format-detect.js';
import { tryDecodeHandRaw } from './hand-raw-decoders.js';
import { decodeWithLibRaw } from './libraw-decode.js';
import { WorkerMsg } from './worker-message-types.js';

// Relay this worker's console to the main thread's on-page console (debug aid).
for (const __k of ['log', 'warn', 'error']) {
    const __orig = console[__k].bind(console);
    console[__k] = (...a) => {
        __orig(...a);
        try {
            const s = a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
            self.postMessage({ type: 'wlog', text: '[' + __k + '] ' + s });
        } catch { /* non-cloneable arg — skip relay */ }
    };
}

let init, rawWasm;
// A3: rgb_to_rgba removed — send RGB8 directly to JXL worker (saves ~250ms + 25% transfer)
let process_orf, process_orf_with_flags, process_cr2_with_flags, process_dng_with_flags, process_raw_mosaic_with_flags, LookRenderer, rotate_rgb8;
// K6#1: named-field look API (preferred over the positional *_with_flags forms).
let process_orf_with_look, process_dng_with_look, process_cr2_with_look;
// Task 7: options API — carries {look, denoise} so the RAW pipeline can apply
// noise-aware denoise before demosaic. Preferred over *_with_flags when present.
let process_orf_with_options, process_dng_with_options, process_cr2_with_options, process_raw_mosaic_with_options;
// Task 8: tiled denoise session API (create_*_denoise_session exports).
let create_orf_denoise_session, create_dng_denoise_session, create_cr2_denoise_session, create_raw_mosaic_denoise_session;
// Multi-format ingest: EXR/TIFF decode to a DecodedImage (mirrors jxl-benchmark.js bindings).
let decode_exr, decode_tiff;
async function loadWasm() {
    const isolated = (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated)
        && typeof SharedArrayBuffer !== 'undefined';
    if (!isolated) {
        console.warn('[worker] not cross-origin-isolated (COOP/COEP); the threaded WASM build ' +
            'may fail to instantiate and no single-thread (pkg-st) build is shipped.');
    }
    rawWasm = await import('./pkg/raw_converter_wasm.js');
    init = rawWasm.default;
    ({ process_orf, process_orf_with_flags, process_cr2_with_flags, process_dng_with_flags, process_raw_mosaic_with_flags, LookRenderer, rotate_rgb8,
       process_orf_with_look, process_dng_with_look, process_cr2_with_look,
       process_orf_with_options, process_dng_with_options, process_cr2_with_options, process_raw_mosaic_with_options,
       create_orf_denoise_session, create_dng_denoise_session, create_cr2_denoise_session, create_raw_mosaic_denoise_session,
       decode_exr, decode_tiff, decode_jpeg } = rawWasm);
}

// Route a RAW buffer to its WASM decoder via the SINGLE-SOURCE sniffer in
// format-detect.js (detectRawKind) — the worker no longer re-implements its own
// magic table. Olympus ORF / Canon CR2 / Adobe-DNG-family TIFF map to their
// decoders; Sony ARW / Nikon NEF / Panasonic RW2 (no WASM decoder) and any
// unrecognized magic raise a LOUD error instead of being silently misrouted to
// the ORF/DNG decoder (K1 decode_raw contract: never guess a decoder). The throw
// is caught by the decode handler's try/catch and surfaced as a WorkerMsg.ERROR.
function pickRawDecoderWithFlags(bytes, name = '') {
  const kind = detectRawKind(bytes, name);
  switch (kind) {
    case 'orf': return process_orf_with_flags;
    case 'cr2': return process_cr2_with_flags;
    case 'dng': return process_dng_with_flags;
    case 'unsupported':
      throw new Error(
        `Unsupported RAW format: ${basename(name)} — Sony ARW / Nikon NEF / ` +
        `Panasonic RW2 are not yet supported by the WASM RAW decoder.`);
    default: // 'unknown'
      throw new Error(
        `Unrecognized RAW file: ${basename(name)} — no matching decoder for its magic bytes.`);
  }
}

function basename(name) {
  return (name && name.split(/[\\/]/).pop()) || name || 'file';
}

// Named-options wrapper over the positional *_with_flags WASM signature.
// Mirrors processOrfNamed/ORF_NEUTRAL in jxl-benchmark.js, but for the
// 16-arg flags-carrying decoders (process_orf_with_flags /
// process_cr2_with_flags / process_dng_with_flags). Behaviour is identical —
// it just maps a named object onto the bare positional literals so the live
// decode call site is readable and the argument order is checked in one place.
//
// TODO: migrate callers to process_orf_with_look / process_dng_with_look /
//       process_cr2_with_look (K6#1) — pass (bytes, flags, lookObj) where
//       lookObj = {wbR, wbB, exposureEv, ...}. Keep this wrapper for back-compat.
//
// Positional order (MUST match src/lib.rs):
//   (bytes, flags, exposureEv, contrast, highlights, shadows, whites, blacks,
//    saturation, vibrance, temp, tint, wbR, wbB, texture, clarity)
const RAW_NEUTRAL = {
    exposureEv: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
    saturation: 0, vibrance: 0, temp: 0, tint: 0,
    wbR: NaN, wbB: NaN, texture: 0, clarity: 0,
};
function processRawWithFlagsNamed(decoderFn, bytes, flags, opts = RAW_NEUTRAL) {
    const o = { ...RAW_NEUTRAL, ...opts };
    return decoderFn(
        bytes, flags,
        o.exposureEv, o.contrast, o.highlights, o.shadows, o.whites, o.blacks,
        o.saturation, o.vibrance, o.temp, o.tint, o.wbR, o.wbB, o.texture, o.clarity,
    );
}

function processRawMosaicWithFlagsNamed(payload, flags, opts = RAW_NEUTRAL) {
    const o = { ...RAW_NEUTRAL, ...opts };
    return process_raw_mosaic_with_flags(
        payload.raw, payload.width, payload.height, payload.cfaPhase,
        payload.black, payload.white, payload.wbR, payload.wbB,
        payload.orientation, new Float32Array(payload.colorMatrix || []), flags,
        o.exposureEv, o.contrast, o.highlights, o.shadows, o.whites, o.blacks,
        o.saturation, o.vibrance, o.temp, o.tint, o.texture, o.clarity,
    );
}

// Task 7: build the {look, denoise} options object the *_with_options WASM APIs
// consume. `look` uses the named LookOverrides field names (LookOverrides::from_js
// — exposureEv, contrast, …, wbR, wbB, texture, clarity), i.e. the same lookArgs
// object the positional wrappers spread. `denoise` is the normalized canonical
// shape from raw-denoise-options.js; default {enabled:false} = pipeline no-op.
function buildWasmOptions(lookArgs, denoise) {
    return { look: lookArgs, denoise: denoise || { enabled: false } };
}

// Task 11: Lazy ORT WebGPU denoise runtime (one per worker).
// Null until first learned-denoise request; remains set for the worker lifetime.
let denoiseRuntime = null;
// Set to true if runtime init fails so we don't retry on every frame.
let denoiseRuntimeFailed = false;

async function getDenoiseRuntime() {
    if (denoiseRuntime) return denoiseRuntime;
    if (denoiseRuntimeFailed) return null;
    try {
        const { createRawDenoiseRuntime } = await import('./raw-denoise-runtime.js');
        const ort = await import('onnxruntime-web/webgpu');
        denoiseRuntime = await createRawDenoiseRuntime({
            ort,
            modelUrl: new URL('./models/raw-denoise-v1.ort', self.location.href).href,
            manifestUrl: new URL('./models/raw-denoise-v1.json', self.location.href).href,
        });
        return denoiseRuntime;
    } catch (err) {
        console.warn('[worker] denoise runtime init failed, will use classical path:', err?.message || err);
        denoiseRuntimeFailed = true;
        return null;
    }
}

// Pick the session-create function for a rawKind, or null if not available.
function pickDenoiseSessionCreator(rawKind) {
    switch (rawKind) {
        case 'orf': return create_orf_denoise_session || null;
        case 'cr2': return create_cr2_denoise_session || null;
        case 'dng': return create_dng_denoise_session || null;
        default: return null;
    }
}

// Run the learned denoise path for a native RAW format.
// Returns the ProcessResult from finish_with_options (learned) or finish_classical (fallback).
// Also returns backend/modelVersion/denoiseMs for surfacing in diagnostics.
async function decodeWithLearnedDenoise(createSessionFn, bytes, wasmOptions, signal) {
    let session;
    try {
        session = createSessionFn(bytes, wasmOptions);
        const runtime = await getDenoiseRuntime();
        if (!runtime) {
            // Runtime init failed — use classical path
            const result = session.finish_classical(wasmOptions);
            return { result, denoiseBackend: 'classical', modelVersion: 'classical-bm3d-v1', denoiseMs: 0 };
        }
        const { backend, modelVersion, inferenceMs } = await runtime.run(session, wasmOptions, signal);
        const result = session.finish_with_options(wasmOptions);
        return { result, denoiseBackend: backend, modelVersion, denoiseMs: inferenceMs };
    } catch (err) {
        // Any failure (inference error, device loss, abort) → classical fallback
        if (session) {
            try {
                const result = session.finish_classical(wasmOptions);
                return { result, denoiseBackend: 'classical', modelVersion: 'classical-bm3d-v1', denoiseMs: 0 };
            } catch (fallbackErr) {
                console.warn('[worker] denoise classical fallback also failed:', fallbackErr?.message || fallbackErr);
            }
        }
        throw err;
    }
}

// Pick the native *_with_options decoder for a rawKind (orf/cr2/dng), or null if
// the options API is not present in this WASM build (fall back to *_with_flags).
function pickRawDecoderWithOptions(rawKind) {
    switch (rawKind) {
        case 'orf': return process_orf_with_options || null;
        case 'cr2': return process_cr2_with_options || null;
        case 'dng': return process_dng_with_options || null;
        default: return null;
    }
}

// EXIF orientation flag bits (mirror src/lib.rs).
// NOTE: bit 8 is OUT_FULL_16 (full-res RGB16). OUT_NO_ORIENT is bit 16 — it was
// split off the 8 collision in b08c0d31 and the shipped web/pkg checks bit 16.
// This worker was the lone caller left at the stale 8 (all tests + asset-store
// already use 16), so every full-res export was silently retaining the ~120 MB
// RGB16 master (bit 8 = FULL_16) AND running apply_orientation instead of skipping
// it — double-rotating portrait (EXIF 3/6/8) files. Keep in lock-step with lib.rs.
const OUT_FULL_RGB8 = 1;
const OUT_LIGHTBOX  = 2;
const OUT_THUMB     = 4;
const OUT_NO_ORIENT = 16;
// Mode 3: retain the phase-1 raw mosaic so a later result.finish_full_rgb8()
// produces the full RGB8 WITHOUT a second decompress (mirror src/lib.rs bit 64).
const OUT_RETAIN_RAW = 64;

// Compose EXIF orientation tag (1..8) with N additional CW quarter-turns.
// Only handles the cycle {1, 6, 3, 8} that maps to pure rotations — Olympus
// ORFs never produce 2/4/5/7 (mirror variants). Returns the original tag
// unchanged for those edge cases (caller still gets a correct image since
// JXL will record the mirror; userTurns just doesn't compose with mirrors).
function composeOrientation(exifOri, cwTurns) {
    const cycle = [1, 6, 3, 8];          // 0°, 90° CW, 180°, 270° CW
    const idx = cycle.indexOf(exifOri);
    if (idx < 0) return exifOri;          // mirror variants — pass through
    return cycle[(idx + (cwTurns & 3)) & 3];
}

// JXL encoding is handled by jxl-worker.js (spawned from the main thread).

let wasmReady;
// Per-taskId state maps — survive across multiple files on this worker.
const liveStateMap  = new Map(); // taskId → {renderer: LookRenderer, outW, outH, wbR, wbB}
const thumbStateMap = new Map(); // taskId → same shape but thumb-sized LookRenderer
// Tasks the main thread has cancelled (lightbox closed / card removed). The
// synchronous WASM decode (process_*_with_flags) cannot be interrupted mid-call,
// so cancel is best-effort *between* messages: we free cached renderer state and
// skip emitting further output for the cancelled task. Bounded by the number of
// live tasks; entries are cleared as soon as they are consumed.
const cancelledTasks = new Set();

async function ensureWasm() {
    if (!wasmReady) wasmReady = (async () => {
        await loadWasm();
        await init();
        // A2: init rayon thread pool when parallel-wasm feature is compiled in.
        // Guard: shared memory requires crossOriginIsolated (COOP/COEP). Falls
        // back silently to single-threaded WASM if the context is not isolated
        // or the browser rejects the memory transfer (e.g. nested worker COI gap).
        if (typeof rawWasm.initThreadPool === 'function') {
            if (self.__disableThreadPool) {
                console.log('[worker] thread pool disabled (test mode)');
            } else if (crossOriginIsolated) {
                try {
                    // Calibrated per-worker thread count avoids the workers×HC
                    // oversubscription (up to 144 threads on a 12-core box). The main
                    // thread posts `self.__calibratedThreads` from the persisted
                    // profile (web/calibration/profile.mjs) before init; absent it we
                    // keep today's HC default. See docs calibration §Phase 6.
                    const __calThreads = Math.max(0, self.__calibratedThreads | 0);
                    const __threads = __calThreads >= 1
                        ? __calThreads
                        : Math.max(1, navigator.hardwareConcurrency || 4);
                    await rawWasm.initThreadPool(__threads);
                } catch (e) {
                    console.warn('[worker] rayon thread pool init failed, using single-thread WASM:', e.message);
                }
            } else {
                console.warn('[worker] crossOriginIsolated=false — skipping rayon thread pool');
            }
        }
    })();
    try {
        await wasmReady;
    } catch (err) {
        wasmReady = null;
        throw err;
    }
}

// makeLiveState constructs a LookRenderer (WASM-resident) from packed rgb16 bytes.
// The renderer owns the RGB16 buffer inside WASM; subsequent render() calls
// transfer only the output RGB8, not the cached buffer.
//
// Phase 2: construct with apply_rotation=false. render() returns sensor-orient
// pixels with sensor dims. Main thread applies EXIF rotation as a canvas
// transform during draw — GPU-accelerated, decoupled from slider tick rate.
function makeLiveState(rgb16Bytes, w, h, orientation, wbR, wbB, colorMatrix, black, white) {
    // Only orientations 6 (90° CW) and 8 (90° CCW) actually swap axes in
    // apply_orientation (pipeline.rs).  Tags 5/7 are pass-through there, so
    // using orientation >= 5 overreports axisSwap and mis-sizes the canvas.
    const axisSwap = orientation === 6 || orientation === 8;
    // black: per-format pedestal (Olympus 256, CR2/DNG from file) so live slider
    // edits subtract the same black as the initial decode — no magenta on drag.
    // white: per-format white level (CR2/DNG ~15300, else 0 → keep the Olympus
    // 4095 default) so the live preview normalises by the same white the decode
    // used — without it CR2/DNG 14-bit data blows out ~3.7×.
    const renderer = LookRenderer.new_with_options(rgb16Bytes, w, h, orientation, colorMatrix, false, black >>> 0, (white >>> 0) || 0);
    return {
        renderer,
        // Native source dims (sensor orientation).
        nativeW: w,
        nativeH: h,
        // Display dims after rotation (what the canvas should be sized to).
        outW: axisSwap ? h : w,
        outH: axisSwap ? w : h,
        orientation,
        wbR, wbB,
    };
}

// makeLiveStateFromRenderer wraps a LookRenderer that was built INSIDE wasm by
// ProcessResult.take_lightbox_renderer / take_thumb_renderer. The packed rgb16
// bytes never cross the wasm boundary, so this skips the take-bytes → JS
// Uint8Array → new_with_options round-trip that makeLiveState performs (S1 seam).
// The returned wrapper shape is identical to makeLiveState's; only the two FFI
// boundary copies + a transient JS Uint8Array (per decode) are eliminated.
function makeLiveStateFromRenderer(renderer, w, h, orientation, wbR, wbB) {
    const axisSwap = orientation === 6 || orientation === 8;
    return {
        renderer,
        nativeW: w,
        nativeH: h,
        outW: axisSwap ? h : w,
        outH: axisSwap ? w : h,
        orientation,
        wbR, wbB,
    };
}

// ---------------------------------------------------------------------------
// Multi-format (EXR / TIFF) ingest helpers.
//
// EXR/TIFF pixels arrive as RGBA (linear f32 for EXR, gamma-encoded sRGB u8/u16
// for TIFF). The shared live-edit engine (LookRenderer) expects a *linear*,
// interleaved, packed RGB16-LE buffer (6 bytes/px, no alpha) — the same format
// the RAW pipeline feeds it — because render() applies the sRGB OETF + tonemap
// internally. So we drop alpha and convert each source to linear RGB16 here.
// An identity colour matrix (length != 9 → LookRenderer falls back to its
// built-in CAM_TO_SRGB; we instead pass identity so the matrix is a no-op) and
// black=0 keep look=0 close to the clean to_display_rgba8 preview.
const IDENTITY_CM = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

// sRGB EOTF (gamma-encoded → linear), 256-entry LUT for u8 TIFF.
const SRGB_TO_LINEAR_U8 = (() => {
    const t = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
        const c = i / 255;
        t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    return t;
})();
function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Build full-res linear packed RGB16-LE (6 bytes/px) from a DecodedImage.
// bit_depth: 8 → RGBA8 sRGB, 16 → RGBA16-LE sRGB, 32 → RGBA f32 linear.
function decodedToLinearRgb16(dec) {
    const w = dec.width, h = dec.height;
    const px = w * h;
    const out = new Uint8Array(px * 6);
    const dv = new DataView(out.buffer);
    const enc = (o, r, g, b) => {
        dv.setUint16(o,     r, true);
        dv.setUint16(o + 2, g, true);
        dv.setUint16(o + 4, b, true);
    };
    const clamp16 = (v) => (v < 0 ? 0 : v > 65535 ? 65535 : v) | 0;
    if (dec.bit_depth === 32) {
        const f = dec.take_rgba_f32(); // RGBA, linear
        for (let i = 0, o = 0; i < px; i++, o += 6) {
            const s = i * 4;
            enc(o, clamp16(f[s] * 65535 + 0.5), clamp16(f[s + 1] * 65535 + 0.5), clamp16(f[s + 2] * 65535 + 0.5));
        }
    } else if (dec.bit_depth === 16) {
        const u = dec.take_rgba16_le(); // RGBA16-LE, gamma sRGB
        const src = new DataView(u.buffer, u.byteOffset, u.byteLength);
        for (let i = 0, o = 0; i < px; i++, o += 6) {
            const s = i * 8;
            const r = srgbToLinear(src.getUint16(s, true) / 65535);
            const g = srgbToLinear(src.getUint16(s + 2, true) / 65535);
            const b = srgbToLinear(src.getUint16(s + 4, true) / 65535);
            enc(o, clamp16(r * 65535 + 0.5), clamp16(g * 65535 + 0.5), clamp16(b * 65535 + 0.5));
        }
    } else {
        const u = dec.take_rgba8(); // RGBA8, gamma sRGB
        for (let i = 0, o = 0; i < px; i++, o += 6) {
            const s = i * 4;
            enc(o, clamp16(SRGB_TO_LINEAR_U8[u[s]] * 65535 + 0.5),
                   clamp16(SRGB_TO_LINEAR_U8[u[s + 1]] * 65535 + 0.5),
                   clamp16(SRGB_TO_LINEAR_U8[u[s + 2]] * 65535 + 0.5));
        }
    }
    return out;
}

// target_dims mirror of src/lib.rs: long-edge clamp, aspect-preserving, no upscale.
function targetDims(w, h, longEdge) {
    if (w >= h) { const lw = Math.min(w, longEdge); return [lw, Math.max(1, Math.floor((h * lw) / w))]; }
    const lh = Math.min(h, longEdge); return [Math.max(1, Math.floor((w * lh) / h)), lh];
}

// Box-filter downscale of packed RGB16-LE (mirrors downscale_rgb16_impl in lib.rs).
function downscaleRgb16LE(src, sw, sh, dw, dh) {
    if (dw === sw && dh === sh) return src;
    const out = new Uint8Array(dw * dh * 6);
    const sv = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const ov = new DataView(out.buffer);
    for (let dy = 0; dy < dh; dy++) {
        const sy0 = Math.floor((dy * sh) / dh);
        const sy1 = Math.max(sy0 + 1, Math.floor(((dy + 1) * sh) / dh));
        for (let dx = 0; dx < dw; dx++) {
            const sx0 = Math.floor((dx * sw) / dw);
            const sx1 = Math.max(sx0 + 1, Math.floor(((dx + 1) * sw) / dw));
            let rr = 0, gg = 0, bb = 0, n = 0;
            for (let sy = sy0; sy < sy1; sy++) {
                let so = (sy * sw + sx0) * 6;
                for (let sx = sx0; sx < sx1; sx++, so += 6) {
                    rr += sv.getUint16(so, true);
                    gg += sv.getUint16(so + 2, true);
                    bb += sv.getUint16(so + 4, true);
                    n++;
                }
            }
            const o = (dy * dw + dx) * 6;
            ov.setUint16(o,     (rr / n) | 0, true);
            ov.setUint16(o + 2, (gg / n) | 0, true);
            ov.setUint16(o + 4, (bb / n) | 0, true);
        }
    }
    return out;
}

// makeLiveState for an EXR/TIFF buffer: identity matrix, no EXIF orientation,
// black=0. Otherwise identical shape to the RAW makeLiveState above.
function makeImageLiveState(rgb16Bytes, w, h) {
    const renderer = LookRenderer.new_with_options(rgb16Bytes, w, h, 1, IDENTITY_CM, false, 0, 0);
    return { renderer, nativeW: w, nativeH: h, outW: w, outH: h, orientation: 1, wbR: NaN, wbB: NaN };
}

// Decode + emit thumb/lightbox/live-edit/encode for an EXR, TIFF or JPEG file.
// Posts the SAME message shapes as the RAW path so main.js needs no new handler.
function processImageFormat(id, bytes, opts, look, route) {
    const pT0 = performance.now();
    const dec = route === 'exr' ? decode_exr(bytes)
              : route === 'jpeg' ? decode_jpeg(bytes)
              : decode_tiff(bytes);
    try {
        const w = dec.width, h = dec.height;
        const bitDepth = dec.bit_depth;
        // Full-res linear RGB16 → drives encode (full LookRenderer) + preview downscales.
        const fullRgb16 = decodedToLinearRgb16(dec);
        const pipelineMs = performance.now() - pT0;

        const [lbW, lbH] = targetDims(w, h, 1800);
        const [thW, thH] = targetDims(w, h, 360);
        const lbRgb16   = downscaleRgb16LE(fullRgb16, w, h, lbW, lbH);
        const thRgb16   = downscaleRgb16LE(fullRgb16, w, h, thW, thH);

        // Cache live-edit renderers (same maps the RAW path + reprocess uses).
        liveStateMap.set(id, makeImageLiveState(lbRgb16, lbW, lbH));
        thumbStateMap.set(id, makeImageLiveState(thRgb16, thW, thH));

        // Minimal EXIF blob — non-RAW files carry no camera metadata here.
        const exif = { make: null, model: null, lens: null, datetime: null,
            exposure: null, fnumber: null, focalLength: null, focalLength35: null,
            iso: null, orientation: 1, gps: null, quality: null, wbMode: null,
            wbR: NaN, wbB: NaN, wbFromCamera: false, width: w, height: h,
            format: route.toUpperCase(), bitDepth };

        // thumb
        const thumbState = thumbStateMap.get(id);
        const thumbRgb = applyLookToState(thumbState, look);
        self.postMessage(
            { id, type: WorkerMsg.THUMB, rgb: thumbRgb,
              w: thumbState.outW, h: thumbState.outH,
              nativeW: thumbState.nativeW, nativeH: thumbState.nativeH,
              orientation: 1,
              pipelineMs, phaseMs: { decompress: pipelineMs, demosaic: 0, tonemap: 0, orient: 0 },
              wbR: NaN, wbB: NaN, make: null, model: null, colorMatrixFromMn: false, exif },
            [thumbRgb.buffer],
        );

        // lightbox
        const lbState = liveStateMap.get(id);
        const bigRgb = applyLookToState(lbState, look);
        self.postMessage(
            { id, type: WorkerMsg.LIGHTBOX, rgb: bigRgb,
              w: lbState.outW, h: lbState.outH,
              nativeW: lbState.nativeW, nativeH: lbState.nativeH,
              orientation: 1 },
            [bigRgb.buffer],
        );

        // encode: full-res look-applied RGB8 (identical rgb8 contract as RAW).
        // EXR/TIFF have no EXIF rotation, but user 90° turns still compose.
        const userTurns = Math.round(((opts.userRotation || 0) % 360 + 360) % 360 / 90) % 4;
        const encodeOrientation = composeOrientation(1, userTurns);
        const fullRenderer = LookRenderer.new_with_options(fullRgb16, w, h, 1, IDENTITY_CM, false, 0, 0);
        let fullRgb;
        try {
            fullRgb = applyLookToState({ renderer: fullRenderer, wbR: NaN, wbB: NaN }, look);
        } finally {
            fullRenderer.free();
        }
        const rgbBuf = fullRgb.buffer.slice(fullRgb.byteOffset, fullRgb.byteOffset + fullRgb.byteLength);
        fullRgb = null;
        self.postMessage(
            { id, type: WorkerMsg.ENCODE_REQUEST, pixels: rgbBuf, format: 'rgb8', width: w, height: h,
              quality: opts.lossless ? 100 : opts.quality,
              effort: opts.effort ?? 3,
              lossless: !!opts.lossless,
              orientation: encodeOrientation },
            [rgbBuf],
        );
    } finally {
        dec.free();
    }
}

// K6#1: migrated from 14-positional render() to named-field render_look().
// wbR/wbB still come from state (the camera WB cached at decode time; NaN means
// "use camera WB from MakerNote"); slider values null-coalesced to 0 before
// passing so render_look's from_js parser never sees a non-number value.
function applyLookToState(state, look) {
    return state.renderer.render_look({
        wbR:        state.wbR,
        wbB:        state.wbB,
        exposureEv: look.exposureEv  ?? 0,
        contrast:   look.contrast    ?? 0,
        highlights: look.highlights  ?? 0,
        shadows:    look.shadows     ?? 0,
        whites:     look.whites      ?? 0,
        blacks:     look.blacks      ?? 0,
        saturation: look.saturation  ?? 0,
        vibrance:   look.vibrance    ?? 0,
        temp:       look.temp        ?? 0,
        tint:       look.tint        ?? 0,
        texture:    look.texture     ?? 0,
        clarity:    look.clarity     ?? 0,
    });
}

self.addEventListener('message', async (ev) => {
    // --- prewarm: run ensureWasm before the first file task (TTFP-1) ---
    // Fire-and-forget: on failure ensureWasm resets wasmReady=null, so the
    // first real task simply retries the load — prewarm failure self-heals.
    if (ev.data.type === WorkerMsg.PRELOAD) {
        ensureWasm().catch((err) => {
            console.warn('[worker] wasm prewarm failed (will retry on first task):', err?.message || err);
        });
        return;
    }

    // --- release cached LookRenderer state for a re-submitted task ---
    if (ev.data.type === WorkerMsg.RELEASE_STATE) {
        const lbState = liveStateMap.get(ev.data.id);
        if (lbState) { lbState.renderer.free(); liveStateMap.delete(ev.data.id); }
        const tState = thumbStateMap.get(ev.data.id);
        if (tState) { tState.renderer.free(); thumbStateMap.delete(ev.data.id); }
        cancelledTasks.delete(ev.data.id);
        return;
    }

    // --- cancel an in-flight / no-longer-needed task (lightbox closed, card
    //     removed). Best-effort: frees cached renderer state and marks the task
    //     so the pipeline below stops emitting for it. The synchronous WASM
    //     decode itself cannot be interrupted mid-call. ---
    if (ev.data.type === WorkerMsg.CANCEL) {
        const cid = ev.data.id;
        if (cid !== undefined && cid !== null) {
            cancelledTasks.add(cid);
            const lbState = liveStateMap.get(cid);
            if (lbState) { lbState.renderer.free(); liveStateMap.delete(cid); }
            const tState = thumbStateMap.get(cid);
            if (tState) { tState.renderer.free(); thumbStateMap.delete(cid); }
        }
        return;
    }

    // --- lightbox live reprocess (single image) ---
    if (ev.data.type === WorkerMsg.REPROCESS_LIVE) {
        const { id, look } = ev.data;
        const state = liveStateMap.get(id);
        if (!state) {
            self.postMessage({ id, type: WorkerMsg.ERROR_LIVE, error: 'no live state for this task' });
            return;
        }
        try {
            const t0 = performance.now();
            const rgb = applyLookToState(state, look);
            const liveMs = performance.now() - t0;
            self.postMessage(
                { id, type: WorkerMsg.LIGHTBOX_LIVE, rgb,
                  // Phase 2: rgb is in sensor orientation (nativeW × nativeH).
                  // Display canvas is sized outW × outH. Main thread rotates via canvas transform.
                  w: state.outW, h: state.outH,
                  nativeW: state.nativeW, nativeH: state.nativeH,
                  orientation: state.orientation,
                  liveMs },
                [rgb.buffer],
            );
        } catch (err) {
            self.postMessage({ id, type: WorkerMsg.ERROR_LIVE, error: String(err?.message || err) });
        }
        return;
    }

    // --- gallery thumb batch reprocess (multiple taskIds owned by this worker) ---
    if (ev.data.type === WorkerMsg.REPROCESS_THUMB_LIVE) {
        const { taskIds, look } = ev.data;
        for (const tid of taskIds) {
            const state = thumbStateMap.get(tid);
            if (!state) continue;
            try {
                const rgb = applyLookToState(state, look);
                self.postMessage(
                    { id: tid, type: WorkerMsg.THUMB_LIVE, rgb,
                      w: state.outW, h: state.outH,
                      nativeW: state.nativeW, nativeH: state.nativeH,
                      orientation: state.orientation },
                    [rgb.buffer],
                );
            } catch (err) {
                self.postMessage({ id: tid, type: WorkerMsg.ERROR_LIVE, error: String(err?.message || err) });
            }
        }
        return;
    }

    // --- full ORF pipeline ---
    const { id, bytes, options } = ev.data;
    if (!id || !bytes) {
        // Not a pipeline message — ignore unknown types silently
        return;
    }
    // Best-effort cancel: if the task was cancelled before we started (queued
    // submit then lightbox closed), skip the expensive decode entirely.
    if (cancelledTasks.has(id)) {
        cancelledTasks.delete(id);
        return;
    }
    try {
        await ensureWasm();

        const opts = options || {};
        const look = opts.look || {};

        // Multi-format routing by magic bytes (+ optional name). RAW keeps its
        // exact existing path; EXR/TIFF/JPEG take the developed-image path; sdr/
        // jxl/unknown are rejected here rather than misrouted to the ORF decoder.
        const route = detectFormat(bytes, opts.name || '');
        if (route === 'exr' || route === 'tiff' || route === 'jpeg') {
            processImageFormat(id, bytes, opts, look, route);
            return;
        }
        if (route === 'sdr' || route === 'jxl' || route === 'unknown') {
            self.postMessage({
                id, type: WorkerMsg.ERROR,
                error: route === 'sdr'
                    ? 'Standard images (PNG/GIF/WebP/etc.) use the browser decode path, not the RAW pipeline.'
                    : route === 'jxl'
                        ? 'JXL files use the JXL decode path, not the RAW pipeline.'
                        : `Unsupported or unrecognized file format (${opts.name || 'unknown'}).`,
            });
            return;
        }
        // route === 'raw' — native ORF/CR2/DNG stay on hand WASM decoders;
        // other known manufacturer RAWs decode through browser LibRaw to a raw
        // Bayer mosaic, then reuse the shared Rust demosaic/tone pipeline.
        const rawKind = detectRawKind(bytes, opts.name || '');
        if (rawKind === 'unknown') {
            self.postMessage({
                id, type: WorkerMsg.ERROR,
                error: `Unrecognized RAW file: ${opts.name || 'unknown'} — no matching decoder for its magic bytes.`,
            });
            return;
        }
        const nativeRaw = rawKind === 'orf' || rawKind === 'cr2' || rawKind === 'dng';
        const decoderFn = nativeRaw ? pickRawDecoderWithFlags(bytes, opts.name || '') : null;
        let librawPayload = null;
        const lookArgs = {
            exposureEv: look.exposureEv ?? 0,
            contrast:   look.contrast   ?? 0,
            highlights: look.highlights ?? 0,
            shadows:    look.shadows    ?? 0,
            whites:     look.whites     ?? 0,
            blacks:     look.blacks     ?? 0,
            saturation: look.saturation ?? 0,
            vibrance:   look.vibrance   ?? 0,
            temp:       look.temp       ?? 0,
            tint:       look.tint       ?? 0,
            wbR: Number.isFinite(opts.wbR) ? opts.wbR : NaN,
            wbB: Number.isFinite(opts.wbB) ? opts.wbB : NaN,
            texture: look.texture ?? 0,
            clarity: look.clarity ?? 0,
        };

        // Mode 3 — single-decompress preview-first split (ORF only): previews
        // first, full-res second, but decompress runs ONCE.
        //
        // The monolithic call held the 360px thumb and 1800px lightbox hostage
        // to the full-res decompress+demosaic+tonemap, because requesting
        // OUT_FULL_RGB8 disables lib.rs's streaming preview-only fast path
        // (should_stream_previews). Phase 1 asks for previews + OUT_RETAIN_RAW,
        // which forces a full decompress (bypassing the streaming path) and
        // RETAINS that full raw mosaic in the ProcessResult; THUMB/LIGHTBOX post
        // before any full-res work. Phase 2 calls result.finish_full_rgb8() to
        // demosaic+tone the RETAINED mosaic into the full RGB8 — NO second
        // decompress, NO second decoder call. Byte-identical to a fresh full
        // decode (web/_mode3_ab.mjs A/B + two-phase-raw.test.js).
        //
        // DNG stays monolithic: its monolithic previews are downscaled from
        // the FULL-RES MHC demosaic (process_dng_impl has no superpixel
        // preview path), while its previews-only twin streams a superpixel
        // demosaic — measurably different preview bytes (proven by the A/B in
        // web/two-phase-raw.test.js). CR2 stays monolithic: decode_cr2_raw has
        // no streaming twin and ignores output flags at decode time, so a
        // split would repeat the full decode+demosaic for zero preview
        // speedup.
        //
        // Phase-1 results have width/height == 0 (lib.rs previews-only path)
        // until finish_full_rgb8 sets the full sensor dims; sensor dims travel on
        // ENCODE_REQUEST (phase 2) and main.js patches exif.width/height at DONE.
        // Cancel semantics unchanged: one checkpoint after the first WASM call,
        // none between phases (a between-phase skip would strand the pool slot,
        // since the worker is released on ENCODE_REQUEST).
        //
        // batch:true opts out of the split. Mode 3's split now decodes each ORF
        // exactly ONCE either way (the retained mosaic is reused), so the split is
        // purely a first-paint-latency win with no extra decompress; batch still
        // takes the single monolithic call (same shape DNG/CR2 use) so no raw is
        // retained for headless exports. Previews are still posted below (the
        // monolithic branch builds THUMB/LIGHTBOX too) — just after the full
        // decode, not before.
        const interactive = opts.batch !== true;   // default: interactive
        // Task 7: normalized denoise options travel on opts.denoise. Denoise runs
        // in the full-decode pipeline (pre-demosaic), which the Mode-3 previews-first
        // ORF split cannot serve (its phase-1 skips the full path), so denoise
        // DISABLES the split. Exact gate per spec:
        //   canSplit = nativeRaw && interactive && rawKind === 'orf' && !denoise.enabled
        const denoise = opts.denoise || { enabled: false };
        const canSplit = nativeRaw && interactive && rawKind === 'orf' && !denoise.enabled;

        const pT0 = performance.now();
        // OUT_NO_ORIENT: skip apply_orientation on the full RGB8 — JXL records
        // rotation as metadata, so pixels stay sensor-native and we avoid the
        // 60–200 MB intermediate buffer + cache-hostile transpose at encode prep.
        // Mode 3: OUT_RETAIN_RAW keeps phase-1's full raw mosaic so phase 2 finishes
        // the full RGB8 from it (finish_full_rgb8) instead of decompressing again.
        const phase1Flags = canSplit
            ? (OUT_LIGHTBOX | OUT_THUMB | OUT_RETAIN_RAW)
            : (OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB | OUT_NO_ORIENT);
        let result;
        // Task 11: learned denoise metadata, surfaced in phaseMs diagnostics.
        let learnedDenoiseBackend = null, learnedModelVersion = null, learnedDenoiseMs = 0;
        if (nativeRaw) {
            // Task 11: when learned denoise is requested (high-quality path), use the
            // tiled session API so ORT WebGPU residuals are committed before finish.
            // Falls back to classical BM3D path on any error (never a partial image).
            const sessionCreator = denoise.enabled ? pickDenoiseSessionCreator(rawKind) : null;
            if (sessionCreator) {
                const wasmOpts = buildWasmOptions(lookArgs, denoise);
                const learned = await decodeWithLearnedDenoise(sessionCreator, bytes, wasmOpts, opts.signal);
                result = learned.result;
                learnedDenoiseBackend = learned.denoiseBackend;
                learnedModelVersion = learned.modelVersion;
                learnedDenoiseMs = learned.denoiseMs;
            } else {
                // Classical path: the *_with_options API carries {look, denoise} so the
                // RAW pipeline can apply noise-aware denoise pre-demosaic. Fall back to
                // the positional *_with_flags wrapper when the options build isn't shipped
                // (kept for back-compat; never the primary path when options exist).
                const optDecoder = pickRawDecoderWithOptions(rawKind);
                if (optDecoder) {
                    result = optDecoder(bytes, phase1Flags, buildWasmOptions(lookArgs, denoise));
                } else {
                    result = processRawWithFlagsNamed(decoderFn, bytes, phase1Flags, lookArgs);
                }
            }
        } else {
            if (rawKind === 'nef' || rawKind === 'nrw' || rawKind === 'rw2' || rawKind === 'rwl' || rawKind === 'crw') {
                const hand = tryDecodeHandRaw(bytes, opts.name || '');
                if (hand.ok) {
                    librawPayload = hand.payload;
                } else {
                    console.warn(`[worker] hand ${rawKind} decoder fallback to LibRaw: ${hand.reason}`);
                }
            }
            if (!librawPayload) librawPayload = await decodeWithLibRaw(bytes, opts.name || '');
            if (process_raw_mosaic_with_options) {
                const p = librawPayload;
                result = process_raw_mosaic_with_options(
                    p.raw, p.width, p.height, p.cfaPhase,
                    p.black, p.white, p.wbR, p.wbB,
                    p.orientation, new Float32Array(p.colorMatrix || []),
                    phase1Flags, p.iso || 0,
                    buildWasmOptions(lookArgs, denoise),
                );
            } else {
                result = processRawMosaicWithFlagsNamed(librawPayload, phase1Flags, lookArgs);
            }
        }
        // Best-effort cancel checkpoint: the synchronous decode could not be
        // interrupted, but if the task was cancelled while it ran, free the
        // decode result and emit nothing further (no renderer state cached yet).
        if (cancelledTasks.has(id)) {
            cancelledTasks.delete(id);
            result.free();
            return;
        }
        // OUT_NO_ORIENT: result.width/height are sensor dims (pre-rotation).
        let w = result.width;
        let h = result.height;
        const pipelineMs = performance.now() - pT0;
        const phaseMs = {
            decompress: result.decompress_ms,
            demosaic:   result.demosaic_ms,
            tonemap:    result.tonemap_ms,
            orient:     result.orient_ms,
            denoise:    result.denoise_ms || 0,
            // Task 11: learned-denoise inference time (0 when classical path used).
            denoiseInference: learnedDenoiseMs,
            denoiseBackend:   learnedDenoiseBackend,
            denoiseModel:     learnedModelVersion,
        };
        const wbR = result.wb_r_used;
        const wbB = result.wb_b_used;
        const black = result.black_used; // per-format pedestal for the live LookRenderer
        const white = result.white_used; // per-format white the live LookRenderer normalises by
        const make  = result.make || (librawPayload && librawPayload.make) || '';
        const model = result.model || (librawPayload && librawPayload.model) || '';
        // DEBUG: the exact black/white the lightbox + thumb LookRenderers use. If
        // white != the file's white (~15300 for CR2/DNG), the live preview blows out.
        console.log(`[DBG] "${model}" black_used=${black} white_used=${white} wbR=${wbR.toFixed(3)} wbB=${wbB.toFixed(3)} lb=${result.lb_w}x${result.lb_h}`);
        const colorMatrixFromMn = result.color_matrix_from_mn;
        const ori = result.orientation;
        const colorMatrix = new Float32Array(result.color_matrix_used());

        // Flat EXIF blob for the lightbox info panel. Rationals are passed as
        // {n, d}; consumer formats. Zero denominators mean "absent".
        const exif = {
            make, model,
            lens: result.lens,
            datetime: result.datetime,
            exposure:   result.exposure_den   > 0 ? { n: result.exposure_num,   d: result.exposure_den   } : null,
            fnumber:    result.fnumber_den    > 0 ? { n: result.fnumber_num,    d: result.fnumber_den    } : null,
            focalLength: result.focal_length_den > 0 ? { n: result.focal_length_num, d: result.focal_length_den } : null,
            focalLength35: result.focal_length_35 || null,
            iso:        result.iso > 0 ? result.iso : null,
            orientation: ori,
            gps:        result.has_gps ? { lat: result.gps_lat, lon: result.gps_lon, alt: result.gps_alt } : null,
            quality:    result.quality || null,
            wbMode:     result.wb_mode === 0xFFFF ? null : result.wb_mode,
            wbR, wbB,
            wbFromCamera: result.wb_from_camera,
            width: w, height: h,
        };

        // Store lightbox liveState — built in-wasm from the internal packed buffer.
        // S1 seam: skips take_rgb16_lb() → JS Uint8Array → new_with_options, so the
        // packed lightbox bytes never leave wasm linear memory (black/orientation/
        // colorMatrix are read from the same ProcessResult fields inside wasm).
        liveStateMap.set(id, makeLiveStateFromRenderer(result.take_lightbox_renderer(), result.lb_w, result.lb_h, ori, wbR, wbB));

        // Store thumb liveState (S1 seam twin).
        thumbStateMap.set(id, makeLiveStateFromRenderer(result.take_thumb_renderer(), result.thumb_w, result.thumb_h, ori, wbR, wbB));

        // thumb RGB8 — apply look to the pre-scaled rgb16 (360px) already cached in thumbStateMap.
        // Avoids downscaling the full 20MP fullRgb (~200× more pixels) for the same result.
        // Phase 2: rgb is sensor-orient; main thread rotates via canvas transform.
        const thumbState = thumbStateMap.get(id);
        const thumbRgb = applyLookToState(thumbState, look);
        self.postMessage(
            { id, type: WorkerMsg.THUMB, rgb: thumbRgb,
              w: thumbState.outW, h: thumbState.outH,
              nativeW: thumbState.nativeW, nativeH: thumbState.nativeH,
              orientation: thumbState.orientation,
              pipelineMs, phaseMs, wbR, wbB, make, model, colorMatrixFromMn, exif },
            [thumbRgb.buffer],
        );

        // lightbox RGB8 — same: apply look to the pre-scaled rgb16 (1800px) in liveStateMap.
        const lbState = liveStateMap.get(id);
        const bigRgb = applyLookToState(lbState, look);
        self.postMessage(
            { id, type: WorkerMsg.LIGHTBOX, rgb: bigRgb,
              w: lbState.outW, h: lbState.outH,
              nativeW: lbState.nativeW, nativeH: lbState.nativeH,
              orientation: lbState.orientation },
            [bigRgb.buffer],
        );

        // JXL records orientation as metadata — no pixel rotation needed for the
        // EXIF tag. User rotation (90° turns from the UI) composes into the
        // same tag, so userTurns also never triggers a CPU rotate.
        const userTurns = Math.round(((opts.userRotation || 0) % 360 + 360) % 360 / 90) % 4;
        const encodeOrientation = composeOrientation(ori, userTurns);

        // Phase 2 (split only): finish the full-res RGB8 FROM the raw mosaic
        // retained in phase 1 — demosaic+tone only, NO second decompress and NO
        // second decoder call. Previews are already on screen; this runs after
        // their postMessages so the main thread paints while the worker crunches.
        // The phase-1 renderers were already moved out (take_*_renderer); the
        // retained mosaic is consumed here, then `result` is freed at the end.
        let fullRgb, encW, encH, encTimings;
        if (canSplit) {
            const p2T0 = performance.now();
            try {
                // Same 14 look args, same order, as process_orf_with_flags / phase 1.
                result.finish_full_rgb8(
                    OUT_FULL_RGB8 | OUT_NO_ORIENT,
                    lookArgs.exposureEv, lookArgs.contrast, lookArgs.highlights, lookArgs.shadows,
                    lookArgs.whites, lookArgs.blacks, lookArgs.saturation, lookArgs.vibrance,
                    lookArgs.temp, lookArgs.tint, lookArgs.wbR, lookArgs.wbB,
                    lookArgs.texture, lookArgs.clarity,
                );
                const p2Ms = performance.now() - p2T0;
                encW = result.width;   // full sensor dims, set by finish_full_rgb8
                encH = result.height;
                // Honest single-decompress cost: decompress ran ONCE (phase 1); the
                // finish contributes demosaic+tonemap only (its orient is skipped by
                // OUT_NO_ORIENT). Travels on ENCODE_REQUEST because THUMB (with the
                // phase-1 partials) has already been posted; main.js patches card
                // state at DONE.
                encTimings = {
                    pipelineMs: pipelineMs + p2Ms,
                    phaseMs: {
                        decompress: phaseMs.decompress,   // the single decompress
                        demosaic:   result.demosaic_ms,   // from the finish
                        tonemap:    result.tonemap_ms,    // from the finish
                        orient:     result.orient_ms,
                    },
                };
                fullRgb = result.take_rgb();
            } finally {
                // Always free the ProcessResult shell, even if finish_full_rgb8 throws
                // (the retained raw is already freed inside the finish on its error path).
                result.free();
            }
        } else {
            encW = w;
            encH = h;
            fullRgb = result.take_rgb();
        }

        // A3: send RGB8 directly — skip the ~210ms rgb_to_rgba conversion and 25% larger transfer.
        // P0 (a44e6a96): take_rgb() = std::mem::take → an OWNED buffer (byteOffset 0), so the old
        // re-slice was a redundant full-buffer memcpy (~40ms + 50MB GC per 4096² file —
        // flipflopdom-measured: .flipflop/dom-tests/bridge-p0-slice.mjs). Transfer .buffer directly;
        // fullRgb is nulled immediately below and never reused, so detaching it is safe.
        const rgbBuf = fullRgb.buffer;
        fullRgb = null; // allow GC (the transfer detaches the buffer anyway)
        self.postMessage(
            { id, type: WorkerMsg.ENCODE_REQUEST, pixels: rgbBuf, format: 'rgb8', width: encW, height: encH,
              quality: opts.lossless ? 100 : opts.quality,
              effort: opts.effort ?? 3,
              lossless: !!opts.lossless,
              orientation: encodeOrientation,
              ...(encTimings ?? {}) },
            [rgbBuf],
        );
    } catch (err) {
        // Free any LookRenderer objects stored before the failure so WASM memory
        // is not leaked for tasks that will never re-render.
        if (id !== undefined) {
            const lbState = liveStateMap.get(id);
            if (lbState) { lbState.renderer.free(); }
            liveStateMap.delete(id);
            const tState = thumbStateMap.get(id);
            if (tState) { tState.renderer.free(); }
            thumbStateMap.delete(id);
        }
        self.postMessage({
            id,
            type: WorkerMsg.ERROR,
            error: (err && (err.message || String(err))) || 'unknown error',
        });
    }
});
