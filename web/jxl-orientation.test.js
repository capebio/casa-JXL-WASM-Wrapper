// Phase 1/3 verification: encoding portrait + landscape ORFs does the same work.
// JXL records orientation as metadata — no CPU rotation tax. The default run
// asserts bytes and dimensions; the wall-clock ratio runs only with RCW_TIMING=1
// (web/timing-gate.js).
//
// Run with bun: `bun test web/jxl-orientation.test.js`
//
// Requires: rebuilt packages/jxl-wasm bridge with _z / _v3 orientation exports.
// Without the rebuild, the test still passes (warning printed) but the encoded
// JXL will have orientation = identity for non-1 inputs.

import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import initRaw, * as rawWasm from './pkg/raw_converter_wasm.js';
import { timingEnabled } from './timing-gate.js';

const DEFAULT_ORF_FOLDER = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const ORF_FOLDER = process.env.TEST_ORF_FOLDER ?? DEFAULT_ORF_FOLDER;
const maybeFixtureTest = existsSync(ORF_FOLDER) ? test : test.skip;

const OUT_FULL_RGB8 = 1;
const OUT_LIGHTBOX  = 2;
const OUT_THUMB     = 4;
const OUT_NO_ORIENT = 16;

function listOrfs(limit) {
    return readdirSync(ORF_FOLDER)
        .filter((n) => n.toLowerCase().endsWith('.orf'))
        .sort()
        .slice(0, limit);
}

function classify(orientation) {
    if (orientation === 1) return 'landscape (ori=1)';
    if (orientation === 3) return 'inverted (ori=3)';
    if (orientation === 6) return 'portrait CW (ori=6)';
    if (orientation === 8) return 'portrait CCW (ori=8)';
    return `ori=${orientation}`;
}

// EXIF orientation → clockwise quarter turns for rotate_rgb8 (pure rotations only;
// the mirrored orientations 2/4/5/7 have no rotate_rgb8 equivalent).
const QUARTER_TURNS = { 1: 0, 3: 2, 6: 1, 8: 3 };

function decode(fn, bytes, flags, keepRgb = true) {
    const t0 = performance.now();
    const r = fn(bytes, flags, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
    const ms = performance.now() - t0;
    try {
        return { w: r.width, h: r.height, ori: r.orientation, orientMs: r.orient_ms, ms,
                 rgb: keepRgb ? r.take_rgb() : null };
    } finally { r.free(); }
}

// Deterministic proof that the rotate path is exactly "no-rotate output, rotated"
// and the OUT_NO_ORIENT path applies no rotation: dims swap for 6/8 and the
// rotated bytes equal rotate_rgb8 of the unrotated bytes.
function expectRotatedEquals(rot, noRot) {
    const turns = QUARTER_TURNS[noRot.ori];
    if (turns === undefined) return false;
    if (turns % 2) { expect([rot.w, rot.h]).toEqual([noRot.h, noRot.w]); }
    else { expect([rot.w, rot.h]).toEqual([noRot.w, noRot.h]); }
    if (turns === 0) { expect(rot.rgb).toEqual(noRot.rgb); return true; }
    const viaRotate = rawWasm.rotate_rgb8(noRot.rgb, noRot.w, noRot.h, turns);
    try { expect(viaRotate.take_rgb()).toEqual(rot.rgb); } finally { viaRotate.free(); }
    return true;
}

function decodeOrfRows(limit) {
    const fullFlags = OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB | OUT_NO_ORIENT;
    return listOrfs(limit).map((name) => {
        const bytes = readFileSync(join(ORF_FOLDER, name));
        const { w, h, ori, orientMs, ms } = decode(rawWasm.process_orf_with_flags, bytes, fullFlags, false);
        return { name, bytes, w, h, ori, pipelineMs: ms, orientMs };
    });
}

maybeFixtureTest('Phase 1+3: OUT_NO_ORIENT does the same work for portrait and landscape ORFs', async () => {
    await initRaw();
    const rows = decodeOrfRows(8);
    if (rows.length === 0) {
        console.warn(`No ORFs in ${ORF_FOLDER}; skipping`);
        return;
    }
    // No rotation on this path: every frame stays in sensor orientation, so a
    // portrait frame is the same size (same pixel count) as a landscape one.
    for (const r of rows) expect([r.w, r.h]).toEqual([rows[0].w, rows[0].h]);
    const portrait = rows.find((r) => r.ori === 6 || r.ori === 8);
    if (!portrait) {
        console.log(`note: no portrait ORF among ${rows.length}; rotate parity not exercised`);
        return;
    }
    const noRot = decode(rawWasm.process_orf_with_flags, portrait.bytes, OUT_FULL_RGB8 | OUT_NO_ORIENT);
    const rot = decode(rawWasm.process_orf_with_flags, portrait.bytes, OUT_FULL_RGB8);
    expect(expectRotatedEquals(rot, noRot)).toBe(true);
    console.log(`  ${portrait.name} (ori=${portrait.ori}): rotate path == rotate_rgb8(no-rotate) ${rot.w}x${rot.h}`);
}, 300000);

// Wall-clock half of the Phase 1 claim; opt-in only (web/timing-gate.js).
const timingFixtureTest = existsSync(ORF_FOLDER) && timingEnabled() ? test : test.skip;
timingFixtureTest('timing (RCW_TIMING=1): portrait ORF encode time matches landscape (no CPU rotate)', async () => {
    await initRaw();
    const rows = decodeOrfRows(8);

    console.log('\n=== Phase 1 verification — process_orf_with_flags(OUT_NO_ORIENT) ===');
    console.log('| File                | Dims        | Orientation         | Pipeline (ms) | orient_ms |');
    console.log('|---------------------|-------------|---------------------|---------------|-----------|');
    for (const r of rows) {
        const orientLabel = classify(r.ori);
        console.log(
            `| ${r.name.padEnd(20)}| ${(r.w + 'x' + r.h).padEnd(12)}| ${orientLabel.padEnd(20)}` +
            `| ${r.pipelineMs.toFixed(0).padStart(13)} ` +
            `| ${r.orientMs.toFixed(2).padStart(9)} |`,
        );
    }

    // Phase 1 claim: orient_ms should be ~0 with OUT_NO_ORIENT (no rotation invoked).
    for (const r of rows) {
        expect(r.orientMs).toBeLessThan(2); // tiny constant time, not a full transpose
    }

    // Phase 1 claim: total pipeline time should be similar between portrait and
    // landscape (within 25%) — the orientation-dependent variance from
    // apply_orientation is gone.
    const landscape = rows.filter((r) => r.ori === 1);
    const portrait  = rows.filter((r) => r.ori === 6 || r.ori === 8);
    if (landscape.length > 0 && portrait.length > 0) {
        const avgL = landscape.reduce((s, r) => s + r.pipelineMs, 0) / landscape.length;
        const avgP = portrait.reduce((s, r) => s + r.pipelineMs, 0) / portrait.length;
        console.log(`\nlandscape avg: ${avgL.toFixed(0)} ms`);
        console.log(`portrait avg:  ${avgP.toFixed(0)} ms`);
        console.log(`portrait/landscape ratio: ${(avgP / avgL).toFixed(2)}× (< 1.25 expected)`);
        expect(Math.abs(avgP - avgL) / avgL).toBeLessThan(0.25);
    } else {
        console.log(`note: only ${landscape.length} landscape + ${portrait.length} portrait — can't compare`);
    }
}, 180000);

// Look for portrait orientation among DNG files in either fixture dir.
function findPortraitDng() {
    for (const dir of [ORF_FOLDER, String.raw`C:\Foo\raw-converter\tests`]) {
        if (!existsSync(dir)) continue;
        const names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.dng'));
        for (const name of names) {
            const bytes = readFileSync(join(dir, name));
            // Peek at TIFF orientation tag (0x0112) in IFD0 — quick parse.
            const ori = peekDngOrientation(bytes);
            if (ori !== 1) return { dir, name, bytes, ori };
        }
    }
    return null;
}

function peekDngOrientation(buf) {
    // Tiny TIFF parser: read endianness, magic, IFD0 offset, find tag 0x0112.
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const le = dv.getUint16(0) === 0x4949;
    const r16 = (o) => dv.getUint16(o, le);
    const r32 = (o) => dv.getUint32(o, le);
    const magic = r16(2);
    if (magic !== 42) return 1;
    let ifd = r32(4);
    const nEntries = r16(ifd);
    for (let i = 0; i < nEntries; i++) {
        const ent = ifd + 2 + i * 12;
        if (r16(ent) === 0x0112) {
            return r16(ent + 8);
        }
    }
    return 1;
}

maybeFixtureTest('Phase 1+3: portrait DNG → A/B rotate vs no-rotate', async () => {
    await initRaw();
    const found = findPortraitDng();
    if (!found) {
        console.log('No portrait DNG with orientation != 1 in fixtures; skipping');
        return;
    }
    console.log(`Portrait fixture: ${found.dir}\\${found.name} (EXIF ori=${found.ori})`);
    expectRotateAB(rawWasm.process_dng_with_flags, found.bytes, found.name);
}, 180000);

// Same file through the rotate and OUT_NO_ORIENT paths: the rotate output must be
// the no-rotate output turned by the EXIF orientation (bytes, not timings).
function expectRotateAB(fn, bytes, name) {
    const flags = OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB;
    const rot = decode(fn, bytes, flags);
    const noRot = decode(fn, bytes, flags | OUT_NO_ORIENT);
    expect(noRot.ori).toBe(rot.ori);
    if (!expectRotatedEquals(rot, noRot)) {
        // Mirrored orientations: rotate_rgb8 cannot model them; dims still must match the EXIF transform.
        expect([rot.w, rot.h]).toEqual(noRot.ori >= 5 ? [noRot.h, noRot.w] : [noRot.w, noRot.h]);
    }
    console.log(`  ${name} (ori=${rot.ori}): rotate ${rot.w}x${rot.h} (orient_ms=${rot.orientMs.toFixed(2)}),` +
        ` no-rotate ${noRot.w}x${noRot.h} (orient_ms=${noRot.orientMs.toFixed(2)})`);
}

maybeFixtureTest('Phase 3: A/B same-file with vs without OUT_NO_ORIENT', async () => {
    await initRaw();
    const names = listOrfs(2);
    if (names.length === 0) return;
    const name = names[0];
    const bytes = readFileSync(join(ORF_FOLDER, name));

    // ori=1: identical bytes on both paths; otherwise the rotate output is the turned no-rotate output.
    expectRotateAB(rawWasm.process_orf_with_flags, bytes, name);
}, 180000);

test('Phase 3: rotate_rgb8 fast path round-trip', async () => {
    await initRaw();
    const { rotate_rgb8 } = rawWasm;
    // Tiny synthetic 7×5 RGB.
    const w = 7, h = 5;
    const src = new Uint8Array(w * h * 3);
    for (let i = 0; i < src.length; i++) src[i] = (i & 0xff);
    // 90 CW then 90 CCW should give identity (turns 1 then 3 = 4).
    const r1 = rotate_rgb8(src, w, h, 1);
    const r1bytes = r1.take_rgb();
    expect(r1.width).toBe(h);
    expect(r1.height).toBe(w);
    const r2 = rotate_rgb8(r1bytes, h, w, 3);
    const r2bytes = r2.take_rgb();
    expect(r2.width).toBe(w);
    expect(r2.height).toBe(h);
    expect(r2bytes).toEqual(src);
    r1.free();
    r2.free();
});
