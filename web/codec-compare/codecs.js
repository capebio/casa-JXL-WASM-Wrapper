// codecs.js — Unified encode/decode adapters for JXL, JPEG, AVIF, WebP.
//
// JXL: uses the @casabio/jxl-wasm facade (createEncoder / createDecoder).
// JPEG, AVIF, WebP: browser-native canvas toBlob / createImageBitmap.
//
// Each codec: { name, encode(rgba, w, h, quality) -> Uint8Array, decode(bytes) -> {data, width, height} }
// rgba: Uint8Array RGBA8. quality: 0–100 integer.

import { createEncoder, createDecoder } from '@casabio/jxl-wasm';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Ensure a Uint8Array has a tight backing buffer (required by facade pushPixels). */
function exactBuffer(u8) {
    return (u8.buffer.byteLength === u8.byteLength)
        ? u8.buffer
        : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

/** Concatenate an array of Uint8Array / ArrayBuffer chunks into one Uint8Array. */
function concatChunks(chunks) {
    const views = chunks.map(c => c instanceof Uint8Array ? c : new Uint8Array(c));
    const total = views.reduce((s, v) => s + v.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const v of views) { out.set(v, off); off += v.byteLength; }
    return out;
}

/**
 * Encode RGBA8 pixels to the given MIME type using canvas.convertToBlob().
 * quality: 0–100 mapped to 0.0–1.0 for canvas API.
 */
async function canvasEncode(rgba, w, h, mimeType, quality) {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.putImageData(
        new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), w, h),
        0, 0
    );
    const blob = await canvas.convertToBlob({ type: mimeType, quality: quality / 100 });
    return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Decode compressed image bytes to RGBA8 via createImageBitmap + canvas.
 * Returns { data: Uint8Array, width, height }.
 */
async function bitmapDecode(bytes, mimeType) {
    const blob = new Blob([bytes], { type: mimeType });
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data: new Uint8Array(id.data.buffer), width: canvas.width, height: canvas.height };
}

// ── JXL codec (facade) ───────────────────────────────────────────────────────

async function jxlEncode(rgba, w, h, quality) {
    const encoder = createEncoder({
        format: 'rgba8', width: w, height: h, hasAlpha: true,
        iccProfile: null, exif: null, xmp: null,
        quality, effort: 3,
        progressive: false, previewFirst: false, chunked: false,
    });
    const chunks = [];
    const chunkTask = (async () => {
        for await (const chunk of encoder.chunks()) chunks.push(chunk);
    })();
    await encoder.pushPixels(exactBuffer(rgba));
    await encoder.finish();
    await chunkTask;
    await encoder.dispose();
    return concatChunks(chunks);
}

async function jxlDecode(bytes) {
    const decoder = createDecoder({
        format: 'rgba8',
        progressionTarget: 'final',
        emitEveryPass: false,
        preserveIcc: false,
        preserveMetadata: false,
    });
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    await decoder.push(exactBuffer(u8));
    await decoder.close();
    let pixels = null, width = 0, height = 0;
    for await (const event of decoder.events()) {
        if (event.type === 'final') {
            pixels = event.pixels;
            width = event.info.width;
            height = event.info.height;
        } else if (event.type === 'error') {
            await decoder.dispose();
            throw new Error(`JXL decode error ${event.code}: ${event.message}`);
        }
    }
    await decoder.dispose();
    if (!pixels) throw new Error('JXL decode produced no output');
    const data = pixels instanceof Uint8Array
        ? pixels
        : new Uint8Array(pixels);
    return { data, width, height };
}

// ── Public codec map ─────────────────────────────────────────────────────────

export const codecs = {
    jxl: {
        name: 'JXL',
        mimeType: 'image/jxl',
        encode: (rgba, w, h, quality) => jxlEncode(rgba, w, h, quality),
        decode: (bytes) => jxlDecode(bytes),
    },
    jpeg: {
        name: 'JPEG',
        mimeType: 'image/jpeg',
        encode: (rgba, w, h, quality) => canvasEncode(rgba, w, h, 'image/jpeg', quality),
        decode: (bytes) => bitmapDecode(bytes, 'image/jpeg'),
    },
    avif: {
        name: 'AVIF',
        mimeType: 'image/avif',
        encode: (rgba, w, h, quality) => canvasEncode(rgba, w, h, 'image/avif', quality),
        decode: (bytes) => bitmapDecode(bytes, 'image/avif'),
    },
    webp: {
        name: 'WebP',
        mimeType: 'image/webp',
        encode: (rgba, w, h, quality) => canvasEncode(rgba, w, h, 'image/webp', quality),
        decode: (bytes) => bitmapDecode(bytes, 'image/webp'),
    },
};
