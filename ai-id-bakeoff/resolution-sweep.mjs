// Resolution + downscale-METHOD sweep for the AI-ID JPEG proxy.
//
// Format is settled (JPEG). Open question: what resolution, and generated HOW?
//   Method A "direct":  our downscale_rgb, full-res → target long-edge (single step).
//   Method B "pyramid": our downscale_rgba cascaded halving (full → 1/2 → 1/4 → 1/8),
//                        i.e. the CASAVA scrubbing pyramid the app already produces.
// Each proxy is JPEG q90 4:4:4, sent to the ID services; we tabulate the top result
// per (image, method, size) to see the minimum viable resolution and whether the
// cheap pyramid levels identify as well as a dedicated direct resize.
//
// Pyramid fractions rarely match the direct target sizes exactly — compared best-effort.
//
// Usage:
//   node resolution-sweep.mjs                      # defaults (Gemini + iNat)
//   node resolution-sweep.mjs --services gemini
//   node resolution-sweep.mjs --sizes 512,800,1024,1920
//   node resolution-sweep.mjs --jpg-q 90 <files...>

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { basename, extname, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import * as gemini from "./services/gemini.mjs";
import * as inat from "./services/inaturalist.mjs";
import * as plantnet from "./services/plantnet.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, "work", "sweep");
const ENV_CANDIDATES = [join(HERE, ".env"), join(HERE, "..", ".env")];
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

const DEFAULT_IMAGES = [
  "c:/Foo/raw-converter/tests/ADH 1248.CR2",   // elephant (animal)
  "c:/Foo/raw-converter/tests/ADH 1455.CR2",   // blue water lily (plant)
  "c:/Foo/raw-converter/tests/Lizard correct.jpg", // agama lizard (animal)
];
const ALL_SERVICES = { gemini, inat, plantnet };

let raw;
const rgbaToRgb = (d, w, h) => { const o = new Uint8Array(w * h * 3); for (let i = 0, s = 0, k = 0; i < w * h; i++, s += 4, k += 3) { o[k] = d[s]; o[k + 1] = d[s + 1]; o[k + 2] = d[s + 2]; } return o; };
const rawSharp = (rgba, w, h) => sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width: w, height: h, channels: 4 } });

function parseArgs(argv) {
  const a = { services: ["gemini", "inat"], sizes: [512, 800, 1024, 1920], jpgQ: 90, images: [] };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--services") a.services = argv[++i].split(",").map((s) => s.trim());
    else if (t === "--sizes") a.sizes = argv[++i].split(",").map(Number);
    else if (t === "--jpg-q") a.jpgQ = Number(argv[++i]);
    else if (t.startsWith("--")) console.warn(`ignoring ${t}`);
    else a.images.push(t);
  }
  return a;
}

// Decode a source to FULL-res RGB (+ dims) via our pipeline (or sharp for JPEG input).
async function loadFullRgb(path) {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") {
    const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
    const rgb = info.channels === 4 ? rgbaToRgb(data, info.width, info.height) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return { rgb, w: info.width, h: info.height };
  }
  const bytes = new Uint8Array(readFileSync(path));
  let dec;
  if (ext === ".orf" || ext === ".raw") dec = raw.process_orf_with_flags(bytes, 1, ...PROCESS_ARGS);
  else if (ext === ".cr2") dec = raw.process_cr2_with_flags(bytes, 1, ...PROCESS_ARGS);
  else if (ext === ".dng") dec = raw.process_dng_with_flags(bytes, 1, ...PROCESS_ARGS);
  else throw new Error(`unsupported ext ${ext}`);
  const rgb = dec.take_rgb(), w = dec.width, h = dec.height; dec.free();
  return { rgb, w, h };
}

const jpgEncode = async (rgba, w, h, q) => new Uint8Array(await rawSharp(rgba, w, h).jpeg({ quality: q, chromaSubsampling: "4:4:4" }).toBuffer());

// Method A: direct single-step downscale to a target long-edge.
function directProxy(rgb, w, h, targetLong) {
  const long = Math.max(w, h);
  if (targetLong >= long) return null; // don't upscale
  const scale = targetLong / long;
  const dw = Math.max(1, Math.round(w * scale)), dh = Math.max(1, Math.round(h * scale));
  const rgba = new Uint8Array(raw.rgb_to_rgba(raw.downscale_rgb(rgb, w, h, dw, dh)));
  return { rgba, w: dw, h: dh };
}

// Method B: cascaded halving (full → 1/2 → 1/4 → 1/8), each level from the previous — the scrubbing pyramid.
function pyramidLevels(rgb, w, h, nLevels = 3) {
  const levels = [];
  let cur = new Uint8Array(raw.rgb_to_rgba(rgb)), cw = w, ch = h;
  for (let l = 1; l <= nLevels; l++) {
    const dw = Math.max(1, cw >> 1), dh = Math.max(1, ch >> 1);
    cur = new Uint8Array(raw.downscale_rgba(cur, cw, ch, dw, dh)); cw = dw; ch = dh;
    levels.push({ frac: `1/${2 ** l}`, rgba: cur, w: cw, h: ch });
  }
  return levels;
}

const fmtTop = (results) => !results?.length ? "—" : results.slice(0, 2).map((r) => {
  const s = typeof r.score === "number" ? ` ${(r.score * (r.score <= 1 ? 100 : 1)).toFixed(0)}%` : "";
  return `${r.name}${r.common ? ` (${r.common})` : ""}${s}`;
}).join("; ");

async function callService(svc, id, buffer, key) {
  const t0 = performance.now();
  try {
    const { results } = await svc.identify({ buffer, filename: "proxy.jpg", key });
    return { ok: true, ms: Math.round(performance.now() - t0), top: results };
  } catch (e) { return { ok: false, ms: Math.round(performance.now() - t0), error: String(e.message ?? e) }; }
}

async function main() {
  const envPath = ENV_CANDIDATES.find((p) => existsSync(p));
  if (envPath) { process.loadEnvFile(envPath); console.log(`creds: ${envPath}`); }
  mkdirSync(WORK, { recursive: true });
  const args = parseArgs(process.argv);
  const images = args.images.length ? args.images : DEFAULT_IMAGES;
  const keyFor = {
    gemini: process.env.GEMINI_API_KEY,
    inat: process.env.INAT_API_TOKEN || process.env.INAT_TOKEN,
    plantnet: process.env.PLANTNET_API_KEY || process.env.PLANTNET_KEY,
  };
  const services = args.services.map((id) => [id, ALL_SERVICES[id]]).filter(([, s]) => s);

  raw = await import("../pkg/raw_converter_wasm.js");
  await raw.default({ module_or_path: readFileSync(new URL("../pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });

  console.log(`\nsizes(direct): ${args.sizes.join(",")} | pyramid: 1/2,1/4,1/8 | services: ${services.map(([id]) => id).join(",")}\n`);
  const out = [];

  for (const path of images) {
    const name = basename(path);
    const { rgb, w, h } = await loadFullRgb(path);
    console.log(`\n■ ${name}  source ${w}x${h}`);

    // Build the proxy matrix: direct sizes + pyramid fractions.
    const proxies = [];
    for (const s of args.sizes) { const p = directProxy(rgb, w, h, s); if (p) proxies.push({ method: "direct", label: `${s}px`, ...p }); }
    for (const lv of pyramidLevels(rgb, w, h, 3)) proxies.push({ method: "pyramid", label: lv.frac, w: lv.w, h: lv.h, rgba: lv.rgba });

    for (const p of proxies) {
      p.jpg = await jpgEncode(p.rgba, p.w, p.h, args.jpgQ);
      const base = `${name.replace(/\.[^.]+$/, "")}_${p.method}_${p.label.replace("/", "-")}`;
      writeFileSync(join(WORK, `${base}.jpg`), p.jpg);
      const row = { image: name, method: p.method, label: p.label, w: p.w, h: p.h, kb: +(p.jpg.length / 1024).toFixed(1), results: {} };
      const cells = [];
      for (const [id, svc] of services) {
        const r = await callService(svc, id, p.jpg, keyFor[id]);
        row.results[id] = r;
        cells.push(`${id}: ${r.ok ? fmtTop(r.top) : "✗ " + (r.error || "").slice(0, 40)}`);
      }
      out.push(row);
      console.log(`   ${p.method.padEnd(7)} ${p.label.padEnd(6)} ${(p.w + "x" + p.h).padEnd(11)} ${String(row.kb).padStart(6)}KB | ${cells.join("  |  ")}`);
    }
  }

  writeFileSync(join(WORK, "sweep.json"), JSON.stringify(out, null, 2));
  writeFileSync(join(WORK, "sweep-report.md"), buildMd(args, images, out));
  console.log(`\nwrote ${join(WORK, "sweep-report.md")}`);
}

function buildMd(args, images, out) {
  const L = [`# Resolution + downscale-method sweep (AI-ID JPEG proxy)\n`];
  L.push(`JPEG q${args.jpgQ} 4:4:4. Direct = our downscale_rgb (single step). Pyramid = our downscale_rgba cascaded halving (CASAVA scrubbing).\n`);
  for (const im of images.map((i) => basename(i))) {
    L.push(`\n## ${im}\n`);
    L.push(`| Method | Level | Dims | JPEG KB | ${Object.keys(out.find((r) => r.image === im)?.results || {}).join(" | ")} |`);
    L.push(`|---|---|---|--:|${"---|".repeat(Object.keys(out.find((r) => r.image === im)?.results || {}).length)}`);
    for (const r of out.filter((x) => x.image === im)) {
      const cells = Object.values(r.results).map((c) => c.ok ? fmtTop(c.top) : "✗");
      L.push(`| ${r.method} | ${r.label} | ${r.w}x${r.h} | ${r.kb} | ${cells.join(" | ")} |`);
    }
  }
  return L.join("\n") + "\n";
}

main().catch((e) => { console.error(e); process.exit(1); });
