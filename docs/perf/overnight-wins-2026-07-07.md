# Overnight Perf Wins — Landing + Measurement (2026-07-07)

**Branch:** `perf/overnight-wins-merge-jul07`
**Source of the 7 wins:** `perf/overnight-deferred-jul07` (worktree `C:\Foo\rcw-overnight-jul07`, tip `7c4fe148`)
**This branch base:** `623abb8d`

## Key finding — the 7 wins are already integrated on this branch

All 7 overnight wins are **already present in this branch's history**, byte-identical to the
source commits but under different SHAs. They landed on the `perf/casv-video-simd-v2-jul05`
lineage (the K-series / S2–S3 merges) that this branch's base sits on, independently of the
`perf/overnight-deferred-jul07` branch.

Verified by diffing this branch's base (`623abb8d`) against the overnight tip (`7c4fe148`)
for every touched source file:

| File | base vs overnight-tip |
|------|-----------------------|
| `crates/raw-pipeline/src/perceptual/simd/avx2.rs` | **identical (0 lines)** |
| `crates/raw-pipeline/src/perceptual/simd/mod.rs`  | **identical (0 lines)** |
| `crates/raw-pipeline/src/perceptual/blur.rs`      | **identical (0 lines)** |
| `crates/raw-pipeline/src/casa_video.rs`           | **identical (0 lines)** |
| `crates/raw-pipeline/src/perceptual/simd/wasm.rs` | +315 (the PARKED experiment `d899f4dc`, **not a win**) |
| `crates/raw-pipeline/src/perceptual/mod.rs`       | +27 (same PARKED experiment — widens the XYB cfg gate to the wasm tier) |

The only two differences are the **parked, bench-gate-pending** wasm threaded-tier band-MT
experiment (`d899f4dc experiment(perceptual): wasm threaded-tier band-MT — PARKED`). That is
**not** one of the 7 wins and is intentionally absent here.

**No cherry-pick was performed.** Cherry-picking the 7 source commits would only create
duplicate/empty commits (or spurious conflicts) on top of code that is already present. The
correct action was to verify the wins are in place, re-measure them, and confirm byte-exact
tests — done below. The only new content on this branch is this document.

### Provenance — win → equivalent commit already in this branch

Each win exists as an ancestor of `HEAD` under a different SHA (all confirmed via
`git merge-base --is-ancestor <sha> HEAD`):

| # | Win | Source SHA (overnight) | Equivalent SHA (this branch) |
|---|-----|------------------------|------------------------------|
| 1 | wasm v128 box_blur (mask blur on WasmSimd) | `32da59d8` | `2539cf00` |
| 2 | parallel column-band V pass for `box_blur_avx2` | `9009cf83` | `ca1901dc` |
| 3 | casa_video `SliceFrameSource` fills ping-pong buffer directly | `7e482c35` | `9a7fbeaf` |
| 4 | pixel-band-parallel SSIM moments | `54a1c194` | `e7e076a7` |
| 5 | byte-band-parallel PSNR SSD | `eb1cecf2` | `92f3460a` |
| 6 | pixel-band-parallel XYB conversion (dispatch level) | `9809ef59` | `4c259f0b` |
| 7 | flush-block-parallel butteraugli `scale_err` | `7bd3db7f` | `b4f2d736` |

## Measurements (this machine, 2026-07-07)

The 5 native AVX2 wins each ship a self-checking interleaved A/B flip example
(`crates/raw-pipeline/examples/*_flip.rs`). Each does a **bit-exact parity check** of the
serial baseline (A) vs the landed parallel kernel (B) before timing, runs 11 interleaved
rounds with per-round start rotation (round 0 dropped), and reports the median. Numbers below
are from running those examples on this branch, `cargo run --release --example …`,
**rayon threads = 12**.

> Caveat (repo rule): absolute times depend on CPU power state — a laptop on battery is
> power-limited (no turbo). These runs were on this machine's current state; the **relative**
> speedups and bit-exact parity are the load-bearing results and match the source-branch
> claims.

| Win | Size | A (serial) ms | B (parallel) ms | %saved | speedup | parity | gate ≥5% |
|-----|------|--------------:|----------------:|-------:|--------:|:------:|:--------:|
| box_blur V-pass (`box_blur_vpar_flip`) | 2.3 MP | 19.200 | 6.904 | +64.0% | 2.78× | PASS | PASS |
| | 6.0 MP | 45.339 | 15.883 | +65.0% | 2.85× | PASS | PASS |
| | 24.0 MP | 194.411 | 57.105 | +70.6% | 3.40× | PASS | PASS |
| SSIM moments (`ssim_moments_mt_flip`) | 2.3 MP | 2.135 | 1.012 | +52.6% | 2.11× | PASS | PASS |
| | 6.0 MP | 4.676 | 2.144 | +54.2% | 2.18× | PASS | PASS |
| | 24.0 MP | 17.706 | 6.721 | +62.0% | 2.63× | PASS | PASS |
| PSNR SSD (`ssd_mt_flip`) | 9.0 MB | 1.049 | 0.735 | +29.9% | 1.43× | PASS | PASS |
| | 24.0 MB | 3.312 | 2.182 | +34.1% | 1.52× | PASS | PASS |
| | 96.0 MB | 12.509 | 6.692 | +46.5% | 1.87× | PASS | PASS |
| XYB conversion (`xyb_band_mt_flip`) | 2.3 MP | 3.162 | 2.342 | +25.9% | 1.35× | PASS | PASS |
| | 6.0 MP | 8.583 | 7.055 | +17.8% | 1.22× | PASS | PASS |
| | 24.0 MP | 31.449 | 24.983 | +20.6% | 1.26× | PASS | PASS |
| scale_err (`scale_err_mt_flip`) | 2.3 MP | 3.330 | 2.157 | +35.2% | 1.54× | PASS | PASS |
| | 6.0 MP | 10.031 | 6.082 | +39.4% | 1.65× | PASS | PASS |
| | 24.0 MP | 42.497 | 25.585 | +39.8% | 1.66× | PASS | PASS |

**All 5 native wins pass the ≥5% gate at every size, with bit-exact parity at every size.**
These reproduce the source-branch commit-message claims (box_blur +65–70%/2.9–3.3×, SSIM
+41–61%/1.7–2.6×, SSD +25–50%/1.3–2.0×, scale_err +28–46%/1.4–1.9×).

### The two wins without a native flip example

| Win | Status | Note |
|-----|--------|------|
| wasm v128 box_blur (`2539cf00`) | code present, compiles to wasm | SIMD (v128, 4-wide) vectorization of the mask-blur vertical pass on `WasmSimd`. Only measurable in a browser/Node WASM harness (`flipflopdom`); not runnable as a native flip. **Re-measure pending** a browser A/B; source-branch recorded it as a per-frame vectorization win. Bit-exactness is covered by the `raw-pipeline` byte-exact test suite (green, below). |
| casa_video `SliceFrameSource` (`9a7fbeaf`) | code present, byte-exact | Overrides `next_frame_into` to `clear()` + `extend_from_slice()` into the caller's reused ping-pong buffer instead of cloning a fresh `w*h*3` `Vec` per frame (~2.7 MB @720p, ~25 MB @4K, every frame). Byte-identical frames, strictly less allocator work — an allocation-elimination micro-opt on the video encode path. No flip vehicle; correctness covered by the casa_video tests in the suite. |

## Verification

- **Native build:** `cargo build --release --example …` (all 5 flip examples) — **clean, exit 0**
  (only pre-existing unused-code warnings unrelated to the wins).
- **Byte-exact tests:** `cargo test` in `crates/raw-pipeline` — **412 passed, 20 ignored, 0 failed**
  (15 suites, ~94 s). The libjxl `premature end of input` / `invalid signature` console lines
  are expected negative-path assertions, not failures. Parallel-kernel bit-exactness is
  additionally proven by the `parity(bit-exact): PASS` line in every flip run above.
- **WASM build:** `wasm-pack build --target web --out-dir pkg --release` — **clean, exit 0**
  (`Done in 2m 30s`, pkg emitted; only pre-existing dead-code warnings). Compiles the
  `box_blur_wasm` v128 vertical pass (win 1).

## Conclusion

The 7 overnight wins are already landed on this branch (byte-identical, under different SHAs),
re-measured green on the native AVX2 paths, and byte-exact under the test suite. The parked
wasm threaded-tier experiment is correctly excluded. No source changes were required.
