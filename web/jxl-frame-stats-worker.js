import { analyzeProgressiveFrame, setFrameStatsWasm } from './jxl-progressive-frame-stats.js';
import { computePsnrVsFinal, computeSsimVsFinal, computeChannelMoments } from './jxl-progressive-quality.js';
import { pixelsToXyb, computeButteraugliVsFinal, createButteraugliComparer, computeButteraugliApproxVsFinal } from './jxl-butteraugli.js';

// Explicit buffer ownership helper. No scattered new Uint8Array in hot paths.
// Future WASM boundary needs single ownership seam (see handoff 1).
function asUint8Array(value) {
    if (value instanceof Uint8Array) {
        return value;
    }
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }
    if (value && typeof value === 'object' && value.buffer instanceof ArrayBuffer) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new TypeError('Expected pixel buffer');
}

// Region-first seam (handoff 6). Back-compat: old flat {pixels,width,height} or new {frameId, region:{x,y,width,height}, pixels}.
// Current chart consumers unchanged; region echoed in results for future regional butter/accel.
function normaliseFrame(input) {
    if (!input) return null;
    const p = asUint8Array(input.pixels ?? input.buf ?? input);
    const r = input.region || input;
    return {
        x: (r && r.x) ?? 0,
        y: (r && r.y) ?? 0,
        width: (r && r.width) ?? input.width ?? 0,
        height: (r && r.height) ?? input.height ?? 0,
        pixels: p
    };
}

// Optional wasm-accelerated metrics (PerceptualComparer in web/pkg). JS remains
// the fallback for no-WASM environments (CSP, locked-down webviews) or load
// failures. null = untried, false = unavailable, object = loaded module.
let _wasmMetrics = null;
let _wasmMemory = null; // WebAssembly.Memory — needed for the zero-copy input_ptr path
async function ensureWasmMetrics() {
    if (_wasmMetrics !== null) return _wasmMetrics;
    try {
        const mod = await import('./pkg/raw_converter_wasm.js');
        // browser worker: init() fetches _bg.wasm via module URL and returns the
        // wasm exports object (incl. `memory`), which the zero-copy path writes to.
        const wasmExports = await mod.default();
        _wasmMemory = wasmExports?.memory ?? null;
        // Wire the exact-FNV WASM frame-stats kernel (~3.7x over JS) into the shared
        // analyzeProgressiveFrame seam. Independent of PerceptualComparer availability.
        if (typeof mod.frame_stats === 'function') {
            setFrameStatsWasm((px, w, h) => mod.frame_stats(px, w, h));
        }
        _wasmMetrics = (typeof mod.PerceptualComparer === 'function') ? mod : false;
    } catch {
        _wasmMetrics = false;
    }
    return _wasmMetrics;
}

// Reference cache for immutable final during chart batches / repeated toggles / scrub.
// id can be caller-provided or synthesized (size+sample). Reuses cmp/wcmp + avoids re-xyb/prep.
// (handoff 3)
let referenceCache = {
    id: null,
    width: 0,
    height: 0,
    refPx: null,
    wcmp: null,
    cmp: null
};

function prepareReference(id, pixels, width, height) {
    if (referenceCache.id === id && referenceCache.width === width && referenceCache.height === height) {
        return referenceCache;
    }
    const refPx = asUint8Array(pixels);
    // Free the prior reference's WASM comparer before dropping it; PerceptualComparer
    // owns WASM-heap memory that is not reclaimed by GC, so a bare reassign leaks it
    // across every chart-batch reference change.
    if (referenceCache.wcmp && typeof referenceCache.wcmp.free === 'function') {
        try { referenceCache.wcmp.free(); } catch {}
    }
    // wcmp / cmp built below in handle; cache holds them after first use in request.
    const cache = {
        id,
        width,
        height,
        refPx,
        wcmp: null,
        cmp: null
    };
    referenceCache = cache;
    return cache;
}

// Stats offload (post-decode only). Lenses 1-25 applied at creation.
// Handoff 2026-06 progressive perceptual worker applied: asUint ownership (1), smart transfer where safe (2),
// ref cache keyed (3), region seam (6), metric sched cheap-first (7), cancel (14).
// Gaps closed: cancel best-effort between passes; receive uses asUint no extra materialization; ref cache + cmp reuse.
// Remaining: full regional analysis (still full vs-ref for chart compat), live/no-ref delta for AR (use temporal only as accel, not replace).
// Fast ML/AR gate (12/16): use includeButter=false + moments/psnr/ssim as surrogate; avoid butter cost.
// Perceptual (17): metrics here on decoded space; LookRenderer flat-log engine (Rust) is paint-time. Do not extend this layer until engine lands (see rejected P-1).
// Zero-copy (20/7/24): asUint + direct transfer of disposable ds buffers in callers; never re-slice received when whole.
// SIMD (22/25): pixel loops not here; see imports + raw pipeline. Consider future WASM stats co-located with decode mem.
// Gaming/astro/photogram (13/11/14): job dispatch for perceptual "telescope"; fidelity for digital-twin recon.
// Run backwards (10): current final-ref = bench; live needs delta-between-passes (handoff 5 rejected here without consumer/evidence).
// On flip-flop for changes: alternate via local const switch, 10 runs, compare emitted timings + external ms.
// Region (handoff 6): normalise-ready; current chart path echoes region in rec but computes full (butter region fn ready in dep).
// Do not retain every pass (handoff 4): already stateless per msg; only ref cache held (immutable during batch).

// Cancellation (handoff 14). Long butter is sync; checks between passes give best-effort preempt for UI/scrub/AR.
let cancelled = false;
let requestGen = 0;

self.onmessage = (event) => {
    const data = event.data ?? {};
    if (data.type === 'cancel') {
        cancelled = true;
        requestGen++;
        return;
    }
    const { id, type } = data;
    if (type === 'chart') {
        cancelled = false; // new work resets
        handleChartRequest(id, data);
    } else {
        handleFrameStats(id, data);
    }
};

async function handleFrameStats(id, data) {
    const { pixels, width, height, returnPixels = true } = data ?? {};
    try {
        await ensureWasmMetrics(); // wires the WASM frame_stats backend on first call (JS fallback if it fails)
        const input = asUint8Array(pixels ?? new ArrayBuffer(0));
        const stats = analyzeProgressiveFrame(input, width, height);
        let pixField = undefined;
        const xfer = [];
        if (returnPixels) {
            const ab = input.buffer;
            const off = input.byteOffset;
            const len = input.byteLength;
            // Transfer the received buffer view directly when it covers the whole (ownership from caller slice).
            // Avoid re-slice when possible (handoff 2).
            if (off === 0 && len === ab.byteLength) {
                pixField = ab;
                xfer.push(ab);
            } else {
                const output = ab.slice(off, off + len);
                pixField = output;
                xfer.push(output);
            }
        }
        self.postMessage({ id, ok: true, stats, pixels: pixField }, xfer);
    } catch (error) {
        self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
}

async function handleChartRequest(id, data) {
    const { ref, refWidth, refHeight, passes, refId } = data;
    const myGen = ++requestGen;
    try {
        if (!passes || !passes.length) {
            self.postMessage({ id, ok: true, type: 'chart', values: [] });
            return;
        }
        const start = performance.now();
        const refPx = asUint8Array(ref);
        const n = refWidth * refHeight;

        // Prepare / reuse reference (handoff 3). id from caller or cheap synthetic.
        const synthId = refId || `r${refWidth}x${refHeight}:${refPx.length}:${refPx[0] ?? 0}`;
        const rcache = prepareReference(synthId, refPx, refWidth, refHeight);
        // If we have prior cmp/wcmp for id, reuse; else build below.
        let wcmp = rcache.wcmp;
        let cmp = rcache.cmp;
        let refXyb = null;

        // Prefer the wasm PerceptualComparer for the default (full butteraugli)
        // path: it computes psnr+ssim+butteraugli in one shared pass. The 'approx'
        // and includeButter===false paths stay on JS (different semantics). Falls
        // back to JS if wasm is unavailable or the comparer can't be built.
        const wm = (data.includeButter !== false && data.includeButter !== 'approx')
            ? await ensureWasmMetrics() : false;
        if (wm && !wcmp) {
            try {
                wcmp = new wm.PerceptualComparer(rcache.refPx, refWidth, refHeight);
                rcache.wcmp = wcmp;
            } catch {
                wcmp = null;
            }
        }

        if (!wcmp && data.includeButter !== false && !cmp) {
            if (data.includeButter === 'approx') {
                refXyb = pixelsToXyb(rcache.refPx, n);
            } else {
                cmp = createButteraugliComparer(rcache.refPx, refWidth, refHeight);
                rcache.cmp = cmp;
            }
        }

        // Region seam (handoff 6): accept {region:{x,y,w,h}} or flat x/y/width/height on pass entries.
        // Compute stays full-ref for now (compat); region echoed in rec for future regional analysis.
        // normalise not needed for flat chart path but support without break.
        let prevPsnr = null;
        const PSNR_GATE_DB = 0.5; // cheap->expensive gate (handoff 7); matches byte-metrics
        const values = [];
        for (let i = 0; i < passes.length; i++) {
            const p = passes[i];
            if (!p) { values.push(null); continue; }
            if (cancelled || myGen !== requestGen) {
                break; // best-effort cancel between passes (sync butter cannot yield mid)
            }
            const px = asUint8Array(p.buf);
            // region passthrough (non-breaking)
            const reg = (p.region || (p.x != null || p.y != null ? p : null));
            let rec;
            if (wcmp) {
                // Zero-copy path: write the test RGBA straight into the comparer's
                // wasm-heap staging buffer (input_ptr/all_at, src/lib.rs) instead of
                // copying the full buffer across the FFI on every pass via all().
                let m;
                if (_wasmMemory && typeof wcmp.input_ptr === 'function') {
                    const p = wcmp.input_ptr(px.length);
                    // Acquire the heap view AFTER input_ptr — growing the staging
                    // buffer may grow (and detach views of) wasm memory.
                    new Uint8Array(_wasmMemory.buffer, p, px.length).set(px);
                    m = wcmp.all_at(px.length);
                } else {
                    m = wcmp.all(px);
                }
                rec = {
                    index: p.index,
                    psnr: m.psnr,
                    ssim: m.ssim,
                    butt: m.butteraugli,
                    moments: computeChannelMoments(px, refWidth, refHeight),
                };
            } else {
                rec = {
                    index: p.index,
                    psnr: computePsnrVsFinal(rcache.refPx, px),
                    ssim: computeSsimVsFinal(rcache.refPx, px, refWidth, refHeight),
                    moments: computeChannelMoments(px, refWidth, refHeight),
                };
                if (data.includeButter !== false) {
                    const psnrDelta = prevPsnr != null ? Math.abs(rec.psnr - prevPsnr) : Infinity;
                    const doButter = (data.includeButter === 'approx') || (psnrDelta > PSNR_GATE_DB) || prevPsnr == null;
                    if (doButter) {
                        if (data.includeButter === 'approx') {
                            rec.butt = computeButteraugliApproxVsFinal(refXyb, px, refWidth, refHeight);
                        } else if (cmp) {
                            rec.butt = cmp(px);
                        }
                    } else {
                        rec.butt = null;
                    }
                } else {
                    rec.butt = null;
                }
            }
            if (reg && (reg.x || reg.y)) {
                rec.region = { x: reg.x | 0, y: reg.y | 0, width: reg.width | 0, height: reg.height | 0 };
            }
            prevPsnr = rec.psnr;
            values.push(rec);
        }
        const end = performance.now();
        self.postMessage({ id, ok: true, type: 'chart', values, timings: { totalMs: end - start, passes: values.length, backend: wcmp ? 'wasm' : 'js' } });
    } catch (error) {
        self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
}
