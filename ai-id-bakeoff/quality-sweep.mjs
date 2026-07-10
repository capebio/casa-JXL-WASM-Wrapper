// JPEG QUALITY sweep for the AI-ID proxy, at a fixed resolution (768px long-edge,
// direct downscale via our pipeline). Varies JPEG quality to find how low we can go
// (smaller upload) before identification degrades.
//
// Usage:
//   node quality-sweep.mjs                          # 768px, q=50,70,80,90,95, Gemini+iNat
//   node quality-sweep.mjs --size 768 --qualities 50,70,80,90,95
//   node quality-sweep.mjs --services inat <files...>

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { basename, extname, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import * as gemini from "./services/gemini.mjs";
import * as inat from "./services/inaturalist.mjs";
import * as plantnet from "./services/plantnet.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, "work", "quality");
const ENV_CANDIDATES = [join(HERE, ".env"), join(HERE, "..", ".env")];
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];
const DEFAULT_IMAGES = [
  "c:/Foo/raw-converter/tests/ADH 1248.CR2",       // elephant
  "c:/Foo/raw-converter/tests/ADH 1455.CR2",       // blue water lily
  "c:/Foo/raw-converter/tests/Lizard correct.jpg", // agama lizard
];
const ALL_SERVICES = { gemini, inat, plantnet };
let raw;

const rgbaToRgb = (d, w, h) => { const o = new Uint8Array(w * h * 3); for (let i = 0, s = 0, k = 0; i < w * h; i++, s += 4, k += 3) { o[k] = d[s]; o[k + 1] = d[s + 1]; o[k + 2] = d[s + 2]; } return o; };
const rawSharp = (rgba, w, h) => sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width: w, height: h, channels: 4 } });
const fmtTop = (r) => !r?.length ? "—" : r.slice(0, 2).map((x) => `${x.name}${x.common ? ` (${x.common})` : ""}${typeof x.score === "number" ? ` ${(x.score * (x.score <= 1 ? 100 : 1)).toFixed(0)}%` : ""}`).join("; ");

function parseArgs(argv) {
  const a = { size: 768, qualities: [50, 70, 80, 90, 95], services: ["gemini", "inat"], images: [] };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--size") a.size = Number(argv[++i]);
    else if (t === "--qualities") a.qualities = argv[++i].split(",").map(Number);
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

  console.log(`\n${args.size}px long-edge (direct) | qualities: ${args.qualities.join(",")} | services: ${services.map(([id]) => id).join(",")}\n`);
  const out = [];
  for (const path of images) {
    const name = basename(path);
    const { rgba, w, h } = await loadRgbaAtLong(path, args.size);
    console.log(`\n■ ${name}  proxy ${w}x${h}`);
    for (const q of args.qualities) {
      const jpg = new Uint8Array(await rawSharp(rgba, w, h).jpeg({ quality: q, chromaSubsampling: "4:4:4" }).toBuffer());
      writeFileSync(join(WORK, `${name.replace(/\.[^.]+$/, "")}_q${q}.jpg`), jpg);
      const row = { image: name, q, kb: +(jpg.length / 1024).toFixed(1), results: {} };
      const cells = [];
      for (const [id, svc] of services) { const r = await callService(svc, jpg, keyFor[id]); row.results[id] = r; cells.push(`${id}: ${r.ok ? fmtTop(r.top) : "✗ " + (r.error || "").slice(0, 30)}`); }
      out.push(row);
      console.log(`   q${String(q).padEnd(3)} ${String(row.kb).padStart(6)}KB | ${cells.join("  |  ")}`);
    }
  }
  writeFileSync(join(WORK, "quality-sweep.json"), JSON.stringify(out, null, 2));
  writeFileSync(join(WORK, "quality-sweep.md"), buildMd(args, images, out));
  console.log(`\nwrote ${join(WORK, "quality-sweep.md")}`);
}

function buildMd(args, images, out) {
  const L = [`# JPEG quality sweep @ ${args.size}px (AI-ID proxy)\n`, `Direct downscale, 4:4:4. Finds the lowest JPEG quality that still identifies correctly.\n`];
  for (const im of images.map((i) => basename(i))) {
    const keys = Object.keys(out.find((r) => r.image === im)?.results || {});
    L.push(`\n## ${im}\n`, `| Quality | KB | ${keys.join(" | ")} |`, `|---|--:|${"---|".repeat(keys.length)}`);
    for (const r of out.filter((x) => x.image === im)) L.push(`| q${r.q} | ${r.kb} | ${Object.values(r.results).map((c) => c.ok ? fmtTop(c.top) : "✗").join(" | ")} |`);
  }
  return L.join("\n") + "\n";
}

main().catch((e) => { console.error(e); process.exit(1); });
