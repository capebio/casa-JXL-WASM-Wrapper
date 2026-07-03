// Progressive-frame telemetry kernel.
//
// Shape note (kept deliberately): the accumulator kernels return only RAW
// accumulators (sums, counts, integer hash). All derived metrics (mean, variance,
// percentages, hex hash) are computed afterwards in `analyzeProgressiveFrame`.
// This separation keeps the hot per-pixel loop branch-light and makes a future
// WASM/SIMD port a drop-in for the kernel only. See docs/JxlDashboardFrameStats.md.
//
// WASM was evaluated and rejected for this kernel: it is a single-pass,
// memory-bound reduction called a handful of times per image (results are cached
// by the caller), so the JS->WASM RGBA heap copy would erase any arithmetic gain.

const FNV_PRIME = 0x01000193;
const FNV_OFFSET = 0x811c9dc5;

// Raw accumulator kernels. No allocations, no derived math, sequential access.
// The full and truncated paths are kept as SEPARATE functions (not branches in
// one body) so TurboFan optimizes each in isolation — sharing one function lets
// the hot full-buffer specialization penalize the cold truncated branch.

// Fast path: whole buffer present, no per-pixel bounds checks. This is the case
// for every fully-decoded progressive pass; it is the path that matters.
function accumulateFull(data, expected) {
    let alphaMin = 255;
    let alphaMax = 0;
    let alphaZeroCount = 0;
    let rgbNonzeroCount = 0;
    let lumaSum = 0;
    // Welford online variance: M2/n = population variance.
    // Eliminates float64 precision loss from lumaSqSum at >2MP.
    let lumaM2 = 0;
    let lumaMean = 0;
    let lumaCount = 0;
    let hash = FNV_OFFSET;

    for (let i = 0; i < expected; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        hash ^= r; hash = Math.imul(hash, FNV_PRIME) >>> 0;
        hash ^= g; hash = Math.imul(hash, FNV_PRIME) >>> 0;
        hash ^= b; hash = Math.imul(hash, FNV_PRIME) >>> 0;
        hash ^= a; hash = Math.imul(hash, FNV_PRIME) >>> 0;
        rgbNonzeroCount += (r !== 0) + (g !== 0) + (b !== 0);
        if (a < alphaMin) alphaMin = a;
        if (a > alphaMax) alphaMax = a;
        if (a === 0) alphaZeroCount++;
        const lumaInt = 54 * r + 183 * g + 18 * b;
        lumaSum += lumaInt;
        lumaCount++;
        const delta = lumaInt - lumaMean;
        lumaMean += delta / lumaCount;
        lumaM2 += delta * (lumaInt - lumaMean);
    }

    return { alphaMin, alphaMax, alphaZeroCount, rgbNonzeroCount, lumaSum, lumaM2, hash };
}

// Truncated path: zero-fill bytes past `limit` (matches original behaviour).
// Only hit for the final partial chunk of an incomplete buffer.
function accumulateTruncated(data, pixelCount, limit) {
    let alphaMin = 255;
    let alphaMax = 0;
    let alphaZeroCount = 0;
    let rgbNonzeroCount = 0;
    let lumaSum = 0;
    let lumaM2 = 0;
    let lumaMean = 0;
    let lumaCount = 0;
    let hash = FNV_OFFSET;

    let i = 0;
    for (let p = 0; p < pixelCount; p++, i += 4) {
        const r = i < limit ? data[i] : 0;
        const g = i + 1 < limit ? data[i + 1] : 0;
        const b = i + 2 < limit ? data[i + 2] : 0;
        const a = i + 3 < limit ? data[i + 3] : 0;
        hash ^= r; hash = Math.imul(hash, FNV_PRIME) >>> 0;
        hash ^= g; hash = Math.imul(hash, FNV_PRIME) >>> 0;
        hash ^= b; hash = Math.imul(hash, FNV_PRIME) >>> 0;
        hash ^= a; hash = Math.imul(hash, FNV_PRIME) >>> 0;
        rgbNonzeroCount += (r !== 0) + (g !== 0) + (b !== 0);
        if (a < alphaMin) alphaMin = a;
        if (a > alphaMax) alphaMax = a;
        if (a === 0) alphaZeroCount++;
        const lumaInt = 54 * r + 183 * g + 18 * b;
        lumaSum += lumaInt;
        lumaCount++;
        const delta = lumaInt - lumaMean;
        lumaMean += delta / lumaCount;
        lumaM2 += delta * (lumaInt - lumaMean);
    }

    return { alphaMin, alphaMax, alphaZeroCount, rgbNonzeroCount, lumaSum, lumaM2, hash };
}

export function formatFrameHash(hash) {
    return (hash >>> 0).toString(16).padStart(8, '0');
}

// Optional WASM kernel backend, injected by the host (the frame-stats worker calls
// setFrameStatsWasm once raw_converter_wasm is initialized). It must be a synchronous
// (pixels: Uint8Array, width, height) => { alphaMin, alphaMax, alphaZeroPct,
// rgbNonzeroCount, lumaVariance, meanLuma, frameHashInt, pixelCount } using the exact
// FNV hash (frame_stats export). null = use the JS kernel (the default / fallback).
let _frameStatsWasm = null;
export function setFrameStatsWasm(fn) {
    _frameStatsWasm = (typeof fn === 'function') ? fn : null;
}

export function analyzeProgressiveFrame(pixels, width, height) {
    const data = pixels instanceof Uint8Array
        ? pixels
        : new Uint8Array(pixels?.buffer ?? pixels ?? new ArrayBuffer(0), pixels?.byteOffset ?? 0, pixels?.byteLength ?? undefined);
    const wInt = Math.max(0, Math.floor(Number(width) || 0));
    const hInt = Math.max(0, Math.floor(Number(height) || 0));
    const pixelCount = wInt * hInt;
    const expected = pixelCount * 4;
    const limit = Math.min(data.byteLength, expected);

    // WASM kernel path (injected by the worker). Exact-FNV parity with the JS path,
    // ~3.7x faster. Falls back to the JS kernel on any error or when not injected.
    if (_frameStatsWasm) {
        try {
            const w = _frameStatsWasm(data, wInt, hInt);
            if (w) {
                return {
                    alphaMin: pixelCount ? w.alphaMin : 0,
                    alphaMax: w.alphaMax,
                    alphaZeroPct: w.alphaZeroPct,
                    rgbNonzeroCount: w.rgbNonzeroCount,
                    lumaVariance: w.lumaVariance,
                    meanLuma: w.meanLuma,
                    frameHash: formatFrameHash(w.frameHashInt),
                    frameHashInt: w.frameHashInt >>> 0,
                    pixelCount: w.pixelCount,
                    byteLength: data.byteLength,
                    truncated: limit !== expected,
                    validPixels: limit >>> 2,
                };
            }
        } catch {
            // fall through to the JS kernel
        }
    }

    const raw = limit === expected
        ? accumulateFull(data, expected)
        : accumulateTruncated(data, pixelCount, limit);

    // Derived metrics live outside the kernel.
    let alphaMin = raw.alphaMin;
    if (pixelCount === 0) {
        alphaMin = 0;
    }

    const meanInt = pixelCount ? raw.lumaSum / pixelCount : 0;
    // Welford M2/n = population variance of lumaInt; same semantics as old E[X²]-E[X]².
    const lumaVariance = pixelCount
        ? Math.max(0, raw.lumaM2 / pixelCount) / 65536
        : 0;

    return {
        alphaMin,
        alphaMax: raw.alphaMax,
        alphaZeroPct: pixelCount ? (raw.alphaZeroCount / pixelCount) * 100 : 0,
        rgbNonzeroCount: raw.rgbNonzeroCount,
        lumaVariance,
        // meanLuma is the per-channel-weighted mean rescaled to ~0..255; free here
        // (already accumulated) and useful for blank-frame / convergence telemetry.
        meanLuma: meanInt / 256,
        frameHash: formatFrameHash(raw.hash),
        frameHashInt: raw.hash >>> 0,
        pixelCount,
        byteLength: data.byteLength,
        truncated: limit !== expected,
        validPixels: limit >>> 2,
    };
}

export function formatFrameStatsLog(stats) {
    return `alphaMin=${stats.alphaMin} ` +
        `alphaMax=${stats.alphaMax} ` +
        `alphaZeroPct=${stats.alphaZeroPct.toFixed(2)} ` +
        `rgbNonzero=${stats.rgbNonzeroCount} ` +
        `lumaVar=${stats.lumaVariance.toFixed(2)} ` +
        `hash=${stats.frameHash}`;
}

export function formatFrameStatsCompact(stats) {
    return `a=${stats.alphaMin}-${stats.alphaMax}|` +
        `a0=${stats.alphaZeroPct.toFixed(2)}%|` +
        `rgbNonzero=${stats.rgbNonzeroCount}|` +
        `lumaVar=${stats.lumaVariance.toFixed(2)}|` +
        `hash=${stats.frameHash}`;
}
