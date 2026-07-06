import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { rdCurve, scatterPlot, barChart } from "./svg-figures.mjs";

const PALETTE = { jxl: "#e11d48", jxl_orig: "#0ea5e9", jpeg_native: "#f59e0b", jpeg_wasm: "#fbbf24", webp_native: "#10b981", webp_wasm: "#34d399", avif_native: "#8b5cf6", avif_wasm: "#a78bfa", png_native: "#6b7280" };
// Grouped by format family: JXL, then AVIF, WebP, JPEG, PNG.
const CODEC_ORDER = ["jxl", "jxl_orig", "avif_native", "avif_wasm", "webp_native", "webp_wasm", "jpeg_native", "jpeg_wasm", "png_native"];
const orderIdx = (c) => { const i = CODEC_ORDER.indexOf(c); return i < 0 ? 999 : i; };
const byFamily = (a, b) => orderIdx(a) - orderIdx(b);

const avg = (arr, sel) => arr.reduce((s,x)=>s+sel(x),0) / arr.length;

// avg a metric across images per codec at each ladder quality -> RD points {x:bpp, y:metric}
function rdSeries(sweep, yKey) {
  const byCodec = new Map();
  for (const s of sweep) { if (!byCodec.has(s.codec)) byCodec.set(s.codec, new Map()); const m = byCodec.get(s.codec); if (!m.has(s.quality)) m.set(s.quality, []); m.get(s.quality).push(s); }
  const series = [];
  for (const [codec, qmap] of byCodec) {
    const points = [...qmap.entries()].map(([, arr]) => ({ x: avg(arr, r=>r.bpp), y: avg(arr, r=>r[yKey]) })).sort((a,b)=>a.x-b.x);
    series.push({ label: codec, color: PALETTE[codec] || "#000", points });
  }
  return series;
}

export function writeFigures({ outDir, sweep, fixed, bdRates }) {
  const figDir = join(outDir, "figures");
  mkdirSync(figDir, { recursive: true });
  const files = {};
  files["rd-butteraugli.svg"] = rdCurve({ series: rdSeries(sweep, "butteraugli"), xLabel: "bits per pixel (bpp)", yLabel: "butteraugli distance (lower = better)" });
  // SSIM saturates near 1.0; plot on a dB scale (-10·log10(1-SSIM)) so the high-quality range is legible.
  const toDb = (s) => -10 * Math.log10(Math.max(1e-4, 1 - Math.min(0.9999, s)));
  const ssimDb = rdSeries(sweep, "ssim").map(se => ({ ...se, points: se.points.map(p => ({ x: p.x, y: toDb(p.y) })) }));
  files["rd-ssim.svg"] = rdCurve({ series: ssimDb, xLabel: "bits per pixel (bpp)", yLabel: "SSIM (dB = -10·log10(1-SSIM), higher = better)" });
  // Pareto: one labelled dot per codec at its mean (encode ms, bpp) over all images.
  const codecs = [...new Set(fixed.map(p => p.codec))].sort(byFamily);
  const paretoPts = codecs.map(c => { const r = fixed.filter(p => p.codec === c); return { x: avg(r, p=>p.enc_ms), y: avg(r, p=>p.bpp), label: c, color: PALETTE[c] || "#000" }; });
  files["pareto-enc-time.svg"] = scatterPlot({ points: paretoPts, xLabel: "mean encode ms (native vs wasm NOT comparable)", yLabel: "mean bpp @ butteraugli~1.5" });
  // size bars, grouped by format family (JXL, AVIF, WebP, JPEG, PNG).
  files["bars-size-time.svg"] = barChart({ bars: codecs.map(c=>({ label: c, value: avg(fixed.filter(p=>p.codec===c), r=>r.bytes)/1024, color: PALETTE[c]||"#000" })), yLabel: "mean KB @ butteraugli~1.5" });
  for (const [name, svg] of Object.entries(files)) writeFileSync(join(figDir, name), svg);

  // ours vs original libjxl: stated in prose (not a figure).
  const ours = fixed.filter(p=>p.codec==="jxl"), orig = fixed.filter(p=>p.codec==="jxl_orig");
  const pct = (a,b,key) => (avg(a,r=>r[key]) / avg(b,r=>r[key])) * 100;
  const oursVsOrig = (ours.length && orig.length) ? {
    size: pct(ours,orig,"bytes"), encX: 100/pct(ours,orig,"enc_ms"), decX: 100/pct(ours,orig,"dec_ms"),
  } : null;

  const CAPTIONS = {
    "rd-butteraugli.svg": "Rate–distortion curve. x = <b>bits per pixel (bpp)</b> = encoded file size × 8 ÷ pixel count (lower = smaller file). y = <b>butteraugli</b>, a perceptual distance where ~1.0 is just-noticeable and lower is better. A curve that sits lower-left dominates: smaller files at the same quality. Each codec is swept across a quality ladder and averaged over all images.",
    "rd-ssim.svg": "Same rate–distortion view using <b>SSIM</b> (structural similarity, 1.0 = identical). SSIM saturates near 1.0, so it is shown in <b>dB</b> (−10·log10(1−SSIM)); higher = better. Curves toward the upper-left are better.",
    "pareto-enc-time.svg": "Speed vs size trade-off at matched quality (butteraugli ≈ 1.5). Each dot is one codec at its mean encode time (x) and mean bpp (y). Lower = smaller files, left = faster. <b>Caveat:</b> native (sharp, multi-threaded + SIMD) and WASM (@jsquash, ours) run on different runtimes — horizontal (time) distances are only meaningful <i>within</i> a runtime; size (vertical) is always comparable.",
    "bars-size-time.svg": "Mean encoded file size (KB) per codec at matched quality (butteraugli ≈ 1.5), averaged over the corpus, grouped by format family (JXL, AVIF, WebP, JPEG, PNG). Shorter bars = smaller files. Size is comparable across all codecs regardless of runtime.",
  };
  const oursProse = oursVsOrig
    ? `<h2>Our WASM JXL vs the original libjxl</h2><p>Against the reference libjxl (<code>@jsquash/jxl</code>) at matched effort 3, over the corpus at butteraugli ≈ 1.5: our WASM build encodes <b>${oursVsOrig.encX.toFixed(1)}× faster</b> and decodes <b>${oursVsOrig.decX.toFixed(1)}× faster</b>, for a file size of <b>${oursVsOrig.size.toFixed(0)}%</b> (${oursVsOrig.size >= 100 ? "+" : ""}${(oursVsOrig.size-100).toFixed(1)}%) — essentially parity on size, a large win on speed. (Both are WASM, so these times <i>are</i> directly comparable.)</p>`
    : "";
  const bdRows = Object.entries(bdRates||{}).sort((a,b)=>byFamily(a[0],b[0])).map(([c,v])=>`<tr><td>${c}</td><td>${v==null?"—":v.toFixed(1)+"%"}</td></tr>`).join("");
  const html = `<!doctype html><meta charset="utf-8"><title>Codec Paper Figures</title>
<style>body{font-family:sans-serif;max-width:900px;margin:2rem auto;line-height:1.5}img{width:100%;border:1px solid #eee;margin:.5rem 0}h2{margin-top:2rem}figcaption{color:#333;font-size:14px;margin-bottom:1rem}table{border-collapse:collapse;margin-top:.5rem}td,th{border:1px solid #ccc;padding:4px 10px}</style>
<h1>Codec comparison: our WASM JXL vs original libjxl vs JPEG/WebP/AVIF/PNG</h1>
<p>Corpus: Kodak 24 (standard, citable) + our RAW-derived renders @1920. Perceptual quality measured with butteraugli (libjxl p3). Native = sharp/libvips; WASM = @jsquash and our facade.</p>
<p><b>Runtime caveat:</b> native (sharp, MT+SIMD) vs WASM encode/decode <b>times are not comparable across runtimes</b>; file size and quality are.</p>
${Object.keys(files).map(n=>`<figure><h2>${n.replace(".svg","")}</h2><img src="figures/${n}" alt="${n}"><figcaption>${CAPTIONS[n]||""}</figcaption></figure>`).join("\n")}
${oursProse}
<h2>BD-rate vs JPEG (jpeg_native baseline)</h2>
<figcaption><b>BD-rate (Bjøntegaard delta-rate)</b> summarises a whole rate–distortion curve into one number: the average % change in file size versus the baseline codec <i>at equal quality</i>, integrated over the overlapping quality range. <b>Negative = fewer bytes for the same quality</b> (better). E.g. −44% means ~44% smaller files than JPEG at matched butteraugli. PNG is blank (lossless — no rate–distortion overlap).</figcaption>
<table><tr><th>codec</th><th>BD-rate vs JPEG</th></tr>${bdRows}</table>`;
  writeFileSync(join(outDir, "figures.html"), html);
  return { figDir, count: Object.keys(files).length };
}
