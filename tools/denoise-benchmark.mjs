#!/usr/bin/env node
/**
 * denoise-benchmark.mjs — RAW denoise quality and performance benchmark.
 *
 * Usage:
 *   node tools/denoise-benchmark.mjs --manifest <path> --out <path>
 *   node tools/denoise-benchmark.mjs --dry-run   (validates manifest only)
 *
 * Reports per-image: gate decision, backend, denoise_ms, noise_score,
 * noise_confidence, noise_source, model_version.
 * When --with-metrics is set: PSNR, SSIM, tile-seam max (requires
 * reference images specified in manifest).
 *
 * Architecture note: this script does NOT run WASM directly.  WASM executes
 * inside browser workers.  The benchmark's job is to:
 *   1. Load and validate the corpus manifest.
 *   2. For each scene, emit a structured row with expected gate behaviour.
 *   3. Compute summary statistics.
 *   4. Write a JSON report to --out.
 *
 * Release gates that require a real browser or trained model are marked as
 * "manual" in RELEASE_GATES below.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';

// ─── Release gate registry ────────────────────────────────────────────────────
// Each entry maps a gate name to how it is verified:
//   null       → checked by this script at runtime
//   'manual'   → requires a browser benchmark or real camera corpus
//   string     → code-enforced; the value names where the guard lives
const RELEASE_GATES = {
  disabled_hash_equals_oracle:        'manual',               // requires browser test
  no_age_trigger:                     'enforced_in_policy_code', // policy.rs has no year field
  old_camera_triggers_from_score:     'manual',               // requires real camera corpus
  clean_low_iso_stays_off:            'manual',               // requires real camera corpus
  unknown_iso_skips_safely:           'enforced_in_policy_code', // decide() returns NoiseUnavailable
  no_tile_seam_exceeds_1:             'manual',               // requires denoise_quality.rs gate4
  color_regression_delta_e00:         'manual',               // requires trained model + corpus
  learned_beats_classical:            'manual',               // requires trained model + corpus
  webgpu_p50_latency:                 'manual',               // requires browser benchmark
  classical_p50_24mp:                 'manual',               // requires timing measurement
  peak_memory_24mp:                   'manual',               // requires heap profiling
  model_size_verified:                null,                   // check at runtime (below)
  hash_verified:                      null,                   // check at runtime (below)
};

// ─── CLI argument parsing ─────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run')        { args.dryRun = true; }
    else if (a === '--with-metrics') { args.withMetrics = true; }
    else if (a === '--manifest')  { args.manifest = argv[++i]; }
    else if (a === '--out')       { args.out = argv[++i]; }
    else if (a === '--limit')     { args.limit = parseInt(argv[++i], 10); }
  }
  return args;
}

// ─── Manifest loading and schema validation ───────────────────────────────────
function loadManifest(manifestPath) {
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new Error(`Manifest JSON parse error: ${e.message}`);
  }

  // Schema check: schemaVersion must be 1
  if (raw.schemaVersion !== 1) {
    throw new Error(
      `Manifest schemaVersion must be 1, got: ${JSON.stringify(raw.schemaVersion)}`,
    );
  }
  // scenes must be an array
  if (!Array.isArray(raw.scenes)) {
    throw new Error(`Manifest "scenes" must be an array, got: ${typeof raw.scenes}`);
  }

  return raw;
}

/**
 * Validate all scene file paths exist on disk.
 * @param {object[]} scenes
 * @returns {{ ok: number, missing: string[] }}
 */
function validateScenePaths(scenes) {
  let ok = 0;
  const missing = [];
  for (const scene of scenes) {
    const paths = scene.paths || {};
    for (const [key, p] of Object.entries(paths)) {
      if (typeof p === 'string') {
        if (existsSync(p)) { ok++; }
        else { missing.push(`${scene.id}/${key}: ${p}`); }
      } else if (Array.isArray(p)) {
        for (const fp of p) {
          if (existsSync(fp)) { ok++; }
          else { missing.push(`${scene.id}/${key}[]: ${fp}`); }
        }
      }
    }
  }
  return { ok, missing };
}

// ─── Runtime gate checks ──────────────────────────────────────────────────────
/**
 * Verify model artifact size and hash from the manifest.
 * Returns { model_size_verified, hash_verified, model_path, artifact_size_bytes }.
 */
function checkModelArtifact() {
  // Locate the model manifest relative to the script (tools/../web/models/)
  const scriptDir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
  const manifestPath = scriptDir.replace(/tools[/\\]?$/, '') + 'web/models/raw-denoise-v1.json';
  const modelPath = manifestPath.replace(/\.json$/, '.ort');

  const result = {
    model_manifest_path: manifestPath,
    model_path: modelPath,
    model_size_verified: false,
    hash_verified: false,
    artifact_size_bytes: null,
    artifact_size_ok: false,
    sha256_expected: null,
    sha256_actual: null,
  };

  if (!existsSync(manifestPath)) {
    result.error = `Model manifest not found: ${manifestPath}`;
    return result;
  }

  let modelManifest;
  try {
    modelManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    result.error = `Model manifest parse error: ${e.message}`;
    return result;
  }

  result.sha256_expected = modelManifest.sha256 || null;
  // Size gate: model must be <= 8 MiB
  const MAX_SIZE_BYTES = 8 * 1024 * 1024;

  if (existsSync(modelPath)) {
    const bytes = readFileSync(modelPath);
    result.artifact_size_bytes = bytes.length;
    result.artifact_size_ok = bytes.length <= MAX_SIZE_BYTES;
    result.model_size_verified = true;

    // Hash check
    const hash = createHash('sha256').update(bytes).digest('hex');
    result.sha256_actual = hash;
    result.hash_verified = (result.sha256_expected != null) && (hash === result.sha256_expected);
  } else {
    result.error = `Model .ort file not found: ${modelPath}`;
  }

  return result;
}

// ─── Per-scene row ────────────────────────────────────────────────────────────
/**
 * Build the expected row for a scene based solely on manifest metadata.
 * Actual metric numbers (PSNR, SSIM, seam) require a browser run.
 *
 * @param {object} scene  Scene entry from manifest
 * @param {boolean} withMetrics  If true, add placeholder metric fields
 */
function buildSceneRow(scene, withMetrics) {
  const row = {
    id: scene.id,
    camera: scene.camera || null,
    iso: typeof scene.iso === 'number' ? scene.iso : 0,
    split: scene.split || null,
    expected_gate: inferExpectedGate(scene),
    paths_defined: Object.keys(scene.paths || {}).length,
  };

  if (withMetrics) {
    // Placeholder fields — populated only when a browser run is wired in.
    row.psnr_db = null;
    row.ssim = null;
    row.tile_seam_max = null;
    row.denoise_ms = null;
    row.noise_score = null;
    row.noise_confidence = null;
    row.noise_source = null;
    row.model_version = null;
    row.backend = null;
    row.metrics_note = 'requires_browser_run';
  }

  return row;
}

/**
 * Infer whether this scene is expected to trigger denoise (auto mode, normal sensitivity).
 * Convention: iso >= 1600 or a "noisy" tag on the scene → expected to trigger.
 */
function inferExpectedGate(scene) {
  if (scene.expected_gate != null) return scene.expected_gate;
  if (typeof scene.iso === 'number' && scene.iso >= 1600) return 'apply';
  return 'undetermined';
}

// ─── Summary statistics ───────────────────────────────────────────────────────
function summarize(rows) {
  const total = rows.length;
  const byGate = {};
  for (const r of rows) {
    byGate[r.expected_gate] = (byGate[r.expected_gate] || 0) + 1;
  }
  const bySplit = {};
  for (const r of rows) {
    const s = r.split || 'unspecified';
    bySplit[s] = (bySplit[s] || 0) + 1;
  }
  return { total, by_expected_gate: byGate, by_split: bySplit };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Default: dry-run if no manifest supplied
  if (!args.manifest && !args.dryRun) {
    console.error(
      'Usage: node tools/denoise-benchmark.mjs --manifest <path> [--out <path>] [--dry-run] [--with-metrics] [--limit N]',
    );
    process.exit(1);
  }

  // Always check model artifact (runtime gates)
  const modelCheck = checkModelArtifact();

  if (args.dryRun && !args.manifest) {
    // Dry-run without manifest: just check model artifact and print gate summary
    console.log('\n=== denoise-benchmark: dry-run (no manifest) ===\n');
    printModelCheck(modelCheck);
    printGateSummary({}, modelCheck);
    return;
  }

  // Load manifest
  const manifest = loadManifest(args.manifest);
  const scenes = args.limit != null ? manifest.scenes.slice(0, args.limit) : manifest.scenes;

  console.log(`\n=== denoise-benchmark ===`);
  console.log(`Manifest: ${args.manifest}`);
  console.log(`Scenes  : ${scenes.length} (of ${manifest.scenes.length} total)`);
  if (manifest.note) console.log(`Note    : ${manifest.note}`);

  // Validate paths
  const { ok: pathsOk, missing: pathsMissing } = validateScenePaths(scenes);

  if (args.dryRun) {
    console.log('\n--- Dry-run: path validation ---');
    console.log(`  Paths found   : ${pathsOk}`);
    console.log(`  Paths missing : ${pathsMissing.length}`);
    if (pathsMissing.length > 0) {
      for (const p of pathsMissing) console.log(`    MISSING: ${p}`);
    } else {
      console.log('  All paths OK');
    }
    printModelCheck(modelCheck);
    printGateSummary(manifest, modelCheck);
    return;
  }

  // Full mode: build per-scene rows
  const rows = [];
  for (const scene of scenes) {
    rows.push(buildSceneRow(scene, args.withMetrics));
  }

  const summary = summarize(rows);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    manifest: args.manifest,
    sceneCount: scenes.length,
    summary,
    modelArtifact: modelCheck,
    releaseGates: buildGateReport(modelCheck),
    rows,
  };

  if (args.out) {
    writeFileSync(args.out, JSON.stringify(report, null, 2));
    console.log(`\nReport written: ${args.out}`);
  } else {
    console.log('\n--- Report ---');
    console.log(JSON.stringify(report, null, 2));
  }

  printModelCheck(modelCheck);
  printGateSummary(manifest, modelCheck);
}

// ─── Console helpers ──────────────────────────────────────────────────────────
function printModelCheck(modelCheck) {
  console.log('\n--- Model artifact ---');
  if (modelCheck.error) {
    console.log(`  ERROR: ${modelCheck.error}`);
    return;
  }
  const sizeKB = modelCheck.artifact_size_bytes != null
    ? `${(modelCheck.artifact_size_bytes / 1024).toFixed(1)} KB`
    : 'unknown';
  console.log(`  Path          : ${modelCheck.model_path}`);
  console.log(`  Size          : ${sizeKB} (max 8 MiB) ${modelCheck.artifact_size_ok ? 'OK' : 'FAIL'}`);
  console.log(`  Hash verified : ${modelCheck.hash_verified ? 'PASS' : 'FAIL'}`);
  if (!modelCheck.hash_verified && modelCheck.sha256_expected) {
    console.log(`    Expected: ${modelCheck.sha256_expected}`);
    console.log(`    Actual  : ${modelCheck.sha256_actual}`);
  }
}

function printGateSummary(manifest, modelCheck) {
  console.log('\n--- Release gate summary ---');
  const gateReport = buildGateReport(modelCheck);
  for (const [gate, status] of Object.entries(gateReport)) {
    const mark = status.status === 'PASS' ? 'PASS'
      : status.status === 'CODE_ENFORCED' ? 'CODE_ENFORCED'
      : status.status === 'MANUAL' ? 'manual (requires corpus/browser)'
      : 'FAIL';
    console.log(`  ${gate.padEnd(42)} ${mark}`);
  }
}

function buildGateReport(modelCheck) {
  const report = {};
  for (const [gate, enforcement] of Object.entries(RELEASE_GATES)) {
    if (gate === 'model_size_verified') {
      report[gate] = {
        status: modelCheck.model_size_verified && modelCheck.artifact_size_ok ? 'PASS' : 'FAIL',
        enforcement: 'runtime',
        detail: modelCheck.artifact_size_bytes != null
          ? `${(modelCheck.artifact_size_bytes / 1024).toFixed(1)} KB`
          : 'not_found',
      };
    } else if (gate === 'hash_verified') {
      report[gate] = {
        status: modelCheck.hash_verified ? 'PASS' : 'FAIL',
        enforcement: 'runtime',
        detail: modelCheck.hash_verified ? 'sha256_match' : 'mismatch_or_missing',
      };
    } else if (enforcement === 'manual') {
      report[gate] = { status: 'MANUAL', enforcement: 'manual' };
    } else {
      report[gate] = { status: 'CODE_ENFORCED', enforcement };
    }
  }
  return report;
}

main().catch((e) => {
  console.error('denoise-benchmark error:', e.message);
  process.exit(1);
});
