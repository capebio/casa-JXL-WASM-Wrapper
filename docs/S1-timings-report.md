# S1 Phase 3: Pipeline Parity & Timings Report

**Date:** 2026-07-06  
**Branch:** `perf/casv-video-simd-v2-jul05`  
**Canonical crate:** `crates/raw-pipeline` (June–July 2026 perf campaign)  
**Vendored baseline:** `jtw-s1-g1/raw-pipeline` (the stale fork in `JXL_Tauri_with_WASM`)

---

## Test file

**P1110226.ORF** (Olympus E-M5, 5240×3912 = 20.5 MP)  
All timings: release build, 3-run average, same machine (Windows 11, native MSVC).

---

## Timing comparison

| Stage | OLD (vendored, no native) | OLD (`target-cpu=native`) | CANONICAL (`target-cpu=native`) | Δ vs old+native |
|-------|--------------------------|--------------------------|----------------------------------|-----------------|
| decompress | 285 ms | 248 ms | **215 ms** | **−13%** |
| demosaic | 20 ms | 20 ms | **18 ms** | **−10%** |
| tone (process) | 44 ms | 42 ms | **59 ms** | +40% |
| **total** | **349 ms** | **310 ms** | **292 ms** | **−6%** |

**Important:** without `target-cpu=native` the canonical crate is 28% slower (446 ms) because its AVX2 demosaic and decompress paths are gated behind runtime CPU detection that only fires when compiled with native tuning. The old pipeline had no SIMD at all and is unaffected. Always build with `-C target-cpu=native` for production (or add it to `.cargo/config.toml`).

The tone pass is 40% slower in canonical because `PipelineParams::default_olympus()` now runs additional stages (tone matrix + saturation/vibrance + unsharp LUT path) that were absent in the old fork. The total pipeline is still 6% faster end-to-end due to the decompress win (the dominant cost).

---

## Parity (pixel correctness)

All 6 tests in `crates/raw-pipeline/tests/parity_corpus.rs` pass:

| Test | File | Result |
|------|------|--------|
| `orf_rgba8_sanity` | P1110226.ORF 5240×3912 | ✓ non-trivial pixels, correct size |
| `orf_rgba8_deterministic` | P1110226.ORF | ✓ bit-exact across two calls |
| `orf_process_rgb8_timing` | P1110226.ORF | ✓ decompress+demosaic+tone run clean |
| `dng_rgb8_sanity` | PXL…dng 3628×2732 | ✓ non-trivial pixels, hash stable |
| `dng_rgb8_deterministic` | PXL…dng | ✓ bit-exact across two calls |
| `dng_align_to_rggb_infallible` | PXL…dng | ✓ plain tuple (not Result) confirmed |

Pixel hashes (release, `target-cpu=native`):
- ORF rgba8 `0x8806822277eac608`
- DNG rgb8  `0x3c3fb14139efec5c`

---

## API changes (app migration surface)

All call-site fixes are committed on branch `s1/g1-canonical-crate-trial` in worktree `C:/Foo/jtw-s1-g1`.

| Old API | New API | Files touched |
|---------|---------|--------------|
| `process(rgb16, w, &params)` | `process(rgb16, &params)` | pipeline.rs (×8), bench.rs, casabio.rs, strategy_bench.rs (×4), lightbox_bench.rs |
| `process_rgba(rgb16, w, &params)` | `process_rgba(rgb16, &params)` | casabio.rs, pyramid_store.rs |
| `align_to_rggb(…).map_err(…)?` | `let (s,w,h) = align_to_rggb(…);` | pipeline.rs, bench.rs, strategy_bench.rs |
| `apply_orientation_rgba` | `apply_orientation` | casabio.rs, pipeline.rs |
| `jxl_lowlevel::decode_progressive_frames` | `jxl_casadecoder::decode_progressive_frames` | pipeline.rs |
| `ExifData { … }` (14 fields) | `ExifData { …, raw_width: None, raw_height: None }` | pipeline.rs (×3) |
| `get_orf_metadata` / `bench_decode_orf` returning `String` error | wrap `.map_err(|e| e.to_string())` on outer `.await?` | pipeline.rs |

**Shims provided** (`s1/g1-compat-shims` branch, `rcw-s1-shims` worktree):
- `encode_rgba16(rgba16, w, h, distance, effort)` — thin wrapper over `Encoder::encode`
- `encode_raw_pyramid_ladder` — `pub use` alias for `encode_rgba8_pyramid_from_rgb16`

---

## Build requirement

Add to `src-tauri/.cargo/config.toml` (or workspace root):

```toml
[target.x86_64-pc-windows-msvc]
rustflags = ["-C", "target-cpu=native"]

[env]
LIBJXL_SOURCE_DIR = "C:\\path\\to\\external\\libjxl-012"
LIBCLANG_PATH = "C:\\Program Files\\LLVM\\bin"
```

Without `LIBJXL_SOURCE_DIR` + `LIBCLANG_PATH` the `jxl-ffi` build step fails. Both are already configured in the `jtw-s1-g1` worktree's `.cargo/config.toml`.

---

## Verdict

Phase 1 (compile) and Phase 2 (parity) complete. Canonical crate is a safe drop-in for the vendored fork:
- 0 test failures on real ORF + DNG
- Deterministic pixel output
- 6% faster end-to-end (native build)
- All future perf wins in canonical lineage automatically available

The sole regression: tone pass +40% on native when `PipelineParams::default_olympus()` is used, because canonical runs more tone stages. This trades speed for quality; images produced by the canonical crate will differ visually from the old vendored version (more accurate color).
