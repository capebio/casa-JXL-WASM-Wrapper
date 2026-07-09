// Browser machine profile: capability signature + persisted worker/thread split,
// stored in localStorage and applied via a global the pool sizing reads. The analogue
// of crates/raw-pipeline/src/calibration/profile.rs for the web runtime.

export const SCHEMA_VERSION = 1;
const STORAGE_KEY = "rawpipe.calibration.v1";
/** Where applied selections live so main.js / worker.js can read them. */
export const GLOBAL_KEY = "__rawCalibration";

/** Capability signature — what makes two browser environments interchangeable. */
export function detectSignature() {
  const g = /** @type {any} */ (globalThis);
  const hc =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  const sab = typeof g.SharedArrayBuffer !== "undefined";
  const coi = typeof g.crossOriginIsolated === "undefined" ? false : g.crossOriginIsolated === true;
  const worker = typeof g.Worker !== "undefined";
  const wasm = typeof g.WebAssembly !== "undefined";
  return { hardwareConcurrency: hc, sab, coi, worker, wasm };
}

/** True when threaded WASM (SharedArrayBuffer + COI + Worker) is usable. */
export function threadsAvailable(sig = detectSignature()) {
  return sig.sab && sig.coi && sig.worker;
}

export function signatureKey(sig = detectSignature()) {
  return `hc${sig.hardwareConcurrency}-${sig.coi ? "coi" : "noco"}-${sig.sab ? "sab" : "nosab"}`;
}

/** Build a profile object (pure). */
export function makeProfile(selections, generatedMs = 0, measurements = null) {
  return {
    schemaVersion: SCHEMA_VERSION,
    signature: detectSignature(),
    generatedMs,
    selections, // { workers, threadsPerWorker, tier }
    measurements,
  };
}

export function matchesCurrent(profile, sig = detectSignature()) {
  return (
    !!profile &&
    profile.schemaVersion === SCHEMA_VERSION &&
    signatureKey(profile.signature) === signatureKey(sig)
  );
}

function storage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null; // access can throw in sandboxed/blocked contexts
  }
}

/** Persist a profile as JSON. No-op (returns false) when storage is unavailable. */
export function save(profile) {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(profile));
    return true;
  } catch {
    return false;
  }
}

/** Load a profile, or null if missing / unparseable / stale schema. */
export function load() {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p.schemaVersion !== SCHEMA_VERSION) return null;
    return p;
  } catch {
    return null;
  }
}

/**
 * Install a profile's selections as a global the pool sizing reads — but only if it
 * matches the current environment. Returns whether applied.
 */
export function apply(profile) {
  if (!matchesCurrent(profile)) return false;
  /** @type {any} */ (globalThis)[GLOBAL_KEY] = { ...profile.selections };
  return true;
}

/** The applied selections, or null. Read by main.js/worker.js with a fallback. */
export function applied() {
  return /** @type {any} */ (globalThis)[GLOBAL_KEY] || null;
}

export function clearApplied() {
  delete /** @type {any} */ (globalThis)[GLOBAL_KEY];
}
