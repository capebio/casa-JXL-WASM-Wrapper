// Static file server for the wasm demo.  Maps:
//   /            → web/index.html
//   /web/*       → web/*
//   /pkg/*       → pkg/*
// Adds COOP/COEP headers so SharedArrayBuffer is usable if we wire up
// wasm-bindgen-rayon later — harmless if not.

import { serve } from "bun";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join, normalize, sep } from "node:path";
import { createDecoder, createEncoder } from "./packages/jxl-wasm/dist/facade.js";

const ROOT = import.meta.dir;
const PORT = Number(process.env.PORT ?? 9000);
const RANDOM_ORF_FOLDER = String.raw`C:\995\2026-02-17 Dave at Kyffhauser`;
const RANDOM_GOBABEB_FOLDER = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const TIMINGS_DIR = join(ROOT, "timings");

// S11 (P3) — MIME table gaps
const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js":   "application/javascript",
    ".mjs":  "application/javascript",
    ".css":  "text/css",
    ".wasm": "application/wasm",
    ".json": "application/json",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".svg":  "image/svg+xml",
    ".ts":   "application/typescript",
    ".jxl":  "image/jxl",
    ".map":  "application/json",
    ".ico":  "image/x-icon",
};

// P5-3: support precompressed .wasm.br (and .js.br) with Content-Encoding: br.
// First-load only (IDB module cache covers subsequent), but first impression matters.
// Usage: drop jxl-core.simd.wasm.br next to the .wasm; clients sending Accept-Encoding: br get the smaller transfer.
function negotiateCompressed(fsPath: string, acceptEncoding: string | null): { path: string; encoding: string | null } {
  const wantsBr = !!acceptEncoding && /\bbr\b/i.test(acceptEncoding);
  if (wantsBr) {
    const br = fsPath + ".br";
    // existence checked by caller before read, but we return candidate
    return { path: br, encoding: "br" };
  }
  return { path: fsPath, encoding: null };
}

// S6 (P1, security) — /api/jxl-crop?file= reads arbitrary absolute paths
// Restrict file paths to be under ROOT or allowed random folders.
function isPathAllowed(p: string): boolean {
    const norm = normalize(p);
    const targets = [ROOT, RANDOM_ORF_FOLDER, RANDOM_GOBABEB_FOLDER].map(t => normalize(t));
    for (const target of targets) {
        if (norm === target || norm.startsWith(target + sep)) {
            return true;
        }
    }
    return false;
}

// --- /api/jxl-crop cache ---
// Key: "file:x:y:w:h:distance:effort:downsample" → encoded crop JXL bytes.
// S4 (P2, bug) — crop cache is LRU, bounded by entry count and byte budget.
const JXL_CROP_CACHE = new Map<string, Uint8Array>();
const JXL_CROP_CACHE_MAX = 50;
const JXL_CROP_CACHE_MAX_BYTES = 64 * 1024 * 1024; // 64 MB budget
let JXL_CROP_CACHE_BYTES = 0;

// S7 (P2, perf) — single-flight dedupe for concurrent identical crops
const JXL_CROP_IN_FLIGHT = new Map<string, Promise<Uint8Array>>();

async function handleJxlCrop(url: URL): Promise<Response> {
    const p = url.searchParams;
    const file     = p.get("file") ?? "";
    const x        = parseInt(p.get("x") ?? "", 10);
    const y        = parseInt(p.get("y") ?? "", 10);
    const w        = parseInt(p.get("w") ?? "", 10);
    const h        = parseInt(p.get("h") ?? "", 10);

    // S2 (P1, bug) — NaN distance/effort reach the encoder
    const dRaw = parseFloat(p.get("distance") ?? "1.0");
    const distance = Number.isFinite(dRaw) ? Math.max(0, Math.min(25, dRaw)) : 1.0;
    const eRaw = parseInt(p.get("effort") ?? "4", 10);
    const effort = (Number.isFinite(eRaw) ? Math.max(1, Math.min(9, eRaw)) : 4) as 1|2|3|4|5|6|7|8|9;

    // S8 (P2, feature) — downsample passthrough on /api/jxl-crop
    const dsRaw = parseInt(p.get("ds") ?? "1", 10);
    const downsample = [1, 2, 4, 8].includes(dsRaw) ? dsRaw : 1;

    if (!file || [x, y, w, h].some((v) => !Number.isInteger(v) || v < 0) || w === 0 || h === 0) {
        return new Response("bad params: file, x, y, w, h required; w and h must be > 0", { status: 400 });
    }

    // S6 (P1, security) — /api/jxl-crop?file= reads arbitrary absolute paths
    if (!isPathAllowed(file)) {
        return new Response("forbidden: path not within allowed directories", { status: 403 });
    }

    const cacheKey = `${file}:${x}:${y}:${w}:${h}:${distance}:${effort}:${downsample}`;

    // S4 (P2, bug) — crop cache is LRU, delete & set on hit to refresh recency
    const cached = JXL_CROP_CACHE.get(cacheKey);
    if (cached !== undefined) {
        JXL_CROP_CACHE.delete(cacheKey);
        JXL_CROP_CACHE.set(cacheKey, cached);
        return new Response(cached, {
            headers: {
                "Content-Type": "image/jxl",
                "Cache-Control": "public, max-age=31536000, immutable",
                "Cross-Origin-Opener-Policy":   "same-origin",
                "Cross-Origin-Embedder-Policy": "require-corp",
            },
        });
    }

    // S7 (P2, perf) — single-flight dedupe for concurrent identical crops
    let inFlightPromise = JXL_CROP_IN_FLIGHT.get(cacheKey);
    if (inFlightPromise) {
        try {
            const cropJxl = await inFlightPromise;
            return new Response(cropJxl, {
                headers: {
                    "Content-Type": "image/jxl",
                    "Cache-Control": "public, max-age=31536000, immutable",
                    "Cross-Origin-Opener-Policy":   "same-origin",
                    "Cross-Origin-Embedder-Policy": "require-corp",
                },
            });
        } catch (err) {
            return new Response("JXL crop failed in concurrent request: " + String((err as Error).message || err), { status: 500 });
        }
    }

    // Crop operation function that does the decoding & encoding
    const doCrop = async (): Promise<Uint8Array> => {
        let sourceBytes: Uint8Array;
        try {
            // S3 (P1, perf) — read file to ArrayBuffer using Bun.file to avoid NodeJS.fs overhead
            const buf = await Bun.file(file).arrayBuffer();
            sourceBytes = new Uint8Array(buf);
        } catch (err) {
            if (!(await Bun.file(file).exists())) {
                throw new Error("source file not found");
            }
            throw err;
        }

        // Decode JXL → RGBA8 crop region.
        let pixels: ArrayBuffer | Uint8Array | null = null;
        let cropW = w;
        let cropH = h;
        const decoder = createDecoder({
            format: "rgba8",
            region: { x, y, w, h },
            downsample,
            progressionTarget: "final",
            emitEveryPass: false,
            preserveIcc: false,
            preserveMetadata: false,
            copyInput: false,
        });

        // S1 (P1, leak) — decoder/encoder never disposed on error paths
        try {
            decoder.push(sourceBytes);
            await decoder.close();
            for await (const event of decoder.events()) {
                if (event.type === "error") {
                    throw new Error("JXL decode failed: " + event.message);
                }
                if (event.type === "final") {
                    pixels = event.pixels;
                    cropW  = event.info.width;
                    cropH  = event.info.height;
                    break;
                }
            }
        } finally {
            await decoder.dispose();
        }

        if (pixels === null) {
            throw new Error("JXL decode produced no final frame");
        }

        // Re-encode crop region as JXL.
        let cropJxl: Uint8Array;
        const encoder = createEncoder({
            format: "rgba8",
            width: cropW,
            height: cropH,
            hasAlpha: true,
            iccProfile: null,
            exif: null,
            xmp: null,
            distance,
            quality: null,
            effort,
            progressive: false,
            previewFirst: false,
            chunked: false,
        });

        // S1 (P1, leak) — decoder/encoder never disposed on error paths
        try {
            await encoder.pushPixels(pixels);
            await encoder.finish();
            const chunks: Uint8Array[] = [];
            for await (const chunk of encoder.chunks()) {
                chunks.push(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk);
            }
            const totalLen = chunks.reduce((n, c) => n + c.byteLength, 0);
            cropJxl = new Uint8Array(totalLen);
            let offset = 0;
            for (const chunk of chunks) { cropJxl.set(chunk, offset); offset += chunk.byteLength; }
        } finally {
            await encoder.dispose();
        }

        return cropJxl;
    };

    const promise = doCrop();
    JXL_CROP_IN_FLIGHT.set(cacheKey, promise);

    try {
        const cropJxl = await promise;

        // Store in cache, evict oldest if over limits (count or bytes)
        if (JXL_CROP_CACHE.has(cacheKey)) {
            const old = JXL_CROP_CACHE.get(cacheKey)!;
            JXL_CROP_CACHE_BYTES -= old.byteLength;
            JXL_CROP_CACHE.delete(cacheKey);
        }
        JXL_CROP_CACHE.set(cacheKey, cropJxl);
        JXL_CROP_CACHE_BYTES += cropJxl.byteLength;

        while (JXL_CROP_CACHE.size > JXL_CROP_CACHE_MAX || JXL_CROP_CACHE_BYTES > JXL_CROP_CACHE_MAX_BYTES) {
            const oldestKey = JXL_CROP_CACHE.keys().next().value;
            if (oldestKey === undefined) break;
            const oldestVal = JXL_CROP_CACHE.get(oldestKey)!;
            JXL_CROP_CACHE_BYTES -= oldestVal.byteLength;
            JXL_CROP_CACHE.delete(oldestKey);
        }

        return new Response(cropJxl, {
            headers: {
                "Content-Type": "image/jxl",
                "Cache-Control": "public, max-age=31536000, immutable",
                "Cross-Origin-Opener-Policy":   "same-origin",
                "Cross-Origin-Embedder-Policy": "require-corp",
            },
        });
    } catch (err) {
        return new Response("JXL crop failed: " + String((err as Error).message || err), {
            status: 500,
        });
    } finally {
        JXL_CROP_IN_FLIGHT.delete(cacheKey);
    }
}

// S10 (P3) — factor the two random-file routes
interface DirCacheEntry {
    files: string[];
    expires: number;
}
const DIR_CACHE = new Map<string, DirCacheEntry>();

async function getOrfsInFolder(folder: string): Promise<string[]> {
    const now = Date.now();
    const cached = DIR_CACHE.get(folder);
    if (cached && cached.expires > now) {
        return cached.files;
    }
    const entries = await readdir(folder, { withFileTypes: true });
    const files = entries
        .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".orf")
        .map((entry) => entry.name);
    
    DIR_CACHE.set(folder, {
        files,
        expires: now + 30000, // cache for 30s
    });
    return files;
}

async function randomFileResponse(folder: string): Promise<Response> {
    try {
        const files = await getOrfsInFolder(folder);
        if (!files.length) {
            return new Response("no ORF files found", { status: 404 });
        }
        const name = files[Math.floor(Math.random() * files.length)];
        const fsPath = join(folder, name);

        // S3 (P1, perf) — Stream file with Bun.file
        const file = Bun.file(fsPath);
        if (!(await file.exists())) {
            return new Response("file not found on disk", { status: 404 });
        }

        return new Response(file, {
            headers: {
                "Content-Type": "application/octet-stream",
                "Cache-Control": "no-cache",
                "Cross-Origin-Opener-Policy":   "same-origin",
                "Cross-Origin-Embedder-Policy": "require-corp",
                "X-File-Name": name,
                "X-File-Size": String(file.size),
                "X-Source-Folder": folder,
            },
        });
    } catch (err) {
        console.error(`random file error in ${folder}:`, err);
        return new Response("failed to load random file", { status: 500 });
    }
}

// S9 (P2, perf) — prewarm codec at startup
async function warmUpCodec() {
    try {
        const pixels = new Uint8Array([255, 0, 0, 255]);
        const encoder = createEncoder({
            format: "rgba8",
            width: 1,
            height: 1,
            hasAlpha: true,
            iccProfile: null,
            exif: null,
            xmp: null,
            distance: 1.0,
            quality: null,
            effort: 4,
            progressive: false,
            previewFirst: false,
            chunked: false,
        });
        await encoder.pushPixels(pixels);
        await encoder.finish();
        const chunks: Uint8Array[] = [];
        for await (const chunk of encoder.chunks()) {
            chunks.push(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk);
        }
        await encoder.dispose();
        const totalLen = chunks.reduce((n, c) => n + c.byteLength, 0);
        const jxl = new Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of chunks) { jxl.set(chunk, offset); offset += chunk.byteLength; }

        const decoder = createDecoder({
            format: "rgba8",
            region: { x: 0, y: 0, w: 1, h: 1 },
            downsample: 1,
            progressionTarget: "final",
            emitEveryPass: false,
            preserveIcc: false,
            preserveMetadata: false,
            copyInput: false,
        });
        decoder.push(jxl);
        await decoder.close();
        for await (const event of decoder.events()) {
            // consume
        }
        await decoder.dispose();
        console.log("Codec prewarmed successfully.");
    } catch (err) {
        console.warn("Codec prewarm failed:", err);
    }
}

serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);
        
        // S5 (P2, bug) — decodeURIComponent can throw
        let path: string;
        try {
            path = decodeURIComponent(url.pathname);
        } catch {
            return new Response("bad request: malformed URI", { status: 400 });
        }

        if (path === "/api/jxl-crop" && req.method === "GET") {
            return handleJxlCrop(url);
        }
        if (path === "/api/timings" && req.method === "POST") {
            try {
                const payload = (await req.json()) as { filename?: string; markdown?: string };
                const markdown = String(payload?.markdown ?? "");
                if (!markdown) return new Response("missing markdown", { status: 400 });
                const rawName = String(payload?.filename ?? "");
                const safeName = basename(rawName || `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
                const filename = safeName.toLowerCase().endsWith(".md") ? safeName : `${safeName}.md`;
                await mkdir(TIMINGS_DIR, { recursive: true });
                const fsPath = join(TIMINGS_DIR, filename);
                await writeFile(fsPath, markdown, "utf8");
                return new Response(JSON.stringify({ path: fsPath }), {
                    headers: { "Content-Type": "application/json" },
                });
            } catch (err) {
                console.error("timings write error:", err);
                return new Response("failed to write timings", { status: 500 });
            }
        }
        if (path === "/api/random-orf") {
            return randomFileResponse(RANDOM_ORF_FOLDER);
        }
        if (path === "/api/random-gobabeb") {
            return randomFileResponse(RANDOM_GOBABEB_FOLDER);
        }
        // Worker falls back to this URL when import maps aren't available (pre-Chrome 114).
        // Serve the scalar WASM so the worker can bootstrap without T-WASM-BUILD.
        // P5-3: honor .br sibling for first-load transfer win.
        if (path === "/packages/jxl-worker-browser/dist/jxl-core.wasm") {
            const baseWasmPath = join(ROOT, "packages", "jxl-wasm", "dist", "jxl-core.scalar.wasm");
            const accept = req.headers.get("accept-encoding");
            const neg = negotiateCompressed(baseWasmPath, accept);
            
            // S12 (P3) — negotiateCompressed does stat-then-read (TOCTOU)
            // S3 (P1, perf) — Stream file with Bun.file
            const targetPath = neg.encoding === "br" && (await Bun.file(neg.path).exists()) ? neg.path : baseWasmPath;
            if (!(await Bun.file(targetPath).exists())) {
                return new Response("jxl-core.scalar.wasm not found", { status: 404 });
            }
            const headers: Record<string, string> = {
                "Content-Type": "application/wasm",
                "Cache-Control": "no-cache",
                "Cross-Origin-Opener-Policy":   "same-origin",
                "Cross-Origin-Embedder-Policy": "require-corp",
                "Vary": "Accept-Encoding",
            };
            if (neg.encoding === "br" && targetPath.endsWith(".br")) headers["Content-Encoding"] = "br";
            return new Response(Bun.file(targetPath), { headers });
        }
        if (path === "/") {
            // Redirect rather than internal rewrite so relative URLs in the
            // page resolve against /web/ not /.
            return new Response(null, {
                status: 302,
                headers: { Location: "/web/index.html" },
            });
        }

        const parts = path.split("/").filter((p) => p.length);
        const fsPath = normalize(join(ROOT, ...parts));
        // Reject any path that escapes ROOT (covers literal "..", URL-encoded,
        // double-encoded, and Windows backslash variants after normalize()).
        if (!fsPath.startsWith(ROOT + sep) && fsPath !== ROOT) {
            return new Response("forbidden", { status: 403 });
        }
        try {
            const accept = req.headers.get("accept-encoding");
            let targetPath = fsPath;
            let encoding: string | null = null;
            const ext = extname(fsPath).toLowerCase();
            if (ext === ".wasm" || ext === ".js") {
                // P5-3: Brotli precompressed for first-load wasm (and js) transfer win.
                const neg = negotiateCompressed(fsPath, accept);
                // S12 (P3) — negotiateCompressed does stat-then-read (TOCTOU)
                if (neg.encoding === "br" && (await Bun.file(neg.path).exists())) {
                    targetPath = neg.path;
                    encoding = "br";
                }
            }
            if (!(await Bun.file(targetPath).exists())) {
                return new Response("not found: " + parts.join("/"), { status: 404 });
            }
            // COOP + COEP enable SharedArrayBuffer for jxl-worker.js, which runs
            // the Pthread-based libjxl MT codec.  All resources are same-origin
            // (no CDN), so require-corp is safe.
            const headers: Record<string, string> = {
                "Content-Type": MIME[ext] ?? "application/octet-stream",
                "Cache-Control": "no-cache",
                "Cross-Origin-Opener-Policy":   "same-origin",
                "Cross-Origin-Embedder-Policy": "require-corp",
                "Vary": "Accept-Encoding",
            };
            if (encoding === "br") headers["Content-Encoding"] = "br";
            
            // S3 (P1, perf) — Stream static files using Bun.file
            return new Response(Bun.file(targetPath), { headers });
        } catch (err) {
            const code = (err as any)?.code;
            if (code === "EACCES") return new Response("forbidden", { status: 403 });
            console.error("serve error:", err);
            return new Response("internal server error", { status: 500 });
        }
    },
});

// Guard unhandled rejections from worker-based prewarm so the server stays up.
process.on('unhandledRejection', (err) => {
    console.warn('[serve] unhandled rejection (non-fatal):', err);
});
console.log(`Serving http://localhost:${PORT}`);
warmUpCodec();
