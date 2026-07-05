import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { rdCurve, scatterPlot, slopeChart, barChart } from "./svg-figures.mjs";

const PALETTE = { jxl: "#e11d48", jxl_orig: "#0ea5e9", jpeg_native: "#f59e0b", jpeg_wasm: "#fbbf24", webp_native: "#10b981", webp_wasm: "#34d399", avif_native: "#8b5cf6", avif_wasm: "#a78bfa", png_native: "#6b7280" };

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
  const codecs = [...new Set(fixed.map(p => p.codec))];
  const paretoPts = codecs.map(c => { const r = fixed.filter(p => p.codec === c); return { x: avg(r, p=>p.enc_ms), y: avg(r, p=>p.bpp), label: c, color: PALETTE[c] || "#000" }; });
  files["pareto-enc-time.svg"] = scatterPlot({ points: paretoPts, xLabel: "mean encode ms (native vs wasm NOT comparable)", yLabel: "mean bpp @ butteraugli~1.5" });
  // ours vs original jxl: slopegraph (original libjxl = 100%, ours plotted relative).
  const ours = fixed.filter(p=>p.codec==="jxl"), orig = fixed.filter(p=>p.codec==="jxl_orig");
  const pct = (a,b,key) => (avg(a,r=>r[key]) / avg(b,r=>r[key])) * 100;
  files["ours-vs-orig-jxl.svg"] = (ours.length && orig.length) ? slopeChart({
    leftLabel: "original libjxl", rightLabel: "our WASM JXL",
    metrics: [
      { label: "file size", value: pct(ours,orig,"bytes"), color: "#e11d48" },
      { label: "encode time", value: pct(ours,orig,"enc_ms"), color: "#0ea5e9" },
      { label: "decode time", value: pct(ours,orig,"dec_ms"), color: "#10b981" },
    ], yLabel: "ours as % of original libjxl (100 = parity, <100 = better)",
  }) : barChart({ bars: [{label:"n/a",value:0,color:"#999"}], yLabel: "no jxl/jxl_orig fixed points" });
  files["bars-size-time.svg"] = barChart({ bars: codecs.map(c=>({ label: c, value: avg(fixed.filter(p=>p.codec===c), r=>r.bytes)/1024, color: PALETTE[c]||"#000" })), yLabel: "mean KB @ butteraugli~1.5" });
  for (const [name, svg] of Object.entries(files)) writeFileSync(join(figDir, name), svg);

  const CAPTIONS = {
    "rd-butteraugli.svg": "Rate–distortion curve. x = <b>bits per pixel (bpp)</b> = encoded file size × 8 ÷ pixel count (lower = smaller file). y = <b>butteraugli</b>, a perceptual distance where ~1.0 is just-noticeable and lower is better. A curve that sits lower-left dominates: smaller files at the same quality. Each codec is swept across a quality ladder and averaged over all images.",
    "rd-ssim.svg": "Same rate–distortion view using <b>SSIM</b> (structural similarity, 1.0 = identical). SSIM saturates near 1.0, so it is shown in <b>dB</b> (−10·log10(1−SSIM)); higher = better. Curves toward the upper-left are better.",
    "pareto-enc-time.svg": "Speed vs size trade-off at matched quality (butteraugli ≈ 1.5). Each dot is one codec at its mean encode time (x) and mean bpp (y). Lower = smaller files, left = faster. <b>Caveat:</b> native (sharp, multi-threaded + SIMD) and WASM (@jsquash, ours) run on different runtimes — horizontal (time) distances are only meaningful <i>within</i> a runtime; size (vertical) is always comparable.",
    "ours-vs-orig-jxl.svg": "Our WASM JXL vs the reference libjxl (@jsquash/jxl) at matched effort 3, as a slopegraph. Original libjxl is the 100% baseline (left); each line shows our value (right). Lines dropping below 100% are wins — we encode and decode much faster; file size sits near parity.",
    "bars-size-time.svg": "Mean encoded file size (KB) per codec at matched quality (butteraugli ≈ 1.5), averaged over the corpus. Shorter bars = smaller files. Size is comparable across all codecs regardless of runtime.",
  };
  const bdRows = Object.entries(bdRates||{}).map(([c,v])=>`<tr><td>${c}</td><td>${v==null?"—":v.toFixed(1)+"%"}</td></tr>`).join("");
  const html = `<!doctype html><meta charset="utf-8"><title>Codec Paper Figures</title>
<style>body{font-family:sans-serif;max-width:900px;margin:2rem auto;line-height:1.5}img{width:100%;border:1px solid #eee;margin:.5rem 0}h2{margin-top:2rem}figcaption{color:#333;font-size:14px;margin-bottom:1rem}table{border-collapse:collapse;margin-top:.5rem}td,th{border:1px solid #ccc;padding:4px 10px}</style>
<h1>Codec comparison: our WASM JXL vs original libjxl vs JPEG/WebP/AVIF/PNG</h1>
<p>Corpus: Kodak 24 (standard, citable) + our RAW-derived renders @1920. Perceptual quality measured with butteraugli (libjxl p3). Native = sharp/libvips; WASM = @jsquash and our facade.</p>
<p><b>Runtime caveat:</b> native (sharp, MT+SIMD) vs WASM encode/decode <b>times are not comparable across runtimes</b>; file size and quality are.</p>
${Object.keys(files).map(n=>`<figure><h2>${n.replace(".svg","")}</h2><img src="figures/${n}" alt="${n}"><figcaption>${CAPTIONS[n]||""}</figcaption></figure>`).join("\n")}
<h2>BD-rate vs JPEG (jpeg_native baseline)</h2>
<figcaption><b>BD-rate (Bjøntegaard delta-rate)</b> summarises a whole rate–distortion curve into one number: the average % change in file size versus the baseline codec <i>at equal quality</i>, integrated over the overlapping quality range. <b>Negative = fewer bytes for the same quality</b> (better). E.g. −44% means ~44% smaller files than JPEG at matched butteraugli. PNG is blank (lossless — no rate–distortion overlap).</figcaption>
<table><tr><th>codec</th><th>BD-rate vs JPEG</th></tr>${bdRows}</table>`;
  writeFileSync(join(outDir, "figures.html"), html);
  return { figDir, count: Object.keys(files).length };
}
