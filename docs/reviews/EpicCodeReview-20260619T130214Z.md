# EpicCodeReview — raw-pipeline parsers/decoders

**Run:** `20260619T130214Z` · **Branch:** `epiccodereview/raw-parsers-20260619T130214Z` · **Mode:** workalone (Sonnet) · **Date:** 2026-06-19

**Target (6 files, 6578 LOC):**
`tiff.rs` (ORF/DNG IFD parser) · `cr2.rs` (Canon CR2) · `dng.rs` (DNG IFD walker) · `ljpeg.rs` (lossless-JPEG SOF3) · `decompress.rs` (Olympus 12-bit predictive) · `demosaic.rs` (Bayer→RGB16).

## Outcome

| | count |
|---|---|
| Findings (5 finders) | 61 |
| Confirmed by verifier | 56 |
| False positives dropped | 5 |
| Uncertain | 0 |
| **Correctness issues fixed + committed** | **13** |
| Opportunities deferred → ADR drafts | 8 themes |
| Perf opportunities measured (flipflop) | 2 (1 win, 1 rejected) |

One section, one fix commit: **`782a28b8`** (5 files, +164/−42). Baseline & post-fix: **135 lib tests pass, 0 failed** (`cargo test --no-default-features --lib`).

## What was fixed (committed)

All are untrusted-input bounds/overflow hardening — divergent paths brought up to the standard siblings already used. **Matters on wasm32** (32-bit usize → additive offset guards `p + ts > len` silently *wrap* and bypass the check; this crate ships to wasm).

| Sev | File | Fix |
|-----|------|-----|
| HIGH | cr2.rs | `read_u16`/`read_u32` no longer panic on OOB (return 0 like dng); `entry_first_u32`/CR2Slices/strip bounds use `checked_add` |
| HIGH | dng.rs | uncompressed-tile path now bounds-checks `tile_offsets`/`tile_byte_counts` (compressed path already did; uncompressed didn't) |
| MED | dng.rs | strip `row_start` checked arithmetic; tile-blit source read bounded; fused-demosaic incomplete decode returns `Err` (was silent zero-pad + `eprintln`, invisible in wasm); `align_to_rggb` doc/naming fixed (returns *stride*, not width) |
| MED | tiff.rs | `parse_olympus_makernote` + 3 bench helpers use `checked_add` + `.get()` |
| MED | demosaic.rs | `demosaic_rggb_mhc_band` enforces even-`halo` precondition (odd halo silently swapped R/B) |
| LOW | ljpeg.rs | unknown-segment skip (`decode_tile_impl` + `probe_tile`) bounds the `pos` advance against buffer; hot-loop up-front index bound documented as sufficient (hot path untouched) |

Root cause across cr2/dng/tiff: **three divergent copies of the same IFD value readers** — one panicked, one returned 0, one returned `Result`. Patched all three; consolidation proposed as ADR-1.

## flipflop timings (the headline ask)

Two perf opportunities were measured on the native flipflop harness (`node --expose-gc flipflop.mjs`, interleaved A/B, 1024²+2048², fractal corpus mandel/fbm/branch). Journal: `docs/outputs/timing tests/flipflop/flipflopjournal.toon`.

### ✅ demosaic-mhc — generic per-pixel CFA dispatch vs RGGB-specialized — **~22% win, trust:high**

`demosaic_bayer_mhc` (per-pixel 4-way `(row%2,col%2)` match + per-neighbor clamp) vs `demosaic_rggb_mhc` (specialized, no runtime dispatch), pixel-exact for RGGB:

| input | generic (ms, warm median) | rggb-specific | %saved | trust |
|-------|--------:|--------:|------:|-------|
| mandel@1024 | 969.4 | 746.6 | **23.0** | high |
| mandel@2048 | 1171.7 | 903.8 | 22.9 | low* |
| fbm@1024 | 1116.4 | 802.5 | **28.1** | high |
| fbm@2048 | 1536.5 | 1287.0 | 16.2 | high |
| branch@1024 | 1003.3 | 794.8 | **20.8** | high |
| branch@2048 | 1065.4 | 853.5 | 19.9 | high |

**Geomean 21.9% faster.** Consistent across types/sizes, mostly trust:high (*one 2048 row throttled). Far above the 5% gate → the dispatch-elimination + MHC-SIMD refactor (ADR-4) is justified **by measurement**, not just argument. MHC is the default quality kernel (~2× bilinear) and has *no* SIMD on any target today — biggest remaining demosaic win.

### ❌ dng-tile-decode — per-pixel endianness branch vs hoisted vectorizable — **REJECTED**

| input | branched (ms) | hoisted | %saved | trust |
|-------|--------:|--------:|------:|-------|
| mandel@1024 | 1202.4 | 1253.0 | −4.2 | low |
| mandel@2048 | 1508.0 | 1623.4 | −7.7 | low |
| fbm@1024 | 1470.8 | 1838.2 | −25.0 | low |
| fbm@2048 | 2322.5 | 2404.6 | −3.5 | low |
| branch@1024 | 2526.5 | 2698.7 | −6.8 | low |
| branch@2048 | 3116.2 | 2516.9 | +19.2 | low |

**Geomean 3.8% *slower*; −25%…+19% swing; trust:low on 11/12 rows** (stdev 127–574 ms, thermal unknown). Noise-dominated, no reliable win above gate. The uncompressed-DNG path is also cold (runs once) and bandwidth-bound, so branch removal buys little. **Branched code left as-is.** Re-measure only on a thermally-stable box (LibreHardwareMonitor running) if revisited.

> Thermal caveat: this box reports `throttled: unknown` (static CPU clock, no LibreHardwareMonitor). The demosaic win is large + repeats across the interleave so it's trustworthy; the tile-decode result is within noise and is treated as a non-result.

## Deferred (ADR drafts — need ratification)

Full text: `.epiccodereview/20260619T130214Z/global/adr_draft/ADR-drafts.md`; summary in `QUESTIONS.md`.

1. **ADR-1** Shared bounded TIFF/IFD reader (root cause of the bounds drift).
2. **ADR-2** Unified `RawError` enum (anyhow/String/bail mix).
3. **ADR-3 (HIGH, platform)** Calibrated scene-referred `RawImageMeta` — currently drops black/white/iso/bits and collapses camera→XYZ to sRGB at decode; add "linear, not-tone-mapped" mode; re-enable CR2 per-model colour matrix. The biggest platform lever — turns these decoders into a calibrated sensor source for species-ID / photogrammetry / perceptual colour.
4. **ADR-4 (measured +22%)** Demosaic phased-MHC split + MHC SIMD + Laplacian CSE.
5. **ADR-6** Fast embedded-preview / LOD tier for CR2+DNG (ORF-only today) + AR half-res tier.
6. **ADR-7** Collapse 3× SOF3 parsers + 2× BitReaders.
7. **ADR-8** Wire "Perceptual Constancy Mode" (after ADR-3).
8. **ADR-5** — measured & rejected (above).

## False positives (verifier-dropped)

- `align_to_rggb col_off==1` accumulating R/B shear — math re-derived; +1 offset is uniform per row, re-phasing is correct (the real defect was the stride-as-width *name*, fixed).
- CR2 multi-slice `lw==0` silent black band — the `lw==0` guard makes the partial-raster branch dead code.
- tiff `as_rational` missing `count>=1` — `Reader::u32` is `.get()`-based, no panic.
- EXIF orientation 2/4/5/7 "silently unrotated" — `apply_orientation` (pipeline.rs) handles all of them with tests; prior deferred bug now implemented.
- DNG bench unchecked strip slices — real divergence but not reachable (`parse()` validates first); hardened anyway for consistency.

## Notes

- CodeQL not run: Rust requires build-mode extraction (not a no-build language) and the extractor isn't installed here.
- `web/worker.js` (pre-existing unrelated change) committed first as `782a28b8`'s parent on this branch, per user direction.
- Untracked `examples/orf_wb_probe.rs` pre-existed; left untouched.
- Add `.epiccodereview/` to `.gitignore` (workflow scratch).
