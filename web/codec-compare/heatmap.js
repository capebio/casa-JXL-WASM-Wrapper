// heatmap.js — Butteraugli-inspired per-pixel error heatmap.
//
// Uses the JS butteraugli approximation from jxl-butteraugli.js.
// renderHeatmap() paints a jet-colormap canvas from the per-pixel saliency field.
// getButteraugliScore() returns the scalar JS-approximation distance.

import { createButteraugliComparer, computeSaliencyField, pixelsToXyb } from '../jxl-butteraugli.js';

// ── Jet colormap ─────────────────────────────────────────────────────────────
// t: 0 (identical, blue) → 1 (max error, red)

function jetColor(t) {
    // Standard jet: blue → cyan → green → yellow → red
    const clamp = (v) => Math.max(0, Math.min(1, v));
    const r = clamp(1.5 - Math.abs(4 * t - 3));
    const g = clamp(1.5 - Math.abs(4 * t - 2));
    const b = clamp(1.5 - Math.abs(4 * t - 1));
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute the JS-approximation Butteraugli scalar score between ref and test RGBA8.
 * @param {Uint8Array} refRgba - Reference RGBA8 pixels.
 * @param {Uint8Array} testRgba - Test (encoded-decoded) RGBA8 pixels.
 * @param {number} width
 * @param {number} height
 * @returns {number} Score (0 = identical, ~0.5 = excellent, >1.5 = visible).
 */
export function getButteraugliScore(refRgba, testRgba, width, height) {
    const compare = createButteraugliComparer(refRgba, width, height);
    return compare(testRgba);
}

/**
 * Render a butteraugli error heatmap onto a canvas element.
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas - Target canvas (will be resized to w×h).
 * @param {Uint8Array} refRgba - Original RGBA8 pixels.
 * @param {Uint8Array} testRgba - Encoded-decoded RGBA8 pixels.
 * @param {number} width
 * @param {number} height
 */
export function renderHeatmap(canvas, refRgba, testRgba, width, height) {
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const n = width * height;

    // Compute per-pixel saliency: 24*dx^2 + 12*dy^2 + 4*db^2 in XYB space.
    const refXyb = pixelsToXyb(refRgba, n);
    const saliency = computeSaliencyField(refXyb, testRgba, width, height);

    // Paint jet colormap into ImageData.
    const id = ctx.createImageData(width, height);
    const px = id.data;
    for (let i = 0; i < n; i++) {
        const t = saliency[i]; // already 0..1 normalized
        const [r, g, b] = jetColor(t);
        const o = i * 4;
        px[o]     = r;
        px[o + 1] = g;
        px[o + 2] = b;
        px[o + 3] = 200; // slight transparency to see the image underneath
    }
    ctx.putImageData(id, 0, 0);
}

/**
 * Render a split view: left half = original, right half = heatmap overlay.
 * @param {HTMLCanvasElement} canvas
 * @param {Uint8Array} refRgba
 * @param {Uint8Array} testRgba
 * @param {number} width
 * @param {number} height
 */
export function renderSplitHeatmap(canvas, refRgba, testRgba, width, height) {
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const n = width * height;

    // Draw original on left half.
    const refId = new ImageData(new Uint8ClampedArray(refRgba.buffer, refRgba.byteOffset, refRgba.byteLength), width, height);
    ctx.putImageData(refId, 0, 0);

    // Compute saliency.
    const refXyb = pixelsToXyb(refRgba, n);
    const saliency = computeSaliencyField(refXyb, testRgba, width, height);

    // Build heatmap ImageData.
    const heatId = ctx.createImageData(width, height);
    const px = heatId.data;
    for (let i = 0; i < n; i++) {
        const t = saliency[i];
        const [r, g, b] = jetColor(t);
        const o = i * 4;
        px[o]     = r;
        px[o + 1] = g;
        px[o + 2] = b;
        px[o + 3] = 255;
    }
    // Draw heatmap on right half using clip.
    const offscreen = new OffscreenCanvas(width, height);
    const offCtx = offscreen.getContext('2d');
    offCtx.putImageData(heatId, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(Math.floor(width / 2), 0, width - Math.floor(width / 2), height);
    ctx.clip();
    ctx.drawImage(offscreen, 0, 0);
    ctx.restore();

    // Draw split line.
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(Math.floor(width / 2), 0);
    ctx.lineTo(Math.floor(width / 2), height);
    ctx.stroke();
    ctx.restore();
}
