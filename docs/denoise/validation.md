# Noise-Aware RAW Denoise — Validation Report

Generated: 2026-07-12
Model: `raw-denoise-v1` (development artifact, random weights — 2.7 MB, hash verified)
Branch: `feat/noise-denoise-t5`

---

## Infrastructure Status

These gates are verified by code structure, automated tests, or runtime artifact
checks. They do not require a real camera corpus or a trained model.

| Gate | Status | Evidence |
|------|--------|----------|
| Disabled / below-threshold result is identical to no-denoise oracle | Code-enforced | `process_*_with_options` returns before BM3D when `!decision.apply`; `raw-denoise-e2e.test.js` test 6 asserts `denoise_requested=false` and pixel buffer untouched |
| No camera selected from age alone | Code-enforced | `policy.rs` has no year/date field; `NoiseCoefficients` contains only `shot_noise` + `read_noise` coefficients; `raw-denoise-e2e.test.js` implicitly covered by activation=auto/iso/always — no age field exists |
| Unknown ISO / noise unavailable skips safely | Code-enforced | `decide()` returns `Reason::NoiseUnavailable` when estimator returns 0; no substitution of a default ISO; `raw-denoise-e2e.test.js` tests 4a, 4b assert `denoise_reason=noise_unavailable` / `iso_unavailable` |
| No tile seam exceeds 1 RGB16 code (constant-field) | Tests pass | `denoise_quality.rs` gate4 runs BM3D on a constant-field mosaic and asserts `max_diff=0`; covered by `cargo test -p raw-pipeline` |
| Model hash verified at runtime | Runtime check | `raw-denoise-runtime.js` SHA-256 vs `manifest.sha256` before ORT session creation; `raw-denoise-runtime.test.js` "manifest hash mismatch" test covers rejection path |
| Model artifact ≤ 8 MiB | Dev artifact: 2.7 MB | `web/models/raw-denoise-v1.ort`: 2,807,000 bytes; `denoise-benchmark.mjs --dry-run` reports `artifact_size_ok=true`; `raw-denoise-v1.json` records `artifact_size_ok=true` |
| WebGPU failure falls back to classical | Code-enforced | `raw-denoise-runtime.js` `createOrtSession` catches WebGPU init error and falls back to `wasm` EP; `raw-denoise-e2e.test.js` test 5 asserts `denoise_backend='classical'` on failure |
| canSplit=false for ORF when denoise enabled | Code-enforced | `worker.js` gate: `canSplit = nativeRaw && interactive && rawKind === 'orf' && !denoise.enabled`; `worker-denoise-routing.test.js` + `raw-denoise-e2e.test.js` test 8 assert this contract |
| ORT tensors disposed after each tile | Code-enforced | `raw-denoise-runtime.js` `finally` block disposes input + output tensor after every tile; `raw-denoise-runtime.test.js` input/output disposal tests cover the contract |
| No retained WASM session state between decodes | Code-enforced | Session variable is local to the decode call; `raw-denoise-e2e.test.js` test 9 asserts session reference is nulled after result consumed |

---

## Pending — Requires Real Camera Corpus and Trained Model

These gates are **manual**: they can only be verified with at least 50 real camera
RAW scenes (a `holdout` split) and a production-trained model. The development
artifact (`raw-denoise-v1.ort`) has random weights and must not be used for
quality evaluation.

| Gate | Requirement | Corpus Minimum |
|------|-------------|----------------|
| Old noisy-sensor holdout (ISO 200/400) triggers from noise score or NoiseProfile | Real camera corpus + trained model | 20+ holdout scenes from old sensors |
| Clean low-ISO holdout remains off (no false positives) | Real corpus | 20+ clean ISO 100–400 holdout scenes |
| No camera median colour regression > ΔE00 0.5 vs no-denoise reference | Trained model + holdout evaluation; `colour-verify.mjs` extended for denoise path | 30+ scenes across format types |
| Learned model beats classical BM3D and old Gaussian (PSNR/SSIM on holdout) | Trained model + holdout evaluation | 50+ holdout scenes |
| WebGPU p50 denoise time ≤ 2× existing decode+demosaic+tone-map time | Browser benchmark (`flipflopdom`) | Representative 24 MP DNG / ORF |
| Classical fallback p50 ≤ 30 s for 24 MP | Timing measurement; Node.js `--prof` or `tools/denoise-benchmark.mjs --with-metrics` with a real browser harness | 24 MP test file |
| 24 MP combined peak working memory ≤ 768 MiB | Heap profiling (Chrome DevTools `performance.measureUserAgentSpecificMemory`) | 24 MP test file |

---

## Benchmark Tooling

`tools/denoise-benchmark.mjs` orchestrates corpus-level reporting:

```
node tools/denoise-benchmark.mjs --manifest docs/denoise/corpus-manifest.template.json --dry-run
```

In dry-run mode it validates the manifest schema, checks that all file paths in
the manifest exist on disk, verifies the model artifact size and SHA-256, and
prints a gate summary. A populated `corpus-manifest.json` following
`docs/denoise/dataset-manifest.schema.json` (schemaVersion 1) is required for a
full run.

---

## Test Suite Summary

| Suite | Runner | Count | Status |
|-------|--------|-------|--------|
| `web/raw-denoise-options.test.js` | bun test | 22 | PASS |
| `web/raw-denoise-runtime.test.js` | bun test | 10 | PASS |
| `web/worker-denoise-routing.test.js` | bun test | 5 | PASS |
| `web/raw-denoise-e2e.test.js` | bun test | 21 | PASS |
| `cargo test -p raw-pipeline` | cargo | all | PASS |

---

## Architecture Notes

### Why camera age is not a trigger

Denoise is activated by the measured or estimated noise level, not the camera's
release year. The policy module (`crates/raw-pipeline/src/denoise/policy.rs`)
contains only calibrated noise coefficients — no model year, no camera name
matching. An old camera at base ISO may produce a clean signal; a new camera at
high ISO may produce significant noise. The activation decision is always
driven by the noise score or the ISO tag.

### Disabled path hash equivalence

When `enabled=false`, the decode pipeline returns before any BM3D or learned
inference step. The pixel buffer that reaches the caller is the same buffer
produced by the standard `process_*_with_options` call with denoise disabled.
There is no extra copy or transformation — the disabled result is
pixel-for-pixel identical to a no-denoise decode of the same file.

### WebGPU / classical fallback transparency

The fallback is transparent to the caller: `process_dng_with_options` and
`process_orf_with_options` return the same result shape regardless of whether
denoise used ORT WebGPU, ORT WASM, or the classical BM3D path. The
`denoise_backend` field in the result records which path was taken.

### Tile seam contract

BM3D operates on 320×320 tiles with a 32-pixel halo overlap. The tile assembly
step (`commit_output_tile` → `finish_with_options`) blends overlapping halos.
The `gate4` test in `denoise_quality.rs` verifies that on a constant-valued
mosaic the output has `max_diff=0` between adjacent tile boundaries — i.e. zero
visible seam for flat inputs. Textured inputs are validated by the quality
metrics gates above (pending real corpus).
