// AI plant/animal identification BAKE-OFF harness.
//
// For each test RAW: extract the embedded preview JPEG (input path validated in
// extract-preview.mjs), then send it to each identification service, timing the
// round-trip and capturing the top candidates. Emits a console table, a JSON
// results file, and a markdown report.
//
// Purpose: empirically decide which service(s) respond, respond best, and respond
// fastest — the data that drives the eventual "AI-optimized export" design.
//
// Usage:
//   node run-bakeoff.mjs                 # all services with available creds
//   node run-bakeoff.mjs --only plantnet,inat
//   node run-bakeoff.mjs --no-lens       # skip the headful Playwright run
//   node run-bakeoff.mjs --dry           # extract previews only, call nothing
//
// Credentials: put PLANTNET_KEY / INAT_TOKEN in ai-id-bakeoff/.env
// Lens needs no key (headful browser). See services/*.mjs for details.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { extractPreview } from "./extract-preview.mjs";
import * as plantnet from "./services/plantnet.mjs";
import * as inat from "./services/inaturalist.mjs";
import * as gemini from "./services/gemini.mjs";
import * as lens from "./services/lens.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, "work");
// Look for .env locally first, then the repo root one level up.
const ENV_CANDIDATES = [join(HERE, ".env"), join(HERE, "..", ".env")];

// Default test corpus (override by passing file paths as positional args).
const DEFAULT_IMAGES = [
  "c:/Foo/raw-converter/tests/PXL_20260527_175312330.RAW-02.ORIGINAL.dng",
  "c:/Foo/raw-converter/tests/ADH 1248.CR2",
  "c:/Foo/raw-converter/tests/ADH 1455.CR2",
];

const ALL_SERVICES = { plantnet, inat, gemini, lens };

function parseArgs(argv) {
  const a = { only: null, lens: true, dry: false, resize: true, maxEdge: 1512, images: [] };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--dry") a.dry = true;
    else if (t === "--no-lens") a.lens = false;
    else if (t === "--no-resize") a.resize = false;
    else if (t === "--max-edge") a.maxEdge = Number(argv[++i]);
    else if (t === "--only") a.only = argv[++i].split(",").map((s) => s.trim());
    else if (t.startsWith("--")) console.warn(`ignoring unknown flag ${t}`);
    else a.images.push(t);
  }
  return a;
}

function selectServices(args) {
  let ids = args.only ?? Object.keys(ALL_SERVICES);
  if (!args.lens) ids = ids.filter((id) => id !== "lens");
  return ids.map((id) => ALL_SERVICES[id]).filter(Boolean);
}

async function timed(fn) {
  const t0 = performance.now();
  try {
    const value = await fn();
    return { ok: true, ms: performance.now() - t0, value };
  } catch (err) {
    return { ok: false, ms: performance.now() - t0, error: String(err?.message ?? err) };
  }
}

function fmtTop(results, n = 3) {
  if (!results?.length) return "—";
  return results.slice(0, n).map((r) => {
    const s = typeof r.score === "number" ? ` ${(r.score * (r.score <= 1 ? 100 : 1)).toFixed(1)}%` : "";
    const c = r.common ? ` (${r.common})` : "";
    return `${r.name}${c}${s}`;
  }).join("; ");
}

async function main() {
  const envPath = ENV_CANDIDATES.find((p) => existsSync(p));
  if (envPath) { process.loadEnvFile(envPath); console.log(`loaded creds from ${envPath}`); }
  else console.log(`no .env found in ${ENV_CANDIDATES.join(" or ")} — API services need PLANTNET_KEY / INAT_TOKEN`);
  mkdirSync(WORK, { recursive: true });

  const args = parseArgs(process.argv);
  const images = (args.images.length ? args.images : DEFAULT_IMAGES);
  const services = selectServices(args);
  const keyFor = {
    plantnet: process.env.PLANTNET_API_KEY || process.env.PLANTNET_KEY,
    inat: process.env.INAT_API_TOKEN || process.env.INAT_TOKEN,
    gemini: process.env.GEMINI_API_KEY,
    lens: null,
  };

  console.log(`\nimages: ${images.length} | services: ${services.map((s) => s.meta.id).join(", ") || "(none)"}${args.dry ? " | DRY" : ""}\n`);

  const rows = [];
  for (const imgPath of images) {
    const name = basename(imgPath);
    let preview;
    try {
      preview = extractPreview(imgPath);
    } catch (err) {
      console.error(`  ✗ ${name}: preview extract failed — ${err.message}`);
      rows.push({ image: name, error: `extract: ${err.message}` });
      continue;
    }
    // Downsize the preview for upload (smaller = faster, and services cap size).
    let sendBuf = preview.buffer, sw = preview.w, sh = preview.h;
    if (args.resize && Math.max(preview.w, preview.h) > args.maxEdge) {
      const out = await sharp(preview.buffer)
        .resize(args.maxEdge, args.maxEdge, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
        .toBuffer({ resolveWithObject: true });
      sendBuf = out.data; sw = out.info.width; sh = out.info.height;
    }
    const jpgPath = join(WORK, name.replace(/\.[^.]+$/, "") + ".preview.jpg");
    writeFileSync(jpgPath, sendBuf);
    const resTag = sendBuf === preview.buffer ? "" : ` → resized ${sw}x${sh}, ${(sendBuf.length / 1024).toFixed(0)}KB`;
    console.log(`▶ ${name} → preview ${preview.w}x${preview.h}, ${(preview.buffer.length / 1024).toFixed(0)}KB${resTag}`);

    for (const svc of services) {
      const id = svc.meta.id;
      if (args.dry) { console.log(`    ${id.padEnd(9)} DRY (would call)`); continue; }
      const key = keyFor[id];
      const r = await timed(() =>
        svc.identify({ buffer: sendBuf, filename: basename(jpgPath), filePath: jpgPath, workDir: WORK, key })
      );
      const row = {
        image: name, service: id, scope: svc.meta.scope,
        ok: r.ok, ms: Math.round(r.ms),
        top: r.ok ? r.value.results : [], error: r.ok ? null : r.error,
      };
      rows.push(row);
      if (r.ok) console.log(`    ${id.padEnd(9)} ${String(row.ms).padStart(6)}ms  ${fmtTop(row.top)}`);
      else console.log(`    ${id.padEnd(9)} ${String(row.ms).padStart(6)}ms  ✗ ${row.error}`);
    }
    console.log();
  }

  // Persist raw JSON.
  const jsonPath = join(WORK, "results.json");
  writeFileSync(jsonPath, JSON.stringify({ images, rows }, null, 2));

  // Markdown report.
  const md = buildReport(images, services, rows);
  const mdPath = join(WORK, "bakeoff-report.md");
  writeFileSync(mdPath, md);

  console.log(`\nwrote ${jsonPath}\nwrote ${mdPath}`);
  if (!args.dry) printSummary(rows);
}

function buildReport(images, services, rows) {
  const L = [];
  L.push(`# AI Identification Bake-off\n`);
  L.push(`Images: ${images.length}. Services: ${services.map((s) => `${s.meta.label} (${s.meta.scope})`).join(", ")}.\n`);
  L.push(`Input = embedded preview JPEG extracted from each RAW (no full decode).\n`);
  for (const img of images.map((i) => basename(i))) {
    L.push(`\n## ${img}\n`);
    L.push(`| Service | Scope | ms | OK | Top candidates |`);
    L.push(`|---|---|--:|:-:|---|`);
    for (const r of rows.filter((x) => x.image === img && x.service)) {
      L.push(`| ${r.service} | ${r.scope} | ${r.ms} | ${r.ok ? "✓" : "✗"} | ${r.ok ? fmtTop(r.top, 3) : "`" + (r.error || "") + "`"} |`);
    }
  }
  return L.join("\n") + "\n";
}

function printSummary(rows) {
  const svcRows = rows.filter((r) => r.service && r.ok);
  const bySvc = {};
  for (const r of rows.filter((x) => x.service)) {
    (bySvc[r.service] ??= { ok: 0, n: 0, ms: [] });
    bySvc[r.service].n++;
    if (r.ok) { bySvc[r.service].ok++; bySvc[r.service].ms.push(r.ms); }
  }
  console.log(`\n── SUMMARY ──`);
  for (const [id, s] of Object.entries(bySvc)) {
    const avg = s.ms.length ? Math.round(s.ms.reduce((a, b) => a + b, 0) / s.ms.length) : "—";
    console.log(`  ${id.padEnd(9)} ${s.ok}/${s.n} ok  avg ${avg}ms`);
  }
  const fastest = Object.entries(bySvc).filter(([, s]) => s.ms.length).sort((a, b) =>
    (a[1].ms.reduce((x, y) => x + y, 0) / a[1].ms.length) - (b[1].ms.reduce((x, y) => x + y, 0) / b[1].ms.length))[0];
  if (fastest) console.log(`  fastest: ${fastest[0]}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
