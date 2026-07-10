// Format comparison for the AI-ID proxy decision: PNG vs JPG vs JXL at the SAME
// pixel dimensions (default 1024x768 box). Uses OUR pathway end to end:
//   - RAW decode + downscale via our WASM pipeline (pkg/raw_converter_wasm)
//   - JXL encode via OUR libjxl facade (benchmark/codec-compare-jxl makeJxlAdapter)
//   - PNG/JPG via sharp
// Reports encoded byte size + butteraugli quality (vs the downscaled source) for
// each format, at identical dimensions. PNG = lossless baseline.
//
// Usage:
//   node format-compare.mjs                         # 3 default images, 1024x768
//   node format-compare.mjs --box 800x600
//   node format-compare.mjs --jpg-q 90 --jxl-q 90
//   node format-compare.mjs <file1> <file2> ...

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, extname, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { initCodecCompareJxl, makeJxlAdapter, butteraugliDistance } from "../benchmark/codec-compare-jxl.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, "work", "formats");

// Verbatim from codec-compare-jxl.mjs — full-range display RGB8, sensor orientation baked.
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];
const DEFAULT_IMAGES = [
  "c:/Foo/raw-converter/tests/PXL_20260527_175312330.RAW-02.ORIGINAL.dng",
  "c:/Foo/raw-converter/tests/ADH 1248.CR2",
  "c:/Foo/raw-converter/tests/ADH 1455.CR2",
];

let raw;
const rgbaToRgb = (d, w, h) => { const o = new Uint8Array(w * h * 3); for (let i = 0, s = 0, k = 0; i < w * h; i++, s += 4, k += 3) { o[k] = d[s]; o[k + 1] = d[s + 1]; o[k + 2] = d[s + 2]; } return o; };

function parseArgs(argv) {
  const a = { box: [1024, 768], jpgQ: 90, jxlQ: 90, images: [] };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--box") { const [w, h] = argv[++i].split("x").map(Number); a.box = [w, h]; }
    else if (t === "--jpg-q") a.jpgQ = Number(argv[++i]);
    else if (t === "--jxl-q") a.jxlQ = Number(argv[++i]);
    else if (t.startsWith("--")) console.warn(`ignoring ${t}`);
    else a.images.push(t);
  }
  return a;
}

// Decode a source file to RGBA at a target box (fit inside, preserve aspect), via our pipeline.
async function loadRgbaBox(path, boxW, boxH) {
  const ext = extname(path).toLowerCase();
  let rgb, srcW, srcH;
  if (ext === ".jpg" || ext === ".jpeg") {
    const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
    rgb = info.channels === 4 ? rgbaToRgb(data, info.width, info.height) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    srcW = info.width; srcH = info.height;
  } else {
    const bytes = new Uint8Array(readFileSync(path));
    let dec;
    if (ext === ".orf" || ext === ".raw") dec = raw.process_orf_with_flags(bytes, 1, ...PROCESS_ARGS);
    else if (ext === ".cr2") dec = raw.process_cr2_with_flags(bytes, 1, ...PROCESS_ARGS);
    else if (ext === ".dng") dec = raw.process_dng_with_flags(bytes, 1, ...PROCESS_ARGS);
    else throw new Error(`unsupported ext ${ext}`);
    rgb = dec.take_rgb(); srcW = dec.width; srcH = dec.height; dec.free();
  }
  const scale = Math.min(boxW / srcW, boxH / srcH, 1);
  const w = Math.max(1, Math.round(srcW * scale)), h = Math.max(1, Math.round(srcH * scale));
  const rgbScaled = scale < 1 ? raw.downscale_rgb(rgb, srcW, srcH, w, h) : rgb;
  const rgba = new Uint8Array(raw.rgb_to_rgba(rgbScaled));
  return { rgba, w, h, srcW, srcH };
}

const rawSharp = (rgba, w, h) => sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width: w, height: h, channels: 4 } });
const u8 = (x) => (x instanceof Uint8Array ? x : new Uint8Array(x));

async function main() {
  mkdirSync(WORK, { recursive: true });
  const args = parseArgs(process.argv);
  const images = args.images.length ? args.images : DEFAULT_IMAGES;
  const [boxW, boxH] = args.box;

  raw = await import("../pkg/raw_converter_wasm.js");
  await raw.default({ module_or_path: readFileSync(new URL("../pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });
  await initCodecCompareJxl();
  const jxl = makeJxlAdapter();

  console.log(`\nbox ${boxW}x${boxH} | JPG q${args.jpgQ} 4:4:4 | JXL q${args.jxlQ} (our facade) | PNG lossless\n`);
  const all = [];

  for (const path of images) {
    const name = basename(path);
    const { rgba, w, h, srcW, srcH } = await loadRgbaBox(path, boxW, boxH);

    // Encode all four at identical dims.
    const png = u8(await rawSharp(rgba, w, h).png().toBuffer());
    const jpg = u8(await rawSharp(rgba, w, h).jpeg({ quality: args.jpgQ, chromaSubsampling: "4:4:4" }).toBuffer());
    const jxlLossy = await jxl.encode(rgba, w, h, args.jxlQ);
    let jxlLossless = null;
    try { jxlLossless = await jxl.encodeLossless(rgba, w, h); } catch { /* unsupported */ }

    // Quality (butteraugli vs the downscaled source) for the lossy encodes.
    const decJpg = await sharp(Buffer.from(jpg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const jpgBa = await butteraugliDistance(rgba, u8(decJpg.data), w, h);
    const decJxl = await jxl.decode(jxlLossy);
    const jxlBa = await butteraugliDistance(rgba, u8(decJxl.data), w, h);

    const base = name.replace(/\.[^.]+$/, "");
    writeFileSync(join(WORK, `${base}.png`), png);
    writeFileSync(join(WORK, `${base}.jpg`), jpg);
    writeFileSync(join(WORK, `${base}.jxl`), jxlLossy);
    if (jxlLossless) writeFileSync(join(WORK, `${base}.lossless.jxl`), jxlLossless);

    const rows = [
      { fmt: "PNG (lossless)", bytes: png.length, ba: 0 },
      { fmt: `JPG q${args.jpgQ}`, bytes: jpg.length, ba: jpgBa },
      { fmt: `JXL q${args.jxlQ}`, bytes: jxlLossy.length, ba: jxlBa },
      ...(jxlLossless ? [{ fmt: "JXL lossless", bytes: jxlLossless.length, ba: 0 }] : []),
    ];
    const jpgBytes = jpg.length;
    console.log(`▶ ${name}  ${srcW}x${srcH} → ${w}x${h}`);
    for (const r of rows) {
      const kb = (r.bytes / 1024).toFixed(1).padStart(8);
      const vs = (r.bytes / jpgBytes).toFixed(2).padStart(5);
      const ba = r.ba === 0 ? "  —  " : r.ba.toFixed(3);
      console.log(`    ${r.fmt.padEnd(16)} ${kb} KB  ${vs}× JPG   butteraugli ${ba}`);
    }
    console.log();
    all.push({ name, srcW, srcH, w, h, rows });
  }

  writeFileSync(join(WORK, "format-compare.json"), JSON.stringify(all, null, 2));
  writeFileSync(join(WORK, "format-compare.md"), buildMd(boxW, boxH, args, all));
  console.log(`wrote ${join(WORK, "format-compare.md")}`);
}

function buildMd(boxW, boxH, args, all) {
  const L = [`# Format comparison (PNG vs JPG vs JXL) at ${boxW}x${boxH}\n`];
  L.push(`Encoders: JXL = our libjxl facade (q${args.jxlQ}); JPG = sharp q${args.jpgQ} 4:4:4; PNG = sharp lossless.`);
  L.push(`Butteraugli = distance from the downscaled source (0 = identical; ~1 imperceptible).`);
  L.push(`\n> AI-ID note: iNaturalist / Pl@ntNet / Gemini accept **JPG and PNG**, not JXL. JXL = archival; the AI proxy must be JPG/PNG.\n`);
  for (const im of all) {
    L.push(`\n## ${im.name}  (${im.srcW}x${im.srcH} → ${im.w}x${im.h})\n`);
    L.push(`| Format | Size | vs JPG | Butteraugli |`);
    L.push(`|---|--:|--:|--:|`);
    const jpg = im.rows.find((r) => r.fmt.startsWith("JPG")).bytes;
    for (const r of im.rows) L.push(`| ${r.fmt} | ${(r.bytes / 1024).toFixed(1)} KB | ${(r.bytes / jpg).toFixed(2)}× | ${r.ba === 0 ? "—" : r.ba.toFixed(3)} |`);
  }
  return L.join("\n") + "\n";
}

main().catch((e) => { console.error(e); process.exit(1); });
