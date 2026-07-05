import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { rdCurve, scatterPlot, barChart } from "./svg-figures.mjs";

const PALETTE = { jxl: "#e11d48", jxl_orig: "#0ea5e9", jpeg_native: "#f59e0b", jpeg_wasm: "#fbbf24", webp_native: "#10b981", webp_wasm: "#34d399", avif_native: "#8b5cf6", avif_wasm: "#a78bfa", avif16: "#6d28d9", png_native: "#6b7280" };
const CODEC_ORDER = ["jxl", "jxl_orig", "avif_native", "avif_wasm", "avif16", "webp_native", "webp_wasm", "jpeg_native", "jpeg_wasm", "png_native"];
const orderIdx = (c) => { const i = CODEC_ORDER.indexOf(c); return i < 0 ? 999 : i; };
const byFamily = (a, b) => orderIdx(a) - orderIdx(b);
const avg = (arr, sel) => arr.length ? arr.reduce((s, x) => s + sel(x), 0) / arr.length : 0;
const toDb = (s) => -10 * Math.log10(Math.max(1e-4, 1 - Math.min(0.9999, s)));

// aggregate rows -> per-codec series of {x,y} averaged at each quality; x from xKey, y from yKey.
function seriesBy(rows, xKey, yKey, transform = (v) => v) {
  const byCodec = new Map();
  for (const r of rows) { if (!byCodec.has(r.codec)) byCodec.set(r.codec, new Map()); const m = byCodec.get(r.codec); if (!m.has(r.quality)) m.set(r.quality, []); m.get(r.quality).push(r); }
  const out = [];
  for (const codec of [...byCodec.keys()].sort(byFamily)) {
    const qmap = byCodec.get(codec);
    const points = [...qmap.values()]
      .map(arr => ({ x: avg(arr, r => r[xKey]), y: transform(avg(arr, r => r[yKey])) }))
      // drop non-finite points (e.g. PSNR = Infinity for lossless PNG) so the SVG never gets NaN coords
      .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
      .sort((a, b) => a.x - b.x);
    if (points.length) out.push({ label: codec, color: PALETTE[codec] || "#000", points });
  }
  return out;
}

export function writeFiguresFull({ outDir, sweep, timed, fixed, lossless, corpus, sweep16 = [] }) {
  const figDir = join(outDir, "figures");
  mkdirSync(figDir, { recursive: true });
  const files = {};
  const codecs = [...new Set(fixed.map(p => p.codec))].sort(byFamily);

  // 1-3. RD curves per quality metric
  files["rd-butteraugli.svg"] = rdCurve({ series: seriesBy(sweep, "bpp", "butteraugli"), xLabel: "bits per pixel (bpp)", yLabel: "butteraugli (lower = better)" });
  files["rd-psnr.svg"] = rdCurve({ series: seriesBy(sweep, "bpp", "psnr"), xLabel: "bits per pixel (bpp)", yLabel: "PSNR dB (higher = better)" });
  files["rd-ssim-db.svg"] = rdCurve({ series: seriesBy(sweep, "bpp", "ssim", toDb), xLabel: "bits per pixel (bpp)", yLabel: "SSIM dB (higher = better)" });

  // 4-5. speed vs quality (from timed sweep): x=butteraugli, y=enc/dec ms
  if (timed && timed.length) {
    files["enc-speed-vs-quality.svg"] = rdCurve({ series: seriesBy(timed, "butteraugli", "enc_ms"), xLabel: "butteraugli (lower = better quality)", yLabel: "encode ms (within-runtime only)" });
    files["dec-speed-vs-quality.svg"] = rdCurve({ series: seriesBy(timed, "butteraugli", "dec_ms"), xLabel: "butteraugli (lower = better quality)", yLabel: "decode ms (within-runtime only)" });
  }

  // 6. decode FPS vs bpp (from fixed point)
  const fpsPts = codecs.map(c => { const r = fixed.filter(p => p.codec === c); return { x: avg(r, p => p.bpp), y: avg(r, p => (p.dec_ms > 0 ? 1000 / p.dec_ms : 0)), label: c, color: PALETTE[c] || "#000" }; });
  files["decode-fps-vs-bpp.svg"] = scatterPlot({ points: fpsPts, xLabel: "mean bpp @ butteraugli~1.5", yLabel: "decode FPS (1000/ms; within-runtime only)" });

  // 7-8. Pareto scatter (enc + dec) per-codec centroid
  files["pareto-enc.svg"] = scatterPlot({ points: codecs.map(c => { const r = fixed.filter(p => p.codec === c); return { x: avg(r, p => p.enc_ms), y: avg(r, p => p.bpp), label: c, color: PALETTE[c] || "#000" }; }), xLabel: "mean encode ms (native vs wasm NOT comparable)", yLabel: "mean bpp @ butteraugli~1.5" });
  files["pareto-dec.svg"] = scatterPlot({ points: codecs.map(c => { const r = fixed.filter(p => p.codec === c); return { x: avg(r, p => p.dec_ms), y: avg(r, p => p.bpp), label: c, color: PALETTE[c] || "#000" }; }), xLabel: "mean decode ms (native vs wasm NOT comparable)", yLabel: "mean bpp @ butteraugli~1.5" });

  // 9. size bars grouped
  files["bars-size.svg"] = barChart({ bars: codecs.map(c => ({ label: c, value: avg(fixed.filter(p => p.codec === c), r => r.bytes) / 1024, color: PALETTE[c] || "#000" })), yLabel: "mean KB @ butteraugli~1.5" });

  // 9b. SUMMARY money figure: % bytes saved vs JPEG at matched quality (per image then averaged).
  const jpegByImg = new Map(fixed.filter(p => p.codec === "jpeg_native").map(p => [p.image, p.bytes]));
  const savingBars = codecs.filter(c => c !== "jpeg_native").map(c => {
    const per = fixed.filter(p => p.codec === c).map(p => { const jb = jpegByImg.get(p.image); return jb ? (1 - p.bytes / jb) * 100 : null; }).filter(x => x != null);
    return { label: c, value: per.length ? avg(per, x => x) : 0, color: PALETTE[c] || "#000" };
  });
  files["summary-savings-vs-jpeg.svg"] = barChart({ bars: savingBars, yLabel: "% smaller than JPEG @ equal quality (higher = better)" });

  // 9c. encode-time with variance whiskers (within-runtime only)
  files["bars-enc-time.svg"] = barChart({ bars: codecs.map(c => { const r = fixed.filter(p => p.codec === c); return { label: c, value: avg(r, p => p.enc_ms), err: avg(r, p => p.enc_ms_std || 0), color: PALETTE[c] || "#000" }; }), yLabel: "mean encode ms ± σ (within-runtime only)" });

  // 10. content-class split RD (butteraugli) for photo (standard) + raw
  for (const cls of ["standard", "raw"]) {
    const rows = sweep.filter(s => s.class === cls);
    if (rows.length) files[`rd-butteraugli-${cls}.svg`] = rdCurve({ series: seriesBy(rows, "bpp", "butteraugli"), xLabel: `bpp — ${cls === "standard" ? "photographic (Kodak)" : "RAW-derived"}`, yLabel: "butteraugli (lower = better)" });
  }

  // 11. lossless shootout
  if (lossless && lossless.length) {
    const lc = [...new Set(lossless.map(p => p.codec))].sort(byFamily);
    files["lossless-size.svg"] = barChart({ bars: lc.map(c => ({ label: c, value: avg(lossless.filter(p => p.codec === c), r => r.bpp), color: PALETTE[c] || "#000" })), yLabel: "lossless bpp (lower = better)" });
    files["lossless-enc-ms.svg"] = barChart({ bars: lc.map(c => ({ label: c, value: avg(lossless.filter(p => p.codec === c), r => r.enc_ms), color: PALETTE[c] || "#000" })), yLabel: "lossless encode ms (within-runtime)" });
  }

  // 12-14. 16-bit / HDR RD curves (JXL + AVIF-10/12; PSNR peak 65535; SSIM on 16-bit luma)
  if (sweep16.length) {
    files["rd-psnr-16bit.svg"] = rdCurve({ series: seriesBy(sweep16, "bpp", "psnr16"), xLabel: "bits per pixel (bpp)", yLabel: "PSNR dB — 16-bit (peak 65535, higher = better)" });
    files["rd-ssim-16bit.svg"] = rdCurve({ series: seriesBy(sweep16, "bpp", "ssim16", toDb), xLabel: "bits per pixel (bpp)", yLabel: "SSIM dB — 16-bit (higher = better)" });
    if (sweep16.some(r => r.butteraugli16 != null)) {
      const bt = sweep16.filter(r => r.butteraugli16 != null);
      files["rd-butteraugli-16bit.svg"] = rdCurve({ series: seriesBy(bt, "bpp", "butteraugli16"), xLabel: "bits per pixel (bpp)", yLabel: "butteraugli — 16-bit (lower = better)" });
    }
  }

  for (const [name, svg] of Object.entries(files)) writeFileSync(join(figDir, name), svg);
  return { files: Object.keys(files), figDir };
}

// BD-rate matrix rows: for each codec, bd vs each baseline. bdFn(refRows, testRows)->number|null.
// distKey selects the distortion axis ("butteraugli" default, or "psnr"). bdFn reads `.butteraugli`,
// so we map the chosen metric into that field.
export function bdMatrix(sweep, corpus, baselines, bdFn, distKey = "butteraugli") {
  const codecs = [...new Set(sweep.map(s => s.codec))].sort(byFamily);
  const asDist = (s) => ({ bpp: s.bpp, butteraugli: s[distKey] });
  const rows = [];
  for (const c of codecs) {
    const cell = { codec: c };
    for (const base of baselines) {
      const per = [];
      for (const img of corpus) {
        const ref = sweep.filter(s => s.image === img.id && s.codec === base).map(asDist);
        const tst = sweep.filter(s => s.image === img.id && s.codec === c).map(asDist);
        const bd = bdFn(ref, tst); if (bd != null) per.push(bd);
      }
      cell[base] = per.length ? per.reduce((a, b) => a + b, 0) / per.length : null;
    }
    rows.push(cell);
  }
  return rows;
}

const CAPTIONS = {
  "rd-butteraugli.svg": "Rate–distortion. x = <b>bits per pixel (bpp)</b> = file size × 8 ÷ pixels (lower = smaller). y = <b>butteraugli</b> perceptual distance (~1.0 = just-noticeable, lower = better). Lower-left dominates. Averaged over the whole corpus.",
  "rd-psnr.svg": "Rate–distortion using <b>PSNR</b> (dB, higher = better). A second, signal-based quality metric — the ranking should agree with butteraugli, which reassures the reader the result isn't metric-specific.",
  "rd-ssim-db.svg": "Rate–distortion using <b>SSIM</b> (structural similarity), shown in dB (−10·log10(1−SSIM)) because SSIM saturates near 1.0. Higher = better; upper-left dominates.",
  "enc-speed-vs-quality.svg": "<b>Encode time vs quality.</b> x = butteraugli (left = better quality), y = encode ms. Shows how expensive it is to reach a given quality. <b>Native vs WASM times are not comparable</b> — compare within a runtime.",
  "dec-speed-vs-quality.svg": "<b>Decode time vs quality.</b> Same axes for decode. Our viewer-critical path — flatter/lower is better.",
  "decode-fps-vs-bpp.svg": "<b>Decode throughput (FPS = 1000/ms) vs file size</b>, at matched quality. Upper region = faster decode. Within-runtime only.",
  "pareto-enc.svg": "Encode speed vs size at matched quality (butteraugli ≈ 1.5). Each dot is one codec (mean encode ms, mean bpp). Lower = smaller, left = faster. Cross-runtime time not comparable.",
  "pareto-dec.svg": "Decode speed vs size at matched quality. Lower = smaller, left = faster decode.",
  "bars-size.svg": "Mean file size (KB) per codec at matched quality (butteraugli ≈ 1.5), grouped by format family. Shorter = smaller. Size is comparable across all runtimes.",
  "rd-butteraugli-standard.svg": "Rate–distortion on <b>photographic</b> content (Kodak 24) only.",
  "rd-butteraugli-raw.svg": "Rate–distortion on our <b>RAW-derived</b> renders (ORF/CR2/DNG @1920) only — the real pipeline output.",
  "lossless-size.svg": "<b>Lossless</b> compression: mean bpp per codec (JXL / WebP / AVIF / PNG lossless). Lower = smaller.",
  "lossless-enc-ms.svg": "<b>Lossless</b> encode time per codec (within-runtime).",
  "rd-psnr-16bit.svg": "16-bit RD — <b>PSNR</b> (RAW-derived). Only JXL and AVIF-10/12-bit participate (JPEG and WebP are 8-bit-only). PSNR peak = 65535; higher = better.",
  "rd-ssim-16bit.svg": "16-bit RD — <b>SSIM</b> (RAW-derived), shown in dB on 16-bit luma. Only JXL and AVIF-10/12-bit participate.",
  "rd-butteraugli-16bit.svg": "16-bit RD — <b>Butteraugli</b> (RAW-derived). Only JXL and AVIF-10/12-bit participate. Omitted when the WASM bridge metric is unavailable.",
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmtPct = (v) => v == null ? "—" : v.toFixed(1) + "%";

export function writeGalleryFull({ outDir, files, perFile, bdRows, bdRowsPsnr, baselines, oursVsOrig, capability, corpusInfo }) {
  const figHtml = files.map(n => `<figure><h3>${n.replace(".svg", "")}</h3><img src="figures/${n}" alt="${n}"><figcaption>${CAPTIONS[n] || ""}</figcaption></figure>`).join("\n");
  const perFileRows = perFile.map(r => `<tr><td>${esc(r.image)}</td><td>${r.class}</td><td>${r.jxl_kb ?? "—"}</td><td>${r.jpeg_kb ?? "—"}</td><td>${r.saving ?? "—"}</td><td>${r.jxl_enc ?? "—"}</td><td>${r.jxl_dec ?? "—"}</td><td>${r.best ?? "—"}</td></tr>`).join("");
  const bdHead = `<tr><th>codec</th>${baselines.map(b => `<th>vs ${b}</th>`).join("")}</tr>`;
  const bdBody = bdRows.map(r => `<tr><td>${r.codec}</td>${baselines.map(b => `<td>${fmtPct(r[b])}</td>`).join("")}</tr>`).join("");
  const bdPsnrBody = (bdRowsPsnr || []).map(r => `<tr><td>${r.codec}</td>${baselines.map(b => `<td>${fmtPct(r[b])}</td>`).join("")}</tr>`).join("");
  const capRows = capability.map(r => `<tr><td>${r.format}</td><td>${r.eightbit}</td><td>${r.sixteenbit}</td><td>${r.alpha}</td><td>${r.progressive}</td><td>${r.lossless}</td></tr>`).join("");
  const prose = oursVsOrig ? `<p>Against the reference libjxl (<code>@jsquash/jxl</code>) at matched effort 3, over the corpus at butteraugli ≈ 1.5: our WASM build encodes <b>${oursVsOrig.encX.toFixed(1)}× faster</b> and decodes <b>${oursVsOrig.decX.toFixed(1)}× faster</b>, at <b>${oursVsOrig.size.toFixed(0)}%</b> file size — near-parity size, large speed win. (Both WASM, so times are directly comparable.)</p>` : "";
  const html = `<!doctype html><meta charset="utf-8"><title>JXL Codec Comparison — Figures</title>
<style>body{font-family:sans-serif;max-width:960px;margin:2rem auto;line-height:1.55;color:#222}img{width:100%;border:1px solid #eee;margin:.4rem 0}h2{margin-top:2.4rem;border-bottom:2px solid #eee;padding-bottom:4px}h3{margin:.2rem 0}figcaption{color:#444;font-size:14px;margin:.2rem 0 1.4rem}table{border-collapse:collapse;margin:.6rem 0;font-size:14px}td,th{border:1px solid #ccc;padding:4px 10px;text-align:center}td:first-child,th:first-child{text-align:left}code{background:#f4f4f4;padding:1px 4px}</style>
<h1>JPEG XL vs JPEG / WebP / AVIF / PNG — comparison figures</h1>
<p>${esc(corpusInfo)}. Perceptual quality via butteraugli (libjxl p3), plus PSNR and SSIM. Native = sharp/libvips; WASM = @jsquash and our facade build of libjxl.</p>
<p><b>Runtime caveat:</b> native (sharp, multi-threaded + SIMD) vs WASM encode/decode <b>times are not comparable across runtimes</b>; file size and quality are.</p>
<h2>Summary: how much smaller than JPEG?</h2>
<figcaption>Headline result — mean % file-size reduction vs JPEG at equal perceptual quality (butteraugli ≈ 1.5), per codec. Taller = smaller files than JPEG.</figcaption>
${["summary-savings-vs-jpeg.svg"].filter(n=>files.includes(n)).map(n=>`<figure><img src="figures/${n}"></figure>`).join("")}
<h2>Our WASM JXL vs the original libjxl</h2>${prose}
<h2>Rate–distortion (quality vs size)</h2>${["rd-butteraugli.svg","rd-psnr.svg","rd-ssim-db.svg","rd-butteraugli-standard.svg","rd-butteraugli-raw.svg"].filter(n=>files.includes(n)).map(n=>`<figure><h3>${n.replace(".svg","")}</h3><img src="figures/${n}"><figcaption>${CAPTIONS[n]||""}</figcaption></figure>`).join("\n")}
<h2>Speed</h2>${["enc-speed-vs-quality.svg","dec-speed-vs-quality.svg","decode-fps-vs-bpp.svg","pareto-enc.svg","pareto-dec.svg","bars-enc-time.svg"].filter(n=>files.includes(n)).map(n=>`<figure><h3>${n.replace(".svg","")}</h3><img src="figures/${n}"><figcaption>${CAPTIONS[n]||"Encode time per codec with ±σ error bars over "+"repeated runs (within-runtime only)."}</figcaption></figure>`).join("\n")}
<h2>Size at matched quality</h2>${["bars-size.svg"].filter(n=>files.includes(n)).map(n=>`<figure><img src="figures/${n}"><figcaption>${CAPTIONS[n]||""}</figcaption></figure>`).join("\n")}
<h2>Lossless</h2>${["lossless-size.svg","lossless-enc-ms.svg"].filter(n=>files.includes(n)).map(n=>`<figure><h3>${n.replace(".svg","")}</h3><img src="figures/${n}"><figcaption>${CAPTIONS[n]||""}</figcaption></figure>`).join("\n")||"<p>(lossless pass not present)</p>"}
<h2>16-bit / HDR Rate-Distortion</h2>${["rd-psnr-16bit.svg","rd-ssim-16bit.svg","rd-butteraugli-16bit.svg"].filter(n=>files.includes(n)).map(n=>`<figure><h3>${n.replace(".svg","")}</h3><img src="figures/${n}"><figcaption>${CAPTIONS[n]||""}</figcaption></figure>`).join("\n")||"<p>(16-bit sweep not present)</p>"}
<h2>Per-file summary (butteraugli ≈ 1.5)</h2>
<figcaption>Per-image file size, our-JXL saving vs JPEG, and our JXL encode/decode ms. "best" = smallest-file codec at matched quality.</figcaption>
<table><tr><th>image</th><th>class</th><th>JXL KB</th><th>JPEG KB</th><th>JXL saving</th><th>JXL enc ms</th><th>JXL dec ms</th><th>best</th></tr>${perFileRows}</table>
<h2>BD-rate matrix (negative = fewer bytes at equal quality)</h2>
<figcaption><b>BD-rate (Bjøntegaard delta-rate)</b>: average % file-size change vs a baseline codec at equal quality, across the rate–distortion curve. Negative = smaller at same quality. Columns are the baselines.</figcaption>
<table>${bdHead}${bdBody}</table>
${bdPsnrBody ? `<h2>BD-rate matrix — PSNR (classic Bjøntegaard, negative = fewer bytes at equal PSNR)</h2>
<figcaption>Same BD-rate but with <b>PSNR</b> as the distortion axis — the traditional codec-paper metric. Agreement with the butteraugli table above shows the result isn't metric-dependent.</figcaption>
<table>${bdHead}${bdPsnrBody}</table>` : ""}
<h2>Format capability</h2>
<table><tr><th>format</th><th>8-bit</th><th>16-bit/HDR</th><th>alpha</th><th>progressive</th><th>lossless</th></tr>${capRows}</table>`;
  writeFileSync(join(outDir, "figures.html"), html);
}

export { byFamily, avg, PALETTE, CODEC_ORDER };
