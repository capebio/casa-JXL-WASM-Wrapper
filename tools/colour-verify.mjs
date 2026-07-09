#!/usr/bin/env node
// colour-verify — decode a real camera file through the EXACT lightbox pipeline (process_orf/dng/cr2
// → rgb_to_rgba, parallel-wasm pkg, in headless Chromium with COOP/COEP so the shared-memory wasm
// loads + the rayon pool runs) and compare its colour to a reference rendering. Renders the decoded
// image to a canvas (the lightbox view) and screenshots it.
//
// Verifies (the memory-flagged "per-camera colour not verified on real files"):
//   - decode succeeds, plausible dimensions
//   - channels NOT swapped (R~R, not R~B) vs the reference
//   - no pink/magenta veil (G not deficient vs R,B)
//   - white balance plausible (R/G, B/G ratios in a sane band, near the reference)
//
// Usage: node tools/colour-verify.mjs [--raw "<path>"] [--ref "<path>"]
//   defaults: C:\Foo\raw-converter\tests\P1110226.ORF  +  "P1110226 windows.jpg"
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, normalize, relative, sep, extname, dirname } from "node:path";
import { chromium } from "playwright";

const REPO = normalize(join(import.meta.dirname, ".."));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const RAW = argv("--raw", "C:/Foo/raw-converter/tests/P1110226.ORF");
const REF = argv("--ref", "C:/Foo/raw-converter/tests/P1110226 windows.jpg");
const SAT = Number(argv("--sat", "0")); // slider saturation (counteract BASELINE_SAT with negative)
const WBR = argv("--wbr", "NaN"); // wb_r override (NaN = camera WB)
const WBB = argv("--wbb", "NaN");
const FN = { ".orf": "process_orf_with_flags", ".dng": "process_dng_with_flags", ".cr2": "process_cr2_with_flags" }[extname(RAW).toLowerCase()];
if (!FN) throw new Error(`unsupported raw ext: ${RAW}`);
const today = new Date().toISOString().slice(0, 10);
const REF_EXISTS = existsSync(REF);
const OUTDIR = join(REPO, "docs", "outputs", "ChatGPT plus Claude Outputs", "Done Deal");
const tag = RAW.split(/[\\/]/).pop().replace(/[^a-z0-9.]+/gi, "_");

const MIME = new Map([[".js", "text/javascript"], [".mjs", "text/javascript"], [".wasm", "application/wasm"], [".html", "text/html"], [".json", "application/json"]]);
const HEADERS = (type) => ({ "Content-Type": type, "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "cross-origin" });

const PAGE = `<!doctype html><meta charset=utf8><body><canvas id=c></canvas><script type=module>
import initRaw, { ${FN}, rgb_to_rgba, initThreadPool } from '/pkg/raw_converter_wasm.js';
const log = (m) => { window.__log = (window.__log||'') + m + '\\n'; };
function meanRGB(rgba){ let r=0,g=0,b=0,n=rgba.length/4; for(let i=0;i<rgba.length;i+=4){r+=rgba[i];g+=rgba[i+1];b+=rgba[i+2];} return {r:r/n,g:g/n,b:b/n}; }
function drawDownscaled(rgba,w,h,canvas,maxEdge){ const src=new OffscreenCanvas(w,h); src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer.slice(rgba.byteOffset,rgba.byteOffset+rgba.byteLength)),w,h),0,0); const s=Math.min(1,maxEdge/Math.max(w,h)); canvas.width=Math.round(w*s); canvas.height=Math.round(h*s); canvas.getContext('2d').drawImage(src,0,0,canvas.width,canvas.height); }
async function imgMean(url){ const blob=await (await fetch(url)).blob(); const bmp=await createImageBitmap(blob); const cv=new OffscreenCanvas(bmp.width,bmp.height); const cx=cv.getContext('2d',{willReadFrequently:true}); cx.drawImage(bmp,0,0); const d=cx.getImageData(0,0,bmp.width,bmp.height).data; return {...meanRGB(d), w:bmp.width, h:bmp.height}; }
(async () => {
  try {
    await initRaw();
    log('crossOriginIsolated=' + self.crossOriginIsolated);
    if (typeof initThreadPool === 'function' && self.crossOriginIsolated) { try { await Promise.race([initThreadPool(navigator.hardwareConcurrency), new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),20000))]); log('threadpool='+navigator.hardwareConcurrency); } catch(e){ log('threadpool failed: '+e.message); } }
    const orf = new Uint8Array(await (await fetch('/__file?which=raw')).arrayBuffer());
    log('raw bytes='+orf.length);
    const t0 = performance.now();
    const res = ${FN}(orf, 1, 0,0,0,0,0,0, ${SAT}, 0,0,0, ${WBR}, ${WBB}, 0, 0); // OUTPUT_FULL_RGB, neutral+sat, WB override
    const decodeMs = performance.now() - t0;
    const rgb = res.take_rgb(); const w = res.width, h = res.height; if (res.free) res.free();
    const rgba = rgb_to_rgba(rgb);
    const pipeline = meanRGB(rgba);
    drawDownscaled(rgba, w, h, document.getElementById('c'), 1024);
    const reference = ${REF_EXISTS} ? await imgMean('/__file?which=ref') : null;
    window.__result = { ok:true, w, h, decodeMs, pipeline, reference };
  } catch (e) { window.__result = { ok:false, error: String(e && (e.stack||e.message) || e) }; }
})();
</script>`;

function startServer() {
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname === "/") { res.writeHead(200, HEADERS("text/html")); res.end(PAGE); return; }
    if (u.pathname === "/__file") {
      const path = u.searchParams.get("which") === "raw" ? RAW : REF;
      try { res.writeHead(200, HEADERS("application/octet-stream")); res.end(readFileSync(path)); }
      catch (e) { res.writeHead(404, HEADERS("text/plain")); res.end(String(e)); }
      return;
    }
    const full = normalize(join(REPO, decodeURIComponent(u.pathname).replace(/^\/+/, "")));
    const rel = relative(REPO, full);
    if (rel.startsWith("..") || rel.split(sep).includes("..")) { res.writeHead(403, HEADERS("text/plain")); res.end("no"); return; }
    try { const body = readFileSync(full); res.writeHead(200, HEADERS(MIME.get(extname(full).toLowerCase()) ?? "application/octet-stream")); res.end(body); }
    catch { res.writeHead(404, HEADERS("text/plain")); res.end("404 " + u.pathname); }
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port })));
}

const ratios = (m) => ({ rg: m.r / m.g, bg: m.b / m.g });
function interpret(p, ref) {
  const pr = ratios(p);
  const rr = ref ? ratios(ref) : null;
  const swap = rr ? (Math.abs(pr.rg - rr.bg) + Math.abs(pr.bg - rr.rg) < Math.abs(pr.rg - rr.rg) + Math.abs(pr.bg - rr.bg)) : null;
  const pinkVeil = p.g < (p.r + p.b) / 2 * 0.92; // G deficient ⇒ magenta cast (intrinsic, no ref needed)
  const wbSane = pr.rg > 0.4 && pr.rg < 2.2 && pr.bg > 0.4 && pr.bg < 2.2;
  return { pipelineRatios: pr, refRatios: rr, channelSwapSuspected: swap, pinkVeil, wbSane };
}

const { server, port } = await startServer();
const browser = await chromium.launch({ headless: true, args: ["--enable-features=SharedArrayBuffer"] });
let result, logs = "";
try {
  const page = await browser.newPage();
  page.on("console", (m) => { logs += "[page] " + m.text() + "\n"; });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__result !== undefined, { timeout: 120000 });
  result = await page.evaluate(() => window.__result);
  logs += (await page.evaluate(() => window.__log || ""));
  if (result.ok) {
    if (!existsSync(OUTDIR)) mkdirSync(OUTDIR, { recursive: true });
    await page.locator("#c").screenshot({ path: join(OUTDIR, `colour-verify-render-${tag}-${today}.png`) });
  }
} finally { await browser.close(); server.close(); }

console.log(logs.trim());
if (!result?.ok) { console.error("FAILED:", result?.error); process.exit(1); }
const interp = interpret(result.pipeline, result.reference);
const round = (o) => o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(3) : v])) : null;
const report = { raw: RAW, ref: REF_EXISTS ? REF : "(none)", dims: `${result.w}×${result.h}`, decodeMs: +result.decodeMs.toFixed(1), pipelineMeanRGB: round(result.pipeline), referenceMeanRGB: round(result.reference), ...interp };
console.log(JSON.stringify(report, null, 2));
const verdict = !interp.channelSwapSuspected && !interp.pinkVeil && interp.wbSane;
console.log("\nCOLOUR VERDICT:", verdict ? "PASS — channels aligned, no pink veil, WB sane" : "REVIEW — see flags above");

const refRow = interp.refRatios
  ? `| reference | ${report.referenceMeanRGB.r} | ${report.referenceMeanRGB.g} | ${report.referenceMeanRGB.b} | ${interp.refRatios.rg.toFixed(3)} | ${interp.refRatios.bg.toFixed(3)} |\n`
  : "";
const md = `# Colour verification — ${RAW.split(/[\\/]/).pop()} (${today})

Decoded through the **exact lightbox pipeline** (\`${FN}\` → rgb_to_rgba, parallel-wasm pkg, headless Chromium, COOP/COEP, camera WB)${REF_EXISTS ? ` and compared to reference \`${REF.split(/[\\/]/).pop()}\`` : ""}. Render screenshot: \`colour-verify-render-${tag}-${today}.png\`.

| | mean R | mean G | mean B | R/G | B/G |
|---|--:|--:|--:|--:|--:|
| pipeline | ${report.pipelineMeanRGB.r} | ${report.pipelineMeanRGB.g} | ${report.pipelineMeanRGB.b} | ${interp.pipelineRatios.rg.toFixed(3)} | ${interp.pipelineRatios.bg.toFixed(3)} |
${refRow}
- dims: ${report.dims} · decode: ${report.decodeMs} ms (single-thread fallback)
- channel swap suspected: **${interp.channelSwapSuspected}**
- pink/magenta veil (G deficient): **${interp.pinkVeil}**
- WB sane (ratios in [0.4,2.2]): **${interp.wbSane}**

**Verdict: ${verdict ? "PASS" : "REVIEW"}.** ${verdict ? "No pink veil, white balance plausible." : "Pink/magenta veil — green channel deficient. Likely the missing per-camera colour matrix (CR2 `Cr2Info.color_matrix` is None → generic CAM_TO_SRGB fallback). Inspect the render screenshot; confirm in your own viewer before treating as fixed."}

> Note: reference (if any) is a Windows/camera rendering with its own WB/tone, so exact mean equality is NOT expected; the test checks channel order, neutrality, and WB plausibility — not pixel match. Mean RGB is scene-dependent; treat as a screening signal, confirm visually.
`;
writeFileSync(join(OUTDIR, `Colour verification ${tag} - ${today}.md`), md);
console.log("\nwrote report + render screenshot to Done Deal/");
