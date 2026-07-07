// Dump parsed MakerNote camera WB multipliers, WB mode, and color matrix origin for each ORF.
// Note: Only the active multipliers (used for final raw decode) are printed. If camera WB is present, 
// it is trusted unconditionally per the pipeline calibration rule. (Honest comment per WB-2).

import init, { process_orf } from "./pkg/raw_converter_wasm.js";
import { readFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

const wasmBytes = readFileSync(
    new URL("./pkg/raw_converter_wasm_bg.wasm", import.meta.url),
);
await init({ module_or_path: wasmBytes });

const args = process.argv.slice(2);
const options = {
    json: args.includes("--json"),
};

const inputArgs = args.filter(a => !a.startsWith("-"));

// WB-3: No args -> print usage and exit 1
if (inputArgs.length === 0) {
    console.error("usage: tsx wb-probe.ts <file.orf|dir> [...] [--json]");
    process.exit(1);
}

// WB-3: Expand directories (PowerShell does not glob *.ORF)
const files: string[] = [];
for (const arg of inputArgs) {
    try {
        const stat = statSync(arg);
        if (stat.isDirectory()) {
            const list = readdirSync(arg).filter(n => /\.orf$/i.test(n));
            for (const name of list) {
                files.push(join(arg, name));
            }
        } else {
            files.push(arg);
        }
    } catch (err) {
        console.error(`Error reading input path "${arg}": ${String(err)}`);
        process.exit(1);
    }
}

if (!options.json) {
    console.log('file                     | wb_mode | from_cam | wb_r  wb_b | matrix');
    console.log('-'.repeat(90));
}

for (const f of files) {
    try {
        const raw = new Uint8Array(readFileSync(f));

        // WB-1: Named constants for raw-converter WASM's 15 parameters
        // Defaults = neutral pipeline (neutral look settings, no overrides).
        const EXPOSURE_EV = 0;
        const CONTRAST = 0;
        const HIGHLIGHTS = 0;
        const SHADOWS = 0;
        const WHITES = 0;
        const BLACKS = 0;
        const SATURATION = 0;
        const VIBRANCE = 0;
        const TEMP = 0;
        const TINT = 0;
        const WB_R_OVERRIDE = NaN; // sentinel for "use camera-stored WB"
        const WB_B_OVERRIDE = NaN; // sentinel for "use camera-stored WB"
        const TEXTURE = 0;
        const CLARITY = 0;

        const r = process_orf(
            raw,
            EXPOSURE_EV,
            CONTRAST,
            HIGHLIGHTS,
            SHADOWS,
            WHITES,
            BLACKS,
            SATURATION,
            VIBRANCE,
            TEMP,
            TINT,
            WB_R_OVERRIDE,
            WB_B_OVERRIDE,
            TEXTURE,
            CLARITY,
        );

        const name = f.split(/[\\/]/).pop()!.padEnd(24);

        if (options.json) {
            // WB-4: NDJSON output
            console.log(JSON.stringify({
                file: f,
                wb_mode: r.wb_mode,
                wb_from_camera: r.wb_from_camera,
                wb_r_used: r.wb_r_used,
                wb_b_used: r.wb_b_used,
                color_matrix_from_mn: r.color_matrix_from_mn,
            }));
        } else {
            console.log(`${name} | ${String(r.wb_mode).padStart(7)} | ${String(r.wb_from_camera).padStart(8)} | ${r.wb_r_used.toFixed(3)} ${r.wb_b_used.toFixed(3)} | ${r.color_matrix_from_mn ? 'mn' : 'fallback'}`);
        }
    } catch (e) {
        // WB-3: String(e) to capture WASM panics properly
        console.error(`${f}: ${String(e)}`);
    }
}
