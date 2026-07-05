// Bitstream conformance / interop: prove our optimized JXL fork produces STANDARD JXL that the
// reference libjxl (@jsquash/jxl) decodes, and that we correctly decode reference-encoded JXL.
// For each image: encode with A, decode with B, measure butteraugli(source, B-decoded). If cross-
// decode butteraugli ~= same-decoder butteraugli, the bitstream is conformant across implementations.
import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { fetchKodak } from "./scripts/fetch-kodak.mjs";
import { initCodecCompareJxl, loadTargetRgba, butteraugliDistance, makeJxlAdapter } from "./benchmark/codec-compare-jxl.mjs";
import { ADAPTERS } from "./benchmark/codec-adapters.mjs";

const TEST_ROOT = String.raw`C:\Foo\raw-converter\tests`;
const log = (...a) => console.log(...a);

async function main() {
  await initCodecCompareJxl();
  const ours = makeJxlAdapter();                       // our facade fork
  const ref = ADAPTERS.find(a => a.key === "jxl_orig"); // reference libjxl (@jsquash/jxl)

  // small corpus: 2 Kodak + 1 RAW
  const corpus = [];
  try { const k = await fetchKodak({ log: () => {} }); for (const p of k.slice(0, 2)) { const { data, info } = await sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); corpus.push({ id: p.split(/[\\/]/).pop(), rgba: new Uint8Array(data), w: info.width, h: info.height }); } } catch {}
  const raw = join(TEST_ROOT, "P1110226.ORF");
  if (existsSync(raw)) { const r = await loadTargetRgba(raw); corpus.push({ id: r.file, rgba: r.rgba, w: r.tgtW, h: r.tgtH }); }

  log("\n=== JXL bitstream conformance (butteraugli of source vs decoded; cross ≈ self ⇒ conformant) ===\n");
  log("image                        | ours→ours | ours→ref  | ref→ref  | ref→ours  | verdict");
  const rows = [];
  for (const img of corpus) {
    const q = 75;
    const oursBytes = await ours.encode(img.rgba, img.w, img.h, q);
    const refBytes = await ref.encode(img.rgba, img.w, img.h, q);
    const bt = async (bytes, decoder) => { try { const d = await decoder(bytes); return await butteraugliDistance(img.rgba, d.data, img.w, img.h); } catch (e) { return null; } };
    const oo = await bt(oursBytes, (b) => ours.decode(b));       // our stream, our decoder
    const or = await bt(oursBytes, (b) => ref.decode(b));        // our stream, REFERENCE decoder  <- key conformance test
    const rr = await bt(refBytes, (b) => ref.decode(b));         // ref stream, ref decoder
    const ro = await bt(refBytes, (b) => ours.decode(b));        // ref stream, OUR decoder        <- key conformance test
    // conformant if cross-decodes succeed and land within 0.3 butteraugli of the same-impl decode
    const ok = or != null && ro != null && Math.abs(or - oo) < 0.3 && Math.abs(ro - rr) < 0.3;
    rows.push({ id: img.id, oo, or, rr, ro, ok });
    const f = (x) => x == null ? " FAIL" : x.toFixed(3);
    log(`${img.id.slice(0, 28).padEnd(28)} | ${f(oo)}     | ${f(or)}     | ${f(rr)}    | ${f(ro)}     | ${ok ? "CONFORMANT" : "MISMATCH"}`);
  }
  const allOk = rows.every(r => r.ok);
  log(`\n${allOk ? "✅ ALL CONFORMANT" : "⚠️ some mismatches"} — our optimized fork ${allOk ? "produces standard JXL the reference decodes, and decodes reference JXL correctly." : "has cross-decode differences (investigate)."}`);
}

main().then(() => setTimeout(() => process.exit(0), 300)).catch(e => { console.error(e); process.exit(1); });
