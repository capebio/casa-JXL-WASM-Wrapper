// resource-lifetime.test.js — P4 T3: bounded render/decode/derived-asset lifetime
//
// Covers findings 11, 12, 29, 43:
//   F11: _jxlDecoded (full-res RGBA) accumulates unbounded across cards.
//   F12: ensureFbo calls texImage2D on every render even if dims unchanged.
//   F29: derived cache (_jxlDecoded) bypasses AssetStore; no byte budget/LRU.
//   F43: repaintThumbFromJxl decodes at full resolution then canvas-downscales.
//
// Tests are grouped in four sections:
//   Section A: DerivedCache module (pure, unit-testable, no DOM)
//   Section B: FBO lazy-realloc (pure mock, no DOM)
//   Section C: main.js source-text assertions (F29, F43)
//   Section D: integration — bounded counts across add/process/reprocess/delete cycles
//
// Run with: bun test web/resource-lifetime.test.js

import { expect, test, describe, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainSrc = readFileSync(join(__dirname, 'main.js'), 'utf8');
const webglSrc = readFileSync(join(__dirname, 'lightbox', 'webgl-pipeline.js'), 'utf8');

// ---------------------------------------------------------------------------
// Section A: DerivedCache — AssetStore-backed, byte-budgeted, LRU, per-key
//            invalidation on generation change / card delete. (F11, F29)
// ---------------------------------------------------------------------------
import { createDerivedCache } from './jxl-derived-cache.js';
import { AssetStore } from '../packages/asset-store/src/index.js';

describe('DerivedCache: AssetStore-backed derived JXL decode cache (F11, F29)', () => {
    let cache;

    beforeEach(() => {
        cache = createDerivedCache({ maxBytes: 100 });
    });

    test('set and get a decoded entry by assetId', () => {
        const pixels = new Uint8ClampedArray(4 * 4 * 4); // 4×4 RGBA
        cache.set('a', { rgba: pixels, w: 4, h: 4 }, pixels.byteLength);
        const hit = cache.get('a');
        expect(hit).not.toBeNull();
        expect(hit.w).toBe(4);
        expect(hit.h).toBe(4);
    });

    test('miss returns undefined for unknown key', () => {
        expect(cache.get('unknown')).toBeUndefined();
    });

    test('byte budget enforced: LRU entry evicted when budget exceeded', () => {
        // Budget = 100 bytes. Two RGBA pixel sets of 60 bytes each → second evicts first.
        const pxA = new Uint8ClampedArray(60);
        const pxB = new Uint8ClampedArray(60);
        cache.set('a', { rgba: pxA, w: 15, h: 1 }, 60);
        expect(cache.bytes).toBe(60);
        cache.set('b', { rgba: pxB, w: 15, h: 1 }, 60);
        // Total 120 > 100 → 'a' (LRU) must be evicted
        expect(cache.bytes).toBeLessThanOrEqual(100);
        expect(cache.get('a')).toBeUndefined(); // evicted
        expect(cache.get('b')).not.toBeUndefined(); // kept
    });

    test('explicit delete removes entry and frees bytes', () => {
        const pixels = new Uint8ClampedArray(40);
        cache.set('a', { rgba: pixels, w: 10, h: 1 }, 40);
        expect(cache.bytes).toBe(40);
        cache.delete('a');
        expect(cache.bytes).toBe(0);
        expect(cache.get('a')).toBeUndefined();
    });

    test('invalidate removes a specific key (generation change)', () => {
        const pxA = new Uint8ClampedArray(20);
        const pxB = new Uint8ClampedArray(20);
        cache.set('a', { rgba: pxA, w: 5, h: 1 }, 20);
        cache.set('b', { rgba: pxB, w: 5, h: 1 }, 20);
        cache.invalidate('a');
        expect(cache.get('a')).toBeUndefined();
        expect(cache.get('b')).not.toBeUndefined(); // 'b' unaffected
    });

    test('clear() releases all entries and resets byte count to 0', () => {
        const pxA = new Uint8ClampedArray(20);
        const pxB = new Uint8ClampedArray(20);
        cache.set('a', { rgba: pxA, w: 5, h: 1 }, 20);
        cache.set('b', { rgba: pxB, w: 5, h: 1 }, 20);
        cache.clear();
        expect(cache.bytes).toBe(0);
        expect(cache.size).toBe(0);
    });

    test('onEvict callback fires when an entry is evicted by LRU', () => {
        const evicted = [];
        const c = createDerivedCache({
            maxBytes: 50,
            onEvict: (key) => evicted.push(key),
        });
        const px30 = new Uint8ClampedArray(30);
        const px30b = new Uint8ClampedArray(30);
        c.set('x', { rgba: px30, w: 30, h: 1 }, 30);
        c.set('y', { rgba: px30b, w: 30, h: 1 }, 30); // evicts 'x'
        expect(evicted).toContain('x');
    });

    test('onEvict callback fires on explicit delete', () => {
        const evicted = [];
        const c = createDerivedCache({
            maxBytes: 200,
            onEvict: (key, reason) => evicted.push({ key, reason }),
        });
        const px = new Uint8ClampedArray(20);
        c.set('z', { rgba: px, w: 20, h: 1 }, 20);
        c.delete('z');
        expect(evicted.some(e => e.key === 'z' && e.reason === 'delete')).toBe(true);
    });

    test('size property tracks count of live entries', () => {
        expect(cache.size).toBe(0);
        const px = new Uint8ClampedArray(10);
        cache.set('a', { rgba: px, w: 10, h: 1 }, 10);
        cache.set('b', { rgba: px, w: 10, h: 1 }, 10);
        expect(cache.size).toBe(2);
        cache.delete('a');
        expect(cache.size).toBe(1);
    });

    test('repeated reprocess cycle stays bounded: N re-encodes of one card never exceed budget', () => {
        const budget = 300;
        const c = createDerivedCache({ maxBytes: budget });
        const assetId = 'card-1';
        for (let gen = 0; gen < 20; gen++) {
            // Each reprocess: invalidate old, set new (same key, new pixels)
            c.invalidate(assetId);
            const px = new Uint8ClampedArray(100);
            c.set(assetId, { rgba: px, w: 25, h: 1 }, 100);
            // Never exceed budget
            expect(c.bytes).toBeLessThanOrEqual(budget);
        }
    });

    test('N-card batch stays bounded: adding 50 cards at 20 bytes each under a 200B budget', () => {
        const N = 50;
        const c = createDerivedCache({ maxBytes: 200 });
        for (let i = 0; i < N; i++) {
            const px = new Uint8ClampedArray(20);
            c.set(`card-${i}`, { rgba: px, w: 20, h: 1 }, 20);
        }
        // At most 200 bytes stored at any time
        expect(c.bytes).toBeLessThanOrEqual(200);
        // At most 10 entries (200 / 20 each)
        expect(c.size).toBeLessThanOrEqual(10);
    });
});

// ---------------------------------------------------------------------------
// Section B: FBO lazy-realloc — texImage2D skipped when dims unchanged (F12)
// ---------------------------------------------------------------------------
import { createHdrRendererWithReuse } from './lightbox/webgl-pipeline.js';

describe('WebGL HdrRenderer FBO lazy-realloc (F12): texImage2D only on dim change', () => {
    // Build a mock WebGL context that counts texImage2D calls.
    function mockGl() {
        const calls = { texImage2D: 0, texParameteri: 0, bindTexture: 0, bindFramebuffer: 0,
                        framebufferTexture2D: 0 };
        return {
            _calls: calls,
            TEXTURE_2D: 0x0DE1,
            FRAMEBUFFER: 0x8D40,
            COLOR_ATTACHMENT0: 0x8CE0,
            TEXTURE_MIN_FILTER: 0x2801,
            TEXTURE_MAG_FILTER: 0x2800,
            TEXTURE_WRAP_S: 0x2802,
            TEXTURE_WRAP_T: 0x2803,
            NEAREST: 0x2600,
            CLAMP_TO_EDGE: 0x812F,
            RGBA32F: 0x8814,
            RGBA: 0x1908,
            FLOAT: 0x1406,
            texImage2D(..._args) { calls.texImage2D++; },
            texParameteri(..._args) { calls.texParameteri++; },
            bindTexture(..._args) { calls.bindTexture++; },
            bindFramebuffer(..._args) { calls.bindFramebuffer++; },
            framebufferTexture2D(..._args) { calls.framebufferTexture2D++; },
            createTexture() { return {}; },
            createFramebuffer() { return {}; },
        };
    }

    test('createHdrRendererWithReuse is exported from webgl-pipeline.js', () => {
        // The new export must exist; if not, the test fails (RED) until we add it.
        expect(typeof createHdrRendererWithReuse).toBe('function');
    });

    test('ensureFbo: texImage2D called on first render', () => {
        const gl = mockGl();
        const renderer = createHdrRendererWithReuse(gl, { isWebGL2: true });
        renderer.ensureFbo(100, 100);
        expect(gl._calls.texImage2D).toBeGreaterThanOrEqual(1);
    });

    test('ensureFbo: texImage2D NOT called on same dimensions (F12 fix)', () => {
        const gl = mockGl();
        const renderer = createHdrRendererWithReuse(gl, { isWebGL2: true });
        renderer.ensureFbo(200, 100);
        const afterFirst = gl._calls.texImage2D;
        renderer.ensureFbo(200, 100); // same dims → should NOT re-allocate
        expect(gl._calls.texImage2D).toBe(afterFirst); // count unchanged
    });

    test('ensureFbo: texImage2D IS called when dims change (F12 fix)', () => {
        const gl = mockGl();
        const renderer = createHdrRendererWithReuse(gl, { isWebGL2: true });
        renderer.ensureFbo(200, 100);
        const afterFirst = gl._calls.texImage2D;
        renderer.ensureFbo(400, 300); // different dims → must reallocate
        expect(gl._calls.texImage2D).toBeGreaterThan(afterFirst);
    });

    test('ensureFbo: width change triggers realloc', () => {
        const gl = mockGl();
        const r = createHdrRendererWithReuse(gl, { isWebGL2: true });
        r.ensureFbo(100, 200);
        const c1 = gl._calls.texImage2D;
        r.ensureFbo(200, 200); // width changed
        expect(gl._calls.texImage2D).toBeGreaterThan(c1);
    });

    test('ensureFbo: height change triggers realloc', () => {
        const gl = mockGl();
        const r = createHdrRendererWithReuse(gl, { isWebGL2: true });
        r.ensureFbo(100, 200);
        const c1 = gl._calls.texImage2D;
        r.ensureFbo(100, 400); // height changed
        expect(gl._calls.texImage2D).toBeGreaterThan(c1);
    });

    test('multiple same-dim calls: texImage2D count stays at initial value', () => {
        const gl = mockGl();
        const r = createHdrRendererWithReuse(gl, { isWebGL2: true });
        r.ensureFbo(512, 512);
        const base = gl._calls.texImage2D;
        r.ensureFbo(512, 512);
        r.ensureFbo(512, 512);
        r.ensureFbo(512, 512);
        expect(gl._calls.texImage2D).toBe(base);
    });
});

// ---------------------------------------------------------------------------
// Section C: main.js + webgl-pipeline.js source-text assertions (F29, F43)
// ---------------------------------------------------------------------------

describe('main.js source: derived cache routes through AssetStore/DerivedCache (F29)', () => {
    test('main.js imports createDerivedCache', () => {
        expect(mainSrc).toContain('createDerivedCache');
    });

    test('main.js creates a derivedCache instance (or jxlDerivedCache)', () => {
        // The derived cache must be named predictably so tests and future code can find it.
        const hasDerivedCache =
            mainSrc.includes('derivedCache') ||
            mainSrc.includes('jxlDerivedCache') ||
            mainSrc.includes('_derivedCache');
        expect(hasDerivedCache).toBe(true);
    });

    test('commitJxlDecodeCache or cache set routes through DerivedCache.set, not direct _jxlDecoded assignment', () => {
        // The old pattern was: target._jxlDecoded = { rgba, w, h }
        // After F29 fix, jxl-decode-cache-policy.js must call derivedCache.set(key, ...) instead.
        // Verify that the policy file no longer contains the direct assignment.
        const policySrc = readFileSync(
            join(__dirname, 'jxl-decode-cache-policy.js'), 'utf8',
        );
        // Should NOT contain the old direct _jxlDecoded = assignment pattern
        expect(policySrc).not.toContain('target._jxlDecoded =');
    });

    test('main.js derivedCache has a byte budget (not unlimited)', () => {
        // The derived cache creation must pass a maxBytes argument.
        // Find the instantiation site: createDerivedCache({ — not the import line.
        const createInstIdx = mainSrc.indexOf('createDerivedCache({');
        expect(createInstIdx).toBeGreaterThan(-1);
        // Within 300 chars of the call, look for a maxBytes reference
        const snippet = mainSrc.slice(createInstIdx, createInstIdx + 300);
        expect(snippet).toContain('maxBytes');
    });

    test('derivedCache invalidation is called on card delete / generation bump', () => {
        // removeCard must call derivedCache.invalidate (or .delete) for the card's assetId.
        const removeIdx = mainSrc.indexOf('function removeCard(');
        expect(removeIdx).toBeGreaterThan(-1);
        // Use 2000 chars to cover the full function body safely
        const removeBody = mainSrc.slice(removeIdx, removeIdx + 2000);
        const hasInvalidate = removeBody.includes('derivedCache.invalidate') ||
                              removeBody.includes('derivedCache.delete') ||
                              removeBody.includes('jxlDerivedCache.invalidate') ||
                              removeBody.includes('jxlDerivedCache.delete');
        expect(hasInvalidate).toBe(true);
    });

    test('onDone handler invalidates derivedCache when blobUrl changes (generation bump)', () => {
        // When a new blobUrl is assigned (reprocess), _jxlDecoded is cleared.
        // F29: this must go through the DerivedCache, not direct null-assignment.
        // The old: getCardState(card)._jxlDecoded = null must be replaced.
        // After fix: the direct null-assignment at "cache stale once bytes change" is gone,
        // replaced by derivedCache.invalidate(assetId).
        const nullAssignCount = (mainSrc.match(/_jxlDecoded\s*=\s*null/g) || []).length;
        // Must be zero direct null-assignments after F29 fix
        expect(nullAssignCount).toBe(0);
    });
});

describe('main.js source: thumbnail decode uses downsample (F43)', () => {
    // Helper: extract the body of repaintThumbFromJxl (up to the closing '}' at column 0).
    // The function is ~80 lines; use 5000 chars to cover it safely.
    function repaintBody() {
        const fnIdx = mainSrc.indexOf('function repaintThumbFromJxl(');
        if (fnIdx < 0) return '';
        return mainSrc.slice(fnIdx, fnIdx + 5000);
    }

    test('repaintThumbFromJxl function exists in main.js', () => {
        expect(mainSrc.indexOf('function repaintThumbFromJxl(')).toBeGreaterThan(-1);
    });

    test('repaintThumbFromJxl passes a downsample option greater than 1', () => {
        const fnBody = repaintBody();
        // Must contain downsample keyword with a value > 1
        expect(fnBody).toContain('downsample');
        // Must NOT decode at full resolution (downsample: 1 or no downsample)
        // Specifically, downsample should be at minimum 4 for a 360px target
        const downsampleMatch = fnBody.match(/downsample\s*:\s*(\d+)/);
        expect(downsampleMatch).not.toBeNull();
        const downsampleValue = parseInt(downsampleMatch[1], 10);
        expect(downsampleValue).toBeGreaterThanOrEqual(4);
    });

    test('repaintThumbFromJxl does not canvas-resize from full resolution (no full master decode)', () => {
        const fnBody = repaintBody();
        // Key negative: the pattern "downsample: 1" (full-res) must not appear
        expect(fnBody).not.toMatch(/downsample\s*:\s*1[^0-9]/);
    });

    test('decodeJxlViaSession in repaintThumbFromJxl forwards downsample option', () => {
        const fnBody = repaintBody();
        // decodeJxlViaSession must appear in the function body
        expect(fnBody).toContain('decodeJxlViaSession');
        // And downsample must appear in the same function body
        expect(fnBody).toContain('downsample');
    });
});

describe('webgl-pipeline.js source: ensureFbo skips realloc on same dims (F12)', () => {
    test('ensureFbo stores last width and height to compare before texImage2D', () => {
        // The fix adds dimension tracking variables (e.g. _fboW, _fboH, fboW, fboH).
        // Look for the pattern: a comparison before texImage2D inside ensureFbo.
        // Also check the surrounding context (vars declared just before the function).
        const ensureFboIdx = webglSrc.indexOf('function ensureFbo(');
        expect(ensureFboIdx).toBeGreaterThan(-1);
        // Grab 200 chars before the fn (tracking vars declared there) + 900 inside
        const fnBody = webglSrc.slice(Math.max(0, ensureFboIdx - 200), ensureFboIdx + 900);
        // Must contain a conditional (===, !==, ==) that references the dimensions
        const hasDimGuard =
            fnBody.includes('=== w') ||
            fnBody.includes('=== h') ||
            fnBody.includes('!== w') ||
            fnBody.includes('!== h') ||
            fnBody.includes('_fboW') ||
            fnBody.includes('_fboH') ||
            fnBody.includes('fboW') ||
            fnBody.includes('fboH') ||
            fnBody.includes('lastW') ||
            fnBody.includes('lastH');
        expect(hasDimGuard).toBe(true);
    });

    test('ensureFbo updates stored dims after realloc', () => {
        // After a texImage2D, the stored dims must be updated so the next same-dim call skips.
        const ensureFboIdx = webglSrc.indexOf('function ensureFbo(');
        // Include the full function body (900 chars covers it)
        const fnBody = webglSrc.slice(ensureFboIdx, ensureFboIdx + 900);
        // After texImage2D, must have an assignment to the tracking variable
        const hasUpdate =
            fnBody.includes('_fboW = w') ||
            fnBody.includes('_fboH = h') ||
            fnBody.includes('fboW = w') ||
            fnBody.includes('fboH = h') ||
            fnBody.includes('lastW = w') ||
            fnBody.includes('lastH = h');
        expect(hasUpdate).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Section D: integration — bounded resource counts across lifecycle cycles (F11, F29)
// ---------------------------------------------------------------------------

describe('DerivedCache lifecycle: bounded across add/process/reprocess/delete cycles (F11)', () => {
    test('50 cards processed then deleted: cache size returns to 0', () => {
        const N = 50;
        const c = createDerivedCache({ maxBytes: N * 100 });
        const keys = Array.from({ length: N }, (_, i) => `card-${i}`);

        // Simulate N cards being processed (each gets a decoded entry)
        for (const key of keys) {
            const px = new Uint8ClampedArray(100);
            c.set(key, { rgba: px, w: 25, h: 1 }, 100);
        }
        expect(c.size).toBe(N);

        // Simulate all cards being deleted
        for (const key of keys) {
            c.delete(key);
        }
        expect(c.size).toBe(0);
        expect(c.bytes).toBe(0);
    });

    test('repeated reprocess: cache never holds more than budget even after 100 cycles', () => {
        const budget = 200;
        const c = createDerivedCache({ maxBytes: budget });
        for (let i = 0; i < 100; i++) {
            c.invalidate('card-a');
            const px = new Uint8ClampedArray(80);
            c.set('card-a', { rgba: px, w: 20, h: 1 }, 80);
            expect(c.bytes).toBeLessThanOrEqual(budget);
        }
    });

    test('generation-change invalidation keeps sibling cards unaffected', () => {
        const c = createDerivedCache({ maxBytes: 1000 });
        for (let i = 0; i < 5; i++) {
            const px = new Uint8ClampedArray(50);
            c.set(`card-${i}`, { rgba: px, w: 50, h: 1 }, 50);
        }
        expect(c.size).toBe(5);
        // Reprocess card-2 → invalidate it
        c.invalidate('card-2');
        expect(c.size).toBe(4);
        expect(c.get('card-2')).toBeUndefined();
        // Others unaffected
        for (let i = 0; i < 5; i++) {
            if (i === 2) continue;
            expect(c.get(`card-${i}`)).not.toBeUndefined();
        }
    });

    test('long-session slope: after 200 cards processed with budget=500B at 10B each, bytes <= 500', () => {
        const c = createDerivedCache({ maxBytes: 500 });
        for (let i = 0; i < 200; i++) {
            const px = new Uint8ClampedArray(10);
            c.set(`card-${i}`, { rgba: px, w: 10, h: 1 }, 10);
        }
        expect(c.bytes).toBeLessThanOrEqual(500);
        expect(c.size).toBeLessThanOrEqual(50); // 500 / 10
    });
});
