const f2 = (x) => (x == null ? "" : Number(x).toFixed(2));
const r0 = (x) => (x == null ? "" : Math.round(x));

export function buildPaperToon({ sweep, fixed, bdRates, batchName, runTimestamp }) {
  const L = [
    `TestName: CodecPaper - ${batchName}`,
    `RunTimestamp: ${runTimestamp}`,
    `Quality parity: butteraugli via facade computeButteraugli (p3); ours vs jxl_orig at matched effort 3`,
    "# CAVEAT: native (sharp) vs wasm (@jsquash, ours) ENC/DEC MS NOT COMPARABLE ACROSS RUNTIMES. SIZE + QUALITY ARE.",
    "",
    "# RD sweep (image|class|codec|runtime|quality|bytes|bpp|butteraugli|ssim)",
  ];
  for (const s of sweep) L.push(`  ${s.image} | ${s.class} | ${s.codec} | ${s.runtime} | ${s.quality} | ${s.bytes} | ${f2(s.bpp)} | ${f2(s.butteraugli)} | ${f2(s.ssim)}`);
  L.push("", "# Fixed-quality point ~butteraugli 1.5 (image|class|codec|runtime|quality|butteraugli|bytes|bpp|enc_ms|dec_ms)");
  for (const p of fixed) L.push(`  ${p.image} | ${p.class} | ${p.codec} | ${p.runtime} | ${p.quality} | ${f2(p.butteraugli)} | ${p.bytes} | ${f2(p.bpp)} | ${r0(p.enc_ms)} | ${r0(p.dec_ms)}`);
  L.push("", "# BD-rate vs jpeg_native (percent bytes vs baseline at equal quality; negative=smaller)");
  for (const [codec, bd] of Object.entries(bdRates || {})) L.push(`BDRate_${codec}: ${bd == null ? "" : Number(bd).toFixed(1)}`);
  return L.join("\n");
}
