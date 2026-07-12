// exif-serialize.test.js — the EXIF writer/reader used to carry the metadata
// privacy policy into the export bytes (finding 44 / I-C).

import { expect, test, describe } from 'bun:test';
import { serializeExif, parseExif } from './exif-serialize.js';

describe('serializeExif / parseExif', () => {
    const base = {
        make: 'Olympus', model: 'OM-5', datetime: '2026:07:11 10:30:00',
        iso: 400, orientation: 6, focalLength35: 50,
        exposure: { n: 1, d: 200 }, fnumber: { n: 28, d: 10 },
        focalLength: { n: 25, d: 1 }, lens: 'M.Zuiko 12-40mm',
        gps: { lat: 51.5074, lon: -0.1278, alt: 35 },
    };

    test('returns null for null/empty input', () => {
        expect(serializeExif(null)).toBeNull();
        expect(serializeExif({})).toBeNull();
    });

    test('produces a valid little-endian TIFF header', () => {
        const b = serializeExif(base);
        expect(b).toBeInstanceOf(Uint8Array);
        expect(b[0]).toBe(0x49); // 'I'
        expect(b[1]).toBe(0x49); // 'I' → little-endian
        expect(b[2]).toBe(0x2A); // magic low
        expect(b[3]).toBe(0x00); // magic high
    });

    test('round-trips make/model as ASCII', () => {
        const p = parseExif(serializeExif(base));
        expect(p.make).toBe('Olympus');
        expect(p.model).toBe('OM-5');
    });

    test('writes a GPS IFD when gps is present', () => {
        const p = parseExif(serializeExif(base));
        expect(p.gpsPointerPresent).toBe(true);
        expect(p.hasGps).toBe(true);
    });

    test('omits GPS entirely when gps is null', () => {
        const p = parseExif(serializeExif({ ...base, gps: null }));
        expect(p.gpsPointerPresent).toBe(false);
        expect(p.hasGps).toBe(false);
        expect(p.ifd0Tags).not.toContain(0x8825);
        // Non-GPS fields survive.
        expect(p.make).toBe('Olympus');
    });

    test('handles a GPS-only exif (no camera identity)', () => {
        const p = parseExif(serializeExif({ orientation: 1, gps: { lat: 10, lon: 20, alt: 0 } }));
        expect(p.hasGps).toBe(true);
        expect(p.make).toBeNull();
    });

    test('ignores non-finite / zero-denominator rationals gracefully', () => {
        const b = serializeExif({ make: 'X', iso: 100, exposure: { n: 1, d: 0 }, fnumber: null });
        expect(b).toBeInstanceOf(Uint8Array);
        const p = parseExif(b);
        expect(p.make).toBe('X');
    });
});
