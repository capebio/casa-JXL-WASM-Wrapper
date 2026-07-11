/**
 * provenance.mjs
 *
 * Computes and validates BuildProvenance for jxl-wasm distribution artifacts.
 * Finding 23 (P0): bind distribution artifacts to complete, structured provenance.
 *
 * DESIGN NOTES
 * ─────────────
 * • computeInputDigest hashes a STRUCTURED, NORMALIZED representation of all
 *   build inputs so that changing ANY named input changes the digest. Inputs:
 *     bridge source hash, exports hash, flags (order-sensitive; they are linker
 *     flags where order matters), libjxl commit + dirty, toolchain (sorted keys),
 *     role, tier, build-script hash, PGO profile digest.
 *
 * • Toolchain keys are sorted before serialisation so that insertion-order
 *   differences in the caller's object do not produce different digests.
 *
 * • flags are NOT sorted — linker flag order is semantically meaningful.
 *
 * • buildProvenanceKey encodes the full provenance identity (inputDigest +
 *   sourceCommit + libjxlCommit) into a single string used by the merge guard.
 *
 * • canMergePartialTier returns true only when both entries carry provenance
 *   and their provenance keys match exactly. Legacy entries (no provenance)
 *   are always rejected to prevent merging unaudited artifacts.
 *
 * • validateProvenance throws on any missing required field and on dirty
 *   source/libjxl in release mode.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types (JSDoc only — this is a .mjs file)
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   bridgeSourceHash: string;
 *   exportsHash: string;
 *   flags: string[];
 *   libjxlCommit: string;
 *   libjxlDirty: boolean;
 *   toolchain: Record<string, string>;
 *   role: string;
 *   tier: string;
 *   buildScriptHash: string;
 *   pgoProfileDigest?: string | undefined;
 * }} ProvenanceInputs
 */

/**
 * @typedef {{
 *   inputDigest: string;
 *   sourceCommit: string;
 *   sourceDirty: boolean;
 *   libjxlCommit: string;
 *   libjxlDirty: boolean;
 *   toolchain: Record<string, string>;
 *   role: "encode" | "decode" | "perceptual" | string;
 *   tier: string;
 *   flags: string[];
 *   pgo?: { profileDigest: string; applied: boolean } | undefined;
 * }} BuildProvenance
 */

/**
 * @typedef {{
 *   kind: string;
 *   tier: string;
 *   jsBytes: number;
 *   wasmBytes: number;
 *   jsSha256: string;
 *   wasmSha256: string;
 *   jsIntegrity: string;
 *   wasmIntegrity: string;
 *   flags: string[];
 *   provenance: BuildProvenance;
 *   [key: string]: unknown;
 * }} ManifestTierEntry
 */

// ---------------------------------------------------------------------------
// computeInputDigest
// ---------------------------------------------------------------------------

/**
 * Hash all build inputs that determine the artifact identity.
 *
 * Normalisation rules:
 *  - toolchain keys are sorted (ascending) before serialisation
 *  - flags are kept in original order (linker order is semantic)
 *  - pgoProfileDigest is included as-is (empty string when absent)
 *  - all fields are included explicitly; no `JSON.stringify(inputs)` shortcut
 *    (would be order-sensitive for object keys and include unexpected fields)
 *
 * @param {ProvenanceInputs} inputs
 * @returns {string} lowercase hex SHA-256
 */
export function computeInputDigest(inputs) {
  const hash = createHash("sha256");

  // Structured, stable serialisation — one field per line so diffs are clear.
  // Use a separator that cannot appear in the values to prevent collisions.
  const sep = "\x00";

  hash.update(`bridgeSourceHash${sep}${inputs.bridgeSourceHash}\n`);
  hash.update(`exportsHash${sep}${inputs.exportsHash}\n`);

  // flags: order-sensitive
  const flagsStr = inputs.flags.map((f, i) => `${i}:${f}`).join(",");
  hash.update(`flags${sep}${flagsStr}\n`);

  hash.update(`libjxlCommit${sep}${inputs.libjxlCommit}\n`);
  hash.update(`libjxlDirty${sep}${inputs.libjxlDirty ? "1" : "0"}\n`);

  // toolchain: sort keys for determinism
  const sortedToolchain = Object.keys(inputs.toolchain)
    .sort()
    .map((k) => `${k}=${inputs.toolchain[k]}`)
    .join(",");
  hash.update(`toolchain${sep}${sortedToolchain}\n`);

  hash.update(`role${sep}${inputs.role}\n`);
  hash.update(`tier${sep}${inputs.tier}\n`);
  hash.update(`buildScriptHash${sep}${inputs.buildScriptHash}\n`);
  hash.update(`pgoProfileDigest${sep}${inputs.pgoProfileDigest ?? ""}\n`);

  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// buildProvenanceKey
// ---------------------------------------------------------------------------

/**
 * Encode the full provenance identity into a single opaque key.
 * Used by canMergePartialTier to compare existing vs incoming tier entries.
 *
 * Covers: inputDigest + sourceCommit + libjxlCommit.
 * (role + tier are already part of the tier key in the manifest object.)
 *
 * @param {BuildProvenance} provenance
 * @returns {string}
 */
export function buildProvenanceKey(provenance) {
  return `${provenance.inputDigest}:${provenance.sourceCommit}:${provenance.libjxlCommit}`;
}

// ---------------------------------------------------------------------------
// canMergePartialTier
// ---------------------------------------------------------------------------

/**
 * Return true when an existing manifest tier entry can be safely merged with
 * an incoming (partial-build) tier entry.
 *
 * Rules:
 *  - Both entries MUST carry a provenance object.
 *  - Their buildProvenanceKey MUST match exactly.
 *
 * Legacy entries (no provenance) are always rejected to prevent merging
 * unaudited artifacts into a release.
 *
 * @param {ManifestTierEntry} existing
 * @param {ManifestTierEntry} incoming
 * @returns {boolean}
 */
export function canMergePartialTier(existing, incoming) {
  if (!existing?.provenance || !incoming?.provenance) return false;
  return buildProvenanceKey(existing.provenance) === buildProvenanceKey(incoming.provenance);
}

// ---------------------------------------------------------------------------
// validateProvenance
// ---------------------------------------------------------------------------

/**
 * Throw if any required provenance field is missing or if dirty source/libjxl
 * is present in release mode.
 *
 * @param {BuildProvenance} provenance
 * @param {{ releaseMode: boolean }} options
 * @throws {Error}
 */
export function validateProvenance(provenance, options) {
  const { releaseMode } = options;

  if (!provenance.inputDigest) {
    throw new Error("provenance.inputDigest is required but missing or empty");
  }
  if (!provenance.sourceCommit) {
    throw new Error("provenance.sourceCommit is required but missing or empty");
  }
  if (!provenance.libjxlCommit) {
    throw new Error("provenance.libjxlCommit is required but missing or empty");
  }
  if (!provenance.toolchain || Object.keys(provenance.toolchain).length === 0) {
    throw new Error("provenance.toolchain is required and must have at least one entry");
  }
  if (!provenance.role) {
    throw new Error("provenance.role is required but missing or empty");
  }
  if (!provenance.tier) {
    throw new Error("provenance.tier is required but missing or empty");
  }

  if (releaseMode) {
    if (provenance.sourceDirty) {
      throw new Error(
        "Release build rejected: sourceDirty=true. Commit or stash all changes before a release build, " +
          "or pass --non-release to record the dirtiness explicitly."
      );
    }
    if (provenance.libjxlDirty) {
      throw new Error(
        "Release build rejected: libjxlDirty=true. The libjxl working tree has uncommitted changes. " +
          "Commit or stash them before a release build, or pass --non-release."
      );
    }
  }
}
