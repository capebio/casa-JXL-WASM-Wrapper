// End-to-end: ORF → wasm RGB8 → JXL encode → JXL decode → compare to
// embedded JPEG.  Confirms JXL preserves colour.

import init, { process_orf, downscale_rgb, rgb_to_rgba } from "./pkg/raw_converter_wasm.js";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import sharp from "sharp";
import encodeJxl from "@jsquash/jxl/encode.js";
import decodeJxl from "@jsquash/jxl/decode.js";
import { createDecoder, createEncoder } from "./packages/jxl-wasm/dist/facade.js";
import { CMP_W, extractLargestJpeg, stats, Stats } from "./tools/orf-utils.ts";

const wasmBytes = readFileSync(
    new URL("./pkg/raw_converter_wasm_bg.wasm", import.meta.url),
);
await init({ module_or_path: wasmBytes });

const args = process.argv.slice(2);
const hasFacade = args.includes("--facade");
const files = args.filter(arg => arg !== "--facade");

if (files.length === 0) {
    console.error("usage: bun jxl-roundtrip.ts [--facade] <orf> [orf2 ...]");
    process.exit(1);
}

for (const f of files) {
    const raw = new Uint8Array(readFileSync(f));

    // process
    const res = process_orf(raw, 0,0,0,0,0,0,0,0,0,0, NaN, NaN, 0, 0);
    const ours8 = res.take_rgb();
    const w = res.width, h = res.height;

    // Reference JPEG
    const jpeg = extractLargestJpeg(raw);
    if (!jpeg) { console.log(`${f}: no jpeg`); continue; }
    let refRgb: Uint8Array;
    try {
        const m = await sharp(jpeg).rotate().metadata();
        const refH = Math.round((m.height! * CMP_W) / m.width!);
        const r = await sharp(jpeg).rotate().resize(CMP_W, refH, { fit: 'fill' }).removeAlpha().raw().toBuffer();
        refRgb = new Uint8Array(r);
    } catch (e) {
        refRgb = new Uint8Array(0);
    }

    const name = f.split(/[\\/]/).pop()!;
    const fmt = (s: Stats) =>
        `R=${s.rMean.toFixed(0).padStart(3)} G=${s.gMean.toFixed(0).padStart(3)} B=${s.bMean.toFixed(0).padStart(3)} ` +
        `lum=${s.lum.toFixed(0).padStart(3)} sat=${s.sat.toFixed(2)} R/G=${s.rgRatio.toFixed(3)} B/G=${s.bgRatio.toFixed(3)}`;

    console.log(`\n=== ${name} ===`);
    if (refRgb.length > 0) console.log(`  jpeg ref : ${fmt(stats(refRgb))}`);

    // Encode JXL from RGBA (lossless to isolate any colour drift from compression)
    const rgba = rgb_to_rgba(ours8);

    // Run @jsquash roundtrip
    await runRoundtrip("jsquash", rgba, ours8, w, h);

    // Run facade roundtrip if requested
    if (hasFacade) {
        await runRoundtrip("facade", rgba, ours8, w, h);
    }
}

async function runRoundtrip(label: string, rgba: Uint8Array, ours8: Uint8Array, w: number, h: number) {
    let jxl: Uint8Array;
    let encMs: number;
    let decRgba: Uint8Array;
    let decW: number;
    let decH: number;

    if (label === "jsquash") {
        const t0 = performance.now();
        // Pass Uint8ClampedArray to encodeJxl to avoid 80MB buffer copy (J1)
        const clamped = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
        const jxlBuffer = await encodeJxl(
            { data: clamped, width: w, height: h },
            { lossless: true, effort: 1 } // Drop jxl encode effort from 5 to 1 for lossless speed (J3)
        );
        jxl = new Uint8Array(jxlBuffer);
        encMs = performance.now() - t0;

        const dec = await decodeJxl(jxl);
        decRgba = new Uint8Array(dec.data.buffer, dec.data.byteOffset, dec.data.byteLength);
        decW = dec.width;
        decH = dec.height;
    } else {
        // Facade J4
        const t0 = performance.now();
        const encoder = createEncoder({
            format: "rgba8",
            width: w,
            height: h,
            hasAlpha: true,
            iccProfile: null,
            exif: null,
            xmp: null,
            distance: 0, // lossless
            quality: null,
            effort: 1, // Drop jxl encode effort from 5 to 1 for lossless speed (J3)
            progressive: false,
            previewFirst: false,
            chunked: false,
        });

        try {
            await encoder.pushPixels(rgba);
            await encoder.finish();
            const chunks: Uint8Array[] = [];
            for await (const chunk of encoder.chunks()) {
                chunks.push(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk);
            }
            const totalLen = chunks.reduce((n, c) => n + c.byteLength, 0);
            jxl = new Uint8Array(totalLen);
            let offset = 0;
            for (const chunk of chunks) {
                jxl.set(chunk, offset);
                offset += chunk.byteLength;
            }
        } finally {
            await encoder.dispose();
        }
        encMs = performance.now() - t0;

        // Decode using facade
        const decoder = createDecoder({
            format: "rgba8",
            progressionTarget: "final",
            emitEveryPass: false,
            preserveIcc: false,
            preserveMetadata: false,
            copyInput: false,
        });

        try {
            decoder.push(jxl);
            await decoder.close();
            let pixels: any = null;
            for await (const event of decoder.events()) {
                if (event.type === "error") {
                    throw new Error("JXL decode failed: " + event.message);
                }
                if (event.type === "final") {
                    pixels = event.pixels;
                    decW = event.info.width;
                    decH = event.info.height;
                    break;
                }
            }
            if (!pixels) {
                throw new Error("JXL decode produced no final frame");
            }
            decRgba = new Uint8Array(pixels instanceof ArrayBuffer ? pixels : pixels.buffer, pixels.byteOffset, pixels.byteLength);
        } finally {
            await decoder.dispose();
        }
    }

    const jxlKB = (jxl.byteLength / 1024).toFixed(0);

    // Compare bit-exact (J2)
    const same = Buffer.compare(
        Buffer.from(decRgba.buffer, decRgba.byteOffset, decRgba.byteLength),
        Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength)
    ) === 0;

    console.log(`  ${label.padEnd(8)} : ${same ? "BIT-EXACT ✓" : "MISMATCH ✗"} (jxl ${jxlKB}KB, enc ${encMs.toFixed(0)}ms)`);

    if (!same) {
        // Find first mismatching byte and count
        let firstDiffIdx = -1;
        let diffCount = 0;
        const len = Math.min(decRgba.length, rgba.length);
        for (let i = 0; i < len; i++) {
            if (decRgba[i] !== rgba[i]) {
                if (firstDiffIdx === -1) {
                    firstDiffIdx = i;
                }
                diffCount++;
            }
        }
        if (decRgba.length !== rgba.length) {
            diffCount += Math.abs(decRgba.length - rgba.length);
            if (firstDiffIdx === -1) {
                firstDiffIdx = len;
            }
        }
        console.log(`    [Mismatch info] first diff at byte ${firstDiffIdx}, total diff bytes: ${diffCount} / ${rgba.length}`);

        // Strip alpha → RGB
        const decRgb = new Uint8Array(decW * decH * 3);
        for (let i = 0, j = 0; i < decRgb.length; i += 3, j += 4) {
            decRgb[i] = decRgba[j];
            decRgb[i+1] = decRgba[j+1];
            decRgb[i+2] = decRgba[j+2];
        }

        // Downscale both ours and dec to CMP_W
        const cmpH = Math.round((h * CMP_W) / w);
        const oursSmall = downscale_rgb(ours8, w, h, CMP_W, cmpH);
        const decSmall  = downscale_rgb(decRgb, decW, decH, CMP_W, cmpH);

        const fmt = (s: Stats) =>
            `R=${s.rMean.toFixed(0).padStart(3)} G=${s.gMean.toFixed(0).padStart(3)} B=${s.bMean.toFixed(0).padStart(3)} ` +
            `lum=${s.lum.toFixed(0).padStart(3)} sat=${s.sat.toFixed(2)} R/G=${s.rgRatio.toFixed(3)} B/G=${s.bgRatio.toFixed(3)}`;

        console.log(`    ours rgb : ${fmt(stats(new Uint8Array(oursSmall)))}`);
        console.log(`    jxl->dec : ${fmt(stats(new Uint8Array(decSmall)))}`);
    }
}
