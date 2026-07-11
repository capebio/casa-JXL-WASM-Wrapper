# Noise-Aware RAW Denoise Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional RAW denoise path that activates from measured or estimated sensor noise, including noisy older cameras at ISO 200/400, with a compact learned WebGPU engine and deterministic Rust/WASM fallback.

**Architecture:** Resolve a heteroscedastic per-CFA noise model from embedded DNG metadata, a measured camera profile, or a robust single-image fit. Convert that model and the image histogram into one display-referred noise score used by a strict policy gate; camera release year is deliberately excluded. When selected, run a noise-conditioned learned joint denoise/demosaic residual model through WebGPU, falling back to variance-stabilized BM3D in Rust/WASM; all tone, colour, texture, clarity, and sharpening remain downstream.

**Tech Stack:** Rust 2021, `raw-pipeline`, `wasm-bindgen`, Rayon, Bun/Vitest, Python 3.12, PyTorch 2.13, ONNX 1.22, ONNX Runtime 1.27, ONNX Runtime Web 1.27/WebGPU.

## Global Constraints

- Run every shell command through `rtk`; use `rtk proxy` unless an existing narrower `rtk` command is documented.
- Do not touch progressive JXL decode behavior in `packages/jxl-wasm/src/bridge.cpp` or `web/jxl-single-progressive.js`.
- Denoise is opt-in and defaults to `enabled: false`.
- Disabled and below-threshold paths must execute no denoise kernel and remain byte-identical to the new no-denoise oracle.
- Remove the current implicit ISO-to-Gaussian calls. Existing positional RAW APIs become denoise-off APIs; the intentional high-ISO output change gets a migration note and golden update.
- Keep `RawStreamExporter::from_orf/from_dng(nr_strength)` as an explicitly requested legacy streaming filter until a separate streaming-quality design replaces it.
- Support standard 2x2 Bayer CFA only. Reject unsupported CFA layouts from the learned path and use the existing non-denoise path.
- Never use camera model age as a trigger. `make + model + readout/gain segment + ISO` may select measured coefficients; the coefficients, not release year, drive the decision.
- Resolve noise sources in this order: DNG `NoiseProfile`, measured camera profile, single-image robust fit, ISO fallback.
- Use `Var[n_c | x] = S_c*x + O_c` for normalized linear signal `x`; retain negative below-black samples in `f32` while estimating and denoising.
- Auto-gate defaults: `noiseThreshold = 1.5` neutral-display code values, estimator confidence floor `0.65`, ISO fallback threshold `1600`.
- Missing ISO plus unavailable/low-confidence noise estimate means skip with reason `noise_unavailable`; never substitute ISO 100.
- Apply `effective_strength = strength * (1 - clamp(NoiseReductionApplied, 0, 1))`; skip when the result is below `0.05`.
- No GAN, diffusion, adversarial, or unbounded perceptual loss. The model predicts a bounded residual over deterministic MHC RGB.
- Learned tiles use fixed packed dimensions: 320x320 input, 32-pixel packed halo, 256x256 committed core.
- The model artifact must be at most 8 MiB, use FP16 weights with FP32 input/output, and pass PyTorch/ONNX parity before entering `web/models/`.
- Keep the feature hidden from product-default workflows until Task 12 release gates pass.
- Use scoped `git add` commands. Do not stage existing unrelated changes in `StandardMultifileTest.mjs`, `benchmark/hardware-telemetry.mjs`, or `.work/`.

## Activation Contract

The public option object is:

```js
{
  denoise: {
    enabled: false,
    activation: 'auto',   // 'auto' | 'iso' | 'always'
    isoThreshold: 1600,
    noiseThreshold: 1.5,  // p90 neutral-display sigma, 8-bit code values
    strength: 1.0,
    quality: 'high'
  }
}
```

Decision rules:

```text
enabled=false                         -> skip: disabled
activation=always                     -> apply
activation=iso and ISO missing        -> skip: iso_unavailable
activation=iso and ISO<threshold      -> skip: below_iso_threshold
activation=iso and ISO>=threshold     -> apply
activation=auto and confidence>=0.65  -> apply iff display_sigma_p90>=noiseThreshold
activation=auto and confidence<0.65   -> use ISO threshold as fallback
activation=auto and neither available -> skip: noise_unavailable
```

This catches an old camera at ISO 200 when its embedded, calibrated, or fitted noise score exceeds 1.5. A clean modern camera at ISO 200 remains off. Camera age adds no information once actual noise is available.

## File Map

| Area | Files | Responsibility |
|---|---|---|
| Noise domain | `crates/raw-pipeline/src/denoise/{mod,types,policy}.rs` | Stable noise model, metrics, options, decision |
| Metadata | `crates/raw-pipeline/src/dng.rs`, `cr2.rs`, `tiff.rs`, `denoise/dng_tags.rs` | Preserve ISO, black/white planes, DNG noise tags |
| Calibration | `denoise/{profiles,calibrate}.rs`, `data/camera-noise-profiles.json`, `src/bin/raw_noise_calibrate.rs` | Measured camera profiles and generator |
| Blind estimate | `denoise/{estimate,score}.rs` | Single-image fit, confidence, display score |
| CPU fallback | `denoise/{vst,bm3d,classical}.rs` | Generalized VST and deterministic BM3D |
| WASM API | `src/denoise_options.rs`, `src/denoise_session.rs`, `src/lib.rs` | Strict options, telemetry, tiled session |
| Browser | `web/raw-denoise-options.js`, `web/raw-denoise-runtime.js`, `web/worker.js`, `web/main.js`, `web/index.html`, `web/style.css` | Controls, routing, WebGPU inference |
| Training | `tools/raw-denoise/` | Dataset synthesis, NAFNet-lite training, export |
| Model | `web/models/raw-denoise-v1.ort`, `web/models/raw-denoise-v1.json` | Versioned model and generated integrity manifest |
| Validation | `crates/raw-pipeline/tests/denoise_quality.rs`, `web/raw-denoise-*.test.js`, `tools/denoise-benchmark.mjs`, `docs/denoise/validation.md` | Correctness, quality, seams, runtime, memory |

---

### Task 1: Noise Types And Policy Gate

**Files:**
- Create: `crates/raw-pipeline/src/denoise/mod.rs`
- Create: `crates/raw-pipeline/src/denoise/types.rs`
- Create: `crates/raw-pipeline/src/denoise/policy.rs`
- Modify: `crates/raw-pipeline/src/lib.rs`

**Interfaces:**
- Produces: `NoiseCoefficients`, `NoiseModel`, `NoiseMetrics`, `DenoiseOptions`, `DenoiseDecision`.
- Produces: `decide(options, iso, metrics, noise_reduction_applied) -> DenoiseDecision`.
- Consumes: no decoder-specific types.

- [ ] **Step 1: Write policy tests**

Add tests in `policy.rs` covering disabled, always, strict ISO, trusted auto score, low-confidence ISO fallback, missing metadata, and prior RAW reduction. Include the old-camera case:

```rust
#[test]
fn trusted_noise_can_trigger_at_iso_200() {
    let options = DenoiseOptions { enabled: true, ..Default::default() };
    let metrics = NoiseMetrics {
        display_sigma_p90: 2.1,
        sigma_18: 0.004,
        sigma_shadow: 0.012,
        snr_18_db: 33.1,
        confidence: 0.91,
        source: NoiseSource::BlindFit,
    };
    let d = decide(&options, Some(200), Some(metrics), None);
    assert!(d.apply);
    assert_eq!(d.reason, DenoiseReason::NoiseThreshold);
}
```

- [ ] **Step 2: Verify RED**

Run: `rtk proxy cargo test --manifest-path crates/raw-pipeline/Cargo.toml denoise::policy`

Expected: compile failure because `denoise` types do not exist.

- [ ] **Step 3: Implement exact domain types**

Use these public shapes:

```rust
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NoiseCoefficients { pub shot: f32, pub read: f32 }

impl NoiseCoefficients {
    pub fn variance(self, signal: f32) -> f32 {
        (self.shot * signal.max(0.0) + self.read).max(0.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationMode { Auto, Iso, Always }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoiseSource { DngNoiseProfile, CameraProfile, BlindFit, IsoFallback, Unavailable }

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NoiseModel {
    pub planes: [NoiseCoefficients; 4],
    pub structured_sigma: [f32; 4],
    pub confidence: f32,
    pub source: NoiseSource,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NoiseMetrics {
    pub display_sigma_p90: f32,
    pub sigma_18: f32,
    pub sigma_shadow: f32,
    pub snr_18_db: f32,
    pub confidence: f32,
    pub source: NoiseSource,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DenoiseOptions {
    pub enabled: bool,
    pub activation: ActivationMode,
    pub iso_threshold: u32,
    pub noise_threshold: f32,
    pub strength: f32,
}
```

`Default` must set `enabled=false`, `Auto`, `1600`, `1.5`, and `1.0`. Clamp parsed thresholds to ISO `25..=409600`, noise `0.5..=8.0`, and strength `0.0..=1.5`.

- [ ] **Step 4: Implement decision table literally**

Keep policy free of camera names and years. Return `effective_strength`, selected source, and a stable enum reason for every branch.

- [ ] **Step 5: Verify GREEN**

Run: `rtk proxy cargo test --manifest-path crates/raw-pipeline/Cargo.toml denoise::policy`

Expected: all policy tests pass.

- [ ] **Step 6: Commit checkpoint after approval**

```powershell
rtk proxy git add crates/raw-pipeline/src/lib.rs crates/raw-pipeline/src/denoise
rtk proxy git commit -m "feat(raw): define noise-aware denoise policy"
```

### Task 2: Parse DNG Noise Metadata Correctly

**Files:**
- Create: `crates/raw-pipeline/src/denoise/dng_tags.rs`
- Modify: `crates/raw-pipeline/src/dng.rs`

**Interfaces:**
- Produces: `RawNoiseMetadata` on `DngImage`, `DngMeta`, and `DngDemosaiced`.
- Consumes: `NoiseCoefficients` from Task 1.

- [ ] **Step 1: Add synthetic TIFF tests**

Extend the existing in-module DNG fixture builder. Assert parsing for little- and big-endian values:

```rust
assert_eq!(meta.black, [512.0, 513.0, 513.0, 515.0]);
assert_eq!(meta.white, [15000.0; 4]);
assert_eq!(meta.embedded_noise.unwrap().planes[0], NoiseCoefficients {
    shot: 0.00042,
    read: 0.0000031,
});
assert_eq!(meta.noise_reduction_applied, Some(0.25));
```

Cover a two-value `NoiseProfile` shared by all planes and a six-value RGB profile mapped through `CFAPlaneColor` to RGGB. Reject NaN, infinity, negative coefficients, invalid count, and out-of-bounds offsets.

- [ ] **Step 2: Verify RED**

Run: `rtk proxy cargo test --manifest-path crates/raw-pipeline/Cargo.toml dng_noise_profile`

Expected: tests fail because tags are ignored.

- [ ] **Step 3: Add exact tag readers**

Implement checked readers for TIFF `DOUBLE` and `RATIONAL`, then parse:

```rust
const TAG_CFA_PLANE_COLOR: u16 = 0xC616;
const TAG_BLACK_LEVEL_REPEAT_DIM: u16 = 0xC619;
const TAG_BLACK_LEVEL: u16 = 0xC61A;
const TAG_BLACK_LEVEL_DELTA_H: u16 = 0xC61B;
const TAG_BLACK_LEVEL_DELTA_V: u16 = 0xC61C;
const TAG_WHITE_LEVEL: u16 = 0xC61D;
const TAG_BASELINE_NOISE: u16 = 0xC62B;
const TAG_NOISE_REDUCTION_APPLIED: u16 = 0xC6F7;
const TAG_NOISE_PROFILE: u16 = 0xC761;
```

Normalize the profile to four CFA planes in the active CFA order. Preserve row/column black deltas in metadata; do not collapse them into a scalar before noise estimation.

- [ ] **Step 4: Thread metadata through every DNG output shape**

Add:

```rust
#[derive(Debug, Clone)]
pub struct RawNoiseMetadata {
    pub black: [f32; 4],
    pub white: [f32; 4],
    pub embedded_noise: Option<NoiseModel>,
    pub baseline_noise: Option<f32>,
    pub noise_reduction_applied: Option<f32>,
}
```

Ensure `decode_bytes`, streaming metadata, and both fused demosaic variants return identical metadata.

- [ ] **Step 5: Verify GREEN and existing DNG coverage**

```powershell
rtk proxy cargo test --manifest-path crates/raw-pipeline/Cargo.toml dng_noise_profile
rtk proxy cargo test --manifest-path crates/raw-pipeline/Cargo.toml dng
```

Expected: new and existing DNG tests pass.

- [ ] **Step 6: Commit checkpoint after approval**

```powershell
rtk proxy git add crates/raw-pipeline/src/dng.rs crates/raw-pipeline/src/denoise/dng_tags.rs
rtk proxy git commit -m "feat(dng): parse sensor noise metadata"
```

### Task 3: Normalize Camera Metadata And Build Measured Profiles

**Files:**
- Create: `crates/raw-pipeline/src/denoise/profiles.rs`
- Create: `crates/raw-pipeline/src/denoise/calibrate.rs`
- Create: `crates/raw-pipeline/data/camera-noise-profiles.json`
- Create: `crates/raw-pipeline/src/bin/raw_noise_calibrate.rs`
- Modify: `crates/raw-pipeline/src/cr2.rs`
- Modify: `crates/raw-pipeline/src/tiff.rs`
- Modify: `web/libraw-normalize.js`
- Modify: `web/libraw-normalize.test.js`
- Modify: `web/libraw-decode.test.js`

**Interfaces:**
- Produces: `CameraKey::new(make, model)` with whitespace/case normalization only.
- Produces: `CameraNoiseRegistry::resolve(key, iso) -> Option<NoiseModel>`.
- Produces: LibRaw payload fields `iso`, `blackLevels`, `whiteLevels`, `noiseProfile`, and `noiseReductionApplied`.

- [ ] **Step 1: Write registry interpolation tests**

Use an in-memory profile with two gain segments. Assert interpolation in `log2(ISO)` within one segment and nearest-point selection across a segment boundary. Assert model release year is neither accepted nor stored.

- [ ] **Step 2: Write calibration tests with deterministic synthetic pairs**

Generate two dark frames and paired flat frames with known per-plane `S` and `O`. The fitter must recover each coefficient within 8%, report sample count, fit residual, and reject saturated samples.

- [ ] **Step 3: Verify RED**

Run: `rtk proxy cargo test --manifest-path crates/raw-pipeline/Cargo.toml denoise::profiles denoise::calibrate`

Expected: missing module failures.

- [ ] **Step 4: Implement registry schema and lookup**

Use this JSON shape; the tracked initial file is valid and empty until measured profiles pass the calibration command:

```json
{"schemaVersion":1,"profiles":[]}
```

Each generated profile entry contains `make`, `model`, `gainSegment`, `iso`, four `{shot,read}` pairs, structured row/column sigma, source manifest SHA-256, and fit residual. Reject entries without all provenance fields.

- [ ] **Step 5: Implement pair-based calibration**

For each ISO and CFA plane:

```text
signal = mean((flat_a + flat_b)/2 - black)
variance = variance(flat_a - flat_b)/2
fit variance = S*signal + O with Huber IRLS
dark variance supplies an independent O check
```

The CLI takes `--manifest`, `--output`, and `--camera-key`. It exits nonzero when fewer than 16 dark frames, 8 flat pairs, or 6 unsaturated signal levels exist for an ISO.

- [ ] **Step 6: Preserve ISO and plane levels in all decoders**

Change missing ISO fields to `Option<u32>` internally. Do not use `unwrap_or(100)`. ORF/CR2 keep `embedded_noise=None` unless verified maker metadata supplies coefficients.

Extend LibRaw normalization with:

```js
const iso = positiveFinite(
  meta.iso_speed ?? meta.other?.iso_speed ?? meta.shootinginfo?.iso_speed
);
```

Map LibRaw per-channel black values when supplied; otherwise replicate the scalar. Tests cover ISO 200 and absent ISO.

- [ ] **Step 7: Verify GREEN**

```powershell
rtk proxy cargo test --manifest-path crates/raw-pipeline/Cargo.toml denoise::profiles denoise::calibrate
rtk proxy bun test web/libraw-normalize.test.js web/libraw-decode.test.js
```

Expected: all targeted tests pass.

- [ ] **Step 8: Commit checkpoint after approval**

```powershell
rtk proxy git add crates/raw-pipeline/src/denoise crates/raw-pipeline/src/bin/raw_noise_calibrate.rs crates/raw-pipeline/data/camera-noise-profiles.json crates/raw-pipeline/src/cr2.rs crates/raw-pipeline/src/tiff.rs web/libraw-normalize.js web/libraw-normalize.test.js web/libraw-decode.test.js
rtk proxy git commit -m "feat(raw): add measured sensor noise profiles"
```

### Task 4: Single-Image Noise Fit And Display Score

**Files:**
- Create: `crates/raw-pipeline/src/denoise/estimate.rs`
- Create: `crates/raw-pipeline/src/denoise/score.rs`
- Modify: `crates/raw-pipeline/src/denoise/mod.rs`

**Interfaces:**
- Produces: `estimate_noise(raw, width, height, cfa, metadata) -> Option<NoiseModel>`.
- Produces: `score_noise(raw, width, height, metadata, model, wb) -> NoiseMetrics`.
- Produces: `resolve_noise_model(embedded, registry, blind) -> Option<NoiseModel>`.

- [ ] **Step 1: Write deterministic estimator tests**

Use a local xorshift PRNG with a fixed seed to synthesize Poisson-Gaussian Bayer frames. Cover flat fields, smooth gradients, edges, checkerboard texture, clipped highlights, below-black samples, row noise, and insufficient flat patches. Require coefficient error below 12% on flat/gradient cases and confidence below `0.65` on texture-only cases.

- [ ] **Step 2: Verify RED**

Run: `rtk proxy cargo test --manifest-path crates/raw-pipeline/Cargo.toml denoise::estimate denoise::score`

Expected: missing module failures.

- [ ] **Step 3: Implement robust CFA-plane fit**

Algorithm, fixed for reproducibility:

1. Convert to normalized `f32`: `(raw - black_plane)/(white_plane - black_plane)` without lower clamping.
2. Split into four half-resolution CFA planes.
3. Divide each plane into 8x8 patches.
4. Compute patch mean and a 3x3 high-pass residual using kernel `[1,-2,1; -2,4,-2; 1,-2,1]`; divide residual variance by kernel energy `36`.
5. Bin patch means into 16 bins over `[-0.02, 0.90]` and retain the lowest-structure 20% per populated bin.
6. Require at least 96 patches and 6 populated bins.
7. Fit `variance=S*mean+O` with eight Huber IRLS iterations, nonnegative constraints, and no intercept substitution.
8. Estimate row/column structured sigma from robust medians after subtracting a 5x5 separable smooth field.
9. Merge the two green fits by inverse-residual weighting while retaining four output planes.

Confidence is the product of capped patch-count coverage, bin coverage, and `exp(-normalized_fit_rmse)`, clamped to `[0,1]`.

- [ ] **Step 4: Implement one objective display score**

Sample 4096 stratified pixels with normalized signal in `[0.01, 0.50]`. For each sample and CFA plane:

```rust
let sigma = model.planes[p].variance(x).sqrt().hypot(model.structured_sigma[p]);
let lo = linear_to_srgb((x - sigma).max(0.0));
let hi = linear_to_srgb((x + sigma).min(1.0));
let sigma_code = 255.0 * (hi - lo) * 0.5;
```

Apply camera WB before the sRGB projection, take p90 of `sigma_code`, and also report model sigma/SNR at 18% and 2% linear signal. This score is diagnostic and stable; it is not a claim of perceptual equivalence across displays.

- [ ] **Step 5: Verify source priority and low-ISO trigger**

Tests assert embedded DNG beats registry, registry beats blind, blind beats ISO fallback, and a noisy ISO 200 synthetic frame applies in auto mode.

- [ ] **Step 6: Verify GREEN**

Run: `rtk proxy cargo test --manifest-path crates/raw-pipeline/Cargo.toml denoise`

Expected: all denoise model, estimator, score, and policy tests pass.

- [ ] **Step 7: Commit checkpoint after approval**

```powershell
rtk proxy git add crates/raw-pipeline/src/denoise
rtk proxy git commit -m "feat(raw): estimate signal-dependent sensor noise"
```

### Task 5: Variance-Stabilized BM3D Fallback

**Files:**
- Create: `crates/raw-pipeline/src/denoise/vst.rs`
- Create: `crates/raw-pipeline/src/denoise/bm3d.rs`
- Create: `crates/raw-pipeline/src/denoise/classical.rs`
- Create: `crates/raw-pipeline/tests/denoise_quality.rs`
- Modify: `crates/raw-pipeline/src/denoise/mod.rs`

**Interfaces:**
- Produces: `classical::denoise(raw, rgb_mhc, metadata, model, strength) -> Vec<u16>`.
- Consumes: normalized four-plane model and deterministic MHC baseline.
- Produces: normalized RGB16 with black `0` and white `65535` for the existing tone pipeline.

- [ ] **Step 1: Write VST round-trip and bias tests**

Test generalized Anscombe forward/inverse on signals from `-0.02` to `1.0`. Exact inverse mean bias must remain below `2e-4` for synthetic Poisson-Gaussian samples.

- [ ] **Step 2: Write BM3D quality tests**

Generate constant, slanted-edge, zone-plate, colour-checker, and repeated-texture fixtures. Compare no denoise, current 5-tap Gaussian oracle, and BM3D. Require:

```text
constant-field PSNR gain over noisy input >= 6 dB
slanted-edge MTF50 retention >= 95%
mean linear bias <= 0.25 * input sigma
tile seam maximum <= 1 RGB16 code
same input/options output SHA-256 identical across 10 runs
```

- [ ] **Step 3: Verify RED**

Run: `rtk proxy cargo test --manifest-path crates/raw-pipeline/Cargo.toml --test denoise_quality`

Expected: missing denoise engine failure.

- [ ] **Step 4: Implement generalized VST**

Use the generalized Anscombe transform and exact unbiased inverse. Operate in `f32`; no saturating subtraction before the forward transform.

- [ ] **Step 5: Implement deterministic two-stage BM3D**

Use fixed parameters:

```text
patch=8, search=32, reference_step=3
stage1 group<=16, hard threshold lambda=2.7
stage2 group<=32, Wiener shrinkage
2D transform=DCT-II, group transform=1D Haar
aggregation window=Kaiser beta 2.0
outer tile=512, halo=32
```

Parallelize independent reference patches with Rayon, but aggregate in deterministic tile/reference order. Avoid atomics and unordered floating-point reductions.

- [ ] **Step 6: Implement noise-regime orchestration**

For `display_sigma_p90 < 4.0`, demosaic first and denoise in YCoCg, using the resolved model to derive stabilized sigma. At `>=4.0`, run a light first-stage CFA-plane VST/BM3D, MHC demosaic, then the YCoCg pass. Blend the estimated clean image against MHC by `effective_strength`; strength zero is an exact no-op.

- [ ] **Step 7: Verify GREEN and memory**

```powershell
rtk proxy cargo test --manifest-path crates/raw-pipeline/Cargo.toml --test denoise_quality
rtk proxy cargo test --manifest-path crates/raw-pipeline/Cargo.toml denoise
```

Expected: quality and deterministic tests pass without increasing memory on the denoise-off path.

- [ ] **Step 8: Commit checkpoint after approval**

```powershell
rtk proxy git add crates/raw-pipeline/src/denoise crates/raw-pipeline/tests/denoise_quality.rs
rtk proxy git commit -m "feat(raw): add calibrated classical denoise fallback"
```

### Task 6: Strict WASM Options, Telemetry, And No Hidden Denoise

**Files:**
- Create: `src/denoise_options.rs`
- Modify: `src/lib.rs`
- Modify: `crates/raw-pipeline/src/pipeline.rs`

**Interfaces:**
- Produces: `process_orf_with_options`, `process_dng_with_options`, `process_cr2_with_options`, `process_raw_mosaic_with_options`.
- Produces: `ProcessResult` denoise telemetry getters.
- Produces: `finish_full_rgb8_with_options` for retained ORF mosaics.

- [ ] **Step 1: Write strict parser tests**

Test neutral defaults, all activation modes, numeric clamps, missing nested object, and unknown-key errors. Unknown keys must name the allowed fields.

- [ ] **Step 2: Write no-op and gating tests**

Pin synthetic RAW hashes for disabled, below threshold, noisy ISO 200 auto, strict ISO 1600, and missing ISO. Disabled and skipped hashes must match a build where all three implicit `apply_luminance_nr` calls are bypassed.

- [ ] **Step 3: Verify RED**

Run: `rtk proxy cargo test --lib denoise_options denoise_noop`

Expected: missing API/types failure.

- [ ] **Step 4: Implement nested options parsing**

Keep `LookOverrides` unchanged. Parse:

```rust
struct RawProcessOptions {
    look: LookOverrides,
    denoise: raw_pipeline::denoise::DenoiseOptions,
}
```

Use strict `js_sys::Reflect` parsing matching the existing look parser style. Do not add a positional denoise argument.

- [ ] **Step 5: Centralize denoise orchestration**

Move DNG, CR2, ORF, and generic mosaic decisions through one internal `finish_mosaic_with_options`. Delete the three hardcoded ISO strength tables at current `src/lib.rs` locations near 1545, 3618, and 4297. Positional and `*_with_look` APIs call `DenoiseOptions::default()` and therefore remain off.

- [ ] **Step 6: Add telemetry**

Add readonly fields/getters:

```text
denoise_requested: bool
denoise_applied: bool
denoise_ms: f64
noise_score: f32
noise_confidence: f32
noise_source: string
denoise_backend: string
denoise_reason: string
denoise_model_version: string
```

Stable backend values: `none`, `classical`, `webgpu`. Stable reason values come from Task 1.

- [ ] **Step 7: Verify GREEN and broad Rust regression**

```powershell
rtk proxy cargo test --lib denoise_options denoise_noop
rtk proxy cargo test --manifest-path crates/raw-pipeline/Cargo.toml
```

Expected: all tests pass. Existing high-ISO goldens change only where hidden Gaussian NR previously ran.

- [ ] **Step 8: Commit checkpoint after approval**

```powershell
rtk proxy git add src/denoise_options.rs src/lib.rs crates/raw-pipeline/src/pipeline.rs
rtk proxy git commit -m "feat(wasm): expose optional noise-aware RAW processing"
```

### Task 7: Browser Controls And Classical Routing

**Files:**
- Create: `web/raw-denoise-options.js`
- Create: `web/raw-denoise-options.test.js`
- Create: `web/worker-denoise-routing.test.js`
- Modify: `web/index.html`
- Modify: `web/style.css`
- Modify: `web/main.js`
- Modify: `web/worker.js`

**Interfaces:**
- Produces: `readDenoiseOptions(root)`, `normalizeDenoiseOptions(value)`, `denoiseNeedsReprocess(a,b)`.
- Worker consumes `options.denoise` and invokes named WASM options APIs.

- [ ] **Step 1: Write option normalization tests**

Assert default off, auto mode, ISO presets 200/400/800/1600/3200/6400, sensitivity mappings `high=1.0`, `normal=1.5`, `low=2.0`, and strict validation.

- [ ] **Step 2: Write worker source-contract tests**

Assert native and LibRaw routes pass the same denoise object, denoise-enabled processing disables the ORF preview split, and result telemetry enters `phaseMs.denoise`.

- [ ] **Step 3: Verify RED**

Run: `rtk proxy bun test web/raw-denoise-options.test.js web/worker-denoise-routing.test.js`

Expected: modules/routes do not exist.

- [ ] **Step 4: Add compact processing controls**

Inside the existing Detail fieldset add a checkbox, activation select, ISO threshold select, and sensitivity select. Use stable dimensions and existing control styling. Do not present denoise as a live look slider.

- [ ] **Step 5: Add options to decode requests**

`currentOptions()` returns the normalized object from the Activation Contract. Changing any denoise control marks existing RAW cards stale and resubmits selected/current RAW files through the worker; it must not call `LookRenderer.render()` because its RGB16 cache is post-denoise.

- [ ] **Step 6: Route all RAW kinds through named options**

Import the four new WASM functions. Keep existing positional wrappers for external compatibility, but stop using them in `worker.js`. Set:

```js
const canSplit = nativeRaw
  && interactive
  && rawKind === 'orf'
  && !denoise.enabled;
```

This guarantees denoised preview and final caches come from the same full-quality RGB. Add `denoise` to timing messages and diagnostic metadata.

- [ ] **Step 7: Verify GREEN**

```powershell
rtk proxy bun test web/raw-denoise-options.test.js web/worker-denoise-routing.test.js
rtk proxy bun test web/libraw-normalize.test.js web/worker-message-types.test.js
```

Expected: targeted browser tests pass.

- [ ] **Step 8: Build threaded WASM and browser bundle**

```powershell
rtk proxy bash tools/build-mt-wasm.sh web/pkg
rtk proxy bun run build
```

Expected: threaded RAW WASM and workspace build complete successfully.

- [ ] **Step 9: Commit checkpoint after approval**

```powershell
rtk proxy git add web/raw-denoise-options.js web/raw-denoise-options.test.js web/worker-denoise-routing.test.js web/index.html web/style.css web/main.js web/worker.js web/pkg
rtk proxy git commit -m "feat(web): add optional automatic RAW denoise controls"
```

### Task 8: Tiled Learned-Denoise Session API

**Files:**
- Create: `src/denoise_session.rs`
- Modify: `src/lib.rs`

**Interfaces:**
- Produces: `create_orf_denoise_session`, `create_dng_denoise_session`, `create_cr2_denoise_session`, `create_raw_mosaic_denoise_session`.
- Produces: `DenoiseSession::take_input_tile`, `commit_output_tile`, `finish_with_options`, `finish_classical`.

- [ ] **Step 1: Write session state tests**

Test odd dimensions, all four CFA phases, edge reflection, exact 320x320x20 input shape, 256x256x12 output shape, duplicate/missing/out-of-order commit rejection, and no seams when model residuals are zero.

- [ ] **Step 2: Verify RED**

Run: `rtk proxy cargo test --lib denoise_session`

Expected: missing session failure.

- [ ] **Step 3: Implement session ownership**

The session owns decoded mosaic, metadata, MHC baseline, decision, committed-tile bitmap, and output RGB16. It exposes no raw pointer to JS.

Each packed input tile has 20 channels:

```text
0..3   normalized RGGB mosaic
4..7   per-pixel sigma maps sqrt(S*x+O)
8..19  packed 2x2 MHC RGB baseline (4 positions * 3 channels)
```

Normalize raw with per-plane black/white in `f32`, retaining values down to `-0.05` and clipping only above `1.25` for model stability.

- [ ] **Step 4: Implement residual commits**

Model output is 12 packed RGB residual channels. Clamp each residual to `[-0.25, 0.25]`, add it to packed MHC, crop the 32-pixel halo, and quantize the committed core to normalized RGB16 `0..65535`. Do not average overlapping cores.

- [ ] **Step 5: Implement finish paths**

`finish_with_options` requires every tile committed and sets black/white to `0/65535` before the existing look/tone path. `finish_classical` invokes Task 5 and needs no model tiles. Both rebuild full, lightbox, and thumbnail caches from the selected denoised RGB.

- [ ] **Step 6: Preserve denoise-off fast paths**

Workers create a session only after the gate says learned/classical processing is needed. Denoise-off requests keep current fused DNG and ORF preview optimizations.

- [ ] **Step 7: Verify GREEN**

Run: `rtk proxy cargo test --lib denoise_session`

Expected: all state, shape, and seam tests pass.

- [ ] **Step 8: Commit checkpoint after approval**

```powershell
rtk proxy git add src/denoise_session.rs src/lib.rs
rtk proxy git commit -m "feat(wasm): add tiled RAW denoise sessions"
```

### Task 9: Training Data And NAFNet-Lite Model

**Files:**
- Create: `tools/raw-denoise/pyproject.toml`
- Create: `tools/raw-denoise/raw_denoise/__init__.py`
- Create: `tools/raw-denoise/raw_denoise/model.py`
- Create: `tools/raw-denoise/raw_denoise/dataset.py`
- Create: `tools/raw-denoise/raw_denoise/noise.py`
- Create: `tools/raw-denoise/raw_denoise/train.py`
- Create: `tools/raw-denoise/tests/test_model.py`
- Create: `tools/raw-denoise/tests/test_noise.py`
- Create: `docs/denoise/dataset-manifest.schema.json`

**Interfaces:**
- Produces: `RawJointDenoiser` input `[N,20,320,320]`, output `[N,12,320,320]`.
- Produces: deterministic synthetic/real training patches described by a checksummed manifest.

- [ ] **Step 1: Create pinned training environment**

`pyproject.toml` requires Python `>=3.12,<3.13`, `torch==2.13.0`, `onnx==1.22.0`, `onnxruntime==1.27.0`, `numpy>=2.2,<3`, and `pytest>=8.3,<9`.

- [ ] **Step 2: Write model contract tests**

Assert exact input/output shape, deterministic seed, residual clamp, parameter count `<=4_000_000`, no normalization layer dependent on batch statistics, and finite gradients.

- [ ] **Step 3: Write noise synthesis tests**

Given clean normalized raw and known coefficients, generated samples must match target mean within `2e-3`, shot/read variance within 8%, and preserve row-pattern alignment under Bayer-safe augmentation.

- [ ] **Step 4: Verify RED**

```powershell
rtk proxy uv sync --project tools/raw-denoise
rtk proxy uv run --project tools/raw-denoise pytest tools/raw-denoise/tests -q
```

Expected: missing package/tests fail before implementation.

- [ ] **Step 5: Implement model architecture**

Use separate CFA-aware stems for eight raw/noise channels and twelve packed-MHC channels, then a three-level NAFNet-lite encoder/decoder with width 32, block counts `[2,2,4]`, eight middle blocks, and `[2,2,2]` decoder blocks. The head predicts 12 residual channels and adds them to packed MHC. Use only operators supported by ONNX Runtime WebGPU: convolution, depthwise convolution, add, multiply, sigmoid, global average, reshape, transpose, and pixel shuffle equivalents.

- [ ] **Step 6: Implement training data construction**

Use three sources:

1. Clean linear RGB unprocessed through the exact inverse ISP method from Brooks et al., then mosaicked.
2. Own aligned RAW bursts: at least 16 frames for clean averages and one noisy frame at each native ISO/gain mode.
3. Real dark residuals sampled in CFA-pattern-aligned patches, including row/column structure and quantization.

Each supported camera release candidate needs at least 50 training scenes, 20 disjoint holdout scenes, 32 dark frames per ISO/gain segment, and 8 flat pairs at 6 exposure levels. Bayer augmentations must permute channels correctly for flips and 90-degree rotations.

- [ ] **Step 7: Implement loss and schedule**

Use AdamW, learning rate `2e-4`, betas `(0.9,0.99)`, weight decay `1e-4`, cosine decay over 400,000 optimizer steps, packed-patch batch size 16, mixed precision, and seed `20260710`. Loss weights:

```text
Charbonnier linear RGB        1.00
multi-scale gradient          0.10
YCoCg chroma                  0.05
fixed neutral-ISP RGB         0.10
saturated-pixel consistency   0.02
```

- [ ] **Step 8: Verify GREEN**

Run: `rtk proxy uv run --project tools/raw-denoise pytest tools/raw-denoise/tests -q`

Expected: model and synthesis tests pass.

- [ ] **Step 9: Commit checkpoint after approval**

```powershell
rtk proxy git add tools/raw-denoise docs/denoise/dataset-manifest.schema.json
rtk proxy git commit -m "feat(ml): add RAW joint denoise training pipeline"
```

### Task 10: Train, Export, And Validate Model Artifact

**Files:**
- Create: `tools/raw-denoise/raw_denoise/export.py`
- Create: `tools/raw-denoise/raw_denoise/evaluate.py`
- Create: `tools/raw-denoise/tests/test_export.py`
- Create: `web/models/raw-denoise-v1.ort`
- Create: `web/models/raw-denoise-v1.json`
- Modify: `.gitattributes`

**Interfaces:**
- Produces: versioned ORT artifact with generated SHA-256 manifest.
- Consumes: Task 9 checkpoint passing holdout gates.

- [ ] **Step 1: Write export parity test**

Export a fixed-seed miniature checkpoint and compare PyTorch versus ONNX Runtime CPU output. Maximum absolute error must be `<=2e-4`, mean error `<=2e-5`.

- [ ] **Step 2: Verify RED**

Run: `rtk proxy uv run --project tools/raw-denoise pytest tools/raw-denoise/tests/test_export.py -q`

Expected: exporter missing.

- [ ] **Step 3: Implement fixed-shape export**

Export ONNX opset 21 with input name `input`, output name `residual_rgb`, and static shape `[1,20,320,320]`. Convert to ORT format. The exporter computes SHA-256 and writes a manifest containing schema version, semantic model version, dimensions, halo/core sizes, coefficient normalization contract, training-manifest hash, git commit, and quality metrics.

- [ ] **Step 4: Train production candidate**

Run the 400,000-step schedule. Evaluate every 5,000 steps and retain the checkpoint with best geometric mean of linear PSNR, rendered SSIM, and edge retention on camera-disjoint holdouts.

- [ ] **Step 5: Enforce artifact gates**

Reject export unless all holdout gates pass:

```text
linear PSNR gain over current Gaussian >= 1.5 dB
rendered SSIM does not regress on any camera median
MTF50 retention >= 95%
median DeltaE00 regression <= 0.5
false-detail point/line fixture has no added connected component > 2 pixels
artifact size <= 8 MiB
```

- [ ] **Step 6: Mark binary attributes**

Add `*.onnx binary` and `*.ort binary` to `.gitattributes`.

- [ ] **Step 7: Verify GREEN**

```powershell
rtk proxy uv run --project tools/raw-denoise pytest tools/raw-denoise/tests/test_export.py -q
rtk proxy uv run --project tools/raw-denoise python -m raw_denoise.evaluate --manifest denoise-data/holdout/manifest.json --model web/models/raw-denoise-v1.ort
```

Expected: parity and holdout gates pass; manifest hash matches artifact bytes.

- [ ] **Step 8: Commit checkpoint after approval**

```powershell
rtk proxy git add tools/raw-denoise/raw_denoise/export.py tools/raw-denoise/raw_denoise/evaluate.py tools/raw-denoise/tests/test_export.py web/models/raw-denoise-v1.ort web/models/raw-denoise-v1.json .gitattributes
rtk proxy git commit -m "feat(ml): add validated RAW denoise model"
```

### Task 11: ONNX Runtime WebGPU Backend And Worker Integration

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Create: `web/raw-denoise-runtime.js`
- Create: `web/raw-denoise-runtime.test.js`
- Modify: `web/worker.js`

**Interfaces:**
- Produces: `createRawDenoiseRuntime({ ort, modelUrl, manifestUrl })`.
- Produces: `runtime.run(session, signal) -> { backend, modelVersion, inferenceMs }`.
- Consumes: `DenoiseSession` from Task 8.

- [ ] **Step 1: Write mocked runtime tests**

Cover manifest/hash failure, no `navigator.gpu`, session creation failure, device loss, abort, tile order, tensor disposal, static dimensions, and successful commit of every tile. Every failure must call `finish_classical`, not return a partially learned image.

- [ ] **Step 2: Verify RED**

Run: `rtk proxy bun test web/raw-denoise-runtime.test.js`

Expected: module missing.

- [ ] **Step 3: Add runtime dependency**

Pin `onnxruntime-web` to `1.27.0`, then run `rtk bun install`.

- [ ] **Step 4: Implement WebGPU session**

Use conditional import and static graph capture:

```js
const ort = await import('onnxruntime-web/webgpu');
const inference = await ort.InferenceSession.create(modelBytes, {
  executionProviders: ['webgpu'],
  enableGraphCapture: true,
  graphOptimizationLevel: 'all',
});
```

Verify model SHA-256 with `crypto.subtle.digest` before session creation. Reuse one ORT session per worker. Dispose every input/output tensor after each tile and destroy runtime state on WebGPU device loss.

- [ ] **Step 5: Integrate routing**

When `DenoiseDecision.apply` is false, finish through the no-denoise path. When true, prefer WebGPU, commit all learned tiles, then finish. On any model/runtime failure, discard the learned session output and rerun the same owned mosaic through `finish_classical`. Surface backend and failure reason in telemetry.

- [ ] **Step 6: Verify GREEN**

```powershell
rtk proxy bun test web/raw-denoise-runtime.test.js web/worker-denoise-routing.test.js
rtk proxy bun run build
```

Expected: runtime, routing, and build pass.

- [ ] **Step 7: Commit checkpoint after approval**

```powershell
rtk proxy git add package.json bun.lock web/raw-denoise-runtime.js web/raw-denoise-runtime.test.js web/worker.js
rtk proxy git commit -m "feat(web): run RAW denoise through WebGPU"
```

### Task 12: End-To-End Quality, Compatibility, And Release Gate

**Files:**
- Create: `tools/denoise-benchmark.mjs`
- Create: `web/raw-denoise-e2e.test.js`
- Create: `docs/denoise/validation.md`
- Modify: `docs/user-manual.html`

**Interfaces:**
- Produces: per-image JSON/TOON report with quality, gate source, runtime, memory, and model version.
- Produces: release evidence for every supported camera/format.

- [ ] **Step 1: Build corpus manifest**

Include each supported camera around every relevant gain boundary and at ISO 100/200/400/800/1600/3200/6400 where available. Scene classes: deep shadows, skin, hair, foliage, fabric, fine text, stars, bokeh, fences, saturated highlights, moire, hot pixels, and banding. Keep training and holdout scene identities disjoint.

- [ ] **Step 2: Write end-to-end browser tests**

Use a real DNG with `NoiseProfile`, one noisy old-camera ISO 200/400 RAW, one clean low-ISO RAW, one missing-ISO generic mosaic, and one forced WebGPU failure. Assert gate decisions, backend fallback, preview/final consistency, telemetry, and no retained WASM/ORT state after release.

- [ ] **Step 3: Verify RED**

Run: `rtk proxy bun test web/raw-denoise-e2e.test.js`

Expected: fixture/routing assertions fail before harness implementation.

- [ ] **Step 4: Implement benchmark report**

Report no denoise, deleted Gaussian oracle, classical, learned, and external DxO comparison outputs without using DxO output as training data. Metrics:

```text
linear camera-RGB PSNR and SSIM
fixed-ISP rendered SSIM and LPIPS-equivalent approved metric
DeltaE00 on chart patches
slanted-edge MTF50
residual mean, autocorrelation, and power spectrum
tile seam maximum
denoise/runtime/total milliseconds
peak WASM and estimated GPU bytes
model bytes and version
```

- [ ] **Step 5: Run complete verification**

```powershell
rtk proxy cargo test --manifest-path crates/raw-pipeline/Cargo.toml
rtk proxy cargo test --lib
rtk proxy bun test web/raw-denoise-options.test.js web/raw-denoise-runtime.test.js web/worker-denoise-routing.test.js web/raw-denoise-e2e.test.js
rtk proxy bash tools/build-mt-wasm.sh web/pkg
rtk proxy bun run build
rtk proxy node tools/denoise-benchmark.mjs --manifest denoise-data/holdout/manifest.json --out docs/denoise/validation-results.json
```

Expected: every command passes and the report contains no failed release gate.

- [ ] **Step 6: Apply release criteria**

All must hold:

```text
disabled/below-threshold hashes equal no-denoise oracle
no camera is selected from age alone
old noisy ISO 200/400 holdout triggers from score/profile
clean low-ISO holdout remains off
unknown ISO/noise skips safely
no tile seam exceeds 1 RGB16 code
no camera median colour regression exceeds DeltaE00 0.5
learned model beats classical and old Gaussian on aggregate quality
WebGPU p50 denoise time <= 2x existing decode+demosaic+tone on reference machine
classical fallback p50 <= 30 seconds for 24 MP
24 MP peak combined working memory <= 768 MiB
model <= 8 MiB and hash verified
```

- [ ] **Step 7: Document behavior**

Document switch default, Auto/ISO/Always behavior, diagnostic noise score/source/confidence, offline fallback, model version, and why camera age is not a trigger.

- [ ] **Step 8: Commit checkpoint after approval**

```powershell
rtk proxy git add tools/denoise-benchmark.mjs web/raw-denoise-e2e.test.js docs/denoise/validation.md docs/user-manual.html
rtk proxy git commit -m "test(raw): validate noise-aware denoise release gates"
```

## Scientific Basis

- DNG noise equation, `NoiseProfile`, `NoiseReductionApplied`, and `BaselineNoise`: [Adobe DNG Specification 1.7.1](https://helpx.adobe.com/content/dam/help/en/camera-raw/digital-negative/jcr_content/root/content/flex/items/position/position-par/download_section_733958301/download-1/DNG_Spec_1_7_1_0.pdf)
- Single-image Poisson-Gaussian parameter fitting: [Foi et al., IEEE TIP 2008](https://doi.org/10.1109/TIP.2008.2001399)
- Nonparametric RAW noise curve estimation: [Colom et al., JOSA A 2014](https://opg.optica.org/josaa/abstract.cfm?uri=josaa-31-4-863)
- Moderate-noise versus high-noise stage ordering: [Guo et al., Inverse Problems and Imaging 2024](https://www.aimsciences.org/article/doi/10.3934/ipi.2023044)
- Joint learned demosaic/denoise: [Gharbi et al., SIGGRAPH 2016](https://groups.csail.mit.edu/graphics/demosaicnet/index.html)
- Exact ISP inversion for synthetic RAW training: [Brooks et al., CVPR 2019](https://openaccess.thecvf.com/content_CVPR_2019/html/Brooks_Unprocessing_Images_for_Learned_Raw_Denoising_CVPR_2019_paper.html)
- Shot/read/row/quantization formation model: [Wei et al., CVPR 2020](https://openaccess.thecvf.com/content_CVPR_2020/html/Wei_A_Physics-Based_Noise_Formation_Model_for_Extreme_Low-Light_Raw_Denoising_CVPR_2020_paper.html)
- Pattern-aligned real dark-noise sampling: [Zhang et al., ICCV 2021](https://openaccess.thecvf.com/content/ICCV2021/html/Zhang_Rethinking_Noise_Synthesis_and_Modeling_in_Raw_Denoising_ICCV_2021_paper.html)
- Dark-frame-efficient calibration: [Li et al., CVPR 2025](https://openaccess.thecvf.com/content/CVPR2025/papers/Li_Noise_Modeling_in_One_Hour_Minimizing_Preparation_Efforts_for_Self-supervised_CVPR_2025_paper.pdf)
- Practical compact sensor-specific network: [Wang et al., ECCV 2020](https://www.ecva.net/papers/eccv_2020/papers_ECCV/papers/123510001.pdf)
- Current real-world RAW architecture/data evidence: [AIM 2025 RAW Denoising Challenge](https://openaccess.thecvf.com/content/ICCV2025W/AIM/papers/Li_AIM_2025_Challenge_on_Real-World_RAW_Image_Denoising_ICCVW_2025_paper.pdf)
- Classical collaborative filtering: [Dabov et al., BM3D, IEEE TIP 2007](https://web.eecs.utk.edu/~hqi/ece692/references/noise-BM3D-tip07.pdf)
- Sensor calibration method: [EMVA 1288](https://www.emva.org/wp-content/uploads/EMVA1288-3.1a.pdf) and [ISO 15739:2023](https://www.iso.org/standard/82233.html)
- WebGPU inference and graph capture: [ONNX Runtime Web WebGPU](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)

## Self-Review

- Spec coverage: optional switch, ISO mode, objective noise auto-gate, old-camera low-ISO behavior, metadata priority, classical fallback, learned engine, previews, telemetry, training, and release tests each map to a task.
- Type consistency: `NoiseCoefficients`, `NoiseModel`, `NoiseMetrics`, `DenoiseOptions`, `DenoiseDecision`, and `DenoiseSession` names remain unchanged across tasks.
- Behavioral safety: no-denoise path stays separate; missing metadata fails closed; model failure falls back from an untouched owned mosaic.
- Scope safety: protected progressive JXL files are absent from the file map.

