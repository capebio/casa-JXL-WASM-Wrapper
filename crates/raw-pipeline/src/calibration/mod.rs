//! One-time, per-machine hardware calibration foundation.
//!
//! Pure + additive: this module only *introspects* the engine's hardware-dependent
//! pathways and generates a deterministic test corpus. It does NOT change any
//! shipped encode/decode selection. See
//! `docs/2026-07-08-hardware-adaptive-calibration-design.md`.
//!
//! Compiles on native + wasm (like `mem_budget`); arch-specific probing is
//! cfg-gated inside `prober`.

pub mod fractal;
pub mod parity;
pub mod prober;
pub mod registry;
