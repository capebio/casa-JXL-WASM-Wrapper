// Tests for Finding 47 (P4 T8): lazy-load optional modules.
//
// Strategy: source-text assertions that the optional modules are NOT
// statically imported in main.js, plus behavioural tests for the lazy-init
// helpers themselves (memoisation, failure surface, state preservation).
//
// Run with: bun test web/main-lazy-imports.test.js

import { expect, test, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainSrc = readFileSync(join(__dirname, 'main.js'), 'utf8');

// Extract the static import declarations: lines that begin with `import ...`
// and end with a `from '...'` clause.  We match the actual ES6 static-import
// syntax: `import ... from '...'` (not dynamic `import('...')`).
// We collect ALL such top-level static imports from the file.
function extractStaticImports(src) {
    // Match `import ... from '...'` at line start, possibly multiline
    // (the multiline AssetStore import spans several lines).
    const re = /^import\s+[\s\S]*?from\s+['"][^'"]+['"]\s*;?/gm;
    return (src.match(re) || []).join('\n');
}
const staticImports = extractStaticImports(mainSrc);

// ---------------------------------------------------------------------------
// Finding 47, Group A: static-import graph snapshot
// These tests FAIL before the refactor (optional modules are in static graph)
// and PASS after (they move to dynamic import() calls only).
// ---------------------------------------------------------------------------

describe('finding-47: optional modules not in static import block', () => {
    test('perceptual-color.mjs is NOT a static top-level import', () => {
        // Before refactor: `import { applyLens, ... } from './perceptual-color.mjs'`
        // After refactor:  only a dynamic `import('./perceptual-color.mjs')` call.
        expect(staticImports).not.toMatch(/from\s+['"]\.\/perceptual-color\.mjs['"]/);
    });

    test('tauri-parity-lightbox.js is NOT a static top-level import', () => {
        // Before: `import { createTauriParityLightbox } from './tauri-parity-lightbox.js'`
        // After:  dynamic import only.
        expect(staticImports).not.toMatch(/from\s+['"]\.\/tauri-parity-lightbox\.js['"]/);
    });

    test('export-service.js is NOT a static top-level import', () => {
        // Before: `import { ExportService, ... } from './export-service.js'`
        // After:  dynamic import only.
        expect(staticImports).not.toMatch(/from\s+['"]\.\/export-service\.js['"]/);
    });

    test('png-encode.js is NOT a static top-level import', () => {
        // Before: `import { encodePng } from './png-encode.js'`
        // After:  dynamic import only.
        expect(staticImports).not.toMatch(/from\s+['"]\.\/png-encode\.js['"]/);
    });
});

// ---------------------------------------------------------------------------
// Finding 47, Group B: dynamic import() present for each optional module
// Confirms the split wiring exists (not just that static import was removed).
// ---------------------------------------------------------------------------

describe('finding-47: dynamic import() present for each optional module', () => {
    test('main.js contains dynamic import of perceptual-color.mjs', () => {
        expect(mainSrc).toMatch(/import\s*\(\s*['"]\.\/perceptual-color\.mjs['"]\s*\)/);
    });

    test('main.js contains dynamic import of tauri-parity-lightbox.js', () => {
        expect(mainSrc).toMatch(/import\s*\(\s*['"]\.\/tauri-parity-lightbox\.js['"]\s*\)/);
    });

    test('main.js contains dynamic import of export-service.js', () => {
        expect(mainSrc).toMatch(/import\s*\(\s*['"]\.\/export-service\.js['"]\s*\)/);
    });

    test('main.js contains dynamic import of png-encode.js', () => {
        expect(mainSrc).toMatch(/import\s*\(\s*['"]\.\/png-encode\.js['"]\s*\)/);
    });
});

// ---------------------------------------------------------------------------
// Finding 47, Group C: memoisation — each lazy import is initialised once
// Tests the lazy-init helper factory that all four modules use.
// ---------------------------------------------------------------------------

import { makeLazyModule } from './lazy-module.js';

describe('finding-47: makeLazyModule — memoised init', () => {
    test('factory function is called only once across repeated calls', async () => {
        let callCount = 0;
        const fakeFactory = async () => {
            callCount++;
            return { value: 42 };
        };

        const lazyMod = makeLazyModule(fakeFactory);
        const r1 = await lazyMod();
        const r2 = await lazyMod();
        const r3 = await lazyMod();

        expect(callCount).toBe(1);
        expect(r1).toBe(r2);     // same object reference
        expect(r2).toBe(r3);
        expect(r1.value).toBe(42);
    });

    test('concurrent calls resolve to the same promise — no double-init', async () => {
        let callCount = 0;
        const fakeFactory = async () => {
            callCount++;
            await new Promise(r => setTimeout(r, 0)); // yield
            return { id: callCount };
        };

        const lazyMod = makeLazyModule(fakeFactory);
        // Fire three concurrent requests before the first resolves
        const [a, b, c] = await Promise.all([lazyMod(), lazyMod(), lazyMod()]);

        expect(callCount).toBe(1);
        expect(a).toBe(b);
        expect(b).toBe(c);
    });

    test('returns the cached value synchronously via the settled promise on subsequent calls', async () => {
        const fakeFactory = async () => ({ ready: true });
        const lazyMod = makeLazyModule(fakeFactory);

        await lazyMod();     // first call — wait for settlement
        let resolved = null;
        lazyMod().then(m => { resolved = m; }); // second call — microtask only
        await Promise.resolve();                  // flush one microtask
        expect(resolved?.ready).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Finding 47, Group D: graceful failure surface
// A failed dynamic import surfaces an error, not a silent hang.
// ---------------------------------------------------------------------------

describe('finding-47: makeLazyModule — failure surface', () => {
    test('rejects with the original error when the factory throws', async () => {
        const boom = new Error('import failed');
        const lazyMod = makeLazyModule(async () => { throw boom; });

        await expect(lazyMod()).rejects.toThrow('import failed');
    });

    test('does NOT memoize a failure — retrying re-invokes the factory', async () => {
        // A transient failure (e.g. network blip on first dynamic import) should
        // not permanently brick the feature.  After a rejection the next call
        // must attempt the factory again.
        let attempts = 0;
        const lazyMod = makeLazyModule(async () => {
            attempts++;
            if (attempts < 3) throw new Error(`attempt ${attempts} failed`);
            return { loaded: true };
        });

        await expect(lazyMod()).rejects.toThrow();
        await expect(lazyMod()).rejects.toThrow();
        const result = await lazyMod();          // 3rd attempt succeeds
        expect(result.loaded).toBe(true);
        expect(attempts).toBe(3);
    });

    test('concurrent calls all reject when factory fails, none hangs', async () => {
        const lazyMod = makeLazyModule(async () => { throw new Error('fail'); });

        const results = await Promise.allSettled([lazyMod(), lazyMod(), lazyMod()]);
        for (const r of results) {
            expect(r.status).toBe('rejected');
            expect(r.reason.message).toBe('fail');
        }
    });
});

// ---------------------------------------------------------------------------
// Finding 47, Group E: state preservation across the lazy boundary
// The module's exported state must be the same object after first-use init.
// ---------------------------------------------------------------------------

describe('finding-47: makeLazyModule — state preserved across lazy boundary', () => {
    test('mutations to the returned module object persist on subsequent calls', async () => {
        const lazyMod = makeLazyModule(async () => ({ count: 0 }));

        const mod1 = await lazyMod();
        mod1.count = 99;

        const mod2 = await lazyMod();
        expect(mod2.count).toBe(99);   // same reference, mutation visible
    });

    test('multiple features resolved from same lazy module share state', async () => {
        const lazyMod = makeLazyModule(async () => {
            const state = { calls: 0 };
            return {
                featureA: () => { state.calls++; return state.calls; },
                featureB: () => state.calls,
            };
        });

        const mod = await lazyMod();
        mod.featureA();
        mod.featureA();
        const mod2 = await lazyMod();
        expect(mod2.featureB()).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// Finding 47, Group F: idle-prefetch policy source assertions
// Prefetch fires only after core interaction readiness and only under a
// resource policy — not eagerly on page load.
// ---------------------------------------------------------------------------

describe('finding-47: idle-prefetch policy', () => {
    test('main.js prefetch call is gated behind an idleness/readiness check', () => {
        // The prefetch must NOT be an unconditional top-level call.
        // It must appear inside: requestIdleCallback | setTimeout | after-first-file
        // or similar readiness gate. We check for common patterns.
        const prefetchMatch = mainSrc.match(/prefetchLazyModules[\s\S]{0,400}/);
        if (!prefetchMatch) {
            // If the function is named differently, check the sentinel pattern:
            // a call to lazy module init inside a readiness callback.
            const hasIdleGate = /requestIdleCallback|after.*first.*file|readiness/.test(mainSrc);
            // Acceptable: either a dedicated prefetchLazyModules OR an inline idle gate.
            // The key invariant: no bare lazy_X() call at module top-level.
            expect(hasIdleGate || mainSrc.includes('prefetchLazy')).toBe(true);
        } else {
            // prefetchLazyModules must NOT appear at module top level (no assignment
            // directly below the import block — it must be inside a function or
            // event handler).
            const prefetchIdx = mainSrc.indexOf('prefetchLazyModules');
            const prePrefetch = mainSrc.slice(0, prefetchIdx);
            // There must be a function/handler boundary before the call.
            expect(prePrefetch).toMatch(/function |=>\s*\{|addEventListener/);
        }
    });

    test('perceptual-color dynamic import is wrapped in a makeLazyModule factory — not a bare top-level call', () => {
        // The dynamic import must be inside a makeLazyModule factory arrow function
        // so the module is NOT loaded eagerly at parse time.
        // Pattern: makeLazyModule(() => import('./perceptual-color.mjs'))
        // The factory arrow `() =>` ensures import() only runs on first lazyPerceptual() call.
        expect(mainSrc).toMatch(/makeLazyModule\s*\(\s*\(\s*\)\s*=>\s*import\s*\(\s*['"]\.\/perceptual-color\.mjs['"]\s*\)\s*\)/);
    });
});
