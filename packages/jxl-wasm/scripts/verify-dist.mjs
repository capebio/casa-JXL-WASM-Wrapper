#!/usr/bin/env node
/**
 * verify-dist.mjs
 *
 * Verify jxl-wasm distribution artifacts before publication or use.
 * Finding 23 (P0): bind distribution artifacts to complete provenance.
 *
 * USAGE (CLI — invoked by release/CI):
 *   node scripts/verify-dist.mjs [--manifest <path>] [--dist <dir>] [--release]
 *
 *   --manifest  Path to build-manifest.json (default: dist/build-manifest.json)
 *   --dist      Directory containing jxl-core.*.{js,wasm} artifacts
 *                (default: dist/)
 *   --release   Activate release-mode dirty-source guard
 *
 * EXPORTS (pure, no file I/O — consumable by tests and other scripts):
 *   verifyManifest(manifest, artifacts, options?) → VerifyManifestResult
 *
 * ALGORITHM
 * ─────────
 * For each tier key in manifest.tiers:
 *  1. Verify the JS artifact:
 *     a. artifact data must be supplied
 *     b. SHA-256 must match manifest entry jsSha256
 *     c. SHA-384 SRI must match manifest entry jsIntegrity
 *  2. Verify the WASM artifact (same checks against wasmSha256/wasmIntegrity).
 *  3. Verify the tier entry carries a complete provenance object (validateProvenance).
 *
 * A tier entry that passes all checks is "clean". Any error is collected and
 * returned in result.errors; result.ok is true only when errors is empty.
 *
 * pgo: if the manifest carries a top-level pgo object, it is reflected in
 * result.pgo so callers (packet 5 T5 PGO) can read pgo.applied.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateProvenance } from "./provenance.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Types (JSDoc)
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   ok: boolean;
 *   errors: string[];
 *   pgo?: { profileDigest: string; applied: boolean } | undefined;
 * }} VerifyManifestResult
 */

// ---------------------------------------------------------------------------
// Pure verifier — no file I/O
// ---------------------------------------------------------------------------

/**
 * Verify that every tier entry in the manifest matches its supplied artifact data.
 *
 * artifacts is a Map<string, Uint8Array> keyed by "<tierKey>:js" and "<tierKey>:wasm"
 * (e.g. "enc:simd:js", "enc:simd:wasm").
 *
 * @param {object} manifest  Parsed build-manifest.json object
 * @param {Map<string, Uint8Array>} artifacts  In-memory artifact bytes
 * @param {{ releaseMode?: boolean }} [options]
 * @returns {VerifyManifestResult}
 */
export function verifyManifest(manifest, artifacts, options = {}) {
  const releaseMode = options.releaseMode ?? false;
  const errors = [];

  const tiers = manifest.tiers ?? {};

  for (const [tierKey, entry] of Object.entries(tiers)) {
    // --- provenance completeness ---
    if (!entry.provenance) {
      errors.push(`${tierKey}: missing provenance object (legacy entry — rebuild required)`);
    } else {
      try {
        validateProvenance(entry.provenance, { releaseMode });
      } catch (e) {
        errors.push(`${tierKey}: invalid provenance — ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // --- JS artifact ---
    const jsKey = `${tierKey}:js`;
    const jsData = artifacts.get(jsKey);
    if (!jsData) {
      errors.push(`${tierKey}: JS artifact data missing (key="${jsKey}")`);
    } else {
      const actualJsSha256 = createHash("sha256").update(jsData).digest("hex");
      if (actualJsSha256 !== entry.jsSha256) {
        errors.push(
          `${tierKey}: jsSha256 mismatch — manifest=${entry.jsSha256} actual=${actualJsSha256}`
        );
      }
      const actualJsIntegrity = `sha384-${createHash("sha384").update(jsData).digest("base64")}`;
      if (actualJsIntegrity !== entry.jsIntegrity) {
        errors.push(
          `${tierKey}: jsIntegrity (SRI) mismatch — manifest=${entry.jsIntegrity} actual=${actualJsIntegrity}`
        );
      }
    }

    // --- WASM artifact ---
    const wasmKey = `${tierKey}:wasm`;
    const wasmData = artifacts.get(wasmKey);
    if (!wasmData) {
      errors.push(`${tierKey}: WASM artifact data missing (key="${wasmKey}")`);
    } else {
      const actualWasmSha256 = createHash("sha256").update(wasmData).digest("hex");
      if (actualWasmSha256 !== entry.wasmSha256) {
        errors.push(
          `${tierKey}: wasmSha256 mismatch — manifest=${entry.wasmSha256} actual=${actualWasmSha256}`
        );
      }
      const actualWasmIntegrity = `sha384-${createHash("sha384").update(wasmData).digest("base64")}`;
      if (actualWasmIntegrity !== entry.wasmIntegrity) {
        errors.push(
          `${tierKey}: wasmIntegrity (SRI) mismatch — manifest=${entry.wasmIntegrity} actual=${actualWasmIntegrity}`
        );
      }
    }
  }

  // Reflect top-level pgo info for packet 5 T5 PGO consumption.
  // Field names align with the BuildProvenance contract: pgo.profileDigest + pgo.applied.
  let pgo;
  if (manifest.pgo) {
    const raw = manifest.pgo;
    // Support both the manifest's staged lock shape (corpusHash) and the
    // BuildProvenance contract shape (profileDigest). Normalize to contract shape.
    pgo = {
      profileDigest: raw.profileDigest ?? raw.corpusHash ?? "",
      applied: raw.applied ?? false,
    };
  }

  return {
    ok: errors.length === 0,
    errors,
    ...(pgo !== undefined ? { pgo } : {}),
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function loadArtifacts(distDir, tierKeys) {
  const artifacts = new Map();
  for (const tierKey of tierKeys) {
    // tierKey is e.g. "enc:simd" → files are jxl-core.enc.simd.js / .wasm
    const [kind, ...tierParts] = tierKey.split(":");
    const tierName = tierParts.join(":");
    const base = `jxl-core.${kind}.${tierName}`;
    for (const ext of ["js", "wasm"]) {
      const filePath = join(distDir, `${base}.${ext}`);
      try {
        const data = await readFile(filePath);
        artifacts.set(`${tierKey}:${ext}`, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      } catch (err) {
        // Missing artifact — verifyManifest will report it
        // Don't add to map; the verifier checks presence
      }
    }
  }
  return artifacts;
}

async function main() {
  const args = process.argv.slice(2);

  let manifestPath = join(packageRoot, "dist", "build-manifest.json");
  let distDir = join(packageRoot, "dist");
  let releaseMode = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--manifest" && args[i + 1]) {
      manifestPath = resolve(args[++i]);
    } else if (args[i] === "--dist" && args[i + 1]) {
      distDir = resolve(args[++i]);
    } else if (args[i] === "--release") {
      releaseMode = true;
    }
  }

  let manifest;
  try {
    const text = await readFile(manifestPath, "utf8");
    manifest = JSON.parse(text);
  } catch (err) {
    console.error(`[verify-dist] Cannot read manifest at ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const tierKeys = Object.keys(manifest.tiers ?? {});
  if (tierKeys.length === 0) {
    console.error("[verify-dist] Manifest has no tier entries.");
    process.exitCode = 1;
    return;
  }

  const artifacts = await loadArtifacts(distDir, tierKeys);
  const result = verifyManifest(manifest, artifacts, { releaseMode });

  if (result.ok) {
    console.log(`[verify-dist] OK — ${tierKeys.length} tier(s) verified.`);
    if (result.pgo) {
      console.log(`[verify-dist] PGO: applied=${result.pgo.applied} profileDigest=${result.pgo.profileDigest}`);
    }
    process.exitCode = 0;
  } else {
    console.error(`[verify-dist] FAILED — ${result.errors.length} error(s):`);
    for (const e of result.errors) {
      console.error(`  • ${e}`);
    }
    process.exitCode = 1;
  }
}

// Run CLI only when invoked directly
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
}
