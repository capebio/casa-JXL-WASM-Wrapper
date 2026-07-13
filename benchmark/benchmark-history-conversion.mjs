import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";

import {
  deriveFamilyIdFromArtifactName,
  familyLabelFromId,
  familyPrimaryMetricKey,
} from "./benchmark-history-registry.mjs";
import { parseGraphRunText } from "./standard-multifile-history-graph.mjs";

const LEGACY_EXTENSIONS = new Set([".json", ".csv", ".md", ".log"]);
const TIME_KEY_RE = /ms/i;
const STRUCTURED_LOG_RE = /(?:RUNNING STANDARDIZED SPEEDTEST|TOON RESULTS|RunTimestamp:|AvgRawMs:)/i;

function timestampFromFilename(fileName) {
  const match = String(fileName).match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?(?:Z)?/);
  if (!match) return null;
  const [, date, hh, mm, ss, ms] = match;
  return `${date}T${hh}:${mm}:${ss}.${ms ?? "000"}Z`;
}

const PRIMARY_KEY_HINTS = new Map([
  ["policy-ab", ["viewer_ms", "baseline_ms"]],
  ["effort-sweep", ["encodeMs", "encode_ms"]],
  ["effort-sweep-benchmark", ["encodeMs", "encode_ms"]],
  ["p3-features", ["fullFinalMs", "full_final_ms", "encodeMs"]],
  ["p3-features-benchmark", ["fullFinalMs", "full_final_ms", "encodeMs"]],
  ["progressive-timing", ["avg_final_ms", "avg_first_ms", "shotFinalMs"]],
  ["progressive-byte", ["encodeMs", "encode_ms"]],
  ["progressive-byte-benchmark", ["encodeMs", "encode_ms"]],
  ["progressive-flag-matrix", ["encodeMs", "encode_ms"]],
  ["streaming-ssim", ["referenceDecodeMs", "reference_decode_ms", "encodeMs"]],
  ["streaming-ssim-benchmark", ["referenceDecodeMs", "reference_decode_ms", "encodeMs"]],
  ["session-worker-timings", ["totalMs", "TotalWallMs", "decodeMs"]],
  ["targeted-wasm-timings", ["totalMs", "TotalWallMs", "encodeMs"]],
  ["raw-format-sweep", ["totalMs", "TotalWallMs", "encodeMs"]],
  ["policy-matrix", ["encodeMs", "encode_ms"]],
]);

export function discoverLegacyBenchmarkArtifacts(roots) {
  const files = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!LEGACY_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      files.push(join(root, entry.name));
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

export function consolidateBenchmarkHistory({
  timingDir,
  legacyRoots = [],
  legacyCopies = [],
  backupDirName = "backup",
} = {}) {
  if (!timingDir) throw new Error("timingDir is required");
  if (!existsSync(timingDir)) mkdirSync(timingDir, { recursive: true });
  const backupRoot = join(timingDir, backupDirName);
  const legacyFiles = discoverLegacyBenchmarkArtifacts(legacyRoots)
    .concat(legacyCopies.filter((filePath) => existsSync(filePath)))
    .sort((a, b) => legacyPriority(a) - legacyPriority(b) || a.localeCompare(b));
  const seenStems = new Set();
  const written = [];
  const moved = [];
  const copyOnlyPaths = new Set(legacyCopies.map((filePath) => normalizePathForCompare(filePath)));

  for (const legacyPath of legacyFiles) {
    const stem = basename(legacyPath).replace(extname(legacyPath), "");
    const sourceRoot = legacyRoots.find((root) => legacyPath.startsWith(root)) ?? null;
    const rel = sourceRoot ? relative(sourceRoot, legacyPath) : basename(legacyPath);
    const backupPath = join(backupRoot, rel || basename(legacyPath));
    ensureParentDir(backupPath);
    const isBackupSource = sourceRoot && normalizePathForCompare(sourceRoot) === normalizePathForCompare(backupRoot);

    if (isBackupSource) {
      if (seenStems.has(stem)) continue;
      const artifact = convertLegacyBenchmarkArtifactToToon(legacyPath);
      if (!artifact) continue;
      seenStems.add(stem);
      const outName = `${artifact.stem}.toon`;
      const outPath = join(timingDir, outName);
      writeFileSync(outPath, artifact.toonText, "utf8");
      written.push(outPath);
      continue;
    }

    if (seenStems.has(stem)) {
      copyFileSync(legacyPath, backupPath);
      if (!copyOnlyPaths.has(normalizePathForCompare(legacyPath))) {
        try {
          unlinkSync(legacyPath);
        } catch (error) {
          if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
        }
        moved.push({ from: legacyPath, to: backupPath });
      }
      continue;
    }

    const artifact = convertLegacyBenchmarkArtifactToToon(legacyPath);
    if (!artifact) continue;
    seenStems.add(stem);
    const outName = `${artifact.stem}.toon`;
    const outPath = join(timingDir, outName);
    writeFileSync(outPath, artifact.toonText, "utf8");
    written.push(outPath);

    copyFileSync(legacyPath, backupPath);
    if (!copyOnlyPaths.has(normalizePathForCompare(legacyPath))) {
      try {
        unlinkSync(legacyPath);
      } catch (error) {
        if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
      }
      moved.push({ from: legacyPath, to: backupPath });
    }
  }

  const toonFiles = readdirSync(timingDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".toon")
    .map((entry) => join(timingDir, entry.name))
    .sort((a, b) => a.localeCompare(b));

  return { backupRoot, written, moved, toonFiles };
}

export function convertLegacyBenchmarkArtifactToToon(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (!LEGACY_EXTENSIONS.has(ext)) return null;

  const rawText = readFileSync(filePath, "utf8");
  if (ext === ".log" && STRUCTURED_LOG_RE.test(rawText)) {
    const parsed = parseGraphRunText(rawText, basename(filePath));
    if (!parsed?.timestampIso) return null;
    return convertStructuredLogArtifactToToon(filePath, parsed);
  }
  const familyId = deriveFamilyIdFromArtifactName(basename(filePath));
  const familyLabel = familyLabelFromId(familyId);
  const primaryKey = familyPrimaryMetricKey(familyId);
    const timestampIso = extractTimestamp(rawText) || timestampFromFilename(basename(filePath)) || statSync(filePath).mtime.toISOString();
  const summary = ext === ".json"
    ? summarizeJsonArtifact(rawText, familyId)
    : ext === ".csv"
      ? summarizeCsvArtifact(rawText, familyId)
      : summarizeMarkdownArtifact(rawText, familyId);

  if (!summary || summary.primaryMs == null) return null;

  const lines = [];
  lines.push(`TestName: ${familyLabel}`);
  lines.push(`RunTimestamp: ${timestampIso}`);
  lines.push(`FamilyId: ${familyId}`);
  lines.push(`FamilyLabel: ${familyLabel}`);
  lines.push(`SourceFile: ${basename(filePath)}`);
  lines.push(``);
  lines.push(`---`);
  lines.push(`${primaryKey}: ${formatNumber(summary.primaryMs)}`);
  if (summary.notes) lines.push(`Notes: ${summary.notes}`);
  if (summary.extraFields) {
    for (const [key, value] of Object.entries(summary.extraFields)) {
      if (value == null) continue;
      const outputKey = key.startsWith(`${familyId}.`) ? key : `${familyId}.${key}`;
      if (outputKey === primaryKey) continue;
      lines.push(`${outputKey}: ${formatNumber(value)}`);
    }
  }
  lines.push(``);

  return {
    stem: basename(filePath).replace(ext, ""),
    toonText: lines.join("\n"),
    familyId,
    familyLabel,
    primaryKey,
    timestampIso,
  };
}

function convertStructuredLogArtifactToToon(filePath, parsed) {
  const lines = [];
  lines.push(`TestName: ${parsed.testName}`);
  lines.push(`RunTimestamp: ${parsed.timestampIso}`);
  lines.push(`FamilyId: ${parsed.familyId}`);
  lines.push(`FamilyLabel: ${parsed.familyLabel}`);
  lines.push(`SourceFile: ${basename(filePath)}`);
  lines.push("");
  lines.push("---");

  for (const [key, value] of Object.entries(parsed.telemetry)) {
    if (value == null) continue;
    lines.push(`${key}: ${formatNumber(value)}`);
  }

  const metricEntries = Object.entries(parsed.metrics)
    .filter(([, value]) => value != null)
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of metricEntries) {
    lines.push(`${key}: ${formatNumber(value)}`);
  }

  lines.push("");

  return {
    stem: basename(filePath).replace(extname(filePath), ""),
    toonText: lines.join("\n"),
    familyId: parsed.familyId,
    familyLabel: parsed.familyLabel,
    primaryKey: familyPrimaryMetricKey(parsed.familyId),
    timestampIso: parsed.timestampIso,
  };
}

function summarizeJsonArtifact(text, familyId) {
  const data = JSON.parse(text);
  const values = collectTimeLikeNumbers(data);
  return buildSummaryFromValues(values, familyId, data);
}

function summarizeCsvArtifact(text, familyId) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const header = splitCsvLine(lines[0]).map((value) => value.trim());
  const rows = lines.slice(1).map(splitCsvLine);
  const values = new Map();
  for (const row of rows) {
    header.forEach((key, index) => {
      if (!TIME_KEY_RE.test(key)) return;
      const value = Number(row[index]);
      if (!Number.isFinite(value)) return;
      const bucket = values.get(key) ?? [];
      bucket.push(value);
      values.set(key, bucket);
    });
  }
  return buildSummaryFromValues(values, familyId, { rows: rows.length });
}

function summarizeMarkdownArtifact(text, familyId) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+(?:Ms|ms|_ms)):\s*([0-9]+(?:\.[0-9]+)?)\b/);
    if (!match) continue;
    const key = match[1];
    const value = Number(match[2]);
    const bucket = values.get(key) ?? [];
    bucket.push(value);
    values.set(key, bucket);
  }
  return buildSummaryFromValues(values, familyId, { markdown: true });
}

function buildSummaryFromValues(values, familyId, meta = {}) {
  const entries = values instanceof Map ? [...values.entries()] : Object.entries(values);
  if (!entries.length) return null;

  const averages = new Map();
  for (const [key, bucket] of entries) {
    const list = Array.isArray(bucket) ? bucket : [bucket];
    const numbers = list.filter((value) => Number.isFinite(value));
    if (!numbers.length) continue;
    averages.set(key, numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
  }

  if (!averages.size) return null;
  const primaryKey = pickPrimaryKey(familyId, [...averages.keys()]);
  const secondaryKeys = [...averages.keys()].filter((key) => key !== primaryKey).sort();
  return {
    primaryMs: averages.get(primaryKey) ?? null,
    secondaryMs: secondaryKeys.length ? averages.get(secondaryKeys[0]) ?? null : null,
    tertiaryMs: secondaryKeys.length > 1 ? averages.get(secondaryKeys[1]) ?? null : null,
    notes: meta.markdown ? "markdown summary" : null,
    extraFields: Object.fromEntries([...averages.entries()].filter(([key]) => key !== primaryKey)),
  };
}

function pickPrimaryKey(familyId, keys) {
  const normalized = String(familyId ?? "").toLowerCase();
  const hints = PRIMARY_KEY_HINTS.get(normalized) ?? [];
  for (const hint of hints) {
    const found = keys.find((key) => key.toLowerCase() === hint.toLowerCase());
    if (found) return found;
  }
  const preferred = keys.find((key) => /primaryms$/i.test(key));
  if (preferred) return preferred;
  const total = keys.find((key) => /total.*ms/i.test(key));
  if (total) return total;
  const encode = keys.find((key) => /encode.*ms/i.test(key));
  if (encode) return encode;
  const decode = keys.find((key) => /decode.*ms/i.test(key));
  if (decode) return decode;
  const final = keys.find((key) => /final.*ms/i.test(key));
  if (final) return final;
  return keys[0];
}

function collectTimeLikeNumbers(value, out = new Map(), path = []) {
  if (value == null) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectTimeLikeNumbers(item, out, path);
    return out;
  }
  if (typeof value === "number") return out;
  if (typeof value !== "object") return out;

  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (typeof child === "number" && TIME_KEY_RE.test(key)) {
      const bucket = out.get(key) ?? [];
      bucket.push(child);
      out.set(key, bucket);
    } else if (typeof child === "object" && child !== null) {
      collectTimeLikeNumbers(child, out, nextPath);
    }
  }

  return out;
}

function extractTimestamp(text) {
  const match = text.match(/^\s*RunTimestamp:\s*(.+)$/im);
  return match ? match[1].trim() : null;
}

function splitCsvLine(line) {
  return line.split(",").map((value) => value.trim());
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "N/A";
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function ensureParentDir(filePath) {
  // Cross-platform: use path.dirname, not a hardcoded "\\" separator. The old form broke on Linux CI —
  // paths there use "/", so lastIndexOf("\\") returned -1 → dir="" → the backup dir was never created
  // and copyFileSync ENOENT'd on the destination.
  const dir = dirname(filePath);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function normalizePathForCompare(filePath) {
  return String(filePath ?? "").replace(/\//g, "\\").toLowerCase().replace(/\\+$/g, "");
}

function legacyPriority(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".json") return 0;
  if (ext === ".csv") return 1;
  if (ext === ".md") return 2;
  if (ext === ".log") return 3;
  return 9;
}
