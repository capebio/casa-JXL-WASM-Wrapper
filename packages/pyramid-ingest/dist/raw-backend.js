import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import init, { process_orf, process_dng, process_cr2, } from "../../../pkg/raw_converter_wasm.js";
let initialized = false;
let initPromise = null;
async function ensureWasm() {
    if (initialized)
        return;
    if (!initPromise) {
        initPromise = (async () => {
            // Dynamic to keep load async (no block worker thread) and singleton guard prevents double wasm read+init under any interleaving.
            const { readFile } = await import("node:fs/promises");
            const url = new URL("../../../pkg/raw_converter_wasm_bg.wasm", import.meta.url);
            const bytes = await readFile(fileURLToPath(url));
            await init({ module_or_path: bytes });
            initialized = true;
        })();
    }
    await initPromise;
}
const ZERO_LOOK = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];
export function createRawBackend() {
    return {
        async decode(bytes, format) {
            await ensureWasm();
            let res;
            if (format === "orf") {
                res = process_orf(bytes, ...ZERO_LOOK);
            }
            else if (format === "dng") {
                res = process_dng(bytes, ...ZERO_LOOK);
            }
            else if (format === "cr2") {
                res = process_cr2(bytes, ...ZERO_LOOK);
            }
            else {
                throw new Error(`native raw decode unsupported format: ${format}`);
            }
            try {
                // Prefer take_rgba (RGB->RGBA inside WASM). Falls back to rgb+convert if needed.
                // The rgb fallback runs a hot per-pixel JS expand loop (lens6) on every pixel of the master.
                // This is the slow path for large RAW ingest into the JXL pyramid; take_rgba (WASM-side) is strongly preferred.
                let rgba;
                if (typeof res.take_rgba === "function") {
                    rgba = new Uint8Array(res.take_rgba());
                }
                else if (typeof res.take_rgb === "function") {
                    const rgb = new Uint8Array(res.take_rgb());
                    rgba = new Uint8Array((rgb.length / 3) * 4);
                    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
                        rgba[j] = rgb[i];
                        rgba[j + 1] = rgb[i + 1];
                        rgba[j + 2] = rgb[i + 2];
                        rgba[j + 3] = 255;
                    }
                }
                else {
                    throw new Error("ProcessResult missing take_rgba/take_rgb");
                }
                const w = Number(res.width) | 0;
                const h = Number(res.height) | 0;
                // Raw pipeline bakes orientation into pixels for ingest path.
                const orientation = "baked";
                // Note: full-res rgb16 not exposed via current flags (lb/thumb only).
                // 16-bit big levels path remains test/synthetic only for v1 (Q12 keep packed in JS).
                return { rgba, width: w, height: h, orientation };
            }
            finally {
                if (res && typeof res.free === "function") {
                    try {
                        res.free();
                    }
                    catch { }
                }
            }
        },
    };
}
//# sourceMappingURL=raw-backend.js.map