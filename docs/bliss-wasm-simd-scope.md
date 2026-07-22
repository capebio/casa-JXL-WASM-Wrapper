# Scope — BLISS WASM decode acceleration (v128 SIMD)

**Goal:** close the gap between browser BLISS decode (26 MP/s @512px, measured) and the native
ceiling (57 MP/s, measured) by porting the decode hot path to WebAssembly 128-bit SIMD (`v128`).

**Date:** 2026-07-22 · **Author:** perf pass off the thumbnail-codec-race finding.

---

## TL;DR

- Browser BLISS decode is **fully scalar and single-threaded today** — two levers are both off:
  **SIMD** (`v128`) and **threads** (the `parallel` rayon feature is disabled in the WASM build).
- Decode splits across **three scalar kernels**, each of which *already has an AVX2 sibling* on
  native. The work is a **mechanical translation of existing AVX2 kernels to `v128`**, not new design.
- Two hard WASM-SIMD limits shape the scope: **no gather instruction** and **no 32×32→64 widening
  multiply**. The first is worked around (emulated gather, LUT is L1-resident); the second only
  affects the *encoder*, so we **scope decode only** (encode is a one-time cache write).
- **Estimated ROI: ~1.7–2× decode throughput, 26 → ~45–50 MP/s**, single-threaded. Optional WASM
  threads stack on top for multi-band images.
- A WASM `pkg/` rebuild is **owed regardless** — the shipped pkg emits the old `LT2R` stream magic
  while native bliss-core now uses `BLSR`. This port naturally bundles that rebuild.

**Recommendation:** do it, decode-only, phased. Start with the rANS kernel (biggest, cleanest win),
gate each phase on bit-exact parity against the scalar decoder (tests already exist as a template).

### Phase 2/3 status (done, 2026-07-22) — v128 reconstruction, measured
`bliss-core/src/band_wasm.rs` (`recon_even_row_v128`, `recon_odd_row_inplace_v128`, `ctx_row_v128`,
`interleave3_v128` — byte-wise `u8x16`, 16/iter, med3 via min/max, saturating ctx, swizzle interleave),
wired into `band.rs` at all three recon sites (wasm32+simd128 arms). Edges scalar, interior SIMD;
**bit-exact** (same 28-case + native-parity harness still green). The byte kernels vectorize far
better than rANS (no gather).

**Measured (sandbox), cumulative over the Phase-0 scalar baseline:**
| workload | scalar | +v128 rANS | +v128 recon | total |
|---|--:|--:|--:|--:|
| thumbnail 512px | 32.0 | 37 | **57–59 MP/s** | **~1.8×** |
| lightbox 1800px | 33.5 | 37.8 | **63–65 MP/s** | **~1.9×** |

Single-thread SIMD ceiling reached (beats the revised 1.4–1.6× guess; hits the original 1.7–2×).

### Phase 4 status (done + measured in-browser, 2026-07-22)
Enabled `bliss-core/parallel` + `wasm-bindgen-rayon` in the sandbox (no bliss-core code change), built
the MT tier (nightly `-Z build-std`, `+atomics,+bulk-memory,+mutable-globals`, `--shared-memory
--import-memory`, exact recipe in the handoff), measured in **headless Chromium** (COOP/COEP → SAB +
rayon pool), threads=1 vs 8, decode output bit-identical across thread counts:
| real Gobabeb | bands | ST(1) | MT(8) | thread× |
|---|--:|--:|--:|--:|
| lightbox 2.42 MP | 5 | 47.7 | **168.8 MP/s** | 3.54× |
| large 8.63 MP | 8 | 49.0 | **185.0 MP/s** | 3.78× |

**Full stack measured (lightbox): 25.7 (scalar 1t) → 47.7 (v128 1t) → 168.8 (v128×8t) = 6.6×, 94 ms → 14 ms.**

### Phase 4 — threads (analysis; ceiling is band count)
Decode is band-parallel (`lib.rs` decode `metas.par_iter()`, `#[cfg(feature="parallel")]`). **Bands are
baked at encode**: `default_bands = (h/256).clamp(1, cap)`. So the thread ceiling is per-image:
- thumbnail 512px (h≈384) → **1 band → threads give nothing** (already ~3 ms, fine).
- lightbox 1800px (h=1200) → **4 bands → up to ~4×** (this is the 86 ms case worth accelerating).
- full 20 MP preview (h≈3600) → ~14 bands → strong scaling.

**Band-parallel scaling — proven natively** (rayon `RAYON_NUM_THREADS` sweep on a ~12-band 2048×3072
decode; native AVX2, but the *scaling* is what WASM threads inherit per-band):
| threads | 1 | 2 | 4 | 8 |
|---|--:|--:|--:|--:|
| MP/s | 81.5 | 151 | 260 | 323 |
| scaling | 1.0× | 1.85× | 3.2× | **4.0×** |

Threads stack with SIMD: lightbox ≈ 1.9× (SIMD) × up-to-4× (bands) vs original scalar single-thread.
Projected lightbox path: **33.5 (scalar) → 63 (v128, done) → ~200+ MP/s (× threads)** ≈ 6× total,
86 ms → ~14 ms.
**Machinery already exists in the root project**, not the sandbox: `tools/build-mt-wasm.sh` → `pkg-mt/`
(nightly + `-Z build-std` + `+atomics,+bulk-memory,+mutable-globals`, `--shared-memory`,
wasm-bindgen-rayon; COOP/COEP already required by libjxl MT). Threads ship **only** in that MT tier.
→ **Recommendation:** activate threads for bliss during the root-pkg MT land (forward `bliss-core/parallel`
in the `parallel-wasm`/MT build + init the thread pool), rather than rebuild the full MT toolchain +
JS worker harness inside the throwaway sandbox.

### Phase 1 status (done, 2026-07-22) — v128 rANS decode, measured
`bliss-core/src/rans_wasm.rs` (`decode16l_v128` + `packed_lut`), wired into `band.rs` via
`decode_stream_fallback` (wasm32+simd128, 16-lane → v128; else scalar). **Bit-exact**: 28 lossless
roundtrip cases (noise/flat/gradient/sparse-rares × 7 sizes incl. non-16-multiple + tiny → tail &
renorm edges) + native `bliss.exe` cross-parity. Renorm is register-resident (extract/merge/replace,
no per-step memory round-trip; `i32x4_bitmask` skips idle regs).

**Measured (sandbox, vs Phase-0 scalar baseline):**
| workload | scalar | v128 rANS | whole-decode |
|---|--:|--:|--:|
| thumbnail 512px | 32.0 | 35–37 MP/s | **~1.13–1.15×** |
| lightbox 1800px | 33.5 | 37–38 MP/s | **~1.13×** |

**Recalibration (this is why we phase):** the whole-decode win is modest because rANS is only
~30–45% of decode — the **reconstruction is 55–70%** and still scalar. The earlier ~1.7–2× estimate
assumed both kernels ported. **Good news for Phase 2/3:** the near-lossless cache tier encodes with
`Opts::default()` (`err_ctx=false, ctx2=false`), so its recon path is `ctx_row` + *simple* residual
gather + median reconstruction — **no serial bias loop**, fully vectorizable. Realistic revised
target with recon ported: **~1.4–1.6× whole-decode** (single-thread).

**Bigger separate lever — threads.** Decode is band-parallel (native uses rayon `par_iter` over
bands). The 1800px lightbox has many bands → WASM threads (`parallel` feature + wasm-bindgen-rayon,
COOP/COEP already required by the app) could give ~Ncores× — multiplicative with SIMD, and the real
path to "instant" on the lightbox. Larger integration surface than SIMD.

### Phase 0 status (done, 2026-07-22)
Work isolated in a standalone sandbox — `C:\Foo\bliss-wasm-sandbox\` (own crate, path-dep to current
`bliss-core`, `+simd128` via its `.cargo/config.toml`) — so the in-flight benchmark paper's `pkg/`
is untouched until a deliberate land step. `wasm-pack build --target web` (59 KB wasm). Verified
(`verify.mjs`): (1) lossless roundtrip **bit-exact**, (2) stream magic now **`BLSR`** (was `LT2R` in
the stale shipped pkg → why native couldn't read WASM bytes), (3) native `bliss.exe` decodes the
sandbox `.bliss` **bit-exact to the WASM decode** — native-interop unblocked. **Scalar baseline**
(`bench.mjs`, this simd128 build, no v128 kernels yet): **thumbnail 512px = 32.0 MP/s**, **lightbox
1800px = 33.5 MP/s** — the numbers Phase 1 must beat, in-harness.

---

## Where the time goes

`bliss_core::decode` (src/lib.rs:250) → per band `decode_band_ctx` (band.rs:559) does two things:

1. **rANS entropy decode** of each channel's stream (band.rs:604–628).
2. **Predictor-inverse reconstruction** — rebuild pixels from residuals (band.rs:634–790+):
   - `ctx_row` — green-plane gradient → context bin (band.rs:678).
   - residual gather + per-context bias correction (scalar, data-dependent — leave scalar).
   - `recon_even_row` / `recon_odd_row_inplace` — checkerboard-median reconstruction (band.rs:769–789).

Every SIMD site is gated `#[cfg(target_arch = "x86_64")]`, so on `wasm32` **all three fall to scalar**:

| kernel | native (x86_64) | wasm32 today | AVX2 template to port |
|---|---|---|---|
| rANS decode (16-lane) | `rans_avx2::decode16l` | `rans::decode_lanes` (scalar) | `rans_avx2.rs:334` |
| green-gradient context | `avx2::ctx_row` | `ctx_row_planar` (scalar) | `band.rs` avx2 mod |
| checkerboard-median recon | `avx2::recon_*_row` | `med_row_prev`/`med_row_horiz` (scalar) | `band.rs` avx2 mod |

Stream format is **16-lane (`V2_LANES = 16`)** — the port targets the `decode16l` shape
(AVX2 uses 2×`__m256i`; `v128` uses 4×`v128`, same 16 lanes, narrower per instruction).

Rough time split (unprofiled, typical for this codec class): rANS ≈ 45–55%, reconstruction ≈ 45–55%.
**Porting only rANS caps the win at ~1.4×**; porting both kernels reaches the ~1.7–2× estimate.
→ Phase the work but plan for both kernels.

---

## What `v128` can and cannot do

WASM SIMD is **baseline** in all current browsers (shipped 2021) — no runtime feature detection
needed; it's a compile-time target feature (`-C target-feature=+simd128`).

Portable from the AVX2 decoder (direct `core::arch::wasm32` equivalents):

| AVX2 op | `v128` equivalent |
|---|---|
| `_mm256_and_si256` | `v128_and` |
| `_mm256_srli_epi32` / `slli` | `u32x4_shr` / `i32x4_shl` |
| `_mm256_add/sub/mullo_epi32` | `i32x4_add` / `i32x4_sub` / **`i32x4_mul`** (low 32 — exactly what the decoder needs) |
| `_mm256_cmpeq_epi32` | `i32x4_eq` |
| `_mm256_movemask_ps` | `i32x4_bitmask` |
| `_mm256_shuffle_epi8` (byte extract) | `i8x16_swizzle` |
| `_mm256_blendv_epi8` | `v128_bitselect` |

**Two blockers and how we handle them:**

1. **No gather.** AVX2 uses `_mm256_i32gather_epi32` for `plut[c]` (the packed-LUT lookup) and for
   the renorm word reads. `v128` has none. Emulate per active lane: `i32x4_extract_lane` → scalar
   load → `i32x4_replace_lane`. Costs 4× (extract+load+insert) per gather.
   *Why it still wins:* the packed LUT is 4096×`u32` = **16 KB, L1-resident**; the scalar loads hit
   L1 every time, and all the surrounding arithmetic + branchless renorm is vectorized. Net still
   1.6–2.2× over the branchy 1-lane scalar loop. (AVX2 hardware gather is itself slow, so the
   emulation gap is smaller than the ISA table suggests.)
   *Renorm alternative:* with 4 lanes per register the renorm word-merge can be done with a **scalar
   per-lane loop over the ≤4 active lanes** instead of mask-permute-gather — simpler and avoids the
   256-entry permute tables (rebuild as 16-entry for 4 lanes only if going full-SIMD).

2. **No 32×32→64 widening multiply** (`_mm256_mul_epu32` has no `v128` analog; no 64-bit mul at all).
   This is only used by the **encoder's Lemire division** (`lemire_q`, rans_avx2.rs:286). The
   **decoder needs no 64-bit math** — its state update is `freq*(x>>12)` which fits `u32` exactly
   (freq<2¹², x>>12<2²⁰ → product<2³²) and maps to `i32x4_mul`. → **Decode ports cleanly; encoder does not.**

---

## Scope

**In:** `wasm32` `v128` decode kernels, bit-exact with the scalar decoder:
1. `rans::decode16l_v128` — 16-lane rANS decode (mirror of `rans_avx2::decode16l`).
2. `ctx_row_v128` — green-gradient context row.
3. `recon_even_row_v128` / `recon_odd_row_v128` — checkerboard-median reconstruction.

Dispatch: add `#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]` arms alongside the
existing `#[cfg(target_arch = "x86_64")]` arms in band.rs (decode path only).

**Out:**
- **Encoder** (blocked by 64-bit mul; and it's a one-time cache write — encode natively or leave
  scalar). Keep `bliss_encode` scalar in WASM.
- **16-bit path** (`decode16`) — not used by the display cache (8-bit RGB thumbnails/previews).
- **Threads** — separate lever (see Alternatives).

---

## ROI estimate (grounded in measured numbers)

| config | decode @512px | basis |
|---|--:|---|
| WASM scalar (today) | **26 MP/s** | measured, thumbnail-gallery.json |
| WASM `v128` (projected) | **~45–50 MP/s** | scalar × 1.7–2.0 (SIMD-over-scalar on both kernels) |
| native AVX2 + MT | **57 MP/s** | measured, native bliss-cli |

The relevant baseline is **SIMD-over-scalar**, not v128-vs-AVX2: the scalar WASM loop is branchy and
processes one lane per iteration, so even 4-wide `v128` with emulated gather lands 1.6–2.2× on the
rANS kernel and ~1.5–2× on reconstruction. Blended whole-decode ≈ 1.7–2×. On larger images (full
20 MP previews, the actual lightbox workload) the win holds or grows (fewer per-row fixed costs).

Impact in context: this roughly **halves the browser gallery/lightbox decode latency** and moves
BLISS from "fast for a WASM codec" to "≈ native-JPEG-class decode, near-lossless" — the "blisteringly
fast" claim, delivered in the browser rather than only natively.

---

## Effort, risk, phasing

**Effort:** ~2–4 focused days. Kernels are small and the AVX2 versions are line-for-line templates.

| phase | deliverable | risk |
|---|---|---|
| 0 | Build pkg with `+simd128`; confirm baseline decode still bit-exact; **fixes `LT2R`→`BLSR` magic skew** | ✅ **DONE** |
| 1 | `decode16l_v128` (rANS) + parity test + bench | med (gather emulation + renorm correctness) |
| 2 | `ctx_row_v128` + parity | low |
| 3 | `recon_even/odd_v128` + parity | med (checkerboard phase ordering; AVX2 comment at band.rs:776 documents the read pattern) |
| 4 | wire dispatch, end-to-end MP/s on the thumbnail corpus, update the codec-race figures | low |

**Risks & mitigations:**
- *Correctness (rANS is unforgiving — one wrong renorm ⇒ garbage).* Mitigate with the **existing
  bit-exact parity tests** (rans_avx2.rs:558 pattern: encode scalar → decode SIMD → assert equal
  bytes) retargeted to the `v128` decoder, run in `wasm32` under `wasmtime`/node.
- *Emulated gather underperforms.* If phase-1 bench shows <1.5×, fall back to the scalar per-lane
  renorm variant and keep only the arithmetic vectorized — still positive, lower ceiling.
- *`+simd128` not currently in the pkg build flags.* Add `RUSTFLAGS="-C target-feature=+simd128"` to
  the wasm-pack invocation; verify no non-SIMD deployment target matters (SIMD is baseline — safe).

**Test/verify:** bit-exact vs scalar decoder on the existing datasets (uniform / skewed / freq==1
stress / tiny / exact-multiple), plus end-to-end decode of real Gobabeb `.bliss` thumbnails with
Butteraugli==0 vs the scalar decode. Then re-run `benchmark/thumbnail-gallery.mjs` — the `bliss`
(WASM) row's MP/s should jump ~1.7–2×; regenerate `fig-thumb-lossless`.

---

## Alternatives / complements

- **WASM threads (the other off lever).** `bliss-core`'s `parallel` feature (rayon `par_iter` over
  bands) is disabled in the WASM build (`default-features = false`). Enabling it needs
  `wasm-bindgen-rayon` + a thread pool + COOP/COEP headers (the app already sets these for
  `SharedArrayBuffer`). Multiplies with SIMD on multi-band images. Larger integration surface than
  SIMD; recommend **SIMD first** (pure-internal, no API/headers change), threads as a follow-up.
- **Do nothing / native-only.** Acceptable if the browser lightbox already feels instant on the
  target hardware — but the measured 26 MP/s means a full 20 MP preview decodes in ~85 ms (matches
  the "86 ms" observation), which SIMD would cut to ~45 ms. Worth it for the cache's whole point:
  instant reopen.

---

## References

- `C:\Foo\bliss\bliss-core\src\rans.rs` — scalar 16-lane rANS (the correctness oracle).
- `C:\Foo\bliss\bliss-core\src\rans_avx2.rs` — AVX2 decode/`decode16l` + parity tests (the template).
- `C:\Foo\bliss\bliss-core\src\band.rs` — decode dispatch (`decode_band_ctx`) + reconstruction.
- Measured baseline: `docs/thumbnail-gallery.json` (bliss WASM 26 MP/s vs native 57 MP/s @512px).
