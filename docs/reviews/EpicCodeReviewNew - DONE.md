# EpicCodeReview — Rust RAW→JXL Pipeline

**Target:** `crates/raw-pipeline/src` · **Focus:** performance/speed + elegant architecture
**Run:** `.epiccodereview/20260617T203437Z` · **Mode:** workalone (Sonnet) · **Date:** 2026-06-17
**Baseline & final test:** `cargo test --no-default-features --lib` → **104 passed, 7 ignored (GREEN, unchanged)**

> ⚠️ **Not committed.** During this run the working tree gained a large *concurrent* BSD-JXL refactor that is **not** part of this review (`jxl_lowlevel.rs`→`jxl_decode.rs`/`jxl_encode.rs`, new `crates/jxl-ffi/`, removed `vendor/jpegxl-src/`, plus `Cargo.toml`/`lib.rs`/scheduler `.ts` edits). RTK's `git status` reported "ok" at start and masked it. Committing now would entangle that half-applied refactor into an EpicCodeReview commit. **See "Git situation" at the bottom — awaiting your decision before any commit.**

---

## Headline (both sections complete)

- **227 candidate findings** (S0 core pipeline 148 + S1 perceptual 79) from 7 parallel finders each (logic, security/safety, concurrency, errors, contracts, performance, **architecture**) → **180 confirmed**, 37 false-positive, 10 uncertain after independent verification.
- **54 fixes applied** — all *safety-hardening* or *provably output-identical* perf / parity-restoring. Zero pixel/colour/metric-value change for valid inputs. Tests stay green throughout (**104 passed, 7 ignored**).
- **2 commits** on `epiccodereview/20260617T202430Z`: `1281f6f7` parsers (29) + `952a2df6` perceptual SIMD (20). Remaining 5 applied edits (casabio_encode.rs ×3, jxl_decode.rs ×2) left **uncommitted** — entangled with the concurrent BSD refactor.
- **~49 deferred** to `QUESTIONS.md` — every behaviour-changing colour/demosaic/stats/metric fix and every perf change needing benchmark evidence, per your CLAUDE.md guardrails + colour-parity rule (*report numbers, you verify on real cameras*).

Fix policy was deliberately conservative: this is a hot, colour-critical pipeline with no pixel-exact output tests in the default suite, so "tests pass" ≠ "output unchanged." Anything that could move a valid file's pixels was deferred for you to ratify, not auto-applied.

---

## Applied fixes (34) — safe hardening + free perf

### Performance (output-identical) — the one real hot-path win
| File | Fix |
|------|-----|
| `pipeline.rs:806` | **Removed `eprintln!` from `perceptual_apply_bulk`** — it ran a stderr lock + format on *every 64px tile* of the tone pass under `c-perceptual`. Pure serializer removal. **[high]** |
| `pipeline.rs:546` | Hoisted `y*width` base out of the separable-blur border kernel-tap loop (bit-identical). |
| `casabio_encode.rs:343` | `rgba_to_rgb` now `extend_from_slice(&px[0..3])` instead of 3× `push` (byte-identical, vectorizable). |
| `dng.rs:1194` | Reuse the per-tile-row halo context `Vec` instead of reallocating each row (constant size, fully overwritten → identical). |

### Memory-safety / DoS hardening on untrusted file parsing (the real attack surface)
- **`tiff.rs` (8):** `parse_header` slices behind a length guard (no panic on <4-byte input); checked IFD-entry offset math in `read_ifd`/orientation paths; bounds-checked `Reader::u16/u32`, `as_rational*`; checked `extract_thumbnail_jpeg`; saturating arithmetic across all Olympus MakerNote / sub-IFD parsers; `strip_offset+byte_count ≤ data.len()` validation.
- **`dng.rs` (9):** bounds-safe `read_u16/u32/i32`; **decompression-bomb cap** (200 MP saturating-`u64` check before `vec![0u16; w*h]` / `*3`, also fixes wasm `usize` under-alloc); `tw/tl==0` div-by-zero guards; `checked_mul` on `coltiles*rowtiles`; `off.checked_add(bc)` before every tile/strip slice; capped `read_array_u32` capacity.
- **`cr2.rs` (4):** guard `1u16 << precision` against `precision ≥ 16` (panic on malformed SOF3); `checked_add` in `read_ascii` and the MakerNote-WB offset path (zero-alloc WB preserved); `bail!` on `decoded_width != stride` CR2Slices inconsistency.
- **`ljpeg.rs` (2):** `decode_tile`/`decode_tile_stats` now validate the max write index (`base + (rows-1)*stride + cols-1 < out.len()`) via checked arithmetic before the entropy loop — closes the OOB/panic the prose contract never enforced. All 3 callers verified in-bounds → no valid-input change.
- **`demosaic.rs` (1):** band helpers (`demosaic_bayer_mhc_band`, `demosaic_rggb_mhc_band`) validate `ctx.len() ≥ width*ctx_h` (checked) before the `get_unchecked` inner loop — load-bearing (dng.rs:1284 comment confirms this path has OOB'd before).
- **`jxl_decode.rs` (2):** `checked_mul/add` on JXTC index-table + per-tile offsets; `tile_pixels.len() ≥ tw*th*bpp` guard before stitch copy. *(Applied here because `jxl_lowlevel.rs` was deleted by the concurrent refactor mid-run.)*

### Contracts / errors (guard-only)
- `casabio_encode.rs` `checked_mul` on `w*h*4` length check + `encode_into` buffer-length guard; `frame_stats.rs` `analyze_scalar` clamps `px` to `d.len()/4` (no panic on short input); `pipeline.rs` `process_rgba` debug-assert → release `assert` (4-channel buffer fails loud, not silent garbage); `decompress.rs` documented the `decompress_rows_into` rows-written contract.

---

## Section 1 — perceptual SIMD metrics (`perceptual/`) — committed `952a2df6`

70 confirmed of 79 candidates. The standout was **soundness**, not just speed:

**Applied (20, all parity-preserving):**
- **`mod.rs`: forced AVX2/AVX-512 backend was selected with no `is_x86_feature_detected!` guard** → UB/SIGILL on any CPU lacking the feature (reachable via `examples/perceptual_flipflop.rs` / `BackendChoice::Force`). Now runtime-gated with `avx512 → avx2 → scalar` fallback. On a capable CPU the chosen path is identical.
- **`avx2.rs`: `ssd_avx2` accumulated squared u8 diffs in i32 lanes** → wrapped after ~258 KB, silently diverging from the scalar `u64` PSNR oracle on megapixel frames. Now drains to `u64` periodically → exact scalar parity restored (small images bit-identical).
- **SIMD OOB hardening** across `avx2/avx512/wasm` (`pixels_to_xyb`, `scale_err`, `downsample`, `ssim_moments`): entry length guards so `get_unchecked` / `loadu`-to-`n` / `storeu` can't run past a slice end on adversarial dims (no-op for valid sized buffers). `avx2` uses release `assert!`; `avx512`/`wasm` use `debug_assert!`.
- **`mod.rs`: `Comparer::new` `width*height*4`** now `checked_mul` (32-bit/wasm overflow → under-alloc → OOB).
- Dimension/zero-dim/div-by-zero guards across `ssim.rs`, `psnr.rs` (length-equality → `NaN` convention), `blur.rs`, `butteraugli.rs` (`box_blur`/`dn2`/`scale_err` `n==0`).

**Deferred (the memory-bound perf + architecture payload — see below and `QUESTIONS.md`):**
- **`Comparer::all()` walks the buffers ~4× (XYB, SSIM, PSNR as separate full passes)** — the single biggest memory-bound win; wants one fused streaming pass. `channel_moments`/SSIM recompute the same sums (provably reusable once plumbed).
- f32-vs-scalar-f64 accumulator in `scale_err` (all three SIMD backends) — a uniform-value change needing ADR sign-off.
- Contract gaps: 8-bit-RGBA input assumed but unvalidated; metrics return bare `f32` overloading `NaN`/`Inf` as undocumented sentinels (want a result newtype + `PixelView`).

---

## Performance roadmap (deferred — need benchmark evidence per your "no tunables without data" rule)

Confirmed-real but **not** applied, because they change parallelism/algorithm and your CLAUDE.md requires benchmark data first. Ranked by likely payoff on the cost-center (memory: *tone/`apply_tone_math` = 70%, compute-bound*):

1. **`pipeline.rs:701` unsharp clarity pass is single-threaded scalar** over the whole RGB16 buffer — prime rayon-row + SIMD candidate (same shape as the already-SIMD tone path).
2. **`pipeline.rs:888` `apply_perceptual_constancy` recomputes ln/exp/sqrt per pixel, no LUT** — despite the dormant `PerceptualGrid`. Matches your open ToneSimd-LUT plan.
3. **`demosaic.rs:379` wasm SIMD path** computes 8 px vectorized then scatters via 24 scalar indexed stores — the scatter eats the SIMD win.
4. **`demosaic.rs:838` per-pixel 4-way CFA `match` + border clamp** in the interior loop — hoist phase out of the hot path.
5. **`dng.rs:228` uncompressed tile/strip decode fully serial** with a per-pixel endianness branch — parallel rows + hoisted byte-order.
6. `pipeline.rs:1393` `apply_luminance_nr`, `pipeline.rs:1503/1493` integer/box downscale — single-threaded/scalar under `parallel`.
7. `frame_stats.rs:127` AVX2 luma accumulation drops to scalar f64 per lane; `ljpeg.rs:388` DHT cache rebuilt+linear-searched per segment; `dng.rs:174` per-tile `Vec` alloc in the parallel map.

Each is a clean, isolated experiment — happy to wire one up behind a bench and measure if you want.

---

## Architecture & elegance roadmap (your headline ask)

The pipeline is *correct and fast in the kernels* but the **structure fights both speed and clarity** in five places. The dataflow you'd want — `RAW → unpack → demosaic → colour → tone → encode` — is nowhere expressed as a type or a seam; it lives implicitly in external callers (`lib.rs` is just module decls). The high-leverage moves:

### 1. One shared TIFF/IFD reader *(high — correctness + size)*
`tiff.rs`, `cr2.rs`, `dng.rs` each hand-roll IFD walking, endianness, and offset math. Three copies = three places for the OOB bugs this review just patched 3× independently. **Elegant form:** a single `tiff::Reader` with a visitor/iterator over entries; CR2/DNG consume it. Removes ~hundreds of lines and makes every bounds guard exist once.

### 2. A unified `RawImage` + `RawDecoder` trait *(high — the missing spine)*
`Cr2Image`, `DngImage`, `OrfInfo+raw`, `DngDemosaiced` carry the same fields (dims, CFA, black/white, WB, colour matrix) with no shared contract — so callers special-case per format. **Elegant form:** `struct RawImage { plane, width, height, cfa, black, white, wb, color_matrix }` + `trait RawDecoder { fn decode(bytes) -> Result<RawImage> }`. This is the type the whole crate is missing; it makes the per-format colour-matrix `None`-means-identity ambiguity (a deferred colour bug) impossible by construction.

### 3. A `Demosaic` enum/trait seam + de-duplicated kernel *(high — perf-enabling)*
The bilinear RGGB interior + SIMD `avg4/avg2/parity` body is **copy-pasted across 5 functions** (the pink-veil fix had to land in every copy — fragile). Selection is by *function name* (`rggb`/`mhc`/`half`/`bayer`/`matrix`). **Elegant form:** `enum Demosaic { Bilinear, Mhc, Half, … }` dispatched once; one kernel body. This is also what lets you **benchmark/swap kernels** cleanly — structure that directly serves your perf goal.

### 4. Decompose the two god-functions *(high — helps the optimizer too)*
- `process_into` fuses LUT-cache access + cfg dispatch + raw-pointer loop + 4-wide path + c-perceptual AVX2 tile path in one body.
- `decode_bytes_demosaiced_impl` is ~240 lines fusing IFD parse + tile decode + halo carry + band demosaic, threading a bench-only `subtract_black` bool through production.

Splitting these into named stages improves readability *and* gives LLVM smaller, more-inlinable units. (`decode_tile` vs `decode_tile_stats` are ~250 duplicated lines differing only by counters — collapse via a generic stats sink.)

### 5. One `RawError` + move orientation out of the tone module *(medium)*
Error handling mixes `String`, real `anyhow`, a **fake local `anyhow!` macro in `tiff.rs`**, and `thiserror`. Collapse to one `thiserror` `RawError`. Separately, EXIF orientation lives in `pipeline.rs` (the tone module) and **silently no-ops mirror/transpose orientations 2/4/5/7** (deferred bug #) — it belongs in its own `orientation` step on `RawImage`.

### 6. Collapse the AVX2/AVX-512/wasm SIMD triplication *(high — one math source of truth)*
In `perceptual/simd/`, `scale_err`, `pixels_to_xyb` and `downsample` are the **same kernel copy-pasted three times** (only intrinsic names differ), and each SIMD file **re-inlines the scalar reference math in its tail loop** — so a constant fix (e.g. the deferred f32→f64 accumulator) must land in 4 places or they drift. This review already had to apply the OOB guard 3× and the f32-accumulator fix is deferred *precisely because* it spans all three. **Elegant form:** one lane-width-generic kernel over a tiny SIMD trait (or `std::simd` / a macro), with the scalar path as the single reference the backends are tested against. Backend selection is also re-implemented per call (`mod.rs`) with a magic `Force(u8)` table → one typed dispatcher.

**Lower-leverage:** `apply_look_params`'s 12 positional `f32` args → a `LookParams` struct (kills transposition bugs); shared generic for the 3 LUT-build fns and `downscale_rgb8/16/rgba`; one camera-matrix colour helper shared by cr2/dng (cr2 currently reaches into dng internals); a metric-result newtype so PSNR(dB) and SSIM(0..1) can't be mixed.

> None of these were applied — they're cross-cutting refactors that touch public shapes and need your sign-off. They are the "beautiful architecture" payload; I can sequence them as a TDD plan (start with #1 + #2, which de-risk the rest) on your word.

---

## Deferred (29) — behaviour-changing, need your verification on real files

Full list with concrete suggested patches in **`QUESTIONS.md`**. The colour/correctness ones worth your eye:
- **`dng.rs` `align_to_rggb` no-ops Grbg/Bggr column phases** — leaves those CFA patterns mis-aligned (visible wrong colour). Real fix needs DNGs of those phases.
- **`dng.rs` per-CFA-channel BlackLevel** — only element 0 kept; arrays dropped.
- **`cr2.rs` crop uses `stride` for source vs `decoded_width` for centering** — now *guarded* (bail on mismatch) but the geometry fix needs CR2Slices files.
- **`frame_stats.rs` `luma_variance / 65536` scale** + the `frameHash` endianness contract (flagged **do-not-touch** — deliberate stable consumer contract).
- **`pipeline.rs` `color_matrix None == generic CAM_TO_SRGB`** conflates "no matrix" with "identity"; **orientation 2/4/5/7** pass-through.
- **`casabio_encode.rs` `has_alpha` measured on full-res but applied to downscaled** preview/thumb buffers.

---

## Git situation — resolved

Per your decision, committed **only the files that are ours alone**, leaving the concurrent BSD-JXL refactor untouched:
- `1281f6f7` — 8 clean parser/pipeline files (cr2, decompress, demosaic, dng, frame_stats, ljpeg, pipeline, tiff).
- `952a2df6` — 8 perceptual files (blur, butteraugli, mod, psnr, ssim, avx2, avx512, wasm).

**Left uncommitted** (entangled with the external refactor — yours to reconcile): `casabio_encode.rs` (3 guards) and `jxl_decode.rs` (2 guards, the renamed `jxl_lowlevel.rs`). Plus everything external (`crates/jxl-ffi/`, `Cargo*`, `lib.rs`, `vendor/jpegxl-src/`, scheduler `.ts`). Nothing pushed; no history rewritten.

> Note: the branch is shared — your other parallel runs landed commits in between (jxl-scheduler/jxl-core reviews, tone-LUT perf). Both EpicCodeReview commits above are intact in history.
> Housekeeping: add `.epiccodereview/` to `.gitignore` (workflow scratch; not committed).

## Next steps (your call)
1. **Apply the architecture roadmap** — I'd sequence #1 (shared TIFF reader) + #2 (`RawImage`/`RawDecoder`) first as a TDD plan; they de-risk #3–#6.
2. **Benchmark-gate one perf win** — strongest candidate: fuse `Comparer::all()`'s 4 buffer passes (memory-bound), or wire the LUT into `apply_perceptual_constancy`.
3. **Verify the deferred colour bugs on real files** — `align_to_rggb` Grbg/Bggr phase + orientation 2/4/5/7 are the most likely to be visibly wrong.
