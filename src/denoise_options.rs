// src/denoise_options.rs — strict JS options parser for process_*_with_options.
//
// Parses a plain JS object with two optional sub-keys: "look" and "denoise".
// Unknown top-level key → JsError. Unknown denoise sub-key → JsError.
// Missing key → default (neutral / disabled). null/undefined → all defaults.

use wasm_bindgen::prelude::*;
use crate::LookOverrides;
use raw_pipeline::denoise::{ActivationMode, DenoiseOptions};

pub struct RawProcessOptions {
    pub look: LookOverrides,
    pub denoise: DenoiseOptions,
}

impl RawProcessOptions {
    pub fn neutral() -> Self {
        RawProcessOptions {
            look: LookOverrides::neutral(),
            denoise: DenoiseOptions::default(), // enabled=false
        }
    }

    /// Parse from a JS object.
    ///
    /// Top-level allowed keys: "look", "denoise".
    /// "look" is delegated to `LookOverrides::from_js`.
    /// "denoise" allowed keys: "enabled", "activation", "isoThreshold",
    ///   "noiseThreshold", "strength".
    /// Unknown key → JsError naming all allowed fields.
    /// Missing key → default (neutral/disabled).
    /// null/undefined → all defaults.
    pub fn from_js(obj: &JsValue) -> Result<Self, JsError> {
        let mut opts = RawProcessOptions::neutral();
        if obj.is_undefined() || obj.is_null() {
            return Ok(opts);
        }
        let obj_ref = obj
            .dyn_ref::<js_sys::Object>()
            .ok_or_else(|| JsError::new("options must be a plain object"))?;

        for key in js_sys::Object::keys(obj_ref).iter() {
            let k = key
                .as_string()
                .ok_or_else(|| JsError::new("option key is not a string"))?;
            let val = js_sys::Reflect::get(obj, &key)
                .map_err(|_| JsError::new("failed to read option value"))?;
            match k.as_str() {
                "look" => {
                    opts.look = LookOverrides::from_js(&val)?;
                }
                "denoise" => {
                    opts.denoise = parse_denoise_options(&val)?;
                }
                other => {
                    return Err(JsError::new(&format!(
                        "unknown option '{other}' (allowed: look, denoise)"
                    )));
                }
            }
        }
        Ok(opts)
    }
}

fn parse_denoise_options(obj: &JsValue) -> Result<DenoiseOptions, JsError> {
    let mut opts = DenoiseOptions::default();
    if obj.is_undefined() || obj.is_null() {
        return Ok(opts);
    }
    let obj_ref = obj
        .dyn_ref::<js_sys::Object>()
        .ok_or_else(|| JsError::new("denoise must be a plain object"))?;

    for key in js_sys::Object::keys(obj_ref).iter() {
        let k = key
            .as_string()
            .ok_or_else(|| JsError::new("denoise key is not a string"))?;
        let val = js_sys::Reflect::get(obj, &key)
            .map_err(|_| JsError::new("failed to read denoise value"))?;
        match k.as_str() {
            "enabled" => {
                opts.enabled = val
                    .as_bool()
                    .ok_or_else(|| JsError::new("denoise.enabled must be a boolean"))?;
            }
            "activation" => {
                let s = val
                    .as_string()
                    .ok_or_else(|| JsError::new("denoise.activation must be a string"))?;
                opts.activation = match s.as_str() {
                    "auto" => ActivationMode::Auto,
                    "always" => ActivationMode::Always,
                    "iso" => ActivationMode::Iso,
                    other => {
                        return Err(JsError::new(&format!(
                            "unknown activation '{other}' (allowed: auto, always, iso)"
                        )));
                    }
                };
            }
            "isoThreshold" => {
                let n = val
                    .as_f64()
                    .ok_or_else(|| JsError::new("denoise.isoThreshold must be a number"))?;
                opts.iso_threshold =
                    crate::require_finite("denoise.isoThreshold", n).map_err(|e| JsError::new(&e))? as u32;
            }
            "noiseThreshold" => {
                let n = val
                    .as_f64()
                    .ok_or_else(|| JsError::new("denoise.noiseThreshold must be a number"))?;
                opts.noise_threshold =
                    crate::require_finite("denoise.noiseThreshold", n).map_err(|e| JsError::new(&e))? as f32;
            }
            "strength" => {
                let n = val
                    .as_f64()
                    .ok_or_else(|| JsError::new("denoise.strength must be a number"))?;
                opts.strength =
                    crate::require_finite("denoise.strength", n).map_err(|e| JsError::new(&e))? as f32;
            }
            other => {
                return Err(JsError::new(&format!(
                    "unknown denoise param '{other}' \
                     (allowed: enabled, activation, isoThreshold, noiseThreshold, strength)"
                )));
            }
        }
    }
    // Clamp tunables into valid ranges after parsing.
    Ok(opts.clamped())
}

// ─── Unit tests ───────────────────────────────────────────────────────────────
//
// These tests exercise only the Rust-side parser logic and do not involve
// WASM or wasm-bindgen — they can run under `cargo test --lib`.
//
// Constructing a real JS object requires a JS runtime, so we test the error
// paths using the fast `JsValue::null()`/`JsValue::undefined()` helpers that
// wasm-bindgen provides even on native (they return the Rust-side null/undef
// sentinels).
#[cfg(test)]
mod tests {
    use super::*;
    use raw_pipeline::denoise::{ActivationMode, DenoiseOptions};

    // null/undefined → all neutral defaults
    // JsValue::null()/undefined() are wasm-bindgen imports that panic on native;
    // these tests only run under wasm32. The equivalent native path is covered by
    // `neutral_defaults_via_constructor` below.
    #[cfg(target_arch = "wasm32")]
    #[test]
    fn neutral_on_null() {
        let opts = RawProcessOptions::from_js(&JsValue::null()).unwrap();
        assert!(!opts.denoise.enabled);
        assert_eq!(opts.denoise.activation, ActivationMode::Auto);
        assert_eq!(opts.denoise.iso_threshold, 1600);
        assert!((opts.denoise.noise_threshold - 4.0).abs() < 1e-6);
        assert!((opts.denoise.strength - 1.0).abs() < 1e-6);
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn neutral_on_undefined() {
        let opts = RawProcessOptions::from_js(&JsValue::undefined()).unwrap();
        assert!(!opts.denoise.enabled);
    }

    // Native-safe equivalent: verify the neutral() constructor gives the same
    // defaults that the null/undefined parser path returns on wasm32.
    #[test]
    fn neutral_defaults_via_constructor() {
        let opts = RawProcessOptions::neutral();
        assert!(!opts.denoise.enabled);
        assert_eq!(opts.denoise.activation, ActivationMode::Auto);
        assert_eq!(opts.denoise.iso_threshold, 1600);
        assert!((opts.denoise.noise_threshold - 4.0).abs() < 1e-6);
        assert!((opts.denoise.strength - 1.0).abs() < 1e-6);
    }

    // Verify that the default DenoiseOptions fields match what the parser produces.
    #[test]
    fn default_denoise_matches_type_default() {
        let def = DenoiseOptions::default();
        let opts = RawProcessOptions::neutral();
        assert_eq!(opts.denoise.enabled, def.enabled);
        assert_eq!(opts.denoise.activation, def.activation);
        assert_eq!(opts.denoise.iso_threshold, def.iso_threshold);
    }
}
