// png-encode.js — minimal, browser-safe PNG encoder for full-res export
// (finding 13 / I-B).
//
// The export "PNG" option previously produced JXL bytes inside a .png file
// (encodePixels ignored outputFmt).  This encodes REAL PNG bytes from a full-res
// RGB8/RGBA8 buffer so the extension and MIME are honest.
//
// Uses the WHATWG CompressionStream('deflate') (zlib wrapper) — available in
// modern browsers AND in the bun/Node test runtime — so no Node built-ins and
// no WASM.  8-bit only (the app's developed output is 8-bit RGB/RGBA); 16-bit
// PNG export is packet-3 scope.
//
// A matching `decodePngToRgba` is provided for round-trip tests.

'use strict';

const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

// --- CRC32 (PNG polynomial) -------------------------------------------------
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

async function deflate(u8) {
    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    writer.write(u8);
    writer.close();
    return await collect(cs.readable);
}
async function inflate(u8) {
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    writer.write(u8);
    writer.close();
    return await collect(ds.readable);
}
async function collect(readable) {
    const reader = readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); total += value.length;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
}

function chunk(type, data) {
    // 4-byte length | type | data | crc32(type+data)
    const typeBytes = Uint8Array.from([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]);
    const body = new Uint8Array(typeBytes.length + data.length);
    body.set(typeBytes, 0);
    body.set(data, typeBytes.length);
    const out = new Uint8Array(4 + body.length + 4);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(body, 4);
    dv.setUint32(4 + body.length, crc32(body));
    return out;
}

/**
 * Encode a packed RGB8 or RGBA8 buffer as PNG bytes.
 *
 * @param {Uint8Array} pixels  packed, row-major, top-to-bottom
 * @param {number} width
 * @param {number} height
 * @param {'rgb8'|'rgba8'} format
 * @returns {Promise<Uint8Array>}
 */
export async function encodePng(pixels, width, height, format = 'rgb8') {
    const channels = format === 'rgba8' ? 4 : 3;
    const colorType = channels === 4 ? 6 : 2; // 6=RGBA, 2=RGB
    const expected = width * height * channels;
    if (pixels.length < expected) {
        throw new Error(`encodePng: pixel buffer too small (${pixels.length} < ${expected})`);
    }

    // Raw filtered scanlines: filter byte 0 (None) per row.
    const stride = width * channels;
    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0; // filter: None
        raw.set(pixels.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
    }
    const idat = await deflate(raw);

    // IHDR
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr[8] = 8;          // bit depth
    ihdr[9] = colorType;  // 2=RGB, 6=RGBA
    ihdr[10] = 0;         // compression
    ihdr[11] = 0;         // filter
    ihdr[12] = 0;         // interlace

    const parts = [
        Uint8Array.from(PNG_SIG),
        chunk('IHDR', ihdr),
        chunk('IDAT', idat),
        chunk('IEND', new Uint8Array(0)),
    ];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
}

/**
 * Decode a PNG produced by `encodePng` back to RGBA8 (for round-trip tests).
 * Supports only filter-None, 8-bit RGB/RGBA, no interlace (what encodePng emits).
 *
 * @param {Uint8Array} png
 * @returns {Promise<{ width: number, height: number, pixels: Uint8Array }>}  pixels are RGBA8
 */
export async function decodePngToRgba(png) {
    for (let i = 0; i < 8; i++) if (png[i] !== PNG_SIG[i]) throw new Error('decodePng: bad signature');
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
    let p = 8;
    let width = 0, height = 0, colorType = 0;
    const idatParts = [];
    while (p < png.length) {
        const len = dv.getUint32(p);
        const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
        const dataStart = p + 8;
        if (type === 'IHDR') {
            width = dv.getUint32(dataStart);
            height = dv.getUint32(dataStart + 4);
            colorType = png[dataStart + 9];
        } else if (type === 'IDAT') {
            idatParts.push(png.subarray(dataStart, dataStart + len));
        } else if (type === 'IEND') {
            break;
        }
        p = dataStart + len + 4; // skip data + crc
    }
    const channels = colorType === 6 ? 4 : 3;
    let idatTotal = 0;
    for (const c of idatParts) idatTotal += c.length;
    const idat = new Uint8Array(idatTotal);
    { let off = 0; for (const c of idatParts) { idat.set(c, off); off += c.length; } }
    const raw = await inflate(idat);

    const stride = width * channels;
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        if (filter !== 0) throw new Error(`decodePng: unsupported filter ${filter}`);
        const rowStart = y * (stride + 1) + 1;
        for (let x = 0; x < width; x++) {
            const si = rowStart + x * channels;
            const di = (y * width + x) * 4;
            rgba[di]     = raw[si];
            rgba[di + 1] = raw[si + 1];
            rgba[di + 2] = raw[si + 2];
            rgba[di + 3] = channels === 4 ? raw[si + 3] : 255;
        }
    }
    return { width, height, pixels: rgba };
}
