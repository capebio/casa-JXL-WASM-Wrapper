// colour-wizard-worker.js — WASM worker for Colour Calibration Wizard.
// Handles RAW decode and LookRenderer re-renders; keeps WASM state off the main thread.

import { detectRawKind } from './format-detect.js';

// --- WASM init state ---
let rawWasm = null;
let wasmReady = false;

// --- LookRenderer state (one per loaded file) ---
let renderer = null;
let rendererW = 0;
let rendererH = 0;

// output_flags bitmask (mirrors worker.js + src/lib.rs)
const OUT_LIGHTBOX = 2;  // 1800-px side RGB16 for LookRenderer

const RAW_NEUTRAL = {
    exposureEv: 0, contrast: 0, highlights: 0, shadows: 0,
    whites: 0, blacks: 0, saturation: 0, vibrance: 0,
    temp: 0, tint: 0, wbR: NaN, wbB: NaN, texture: 0, clarity: 0,
};

// ---- helpers ----

async function ensureWasm() {
    if (wasmReady) return;
    rawWasm = await import('./pkg/raw_converter_wasm.js');
    await rawWasm.default();
    if (typeof rawWasm.initThreadPool === 'function') {
        await rawWasm.initThreadPool(navigator.hardwareConcurrency || 4);
    }
    wasmReady = true;
}

function pickDecoder(bytes, name) {
    const kind = detectRawKind(bytes, name);
    switch (kind) {
        case 'orf': return rawWasm.process_orf_with_flags;
        case 'cr2': return rawWasm.process_cr2_with_flags;
        case 'dng': return rawWasm.process_dng_with_flags;
        case 'unsupported':
            throw new Error(`RAW format not supported by WASM: ${name} (Sony/Nikon/Panasonic require a native decoder)`);
        default:
            throw new Error(`Unrecognised RAW file: ${name}`);
    }
}

// Convert RGB8 (3 bytes/px) → RGBA8 (4 bytes/px, alpha=255).
function rgb8ToRgba8(rgb, n) {
    const rgba = new Uint8ClampedArray(n * 4);
    for (let i = 0, j = 0; i < n; i++, j += 3) {
        rgba[i * 4    ] = rgb[j    ];
        rgba[i * 4 + 1] = rgb[j + 1];
        rgba[i * 4 + 2] = rgb[j + 2];
        rgba[i * 4 + 3] = 255;
    }
    return rgba;
}

// ---- message handlers ----

/**
 * Decode a RAW file and initialise the LookRenderer.
 * Returns rgba8 (Uint8ClampedArray) at lightbox size, plus metadata.
 */
function handleDecode({ bytes, name }) {
    const decoder = pickDecoder(bytes, name);
    const o = RAW_NEUTRAL;
    const result = decoder(
        bytes, OUT_LIGHTBOX,
        o.exposureEv, o.contrast, o.highlights, o.shadows, o.whites, o.blacks,
        o.saturation, o.vibrance, o.temp, o.tint, o.wbR, o.wbB, o.texture, o.clarity,
    );

    // Free previous renderer if any
    if (renderer) { try { renderer.free(); } catch (_) {} }

    renderer  = result.take_lightbox_renderer();
    rendererW = result.lb_w;
    rendererH = result.lb_h;

    const meta = {
        wbR:          result.wb_r_used,
        wbB:          result.wb_b_used,
        colorMatrix:  Array.from(result.color_matrix_used()),
        orientation:  result.orientation,
        black:        result.black_used,
        make:         result.make,
        model:        result.model,
        lens:         result.lens,
        iso:          result.iso,
        wbFromCamera: result.wb_from_camera,
        width:        rendererW,
        height:       rendererH,
    };

    result.free();

    // Initial render: apply camera WB, neutral tone sliders
    const rgb = renderer.render(
        meta.wbR, meta.wbB,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    );

    const rgba = rgb8ToRgba8(rgb, rendererW * rendererH);
    return { rgba, meta };
}

/**
 * Re-render with new look parameters using the resident LookRenderer.
 * Returns rgba8 (Uint8ClampedArray) at lightbox size.
 */
function handleRender({ params }) {
    if (!renderer) throw new Error('No renderer loaded — decode a file first');
    const p = { ...RAW_NEUTRAL, ...params };
    const rgb = renderer.render(
        p.wbR, p.wbB,
        p.exposureEv, p.contrast, p.highlights, p.shadows, p.whites, p.blacks,
        p.saturation, p.vibrance, p.temp, p.tint, p.texture, p.clarity,
    );
    const n = rendererW * rendererH;
    const rgba = rgb8ToRgba8(rgb, n);
    return { rgba, width: rendererW, height: rendererH };
}

// ---- message dispatch ----

self.addEventListener('message', async (e) => {
    const { type, id } = e.data;
    try {
        await ensureWasm();

        if (type === 'decode') {
            const { rgba, meta } = handleDecode(e.data);
            self.postMessage(
                { type: 'decoded', id, rgba, width: meta.width, height: meta.height, meta },
                [rgba.buffer],
            );
        } else if (type === 'render') {
            const { rgba, width, height } = handleRender(e.data);
            self.postMessage(
                { type: 'rendered', id, rgba, width, height },
                [rgba.buffer],
            );
        } else if (type === 'free') {
            if (renderer) { try { renderer.free(); } catch (_) {} renderer = null; }
            self.postMessage({ type: 'freed', id });
        }
    } catch (err) {
        self.postMessage({ type: 'error', id, error: err.message });
    }
});
