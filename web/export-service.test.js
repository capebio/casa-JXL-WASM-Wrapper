// export-service.test.js
// TDD tests for web/export-service.js — full-resolution Export Selected +
// metadata policy (keep/strip-gps/strip-all) + format/bit-depth reporting.
//
// Findings: 13 (P0 — Export Selected unwired / preview bytes), 44 (metadata
// absent from export), 45 (hardcoded "ORF (Olympus 12-bit)" format/bit-depth).
//
// Run with: bun test web/export-service.test.js

import { expect, test, describe, beforeEach } from 'bun:test';
import {
    ExportService,
    applyMetadataPolicy,
    formatLabel,
    deriveOutputFilename,
} from './export-service.js';

// ---------------------------------------------------------------------------
// Helpers: minimal stubs that satisfy ExportService without a browser
// ---------------------------------------------------------------------------

/**
 * Build a minimal per-card state stub that resembles what main.js holds.
 * - exif.format + exif.bitDepth come from the worker (finding 44/45 fix)
 * - _blobUrl is the JXL bytes URL (finding 13: must NOT be exported as-is for
 *   non-JXL outputs; we need full-res pixels)
 */
function makeCardState({
    assetId = 'asset-a',
    name    = 'IMG_0001.ORF',
    blobUrl = 'blob:test/jxl-1',
    exif    = null,
    lightbox = null,  // { rgb, w, h, orientation }
    orientation = 1,
    file    = null,
} = {}) {
    return {
        _assetId: assetId,
        _file: file ?? { name, size: 1000, lastModified: 1000 },
        _blobUrl: blobUrl,
        _exif: exif,
        _lightbox: lightbox,
        _thumbOrientation: orientation,
    };
}

/**
 * Minimal encoder stub: records calls and returns fake JXL bytes.
 */
function makeEncoder(failAssetIds = new Set()) {
    const calls = [];
    async function encode(pixels, width, height, format, orientation, outputFormat) {
        calls.push({ width, height, format, orientation, outputFormat });
        const assetId = calls.length.toString(); // positional
        return new Uint8Array([0xFF, 0x0A, calls.length]); // fake bytes
    }
    encode.calls = calls;
    return encode;
}

/**
 * Encoder that fails for specific asset IDs (for partial-failure tests).
 */
function makePartialEncoder(failOnNthCall) {
    const calls = [];
    async function encode(pixels, width, height, format, orientation, outputFormat) {
        calls.push({ width, height, format, orientation, outputFormat });
        if (calls.length === failOnNthCall) throw new Error('encode failed');
        return new Uint8Array([0xFF, 0x0A, calls.length]);
    }
    encode.calls = calls;
    return encode;
}

// ---------------------------------------------------------------------------
// 1. formatLabel — finding 45: real format + bit-depth display
// ---------------------------------------------------------------------------

describe('formatLabel: real format + bit-depth (finding 45)', () => {
    test('returns ORF label when exif.format is ORF', () => {
        const label = formatLabel({ format: 'ORF', bitDepth: 12 });
        expect(label).toBe('ORF (12-bit)');
    });

    test('returns DNG label with bit depth', () => {
        expect(formatLabel({ format: 'DNG', bitDepth: 14 })).toBe('DNG (14-bit)');
    });

    test('returns CR2 with bit depth', () => {
        expect(formatLabel({ format: 'CR2', bitDepth: 14 })).toBe('CR2 (14-bit)');
    });

    test('returns format without bit depth when bitDepth absent', () => {
        expect(formatLabel({ format: 'TIFF', bitDepth: null })).toBe('TIFF');
    });

    test('returns format without bit depth when bitDepth is 0', () => {
        expect(formatLabel({ format: 'EXR', bitDepth: 0 })).toBe('EXR');
    });

    test('returns "Unknown" when exif is null', () => {
        expect(formatLabel(null)).toBe('Unknown');
    });

    test('returns "Unknown" when format is absent', () => {
        expect(formatLabel({})).toBe('Unknown');
    });

    test('JPEG at 8-bit shows correctly', () => {
        expect(formatLabel({ format: 'JPEG', bitDepth: 8 })).toBe('JPEG (8-bit)');
    });

    test('format label is NOT the hardcoded "ORF (Olympus 12-bit)" string', () => {
        const label = formatLabel({ format: 'ORF', bitDepth: 12 });
        expect(label).not.toBe('ORF (Olympus 12-bit)');
        expect(label).toBe('ORF (12-bit)');
    });
});

// ---------------------------------------------------------------------------
// 2. applyMetadataPolicy — finding 44: GPS stripped when policy says so
// ---------------------------------------------------------------------------

describe('applyMetadataPolicy: GPS and EXIF stripping (finding 44)', () => {
    const fullExif = {
        make: 'Olympus', model: 'OM-5', lens: '12-40mm',
        datetime: '2026:07:11 10:30:00',
        exposure: { n: 1, d: 200 }, fnumber: { n: 28, d: 10 },
        focalLength: { n: 25, d: 1 }, focalLength35: 50,
        iso: 400,
        orientation: 1,
        gps: { lat: 51.5, lon: -0.12, alt: 10 },
        quality: 4,
        wbMode: 0, wbR: 1.1, wbB: 0.8, wbFromCamera: true,
        width: 5184, height: 3888,
        format: 'ORF', bitDepth: 12,
    };

    test('"keep" policy returns exif unchanged', () => {
        const result = applyMetadataPolicy(fullExif, 'keep');
        expect(result).toEqual(fullExif);
        expect(result.gps).not.toBeNull();
    });

    test('"strip-gps" removes gps field', () => {
        const result = applyMetadataPolicy(fullExif, 'strip-gps');
        expect(result.gps).toBeNull();
    });

    test('"strip-gps" preserves all other EXIF fields', () => {
        const result = applyMetadataPolicy(fullExif, 'strip-gps');
        expect(result.make).toBe('Olympus');
        expect(result.model).toBe('OM-5');
        expect(result.datetime).toBe('2026:07:11 10:30:00');
        expect(result.iso).toBe(400);
        expect(result.orientation).toBe(1);
        expect(result.format).toBe('ORF');
        expect(result.bitDepth).toBe(12);
    });

    test('"strip-all" returns only width, height, orientation, format, bitDepth', () => {
        const result = applyMetadataPolicy(fullExif, 'strip-all');
        // Allowed technical fields
        expect(result.width).toBe(5184);
        expect(result.height).toBe(3888);
        expect(result.orientation).toBe(1);
        expect(result.format).toBe('ORF');
        expect(result.bitDepth).toBe(12);
        // Privacy-sensitive stripped
        expect(result.gps).toBeNull();
        expect(result.make).toBeNull();
        expect(result.model).toBeNull();
        expect(result.datetime).toBeNull();
        expect(result.lens).toBeNull();
        expect(result.iso).toBeNull();
    });

    test('"strip-all" GPS is null (not merely undefined)', () => {
        const result = applyMetadataPolicy(fullExif, 'strip-all');
        // null = explicitly absent, not undefined = "maybe present"
        expect(result.gps).toBeNull();
    });

    test('"keep" on null exif returns null', () => {
        expect(applyMetadataPolicy(null, 'keep')).toBeNull();
    });

    test('"strip-gps" on exif with no gps is a no-op', () => {
        const noGps = { ...fullExif, gps: null };
        const result = applyMetadataPolicy(noGps, 'strip-gps');
        expect(result.gps).toBeNull();
        expect(result.make).toBe('Olympus');
    });

    test('does not mutate the original exif object', () => {
        const original = { ...fullExif };
        applyMetadataPolicy(fullExif, 'strip-gps');
        expect(fullExif.gps).toEqual(original.gps); // unchanged
    });
});

// ---------------------------------------------------------------------------
// 3. deriveOutputFilename — collision handling
// ---------------------------------------------------------------------------

describe('deriveOutputFilename: filename derivation + collision handling', () => {
    test('replaces raw extension with output format extension', () => {
        expect(deriveOutputFilename('IMG_0001.ORF', 'jxl')).toBe('IMG_0001.jxl');
    });

    test('replaces .CR2 with .jpeg for jpeg output', () => {
        expect(deriveOutputFilename('P1000001.CR2', 'jpeg')).toBe('P1000001.jpeg');
    });

    test('replaces .DNG with .png for png output', () => {
        expect(deriveOutputFilename('DSCF0001.DNG', 'png')).toBe('DSCF0001.png');
    });

    test('replaces .tif with .tiff for tiff output', () => {
        expect(deriveOutputFilename('scan.tif', 'tiff')).toBe('scan.tiff');
    });

    test('handles lowercase extension', () => {
        expect(deriveOutputFilename('img.orf', 'jxl')).toBe('img.jxl');
    });

    test('deduplicates against an existing set by appending -N suffix', () => {
        const existing = new Set(['IMG_0001.jxl']);
        expect(deriveOutputFilename('IMG_0001.ORF', 'jxl', existing)).toBe('IMG_0001-2.jxl');
    });

    test('deduplication increments to next free slot', () => {
        const existing = new Set(['IMG_0001.jxl', 'IMG_0001-2.jxl']);
        expect(deriveOutputFilename('IMG_0001.ORF', 'jxl', existing)).toBe('IMG_0001-3.jxl');
    });

    test('no collision when set is empty', () => {
        const existing = new Set();
        expect(deriveOutputFilename('IMG_0001.ORF', 'jxl', existing)).toBe('IMG_0001.jxl');
    });

    test('null existing set means no dedup (returns base name)', () => {
        expect(deriveOutputFilename('A.ORF', 'jxl', null)).toBe('A.jxl');
    });
});

// ---------------------------------------------------------------------------
// 4. ExportService — finding 13: single entry point, full-resolution
// ---------------------------------------------------------------------------

describe('ExportService: construction and API contract', () => {
    test('ExportService can be instantiated', () => {
        const svc = new ExportService({ getCardStateByAssetId: () => null });
        expect(svc).toBeTruthy();
        expect(typeof svc.export).toBe('function');
        expect(typeof svc.cancel).toBe('function');
    });

    test('export() returns an AsyncIterable of progress/result events', async () => {
        const state = makeCardState({
            exif: { format: 'ORF', bitDepth: 12, orientation: 1, gps: null,
                    width: 100, height: 80 },
            lightbox: { rgb: new Uint8Array(100 * 80 * 3), w: 100, h: 80, orientation: 1 },
        });
        const encoder = makeEncoder();
        const svc = new ExportService({
            getCardStateByAssetId: (id) => id === 'asset-a' ? state : null,
            encodePixels: encoder,
        });
        const req = {
            assetIds: ['asset-a'],
            output: 'jxl',
            metadata: 'keep',
            resolution: 'full',
        };
        const events = [];
        for await (const ev of svc.export(req)) {
            events.push(ev);
        }
        expect(events.length).toBeGreaterThan(0);
        const done = events.find(e => e.type === 'done' && e.assetId === 'asset-a');
        expect(done).toBeTruthy();
    });
});

describe('ExportService: multi-select order preserved (finding 13)', () => {
    test('results arrive in the same order as assetIds input', async () => {
        function makeState(id) {
            return makeCardState({
                assetId: id,
                name: id + '.ORF',
                exif: { format: 'ORF', bitDepth: 12, orientation: 1, gps: null, width: 10, height: 10 },
                lightbox: { rgb: new Uint8Array(10 * 10 * 3), w: 10, h: 10, orientation: 1 },
            });
        }
        const states = { 'a': makeState('a'), 'b': makeState('b'), 'c': makeState('c') };
        const encoder = makeEncoder();
        const svc = new ExportService({
            getCardStateByAssetId: (id) => states[id] ?? null,
            encodePixels: encoder,
        });
        const req = {
            assetIds: ['a', 'b', 'c'],
            output: 'jxl',
            metadata: 'keep',
            resolution: 'full',
        };
        const doneEvents = [];
        for await (const ev of svc.export(req)) {
            if (ev.type === 'done') doneEvents.push(ev.assetId);
        }
        expect(doneEvents).toEqual(['a', 'b', 'c']);
    });
});

describe('ExportService: full-resolution pixels, not preview (finding 13)', () => {
    test('exported dimensions equal the full-res lightbox pixels, not a preview', async () => {
        // Full sensor: 4608×3456
        // Preview (lightbox canvas long edge 1800): would be 1800×1350
        const W = 4608, H = 3456;
        const state = makeCardState({
            exif: { format: 'ORF', bitDepth: 12, orientation: 1, gps: null, width: W, height: H },
            lightbox: { rgb: new Uint8Array(W * H * 3), w: W, h: H, orientation: 1 },
        });
        const encoder = makeEncoder();
        const svc = new ExportService({
            getCardStateByAssetId: () => state,
            encodePixels: encoder,
        });
        const req = {
            assetIds: ['asset-a'],
            output: 'jxl',
            metadata: 'keep',
            resolution: 'full',
        };
        for await (const ev of svc.export(req)) { /* consume */ }
        // The encoder must have been called with full sensor dimensions
        expect(encoder.calls.length).toBe(1);
        expect(encoder.calls[0].width).toBe(W);
        expect(encoder.calls[0].height).toBe(H);
        // Importantly, NOT 1800 or 1350
        expect(encoder.calls[0].width).not.toBe(1800);
    });
});

describe('ExportService: orientation preserved', () => {
    test('orientation from exif is passed to the encoder', async () => {
        const state = makeCardState({
            exif: { format: 'ORF', bitDepth: 12, orientation: 6, gps: null, width: 50, height: 40 },
            lightbox: { rgb: new Uint8Array(50 * 40 * 3), w: 50, h: 40, orientation: 6 },
        });
        const encoder = makeEncoder();
        const svc = new ExportService({
            getCardStateByAssetId: () => state,
            encodePixels: encoder,
        });
        for await (const _ of svc.export({
            assetIds: ['asset-a'], output: 'jxl', metadata: 'keep', resolution: 'full',
        })) {}
        expect(encoder.calls[0].orientation).toBe(6);
    });
});

describe('ExportService: metadata policy end-to-end (finding 44)', () => {
    test('"keep" policy: GPS survives in the result exif', async () => {
        const state = makeCardState({
            exif: { format: 'ORF', bitDepth: 12, orientation: 1,
                    gps: { lat: 51.5, lon: -0.12, alt: 10 }, width: 20, height: 20 },
            lightbox: { rgb: new Uint8Array(20 * 20 * 3), w: 20, h: 20, orientation: 1 },
        });
        const encoder = makeEncoder();
        const svc = new ExportService({
            getCardStateByAssetId: () => state,
            encodePixels: encoder,
        });
        const events = [];
        for await (const ev of svc.export({
            assetIds: ['asset-a'], output: 'jxl', metadata: 'keep', resolution: 'full',
        })) { events.push(ev); }
        const done = events.find(e => e.type === 'done');
        expect(done.exif.gps).not.toBeNull();
        expect(done.exif.gps.lat).toBeCloseTo(51.5);
    });

    test('"strip-gps" policy: GPS absent from result exif', async () => {
        const state = makeCardState({
            exif: { format: 'ORF', bitDepth: 12, orientation: 1,
                    gps: { lat: 51.5, lon: -0.12, alt: 10 }, width: 20, height: 20 },
            lightbox: { rgb: new Uint8Array(20 * 20 * 3), w: 20, h: 20, orientation: 1 },
        });
        const encoder = makeEncoder();
        const svc = new ExportService({
            getCardStateByAssetId: () => state,
            encodePixels: encoder,
        });
        const events = [];
        for await (const ev of svc.export({
            assetIds: ['asset-a'], output: 'jxl', metadata: 'strip-gps', resolution: 'full',
        })) { events.push(ev); }
        const done = events.find(e => e.type === 'done');
        expect(done.exif.gps).toBeNull();
    });

    test('"strip-all" policy: no camera/GPS/datetime in result exif', async () => {
        const state = makeCardState({
            exif: { format: 'ORF', bitDepth: 12, orientation: 1,
                    make: 'Olympus', model: 'OM-5',
                    datetime: '2026:07:11 10:30:00',
                    gps: { lat: 51.5, lon: -0.12, alt: 10 },
                    iso: 400, width: 20, height: 20 },
            lightbox: { rgb: new Uint8Array(20 * 20 * 3), w: 20, h: 20, orientation: 1 },
        });
        const encoder = makeEncoder();
        const svc = new ExportService({
            getCardStateByAssetId: () => state,
            encodePixels: encoder,
        });
        const events = [];
        for await (const ev of svc.export({
            assetIds: ['asset-a'], output: 'jxl', metadata: 'strip-all', resolution: 'full',
        })) { events.push(ev); }
        const done = events.find(e => e.type === 'done');
        expect(done.exif.gps).toBeNull();
        expect(done.exif.make).toBeNull();
        expect(done.exif.model).toBeNull();
        expect(done.exif.datetime).toBeNull();
        expect(done.exif.iso).toBeNull();
    });
});

describe('ExportService: progress events', () => {
    test('emits "progress" events before "done"', async () => {
        const state = makeCardState({
            exif: { format: 'ORF', bitDepth: 12, orientation: 1, gps: null, width: 10, height: 10 },
            lightbox: { rgb: new Uint8Array(10 * 10 * 3), w: 10, h: 10, orientation: 1 },
        });
        const encoder = makeEncoder();
        const svc = new ExportService({
            getCardStateByAssetId: () => state,
            encodePixels: encoder,
        });
        const types = [];
        for await (const ev of svc.export({
            assetIds: ['asset-a'], output: 'jxl', metadata: 'keep', resolution: 'full',
        })) { types.push(ev.type); }
        expect(types).toContain('progress');
        expect(types).toContain('done');
        // progress must come before done for the same asset
        const piFirst = types.indexOf('progress');
        const doneFirst = types.indexOf('done');
        expect(piFirst).toBeLessThan(doneFirst);
    });

    test('progress event carries assetId and phase', async () => {
        const state = makeCardState({
            exif: { format: 'ORF', bitDepth: 12, orientation: 1, gps: null, width: 10, height: 10 },
            lightbox: { rgb: new Uint8Array(10 * 10 * 3), w: 10, h: 10, orientation: 1 },
        });
        const encoder = makeEncoder();
        const svc = new ExportService({
            getCardStateByAssetId: () => state,
            encodePixels: encoder,
        });
        let firstProgress = null;
        for await (const ev of svc.export({
            assetIds: ['asset-a'], output: 'jxl', metadata: 'keep', resolution: 'full',
        })) {
            if (ev.type === 'progress' && !firstProgress) firstProgress = ev;
        }
        expect(firstProgress).toBeTruthy();
        expect(firstProgress.assetId).toBe('asset-a');
        expect(typeof firstProgress.phase).toBe('string');
    });
});

describe('ExportService: partial failure (one asset fails, others continue)', () => {
    test('error for one asset does not prevent others from completing', async () => {
        function makeState(id, shouldFail = false) {
            return makeCardState({
                assetId: id,
                name: id + '.ORF',
                exif: { format: 'ORF', bitDepth: 12, orientation: 1, gps: null, width: 10, height: 10 },
                lightbox: shouldFail
                    ? null   // missing lightbox triggers failure in the service
                    : { rgb: new Uint8Array(10 * 10 * 3), w: 10, h: 10, orientation: 1 },
            });
        }
        const states = {
            'ok-1': makeState('ok-1', false),
            'fail': makeState('fail', true),  // no lightbox → error
            'ok-2': makeState('ok-2', false),
        };
        const encoder = makeEncoder();
        const svc = new ExportService({
            getCardStateByAssetId: (id) => states[id] ?? null,
            encodePixels: encoder,
        });
        const events = [];
        for await (const ev of svc.export({
            assetIds: ['ok-1', 'fail', 'ok-2'],
            output: 'jxl', metadata: 'keep', resolution: 'full',
        })) { events.push(ev); }

        const errors  = events.filter(e => e.type === 'error');
        const dones   = events.filter(e => e.type === 'done');
        expect(errors.length).toBe(1);
        expect(errors[0].assetId).toBe('fail');
        expect(dones.length).toBe(2);
        expect(dones.map(e => e.assetId)).toContain('ok-1');
        expect(dones.map(e => e.assetId)).toContain('ok-2');
    });
});

describe('ExportService: cancel', () => {
    test('cancel() stops processing after the current asset', async () => {
        // Ten assets, cancel after the first done — remaining should not emit done.
        const states = {};
        for (let i = 0; i < 10; i++) {
            const id = `a${i}`;
            states[id] = makeCardState({
                assetId: id, name: id + '.ORF',
                exif: { format: 'ORF', bitDepth: 12, orientation: 1, gps: null, width: 5, height: 5 },
                lightbox: { rgb: new Uint8Array(5 * 5 * 3), w: 5, h: 5, orientation: 1 },
            });
        }
        let slowEncoder_calls = 0;
        async function slowEncoder(pixels, w, h, format, orientation, outputFormat) {
            slowEncoder_calls++;
            return new Uint8Array([0xFF]);
        }
        const svc = new ExportService({
            getCardStateByAssetId: (id) => states[id] ?? null,
            encodePixels: slowEncoder,
        });
        const req = {
            assetIds: Object.keys(states),
            output: 'jxl', metadata: 'keep', resolution: 'full',
        };
        let doneCount = 0;
        for await (const ev of svc.export(req)) {
            if (ev.type === 'done') {
                doneCount++;
                if (doneCount === 1) svc.cancel();
            }
        }
        // Cancel was called after asset 0; at most a couple more may have started
        // (depends on concurrency) but not all 10 should complete.
        expect(doneCount).toBeLessThan(10);
    });
});

describe('ExportService: filename collision handling', () => {
    test('two assets with same basename get distinct output filenames', async () => {
        function makeState(id, name) {
            return makeCardState({
                assetId: id, name,
                exif: { format: 'ORF', bitDepth: 12, orientation: 1, gps: null, width: 10, height: 10 },
                lightbox: { rgb: new Uint8Array(10 * 10 * 3), w: 10, h: 10, orientation: 1 },
            });
        }
        const states = {
            'id-1': makeState('id-1', 'photo.ORF'),
            'id-2': makeState('id-2', 'photo.ORF'),
        };
        const encoder = makeEncoder();
        const svc = new ExportService({
            getCardStateByAssetId: (id) => states[id] ?? null,
            encodePixels: encoder,
        });
        const filenames = [];
        for await (const ev of svc.export({
            assetIds: ['id-1', 'id-2'], output: 'jxl', metadata: 'keep', resolution: 'full',
        })) {
            if (ev.type === 'done') filenames.push(ev.filename);
        }
        expect(filenames.length).toBe(2);
        expect(filenames[0]).not.toBe(filenames[1]);
        expect(filenames[0]).toBe('photo.jxl');
        expect(filenames[1]).toBe('photo-2.jxl');
    });
});

describe('ExportService: missing asset state', () => {
    test('emits error for unknown assetId without crashing', async () => {
        const encoder = makeEncoder();
        const svc = new ExportService({
            getCardStateByAssetId: () => null,  // all unknown
            encodePixels: encoder,
        });
        const events = [];
        for await (const ev of svc.export({
            assetIds: ['ghost'], output: 'jxl', metadata: 'keep', resolution: 'full',
        })) { events.push(ev); }
        expect(events.some(e => e.type === 'error' && e.assetId === 'ghost')).toBe(true);
    });
});

describe('ExportService: done event contract', () => {
    test('done event includes filename, bytes, exif, and assetId', async () => {
        const state = makeCardState({
            exif: { format: 'ORF', bitDepth: 12, orientation: 1, gps: null,
                    width: 10, height: 10, make: 'Olympus', model: 'OM-5' },
            lightbox: { rgb: new Uint8Array(10 * 10 * 3), w: 10, h: 10, orientation: 1 },
        });
        const encoder = makeEncoder();
        const svc = new ExportService({
            getCardStateByAssetId: () => state,
            encodePixels: encoder,
        });
        let doneEv = null;
        for await (const ev of svc.export({
            assetIds: ['asset-a'], output: 'jxl', metadata: 'keep', resolution: 'full',
        })) { if (ev.type === 'done') doneEv = ev; }
        expect(doneEv).toBeTruthy();
        expect(doneEv.assetId).toBe('asset-a');
        expect(doneEv.filename).toBeTruthy();
        expect(doneEv.filename).toMatch(/\.jxl$/);
        expect(doneEv.bytes).toBeInstanceOf(Uint8Array);
        expect(doneEv.bytes.length).toBeGreaterThan(0);
        expect(doneEv.exif).toBeTruthy();
    });

    test('output format extension matches the requested output type', async () => {
        for (const outputFmt of ['jxl', 'jpeg', 'png', 'tiff']) {
            const state = makeCardState({
                exif: { format: 'ORF', bitDepth: 12, orientation: 1, gps: null, width: 5, height: 5 },
                lightbox: { rgb: new Uint8Array(5 * 5 * 3), w: 5, h: 5, orientation: 1 },
            });
            const encoder = makeEncoder();
            const svc = new ExportService({
                getCardStateByAssetId: () => state,
                encodePixels: encoder,
            });
            let doneEv = null;
            for await (const ev of svc.export({
                assetIds: ['asset-a'], output: outputFmt, metadata: 'keep', resolution: 'full',
            })) { if (ev.type === 'done') doneEv = ev; }
            expect(doneEv.filename).toMatch(new RegExp(`\\.${outputFmt === 'jpeg' ? 'jpeg' : outputFmt}$`));
        }
    });
});
