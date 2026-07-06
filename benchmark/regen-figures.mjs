// Regenerate figures + figures.html from an existing CodecPaper toon (no re-encode).
// Usage: node benchmark/regen-figures.mjs [path-to-toon]
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFigures } from "./codec-paper-figures.mjs";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "outputs", "codec-paper");

function parseToon(text) {
  const sweepBlock = text.split("# RD sweep")[1].split("# Fixed")[0];
  const fixedBlock = text.split("# Fixed-quality point")[1].split("# BD-rate")[0];
  const rows = (block) => block.trim().split("\n").slice(1).map(l => l.trim().split("|").map(x => x.trim())).filter(c => c.length > 3);
  const sweep = rows(sweepBlock).map(c => ({ image: c[0], class: c[1], codec: c[2], runtime: c[3], quality: +c[4], bytes: +c[5], bpp: +c[6], butteraugli: +c[7], ssim: +c[8] }));
  const fixed = rows(fixedBlock).map(c => ({ image: c[0], class: c[1], codec: c[2], runtime: c[3], quality: +c[4], butteraugli: +c[5], bytes: +c[6], bpp: +c[7], enc_ms: +c[8], dec_ms: +c[9] }));
  const bdRates = {};
  for (const l of text.split("\n")) { const m = l.match(/^BDRate_(\S+):\s*(-?[\d.]+)?/); if (m) bdRates[m[1]] = m[2] == null ? null : +m[2]; }
  return { sweep, fixed, bdRates };
}

const toonPath = process.argv[2] || join(OUT_DIR, readdirSync(OUT_DIR).filter(f => f.includes("CodecPaper") && f.endsWith(".toon")).sort().pop());
const { sweep, fixed, bdRates } = parseToon(readFileSync(toonPath, "utf8"));
const { count } = writeFigures({ outDir: OUT_DIR, sweep, fixed, bdRates });
console.log(`Regenerated ${count} figures + figures.html from ${toonPath.split(/[\\/]/).pop()} (${sweep.length} sweep, ${fixed.length} fixed rows)`);
