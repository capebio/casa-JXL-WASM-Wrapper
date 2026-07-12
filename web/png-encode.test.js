// png-encode.test.js — real PNG encoder used for the honest PNG export option
// (finding 13 / I-B).  Verifies a valid PNG signature + lossless round-trip.

import { expect, test, describe } from 'bun:test';
import { encodePng, decodePngToRgba } from './png-encode.js';

const SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

function makeRgb(w, h) {
    const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < px.length; i++) px[i] = (i * 11) & 0xFF;
    return px;
}
function makeRgba(w, h) {
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        px[i * 4] = (i * 3) & 0xFF; px[i * 4 + 1] = (i * 5) & 0xFF;
        px[i * 4 + 2] = (i * 7) & 0xFF; px[i * 4 + 3] = (i * 13) & 0xFF;
    }
    return px;
}

describe('encodePng', () => {
    test('emits a valid PNG signature', async () => {
        const png = await encodePng(makeRgb(8, 8), 8, 8, 'rgb8');
        expect(Array.from(png.slice(0, 8))).toEqual(SIG);
    });

    test('rgb8 round-trips losslessly (alpha filled to 255)', async () => {
        const W = 16, H = 10;
        const rgb = makeRgb(W, H);
        const dec = await decodePngToRgba(await encodePng(rgb, W, H, 'rgb8'));
        expect(dec.width).toBe(W);
        expect(dec.height).toBe(H);
        for (let i = 0; i < W * H; i++) {
            expect(dec.pixels[i * 4]).toBe(rgb[i * 3]);
            expect(dec.pixels[i * 4 + 1]).toBe(rgb[i * 3 + 1]);
            expect(dec.pixels[i * 4 + 2]).toBe(rgb[i * 3 + 2]);
            expect(dec.pixels[i * 4 + 3]).toBe(255);
        }
    });

    test('rgba8 round-trips losslessly including alpha', async () => {
        const W = 12, H = 9;
        const rgba = makeRgba(W, H);
        const dec = await decodePngToRgba(await encodePng(rgba, W, H, 'rgba8'));
        expect(dec.width).toBe(W);
        expect(dec.height).toBe(H);
        expect(dec.pixels).toEqual(rgba);
    });

    test('throws when the pixel buffer is too small', async () => {
        await expect(encodePng(new Uint8Array(10), 100, 100, 'rgb8')).rejects.toThrow(/too small/);
    });
});
