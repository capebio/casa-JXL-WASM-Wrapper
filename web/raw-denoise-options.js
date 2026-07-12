// Noise-aware RAW denoise UI options.
//
// A single canonical `denoise` option object travels from the browser controls
// (readDenoiseOptions) through main.js's currentOptions() into the worker, which
// forwards it to the WASM *_with_options RAW decoders. This module owns the shape,
// the validation, and the "did anything change enough to re-decode?" comparison.
//
// Canonical shape (what normalizeDenoiseOptions always returns):
//   { enabled: boolean,
//     activation: 'auto' | 'iso' | 'always',
//     isoThreshold: 200|400|800|1600|3200|6400,   // only consulted when activation==='iso'
//     noiseThreshold: number,                      // derived from the sensitivity UI
//     strength: number }                           // 0..N; UI default 1.0
//
// The UI exposes a "sensitivity" select (high/normal/low) rather than a raw
// noiseThreshold number; the mapping lives here so both the DOM reader and any
// programmatic caller agree. `sensitivity` is an INPUT alias — it is validated and
// mapped to noiseThreshold, then dropped from the canonical output.

// Sensitivity UI value → noiseThreshold (a smaller threshold denoises more).
const SENSITIVITY_MAP = { high: 1.0, normal: 1.5, low: 2.0 };
const VALID_ACTIVATIONS = new Set(['auto', 'iso', 'always']);
const VALID_ISO_PRESETS = new Set([200, 400, 800, 1600, 3200, 6400]);
const DEFAULTS = Object.freeze({
  enabled: false,
  activation: 'auto',
  isoThreshold: 1600,
  noiseThreshold: 1.5,
  strength: 1.0,
});

// Fields compared by denoiseNeedsReprocess. `enabled` always matters; the rest
// only matter while denoise is enabled (a change to isoThreshold while denoise is
// off must NOT trigger a re-decode).
const COMPARED_FIELDS = ['activation', 'isoThreshold', 'noiseThreshold', 'strength'];

// Keys accepted on the INPUT object (before normalization). `sensitivity` is an
// alias for noiseThreshold; the rest map 1:1 to the canonical shape.
const ACCEPTED_INPUT_KEYS = new Set([
  'enabled', 'activation', 'isoThreshold', 'noiseThreshold', 'strength', 'sensitivity',
]);

/**
 * Validate and canonicalize a partial denoise-options object.
 * Throws on unknown keys or invalid enum values (strict validation).
 * @param {object|null|undefined} value
 * @returns {{enabled:boolean, activation:string, isoThreshold:number, noiseThreshold:number, strength:number}}
 */
export function normalizeDenoiseOptions(value) {
  if (value == null) return { ...DEFAULTS };
  if (typeof value !== 'object') {
    throw new TypeError(`denoise options must be an object, got ${typeof value}`);
  }

  for (const key of Object.keys(value)) {
    if (!ACCEPTED_INPUT_KEYS.has(key)) {
      throw new Error(`Unknown denoise option key: "${key}"`);
    }
  }

  const out = { ...DEFAULTS };

  if ('enabled' in value) out.enabled = Boolean(value.enabled);

  if ('activation' in value) {
    const a = value.activation;
    if (!VALID_ACTIVATIONS.has(a)) {
      throw new Error(`Invalid denoise activation: ${JSON.stringify(a)} (expected auto|iso|always)`);
    }
    out.activation = a;
  }

  if ('isoThreshold' in value) {
    const iso = Number(value.isoThreshold);
    if (!VALID_ISO_PRESETS.has(iso)) {
      throw new Error(`Invalid denoise ISO threshold: ${JSON.stringify(value.isoThreshold)} ` +
        `(expected one of ${[...VALID_ISO_PRESETS].join(', ')})`);
    }
    out.isoThreshold = iso;
  }

  // sensitivity is an alias that maps to noiseThreshold; an explicit noiseThreshold
  // (if both are given) is applied after and wins.
  if ('sensitivity' in value) {
    const s = value.sensitivity;
    if (!(s in SENSITIVITY_MAP)) {
      throw new Error(`Invalid denoise sensitivity: ${JSON.stringify(s)} (expected high|normal|low)`);
    }
    out.noiseThreshold = SENSITIVITY_MAP[s];
  }

  if ('noiseThreshold' in value) {
    const n = Number(value.noiseThreshold);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`Invalid denoise noiseThreshold: ${JSON.stringify(value.noiseThreshold)}`);
    }
    out.noiseThreshold = n;
  }

  if ('strength' in value) {
    const st = Number(value.strength);
    if (!Number.isFinite(st) || st < 0) {
      throw new Error(`Invalid denoise strength: ${JSON.stringify(value.strength)}`);
    }
    out.strength = st;
  }

  return out;
}

/**
 * Read the denoise controls from a DOM root (document or a sub-tree).
 * Missing controls fall back to the canonical defaults.
 * @param {ParentNode} root
 */
export function readDenoiseOptions(root) {
  const q = (sel) => (root && root.querySelector ? root.querySelector(sel) : null);
  const enabledEl = q('#denoise-enabled');
  const activationEl = q('#denoise-activation');
  const isoEl = q('#denoise-iso-threshold');
  const sensEl = q('#denoise-sensitivity');

  const input = {};
  if (enabledEl) input.enabled = Boolean(enabledEl.checked);
  if (activationEl && activationEl.value) input.activation = activationEl.value;
  if (isoEl && isoEl.value) input.isoThreshold = isoEl.value;
  if (sensEl && sensEl.value) input.sensitivity = sensEl.value;

  return normalizeDenoiseOptions(input);
}

/**
 * Does a change from `a` to `b` require a full RAW re-decode?
 * null/undefined is treated as the default (denoise off). When BOTH are disabled,
 * no downstream field matters, so this returns false regardless of the other
 * fields. Otherwise any differing compared field (or the enabled flag) → true.
 */
export function denoiseNeedsReprocess(a, b) {
  const na = normalizeDenoiseOptions(a);
  const nb = normalizeDenoiseOptions(b);
  if (na.enabled !== nb.enabled) return true;
  // Both disabled → nothing downstream is consulted, so no re-decode.
  if (!na.enabled && !nb.enabled) return false;
  for (const f of COMPARED_FIELDS) {
    if (na[f] !== nb[f]) return true;
  }
  return false;
}
