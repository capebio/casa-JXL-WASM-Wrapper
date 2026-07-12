// export-service.test.js
// TDD tests for web/export-service.js — REAL data-path export:
//   I-A (finding 13, P0): export the FULL-RESOLUTION DEVELOPED OUTPUT (not the
//       1800px _lightbox preview).  Tests source full-res from the developed
//       output (getDevelopedOutput), NOT a hand-built _lightbox.
//   I-B (finding 13/formats): never emit a mislabeled file.  JXL + PNG genuinely
//       encode; JPEG/TIFF are gated.  PNG bytes round-trip through a real decoder.
//   I-C (finding 44): the metadata privacy policy is serialised to EXIF bytes and
//       threaded into the encoder; GPS is ABSENT under strip-gps (proven by
//       decoding the serialised EXIF).
//   Finding 45: real format + bit-depth label (kept).
//
// The full-res + metadata-carry + format-gating tests exercise the REAL path:
// they drive the developed-output source and a REAL PNG encoder + REAL EXIF
// serializer/parser, not fabricated fixtures.  The libjxl WASM encoder cannot
// run under `bun test` (its Emscripten worker terminates — see
// jxl-bridge-orientation.test.js), so JXL bytes use the pass-through path (real
// developed bytes) and metadata is asserted on the serialised EXIF bytes.
//
// Run with: bun test web/export-service.test.js

import { expect, test, describe } from 'bun:test';
import {
    ExportService,
    applyMetadataPolicy,
    serializeMetadata,
    formatLabel,
    deriveOutputFilename,
    isFormatEncodable,
    ENCODABLE_FORMATS,
    GATED_FORMATS,
} from './export-service.js';
import { serializeExif, parseExif } from './exif-serialize.js';
import { encodePng, decodePngToRgba } from './png-encode.js';

// ---------------------------------------------------------------------------
// Real developed-output fixtures.  A "developed output" is the full-res
// developed JXL for an asset: { jxlBytes, w, h } at FULL sensor dims.  For the
// tests we use recognisable placeholder bytes for the JXL blob (pass-through
// asserts on identity, not JXL decoding) and a REAL full-res RGBA buffer that
// the re-encode path decodes to.
// ---------------------------------------------------------------------------

const FULL_W = 4608, FULL_H = 3456;      // full sensor
const PREVIEW_W = 1800, PREVIEW_H = 1350; // what _lightbox would hold (must NOT appear)

/** Deterministic full-res RGBA buffer (what a real developed JXL decodes to). */
function makeFullResRgba(w, h) {
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        px[i * 4]     = (i * 3) & 0xFF;
        px[i * 4 + 1] = (i * 5) & 0xFF;
        px[i * 4 + 2] = (i * 7) & 0xFF;
        px[i * 4 + 3] = 255;
    }
    return px;
}

/** Recognisable "developed JXL" bytes for the pass-through identity assertion. */
function makeDevelopedJxlBytes(seed = 1) {
    // Real JXL container magic (0xFF 0x0A) + a marker so we can assert identity.
    return Uint8Array.from([0xFF, 0x0A, seed, 0xDE, 0xAD, 0xBE, 0xEF]);
}

/** Card state as main.js holds it (exif + _file). NOTE: no fabricated full _lightbox. */
function makeCardState({
    name = 'IMG_0001.ORF',
    exif = null,
    file = null,
} = {}) {
    return {
        _file: file ?? { name, size: 1000, lastModified: 1000 },
        _exif: exif,
        // A preview-sized _lightbox may exist on real cards — deliberately set it
        // to the PREVIEW dims to prove the service does NOT read it for export.
        _lightbox: { rgb: new Uint8Array(PREVIEW_W * PREVIEW_H * 3), w: PREVIEW_W, h: PREVIEW_H, orientation: 1 },
    };
}

/**
 * Build a full set of injected capabilities backed by a per-asset developed
 * output map.  decodeFullRes returns the FULL-RES RGBA; encodePixels routes to
 * the real PNG encoder for png, and records metadata bytes for assertion.
 */
function makeCaps({
    developed = {},         // assetId -> { jxlBytes, w, h }  (null/absent => not yet developed)
    states = {},            // assetId -> cardState
    fullResRgba = null,     // override decode output
    developOnEnsure = null, // assetId -> { jxlBytes, w, h } produced by ensureDeveloped
} = {}) {
    const encodeCalls = [];
    const caps = {
        getCardStateByAssetId: (id) => states[id] ?? null,
        getDevelopedOutput: (state) => {
            const id = state?._file?.name;
            return developed[id] ?? developed[state?._assetId] ?? null;
        },
        ensureDeveloped: async (assetId) => {
            if (developOnEnsure && developOnEnsure[assetId]) {
                developed[assetId] = developOnEnsure[assetId];
            }
        },
        decodeFullRes: async (jxlBytes) => {
            // A real decoder would decode `jxlBytes`; here we return the known
            // full-res RGBA so re-encode tests have honest full-res pixels.
            const rgba = fullResRgba ?? makeFullResRgba(FULL_W, FULL_H);
            return { pixels: rgba, w: FULL_W, h: FULL_H, format: 'rgba8' };
        },
        encodePixels: async (pixels, w, h, format, orientation, outputFmt, metadata) => {
            encodeCalls.push({ w, h, format, orientation, outputFmt, metadata });
            if (outputFmt === 'png') {
                return encodePng(pixels, w, h, format === 'rgb8' ? 'rgb8' : 'rgba8');
            }
            // jxl re-encode path (metadata embed): return recognisable bytes; the
            // real libjxl encoder cannot run under bun test.
            return Uint8Array.from([0xFF, 0x0A, 0x99]);
        },
    };
    caps._encodeCalls = encodeCalls;
    return caps;
}

// ===========================================================================
// 1. formatLabel — finding 45 (kept, still compliant)
// ===========================================================================
describe('formatLabel: real format + bit-depth (finding 45)', () => {
    test('ORF 12-bit', () => expect(formatLabel({ format: 'ORF', bitDepth: 12 })).toBe('ORF (12-bit)'));
    test('DNG 14-bit', () => expect(formatLabel({ format: 'DNG', bitDepth: 14 })).toBe('DNG (14-bit)'));
    test('no bit depth when absent', () => expect(formatLabel({ format: 'TIFF', bitDepth: null })).toBe('TIFF'));
    test('no bit depth when 0', () => expect(formatLabel({ format: 'EXR', bitDepth: 0 })).toBe('EXR'));
    test('null exif → Unknown', () => expect(formatLabel(null)).toBe('Unknown'));
    test('not the hardcoded string', () => expect(formatLabel({ format: 'ORF', bitDepth: 12 })).not.toBe('ORF (Olympus 12-bit)'));
});

// ===========================================================================
// 2. applyMetadataPolicy (finding 44) — pure policy on the JS object
// ===========================================================================
describe('applyMetadataPolicy: privacy stripping (finding 44)', () => {
    const fullExif = {
        make: 'Olympus', model: 'OM-5', lens: '12-40mm', datetime: '2026:07:11 10:30:00',
        iso: 400, orientation: 1, gps: { lat: 51.5, lon: -0.12, alt: 10 },
        width: 5184, height: 3888, format: 'ORF', bitDepth: 12,
    };
    test('keep unchanged', () => expect(applyMetadataPolicy(fullExif, 'keep')).toEqual(fullExif));
    test('strip-gps removes gps only', () => {
        const r = applyMetadataPolicy(fullExif, 'strip-gps');
        expect(r.gps).toBeNull();
        expect(r.make).toBe('Olympus');
        expect(r.iso).toBe(400);
    });
    test('strip-all keeps only technical fields', () => {
        const r = applyMetadataPolicy(fullExif, 'strip-all');
        expect(r.width).toBe(5184);
        expect(r.format).toBe('ORF');
        expect(r.gps).toBeNull();
        expect(r.make).toBeNull();
        expect(r.datetime).toBeNull();
    });
    test('does not mutate input', () => {
        const original = JSON.parse(JSON.stringify(fullExif));
        applyMetadataPolicy(fullExif, 'strip-all');
        expect(fullExif).toEqual(original);
    });
});

// ===========================================================================
// 3. serializeMetadata + EXIF serializer (I-C) — REAL bytes, GPS proof
// ===========================================================================
describe('serializeMetadata: policy → EXIF bytes with GPS proof (I-C)', () => {
    const exifWithGps = {
        make: 'Olympus', model: 'OM-5', datetime: '2026:07:11 10:30:00',
        iso: 400, orientation: 1, gps: { lat: 51.5, lon: -0.12, alt: 10 },
    };

    test('keep: serialised EXIF CONTAINS GPS', () => {
        const kept = applyMetadataPolicy(exifWithGps, 'keep');
        const { exif } = serializeMetadata(kept);
        expect(exif).toBeInstanceOf(Uint8Array);
        const parsed = parseExif(exif);
        expect(parsed.hasGps).toBe(true);
        expect(parsed.gpsPointerPresent).toBe(true);
        expect(parsed.make).toBe('Olympus');
    });

    test('strip-gps: serialised EXIF has NO GPS (no IFD, no pointer)', () => {
        const stripped = applyMetadataPolicy(exifWithGps, 'strip-gps');
        const { exif } = serializeMetadata(stripped);
        const parsed = parseExif(exif);
        expect(parsed.hasGps).toBe(false);
        expect(parsed.gpsPointerPresent).toBe(false);
        // other fields still present
        expect(parsed.make).toBe('Olympus');
    });

    test('strip-all: serialised EXIF has NO GPS and NO camera identity', () => {
        const stripped = applyMetadataPolicy(exifWithGps, 'strip-all');
        const { exif } = serializeMetadata(stripped);
        // may be null (nothing worth writing) OR a header with no GPS/make
        if (exif) {
            const parsed = parseExif(exif);
            expect(parsed.hasGps).toBe(false);
            expect(parsed.gpsPointerPresent).toBe(false);
            expect(parsed.make).toBeNull();
        }
    });

    test('GPS bytes are literally absent from the strip-gps byte stream', () => {
        // Byte-level: the GPS IFD pointer tag (0x8825) must not appear as a tag.
        const stripped = applyMetadataPolicy(exifWithGps, 'strip-gps');
        const { exif } = serializeMetadata(stripped);
        const parsed = parseExif(exif);
        expect(parsed.ifd0Tags).not.toContain(0x8825);
    });
});

// ===========================================================================
// 4. deriveOutputFilename — collision handling (kept)
// ===========================================================================
describe('deriveOutputFilename', () => {
    test('ORF → jxl', () => expect(deriveOutputFilename('IMG_0001.ORF', 'jxl')).toBe('IMG_0001.jxl'));
    test('ORF → png', () => expect(deriveOutputFilename('IMG_0001.ORF', 'png')).toBe('IMG_0001.png'));
    test('dedup appends -N', () => {
        const set = new Set(['photo.jxl']);
        expect(deriveOutputFilename('photo.ORF', 'jxl', set)).toBe('photo-2.jxl');
    });
});

// ===========================================================================
// 5. Format gating (I-B) — never emit a mislabeled file
// ===========================================================================
describe('format gating (I-B): only encodable formats allowed', () => {
    test('jxl + png are encodable', () => {
        expect(isFormatEncodable('jxl')).toBe(true);
        expect(isFormatEncodable('png')).toBe(true);
    });
    test('jpeg + tiff are gated', () => {
        expect(isFormatEncodable('jpeg')).toBe(false);
        expect(isFormatEncodable('tiff')).toBe(false);
        expect(GATED_FORMATS).toContain('jpeg');
        expect(GATED_FORMATS).toContain('tiff');
    });

    test('export to jpeg yields an error event (no bytes written)', async () => {
        const states = { 'IMG_0001.ORF': makeCardState({ exif: { format: 'ORF', bitDepth: 12, orientation: 1, gps: null } }) };
        const caps = makeCaps({
            states,
            developed: { 'IMG_0001.ORF': { jxlBytes: makeDevelopedJxlBytes(), w: FULL_W, h: FULL_H } },
        });
        const svc = new ExportService(caps);
        const events = [];
        for await (const ev of svc.export({ assetIds: ['IMG_0001.ORF'], output: 'jpeg', metadata: 'keep', resolution: 'full' })) events.push(ev);
        const done = events.filter(e => e.type === 'done');
        const errs = events.filter(e => e.type === 'error');
        expect(done.length).toBe(0);
        expect(errs.length).toBe(1);
        expect(errs[0].error).toMatch(/packet-3|not available/i);
    });

    test('export to tiff yields an error event (no bytes written)', async () => {
        const states = { 'IMG_0001.ORF': makeCardState({ exif: { format: 'ORF', bitDepth: 12, orientation: 1, gps: null } }) };
        const caps = makeCaps({ states, developed: { 'IMG_0001.ORF': { jxlBytes: makeDevelopedJxlBytes(), w: FULL_W, h: FULL_H } } });
        const svc = new ExportService(caps);
        const events = [];
        for await (const ev of svc.export({ assetIds: ['IMG_0001.ORF'], output: 'tiff', metadata: 'keep', resolution: 'full' })) events.push(ev);
        expect(events.some(e => e.type === 'error')).toBe(true);
        expect(events.some(e => e.type === 'done')).toBe(false);
    });
});

// ===========================================================================
// 6. I-A — export the FULL-RES developed output, NOT the 1800px preview
// ===========================================================================
describe('I-A: full-res developed output, never the preview', () => {
    test('JXL/keep passes through the developed FULL-RES bytes at full dims', async () => {
        const devBytes = makeDevelopedJxlBytes(42);
        const states = { 'IMG_0001.ORF': makeCardState({ exif: { format: 'ORF', bitDepth: 12, orientation: 1, gps: null, width: FULL_W, height: FULL_H } }) };
        const caps = makeCaps({
            states,
            developed: { 'IMG_0001.ORF': { jxlBytes: devBytes, w: FULL_W, h: FULL_H } },
        });
        const svc = new ExportService(caps);
        let done = null;
        for await (const ev of svc.export({ assetIds: ['IMG_0001.ORF'], output: 'jxl', metadata: 'keep', resolution: 'full' })) {
            if (ev.type === 'done') done = ev;
        }
        expect(done).toBeTruthy();
        // The exported bytes ARE the developed full-res JXL bytes (pass-through).
        expect(done.bytes).toBe(devBytes);
        expect(done.source).toBe('developed-jxl-passthrough');
        // Full sensor dims — NOT the 1800px preview.
        expect(done.width).toBe(FULL_W);
        expect(done.height).toBe(FULL_H);
        expect(done.width).not.toBe(PREVIEW_W);
        // The service must NOT have read the preview _lightbox for encoding.
        expect(caps._encodeCalls.length).toBe(0);
    });

    test('re-encode path decodes the FULL-RES developed JXL (full dims), not preview', async () => {
        // PNG output forces decode+re-encode; the decoder must yield full dims.
        const states = { 'IMG_0001.ORF': makeCardState({ exif: { format: 'ORF', bitDepth: 12, orientation: 1, gps: null, width: FULL_W, height: FULL_H } }) };
        const caps = makeCaps({ states, developed: { 'IMG_0001.ORF': { jxlBytes: makeDevelopedJxlBytes(), w: FULL_W, h: FULL_H } } });
        const svc = new ExportService(caps);
        let done = null;
        for await (const ev of svc.export({ assetIds: ['IMG_0001.ORF'], output: 'png', metadata: 'keep', resolution: 'full' })) {
            if (ev.type === 'done') done = ev;
        }
        expect(done).toBeTruthy();
        // encodePixels was called with FULL sensor dims sourced from the decode.
        expect(caps._encodeCalls.length).toBe(1);
        expect(caps._encodeCalls[0].w).toBe(FULL_W);
        expect(caps._encodeCalls[0].h).toBe(FULL_H);
        expect(caps._encodeCalls[0].w).not.toBe(PREVIEW_W);
        expect(done.width).toBe(FULL_W);
    });

    test('errors clearly when developed output is not available and cannot be produced', async () => {
        const states = { 'IMG_0001.ORF': makeCardState({ exif: { format: 'ORF', bitDepth: 12, orientation: 1, gps: null } }) };
        const caps = makeCaps({ states, developed: {} }); // never developed
        delete caps.ensureDeveloped; // no way to produce it
        const svc = new ExportService(caps);
        const events = [];
        for await (const ev of svc.export({ assetIds: ['IMG_0001.ORF'], output: 'jxl', metadata: 'keep', resolution: 'full' })) events.push(ev);
        const errs = events.filter(e => e.type === 'error');
        expect(errs.length).toBe(1);
        expect(errs[0].error).toMatch(/still developing|not available/i);
        expect(events.some(e => e.type === 'done')).toBe(false);
    });

    test('triggers ensureDeveloped when the developed output is missing, then exports', async () => {
        const devBytes = makeDevelopedJxlBytes(7);
        const states = { 'IMG_0001.ORF': makeCardState({ exif: { format: 'ORF', bitDepth: 12, orientation: 1, gps: null, width: FULL_W, height: FULL_H } }) };
        const caps = makeCaps({
            states,
            developed: {}, // not developed yet
            developOnEnsure: { 'IMG_0001.ORF': { jxlBytes: devBytes, w: FULL_W, h: FULL_H } },
        });
        const svc = new ExportService(caps);
        let done = null;
        for await (const ev of svc.export({ assetIds: ['IMG_0001.ORF'], output: 'jxl', metadata: 'keep', resolution: 'full' })) {
            if (ev.type === 'done') done = ev;
        }
        expect(done).toBeTruthy();
        expect(done.bytes).toBe(devBytes);
        expect(done.width).toBe(FULL_W);
    });
});

// ===========================================================================
// 7. I-B — PNG produces REAL PNG bytes (round-trip decode)
// ===========================================================================
describe('I-B: PNG export produces real, honest PNG bytes', () => {
    test('exported PNG has a valid PNG signature and round-trips to full dims', async () => {
        // Small full-res to keep the deflate fast.
        const W = 64, H = 48;
        const rgba = makeFullResRgba(W, H);
        const states = { 'IMG_0001.ORF': makeCardState({ exif: { format: 'ORF', bitDepth: 12, orientation: 1, gps: null, width: W, height: H } }) };
        const caps = makeCaps({
            states,
            developed: { 'IMG_0001.ORF': { jxlBytes: makeDevelopedJxlBytes(), w: W, h: H } },
            fullResRgba: rgba,
        });
        // Override decodeFullRes to return the small dims consistently.
        caps.decodeFullRes = async () => ({ pixels: rgba, w: W, h: H, format: 'rgba8' });
        const svc = new ExportService(caps);
        let done = null;
        for await (const ev of svc.export({ assetIds: ['IMG_0001.ORF'], output: 'png', metadata: 'keep', resolution: 'full' })) {
            if (ev.type === 'done') done = ev;
        }
        expect(done).toBeTruthy();
        // Real PNG signature.
        expect(Array.from(done.bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        expect(done.filename).toMatch(/\.png$/);
        // Round-trip: decode the exported PNG back and confirm full dims + pixels.
        const dec = await decodePngToRgba(done.bytes);
        expect(dec.width).toBe(W);
        expect(dec.height).toBe(H);
        // Pixel fidelity (PNG is lossless).
        expect(dec.pixels).toEqual(rgba);
    });
});

// ===========================================================================
// 8. I-C — metadata policy is CARRIED INTO the encode (re-encode path)
// ===========================================================================
describe('I-C: metadata policy threaded into the encoder', () => {
    test('strip-gps: encoder receives EXIF bytes with NO GPS', async () => {
        const states = { 'IMG_0001.ORF': makeCardState({
            exif: { make: 'Olympus', model: 'OM-5', datetime: '2026:07:11 10:30:00',
                    iso: 400, orientation: 1, gps: { lat: 51.5, lon: -0.12, alt: 10 },
                    width: FULL_W, height: FULL_H, format: 'ORF', bitDepth: 12 },
        }) };
        const caps = makeCaps({ states, developed: { 'IMG_0001.ORF': { jxlBytes: makeDevelopedJxlBytes(), w: FULL_W, h: FULL_H } } });
        const svc = new ExportService(caps);
        for await (const _ of svc.export({ assetIds: ['IMG_0001.ORF'], output: 'png', metadata: 'strip-gps', resolution: 'full' })) {}
        expect(caps._encodeCalls.length).toBe(1);
        const meta = caps._encodeCalls[0].metadata;
        expect(meta).toBeTruthy();
        expect(meta.exif).toBeInstanceOf(Uint8Array);
        const parsed = parseExif(meta.exif);
        expect(parsed.hasGps).toBe(false);
        expect(parsed.gpsPointerPresent).toBe(false);
        // Non-GPS metadata still carried.
        expect(parsed.make).toBe('Olympus');
    });

    test('keep: encoder receives EXIF bytes WITH GPS', async () => {
        const states = { 'IMG_0001.ORF': makeCardState({
            exif: { make: 'Olympus', model: 'OM-5', iso: 400, orientation: 1,
                    gps: { lat: 51.5, lon: -0.12, alt: 10 }, width: FULL_W, height: FULL_H,
                    format: 'ORF', bitDepth: 12 },
        }) };
        const caps = makeCaps({ states, developed: { 'IMG_0001.ORF': { jxlBytes: makeDevelopedJxlBytes(), w: FULL_W, h: FULL_H } } });
        const svc = new ExportService(caps);
        // PNG forces the re-encode path even for 'keep', so we can inspect metadata bytes.
        for await (const _ of svc.export({ assetIds: ['IMG_0001.ORF'], output: 'png', metadata: 'keep', resolution: 'full' })) {}
        expect(caps._encodeCalls.length).toBe(1);
        const parsed = parseExif(caps._encodeCalls[0].metadata.exif);
        expect(parsed.hasGps).toBe(true);
    });
});

// ===========================================================================
// 9. Service contract: order, partial failure, cancel, missing asset
// ===========================================================================
describe('ExportService: contract', () => {
    function multiCaps(ids, opts = {}) {
        const states = {}, developed = {};
        for (const id of ids) {
            const name = id + '.ORF';
            states[id] = makeCardState({ name, exif: { format: 'ORF', bitDepth: 12, orientation: 1, gps: null, width: FULL_W, height: FULL_H } });
            // getDevelopedOutput keys off state._file.name, so key `developed` by name.
            if (!opts.undeveloped?.includes(id)) developed[name] = { jxlBytes: makeDevelopedJxlBytes(), w: FULL_W, h: FULL_H };
        }
        const caps = makeCaps({ states, developed });
        if (opts.noEnsure) delete caps.ensureDeveloped;
        return caps;
    }

    test('results arrive in assetIds order', async () => {
        const caps = multiCaps(['a', 'b', 'c']);
        const svc = new ExportService(caps);
        const order = [];
        for await (const ev of svc.export({ assetIds: ['a', 'b', 'c'], output: 'jxl', metadata: 'keep', resolution: 'full' })) {
            if (ev.type === 'done') order.push(ev.assetId);
        }
        expect(order).toEqual(['a', 'b', 'c']);
    });

    test('partial failure: undeveloped asset errors, others complete', async () => {
        const caps = multiCaps(['ok-1', 'bad', 'ok-2'], { undeveloped: ['bad'], noEnsure: true });
        const svc = new ExportService(caps);
        const events = [];
        for await (const ev of svc.export({ assetIds: ['ok-1', 'bad', 'ok-2'], output: 'jxl', metadata: 'keep', resolution: 'full' })) events.push(ev);
        const errs = events.filter(e => e.type === 'error');
        const dones = events.filter(e => e.type === 'done');
        expect(errs.length).toBe(1);
        expect(errs[0].assetId).toBe('bad');
        expect(dones.map(e => e.assetId).sort()).toEqual(['ok-1', 'ok-2']);
    });

    test('cancel stops further exports', async () => {
        const ids = Array.from({ length: 10 }, (_, i) => `a${i}`);
        const caps = multiCaps(ids);
        const svc = new ExportService(caps);
        let doneCount = 0;
        for await (const ev of svc.export({ assetIds: ids, output: 'jxl', metadata: 'keep', resolution: 'full' })) {
            if (ev.type === 'done') { doneCount++; if (doneCount === 1) svc.cancel(); }
        }
        expect(doneCount).toBeLessThan(10);
    });

    test('missing asset state → error', async () => {
        const caps = makeCaps({ states: {}, developed: {} });
        const svc = new ExportService(caps);
        const events = [];
        for await (const ev of svc.export({ assetIds: ['ghost'], output: 'jxl', metadata: 'keep', resolution: 'full' })) events.push(ev);
        expect(events.some(e => e.type === 'error' && e.assetId === 'ghost')).toBe(true);
    });

    test('filename collision → distinct names', async () => {
        const states = {
            'id-1': makeCardState({ name: 'photo.ORF', exif: { format: 'ORF', bitDepth: 12, orientation: 1, gps: null, width: FULL_W, height: FULL_H } }),
            'id-2': makeCardState({ name: 'photo.ORF', exif: { format: 'ORF', bitDepth: 12, orientation: 1, gps: null, width: FULL_W, height: FULL_H } }),
        };
        const developed = {
            'photo.ORF': { jxlBytes: makeDevelopedJxlBytes(), w: FULL_W, h: FULL_H },
        };
        // Both cards share the same _file.name → same developed key; that's fine
        // for this collision test (we assert on output filename dedup).
        const caps = makeCaps({ states, developed });
        const svc = new ExportService(caps);
        const names = [];
        for await (const ev of svc.export({ assetIds: ['id-1', 'id-2'], output: 'jxl', metadata: 'keep', resolution: 'full' })) {
            if (ev.type === 'done') names.push(ev.filename);
        }
        expect(names.sort()).toEqual(['photo-2.jxl', 'photo.jxl']);
    });
});

// ===========================================================================
// 10. Consolidated REAL round-trip: full-res fixture → export → decode back.
//     Combines I-A (full dims) + I-C (GPS strip vs keep) end-to-end through the
//     service, using the REAL PNG encoder+decoder for the pixel round-trip and
//     the REAL EXIF serializer for the metadata proof.  (The libjxl WASM encoder
//     cannot run under bun test — see file header — so the pixel round-trip goes
//     through PNG and the metadata proof is on the serialised EXIF bytes.)
// ===========================================================================
describe('real round-trip: full-res + metadata policy end-to-end', () => {
    const W = 40, H = 30; // small full-res fixture (keeps deflate fast)
    function makeE2ECaps(policyExif) {
        const rgba = makeFullResRgba(W, H);
        const states = { 'IMG.ORF': makeCardState({ name: 'IMG.ORF', exif: { ...policyExif, width: W, height: H } }) };
        const caps = makeCaps({
            states,
            developed: { 'IMG.ORF': { jxlBytes: makeDevelopedJxlBytes(), w: W, h: H } },
            fullResRgba: rgba,
        });
        caps.decodeFullRes = async () => ({ pixels: rgba, w: W, h: H, format: 'rgba8' });
        return { caps, rgba };
    }

    test('strip-gps: PNG round-trips at FULL dims AND serialised EXIF has no GPS', async () => {
        const { caps, rgba } = makeE2ECaps({
            make: 'Olympus', model: 'OM-5', iso: 400, orientation: 1,
            gps: { lat: 51.5, lon: -0.12, alt: 10 }, format: 'ORF', bitDepth: 12,
        });
        const svc = new ExportService(caps);
        let done = null;
        for await (const ev of svc.export({ assetIds: ['IMG.ORF'], output: 'png', metadata: 'strip-gps', resolution: 'full' })) {
            if (ev.type === 'done') done = ev;
        }
        expect(done).toBeTruthy();
        // I-A: decoded output is FULL resolution and pixel-identical (lossless).
        const dec = await decodePngToRgba(done.bytes);
        expect(dec.width).toBe(W);
        expect(dec.height).toBe(H);
        expect(dec.pixels).toEqual(rgba);
        // I-C: the metadata the encoder received had GPS removed.
        const meta = caps._encodeCalls[0].metadata;
        const parsed = parseExif(meta.exif);
        expect(parsed.hasGps).toBe(false);
        expect(parsed.gpsPointerPresent).toBe(false);
        expect(parsed.make).toBe('Olympus'); // non-GPS metadata preserved
    });

    test('keep: serialised EXIF preserves GPS', async () => {
        const { caps } = makeE2ECaps({
            make: 'Olympus', model: 'OM-5', iso: 400, orientation: 1,
            gps: { lat: 51.5, lon: -0.12, alt: 10 }, format: 'ORF', bitDepth: 12,
        });
        const svc = new ExportService(caps);
        for await (const _ of svc.export({ assetIds: ['IMG.ORF'], output: 'png', metadata: 'keep', resolution: 'full' })) {}
        const parsed = parseExif(caps._encodeCalls[0].metadata.exif);
        expect(parsed.hasGps).toBe(true);
        expect(parsed.gpsPointerPresent).toBe(true);
    });
});
