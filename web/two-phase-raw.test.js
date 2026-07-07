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
// Corpus fallback: the committed default ORF folder is machine-specific. When it
// is absent, fall back to the checked-in RAW test fixtures (which contain
// P1110226.ORF) so the byte-identity + batch tests are runnable here too.
const TESTS = String.raw`C:\Foo\raw-converter\tests`;
const ORF_FOLDER = process.env.TEST_ORF_FOLDER
    ?? (existsSync(DEFAULT_ORF_FOLDER) ? DEFAULT_ORF_FOLDER : TESTS);
const ORF_FIXTURE = join(TESTS, 'P1110226.ORF');
const DNG_FIXTURE = String.raw`C:\Foo\raw-converter\tests\PXL_20260501_095020990.RAW-02.ORIGINAL.dng`;

const OUT_FULL_RGB8 = 1;
const OUT_LIGHTBOX  = 2;
const OUT_THUMB     = 4;
const OUT_NO_ORIENT = 16;
const OUT_RETAIN_RAW = 64; // mode 3: phase-1 retains the raw mosaic for a decompress-free finish

const orfTest = existsSync(ORF_FOLDER) ? test : test.skip;
const dngTest = existsSync(DNG_FIXTURE) ? test : test.skip;
const batchTest = existsSync(ORF_FIXTURE) ? test : test.skip;

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// The web-target pkg's default init resolves the .wasm via `fetch(new URL(...))`,
// which hangs for file:// URLs under bun/node. Pass the wasm bytes explicitly;
// initRaw is idempotent, so sharing one init across tests is free.
let rawInit;
function ensureRaw() {
    return (rawInit ??= initRaw({
        module_or_path: readFileSync(new URL('./pkg/raw_converter_wasm_bg.wasm', import.meta.url)),
    }));
}

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
    await ensureRaw();
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
    await ensureRaw();
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

// Documents the redundant work that TWO SEPARATE decode calls incur: a previews-only
// call + a full-res call each re-run the dominant serial `decompress` stage, so their
// summed decompress is ~2x a single monolithic call. Both the batch gate (single call)
// and mode 3 (retain phase-1 raw, finish without re-decompress — see the next test)
// eliminate this; the full RGB8 bytes are byte-identical regardless. This test measures
// the raw-WASM cost of the old two-call shape to justify collapsing it to one decompress.
batchTest('two separate decode calls pay ~2x decompress vs monolithic', async () => {
    await ensureRaw();
    const bytes = new Uint8Array(readFileSync(ORF_FIXTURE));
    // Warmup: cold caches/predictors on the first decode inflate the single
    // (measured-first) run and depress the ratio; a throwaway decode de-noises.
    processNeutral(rawWasm.process_orf_with_flags, bytes,
        OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB | OUT_NO_ORIENT).free();
    const single = processNeutral(rawWasm.process_orf_with_flags, bytes,
        OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB | OUT_NO_ORIENT);
    const singleDecompress = single.decompress_ms; single.free();
    const p1 = processNeutral(rawWasm.process_orf_with_flags, bytes, OUT_LIGHTBOX | OUT_THUMB);
    const p2 = processNeutral(rawWasm.process_orf_with_flags, bytes, OUT_FULL_RGB8 | OUT_NO_ORIENT);
    const twoPhaseDecompress = p1.decompress_ms + p2.decompress_ms;
    console.log(`  decompress_ms: single=${singleDecompress} two-phase=${twoPhaseDecompress}` +
        ` (p1=${p1.decompress_ms}, p2=${p2.decompress_ms})`);
    p1.free(); p2.free();
    // Threshold proves a SECOND decompress occurs (ratio clearly >1). Observed
    // 1.5x-2.8x across machines (the streaming preview-only phase-1 decompress
    // overhead is the machine-dependent swing); 1.3x keeps headroom below the
    // ~1.5 floor while staying clearly separated from the ~1.0 "decoded once" case.
    expect(twoPhaseDecompress).toBeGreaterThan(singleDecompress * 1.3);
}, 300_000);

// Mode 3 (the shipped interactive path): phase-1 retains the raw mosaic; finish_full_rgb8
// produces full-res FROM it with NO second decompress. The full RGB8 must be byte-identical
// to the monolithic decode (finish_from_raw is the single shared demosaic+tone source), and
// the decompress must run exactly once. This is the committed regression gate for mode 3.
batchTest('mode 3: retain-raw + finish_full_rgb8 == monolithic full, single decompress', async () => {
    await ensureRaw();
    const bytes = new Uint8Array(readFileSync(ORF_FIXTURE));
    // Reference: monolithic full decode (one decompress, one demosaic+tone).
    const ref = processNeutral(rawWasm.process_orf_with_flags, bytes, OUT_FULL_RGB8 | OUT_NO_ORIENT);
    const refSha = sha(ref.take_rgb()); ref.free();
    // Mode 3: phase-1 previews + retain raw, then finish full-res from the retained mosaic.
    const r = processNeutral(rawWasm.process_orf_with_flags, bytes, OUT_LIGHTBOX | OUT_THUMB | OUT_RETAIN_RAW);
    const phase1Decompress = r.decompress_ms;
    // finish_full_rgb8(output_flags, <same 14 neutral look args as processNeutral>)
    r.finish_full_rgb8(OUT_FULL_RGB8 | OUT_NO_ORIENT, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
    const modeSha = sha(r.take_rgb());
    const afterDecompress = r.decompress_ms;
    r.free();
    console.log(`  mode3 decompress_ms: phase1=${phase1Decompress} afterFinish=${afterDecompress} (finish adds 0)`);
    expect(modeSha).toBe(refSha);                    // byte-identical full output
    expect(phase1Decompress).toBeGreaterThan(0);     // phase-1 did the (only) decompress
    expect(afterDecompress).toBe(phase1Decompress);  // finish added NO decompress

    // Contract: finish without a retained raw must throw (a plain full decode never retains).
    const noRetain = processNeutral(rawWasm.process_orf_with_flags, bytes, OUT_FULL_RGB8 | OUT_NO_ORIENT);
    expect(() => noRetain.finish_full_rgb8(OUT_FULL_RGB8 | OUT_NO_ORIENT, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0)).toThrow();
    noRetain.free();
}, 300_000);
