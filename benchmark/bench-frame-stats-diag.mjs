// Diagnostic flip-flop: WHERE is the time in analyzeProgressiveFrame?
// True alternation (cancels background drift) + min (contention-robust) + median.
// All variants return a live checksum so nothing is dead-code-eliminated.
import { performance } from 'node:perf_hooks';

const W = 1920, H = 1280, N = W * H, EXP = N * 4;
const data = new Uint8Array(EXP);
{ let s = 12345; for (let k = 0; k < data.length; k++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; data[k] = s & 0xff; } }
const u32 = new Uint32Array(data.buffer);

// 1. baseline: byte read + full byte-wise FNV + stats (current shipped logic)
function v_baseline() {
    let aMin = 255, aMax = 0, aZero = 0, rgbNZ = 0, lSum = 0, lSq = 0, h = 0x811c9dc5;
    for (let i = 0; i < EXP; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        h ^= r; h = Math.imul(h, 0x01000193) >>> 0;
        h ^= g; h = Math.imul(h, 0x01000193) >>> 0;
        h ^= b; h = Math.imul(h, 0x01000193) >>> 0;
        h ^= a; h = Math.imul(h, 0x01000193) >>> 0;
        rgbNZ += (r !== 0) + (g !== 0) + (b !== 0);
        if (a < aMin) aMin = a; if (a > aMax) aMax = a; if (a === 0) aZero++;
        const L = 54 * r + 183 * g + 18 * b; lSum += L; lSq += L * L;
    }
    return (h ^ rgbNZ ^ aMin ^ aMax ^ aZero ^ (lSum >>> 0)) >>> 0;
}

// 2. nohash: identical stats, FNV removed -> reveals the hash's share of the time
function v_nohash() {
    let aMin = 255, aMax = 0, aZero = 0, rgbNZ = 0, lSum = 0, lSq = 0;
    for (let i = 0; i < EXP; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        rgbNZ += (r !== 0) + (g !== 0) + (b !== 0);
        if (a < aMin) aMin = a; if (a > aMax) aMax = a; if (a === 0) aZero++;
        const L = 54 * r + 183 * g + 18 * b; lSum += L; lSq += L * L;
    }
    return (rgbNZ ^ aMin ^ aMax ^ aZero ^ (lSum >>> 0)) >>> 0;
}

// 3. u32 read, byte-extract, SAME byte-wise FNV (fewer loads, identical hash identity)
function v_u32_samehash() {
    let aMin = 255, aMax = 0, aZero = 0, rgbNZ = 0, lSum = 0, lSq = 0, h = 0x811c9dc5;
    for (let p = 0; p < N; p++) {
        const w = u32[p];
        const r = w & 0xff, g = (w >>> 8) & 0xff, b = (w >>> 16) & 0xff, a = w >>> 24;
        h ^= r; h = Math.imul(h, 0x01000193) >>> 0;
        h ^= g; h = Math.imul(h, 0x01000193) >>> 0;
        h ^= b; h = Math.imul(h, 0x01000193) >>> 0;
        h ^= a; h = Math.imul(h, 0x01000193) >>> 0;
        rgbNZ += (r !== 0) + (g !== 0) + (b !== 0);
        if (a < aMin) aMin = a; if (a > aMax) aMax = a; if (a === 0) aZero++;
        const L = 54 * r + 183 * g + 18 * b; lSum += L; lSq += L * L;
    }
    return (h ^ rgbNZ ^ aMin ^ aMax ^ aZero ^ (lSum >>> 0)) >>> 0;
}

// 4. u32 read + ONE hash step per pixel on the whole word (breaks FNV identity; measures word-hash)
function v_u32_wordhash() {
    let aMin = 255, aMax = 0, aZero = 0, rgbNZ = 0, lSum = 0, lSq = 0, h = 0x811c9dc5;
    for (let p = 0; p < N; p++) {
        const w = u32[p];
        h ^= w; h = Math.imul(h, 0x01000193) >>> 0;
        const r = w & 0xff, g = (w >>> 8) & 0xff, b = (w >>> 16) & 0xff, a = w >>> 24;
        rgbNZ += (r !== 0) + (g !== 0) + (b !== 0);
        if (a < aMin) aMin = a; if (a > aMax) aMax = a; if (a === 0) aZero++;
        const L = 54 * r + 183 * g + 18 * b; lSum += L; lSq += L * L;
    }
    return (h ^ rgbNZ ^ aMin ^ aMax ^ aZero ^ (lSum >>> 0)) >>> 0;
}

// 5. word-hash, two independent hash lanes (break the serial dependency -> ILP)
function v_u32_wordhash_2lane() {
    let aMin = 255, aMax = 0, aZero = 0, rgbNZ = 0, lSum = 0, lSq = 0, h0 = 0x811c9dc5, h1 = 0x811c9dc5;
    for (let p = 0; p < N; p += 2) {
        const w0 = u32[p], w1 = u32[p + 1];
        h0 ^= w0; h0 = Math.imul(h0, 0x01000193) >>> 0;
        h1 ^= w1; h1 = Math.imul(h1, 0x01000193) >>> 0;
        const r0 = w0 & 0xff, g0 = (w0 >>> 8) & 0xff, b0 = (w0 >>> 16) & 0xff, a0 = w0 >>> 24;
        const r1 = w1 & 0xff, g1 = (w1 >>> 8) & 0xff, b1 = (w1 >>> 16) & 0xff, a1 = w1 >>> 24;
        rgbNZ += (r0 !== 0) + (g0 !== 0) + (b0 !== 0) + (r1 !== 0) + (g1 !== 0) + (b1 !== 0);
        if (a0 < aMin) aMin = a0; if (a0 > aMax) aMax = a0; if (a0 === 0) aZero++;
        if (a1 < aMin) aMin = a1; if (a1 > aMax) aMax = a1; if (a1 === 0) aZero++;
        const L0 = 54 * r0 + 183 * g0 + 18 * b0; lSum += L0; lSq += L0 * L0;
        const L1 = 54 * r1 + 183 * g1 + 18 * b1; lSum += L1; lSq += L1 * L1;
    }
    return ((h0 ^ h1) ^ rgbNZ ^ aMin ^ aMax ^ aZero ^ (lSum >>> 0)) >>> 0;
}

const variants = [
    ['baseline (byte FNV)', v_baseline],
    ['nohash (stats only) ', v_nohash],
    ['u32 + same byte FNV ', v_u32_samehash],
    ['u32 + word hash     ', v_u32_wordhash],
    ['u32 word hash 2-lane', v_u32_wordhash_2lane],
];

const min = a => Math.min(...a), median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const t1 = fn => { const s = performance.now(); const v = fn(); return [performance.now() - s, v]; };

// warm all
let sink = 0;
for (let i = 0; i < 10; i++) for (const [, fn] of variants) sink ^= fn();
const ITERS = 40;
const times = variants.map(() => []);
for (let i = 0; i < ITERS; i++) {                       // TRUE alternation each iter
    for (let v = 0; v < variants.length; v++) { const [t, val] = t1(variants[v][1]); times[v].push(t); sink ^= val; }
}
if (sink === -1) console.log('');                        // keep sink live

console.log(`Frame ${W}x${H} (${(N / 1e6).toFixed(2)} MP), ${ITERS} alternating iters, min ms/call (lower=faster):\n`);
const base = min(times[0]);
for (let v = 0; v < variants.length; v++) {
    const mn = min(times[v]), md = median(times[v]);
    console.log(`${variants[v][0]}  min ${mn.toFixed(2)} ms   median ${md.toFixed(2)} ms   vs baseline ${(base / mn).toFixed(2)}x`);
}
