// Chroma-subsampling sweep for the AI-ID JPEG proxy: 4:4:4 vs 4:2:0 (the extremes;
// 4:2:2 is bounded between them and sharp doesn't expose it). Tests the "ML discards
// colour" hypothesis — does throwing away chroma resolution hurt identification?
// Swept at one or two optimal sizes (default 512 + 768) at fixed JPEG quality.
//
// Usage:
//   node chroma-sweep.mjs                     # sizes 512,768; q80; iNat+PlantNet
//   node chroma-sweep.mjs --sizes 768 --services gemini,inat
//   node chroma-sweep.mjs --q 80 <files...>

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { basename, extname, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import * as gemini from "./services/gemini.mjs";
import * as inat from "./services/inaturalist.mjs";
import * as plantnet from "./services/plantnet.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, "work", "chroma");
const ENV_CANDIDATES = [join(HERE, ".env"), join(HERE, "..", ".env")];
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];
const CHROMA = ["4:4:4", "4:2:0"];
const DEFAULT_IMAGES = [
  "c:/Foo/raw-converter/tests/ADH 1248.CR2",       // elephant (grey — colour-poor)
  "c:/Foo/raw-converter/tests/ADH 1455.CR2",       // blue water lily (colour-critical)
  "c:/Foo/raw-converter/tests/Lizard correct.jpg", // agama lizard (colourful)
];
const ALL_SERVICES = { gemini, inat, plantnet };
let raw;

const rgbaToRgb = (d, w, h) => { const o = new Uint8Array(w * h * 3); for (let i = 0, s = 0, k = 0; i < w * h; i++, s += 4, k += 3) { o[k] = d[s]; o[k + 1] = d[s + 1]; o[k + 2] = d[s + 2]; } return o; };
const rawSharp = (rgba, w, h) => sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width: w, height: h, channels: 4 } });
const fmtTop = (r) => !r?.length ? "—" : r.slice(0, 2).map((x) => `${x.name}${x.common ? ` (${x.common})` : ""}${typeof x.score === "number" ? ` ${(x.score * (x.score <= 1 ? 100 : 1)).toFixed(0)}%` : ""}`).join("; ");

function parseArgs(argv) {
  const a = { sizes: [512, 768], q: 80, services: ["inat", "plantnet"], images: [] };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--sizes") a.sizes = argv[++i].split(",").map(Number);
    else if (t === "--q") a.q = Number(argv[++i]);
    else if (t === "--services") a.services = argv[++i].split(",").map((s) => s.trim());
    else if (t.startsWith("--")) console.warn(`ignoring ${t}`);
    else a.images.push(t);
  }
  return a;
}

async function loadRgbaAtLong(path, targetLong) {
  const ext = extname(path).toLowerCase();
  let rgb, w, h;
  if (ext === ".jpg" || ext === ".jpeg") {
    const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
    rgb = info.channels === 4 ? rgbaToRgb(data, info.width, info.height) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    w = info.width; h = info.height;
  } else {
    const bytes = new Uint8Array(readFileSync(path));
    let dec;
    if (ext === ".orf" || ext === ".raw") dec = raw.process_orf_with_flags(bytes, 1, ...PROCESS_ARGS);
    else if (ext === ".cr2") dec = raw.process_cr2_with_flags(bytes, 1, ...PROCESS_ARGS);
    else if (ext === ".dng") dec = raw.process_dng_with_flags(bytes, 1, ...PROCESS_ARGS);
    else throw new Error(`unsupported ext ${ext}`);
    rgb = dec.take_rgb(); w = dec.width; h = dec.height; dec.free();
  }
  const long = Math.max(w, h);
  const scale = Math.min(targetLong / long, 1);
  const dw = Math.max(1, Math.round(w * scale)), dh = Math.max(1, Math.round(h * scale));
  const rgba = new Uint8Array(raw.rgb_to_rgba(scale < 1 ? raw.downscale_rgb(rgb, w, h, dw, dh) : rgb));
  return { rgba, w: dw, h: dh };
}

async function callService(svc, buffer, key) {
  const t0 = performance.now();
  try { const { results } = await svc.identify({ buffer, filename: "proxy.jpg", key }); return { ok: true, ms: Math.round(performance.now() - t0), top: results }; }
  catch (e) { return { ok: false, ms: Math.round(performance.now() - t0), error: String(e.message ?? e) }; }
}

async function main() {
  const envPath = ENV_CANDIDATES.find((p) => existsSync(p));
  if (envPath) { process.loadEnvFile(envPath); console.log(`creds: ${envPath}`); }
  mkdirSync(WORK, { recursive: true });
  const args = parseArgs(process.argv);
  const images = args.images.length ? args.images : DEFAULT_IMAGES;
  const keyFor = { gemini: process.env.GEMINI_API_KEY, inat: process.env.INAT_API_TOKEN || process.env.INAT_TOKEN, plantnet: process.env.PLANTNET_API_KEY || process.env.PLANTNET_KEY };
  const services = args.services.map((id) => [id, ALL_SERVICES[id]]).filter(([, s]) => s);

  raw = await import("../pkg/raw_converter_wasm.js");
  await raw.default({ module_or_path: readFileSync(new URL("../pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });

  console.log(`\nsizes: ${args.sizes.join(",")} | chroma: ${CHROMA.join(" vs ")} | q${args.q} | services: ${services.map(([id]) => id).join(",")}\n`);
  const out = [];
  for (const path of images) {
    const name = basename(path);
    console.log(`\n■ ${name}`);
    for (const size of args.sizes) {
      const { rgba, w, h } = await loadRgbaAtLong(path, size);
      for (const cs of CHROMA) {
        const jpg = new Uint8Array(await rawSharp(rgba, w, h).jpeg({ quality: args.q, chromaSubsampling: cs }).toBuffer());
        writeFileSync(join(WORK, `${name.replace(/\.[^.]+$/, "")}_${size}_${cs.replace(/:/g, "")}.jpg`), jpg);
        const row = { image: name, size, chroma: cs, w, h, kb: +(jpg.length / 1024).toFixed(1), results: {} };
        const cells = [];
        for (const [id, svc] of services) { const r = await callService(svc, jpg, keyFor[id]); row.results[id] = r; cells.push(`${id}: ${r.ok ? fmtTop(r.top) : "✗ " + (r.error || "").slice(0, 28)}`); }
        out.push(row);
        console.log(`   ${size}px ${cs} ${String(row.kb).padStart(6)}KB | ${cells.join("  |  ")}`);
      }
    }
  }
  writeFileSync(join(WORK, "chroma-sweep.json"), JSON.stringify(out, null, 2));
  writeFileSync(join(WORK, "chroma-sweep.md"), buildMd(args, images, out));
  console.log(`\nwrote ${join(WORK, "chroma-sweep.md")}`);
}

function buildMd(args, images, out) {
  const L = [`# Chroma subsampling sweep (4:4:4 vs 4:2:0) — AI-ID proxy\n`, `Sizes ${args.sizes.join(", ")}px, JPEG q${args.q}. Tests whether discarding chroma resolution hurts ID.\n`];
  for (const im of images.map((i) => basename(i))) {
    const keys = Object.keys(out.find((r) => r.image === im)?.results || {});
    L.push(`\n## ${im}\n`, `| Size | Chroma | KB | ${keys.join(" | ")} |`, `|---|---|--:|${"---|".repeat(keys.length)}`);
    for (const r of out.filter((x) => x.image === im)) L.push(`| ${r.size} | ${r.chroma} | ${r.kb} | ${Object.values(r.results).map((c) => c.ok ? fmtTop(c.top) : "✗").join(" | ")} |`);
  }
  return L.join("\n") + "\n";
}

main().catch((e) => { console.error(e); process.exit(1); });
