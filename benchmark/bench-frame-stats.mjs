// Rigorous micro-benchmark for analyzeProgressiveFrame (telemetry kernel).
//
//   node bench-frame-stats.mjs run <old|new> <full|trunc>   -> single fresh-process trial, prints "min=<ms>"
//   node bench-frame-stats.mjs                               -> driver: spawns isolated processes, reports min ms/call
//
// Each measured impl runs in its OWN node process (no shared JIT/IC/GC state),
// and we take the MIN ms/call across many internal+external trials — min is the
// least noise-contaminated estimator for CPU-bound micro-benchmarks.
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const W = 1920, H = 1280, N = W * H;

function makeBuf() {
    const buf = new Uint8Array(N * 4);
    let s = 12345;
    for (let k = 0; k < buf.length; k++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; buf[k] = s & 0xff; }
    return buf;
}

// --- previous implementation (verbatim, for A/B) ---
function analyzeOld(pixels, width, height) {
    const data = pixels;
    const pixelCount = Math.max(0, Math.floor(Number(width) || 0) * Math.floor(Number(height) || 0));
    const expected = pixelCount * 4;
    const limit = Math.min(data.byteLength, expected);
    let alphaMin = 255, alphaMax = 0, alphaZeroCount = 0, rgbNonzeroCount = 0, lumaSum = 0, lumaSqSum = 0, hash = 0x811c9dc5;
    const full = limit === expected;
    let i = 0;
    for (let p = 0; p < pixelCount; p++, i += 4) {
        const r = full || i < limit ? data[i] : 0;
        const g = full || i + 1 < limit ? data[i + 1] : 0;
        const b = full || i + 2 < limit ? data[i + 2] : 0;
        const a = full || i + 3 < limit ? data[i + 3] : 0;
        hash ^= r; hash = Math.imul(hash, 0x01000193) >>> 0;
        hash ^= g; hash = Math.imul(hash, 0x01000193) >>> 0;
        hash ^= b; hash = Math.imul(hash, 0x01000193) >>> 0;
        hash ^= a; hash = Math.imul(hash, 0x01000193) >>> 0;
        rgbNonzeroCount += (r !== 0) + (g !== 0) + (b !== 0);
        if (a < alphaMin) alphaMin = a;
        if (a > alphaMax) alphaMax = a;
        if (a === 0) alphaZeroCount++;
        const lumaInt = 54 * r + 183 * g + 18 * b;
        lumaSum += lumaInt; lumaSqSum += lumaInt * lumaInt;
    }
    if (pixelCount === 0) alphaMin = 0;
    const meanInt = pixelCount ? lumaSum / pixelCount : 0;
    const lumaVariance = pixelCount ? Math.max(0, (lumaSqSum / pixelCount) - meanInt * meanInt) / 65536 : 0;
    return { alphaMin, alphaMax, alphaZeroPct: pixelCount ? (alphaZeroCount / pixelCount) * 100 : 0,
        rgbNonzeroCount, lumaVariance, frameHash: (hash >>> 0).toString(16).padStart(8, '0'), pixelCount, byteLength: data.byteLength };
}

async function runTrial(impl, which) {
    const fn = impl === 'old' ? analyzeOld : (await import('./web/jxl-progressive-frame-stats.js')).analyzeProgressiveFrame;
    const full = makeBuf();
    const data = which === 'full' ? full : full.subarray(0, N * 4 - 4007);
    const ITERS = 12, TRIALS = 6, WARMUP = 8;
    let sink = 0;
    for (let i = 0; i < WARMUP; i++) sink += fn(data, W, H).rgbNonzeroCount;
    let best = Infinity;
    for (let t = 0; t < TRIALS; t++) {
        const t0 = performance.now();
        for (let i = 0; i < ITERS; i++) sink += fn(data, W, H).rgbNonzeroCount;
        const per = (performance.now() - t0) / ITERS;
        if (per < best) best = per;
    }
    if (sink === -1) console.log('');           // keep `sink` live
    console.log(`min=${best.toFixed(4)}`);
}

function spawnMin(impl, which) {
    const self = fileURLToPath(import.meta.url);
    let best = Infinity;
    for (let r = 0; r < 3; r++) {                // 3 fresh processes per cell
        const out = spawnSync(process.execPath, [self, 'run', impl, which], { encoding: 'utf8' });
        const m = /min=([\d.]+)/.exec(out.stdout || '');
        if (m) best = Math.min(best, parseFloat(m[1]));
        else process.stderr.write(out.stderr || 'no output\n');
    }
    return best;
}

const [, , mode, implArg, whichArg] = process.argv;
if (mode === 'run') {
    await runTrial(implArg, whichArg);
} else {
    console.log(`Frame ${W}x${H} (${(N / 1e6).toFixed(2)} MP). min ms/call across isolated processes (lower = faster).\n`);
    for (const which of ['full', 'trunc']) {
        const o = spawnMin('old', which);
        const n = spawnMin('new', which);
        console.log(`[${which}]  OLD ${o.toFixed(3)} ms   NEW ${n.toFixed(3)} ms   speedup ${(o / n).toFixed(3)}x`);
    }
}
