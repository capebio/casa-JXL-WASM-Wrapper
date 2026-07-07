/**
 * S5 golden corpus check.
 *
 * Decodes each RAW file in docs/golden-corpus.json at fixed neutral sliders
 * via the shipped WASM pipeline (web/pkg), computes SHA256 of the RGBA8 pixel
 * buffer, and — if the SHA256 differs from the stored golden — runs a
 * butteraugli comparison against the stored golden buffer.
 *
 * Exit 0: all corpus files pass (or were skipped due to missing file).
 * Exit 1: any file exceeds the threshold.
 *
 * Usage (must use bun --smol on Windows to avoid mprotect/JIT conflict with WASM shared memory):
 *   bun --smol scripts/golden-check.mjs            # check mode
 *   bun --smol scripts/golden-check.mjs --update   # regenerate goldens and exit 0
 *
 * Environment:
 *   GOLDEN_THRESHOLD   butteraugli threshold (default 0.05, per S5-GOLDEN-WORKFLOW.md)
 *
 * Notes:
 * - SHA256 match => butteraugli 0.000, instant pass (no buffer load needed).
 * - SHA256 mismatch + buffer present => butteraugli comparison.
 * - SHA256 mismatch + buffer absent => FAIL with instructions to run --update.
 * - File absent (machine-gated) => SKIP with warning (not a failure).
 * - Golden buffers (docs/golden-buffers/*.rgba) are gitignored large binaries;
 *   they are generated locally by --update and are not committed.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── path constants ────────────────────────────────────────────────────────────
const __scriptDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT   = join(__scriptDir, '..');
const CORPUS_JSON = join(REPO_ROOT, 'docs', 'golden-corpus.json');
const BUFFERS_DIR = join(REPO_ROOT, 'docs', 'golden-buffers');

const THRESHOLD = Number(process.env.GOLDEN_THRESHOLD ?? '0.05');
const isUpdate  = process.argv.includes('--update');

// ── WASM ──────────────────────────────────────────────────────────────────────
// Import path is relative to this file; raw_converter_wasm.js uses import.meta.url
// internally, so it resolves raw_converter_wasm_bg.wasm correctly from web/pkg/.
import initRaw, {
    process_orf,
    process_dng,
    process_cr2,
} from '../web/pkg/raw_converter_wasm.js';

await initRaw();

// ── butteraugli (JS approximation, identical to web/jxl-butteraugli.js) ──────
import { createButteraugliComparer } from '../web/jxl-butteraugli.js';

// ── helpers ───────────────────────────────────────────────────────────────────
function sha256hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

/**
 * Resolve a corpus path entry:
 * - Absolute (C:\... or /...) → used as-is.
 * - Relative → joined with REPO_ROOT (allows cross-worktree portability).
 */
function resolvePath(pathStr) {
    if (/^[A-Za-z]:/.test(pathStr) || pathStr.startsWith('/')) return pathStr;
    return join(REPO_ROOT, pathStr.replace(/\\/g, '/'));
}

/**
 * Decode a RAW file at strictly neutral sliders (all zero, camera WB).
 * Returns { rgba: Uint8Array, w: number, h: number }.
 * Throws on WASM error (corrupt file, unsupported format, etc.).
 */
function decodeNeutral(absPath, format) {
    const bytes = new Uint8Array(readFileSync(absPath));
    const fn = format === 'ORF' ? process_orf
             : format === 'DNG' ? process_dng
             : process_cr2;
    // Neutral: exposure=0, contrast=0, highlights=0, shadows=0, whites=0,
    //          blacks=0, saturation=0, vibrance=0, temp=0, tint=0,
    //          wb_r_override=NaN (use camera WB), wb_b_override=NaN,
    //          texture=0, clarity=0
    const result = fn(bytes, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
    try {
        const rgba = result.rgba(); // RGBA8, width×height×4 bytes (copy from WASM heap)
        const w    = result.width;
        const h    = result.height;
        return { rgba, w, h };
    } finally {
        result.free();
    }
}

// ── main ──────────────────────────────────────────────────────────────────────
console.log(`golden-check  mode=${isUpdate ? 'UPDATE' : 'CHECK'}  threshold=${THRESHOLD}`);
console.log(`corpus: ${CORPUS_JSON}\n`);

const corpus = JSON.parse(readFileSync(CORPUS_JSON, 'utf8'));

if (isUpdate) {
    mkdirSync(BUFFERS_DIR, { recursive: true });
}

let passed = 0, failed = 0, skipped = 0;

for (const entry of corpus.entries) {
    const absPath = resolvePath(entry.path);

    if (!existsSync(absPath)) {
        console.log(`  SKIP   ${entry.id}: file not found (machine-gated)`);
        console.log(`         tried: ${absPath}`);
        skipped++;
        continue;
    }

    process.stdout.write(`  decode ${entry.id} (${entry.format})... `);
    let decoded;
    try {
        decoded = decodeNeutral(absPath, entry.format);
    } catch (e) {
        console.log('');
        console.error(`  ERROR  ${entry.id}: decode failed: ${e.message}`);
        failed++;
        continue;
    }

    const { rgba, w, h } = decoded;
    const sha = sha256hex(rgba);

    if (isUpdate) {
        const bufPath = join(BUFFERS_DIR, `${entry.id}.rgba`);
        writeFileSync(bufPath, rgba);
        entry.sha256_rgba8 = sha;
        entry.width  = w;
        entry.height = h;
        entry.updated = new Date().toISOString().slice(0, 10);
        console.log(`${w}x${h}`);
        console.log(`  UPDATE ${entry.id}: sha256=${sha.slice(0, 16)}…  buffer=${bufPath}`);
        passed++;
        continue;
    }

    console.log(`${w}x${h}`);

    // ── check mode ─────────────────────────────────────────────────────────
    if (!entry.sha256_rgba8) {
        console.log(`  SKIP   ${entry.id}: no golden SHA256 in corpus.json`);
        console.log(`         Run --update to generate goldens.`);
        skipped++;
        continue;
    }

    // Fast path: SHA256 exact match => pixel-identical, butteraugli = 0.
    if (sha === entry.sha256_rgba8) {
        console.log(`  PASS   ${entry.id}: SHA256 match — butteraugli = 0.000`);
        passed++;
        continue;
    }

    // SHA256 changed — load stored buffer for butteraugli comparison.
    const bufPath = join(BUFFERS_DIR, `${entry.id}.rgba`);
    if (!existsSync(bufPath)) {
        console.error(`  FAIL   ${entry.id}: SHA256 changed + no golden buffer`);
        console.error(`         Expected: ${entry.sha256_rgba8.slice(0, 16)}…`);
        console.error(`         Got:      ${sha.slice(0, 16)}…`);
        console.error(`         Run --update after David (capebio@gmail.com) reviews the change.`);
        failed++;
        continue;
    }

    process.stdout.write(`  butter ${entry.id}: SHA256 changed — computing butteraugli... `);
    const goldenRgba = new Uint8Array(readFileSync(bufPath));
    if (goldenRgba.length !== w * h * 4) {
        console.log('');
        console.error(`  FAIL   ${entry.id}: golden buffer size mismatch`);
        console.error(`         Buffer: ${goldenRgba.length} bytes, expected ${w * h * 4}`);
        console.error(`         Run --update to regenerate.`);
        failed++;
        continue;
    }
    const compare = createButteraugliComparer(goldenRgba, w, h);
    const score   = compare(rgba);
    console.log(`score = ${score.toFixed(4)}`);

    if (score <= THRESHOLD) {
        console.log(`  PASS   ${entry.id}: butteraugli ${score.toFixed(4)} <= ${THRESHOLD}`);
        passed++;
    } else {
        console.error(`  FAIL   ${entry.id}: butteraugli ${score.toFixed(4)} > ${THRESHOLD}`);
        console.error(`         Perceptible colour change. Request sign-off from David (capebio@gmail.com)`);
        console.error(`         then run --update to adopt the new golden.`);
        failed++;
    }
}

// ── finalize --update ─────────────────────────────────────────────────────────
if (isUpdate) {
    corpus.date = new Date().toISOString().slice(0, 10);
    writeFileSync(CORPUS_JSON, JSON.stringify(corpus, null, 2) + '\n');
    console.log(`\ndocs/golden-corpus.json updated (${passed} decoded, ${skipped} skipped).`);
    process.exit(0);
}

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\nResults: ${passed} pass, ${failed} fail, ${skipped} skip`);
if (failed > 0) {
    console.error('Golden check FAILED. See details above.');
    process.exit(1);
}
process.exit(0);
