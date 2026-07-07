// Compare our pipeline output vs the embedded JPEG inside the same .ORF.
// The embedded JPEG is the camera's own rendering — the "right" colour.
//
// Usage:  bun colour-cmp.ts <orf> [orf2 ...]

import init, { process_orf, downscale_rgb } from "./pkg/raw_converter_wasm.js";
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { CMP_W, extractLargestJpeg, stats, Stats } from "./tools/orf-utils.ts";

const wasmBytes = readFileSync(
    new URL("./pkg/raw_converter_wasm_bg.wasm", import.meta.url),
);
await init({ module_or_path: wasmBytes });

function pct(a: number, b: number): string {
    if (b < 1e-6) return '   n/a';
    const d = ((a / b) - 1) * 100;
    return (d >= 0 ? '+' : '') + d.toFixed(1) + '%';
}

let maxLumDelta: number | null = null;
let maxSatDelta: number | null = null;

const files: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--max-lum-delta') {
        maxLumDelta = parseFloat(process.argv[++i]);
    } else if (arg === '--max-sat-delta') {
        maxSatDelta = parseFloat(process.argv[++i]);
    } else {
        files.push(arg);
    }
}

if (files.length === 0) {
    console.error('usage: bun colour-cmp.ts <orf> [orf2 ...] [--max-lum-delta <val>] [--max-sat-delta <val>]');
    process.exit(1);
}

console.log(
    'file                     | source     |  R     G     B    lum  sat   ctr  |  R/G    B/G   | Δ vs JPEG'
);
console.log('-'.repeat(130));

for (const f of files) {
    try {
        const raw = new Uint8Array(readFileSync(f));

        // --- embedded JPEG → reference RGB at CMP_W ---
        const jpeg = extractLargestJpeg(raw);
        if (!jpeg) { console.log(`${f}: no embedded jpeg`); continue; }

        // C2: EXIF orientation post-rotation metadata
        const orientedMeta = await sharp(jpeg).rotate().metadata();
        const refW = orientedMeta.width!;
        const refH_orig = orientedMeta.height!;

        // C5: refH computed once
        const refH = Math.round((refH_orig * CMP_W) / refW);

        // --- our pipeline → RGB at CMP_W ---
        const res = process_orf(raw, 0,0,0,0,0,0,0,0,0,0, NaN, NaN, 0, 0);
        const ours8 = res.take_rgb();
        const ourW = res.width, ourH = res.height;

        // C2: orientation guard
        if ((ourW > ourH) !== (refW > refH_orig)) {
            console.warn(`  ⚠ orientation mismatch: ours ${ourW}×${ourH} vs ref ${refW}×${refH_orig}`);
        }

        // C5: downscale_rgb for reference JPEG
        const refFull = await sharp(jpeg)
            .rotate()
            .removeAlpha()
            .raw()
            .toBuffer();
        const refRgb = downscale_rgb(new Uint8Array(refFull), refW, refH_orig, CMP_W, refH);

        // oursSmall using computed refH
        const oursSmall = downscale_rgb(ours8, ourW, ourH, CMP_W, refH);

        const sRef  = stats(refRgb);
        const sOurs = stats(oursSmall);

        const name = f.split(/[\\/]/).pop()!.padEnd(24);
        const fmtS = (s: Stats) =>
            `${s.rMean.toFixed(0).padStart(4)} ${s.gMean.toFixed(0).padStart(4)} ${s.bMean.toFixed(0).padStart(4)} ` +
            `${s.lum.toFixed(0).padStart(4)} ${s.sat.toFixed(2)} ${s.contrastStd.toFixed(0).padStart(4)} | ` +
            `${s.rgRatio.toFixed(3)} ${s.bgRatio.toFixed(3)}`;
        console.log(`${name} | embed jpeg | ${fmtS(sRef)} |  ref`);
        console.log(`${name} | ours rgb8  | ${fmtS(sOurs)} | sat ${pct(sOurs.sat, sRef.sat)}  ctr ${pct(sOurs.contrastStd, sRef.contrastStd)}  lum ${pct(sOurs.lum, sRef.lum)}`);

        // C4: CI gate thresholds check
        let breached = false;
        let breachReason = "";
        if (maxLumDelta !== null) {
            const lumDeltaPct = Math.abs(((sOurs.lum / sRef.lum) - 1) * 100);
            if (lumDeltaPct > maxLumDelta) {
                breached = true;
                breachReason += `lum delta (${lumDeltaPct.toFixed(2)}%) exceeded threshold (${maxLumDelta}%). `;
            }
        }
        if (maxSatDelta !== null) {
            const satDeltaPct = Math.abs(((sOurs.sat / sRef.sat) - 1) * 100);
            if (satDeltaPct > maxSatDelta) {
                breached = true;
                breachReason += `sat delta (${satDeltaPct.toFixed(2)}%) exceeded threshold (${maxSatDelta}%). `;
            }
        }

        if (breached) {
            console.log(`FAIL: ${f} breached threshold(s): ${breachReason}`);
            process.exitCode = 1;
        }

        // Save side-by-side pngs for visual confirmation
        const stem = f.replace(/.*[\\/]/, '').replace(/\.[^.]+$/, '');
        // C5: Promise.all for writing PNGs
        await Promise.all([
            sharp(refRgb, { raw: { width: CMP_W, height: refH, channels: 3 } })
                .png().toFile(`out_${stem}_ref.png`),
            sharp(oursSmall, { raw: { width: CMP_W, height: refH, channels: 3 } })
                .png().toFile(`out_${stem}_ours.png`)
        ]);
    } catch (e) {
        console.log(`${f}: error ${(e as Error).message}`);
    }
}
