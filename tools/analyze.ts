// Quantitative comparison: WASM pipeline output vs Windows Photos reference JPEG.
//
// Segments pixels into shadow/midtone/highlight zones by luminance and reports
// per-channel mean + percentiles for each zone, plus the delta (ours - ref).
// Use this to diagnose shadow dullness, colour bias, clipping, etc.
//
// Usage: bun analyze.ts [orf] [ref_jpg]
//   Defaults to the test files in c:\Foo\raw-converter\tests\

import init, { process_orf, downscale_rgb } from "./pkg/raw_converter_wasm.js";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { parseArgs } from "node:util";
import { CMP_W as DEFAULT_CMP_W, LUM_R, LUM_G, LUM_B } from "./tools/orf-utils.ts";

// ---------------------------------------------------------------------------
// CLI Parsing & Configuration
// ---------------------------------------------------------------------------
const { values, positionals } = parseArgs({
    options: {
        width: { type: "string" },
        shadow: { type: "string" },
        highlight: { type: "string" },
        json: { type: "boolean" },
    },
    allowPositionals: true,
});

const isJson = !!values.json;

const ORF_PATH =
    positionals[0] ??
    String.raw`c:\Foo\raw-converter\tests\P1110226.ORF`;
const REF_PATH =
    positionals[1] ??
    String.raw`c:\Foo\raw-converter\tests\P1110226 windows.jpg`;

// Comparison resolution — both images rescaled to this before analysis.
// Smaller = faster; 1200px is plenty for statistics.
const CMP_W = values.width !== undefined ? parseInt(values.width, 10) : DEFAULT_CMP_W;

// Luminance zone boundaries (0–255 scale).
const SHADOW_MAX = values.shadow !== undefined ? parseFloat(values.shadow) : 80;    // < 80  → shadow
const HIGHLIGHT_MIN = values.highlight !== undefined ? parseFloat(values.highlight) : 180; // > 180 → highlight
// 80–180 → midtone

// ---------------------------------------------------------------------------
// Init WASM
// ---------------------------------------------------------------------------
const wasmBytes = readFileSync(
    new URL("./pkg/raw_converter_wasm_bg.wasm", import.meta.url),
);
await init({ module_or_path: wasmBytes });

// ---------------------------------------------------------------------------
// Run our pipeline
// ---------------------------------------------------------------------------
if (!isJson) console.log(`\nProcessing: ${ORF_PATH}`);
const rawBytes = new Uint8Array(readFileSync(ORF_PATH));
const t0 = performance.now();
const result = process_orf(
    rawBytes,
    /* exposure_ev */ 0,
    /* contrast    */ 0,
    /* highlights  */ 0,
    /* shadows     */ 0,
    /* whites      */ 0,
    /* blacks      */ 0,
    /* saturation  */ 0,
    /* vibrance    */ 0,
    /* temp        */ 0,
    /* tint        */ 0,
    /* wb_r_override */ NaN,
    /* wb_b_override */ NaN,
    /* texture     */ 0,
    /* clarity     */ 0,
);
if (!isJson) {
    console.log(`Pipeline: ${(performance.now() - t0).toFixed(0)} ms  (dec ${result.decompress_ms.toFixed(0)} / dem ${result.demosaic_ms.toFixed(0)} / tone ${result.tonemap_ms.toFixed(0)} / ori ${result.orient_ms.toFixed(0)})`);
    console.log(`Dims: ${result.width}×${result.height}  WB R=${result.wb_r_used.toFixed(3)} B=${result.wb_b_used.toFixed(3)}  matrix=${result.color_matrix_from_mn ? 'mn' : 'fallback'}`);
}

const fullRgb = result.take_rgb();
const fullW = result.width;
const fullH = result.height;

// Downscale to comparison size
const cmpH = Math.round((fullH * CMP_W) / fullW);
const oursRgb = downscale_rgb(fullRgb, fullW, fullH, CMP_W, cmpH);

// ---------------------------------------------------------------------------
// Load reference JPEG, downscale to comparison size using same resampler
// ---------------------------------------------------------------------------
if (!isJson) console.log(`\nLoading reference: ${REF_PATH}`);
const { data: refFullRgb, info: refInfo } = await sharp(REF_PATH)
    .rotate()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

const refW = refInfo.width;
const refH = refInfo.height;

if ((refW > refH) !== (fullW > fullH)) {
    console.warn(`⚠ Warning: Orientation mismatch between ours (${fullW}x${fullH}) and reference (${refW}x${refH}) after orientation.`);
}

const refFullU8 = new Uint8Array(refFullRgb.buffer, refFullRgb.byteOffset, refFullRgb.byteLength);
const refRgb = downscale_rgb(refFullU8, refW, refH, CMP_W, cmpH);

// ---------------------------------------------------------------------------
// Statistics engine
// ---------------------------------------------------------------------------
interface ZoneStat {
    n: number;
    rMean: number; gMean: number; bMean: number;
    rP10: number;  gP10: number;  bP10: number;
    rP50: number;  gP50: number;  bP50: number;
    rP90: number;  gP90: number;  bP90: number;
}

// per image: hist[zone][channel] = Uint32Array(256); plus global sums
function buildStats(rgb: Uint8Array) {
    const hist = [0, 1, 2].map(() => [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]);
    let rSum = 0, gSum = 0, bSum = 0, lumSum = 0;
    const n = rgb.length / 3;
    if (n === 0) return { hist, global: { r: 0, g: 0, b: 0, lum: 0 }, n: 0 };
    for (let i = 0, o = 0; i < n; i++, o += 3) {
        const r = rgb[o], g = rgb[o+1], b = rgb[o+2];
        rSum += r; gSum += g; bSum += b;
        // Rec.709 luminance weighting on sRGB-encoded bytes per A5
        const lum = LUM_R * r + LUM_G * g + LUM_B * b;
        lumSum += lum;
        const z = lum < SHADOW_MAX ? 0 : lum > HIGHLIGHT_MIN ? 2 : 1;
        hist[z][0][r]++; hist[z][1][g]++; hist[z][2][b]++;
    }
    return { hist, global: { r: rSum / n, g: gSum / n, b: bSum / n, lum: lumSum / n }, n };
}

function computeZoneChannelStats(hist: Uint32Array) {
    let count = 0;
    let sum = 0;
    for (let v = 0; v < 256; v++) {
        const cnt = hist[v];
        count += cnt;
        sum += v * cnt;
    }
    if (count === 0) {
        return { mean: 0, p10: 0, p50: 0, p90: 0, count: 0 };
    }
    const mean = sum / count;

    // percentile definition: smallest value whose cumulative count >= floor(p/100 * count) + 1
    const findPercentile = (p: number) => {
        const target = Math.floor((p / 100) * count) + 1;
        let cumulative = 0;
        for (let v = 0; v < 256; v++) {
            cumulative += hist[v];
            if (cumulative >= target) {
                return v;
            }
        }
        return 255;
    };

    const p10 = findPercentile(10);
    const p50 = findPercentile(50);
    const p90 = findPercentile(90);

    return { mean, p10, p50, p90, count };
}

function getZoneStat(hist: Uint32Array[][], zoneIndex: number): ZoneStat {
    const rStats = computeZoneChannelStats(hist[zoneIndex][0]);
    const gStats = computeZoneChannelStats(hist[zoneIndex][1]);
    const bStats = computeZoneChannelStats(hist[zoneIndex][2]);
    return {
        n: rStats.count,
        rMean: rStats.mean, gMean: gStats.mean, bMean: bStats.mean,
        rP10: rStats.p10, gP10: gStats.p10, bP10: bStats.p10,
        rP50: rStats.p50, gP50: gStats.p50, bP50: bStats.p50,
        rP90: rStats.p90, gP90: gStats.p90, bP90: bStats.p90,
    };
}

// ---------------------------------------------------------------------------
// Run Analysis
// ---------------------------------------------------------------------------
const oursU8 = oursRgb instanceof Uint8Array ? oursRgb : new Uint8Array(oursRgb);
const refU8  = refRgb  instanceof Uint8Array ? refRgb  : new Uint8Array(refRgb);

const oursStats = buildStats(oursU8);
const refStats = buildStats(refU8);

const oursGlobal = oursStats.global;
const refGlobal  = refStats.global;

if (!isJson) {
    console.log('\n══════════════════════════════════════════════════════════');
    console.log(' GLOBAL MEANS (all pixels, 0–255)');
    console.log('══════════════════════════════════════════════════════════');
    console.log(`  Ours : R ${oursGlobal.r.toFixed(1).padStart(5)}  G ${oursGlobal.g.toFixed(1).padStart(5)}  B ${oursGlobal.b.toFixed(1).padStart(5)}  lum ${oursGlobal.lum.toFixed(1)}`);
    console.log(`  Ref  : R ${refGlobal.r.toFixed(1).padStart(5)}  G ${refGlobal.g.toFixed(1).padStart(5)}  B ${refGlobal.b.toFixed(1).padStart(5)}  lum ${refGlobal.lum.toFixed(1)}`);
    const dR = oursGlobal.r - refGlobal.r, dG = oursGlobal.g - refGlobal.g, dB = oursGlobal.b - refGlobal.b;
    console.log(`  Delta: R ${(dR>=0?'+':'')+dR.toFixed(1).padStart(5)}  G ${(dG>=0?'+':'')+dG.toFixed(1).padStart(5)}  B ${(dB>=0?'+':'')+dB.toFixed(1).padStart(5)}`);
}

const zones = ['shadow', 'midtone', 'highlight'] as const;
const zoneIndices = { shadow: 0, midtone: 1, highlight: 2 };

for (const zone of zones) {
    const zIndex = zoneIndices[zone];
    const o = getZoneStat(oursStats.hist, zIndex);
    const r = getZoneStat(refStats.hist, zIndex);
    
    if (!isJson) {
        const pct = ((o.n / (oursU8.length / 3)) * 100).toFixed(1);
        console.log(`\n──────────────────────────────────────────────────────────`);
        console.log(` ZONE: ${zone.toUpperCase().padEnd(10)} (${pct}% of pixels, lum ${zone==='shadow'?'<'+SHADOW_MAX:zone==='highlight'?'>'+HIGHLIGHT_MIN:SHADOW_MAX+'–'+HIGHLIGHT_MIN})`);
        console.log(`──────────────────────────────────────────────────────────`);
        if (o.n === 0) { console.log('  (no pixels in zone)'); continue; }
        const fmt = (v: number) => v.toFixed(1).padStart(5);
        const fmtD = (v: number) => ((v>=0?'+':'')+v.toFixed(1)).padStart(6);
        console.log(`  Metric     R-ours  G-ours  B-ours  │  R-ref   G-ref   B-ref   │  ΔR      ΔG      ΔB`);
        const rows = [
            ['P10',  o.rP10, o.gP10, o.bP10, r.rP10, r.gP10, r.bP10],
            ['Mean', o.rMean,o.gMean,o.bMean,r.rMean,r.gMean,r.bMean],
            ['P50',  o.rP50, o.gP50, o.bP50, r.rP50, r.gP50, r.bP50],
            ['P90',  o.rP90, o.gP90, o.bP90, r.rP90, r.gP90, r.bP90],
        ] as [string, number, number, number, number, number, number][];
        for (const [label, or, og, ob, rr, rg, rb] of rows) {
            console.log(
                `  ${label.padEnd(6)}   ${fmt(or)}   ${fmt(og)}   ${fmt(ob)}  │  ${fmt(rr)}   ${fmt(rg)}   ${fmt(rb)}  │  ${fmtD(or-rr)} ${fmtD(og-rg)} ${fmtD(ob-rb)}`
            );
        }
        // Shadow lift diagnosis
        if (zone === 'shadow') {
            const shadowLiftOurs = o.rP50 + o.gP50 + o.bP50;
            const shadowLiftRef  = r.rP50 + r.gP50 + r.bP50;
            const ratio = shadowLiftRef > 0 ? shadowLiftOurs / shadowLiftRef : NaN;
            console.log(`\n  Shadow midpoint sum: ours=${shadowLiftOurs.toFixed(0)}  ref=${shadowLiftRef.toFixed(0)}  ratio=${ratio.toFixed(2)}x`);
            if (ratio < 0.85) console.log('  ⚠  Ours is significantly darker in shadows — increase BASELINE_EXP_EV or shadow lift');
            else if (ratio > 1.15) console.log('  ⚠  Ours is significantly brighter in shadows');
            else console.log('  ✓  Shadow brightness within 15% of reference');
        }
    }
}

if (!isJson) {
    console.log('\n══════════════════════════════════════════════════════════\n');
}

if (isJson) {
    const jsonOutput = {
        global: {
            ours: { r: oursGlobal.r, g: oursGlobal.g, b: oursGlobal.b, lum: oursGlobal.lum },
            ref: { r: refGlobal.r, g: refGlobal.g, b: refGlobal.b, lum: refGlobal.lum },
            delta: { r: oursGlobal.r - refGlobal.r, g: oursGlobal.g - refGlobal.g, b: oursGlobal.b - refGlobal.b }
        },
        zones: {} as Record<string, any>
    };

    for (const zone of zones) {
        const zIndex = zoneIndices[zone];
        const o = getZoneStat(oursStats.hist, zIndex);
        const r = getZoneStat(refStats.hist, zIndex);
        const pct = (o.n / (oursU8.length / 3)) * 100;

        const zoneData: any = {
            pct,
            ours: {
                n: o.n,
                rMean: o.rMean, gMean: o.gMean, bMean: o.bMean,
                rP10: o.rP10, gP10: o.gP10, bP10: o.bP10,
                rP50: o.rP50, gP50: o.gP50, bP50: o.bP50,
                rP90: o.rP90, gP90: o.gP90, bP90: o.bP90,
            },
            ref: {
                n: r.n,
                rMean: r.rMean, gMean: r.gMean, bMean: r.bMean,
                rP10: r.rP10, gP10: r.gP10, bP10: r.bP10,
                rP50: r.rP50, gP50: r.gP50, bP50: r.bP50,
                rP90: r.rP90, gP90: r.gP90, bP90: r.bP90,
            },
            delta: {
                rMean: o.rMean - r.rMean, gMean: o.gMean - r.gMean, bMean: o.bMean - r.bMean,
                rP10: o.rP10 - r.rP10, gP10: o.gP10 - r.gP10, bP10: o.bP10 - r.bP10,
                rP50: o.rP50 - r.rP50, gP50: o.gP50 - r.gP50, bP50: o.bP50 - r.bP50,
                rP90: o.rP90 - r.rP90, gP90: o.gP90 - r.gP90, bP90: o.bP90 - r.bP90,
            }
        };

        if (zone === 'shadow') {
            const shadowLiftOurs = o.rP50 + o.gP50 + o.bP50;
            const shadowLiftRef  = r.rP50 + r.gP50 + r.bP50;
            const ratio = shadowLiftRef > 0 ? shadowLiftOurs / shadowLiftRef : NaN;
            zoneData.shadowLift = {
                oursMidpointSum: shadowLiftOurs,
                refMidpointSum: shadowLiftRef,
                ratio: Number.isNaN(ratio) ? null : ratio
            };
        }

        jsonOutput.zones[zone] = zoneData;
    }

    console.log(JSON.stringify(jsonOutput));
}
