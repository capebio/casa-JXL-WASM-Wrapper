# Hardware-Adaptive Calibration — Phase 1 + 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native, additive, zero-behaviour-change calibration foundation to `raw-pipeline`: a deterministic fractal test-image generator, an explicit pathway registry, an accessibility prober (incl. cgroup-aware core budget), a cross-backend parity gate, and a `routes` example that prints all of it.

**Architecture:** New `crates/raw-pipeline/src/calibration/` module, sibling to `mem_budget` (the precedent for a pure, native+wasm, additive module). Nothing in the shipped encode/decode path changes — this phase only *adds* introspection and a test corpus. Later phases (bench, profile store, orchestrator, runtime-selector hooks) build on this.

**Tech Stack:** Rust 2021, `raw-pipeline` crate. Reuses `perceptual::{Backend, detect_native, Comparer, Opts, BackendChoice}`. No new dependencies. cgroup reads are stdlib file reads (Linux only, cfg-gated).

**Scope boundary (overnight):** Phases 1–2 only. Does NOT touch `detect_native`/`detectTier`/thread-count call sites, does NOT write a profile, does NOT run timing benchmarks. Those are Phases 3–7 (supervised, because they touch shipped selectors).

**Reference spec:** `docs/2026-07-08-hardware-adaptive-calibration-design.md`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `crates/raw-pipeline/src/calibration/mod.rs` | Module root; re-exports; module docs |
| `crates/raw-pipeline/src/calibration/fractal.rs` | Deterministic escape-time fractal → RGBA8, presets, optional dither |
| `crates/raw-pipeline/src/calibration/registry.rs` | Declarative pathway catalog (`Pathway`, `native_registry()`) |
| `crates/raw-pipeline/src/calibration/prober.rs` | Accessibility probe + cgroup-aware `effective_core_budget()` |
| `crates/raw-pipeline/src/calibration/parity.rs` | Cross-backend bit-exact parity gate via `Comparer` |
| `crates/raw-pipeline/src/lib.rs` | Add `pub mod calibration;` |
| `crates/raw-pipeline/examples/routes.rs` | Prints registry + accessibility + parity summary |

**Test command (fast, skips jxl-ffi):**
`cargo test -p raw-pipeline --no-default-features --features parallel calibration`

**wasm compile gate (calibration must build on wasm32):**
`cargo build -p raw-pipeline --lib --target wasm32-unknown-unknown --no-default-features`

---

## Task 1: Scaffold calibration module

**Files:**
- Create: `crates/raw-pipeline/src/calibration/mod.rs`
- Modify: `crates/raw-pipeline/src/lib.rs` (module declarations block, near `pub mod mem_budget;`)

- [ ] **Step 1: Create the module root**

`crates/raw-pipeline/src/calibration/mod.rs`:
```rust
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
pub mod registry;
pub mod prober;

// The parity gate depends on the perceptual `Comparer`, which is present in every
// build, so it needs no extra gate.
pub mod parity;
```

- [ ] **Step 2: Wire it into the crate**

In `crates/raw-pipeline/src/lib.rs`, immediately after the `pub mod mem_budget;` block (the S3 pure native+wasm module), add:
```rust
// One-time hardware calibration foundation (registry / fractal corpus / prober /
// parity). Pure + additive; native + wasm. See docs/2026-07-08-hardware-adaptive-calibration-design.md.
pub mod calibration;
```

- [ ] **Step 3: Create empty submodule files so the crate compiles**

Create these three files with only a doc comment (filled by later tasks):
- `crates/raw-pipeline/src/calibration/fractal.rs` → `//! Deterministic fractal test-image generator.`
- `crates/raw-pipeline/src/calibration/registry.rs` → `//! Declarative catalog of hardware-dependent pathways.`
- `crates/raw-pipeline/src/calibration/prober.rs` → `//! Accessibility + core-budget probing.`
- `crates/raw-pipeline/src/calibration/parity.rs` → `//! Cross-backend parity gate.`

- [ ] **Step 4: Verify it compiles**

Run: `cargo build -p raw-pipeline --lib --no-default-features --features parallel`
Expected: builds clean (empty modules).

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/calibration crates/raw-pipeline/src/lib.rs
git commit -m "feat(calibration): scaffold calibration module (empty, additive)"
```

---

## Task 2: Fractal generator core (Mandelbrot + smooth colour)

**Files:**
- Modify: `crates/raw-pipeline/src/calibration/fractal.rs`

- [ ] **Step 1: Write the failing tests**

Append to `fractal.rs`:
```rust
use std::f64::consts::PI;

/// A fully-specified fractal render request. Deterministic: `render_rgba8` is a pure
/// function of these fields. No RNG anywhere (dither uses a positional integer hash).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FractalSpec {
    pub kind: Kind,
    pub width: usize,
    pub height: usize,
    /// Complex-plane centre.
    pub center_re: f64,
    pub center_im: f64,
    /// Half-height of the viewport in complex-plane units (zoom = smaller scale).
    pub scale: f64,
    pub max_iter: u32,
    /// Palette phase offset (radians) — lets presets differ in colour.
    pub palette_phase: f64,
    /// Seeded-hash entropy overlay for photo-like statistics in the encode bench.
    pub dither: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Mandelbrot,
    /// Julia set with parameter `c = (julia_re, julia_im)` carried in the spec's
    /// `center_*` fields reinterpreted as the constant (viewport is fixed at origin).
    Julia { c_re_milli: i64, c_im_milli: i64 },
    BurningShip,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn small_mandel() -> FractalSpec {
        FractalSpec {
            kind: Kind::Mandelbrot,
            width: 32,
            height: 24,
            center_re: -0.5,
            center_im: 0.0,
            scale: 1.25,
            max_iter: 128,
            palette_phase: 0.0,
            dither: false,
        }
    }

    #[test]
    fn output_length_is_rgba8() {
        let s = small_mandel();
        let px = s.render_rgba8();
        assert_eq!(px.len(), s.width * s.height * 4);
    }

    #[test]
    fn alpha_is_opaque_everywhere() {
        let px = small_mandel().render_rgba8();
        assert!(px.chunks_exact(4).all(|p| p[3] == 255));
    }

    #[test]
    fn deterministic_same_twice() {
        let s = small_mandel();
        assert_eq!(s.render_rgba8(), s.render_rgba8());
    }

    #[test]
    fn not_a_flat_image() {
        // A real fractal has many distinct colours, not one flat fill.
        let px = small_mandel().render_rgba8();
        let first = &px[0..3];
        assert!(
            px.chunks_exact(4).any(|p| &p[0..3] != first),
            "render is a flat fill — colouring is broken"
        );
    }

    #[test]
    fn in_set_point_is_dark() {
        // c = 0 (image centre for this spec) never escapes → "inside" colour, which we
        // define as black. Centre pixel index: (h/2)*w + (w/2).
        let s = small_mandel();
        let px = s.render_rgba8();
        let idx = ((s.height / 2) * s.width + s.width / 2) * 4;
        assert_eq!(&px[idx..idx + 3], &[0, 0, 0], "inside-set point should be black");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p raw-pipeline --no-default-features --features parallel calibration::fractal`
Expected: FAIL — `render_rgba8` not found.

- [ ] **Step 3: Implement the generator**

Insert before the `#[cfg(test)]` block in `fractal.rs`:
```rust
impl FractalSpec {
    /// Render to a packed RGBA8 buffer, row-major, `width*height*4` bytes. Pure and
    /// deterministic. Points that never escape within `max_iter` are painted black
    /// ("inside the set"); escaping points get a smooth continuous-iteration colour.
    pub fn render_rgba8(&self) -> Vec<u8> {
        let mut out = vec![0u8; self.width * self.height * 4];
        let aspect = self.width as f64 / self.height as f64;
        let half_h = self.scale;
        let half_w = self.scale * aspect;
        for py in 0..self.height {
            // Map pixel row → imaginary axis (top = +im).
            let t = (py as f64 + 0.5) / self.height as f64; // 0..1
            let im = self.center_im + (1.0 - 2.0 * t) * half_h;
            for px in 0..self.width {
                let s = (px as f64 + 0.5) / self.width as f64;
                let re = self.center_re + (2.0 * s - 1.0) * half_w;
                let smooth = self.escape(re, im);
                let idx = (py * self.width + px) * 4;
                let (r, g, b) = match smooth {
                    None => (0u8, 0u8, 0u8), // inside the set
                    Some(mu) => palette(mu, self.palette_phase),
                };
                let (r, g, b) = if self.dither {
                    dither_pixel(r, g, b, px, py)
                } else {
                    (r, g, b)
                };
                out[idx] = r;
                out[idx + 1] = g;
                out[idx + 2] = b;
                out[idx + 3] = 255;
            }
        }
        out
    }

    /// Returns `None` if the orbit never escapes (inside the set), else `Some(mu)`
    /// where `mu` is the smooth (fractional) iteration count.
    fn escape(&self, cx: f64, cy: f64) -> Option<f64> {
        // Starting point + per-iteration transform vary by kind.
        let (mut zx, mut zy, kx, ky) = match self.kind {
            Kind::Mandelbrot => (0.0, 0.0, cx, cy),
            Kind::BurningShip => (0.0, 0.0, cx, cy),
            Kind::Julia { c_re_milli, c_im_milli } => {
                (cx, cy, c_re_milli as f64 / 1000.0, c_im_milli as f64 / 1000.0)
            }
        };
        let bailout = 4.0_f64; // |z|^2 > 4 → escaped
        for i in 0..self.max_iter {
            let x2 = zx * zx;
            let y2 = zy * zy;
            if x2 + y2 > bailout {
                // Smooth iteration count: i + 1 - log2(log|z|).
                let log_zn = (x2 + y2).ln() * 0.5;
                let nu = (log_zn / std::f64::consts::LN_2).ln() / std::f64::consts::LN_2;
                return Some(i as f64 + 1.0 - nu);
            }
            match self.kind {
                Kind::BurningShip => {
                    zx = zx.abs();
                    zy = zy.abs();
                    let nzx = x2 - y2 + kx;
                    zy = 2.0 * zx * zy + ky;
                    zx = nzx;
                }
                _ => {
                    let nzx = x2 - y2 + kx;
                    zy = 2.0 * zx * zy + ky;
                    zx = nzx;
                }
            }
        }
        None
    }
}

/// Smooth-iteration → RGB via a phase-shifted sinusoid palette. Deterministic,
/// colourful, and continuous (no banding artefacts that would trivialise the codec).
fn palette(mu: f64, phase: f64) -> (u8, u8, u8) {
    let t = mu * 0.15 + phase;
    let r = (0.5 + 0.5 * (t).sin()) * 255.0;
    let g = (0.5 + 0.5 * (t + 2.0 * PI / 3.0).sin()) * 255.0;
    let b = (0.5 + 0.5 * (t + 4.0 * PI / 3.0).sin()) * 255.0;
    (r as u8, g as u8, b as u8)
}

/// Deterministic per-pixel dither: a positional integer hash mapped to ±small delta.
/// Raises entropy toward photographic statistics without any RNG.
fn dither_pixel(r: u8, g: u8, b: u8, px: usize, py: usize) -> (u8, u8, u8) {
    #[inline]
    fn h(x: u64) -> u64 {
        // splitmix64 finaliser — deterministic hash, no state.
        let mut z = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    let base = (px as u64) << 32 | py as u64;
    let d = |chan: u64| -> i32 { (h(base ^ (chan << 3)) & 0x7) as i32 - 3 }; // -3..+4
    let clamp = |v: i32| v.clamp(0, 255) as u8;
    (
        clamp(r as i32 + d(1)),
        clamp(g as i32 + d(2)),
        clamp(b as i32 + d(3)),
    )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p raw-pipeline --no-default-features --features parallel calibration::fractal`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/calibration/fractal.rs
git commit -m "feat(calibration): deterministic fractal generator (mandelbrot/julia/burning-ship + smooth palette + dither)"
```

---

## Task 3: Named presets (incl. mandelbrot-seahorse)

**Files:**
- Modify: `crates/raw-pipeline/src/calibration/fractal.rs`

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `fractal.rs`:
```rust
    #[test]
    fn all_presets_render_at_requested_size() {
        for id in DATASETS {
            let s = FractalSpec::preset(*id, 40, 30);
            let px = s.render_rgba8();
            assert_eq!(px.len(), 40 * 30 * 4, "{id:?} wrong size");
            let first = &px[0..3];
            assert!(
                px.chunks_exact(4).any(|p| &p[0..3] != first),
                "{id:?} rendered flat"
            );
        }
    }

    #[test]
    fn seahorse_is_high_detail() {
        // Seahorse valley: a deep-zoom slice with dense structure → many distinct
        // colours. Count unique RGB triples; require a healthy fraction.
        let px = FractalSpec::preset(Dataset::MandelbrotSeahorse, 64, 64).render_rgba8();
        let mut seen = std::collections::HashSet::new();
        for p in px.chunks_exact(4) {
            seen.insert([p[0], p[1], p[2]]);
        }
        assert!(seen.len() > 200, "seahorse too flat: {} colours", seen.len());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p raw-pipeline --no-default-features --features parallel calibration::fractal`
Expected: FAIL — `Dataset`, `DATASETS`, `preset` not found.

- [ ] **Step 3: Implement presets**

Add to `fractal.rs` (before `#[cfg(test)]`):
```rust
/// Named, fixed-parameter datasets. Sizes are chosen by the caller; the mathematical
/// viewport (centre/scale/iter) is pinned here so results are comparable everywhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dataset {
    /// Deep-zoom seahorse valley: dense high-frequency swirl. The headline visual.
    MandelbrotSeahorse,
    /// The whole set: mixed flat + detail.
    MandelbrotFull,
    /// Julia c = -0.8 + 0.156i.
    JuliaA,
    /// Julia c = 0.285 + 0.01i.
    JuliaB,
    /// Burning ship: sharp anisotropic edges.
    BurningShip,
}

/// Enumerates every dataset (for the registry, the routes report, and bench sweeps).
pub const DATASETS: &[Dataset] = &[
    Dataset::MandelbrotSeahorse,
    Dataset::MandelbrotFull,
    Dataset::JuliaA,
    Dataset::JuliaB,
    Dataset::BurningShip,
];

impl Dataset {
    pub fn label(self) -> &'static str {
        match self {
            Dataset::MandelbrotSeahorse => "mandelbrot-seahorse",
            Dataset::MandelbrotFull => "mandelbrot-full",
            Dataset::JuliaA => "julia-a",
            Dataset::JuliaB => "julia-b",
            Dataset::BurningShip => "burning-ship",
        }
    }
}

impl FractalSpec {
    /// Build the fixed-viewport spec for a named dataset at the requested pixel size.
    pub fn preset(id: Dataset, width: usize, height: usize) -> Self {
        let base = |kind, center_re, center_im, scale, max_iter, palette_phase| FractalSpec {
            kind,
            width,
            height,
            center_re,
            center_im,
            scale,
            max_iter,
            palette_phase,
            dither: false,
        };
        match id {
            // Seahorse valley on the Mandelbrot boundary, zoomed in tight.
            Dataset::MandelbrotSeahorse => base(
                Kind::Mandelbrot,
                -0.743_643_887_037,
                0.131_825_904_205,
                0.005,
                512,
                0.0,
            ),
            Dataset::MandelbrotFull => base(Kind::Mandelbrot, -0.5, 0.0, 1.25, 256, 1.0),
            Dataset::JuliaA => base(
                Kind::Julia { c_re_milli: -800, c_im_milli: 156 },
                0.0,
                0.0,
                1.5,
                256,
                2.0,
            ),
            Dataset::JuliaB => base(
                Kind::Julia { c_re_milli: 285, c_im_milli: 10 },
                0.0,
                0.0,
                1.5,
                256,
                3.0,
            ),
            Dataset::BurningShip => base(Kind::BurningShip, -0.5, -0.5, 0.6, 256, 4.0),
        }
    }

    /// Convenience: this spec with dither enabled (photo-like entropy for the encode bench).
    pub fn dithered(mut self) -> Self {
        self.dither = true;
        self
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p raw-pipeline --no-default-features --features parallel calibration::fractal`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/calibration/fractal.rs
git commit -m "feat(calibration): named fractal presets incl. mandelbrot-seahorse"
```

---

## Task 4: Pathway registry (declarative catalog)

**Files:**
- Modify: `crates/raw-pipeline/src/calibration/registry.rs`

- [ ] **Step 1: Write the failing tests**

Append to `registry.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_non_empty_and_well_formed() {
        let r = native_registry();
        assert!(!r.is_empty());
        for p in &r {
            assert!(!p.id.is_empty(), "pathway id empty");
            assert!(!p.variants.is_empty(), "{} has no variants", p.id);
            assert!(!p.selector_site.is_empty(), "{} has no selector site", p.id);
        }
    }

    #[test]
    fn ids_are_unique() {
        let r = native_registry();
        let mut ids: Vec<&str> = r.iter().map(|p| p.id).collect();
        ids.sort_unstable();
        let n = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), n, "duplicate pathway ids");
    }

    #[test]
    fn covers_simd_backend_axis() {
        let r = native_registry();
        assert!(
            r.iter().any(|p| p.axis == Axis::SimdBackend),
            "no SIMD-backend pathway in registry"
        );
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p raw-pipeline --no-default-features --features parallel calibration::registry`
Expected: FAIL — `native_registry`, `Axis` not found.

- [ ] **Step 3: Implement the registry**

Insert before `#[cfg(test)]` in `registry.rs`:
```rust
/// The throughput dimension a pathway moves. Quality/size axes are intentionally
/// absent — this calibration tunes only hardware-sensitive throughput.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    /// Which SIMD kernel implementation runs (scalar / AVX2 / AVX-512 / wasm-v128).
    SimdBackend,
    /// Thread / worker concurrency.
    Concurrency,
    /// Which WASM build tier loads (browser).
    WasmTier,
}

/// Where a pathway is reachable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Env {
    Native,
    Browser,
    Both,
}

/// One tunable, hardware-dependent route through the engine. Data only — the
/// declarative "map" the design calls for. Consumed by the prober (accessibility),
/// the routes report (human view), and later the bench harness.
#[derive(Clone, Copy, Debug)]
pub struct Pathway {
    /// Stable key, e.g. `native.backend.xyb`.
    pub id: &'static str,
    pub description: &'static str,
    /// The mutually-exclusive implementations to choose among.
    pub variants: &'static [&'static str],
    /// Where the runtime currently selects, as `file:line`.
    pub selector_site: &'static str,
    pub axis: Axis,
    pub env: Env,
}

/// The native (server-primary) catalog. Kept in sync with the design's §5 table.
pub fn native_registry() -> Vec<Pathway> {
    vec![
        Pathway {
            id: "native.backend.perceptual",
            description: "Perceptual SIMD kernels (xyb/blur/ssim/psnr/downsample)",
            variants: &["scalar", "avx2-strict", "avx2-rsqrt", "avx512-strict", "avx512-rsqrt"],
            selector_site: "perceptual/simd/mod.rs:38 (detect_native) / perceptual/mod.rs:644 (resolve_backend)",
            axis: Axis::SimdBackend,
            env: Env::Native,
        },
        Pathway {
            id: "native.telemetry.analyze",
            description: "Frame-stats + histogram (analyze_fused)",
            variants: &["scalar", "avx2"],
            selector_site: "perceptual/telemetry.rs:314 (analyze_fused)",
            axis: Axis::SimdBackend,
            env: Env::Native,
        },
        Pathway {
            id: "native.tone.bulk",
            description: "Tone matrix multiply (apply_tone_bulk)",
            variants: &["scalar", "avx2-fma"],
            selector_site: "tone_simd.rs:95 (apply_tone_bulk)",
            axis: Axis::SimdBackend,
            env: Env::Native,
        },
        Pathway {
            id: "native.decode.threads",
            description: "JXL decode threading (Decoder::with_threads)",
            variants: &["single-thread", "rayon-N"],
            selector_site: "jxl_casadecoder.rs:321 (with_threads)",
            axis: Axis::Concurrency,
            env: Env::Native,
        },
        Pathway {
            id: "native.encode.threads",
            description: "JXL encode threading (Encoder::with_threads)",
            variants: &["single-thread", "rayon-N"],
            selector_site: "jxl_casaencoder.rs:453 (with_threads)",
            axis: Axis::Concurrency,
            env: Env::Native,
        },
        Pathway {
            id: "native.casv.enc.threads",
            description: "CASV streaming encode threads (CASV_ENC_THREADS)",
            variants: &["available_parallelism", "env-override-N"],
            selector_site: "casa_video.rs:833 (CASV_ENC_THREADS)",
            axis: Axis::Concurrency,
            env: Env::Native,
        },
    ]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p raw-pipeline --no-default-features --features parallel calibration::registry`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/calibration/registry.rs
git commit -m "feat(calibration): declarative pathway registry (native routes catalog)"
```

---

## Task 5: cgroup-aware effective core budget

**Files:**
- Modify: `crates/raw-pipeline/src/calibration/prober.rs`

- [ ] **Step 1: Write the failing tests**

Append to `prober.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_budget_is_at_least_one() {
        assert!(effective_core_budget() >= 1);
    }

    #[test]
    fn parse_cgroup_v2_quota() {
        // "max 100000" = unlimited → None; "200000 100000" = 2 cores.
        assert_eq!(parse_cpu_max("max 100000"), None);
        assert_eq!(parse_cpu_max("200000 100000"), Some(2));
        // Round up a fractional quota (1.5 cores → 2 so we never under-provision the pool).
        assert_eq!(parse_cpu_max("150000 100000"), Some(2));
        assert_eq!(parse_cpu_max("50000 100000"), Some(1)); // never zero
        assert_eq!(parse_cpu_max("garbage"), None);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p raw-pipeline --no-default-features --features parallel calibration::prober`
Expected: FAIL — `effective_core_budget`, `parse_cpu_max` not found.

- [ ] **Step 3: Implement**

Insert before `#[cfg(test)]` in `prober.rs`:
```rust
/// The number of CPUs the process may actually use — the effective concurrency
/// ceiling. `available_parallelism()` already honours OS affinity/quota on modern
/// platforms, but Linux cgroup v2 CPU *bandwidth* limits (common in containers) are
/// NOT reflected in it, so we additionally clamp to the cgroup quota. This is the
/// single most important server-correctness value: thread pools must never exceed it.
pub fn effective_core_budget() -> usize {
    let logical = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    #[cfg(target_os = "linux")]
    {
        if let Some(quota) = cgroup_cpu_quota() {
            return logical.min(quota).max(1);
        }
    }
    logical.max(1)
}

/// Parse a cgroup v2 `cpu.max` line ("<quota> <period>" or "max <period>") into a
/// whole-core count. Fractional quotas round UP (never under-provision). `None` when
/// unlimited or unparseable.
#[cfg(target_os = "linux")]
fn parse_cpu_max(s: &str) -> Option<usize> {
    let mut it = s.split_whitespace();
    let quota = it.next()?;
    let period: f64 = it.next()?.parse().ok()?;
    if quota == "max" || period <= 0.0 {
        return None;
    }
    let quota: f64 = quota.parse().ok()?;
    let cores = (quota / period).ceil() as usize;
    Some(cores.max(1))
}

/// Read cgroup v2 (`/sys/fs/cgroup/cpu.max`), falling back to v1
/// (`cpu.cfs_quota_us` / `cpu.cfs_period_us`). `None` when no limit is set.
#[cfg(target_os = "linux")]
fn cgroup_cpu_quota() -> Option<usize> {
    use std::fs::read_to_string;
    if let Ok(v2) = read_to_string("/sys/fs/cgroup/cpu.max") {
        return parse_cpu_max(v2.trim());
    }
    let quota: i64 = read_to_string("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")
        .ok()?
        .trim()
        .parse()
        .ok()?;
    let period: i64 = read_to_string("/sys/fs/cgroup/cpu/cpu.cfs_period_us")
        .ok()?
        .trim()
        .parse()
        .ok()?;
    if quota <= 0 || period <= 0 {
        return None;
    }
    Some((((quota as f64) / (period as f64)).ceil() as usize).max(1))
}
```

> Note: `parse_cpu_max` is `#[cfg(target_os = "linux")]`, and so is its test. On non-Linux hosts (this dev machine is Windows) the parse test is compiled out; `core_budget_is_at_least_one` still runs everywhere. The CI Linux runner exercises `parse_cpu_max`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p raw-pipeline --no-default-features --features parallel calibration::prober`
Expected: PASS (`core_budget_is_at_least_one`; the parse test runs on Linux only).

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/calibration/prober.rs
git commit -m "feat(calibration): cgroup-aware effective_core_budget (server correctness)"
```

---

## Task 6: Accessibility prober + CI reachability test

**Files:**
- Modify: `crates/raw-pipeline/src/calibration/prober.rs`

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `prober.rs`:
```rust
    use crate::calibration::registry::{native_registry, Axis};

    #[test]
    fn probe_reports_every_pathway() {
        let reg = native_registry();
        let report = probe(&reg);
        assert_eq!(report.len(), reg.len());
        for r in &report {
            assert!(!r.reason.is_empty(), "{} has no reason", r.id);
        }
    }

    #[test]
    fn active_perceptual_backend_is_a_listed_variant() {
        // CI reachability guard: the backend the engine will actually pick MUST be one
        // of the variants the registry advertises. Catches a backend accidentally
        // cfg'd out of the build.
        let reg = native_registry();
        let p = reg
            .iter()
            .find(|p| p.id == "native.backend.perceptual")
            .expect("perceptual pathway missing");
        let active = active_perceptual_variant();
        assert!(
            p.variants.contains(&active),
            "active backend {active:?} not in advertised variants {:?}",
            p.variants
        );
    }

    #[test]
    fn concurrency_pathways_are_accessible_when_multicore() {
        // If the box has >1 usable core, the concurrency routes must probe accessible.
        if effective_core_budget() > 1 {
            let reg = native_registry();
            let report = probe(&reg);
            for r in report.iter().filter(|r| {
                reg.iter().any(|p| p.id == r.id && p.axis == Axis::Concurrency)
            }) {
                assert!(r.accessible, "{} should be accessible on multicore", r.id);
            }
        }
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p raw-pipeline --no-default-features --features parallel calibration::prober`
Expected: FAIL — `probe`, `Accessibility`, `active_perceptual_variant` not found.

- [ ] **Step 3: Implement**

Insert before `#[cfg(test)]` in `prober.rs` (add `use` at top of file):
```rust
use crate::calibration::registry::{Axis, Pathway};

/// Result of probing one pathway on THIS machine + build.
#[derive(Clone, Debug)]
pub struct Accessibility {
    pub id: &'static str,
    pub accessible: bool,
    /// Human-readable why (feature present/absent, core count, etc.).
    pub reason: String,
}

/// The perceptual SIMD variant the engine will auto-select right now, as the string
/// used in the registry's `variants` list.
pub fn active_perceptual_variant() -> &'static str {
    #[cfg(target_arch = "x86_64")]
    {
        use crate::perceptual::Backend;
        return match crate::perceptual::detect_native(false) {
            Backend::Scalar => "scalar",
            Backend::Avx2Strict => "avx2-strict",
            Backend::Avx2Rsqrt => "avx2-rsqrt",
            Backend::Avx512Strict => "avx512-strict",
            Backend::Avx512Rsqrt => "avx512-rsqrt",
            Backend::WasmSimd => "scalar", // unreachable on x86_64
        };
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        "scalar"
    }
}

/// True when this CPU can execute the named perceptual variant (x86 feature check).
fn perceptual_variant_accessible(variant: &str) -> (bool, String) {
    #[cfg(target_arch = "x86_64")]
    {
        let avx2 = std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma");
        let avx512 = avx2
            && std::is_x86_feature_detected!("avx512f")
            && std::is_x86_feature_detected!("avx512bw");
        let ok = match variant {
            "scalar" => true,
            "avx2-strict" | "avx2-rsqrt" | "avx2" | "avx2-fma" => avx2,
            "avx512-strict" | "avx512-rsqrt" => avx512,
            _ => false,
        };
        let reason = format!("avx2={avx2} avx512={avx512}");
        return (ok, reason);
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        (variant == "scalar", format!("non-x86 host: only scalar (asked {variant})"))
    }
}

/// Probe every pathway for accessibility on this machine + build. A SIMD-backend
/// pathway is accessible if AT LEAST its best variant is executable; a concurrency
/// pathway is accessible if the effective core budget exceeds one.
pub fn probe(pathways: &[Pathway]) -> Vec<Accessibility> {
    let cores = effective_core_budget();
    pathways
        .iter()
        .map(|p| match p.axis {
            Axis::SimdBackend => {
                // Best executable variant + a per-variant breakdown.
                let mut best: Option<&str> = None;
                let mut parts = Vec::new();
                for v in p.variants {
                    let (ok, _) = perceptual_variant_accessible(v);
                    if ok {
                        best = Some(v);
                    }
                    parts.push(format!("{v}={}", if ok { "�ók" } else { "-" }));
                }
                Accessibility {
                    id: p.id,
                    accessible: best.is_some(),
                    reason: format!("best={} [{}]", best.unwrap_or("none"), parts.join(" ")),
                }
            }
            Axis::Concurrency => Accessibility {
                id: p.id,
                accessible: cores > 1,
                reason: format!("effective_core_budget={cores}"),
            },
            Axis::WasmTier => Accessibility {
                id: p.id,
                accessible: false,
                reason: "wasm tier probed in browser, not native".to_string(),
            },
        })
        .collect()
}
```

> Replace the `✓ok`/`�ók` placeholder above with the ASCII `ok`/`-` to avoid non-ASCII in source. (Concretely: use `if ok { "ok" } else { "-" }`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p raw-pipeline --no-default-features --features parallel calibration::prober`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/calibration/prober.rs
git commit -m "feat(calibration): accessibility prober + CI reachability guard"
```

---

## Task 7: Cross-backend parity gate

**Files:**
- Modify: `crates/raw-pipeline/src/calibration/parity.rs`

Uses `Comparer` (scalar = documented parity oracle). We render a fractal, make a
mildly-distorted copy, then compute the butteraugli score under ForceScalar and under
each forced SIMD backend; all must agree bit-for-bit (or within a tight epsilon if the
codebase's SIMD parity is not exactly bit-identical for this metric).

**Files:**
- Modify: `crates/raw-pipeline/src/calibration/parity.rs`

- [ ] **Step 1: Write the failing tests**

Append to `parity.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::calibration::fractal::{Dataset, FractalSpec};

    #[test]
    fn scalar_vs_active_backend_agree_on_fractal() {
        let spec = FractalSpec::preset(Dataset::MandelbrotSeahorse, 96, 96);
        let report = parity_check(&spec);
        // At minimum the scalar self-check must exist and pass.
        assert!(report.iter().any(|r| r.variant == "scalar"));
        for r in &report {
            assert!(
                r.matches_scalar,
                "backend {} disagrees with scalar: score={} scalar={}",
                r.variant, r.score, r.scalar_score
            );
        }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p raw-pipeline --no-default-features --features parallel calibration::parity`
Expected: FAIL — `parity_check` not found.

- [ ] **Step 3: Implement**

Insert before `#[cfg(test)]` in `parity.rs`:
```rust
use crate::calibration::fractal::FractalSpec;
use crate::perceptual::{BackendChoice, Comparer, Opts};

/// One backend's parity result against the scalar oracle.
#[derive(Clone, Debug)]
pub struct ParityResult {
    pub variant: &'static str,
    pub score: f32,
    pub scalar_score: f32,
    pub matches_scalar: bool,
}

/// Distort a copy of the fractal so the butteraugli score is non-trivial (a
/// self-compare would be 0 on every backend and prove nothing). Deterministic: shift
/// every channel by a small fixed amount.
fn distort(px: &[u8]) -> Vec<u8> {
    px.iter()
        .enumerate()
        .map(|(i, &v)| if i % 4 == 3 { v } else { v.wrapping_add(7) })
        .collect()
}

/// The forced-backend ids to test, paired with their registry variant label. Only
/// those the CPU can actually execute are run (`resolve_forced_backend` degrades, but
/// we skip explicitly so the report is honest about what ran).
fn candidate_backends() -> Vec<(&'static str, BackendChoice)> {
    let mut v = vec![("scalar", BackendChoice::ForceScalar)];
    #[cfg(target_arch = "x86_64")]
    {
        let avx2 = std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma");
        let avx512 = avx2
            && std::is_x86_feature_detected!("avx512f")
            && std::is_x86_feature_detected!("avx512bw");
        if avx2 {
            v.push(("avx2-strict", BackendChoice::Force(1)));
            v.push(("avx2-rsqrt", BackendChoice::Force(2)));
        }
        if avx512 {
            v.push(("avx512-strict", BackendChoice::Force(3)));
            v.push(("avx512-rsqrt", BackendChoice::Force(5)));
        }
    }
    v
}

/// Run the parity gate on `spec`: every executable backend must reproduce the scalar
/// butteraugli score on the fractal. Returns one row per backend that ran.
///
/// Note: rsqrt backends use reciprocal-sqrt *approximations*, so they are expected to
/// differ slightly from strict sqrt. They are compared with a small tolerance; the
/// strict SIMD backends are required to match scalar exactly.
pub fn parity_check(spec: &FractalSpec) -> Vec<ParityResult> {
    let reference = spec.render_rgba8();
    let test = distort(&reference);
    let (w, h) = (spec.width, spec.height);

    let score_with = |choice: BackendChoice| -> f32 {
        let opts = Opts { backend: choice, ..Opts::default() };
        let mut cmp = Comparer::new(reference.clone(), w, h, opts);
        cmp.butteraugli(&test)
    };

    let scalar_score = score_with(BackendChoice::ForceScalar);
    candidate_backends()
        .into_iter()
        .map(|(variant, choice)| {
            let score = score_with(choice);
            // Strict + scalar: require bit-exact. rsqrt: allow a small relative epsilon
            // (approximation by design).
            let is_rsqrt = variant.contains("rsqrt");
            let matches = if is_rsqrt {
                let denom = scalar_score.abs().max(1e-6);
                ((score - scalar_score).abs() / denom) < 5e-3
            } else {
                score.to_bits() == scalar_score.to_bits()
            };
            ParityResult { variant, score, scalar_score, matches_scalar: matches }
        })
        .collect()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p raw-pipeline --no-default-features --features parallel calibration::parity`
Expected: PASS.
If a *strict* backend fails bit-exact (fmadd vs mul-add rounding), switch its check to
the same tight relative epsilon as rsqrt and document why in a comment — do NOT loosen
silently without a note.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/calibration/parity.rs
git commit -m "feat(calibration): cross-backend parity gate on fractal corpus"
```

---

## Task 8: `routes` example — print the map

**Files:**
- Create: `crates/raw-pipeline/examples/routes.rs`

- [ ] **Step 1: Write the example**

`crates/raw-pipeline/examples/routes.rs`:
```rust
//! Prints the explicit hardware-dependent pathway map for THIS machine + build:
//! every route, its variants, whether it is accessible here, and a fractal parity
//! summary. Run: `cargo run -p raw-pipeline --example routes --no-default-features --features parallel`.

use raw_pipeline::calibration::fractal::{Dataset, FractalSpec, DATASETS};
use raw_pipeline::calibration::parity::parity_check;
use raw_pipeline::calibration::prober::{effective_core_budget, probe};
use raw_pipeline::calibration::registry::native_registry;

fn main() {
    println!("== raw-pipeline hardware pathways ==");
    println!("effective core budget: {}", effective_core_budget());
    println!();

    let reg = native_registry();
    let acc = probe(&reg);
    println!("{:<28} {:<12} {}", "pathway", "accessible", "detail");
    for (p, a) in reg.iter().zip(acc.iter()) {
        println!(
            "{:<28} {:<12} {}",
            p.id,
            if a.accessible { "yes" } else { "no" },
            a.reason
        );
        println!("    variants: {}", p.variants.join(", "));
        println!("    selector: {}", p.selector_site);
    }

    println!();
    println!("== fractal corpus ==");
    for d in DATASETS {
        let s = FractalSpec::preset(*d, 8, 8);
        let _ = s.render_rgba8(); // smoke: renders without panic
        println!("  {} ({:?})", d.label(), s.kind);
    }

    println!();
    println!("== parity gate (mandelbrot-seahorse 96x96) ==");
    for r in parity_check(&FractalSpec::preset(Dataset::MandelbrotSeahorse, 96, 96)) {
        println!(
            "  {:<14} score={:.6} scalar={:.6} match={}",
            r.variant, r.score, r.scalar_score, r.matches_scalar
        );
    }
}
```

- [ ] **Step 2: Run it**

Run: `cargo run -p raw-pipeline --example routes --no-default-features --features parallel`
Expected: prints the pathway table, the fractal list, and the parity summary; exits 0.

- [ ] **Step 3: Commit**

```bash
git add crates/raw-pipeline/examples/routes.rs
git commit -m "feat(calibration): routes example prints pathway map + parity summary"
```

---

## Task 9: Final verification gates

- [ ] **Step 1: Full calibration test run**

Run: `cargo test -p raw-pipeline --no-default-features --features parallel calibration`
Expected: all calibration tests PASS.

- [ ] **Step 2: wasm compile gate (module must build on wasm32)**

Run: `cargo build -p raw-pipeline --lib --target wasm32-unknown-unknown --no-default-features`
Expected: builds clean (fractal + registry + prober-core compile on wasm; rayon/cgroup are cfg'd out).

- [ ] **Step 3: Broader native lib gate (no regressions)**

Run: `cargo build -p raw-pipeline --lib --no-default-features --features parallel`
Expected: clean. (Default-feature build pulls `jxl-ffi`/libjxl — if that fails for env reasons unrelated to this change, note it; the calibration module itself is feature-independent.)

- [ ] **Step 4: Clippy on the new module (quality)**

Run: `cargo clippy -p raw-pipeline --no-default-features --features parallel -- -D warnings` (scope to calibration if the wider crate has pre-existing warnings)
Expected: no warnings in `calibration/`.

- [ ] **Step 5: Commit any fixups**

```bash
git add -A && git commit -m "chore(calibration): verification fixups"
```

---

## Self-Review Notes

- **Spec coverage:** Registry = design §4.1/§5; Prober + core budget = §4.2/§8 (cgroup); Fractal = §4.3; Parity gate = §4.4; `routes` = success criterion #1. Bench/profile/orchestrator/broadcast/runtime-hooks (§4.4 macro, §4.5–4.8) are **deferred to supervised phases 3–7** — out of this plan's scope by design.
- **Type consistency:** `Dataset`/`Kind`/`FractalSpec` names consistent across tasks 2–3, 7, 8. `Axis`/`Env`/`Pathway` consistent tasks 4, 6, 8. `BackendChoice::{Force,ForceScalar}` matches `perceptual/mod.rs`.
- **Placeholder note:** Task 6 flags one non-ASCII glyph to replace with ASCII `ok`/`-`; do that during implementation.
- **Known risk:** strict SIMD parity may be 1-ULP off scalar for butteraugli (fmadd). Task 7 Step 4 gives the explicit remediation (tight epsilon + comment).
