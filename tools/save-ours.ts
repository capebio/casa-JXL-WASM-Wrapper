// Render ORF → PNG via our pipeline, for visual inspection.
import init, { process_orf, downscale_rgb } from "./pkg/raw_converter_wasm.js";
import { readFileSync } from "node:fs";
import sharp from "sharp";

const wasmBytes = readFileSync(new URL("./pkg/raw_converter_wasm_bg.wasm", import.meta.url));
await init({ module_or_path: wasmBytes });

for (const f of process.argv.slice(2)) {
    const raw = new Uint8Array(readFileSync(f));
    const r = process_orf(raw, 0,0,0,0,0,0,0,0,0,0, NaN, NaN, 0, 0);
    const w = r.width, h = r.height;
    const rgb = r.take_rgb();
    const targetW = 800;
    const targetH = Math.round((h * targetW) / w);
    const small = downscale_rgb(rgb, w, h, targetW, targetH);
    const stem = f.replace(/.*[\\/]/, '').replace(/\.[^.]+$/, '');
    await sharp(small, { raw: { width: targetW, height: targetH, channels: 3 } })
        .png().toFile(`solo_${stem}.png`);
    console.log(`solo_${stem}.png  WB=${r.wb_r_used.toFixed(3)}/${r.wb_b_used.toFixed(3)}  matrix=${r.color_matrix_from_mn?'mn':'fb'}`);
}
