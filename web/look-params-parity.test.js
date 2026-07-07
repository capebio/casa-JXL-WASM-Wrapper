/**
 * look-params-parity.test.js — K6#1 parity gate.
 *
 * Verifies that the new named-field render_look(look) API and the legacy
 * positional render(wb_r, wb_b, ...) API produce byte-identical output for
 * identical parameters.  Uses a synthetic 4×4 RGB16 image (no real ORF needed)
 * so this test runs in any Node/Bun environment without fixture files.
 *
 * Runner: bun test web/look-params-parity.test.js
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import initRaw, { LookRenderer } from './pkg/raw_converter_wasm.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a packed RGB16-LE buffer (6 bytes/pixel) for a w×h synthetic image.
 * Each channel cycles through 0..65535 so the look adjustments produce
 * non-trivial output — a flat-grey frame would hide channel-specific bugs.
 */
function syntheticRgb16Le(w, h) {
    const buf = new Uint8Array(w * h * 6);
    let i = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const r = (x * 16384 + y * 4096) & 0xffff;
            const g = (x * 8192  + y * 8192) & 0xffff;
            const b = (x * 4096  + y * 16384) & 0xffff;
            // packed LE: low byte then high byte for each channel
            buf[i++] = r & 0xff; buf[i++] = (r >> 8) & 0xff;
            buf[i++] = g & 0xff; buf[i++] = (g >> 8) & 0xff;
            buf[i++] = b & 0xff; buf[i++] = (b >> 8) & 0xff;
        }
    }
    return buf;
}

// 9-element row-major identity matrix (no colour rotation).
const IDENTITY_CM = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const W = 4, H = 4;

/** Construct a LookRenderer for the synthetic image. */
function makeRenderer() {
    const rgb16 = syntheticRgb16Le(W, H);
    const result = LookRenderer.new_with_options(rgb16, W, H, 1, IDENTITY_CM, false, 0);
    if (result instanceof Error) throw result;
    return result;
}

// ── WASM init ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
    // No-arg call: wasm-bindgen resolves the .wasm via import.meta.url (file://).
    // Bun handles file:// URLs in fetch(), so this works without manual byte loading.
    await initRaw();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('K6#1 render_look() parity with positional render()', () => {
    test('neutral look: render_look({}) identical to render(NaN,NaN,0,…,0)', () => {
        const r = makeRenderer();
        try {
            // positional neutral: wbR=NaN (camera WB), wbB=NaN, all sliders 0
            const positional = r.render(
                NaN, NaN,
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            );
            // named neutral: empty object — from_js defaults all to 0 / NaN
            const named = r.render_look({});
            expect(named).toEqual(positional);
        } finally {
            r.free();
        }
    });

    test('non-zero look: render_look({...}) identical to positional render()', () => {
        const r = makeRenderer();
        try {
            const wbR = 1.8, wbB = 1.3;
            const exposureEv = 0.5, contrast = 0.2, highlights = -0.3, shadows = 0.1;
            const whites = 0.0, blacks = 0.0, saturation = 0.15, vibrance = 0.1;
            const temp = 0.0, tint = 0.0, texture = 0.0, clarity = 0.0;

            const positional = r.render(
                wbR, wbB,
                exposureEv, contrast, highlights, shadows,
                whites, blacks, saturation, vibrance,
                temp, tint, texture, clarity,
            );
            const named = r.render_look({
                wbR, wbB, exposureEv, contrast, highlights, shadows,
                whites, blacks, saturation, vibrance, temp, tint, texture, clarity,
            });
            expect(named).toEqual(positional);
        } finally {
            r.free();
        }
    });

    test('render_look rejects unknown keys', () => {
        const r = makeRenderer();
        try {
            expect(() => r.render_look({ unknownKey: 1.0 })).toThrow(/unknown look param/);
        } finally {
            r.free();
        }
    });

    test('render_look accepts partial look (missing keys default to neutral)', () => {
        const r = makeRenderer();
        try {
            // Only set exposure; all other sliders should default to 0 / camera WB.
            const partial = r.render_look({ exposureEv: 0.0 });
            // Compare to full neutral positional call — must be identical.
            const neutralPositional = r.render(NaN, NaN, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
            expect(partial).toEqual(neutralPositional);
        } finally {
            r.free();
        }
    });
});
