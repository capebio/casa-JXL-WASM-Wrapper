#!/usr/bin/env bun
/**
 * yt-testbed.mjs — CASAVA encoding sweep testbed.
 *
 * Accepts YouTube URLs (yt-dlp download) or local video file paths.
 * Encodes each at 3 distances × 3 efforts × 3 dimensions = 27 cells.
 * Writes an HTML comparison report to <out>/<video-id>/report.html.
 *
 * Usage:
 *   bun tools/yt-testbed.mjs <url-or-path> [<url-or-path>...] [--out ./testbed-out] [--gop 8]
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "fs";
import { basename, extname, join } from "path";

// ── Sweep axes ──────────────────────────────────────────────────────────────
const DISTANCES = [2, 1, 0.5];
const EFFORTS   = [1, 3, 4];
const DIMS      = [256, 512, 1080];

// ── CLI parse ───────────────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);
const inputs = [];
let outDir = "./testbed-out";
let gop = 8;
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--out")      { outDir = rawArgs[++i]; }
  else if (rawArgs[i] === "--gop") { gop = Number(rawArgs[++i]); }
  else                              { inputs.push(rawArgs[i]); }
}
if (!inputs.length) {
  console.error("Usage: bun tools/yt-testbed.mjs <url-or-path>... [--out ./testbed-out] [--gop 8]");
  process.exit(1);
}

// ── Utilities ────────────────────────────────────────────────────────────────
function isUrl(s)  { return s.startsWith("http://") || s.startsWith("https://"); }

function sanitizeVideoId(input) {
  const raw = basename(input.replace(/\\/g, "/"), extname(input.replace(/\\/g, "/")));
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").slice(0, 60);
}

async function spawnCapture(cmd, args) {
  const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { text: text.trim(), exitCode: proc.exitCode };
}

async function spawnSilent(cmd, args, ignoreError = false) {
  const proc = Bun.spawn([cmd, ...args], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  if (proc.exitCode !== 0 && !ignoreError) {
    throw new Error(`${cmd} exited with ${proc.exitCode}`);
  }
  return proc.exitCode;
}

// ── Video acquisition ────────────────────────────────────────────────────────
async function downloadYtDlp(url, workDir) {
  console.log(`  yt-dlp download: ${url}`);
  await spawnSilent("yt-dlp", [
    url,
    "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    "-o", "source.%(ext)s",
    "-P", workDir,
    "--no-playlist",
  ]);
  const files = readdirSync(workDir).filter(f => f.startsWith("source."));
  if (!files.length) throw new Error("yt-dlp: no source file downloaded");
  return join(workDir, files[0]);
}

// ── FFprobe ──────────────────────────────────────────────────────────────────
async function probeVideo(sourceFile) {
  const { text } = await spawnCapture("ffprobe", [
    "-v", "quiet", "-print_format", "json",
    "-show_streams", "-show_format",
    sourceFile,
  ]);
  const data = JSON.parse(text || "{}");
  const vs = (data.streams || []).find(s => s.codec_type === "video");
  const [fpsN, fpsD] = (vs?.r_frame_rate || "30/1").split("/").map(Number);
  const duration = parseFloat(data.format?.duration ?? "0");
  return {
    fpsN, fpsD,
    fps: fpsD > 0 ? fpsN / fpsD : 30,
    duration,
    width: vs?.width ?? 0,
    height: vs?.height ?? 0,
  };
}

// ── Frame grab extraction ────────────────────────────────────────────────────
async function extractFrameGrab(sourceFile, timestamp, dim, outPng) {
  const vf = dim === "exact"
    ? "scale=trunc(iw/2)*2:trunc(ih/2)*2"
    : `scale=${dim}:${dim}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
  await spawnSilent("ffmpeg", [
    "-ss", String(Math.max(0, timestamp)),
    "-i", sourceFile,
    "-frames:v", "1",
    "-vf", vf,
    "-y", outPng,
  ], true /* ignore error */);
}

// ── Encode one cell ──────────────────────────────────────────────────────────
async function encodeCell(sourceFile, outCasv, probe, d, e, gopSize, dim) {
  // casv_encode --video <in> <out> <fps_num> <fps_den> <rate> <d> <e> <gop> <skip> <tile> <thresh> <dim>
  await spawnSilent("casv_encode", [
    "--video", sourceFile, outCasv,
    String(probe.fpsN), String(probe.fpsD),
    "auto",          // rate
    String(d),       // distance
    String(e),       // effort
    String(gopSize), // gop
    "tile",          // skip
    "32",            // tile size
    "auto",          // thresh
    String(dim),     // long-side dimension
  ]);
}

// ── Sweep ────────────────────────────────────────────────────────────────────
async function runSweep(sourceFile, videoId, workDir, probe, gopSize) {
  const results = [];
  let n = 0;
  const total = DIMS.length * DISTANCES.length * EFFORTS.length;

  for (const dim of DIMS) {
    for (const d of DISTANCES) {
      for (const e of EFFORTS) {
        n++;
        const stem    = `${videoId}_d${d}_e${e}_dim${dim}`;
        const outCasv = join(workDir, `${stem}.casv`);
        const outPng  = join(workDir, `${stem}.png`);
        process.stdout.write(`  [${n}/${total}] dim=${dim} d=${d} e=${e} … `);

        const t0 = Date.now();
        let encOk = true;
        try {
          await encodeCell(sourceFile, outCasv, probe, d, e, gopSize, dim);
        } catch (err) {
          encOk = false;
          console.log(`FAILED (${err.message})`);
        }
        const encMs    = Date.now() - t0;
        const fileBytes = encOk && existsSync(outCasv) ? statSync(outCasv).size : 0;
        if (encOk) console.log(`${(fileBytes / 1024).toFixed(0)} KB  ${(encMs / 1000).toFixed(1)}s`);

        // Frame grab from source at 1/3 of video duration.
        if (probe.duration > 0) {
          await extractFrameGrab(sourceFile, probe.duration / 3, dim, outPng);
        }

        results.push({ dim, d, e, stem, encMs, fileBytes, encOk });
      }
    }
  }
  return results;
}

// ── HTML report ──────────────────────────────────────────────────────────────
function fmtBytes(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB`
                           : `${(n / 1024).toFixed(0)} KB`;
}
function fmtMs(ms) {
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)}s`;
}

function generateReport(videoId, sourceInput, probe, results) {
  const byKey = {};
  for (const r of results) byKey[`${r.dim}_${r.d}_${r.e}`] = r;

  const cols = [];
  for (const d of DISTANCES) for (const e of EFFORTS) cols.push({ d, e });

  const thead = `<tr><th>dim</th>${cols.map(c => `<th>d=${c.d}<br>e=${c.e}</th>`).join("")}</tr>`;
  const tbody = DIMS.map(dim => {
    const cells = cols.map(({ d, e }) => {
      const r = byKey[`${dim}_${d}_${e}`];
      if (!r || !r.encOk) return `<td class="err">ERR</td>`;
      const w = Math.min(dim, 200);
      return `<td>
  <img src="./${r.stem}.png" width="${w}" loading="lazy" onerror="this.style.display='none'">
  <div class="s">${fmtBytes(r.fileBytes)}<br>${fmtMs(r.encMs)} enc</div>
</td>`;
    }).join("\n");
    return `<tr><th>${dim}</th>${cells}</tr>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>CASAVA Testbed — ${videoId}</title>
<style>
  body { background:#111; color:#eee; font:13px/1.4 monospace; margin:1.5em; }
  h1 { color:#7cf; margin:.3em 0; }
  .info { color:#888; margin-bottom:1em; font-size:12px; }
  table { border-collapse:collapse; }
  th,td { border:1px solid #333; padding:5px 7px; vertical-align:top; text-align:center; }
  th { background:#1a1a1a; color:#aaa; font-weight:normal; }
  td { min-width:${Math.min(DIMS[0], 200) + 16}px; }
  td.err { color:#f66; background:#1a0000; }
  td img { display:block; margin:0 auto 4px; }
  .s { color:#aaa; font-size:11px; line-height:1.3; }
</style>
</head>
<body>
<h1>CASAVA Testbed — ${videoId}</h1>
<div class="info">
  Source: ${sourceInput}<br>
  ${probe.width}x${probe.height} &middot; ${probe.fps.toFixed(2)} fps &middot; ${probe.duration.toFixed(1)}s<br>
  Rows = long-side dimension &middot; Columns = distance x effort (quality x speed)
</div>
<table>
  <thead>${thead}</thead>
  <tbody>${tbody}</tbody>
</table>
</body>
</html>`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
const indexLinks = [];

for (const input of inputs) {
  console.log(`\n> ${input}`);
  const ytMode = isUrl(input);
  const videoId = ytMode
    ? (input.match(/[?&]v=([^&]+)/)?.[1] ?? sanitizeVideoId(input))
    : sanitizeVideoId(input);

  const workDir = join(outDir, videoId);
  mkdirSync(workDir, { recursive: true });

  let sourceFile;
  if (ytMode) {
    sourceFile = await downloadYtDlp(input, workDir);
  } else {
    if (!existsSync(input)) { console.error(`  ERROR: file not found: ${input}`); continue; }
    sourceFile = input;
  }

  console.log(`  probe: ${sourceFile}`);
  const probe = await probeVideo(sourceFile);
  console.log(`  ${probe.width}x${probe.height}  ${probe.fps.toFixed(2)} fps  ${probe.duration.toFixed(1)}s`);

  const results = await runSweep(sourceFile, videoId, workDir, probe, gop);

  const reportPath = join(workDir, "report.html");
  writeFileSync(reportPath, generateReport(videoId, input, probe, results));
  console.log(`  report: ${reportPath}`);
  indexLinks.push({ videoId, reportPath: `./${videoId}/report.html` });
}

// Write top-level index if multiple inputs.
if (indexLinks.length > 1) {
  const indexHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>CASAVA Testbed Index</title>
<style>body{background:#111;color:#eee;font:14px monospace;margin:2em}a{color:#7cf}</style>
</head><body><h1>CASAVA Testbed</h1><ul>
${indexLinks.map(l => `<li><a href="${l.reportPath}">${l.videoId}</a></li>`).join("\n")}
</ul></body></html>`;
  writeFileSync(join(outDir, "index.html"), indexHtml);
  console.log(`\nindex: ${join(outDir, "index.html")}`);
}
