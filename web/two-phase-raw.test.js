// TTFP-4 verification: the two-phase RAW split in web/worker.js (previews-only
// WASM call first, full-res call second) must be byte-identical to the old
// monolithic call on every output the worker posts:
//   - THUMB rgb    (LookRenderer.render on the thumb renderer)
//   - LIGHTBOX rgb (LookRenderer.render on the lightbox renderer)
//   - ENCODE pixels (take_rgb full-res RGB8) + sensor dims
//   - wb/black/orientation metadata the worker copies into messages
//
// This mirrors the exact call shapes of worker.js: arm A is the old single
// call (OUT_FULL_RGB8|OUT_LIGHTBOX|OUT_THUMB|OUT_NO_ORIENT), arm B is the new
// phase 1 (OUT_LIGHTBOX|OUT_THUMB) + phase 2 (OUT_FULL_RGB8|OUT_NO_ORIENT).
// Byte-equality here proves the split changes ordering only, not pixels —
// including when lib.rs takes the streaming preview fast path in phase 1.
//
// Run with bun: `bun test web/two-phase-raw.test.js`
// Skips silently when the local RAW fixture folders are absent.

import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import initRaw, * as rawWasm from './pkg/raw_converter_wasm.js';

const DEFAULT_ORF_FOLDER = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const ORF_FOLDER = process.env.TEST_ORF_FOLDER ?? DEFAULT_ORF_FOLDER;
const DNG_FIXTURE = String.raw`C:\Foo\raw-converter\tests\PXL_20260501_095020990.RAW-02.ORIGINAL.dng`;

const OUT_FULL_RGB8 = 1;
const OUT_LIGHTBOX  = 2;
const OUT_THUMB     = 4;
const OUT_NO_ORIENT = 16;

const orfTest = existsSync(ORF_FOLDER) ? test : test.skip;
const dngTest = existsSync(DNG_FIXTURE) ? test : test.skip;

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// Neutral look, camera WB (NaN overrides) — the worker's default submit shape.
function processNeutral(fn, bytes, flags) {
    return fn(bytes, flags, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
}

const NEUTRAL12 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

// Mirror worker.js applyLookToState: render with the wb the decode reported.
function renderPreviews(result) {
    const wbR = result.wb_r_used;
    const wbB = result.wb_b_used;
    const lbRend = result.take_lightbox_renderer();
    const thRend = result.take_thumb_renderer();
    try {
        return {
            lb: sha(lbRend.render(wbR, wbB, ...NEUTRAL12)),
            th: sha(thRend.render(wbR, wbB, ...NEUTRAL12)),
            wbR, wbB,
            black: result.black_used,
            orientation: result.orientation,
            lbW: result.lb_w, lbH: result.lb_h,
            thW: result.thumb_w, thH: result.thumb_h,
        };
    } finally {
        lbRend.free();
        thRend.free();
    }
}

function runBothArms(fn, bytes) {
    // Arm A — old monolithic worker call.
    const a = processNeutral(fn, bytes, OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB | OUT_NO_ORIENT);
    const aPrev = renderPreviews(a);
    const aFull = { rgb: sha(a.take_rgb()), w: a.width, h: a.height };
    a.free();

    // Arm B — new split: phase 1 previews-only, phase 2 full-res only.
    const b1 = processNeutral(fn, bytes, OUT_LIGHTBOX | OUT_THUMB);
    const bPrev = renderPreviews(b1);
    b1.free();
    const b2 = processNeutral(fn, bytes, OUT_FULL_RGB8 | OUT_NO_ORIENT);
    const bFull = { rgb: sha(b2.take_rgb()), w: b2.width, h: b2.height };
    b2.free();

    return { aPrev, aFull, bPrev, bFull };
}

function expectArmsEqual({ aPrev, aFull, bPrev, bFull }) {
    expect(bPrev.th).toBe(aPrev.th);
    expect(bPrev.lb).toBe(aPrev.lb);
    expect(bFull.rgb).toBe(aFull.rgb);
    expect(bFull.w).toBe(aFull.w);
    expect(bFull.h).toBe(aFull.h);
    expect(bPrev.wbR).toBe(aPrev.wbR);
    expect(bPrev.wbB).toBe(aPrev.wbB);
    expect(bPrev.black).toBe(aPrev.black);
    expect(bPrev.orientation).toBe(aPrev.orientation);
    expect(bPrev.lbW).toBe(aPrev.lbW);
    expect(bPrev.lbH).toBe(aPrev.lbH);
    expect(bPrev.thW).toBe(aPrev.thW);
    expect(bPrev.thH).toBe(aPrev.thH);
}

orfTest('two-phase ORF split is byte-identical to the monolithic call', async () => {
    await initRaw();
    const orfs = readdirSync(ORF_FOLDER)
        .filter((n) => n.toLowerCase().endsWith('.orf'))
        .sort()
        .slice(0, 2);
    expect(orfs.length).toBeGreaterThan(0);
    for (const name of orfs) {
        const bytes = new Uint8Array(readFileSync(join(ORF_FOLDER, name)));
        const r = runBothArms(rawWasm.process_orf_with_flags, bytes);
        expectArmsEqual(r);
        console.log(`  ${name}: full=${r.aFull.rgb.slice(0, 12)} th=${r.aPrev.th.slice(0, 12)} lb=${r.aPrev.lb.slice(0, 12)} — split identical`);
    }
}, 300_000);

// GUARD for the ORF-only gate in worker.js: DNG's monolithic previews are
// downscaled from the FULL-RES MHC demosaic (process_dng_impl has no
// superpixel preview path), while its previews-only twin streams a superpixel
// demosaic — different preview bytes, so worker.js must NOT split DNG tasks.
// The full-res encode output IS identical either way. If this test ever flips
// (lib.rs unifies the DNG preview sources), extend the split to DNG.
dngTest('DNG previews-only twin differs from monolithic previews (split stays ORF-only)', async () => {
    await initRaw();
    const bytes = new Uint8Array(readFileSync(DNG_FIXTURE));
    const r = runBothArms(rawWasm.process_dng_with_flags, bytes);
    expect(r.bPrev.th).not.toBe(r.aPrev.th);
    expect(r.bPrev.lb).not.toBe(r.aPrev.lb);
    // Encode leg would still match — the divergence is preview-only.
    expect(r.bFull.rgb).toBe(r.aFull.rgb);
    expect(r.bFull.w).toBe(r.aFull.w);
    expect(r.bFull.h).toBe(r.aFull.h);
    console.log('  DNG previews diverge (expected) — worker.js keeps DNG monolithic');
}, 300_000);
