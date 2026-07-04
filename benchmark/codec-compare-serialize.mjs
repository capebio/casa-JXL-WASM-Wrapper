const COLS = ["file","codec","runtime","quality","target_butter","achieved_butter","converged","ssim","enc_ms","dec_ms","ttfp_ms","ttfp_kind","bytes","bpp","enc_fps","dec_fps"];
const r0 = (x) => (x == null ? "" : Math.round(x));
const f2 = (x) => (x == null ? "" : Number(x).toFixed(2));
const fps = (ms) => (ms && ms > 0 ? Math.round(1000 / ms) : "");

export function buildCodecToon({ rows, batchName, runTimestamp, target }) {
  const lines = [
    `TestName: CodecCompare - ${batchName}`,
    `RunTimestamp: ${runTimestamp}`,
    `Target: ${target}`,
    `Quality parity: per-file butteraugli anchored to our JXL @ distance 1.0`,
    "# CAVEAT: native (sharp; libvips MT+SIMD) vs wasm (@jsquash, our JXL) — ENCODE/DECODE MS + FPS NOT COMPARABLE ACROSS RUNTIMES. SIZE + QUALITY ARE.",
    "",
    `---`,
    `rows[${rows.length}]{${COLS.join("|")}}:`,
  ];
  for (const r of rows) {
    lines.push("  " + [
      r.file, r.codec, r.runtime, r0(r.quality), f2(r.target_butter), f2(r.achieved_butter),
      r.converged ? 1 : 0, f2(r.ssim), r0(r.enc_ms), r0(r.dec_ms), r0(r.ttfp_ms), r.ttfp_kind,
      r.bytes, f2(r.bpp), fps(r.enc_ms), fps(r.dec_ms),
    ].join(" | "));
  }
  // aggregates per codec key
  lines.push("", "# Aggregates (per codec key)");
  const jxlBytesByFile = new Map(rows.filter(r => r.codec === "jxl").map(r => [r.file, r.bytes]));
  const byKey = new Map();
  for (const r of rows) { if (!byKey.has(r.codec)) byKey.set(r.codec, []); byKey.get(r.codec).push(r); }
  const avg = (arr, sel) => { const v = arr.map(sel).filter(x => x != null); return v.length ? v.reduce((s,x)=>s+x,0)/v.length : null; };
  for (const [key, arr] of byKey) {
    const ratios = arr.map(r => { const jb = jxlBytesByFile.get(r.file); return jb ? r.bytes / jb : null; }).filter(x => x != null);
    const sizeRatio = ratios.length ? ratios.reduce((s,x)=>s+x,0)/ratios.length : null;
    lines.push(
      `Avg_${key}_Bytes: ${r0(avg(arr, r=>r.bytes))} | Avg_${key}_Bpp: ${f2(avg(arr, r=>r.bpp))} | ` +
      `Avg_${key}_EncMs: ${r0(avg(arr, r=>r.enc_ms))} | Avg_${key}_DecMs: ${r0(avg(arr, r=>r.dec_ms))} | ` +
      `Avg_${key}_AchievedButter: ${f2(avg(arr, r=>r.achieved_butter))} | Avg_${key}_Ssim: ${f2(avg(arr, r=>r.ssim))} | ` +
      `Avg_${key}_SizeVsJxlRatio: ${sizeRatio == null ? "" : sizeRatio.toFixed(2)} | ` +
      `Avg_${key}_EncFps: ${fps(avg(arr, r=>r.enc_ms))} | Avg_${key}_DecFps: ${fps(avg(arr, r=>r.dec_ms))}`
    );
  }
  return lines.join("\n");
}
