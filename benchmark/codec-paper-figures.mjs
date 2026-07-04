import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { rdCurve, paretoPlot, barChart, deltaChart } from "./svg-figures.mjs";

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
  files["rd-butteraugli.svg"] = rdCurve({ series: rdSeries(sweep, "butteraugli"), xLabel: "bpp", yLabel: "butteraugli (lower=better)" });
  files["rd-ssim.svg"] = rdCurve({ series: rdSeries(sweep, "ssim"), xLabel: "bpp", yLabel: "SSIM (higher=better)" });
  files["pareto-enc-time.svg"] = paretoPlot({ series: [
    { label: "native", color: "#f59e0b", points: fixed.filter(p=>p.runtime==="native").map(p=>({x:p.enc_ms,y:p.bpp})) },
    { label: "wasm", color: "#0ea5e9", points: fixed.filter(p=>p.runtime==="wasm").map(p=>({x:p.enc_ms,y:p.bpp})) },
  ], xLabel: "encode ms (NOT comparable across runtimes)", yLabel: "bpp @ butteraugli~1.5" });
  // ours vs original jxl delta at fixed point (avg over images)
  const ours = fixed.filter(p=>p.codec==="jxl"), orig = fixed.filter(p=>p.codec==="jxl_orig");
  const pct = (a,b,key) => (avg(a,r=>r[key]) / avg(b,r=>r[key])) * 100;
  files["ours-vs-orig-jxl.svg"] = (ours.length && orig.length) ? deltaChart({ groups: [
    { label: "size %", value: pct(ours,orig,"bytes"), color: "#e11d48" },
    { label: "enc %", value: pct(ours,orig,"enc_ms"), color: "#0ea5e9" },
    { label: "dec %", value: pct(ours,orig,"dec_ms"), color: "#10b981" },
  ], yLabel: "ours as % of original libjxl (100 = parity)" }) : barChart({ bars: [{label:"n/a",value:0,color:"#999"}], yLabel: "no jxl/jxl_orig fixed points" });
  // size bars at fixed point (avg KB per codec)
  const codecs = [...new Set(fixed.map(p=>p.codec))];
  files["bars-size-time.svg"] = barChart({ bars: codecs.map(c=>({ label: c, value: avg(fixed.filter(p=>p.codec===c), r=>r.bytes)/1024, color: PALETTE[c]||"#000" })), yLabel: "KB @ butteraugli~1.5" });
  for (const [name, svg] of Object.entries(files)) writeFileSync(join(figDir, name), svg);
  // gallery
  const bdRows = Object.entries(bdRates||{}).map(([c,v])=>`<tr><td>${c}</td><td>${v==null?"":v.toFixed(1)+"%"}</td></tr>`).join("");
  const html = `<!doctype html><meta charset="utf-8"><title>Codec Paper Figures</title>
<style>body{font-family:sans-serif;max-width:900px;margin:2rem auto}img{width:100%;border:1px solid #eee;margin:.5rem 0}h2{margin-top:2rem}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 10px}</style>
<h1>Codec comparison figures</h1>
<p><b>Caveat:</b> native (sharp, MT+SIMD) vs WASM (@jsquash, ours) encode/decode times are not comparable across runtimes; size and quality are.</p>
${Object.keys(files).map(n=>`<h2>${n.replace(".svg","")}</h2><img src="figures/${n}" alt="${n}">`).join("\n")}
<h2>BD-rate vs jpeg_native (negative = fewer bytes at equal quality)</h2>
<table><tr><th>codec</th><th>BD-rate</th></tr>${bdRows}</table>`;
  writeFileSync(join(outDir, "figures.html"), html);
  return { figDir, count: Object.keys(files).length };
}
