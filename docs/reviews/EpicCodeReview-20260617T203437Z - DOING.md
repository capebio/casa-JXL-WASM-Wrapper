# EpicCodeReview — Rust RAW→JXL Pipeline

**Target:** `crates/raw-pipeline/src` · **Focus:** performance/speed + elegant architecture
**Run:** `.epiccodereview/20260617T203437Z` · **Mode:** workalone (Sonnet) · **Date:** 2026-06-17/18
**Baseline & final test:** `cargo test --no-default-features --lib` → **104 passed, 7 ignored (GREEN, unchanged)**

> Report is timestamped (`-20260617T203437Z`) so concurrent/repeat EpicCodeReview runs don't overwrite each other — the earlier un-suffixed `EpicCodeReview.md` from this run was in fact clobbered by a concurrent run before this fix landed.

---

## Headline (both sections complete)

- **227 candidate findings** (S0 core pipeline 148 + S1 perceptual 79) from 7 parallel finders each (logic, security/safety, concurrency, errors, contracts, performance, **architecture**) → **180 confirmed**, 37 false-positive, 10 uncertain after independent verification.
- **54 fixes applied** — all *safety-hardening* or *provably output-identical* perf / parity-restoring. Zero pixel/colour/metric-value change for valid inputs. Tests stay green throughout (**104 passed, 7 ignored**).
- **2 commits** on `epiccodereview/20260617T202430Z`: `1281f6f7` parsers (29) + `952a2df6` perceptual SIMD (20). Remaining 5 applied edits (casabio_encode.rs ×3, jxl_decode.rs ×2) left **uncommitted** — entangled with the concurrent BSD refactor.
- **~49 deferred** to `QUESTIONS.md` — every behaviour-changing colour/demosaic/stats/metric fix and every perf change needing benchmark evidence, per your CLAUDE.md guardrails + colour-parity rule (*report numbers, you verify on real cameras*).

Fix policy was deliberately conservative: this is a hot, colour-critical pipeline with no pixel-exact output tests in the default suite, so "tests pass" ≠ "output unchanged." Anything that could move a valid file's pixels/metrics was deferred for you to ratify, not auto-applied.

---

## Section 0 — core pipeline (`(root)`, 13 files) — committed `1281f6f7`

### Performance (output-identical) — the real hot-path wins
| File | Fix |
|------|-----|
| `pipeline.rs:806` | **Removed `eprintln!` from `perceptual_apply_bulk`** — ran a stderr lock + format on *every 64px tile* of the tone pass under `c-perceptual`. Pure serializer removal. **[high]** |
| `pipeline.rs:546` | Hoisted `y*width` base out of the separable-blur border kernel-tap loop (bit-identical). |
| `casabio_encode.rs:343` | `rgba_to_rgb` now `extend_from_slice(&px[0..3])` instead of 3× `push` (byte-identical, vectorizable). |
| `dng.rs:1194` | Reuse the per-tile-row halo context `Vec` instead of reallocating each row (constant size, fully overwritten → identical). |

### Memory-safety / DoS hardening on untrusted file parsing (the real attack surface)
- **`tiff.rs` (8):** `parse_header` length guard (no panic on <4-byte input); checked IFD-entry offset math; bounds-checked `Reader::u16/u32`, `as_rational*`; checked `extract_thumbnail_jpeg`; saturating arithmetic across Olympus MakerNote/sub-IFD parsers; `strip_offset+byte_count ≤ data.len()`.
- **`dng.rs` (9):** bounds-safe `read_u16/u32/i32`; **decompression-bomb cap** (200 MP saturating-`u64` before `vec![0u16; w*h]`/`*3`, also fixes wasm `usize` under-alloc); `tw/tl==0` div-by-zero guards; `checked_mul` on `coltiles*rowtiles`; `off.checked_add(bc)` before every tile/strip slice; capped `read_array_u32` capacity.
- **`cr2.rs` (4):** guard `1u16 << precision` against `precision ≥ 16`; `checked_add` in `read_ascii` + MakerNote-WB offset path (zero-alloc WB preserved); `bail!` on `decoded_width != stride` CR2Slices inconsistency.
- **`ljpeg.rs` (2):** `decode_tile`/`decode_tile_stats` validate the max write index via checked arithmetic before the entropy loop — closes the OOB the prose contract never enforced. All 3 callers verified in-bounds.
- **`demosaic.rs` (1):** band helpers validate `ctx.len() ≥ width*ctx_h` before the `get_unchecked` inner loop (load-bearing; dng.rs:1284 confirms this path has OOB'd).
- **`jxl_decode.rs` (2, uncommitted):** `checked_mul/add` on JXTC index-table + per-tile offsets; `tile_pixels.len() ≥ tw*th*bpp` guard before stitch. *(Applied here because `jxl_lowlevel.rs` was deleted by the concurrent BSD refactor mid-run.)*

### Contracts / errors (guard-only)
`casabio_encode.rs` `checked_mul` on `w*h*4` + `encode_into` buffer-length guard (uncommitted); `frame_stats.rs` `analyze_scalar` clamps `px` to `d.len()/4`; `pipeline.rs` `process_rgba` debug-assert → release `assert`; `decompress.rs` documented the `decompress_rows_into` rows-written contract.

---

## Section 1 — perceptual SIMD metrics (`perceptual/`) — committed `952a2df6`

70 confirmed of 79 candidates. The standout was **soundness**, not just speed:

**Applied (20, all parity-preserving):**
- **`mod.rs`: forced AVX2/AVX-512 backend was selected with no `is_x86_feature_detected!` guard** → UB/SIGILL on any CPU lacking the feature (reachable via `examples/perceptual_flipflop.rs` / `BackendChoice::Force`). Now runtime-gated with `avx512 → avx2 → scalar` fallback. On a capable CPU the chosen path is identical.
- **`avx2.rs`: `ssd_avx2` accumulated squared u8 diffs in i32 lanes** → wrapped after ~258 KB, silently diverging from the scalar `u64` PSNR oracle on megapixel frames. Now drains to `u64` periodically → exact scalar parity restored (small images bit-identical).
- **SIMD OOB hardening** across `avx2/avx512/wasm` (`pixels_to_xyb`, `scale_err`, `downsample`, `ssim_moments`): entry length guards so `get_unchecked` / `loadu`-to-`n` / `storeu` can't run past a slice end on adversarial dims (no-op for valid sized buffers). `avx2` uses release `assert!`; `avx512`/`wasm` use `debug_assert!`.
- **`mod.rs`: `Comparer::new` `width*height*4`** now `checked_mul` (32-bit/wasm overflow → under-alloc → OOB).
- Dimension/zero-dim/div-by-zero guards across `ssim.rs`, `psnr.rs` (length-equality → `NaN` convention), `blur.rs`, `butteraugli.rs` (`box_blur`/`dn2`/`scale_err` `n==0`).

**Deferred (the memory-bound perf + architecture payload):**
- **`Comparer::all()` walks the buffers ~4× (XYB, SSIM, PSNR as separate full passes)** — biggest memory-bound win; wants one fused streaming pass. `channel_moments`/SSIM recompute the same sums (provably reusable once plumbed). **FLIPFLOP VERDICT (2026-06-18): psnr+means fusion is 9.3% SLOWER (separate loops vectorize better). Do not fuse. See rejected optimizations.md.**
- f32-vs-scalar-f64 accumulator in `scale_err` (all three SIMD backends) — a uniform-value change needing ADR sign-off.
- Contract gaps: 8-bit-RGBA input assumed but unvalidated; metrics return bare `f32` overloading `NaN`/`Inf` as undocumented sentinels (want a result newtype + `PixelView`).

---

## Performance roadmap (deferred — need benchmark evidence per your "no tunables without data" rule)

Ranked by likely payoff on the cost-center (memory: *tone/`apply_tone_math` = 70%, compute-bound*):

1. **`pipeline.rs:701` unsharp clarity pass is single-threaded scalar** over the whole RGB16 buffer — prime rayon-row + SIMD candidate (same shape as the already-SIMD tone path).
2. **`pipeline.rs:888` `apply_perceptual_constancy` recomputes ln/exp/sqrt per pixel, no LUT** — despite the dormant `PerceptualGrid`. Matches your open ToneSimd-LUT plan.
3. **`Comparer::all()` 4× buffer walk** (perceptual) — fuse to one streaming pass; memory-bound win. **FLIPFLOP VERDICT (2026-06-18): fusion is 9.3% SLOWER. Rejected. See docs/rejected optimizations.md.**
4. **`demosaic.rs:379` wasm SIMD path** scatters 8 vectorized px via 24 scalar indexed stores — the scatter eats the win.
5. **`demosaic.rs:838` per-pixel 4-way CFA `match` + border clamp** in the interior loop — hoist phase out. **FLIPFLOP VERDICT (2026-06-18): rggb-specific is 21.9% faster vs generic. However, RGGB DNG files already use `demosaic_rggb_mhc` (guarded by `if cfa != Cfa::Rggb`). Only non-RGGB DNG (GBRG/GRBG/BGGR) uses the generic path. Specialised GBRG/GRBG/BGGR functions would give similar speedup but are low priority (rare cameras).**
6. **`dng.rs:228` uncompressed tile/strip decode fully serial** with a per-pixel endianness branch. **FLIPFLOP VERDICT (2026-06-18): hoisted 0.5% faster, trust:low. LLVM already strength-reduces the branched version. Rejected. Real gain requires explicit SIMD intrinsics. See docs/rejected optimizations.md.**
7. `pipeline.rs:1393` `apply_luminance_nr`, `pipeline.rs:1503/1493` downscale; `frame_stats.rs:127` AVX2 luma f64-per-lane; `ljpeg.rs:388` DHT cache rebuilt+linear-searched per segment; `dng.rs:174` per-tile `Vec` alloc in parallel map.

Each is a clean isolated experiment — happy to wire one behind a bench and measure.

---

## Architecture & elegance roadmap (your headline ask)

The kernels are correct and fast, but the **structure fights both speed and clarity**. The intended dataflow — `RAW → unpack → demosaic → colour → tone → encode` — is nowhere a type or seam; it lives implicitly in external callers (`lib.rs` is just module decls). High-leverage moves:

### 1. One shared TIFF/IFD reader *(high — correctness + size)*
`tiff.rs`, `cr2.rs`, `dng.rs` each hand-roll IFD walking/endianness/offset math. Three copies = three homes for the OOB bugs this review patched 3× independently. **Elegant form:** one `tiff::Reader` with a visitor/iterator; CR2/DNG consume it. Every bounds guard exists once.

### 2. A unified `RawImage` + `RawDecoder` trait *(high — the missing spine)*
`Cr2Image`, `DngImage`, `OrfInfo+raw`, `DngDemosaiced` carry the same fields with no shared contract. **Elegant form:** `struct RawImage { plane, width, height, cfa, black, white, wb, color_matrix }` + `trait RawDecoder`. Makes the `color_matrix: None`-means-identity ambiguity (a deferred colour bug) impossible by construction.

### 3. A `Demosaic` enum/trait seam + de-duplicated kernel *(high — perf-enabling)*
The bilinear RGGB interior + SIMD `avg4/avg2/parity` body is **copy-pasted across 5 functions** (the pink-veil fix had to land in every copy). Selection is by *function name*. **Elegant form:** `enum Demosaic { Bilinear, Mhc, Half, … }` dispatched once; one kernel body — which is also what lets you cleanly benchmark/swap kernels.

### 4. Decompose the two god-functions *(high — helps the optimizer)*
`process_into` fuses LUT-cache + cfg dispatch + raw-pointer loop + 4-wide + c-perceptual tile path; `decode_bytes_demosaiced_impl` is ~240 lines fusing IFD parse + tile decode + halo carry + band demosaic with a bench-only `subtract_black` bool. Split into named stages → readability + smaller inlinable units. (`decode_tile` vs `decode_tile_stats` ~250 duplicated lines → collapse via a generic stats sink.)

### 5. One `RawError` + move orientation out of the tone module *(medium)*
Error handling mixes `String`, real `anyhow`, a **fake local `anyhow!` macro in `tiff.rs`**, and `thiserror`. Collapse to one `thiserror` `RawError`. EXIF orientation lives in `pipeline.rs` (tone) and **silently no-ops mirror/transpose 2/4/5/7** — belongs in its own `orientation` step on `RawImage`.

### 6. Collapse the AVX2/AVX-512/wasm SIMD triplication *(high — one math source of truth)*
In `perceptual/simd/`, `scale_err`, `pixels_to_xyb`, `downsample` are the **same kernel copy-pasted three times** (only intrinsics differ), and each re-inlines the scalar tail math → drift risk. This review applied the OOB guard 3× and the f32-accumulator fix is deferred *precisely because* it spans all three. **Elegant form:** one lane-width-generic kernel over a small SIMD trait (or `std::simd`/macro), with the scalar path as the single reference the backends test against. Backend selection (`mod.rs`, magic `Force(u8)` table) → one typed dispatcher.

**Lower-leverage:** `apply_look_params`'s 12 positional `f32` args → a `LookParams` struct; shared generic for the 3 LUT-build fns and `downscale_rgb8/16/rgba`; one camera-matrix colour helper shared by cr2/dng (cr2 reaches into dng internals); a metric-result newtype so PSNR(dB) and SSIM(0..1) can't be mixed.

> None applied — cross-cutting refactors touching public shapes, need your sign-off. They're the "beautiful architecture" payload; I can sequence them as a TDD plan (start #1 + #2, which de-risk the rest).

---

## Deferred (~49) — behaviour-changing, need your verification on real files

Full list with concrete suggested patches in **`QUESTIONS.md`**. Highest-risk colour/correctness ones:
- **`dng.rs` `align_to_rggb` no-ops Grbg/Bggr column phases** — visible wrong colour for those CFAs.
- **`dng.rs` per-CFA-channel BlackLevel** — only element 0 kept.
- **`cr2.rs` crop uses `stride` for source vs `decoded_width` for centering** — now guarded (bail on mismatch); geometry fix needs CR2Slices files.
- **`frame_stats.rs` `luma_variance / 65536` scale** + the `frameHash` endianness contract (flagged **do-not-touch** — deliberate stable consumer contract).
- **`pipeline.rs` `color_matrix None == generic CAM_TO_SRGB`** + **orientation 2/4/5/7** pass-through.
- **`casabio_encode.rs` `has_alpha` measured on full-res but applied to downscaled** preview/thumb buffers.

---

## Git

- `1281f6f7` — 8 clean parser/pipeline files (cr2, decompress, demosaic, dng, frame_stats, ljpeg, pipeline, tiff).
- `952a2df6` — 8 perceptual files (blur, butteraugli, mod, psnr, ssim, avx2, avx512, wasm).
- **Uncommitted** (entangled with the concurrent BSD-JXL refactor, yours to reconcile): `casabio_encode.rs` (3 guards), `jxl_decode.rs` (2 guards). Plus everything external (`crates/jxl-ffi/`, `Cargo*`, `lib.rs`, `vendor/jpegxl-src/`, scheduler `.ts`). Nothing pushed; no history rewritten. Branch shared — other parallel runs landed commits between mine; both EpicCodeReview commits intact.
- Housekeeping: add `.epiccodereview/` to `.gitignore`.

## Next steps (your call)
1. **Apply the architecture roadmap** — sequence #1 (shared TIFF reader) + #2 (`RawImage`/`RawDecoder`) first as a TDD plan.
2. **Benchmark-gate one perf win** — strongest candidate: fuse `Comparer::all()`'s 4 buffer passes, or wire the LUT into `apply_perceptual_constancy`.
3. **Verify the deferred colour bugs on real files** — `align_to_rggb` Grbg/Bggr + orientation 2/4/5/7 most likely visibly wrong.
