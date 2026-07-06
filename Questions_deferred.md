# QUESTIONS — Deferred

**From:** QUESTIONS.md breakdown + Mr. Smith comptroller (2026-06-19)

> **2026-07-02 batch resolution** (full detail: `docs/implemented improvements.md`
> §2026-07-02, `docs/1 rejected optimizations.md` DS-HADD/DC-XZERO/NOWIN-JUL02):
> - **LANDED:** dec_ans alphabet-size uint16 wrap fix (TTFP #6, branch a7f2); conv5
>   pool-Status propagation (leftovers #5, branch s3v1); box_blur H-pass row-parallel +
>   uninit pyramid allocs (+77–79%, 4.4–4.8×); casabio preview+full leaf coalescing
>   (CASA-ENC D3, byte-exact, drops one e3 encode); perceptual-color percentile
>   typed-array sort (+78–84%); **JOLT** lossy-video profile (rate metadata + presets,
>   `docs/jolt-lossy-video.md`).
> - **REJECTED (measured):** compressed_dc DC X-zero dequant (regression −1.8..−7.4%,
>   DC-XZERO); downsample_avx2 hadd rewrite (wash, DS-HADD).
> - **REJECTED (no implementation needed):** ans_common CreateFlatHistogram tweak,
>   AdjustQuantBias reschedule, chroma_from_luma micro-cleanups, RatioJPEG hoist +
>   compressed_dc #6 (app-dead JPEG-recon paths), enc_modular subsampled alloc
>   (app is 4:4:4) — see NOWIN-JUL02.

---

## butteraugli SpeedCodeReview — deferred items (2026-07-02)

Context: LANDED the byte-exact SIMD hot-path pass on `butteraugli.cc`+`.h`
(submodule branch `perf/butteraugli-simd-hotpath-jul01-b9f2` @b6162a03, capebio,
off e4fbf789, worktree `C:\Foo\rcw-butteraugli`, PUSHED not-merged). Native
−48..53% / WASM −33..48% end-to-end, diffmap FNV + score bits identical on
25/25 native + 63/63 WASM sizes (incl odd 513×385, 255×257, 31×29 and tiny 9×8).
Harness `C:\Tmp\butteraugli-ab` (native clang-cl OLD/NEW + em++ wasm OLD/NEW,
interleaved min). **Ship gate: rebuild web/pkg + jxl-wasm dist from this rev**
(no gitlink bump done — parked remote-only like the other jul01 perf branches).

Deferred (real but out of the byte-exact / low-risk envelope):

1. **Malta directional-stencil reduction (the big algorithmic lever, NOT
   byte-exact).** `MaltaDiffMapT` runs 16 directional line-kernels per pixel and
   is called 6× (uhf/hf/mf × X/Y). It dominates the diffmap cost. A cheaper
   basis (separable approximation, fewer directions, or a learned surrogate)
   could cut butteraugli far more than SIMD did — but it changes the score, and
   the score feeds encoder AQ/heuristics and quality gates. Needs a
   score-correlation study (Spearman vs stock butteraugli on a photo+screenshot
   corpus) + a cjxl size/quality regression, not the SHA gate. Research-grade.
2. **web/jxl-butteraugli.js `scaleErr` reciprocal-hoist** (`/m` ×3 → `inv=1/m`
   then ×3, as the Rust twin already does). Real per-pixel win but changes float
   rounding in an *approximation* that drives progressive cutoff decisions;
   gate with the Node flipflop before landing. Low EV now that the WASM
   comparator (faster after this pass) is the primary path and the JS approx is
   the fallback.
3. **web/jxl-butteraugli.js → prefer the WASM `ButteraugliComparator`** in the
   progressive cutoff loop instead of the JS approx (`_backend.score` hook
   already exists). Behavior/wiring change (approx→exact scores shift plateau
   detection) → user decision, measure cutoff-count impact.
4. **bridge.cpp gamma-decode+planarize SIMD** (3 `build_image` loops). Already
   LUT-based; vectorizing the u8→planar-f32 scatter is a small fraction of the
   (now-halved) butteraugli compute and forces a full WASM rebuild. Low value.
5. **perceptual/butteraugli.rs** — no action: it is the deliberate independent
   scalar parity oracle for the avx2/avx512/wasm `scale_err`/`downsample`
   kernels (`dn2`/`scale_err`, already inv-hoisted + f64-accum + cbrt).
   Optimizing it would defeat its purpose. Production perceptual butteraugli
   rides `simd/*.rs`, a separate subsystem from libjxl butteraugli.
6. **butteraugli_main.cc** — no action: CLI dev tool (2 reads, 1 compare,
   print). Not on any app hot path.

---

## Organization: By Workstream & Effort

Deferred items grouped by file/package scope + dependency + effort.

---

## Measurement recipes — a WASM rebuild is ONE shared artifact, NOT per-opt

Many entries below say "needs a WASM build / ~34-min integrator gate to flipflop."
That reads as a build *per optimization* — it is not. `build.mjs` compiles the
**entire** integrated `libjxl-012` + `bridge.cpp` into the 6 `dist` modules in **one**
run; every facade-level test/flipflop loads that same `dist`. Merge the opts, build
**once**, measure all of them. Worked examples drawn from the entries in this doc:

**1. Native A/B — NO build at all (where most kernel opts belong).**
Any opt with an isolated `*_ab.cc` harness compiles straight with clang and times
OLD vs NEW in-process — no libjxl build, no WASM, seconds to run:
```
clang++ -O3 -std=c++17 tools/enc_bit_writer_append_ab.cc -o bw_ab && ./bw_ab
clang++ -O3 -std=c++17 tools/dc_ctxmap_ab.cc -o dc_ab && ./dc_ab
```
Right tool for enc_bit_writer, enc_cluster, dc_ctxmap, ac_strategy, enc_xyb, conv5 —
a kernel-level number without touching the build.

**2. Real dec-path number — ONE shared rebuild; baseline is already in git (no 2nd build).**
For dec opts that DO fire in the app (CfL X-zero dequant, compressed_dc X-zero): do
not build per-opt. Merge the dec opts, run the single `build.mjs` rebuild, then
flipflop the new `dist` against the pre-integration `dist` **already in git history**
(built from 10783f7e at `b4a55047`) — the baseline needs no rebuild:
```
git show b4a55047:packages/jxl-wasm/dist/jxl-core.dec.simd.wasm > /tmp/old.dec.simd.wasm
git show b4a55047:packages/jxl-wasm/dist/jxl-core.dec.simd.js   > /tmp/old.dec.simd.js
# NEW = current dist (rebuilt from integrated main); flipflop OLD vs NEW via facade/section bench.
```
That one build covers every merged dec opt together — the 34-min cost is shared, paid once.

**3. Encoder number — one native cjxl A/B build pair (not WASM, not per-test).**
For enc opts (enc_cluster, enc_bit_writer SHA + timing): build cjxl OLD vs NEW once
via `jxl_encdec_ab` (`LIBJXL_SOURCE_DIR`), SHA-compare e3+e9 (byte-exact gate) and read
the timing delta. One build pair, shared across all merged enc opts.

**4. Don't build at all — no-evidence / negligible / correctness.**
- `quantizer-inl AdjustQuantBias` reschedule: compiler already reorders independent ops
  at -O2/-O3; building to chase a source-level guess is negative-EV. Gate is a per-target
  **assembly diff**, not a flipflop.
- `ans_common CreateFlatHistogram`: off every hot path; no measurement justifies the branch.
- `quantizer` lower-bound clamps: a **correctness/reachability** question, not a perf A/B —
  not byte-exact, so it cannot ride a flipflop branch at all.

**App-path-dead caveat:** some opts never run in the RAW→sRGB app path (enc_xyb fires only
linear / non-sRGB-CMS; CfL `RatioJPEG` only on JPEG-recon; compressed_dc #6 only when
subsampled). A facade flipflop reads **neutral** for these no matter how often you rebuild —
measure them native-isolated (recipe 1) or accept "provably-less-work, unmeasured."

---

## WORKSTREAM 1: Raw-Pipeline Colour & Output Validation

**Priority:** HIGH (user-visible colour/geometry changes)  
**Gate:** Real camera files + user colour parity validation  
**Effort:** 20–30h (highly variable based on measurement results)

### User Decisions Required

| Issue | Item | Status | Gate |
|-------|------|--------|------|
| A2 | Exposure-time sentinel (DNG `den=1` vs ORF `den=0`) | Unimplemented | User decision: harmonize to `den==0`? |
| A3 | `color_matrix_from_mn` rename + docs | Unimplemented | Rename signal (DNG default vs user-supplied intent) |
| A4 | Colour matrix fallback semantics (None → CAM_TO_SRGB) | Unimplemented | Type-level enum or require explicit fallback per format |
| A5 | CR2 per-model colour matrix extraction | Stashed (project-cr2-colordata-matrix-todo.md) | Canon ColorData v>=6 wire-up; depends on A4 decision |
| A6 | Black/white level inference + per-channel extraction | Unimplemented | DNG per-CFA-channel read; CR2 WhiteLevel tag override |

### Colour Output Changes (Need Real File Validation)

| Issue | Item | Severity | Gate |
|-------|------|----------|------|
| B1 | Grbg/Bggr CFA alignment (align_to_rggb dead code) | Med | Real Grbg/Bggr DNG files + parity test |
| B2 | AsShotNeutral validation (zero/NaN handling) | Med | Audit callers; confirm no DNG relies on 0.0 clamp |
| B3 | DNG per-channel black levels | Med | Real DNG w/ per-channel black + colour validation |
| B4 | ORF color_matrix 0x1011 dtype gate | Med | Real Olympus body storing 0x1011 + colour parity |
| B5 | Demosaic degenerate 1×N handling | Low | Ensure m10c test still passes |

### Performance Opportunities (≥5% gate)

| Issue | Item | Expected | Effort | Status |
|-------|------|----------|--------|--------|
| C1 | Demosaic MHC +22% | +22% (synthetics) | 4h | Measure on real CR2/ORF; colour validation required |
| C3 | DNG tile endian branch | −3.8% | Low | REJECTED (below 5% gate) |
| C4–C10 | Downscale, pack_rgb16, rgb_to_rgba, LookRenderer | ? | 1–3h each | Flipflop measurement required |

### Structural Refactors (ADR-level)

| Issue | Item | Scope | Effort |
|-------|------|-------|--------|
| D1 | Unified TIFF/IFD reader | tiff/cr2/dng consolidation | 4h (cross-file) |
| D2 | Unified RawError enum | anyhow/String/bail → typed | 2h (cross-file) |
| D3 | Scene-referred RawImageMeta | Linear mode; CR2 colour matrix | 3h + user decision |
| D4 | Fast embedded-preview LOD tier | CR2/DNG half-res decode | 2h |
| D6 | EXIF orientation 2/4/5/7 | Mirror/transpose implementation | 2h + real test corpus |

### Perceptual Module (f32 vs f64 accumulator, sentinels, fused kernel)

| Issue | Item | Impact | Effort | Gate |
|-------|------|--------|--------|------|
| E1 | scale_err accumulator precision | <1e-4 rel drift @ full res | 3h | Parity test + benchmark |
| E2–E7 | Empty-buffer sentinels, PSNR alpha, fused kernel | Cross-metric | 5h | ADR + cross-backend coordination |

**Next:** Prioritize A2–A6 user decisions. Then measure C1, C4–C10 on real files.

---

## WORKSTREAM 2: Cross-Package Protocol & Contract Wiring

**Priority:** MEDIUM (enables worker communication)  
**Gate:** Cross-file coordination + unit tests  
**Effort:** 8–12h

### jxl-core Issues (span 3+ packages)

| Issue | Item | Files | Effort | Status |
|-------|------|-------|--------|--------|
| A1 | ~15 EncodeOptions fields missing wire | jxl-core + encode-session + worker | 3h | Unimplemented; extract mapper |
| A2 | Worker error codes outside JxlErrorCode | jxl-core + handlers + session | 2h | Unimplemented; merge unions |
| A3 | MsgWorkerError missing sessionId | worker + scheduler + session | 2h | Unimplemented; route to session |
| A4 | DecodeFrameMeta dropped by session.makeFrame | jxl-core + decode-handler + session | 1h | PARTIALLY FIXED (verify assignFrameMeta called) |
| A5 | decode_budget_exceeded metadata gaps | protocol + handler | 1h | PARTIALLY FIXED (verify metrics folded) |

### Stream Abort Contract (parity testing)

| Issue | Item | Files | Effort | Status |
|-------|------|-------|--------|--------|
| D1 | Abort contract resolve vs reject | browser + node + session | 2h user decision + 3h impl | Decided: RESOLVE ✅ (implemented browser.ts) |
| D2–D6 | Regression tests (parity, prefetch, 200-fallback, resume) | test/*.test.ts | 6h total | Unimplemented; depends on D1 decision |
| E1 | Node.js abort parity (node.ts) | node.ts (out-of-scope this review) | 3h | Unimplemented; coordinate with browser fix |

**Next:** Verify A4/A5 status (MEMORY.md says partly done). Then wire A1–A3. Then test D2–D6.

---

## WORKSTREAM 3: Scheduler & Worker Lifecycle

**Priority:** MEDIUM (backpressure + decode state machine)  
**Gate:** Verifier arbitration or trace evidence  
**Effort:** 8–12h

### Scheduler Invariants & Decisions

| Issue | Item | Status | Gate |
|-------|------|--------|------|
| A1 | One-primary-per-sourceKey assertion | Unimplemented | Add DEBUG flag guard; audit callers |
| A2 | CoreBudget unbounded waiter queue | Unimplemented | User decision: bounded or status quo |
| A3 | signalDrain double-decrement | ✅ FALSIFIED (not a bug; see Questions_implemented.md) | — |
| A4 | Promotion counter fragility | Unimplemented | Hardening (doc + invariant assert) |
| A5 | Buffered chunks unbounded overflow | Unimplemented | User decision: drop, error, or backpressure |

**Completed:** A3 (gauge invariant documented, b5249622).

### Decode-Handler Metrics & Test Gaps

| Issue | Item | Effort | Severity |
|-------|------|--------|----------|
| B1 | MAX_OUTPUT_BYTES_GUARD conservative | 1h | Info (policy doc) |
| B2 | output_bytes vs copied_bytes unification | 1h | Clarity |
| B4 | Missing unit tests (cancel/budget/drain) | 3h | Medium (coverage) |

**Next:** Decide A2 (waiter cap policy) and A5 (overflow semantics). Then implement B1–B4.

---

## WORKSTREAM 4: WASM FFI/ABI Layer

**Priority:** MEDIUM–HIGH (security + ABI correctness)  
**Gate:** WASM rebuild cycle (Docker/Emscripten, not available locally)  
**Effort:** 8–15h + rebuild time

### Facade.ts ABI Bugs (Deferred — requires rebuild + test)

| Issue | File | Severity | Lines | Status |
|-------|------|----------|-------|--------|
| B1 | encode_rgba8_with_metadata arg-shift | HIGH | +2 args | Unimplemented; rebuild + round-trip ICC/EXIF |
| B2 | 6 encoder options not forwarded | HIGH | +6 fields | Unimplemented; rebuild + test |
| B3 | ExtraChannel stride mismatch | MED | struct | Latent (no caller yet) |
| B4 | perceptualConstancyApplyBulk scalar fallback | MED | Impl | Fix link first (c-perceptual) |
| B5 | Leaks on throw (decoder, wasmEncState) | MED | Hoist | Unimplemented |
| B6 | rgb8 progressive pixelStride | MED | Stride | ADR: shared channel-stride helper |

### bridge.cpp (C++, cannot build here)

| Issue | Severity | Status | Rebuild |
|-------|----------|--------|---------|
| C1 | JXTC encode integer overflow | HIGH/security | PARTIALLY PATCHED (verify in build) | ✅ Build+test |
| C2 | Unvalidated FFI lengths | MED/security | Unimplemented | ✅ Build+fuzzing |
| C7 | Butteraugli ref deep-copy | HIGH/perf | Unimplemented | ✅ Build+flipflop (5–10% win) |
| C8 | SSIM two-pass fusion | MED/perf | Unimplemented | ✅ Build+test |

### Correctness (TS-only, no rebuild)

| Issue | File | Status |
|-------|------|--------|
| F1 | JPEG marker walk | ✅ IMPLEMENTED (b5249622) |

**Next:** Schedule WASM rebuild cycle. Coordinate B1–B6 (facade) + C1–C8 (bridge) + security audit.

---

## WORKSTREAM 5: Progressive Encode Architecture

**Priority:** LOW (Flagship ADR rejected; stay 3-pass or incremental)  
**Gate:** User pivot decision  
**Effort:** 5–15h (depends on path chosen)

### Flagship ADR Path (REJECTED)

**Status:** ❌ One-pass progressive encode quality gate FAILED (DC/AC tiers undecodable).

**Alternative paths:**
1. **Incremental** (Option 1): Keep thumb+preview tiers; add progressive_dc+group_order to full tier only (CPU-neutral, graceful big-image).
2. **Status quo** (Option 2): Stay 3-pass; close ADR as not-viable.
3. **Investigate** (Option 3): Why does prefix-decode fail? May be libjxl limitation.

**Recommendation:** Choose Option 1 or 2. Do not pursue one-pass-for-all-tiers.

### Cross-File Issues (if Option 1 chosen)

| Issue | Item | Effort |
|-------|------|--------|
| B1 | byteStart dead field | 0 (wait for format revision) |
| B2 | Manifest double-fetch race | 1h (share in-flight promise) |
| B3 | DC byteEnd exceeds file size | 0.5h (cap to fullFileSize - 1) |

### Performance (optional, low priority)

| Issue | Item | Expected | Gate |
|-------|------|----------|------|
| C1 | tick() dirty-flag (scheduler re-sort) | 73% sort, ~5–10% overall | Measure @ 200+ jobs |
| C3 | tee() buffering | Tier-size dependent | Measure P95 tier size |

**Next:** User decides Option 1/2/3. If Option 1, coordinate with encode-handler + manifest changes.

---

## WORKSTREAM 6: Additional Deferrals (Low Priority, Vision)

### Vision ADRs (Aspirational, backlog)

| Issue | Item | Files | Effort |
|-------|------|-------|--------|
| E1 | ManifestTier LOD metadata | manifest.ts | 2h |
| E2 | TierFetchOptions timeoutMs | scheduler | 1h |
| E3 | Typed perceptual passthrough | manifest schema | 2h (pending Perceptual Constancy) |
| E4 | onManifest ML-dispatch + render-budget | scheduler + types | 3h |
| E5 | Per-frame byte offsets | progressive-manifest | 2h |

### Verifier-Uncertain (Low severity)

| Issue | Item | Impact | Status |
|-------|------|--------|--------|
| H1 | take_flushed lifetime (bridge.cpp) | Low (decoder-side) | Comment-only; audit callers |
| H2 | Decoder cancel leak | Low (only if abandoned) | Code audit required |

---

## Effort Rollup (Deferred Only, Excluding Falsified)

| Workstream | Est. Effort | Gate |
|------------|-------------|------|
| 1: Raw-pipeline colour + perf | 20–30h | User validation + flipflop |
| 2: Cross-package protocol wiring | 8–12h | Cross-file coordination |
| 3: Scheduler lifecycle + tests | 8–12h | Verifier arbitration or trace |
| 4: WASM rebuild cycle | 8–15h | Docker/Emscripten build |
| 5: Progressive encode (if Option 1) | 5–10h | User decision |
| 6: Vision ADRs (backlog) | 10h | Aspirational, low priority |
| **TOTAL** | **60–90h** | **User + measurement gates** |

---

## Critical Path (Next 7–14 Days)

**Phase 1 (Today):** Consolidate output files (✅ done). User pivot decision on Flagship ADR → Option 1/2/3.

**Phase 2 (1–2 days):** Verify A4/A5 status (MEMORY.md). Decide A2 (waiter cap), A5 (overflow), B1 (MAX_OUTPUT_BYTES).

**Phase 3 (3–5 days):** Measurement + real-file validation (raw-pipeline colour C1, downscale C4–C10, scheduler C1).

**Phase 4 (5–10 days):** WASM rebuild + bridge.cpp security audit + B1–B6 facade fixes.

**Phase 5 (10–14 days):** Cross-package wiring (A1–A3, D2–D6 tests).

---

## References

- **QUESTIONS_BREAKDOWN.md** — Handoff structure + agent roles
- **Questions_raw-pipeline.md** — Raw decode scope
- **Questions_jxl-core-protocol.md** — Contract layer scope
- **Questions_jxl-worker.md** — Scheduler + handler scope
- **Questions_jxl-session-stream.md** — Session + stream scope
- **Questions_jxl-wasm.md** — FFI/ABI scope
- **Questions_progressive-encode.md** — Encode architecture scope
- **Questions_implemented.md** — 3 deployed quick wins (b5249622)
- **Questions_falsified.md** — 3 rejected items

---

## ac_strategy / ac_context deferred items (2026-06-29)

From the ChatGPT "holographic" pass on the 3rd-hottest file. Landed wins are on branch `capebio/perf/ac-strategy-coefforder-zdc1-jun29-x7q2` (C1 order-traversal + Set split; C2 ZeroDensityContext1). Items below are deferred — each is either a broad cross-file refactor, profile-led, or needs a measured WASM A/B before it can be judged. None are byte-exact-trivial.

1. **Unified `StrategyGeometry` descriptor** (replace the 3 per-strategy LUTs `covered_blocks_x/y` + `log2_covered_blocks` in ac_strategy.h with one struct, + raw-byte `AcStrategyRow` accessors). Marginal (the 3 LUTs are tiny constexpr, likely register-resident when inlined); wide blast radius (enc_group/dec_group/enc_ac_strategy/etc. all derive geometry). CLAUDE.md "no opportunistic refactors". Needs an end-to-end measurement showing the repeated derivation is actually visible before touching every caller.

2. **Paired order+LUT generation + canonical (cx,cy) order cache.** The 27 raw strategies collapse to 12 canonical coeff geometries; where both forward order AND inverse LUT are needed (enc_coeff_order.cc), one traversal could emit both, and orders could be cached by normalized geometry rather than raw strategy. Setup-cost only; only a win where both are consumed together (doubles write bandwidth otherwise). Measure before landing.

3. **QF-bucket precompute** for threshold-rich frames (split `BlockCtxMap::Context` qf-threshold scan into a precomputed per-block bucket plane). Keep the direct scan when `qf_thresholds.size() <= 1` (the common case). Profile-led — only helps multi-threshold frames; the default ctx map has 0 thresholds.

4. **Default `BlockCtxMap` alloc avoidance** (use `kDefaultCtxMap` static directly until a custom map is parsed; num_ctxs=15/num_dc_ctxs=1 are invariant). Cold-start latency only, not hot-loop. Needs move-ctor rebind of the data pointer. Marginal.

5. **Header zero-density table dedup** (`extern` decl + single .cc definition for `kCoeffFreqContext`/`kCoeffNumNonzeroContext`). WASM .data size only; measure object/.wasm sections for actual duplication first. Do NOT convert to arithmetic.

6. **`CountBlocksByType` bulk single-pass count.** Only worth it if a call-site audit finds repeated `CountBlocks` scans over the same image; otherwise sequential scan is fine.

7. **Packed 1-byte `AcStrategy`** (store raw byte, derive type/is_first). Profile-led; inlined call sites likely scalar-replace the current object already, so probably no gain and adds mask/extend ops.

8. **Forensic audit: `kZeroDensityContextCount` (458) vs `kZeroDensityContextLimit` (474).** Not an optimization — verify entropy-context allocation reserves the right bound and no malformed-stream path can index 458..473. Belongs once-per-block / in allocation policy, never as a per-coefficient clamp.

9. **nzero rect-fill / strategy-map rect-fill via std::fill_n/memset with a size threshold** (dec_group nzero propagation + the new SetUnchecked). Minor; bulk fill helps only large footprints, scalar stores win for 1x1/2x2. Optional micro-tune.

---

## 2026-06-29 — enc_entropy_coder.cc: deferred cross-file / architectural levers (ChatGPT pass)

Context: round-2 micro-opt pass on `lib/jxl/enc_entropy_coder.cc` (5th-hottest file).
Implemented byte-exact in-file (branch `perf/enc-entropy-count-decomp-jun29-z4x`,
submodule capebio): count-decomposition for both nzero counters. The following
larger ideas were surfaced but DEFERRED — each crosses file boundaries and/or
needs ratio/timing evidence before landing:

- **D1 — quantizer-produced exact nonzero counts.** Have the final quantization
  stage emit one exact AC-nonzero count per (channel, transform) into a compact
  side stream; tokenization then skips its leading SIMD count pass entirely.
  Biggest potential win (deletes a whole coefficient read for large transforms)
  but cross-file (enc_quant / enc_group plumbing) and must count only *after*
  the last stage that can alter coefficients. Needs an A/B build to size it.
- **D2 — entropy-scan-order coefficient staging.** Producer writes coefficients
  already in scan order so the token loop reads `block[k]` contiguously instead
  of `block[order[k]]` (permutation gather). Removes the order-table load and
  scattered loads, best for large transforms / WASM. Large upstream disturbance
  (may regress the quantizer's contiguous writes) — measure before committing.
- **D3 — persistent token-buffer high-water reserve.** Current per-group
  `output->reserve(worst_case)` over-commits for sparse groups and pins a large
  per-worker capacity. Replace with a `TokenizeScratch` carrying a rolling
  high-water hint (EncCache-level, cross-file). NOT byte-exact-affecting; needs
  telemetry (requested vs final size, realloc count, peak RSS, first-group ms)
  before tuning. Do NOT swap to `resize()+data()` raw writes — that value-inits
  the whole pessimistic buffer (worse for sparse).

## enc_convolve_separable5.cc (2026-06-29, after border-dedup landed on perf/conv5-border-dedup-jun29-bd7)

The big win (vertical-band rolling ring, +31-49%) is already in trunk. Border-row
horizontal dedup is now done (byte-exact, helps small/short planes; neutral on
full frames). Remaining ideas, all DEFERRED with reasons:

- **N / N+1 SIMD-width cliff.** Widths exactly `Lanes` or `Lanes+1` fall to the
  scalar `SlowSeparable5` (the fast path needs `xsize >= Lanes + kRadius`). A
  dedicated one-vector kernel (load center, mirror both sides via Neighbors +
  MirrorLanes, scalar-finish the +1 column) would cover them on SIMD. DEFERRED:
  niche (only two exact widths per target); needs its own HWY_SCALAR guard and a
  correctness pass against SlowSeparable5. Real-benefit unknown without width
  telemetry from butteraugli/detect_dots.
- **x-tiling for short-wide geometry.** The pool splits work by y-band only; a
  few-rows-tall, very-wide plane yields too few band-tasks to fill cores. Add x
  tiles ONLY for short/wide (keep y-band default). Constraints: internal tile
  boundaries use ordinary HorzConvolve, only the global left/right edges mirror,
  never call Separable5 on sub-Rects (horizontal borders are rect-bound).
  DEFERRED: profiling-gated; needs evidence such planes dominate any caller.
- **Status propagation from RunInteriorRows.** `RunOnPool`'s Status is asserted
  in debug then discarded; `Run()` always returns true. Latent reliability gap
  (a runner failure reports success), not perf. DEFERRED: out of optimization
  scope; thread to Run() in a separate correctness change.
- **Weight-family dispatch (identity / 3-tap / horizontal-only / vertical-only).**
  Classify `WeightsSeparable5` once at construction and skip zero taps. DEFERRED:
  data-led only — needs coefficient telemetry that those families actually reach
  this function; also changes NaN/signed-zero propagation, so not byte-exact.
- **Scalar-tail abs/Mirror hygiene.** The remainder loop recomputes `std::abs(dy/dx)`
  weight indexing and calls `Mirror` for every column incl. interior ones. Could
  hoist weights and skip Mirror until the final two columns. DEFERRED: micro
  (< Lanes columns/row), and must preserve the exact 25-term accumulation order
  to stay byte-exact — low value, easy to get subtly wrong.

---

## enc_convolve_separable5 — ChatGPT 3-pass analysis leftovers (2026-06-29)

Context: y-reuse ring + remainder-collapse already landed on submodule main
@10783f7e; border-row dedup landed on `perf/enc-conv5-border-dedup-jun29-r3x`.
Remaining ChatGPT suggestions, deferred:

1. **SIMD width-cliff (xsize == N or N+1).** These widths fall to `SlowSeparable5`
   though one custom vector could cover them. NOT byte-exact vs the current slow
   path (different numerical reduction tree for those widths) → needs an explicit
   tolerance/identity decision before landing. Low value (narrow rects only).
2. **x-tiling for short/wide geometry.** When `num_bands` is tiny (few-row, very
   wide rect) the y-band scheduler under-fills cores. Add x-slicing (internal
   tiles only; global edges keep mirroring; never recurse `Separable5` on sub-
   rects — horizontal borders are rect-bound). Scheduler change; butteraugli's
   roughly-square pyramids rarely hit this. Needs its own benchmark.
3. **SIMD output-rect / in-place API.** Fast path requires `SameSize(rect,*out)`
   and origin-zero output; callers needing a sub-rect must materialize+copy. A
   `Separable5ToRect` (StoreU when unaligned) or delayed-write in-place variant
   could remove a full-plane round-trip. Audit `butteraugli.cc` Blur and
   `enc_detect_dots.cc` for such temporaries first — potentially bigger than any
   inner-loop change, but a caller-contract refactor.
4. **Weight-family classification** (identity / 3-tap / h-only / v-only). Classify
   once in `WeightsSeparable5` ctor, dispatch specialized kernels. Needs
   coefficient telemetry to justify; risks NaN/signed-zero policy changes and
   per-Highway-target code bloat. Data-led only.
5. **Status propagation.** `RunInteriorRows` does `JXL_DASSERT(status); (void)`
   — a pool failure is reported as success. Thread through `Run()`. Reliability,
   not perf; tiny.

---

## enc_adaptive_quantization — ChatGPT 4-pass analysis leftovers (2026-06-29)

Context: This is the hottest remaining enc file. Big batch already landed on
submodule main @10783f7e (6c8dd38a): TileDistMap margin==0 fast path, FuzzyErosion
2×2 fusion, MaskingSqrt kSqrtMul precompute, AdjustQuantField 1x1-skip + mean-only-
when-covered≥4, quantizer-const hoist, MaxError any_change exit + per-block clip,
terminal-iteration Butteraugli skip. THREE more byte-exact opts landed on branch
`perf/enc-aq-fixedpoint-hfblue-jun29-q8x` (capebio, off 10783f7e): cur_pow==0
fixed-point early-exit (+13% e9 on real RAW), HF-dominates-blue short-circuit,
HfModulation dy==7 vertical no-op. Remaining ChatGPT suggestions, deferred:

### Output-changing (need ratio + Butteraugli regression, NOT byte-exact)
1. **pow(x, 1/16) → 4× std::sqrt** in TileDistMap tile_dist. Mathematically equal,
   much cheaper (esp. WASM), but NOT bit-identical → changes AQ decisions → output
   bytes. Gate behind size/Butteraugli corpus regression.
2. **std::pow(diff, cur_pow) → FastPow2f(FastLog2f·k)** in the quant-update loop.
   cur_pow is only ever 0.2 (i<2) or 0 in practice. Fast path promising on WASM;
   crosses quant-bin boundaries → corpus-validate.
3. **SIMD fast-log for mask1x1** (replace scalar std::log1p per pixel with vector
   FastLog2f). Large scalar-libm cost on the full-res 1x1 Laplacian pass. Changes
   the masking heuristic → validate on HDR/low-light/edge-heavy images.
4. **Merge the two gamma-Laplacian walks** (scalar mask1x1 + SIMD 4×4 pre-erosion
   both compute gammac·(in−neighbour_avg)). One signed-Laplacian producer feeding
   both. Scalar-vs-SIMD association differs → not byte-exact; experiment only.

### Architectural (large surface / correctness risk)
5. **Persistent AQ round-trip context (E/F — ChatGPT's "most strategic").** Reuse
   PassesDecoderState / ModularFrameEncoder / render pipeline / GroupDecCache /
   decoded ImageBundle across the 2–5 FindBestQuantization iterations instead of
   rebuilding each round; plus an AQ-narrow InitializePassesEncoder that skips
   special-frame/entropy-token/bitstream-only work (note the existing
   `special_frames.resize(num_special_frames)` rollback — generic init does work
   AQ discards). Biggest potential multi-ms win but touches decoder reset
   contracts → must prove byte-exact across corpus (stale group caches are the
   hazard). Compounds with the landed render-pipeline descriptor reuse.
6. **Strategy-cell native representation.** After AdjustQuantField every member of
   a variable AC strategy is uniform and TileDistMap broadcasts one residual back
   over the same footprint; the iterative state is really one (q, residual,
   initial) per AC-strategy root. Represent it that way (no expand→update→collapse
   per block; direct strategy residual accumulation in the comparator). Removes
   duplicated div/pow/lround/clamp. Large refactor touching the Quantizer API
   (SetQuantFieldFromStrategyCells); byte-exactness needs care.
7. **Incremental sparse round-trips.** After the first refinement only some raw
   quant cells change; re-encode/re-render only affected groups + AC/EPF/render/
   Butteraugli halo. Very high complexity (invalidation-radius correctness);
   highest payoff at Tortoise. Research-grade.
8. **Staged Gamma+HF fusion** (G, conservative form). Combine the Gamma and HF
   per-block scans (both consume X/Y) — NOT the full 3-way fuse (register
   pressure / WASM regression risk per ChatGPT's own walk-back). Keep independent
   accumulators/order for byte-exactness; benchmark native + WASM separately.

### Minor byte-exact, deferred (low value or small risk)
9. **tile_distmap buffer reuse** across iterations (refactor TileDistMap to fill an
   existing ImageF). Saves a small blocks-sized alloc per iteration (only 2–5×);
   marginal now that #1 cuts iterations.
10. **score / ScaleImage(-1) debug-gating.** Release-dead: TileDistMap raises diff
    to the 16th (even) power so the sign flip can't matter; `score` only feeds a
    debug printf. Pass nullptr + #if-guard. Tiny.
11. **High butteraugli_target (≥14) modulation bypass.** dampen==0 → result is a
    constant base_level; skip Gamma/HF/Blue entirely. Rare target; low value.
12. **ComputeTile SIMD-tail off-by-one** (`x + 1 + Lanes < x_end` → `x + Lanes <
    x_end`). Recovers one vector/row but is a bounds-sensitive change near the
    right-neighbour load — needs careful padding audit; skipped as too risky for
    one vector.
13. **mask1x1 tile-local fused blur** (fuse raw mask1x1 production with Symmetric5
    over each tile's core + 2px halo, removing the full-res intermediate + barrier).
    Seam risk at internal tile boundaries (current halos only cover the outer rect
    edge); benchmark vs the optimized full-image Symmetric5 before adopting.
14. **Max-error: accumulate max during group decode** instead of writing then
    re-reading the full decoded image. Complication: strategy regions crossing
    group boundaries (need root-index map + reduction). Max-error mode only.

### enc_convolve_separable5 — secondary items (2026-06-29)

The register rolling ring is the shipped interior optimum (x-tile scratch ring
tested and rejected, see rejected-opts CONV5-2). Remaining ChatGPT secondaries,
deferred as low-EV for the WASM 4-lane butteraugli/dots callers:

15. **Equal-axis 3-weight load** (byte-exact). `butteraugli.cc` Blur calls
    Separable5 with `horz == vert`. Detect equality once and load 3 broadcast
    weight vectors instead of 6, passing each to both stages → frees 3 vector
    registers in the hot `RingColumn`. Same Add/MulAdd order → byte-exact.
    Uncertain micro-win; the ring is not spill-bound on AVX2/WASM today (it
    already hits the +39–49% ceiling), so register relief may not show. Measure
    before adopting.
16. **Narrow capped-SIMD fallback** — AVX-512-only concern (widths 6–17 fall to
    SlowSeparable5). Irrelevant to the WASM ship target (already 4-lane; only
    sub-6px images affected). Skip unless a native AVX-512 path matters.
17. **Direct 2-D / isotropic kernel** — saves a few arithmetic ops but keeps the
    25-source-load pattern and **reorders accumulation → NOT byte-exact**. Would
    change butteraugli scores → encode bitstream; needs decode-SHA + Butteraugli
    quality gating, not the encode-SHA gate. Out of scope as a default path.

---

## dec_ans.{h,cc} TTFP pass — deferred (2026-06-29)

Branch `perf/dec-ans-ttfp-inline-jun29-z4k1` (capebio submodule, off main
@10783f7e) landed 3 byte-exact wins (W1 hot-path no-LZ77 inline via
`ReadHybridUintClusteredMaybeInlined`; W2 `std::move(counts)` into by-value
`InitAliasTable`; W3 ReadHistogram heap vecs → 258-stack arrays). 14/14 testable
files decode byte-exact (native static djxl OLD@10783f7e vs NEW), native ST
+2.5% median on _cap (noisy, no regression). Deferred from the same analysis:

1. **Definitive WASM/browser TTFP bench of W1.** Native ST is +2.5% but noisy and
   a weak proxy — inlining wins are WASM-codegen-dependent (cf. the "SSSE3 proxy
   lied for transpose" lesson). Real gate before merge: rebuild the dec WASM tiers
   from this branch and A/B first-paint via the browser harness (flipflopdom) on
   real RAW→JXL O1 blobs. ~34min WASM build.
2. **Split LZ77 state out of `ANSSymbolReader` (or at least drop the
   `special_distances_[120]{}` zero-init).** No-LZ77 readers currently zero-init
   ~480B + carry LZ fields. Cold-start/first-group win, but needs a profile to
   confirm reader construction shows up, and MSan/fuzz after removing the init.
3. **Bounded LZ window.** 4 MiB (`kWindowSize`) allocated per LZ reader regardless
   of how many values it can emit. Pass a proven max-emit bound from the caller →
   allocate `min(kWindowSize, max_emit)`. Needs caller plumbing; LZ-streams/cold
   start only.
4. **Virtual zero-run instead of the initial `distance==0` memset.** Up to 4 MiB
   memset before useful decode. Model as a `zero_run_` flag (incl. Save/Restore).
   Needs real-corpus frequency of first-run zero copies to justify.
5. **`IsSingleValueAndAdvance` degenerate fast-path.** Use precomputed
   `degenerate_symbols[ctx]` (add a `const int*` reader member) to skip the alias
   lookup. Byte-exact-plausible but needs careful verification that value + state
   advancement match exactly; marginal (only when that optimization path is hit).
6. **`uint16_t alphabet_sizes` overflow hardening (dec_ans.cc:204-208).** Real
   latent bug: `DecodeVarLenUint16()+1` can be 65536 → wraps to 0 in uint16_t
   BEFORE the `> max_alphabet_size` check (valid streams never reach it, so
   byte-exact). Malformed-input robustness only; deserves its own fix + fuzz, not
   a perf-pass rider.
7. **Defensive `max_num_bits = 0` reset + `degenerate_symbols.assign(n,-1)`.**
   No-op in the current flow (ANSCode is freshly constructed per DecodeHistograms,
   not reused) — only matters if ANSCode reuse is ever introduced. Harmless; skip
   until reuse exists.
8. **Per-target A/B of (a) alias-table prefetch on/off and (b) ANS normalization
   branchful vs branchless.** Both are target-sensitive (the source comment only
   claims parity "on SKX"); choose at compile time per target, never a per-symbol
   runtime heuristic. Needs WASM + native A/B.
9. **Setup micro-ops:** single `Refill()` batching in DecodeVarLenUint8/16 +
   DecodeUintConfig; table-lookup (CTZ) for the unary shift prefix (the file's own
   `TODO(veluca)`); packed-RLE rewrite of the histogram scratch (W3 already moved
   it to the stack — the further RLE-into-logcounts packing is byte-exact-risky and
   low value).

---

## enc_modular R1–R4 + D2 pass (2026-06-29, branch capebio/perf/enc-modular-r1to4-d2-jun29-q4z)

Landed (byte-exact, see branch): R1 two-phase single-group prepare + pool for the
Global RCT/WP search; R2 AddACMetadata zero-channel construction; R3 reserves; R4
uint32 extra-channel guard + gi_channel_ reuse-clear; D2 EstimateCost workspace
reuse across the RCT search.

Deferred from THIS pass:
1. **Subsampled `AddVarDCTDC` exact allocation (4:2:0 / 4:2:2).** The shared
   `Image::Create(...,8,3)` makes three full-res planes; the subsampled branch then
   `shrink()`s the two chroma planes (full-res backing already allocated). Allocating
   each channel at final dims needs splitting the shared create across the four
   branches. Rare path — the RAW pipeline is 4:4:4, so never exercised here. Byte-exact
   memory-only win; do it if a subsampled-input workload appears.
2. **R1 pool speedup is multi-thread-only and single-group-only.** The two-phase split
   is byte-exact and removes a real data race, but its FwdRct/do_transform parallelism
   only helps when (a) encode uses a thread pool and (b) the frame is one group (small
   images / TTFP preview blobs). The 1-thread A/B harness cannot measure it; verified
   byte-exact instead. Multi-thread single-group bench is the open measurement.
3. **D1 palette `cost_before` carry-forward and D3 bounded EstimateCost scoring**
   remain deferred (see external/libjxl-012/HANDOFF_enc_modular.md). D1 changes the
   bitstream (needs a size bench); D3 is NOT byte-exact (fractional-entropy floor is
   nonlinear, so dropping the constant non-colour channels can flip a near-tie RCT
   choice) — confirmed this pass, do not land as "byte-exact".

---

## compressed_dc DC-context-map (2026-06-29)

Branch `capebio/perf/dec-compressed-dc-ctxmap-jun29-q7x` @f7f5db73 (off submodule
main 0ba69efd) landed #5 (4:4:4) + #6 (subsampled) byte-exact builder
specializations. Deferred from that pass:

1. **#6 vertical chroma reuse.** Current #6 reuses each native chroma bucket only
   *within* a row (x>>HShift monotone). A native chroma row is still reclassified
   for every luma row it covers (2 rows in 4:2:0). Full 2-D reuse needs a per-row
   native-bucket scratch buffer; left out to stay allocation-free and avoid a
   per-DC-group alloc regression on small groups. Revisit only if a profile shows
   the subsampled context build is hot (it is JPEG-recompression territory; the
   RAW→XYB pipeline is 4:4:4 and never hits #6).

2. **Integrator decode-A/B gate.** Equivalence here is proven on the isolated
   builder (tools/dc_ctxmap_ab.cc, 6.66M bytes, 0 fails) + by construction. The
   full-lib gate is a decode A/B (native static djxl or WASM) on a stream that
   actually signals num_dc_ctxs>1 — RAW-app JXLs may never exercise this path, so
   pick/encode a multi-DC-context VarDCT stream to confirm before merge.

---

## enc_xyb (3rd-hottest) — 2026-06-29 (branch capebio/perf/enc-xyb-copy-elim-jun29-k3w9)

Landed this pass (byte-exact, verified native cjxl A/B): ChatGPT **1A** (fused
`LinearSRGBToXYBAndCopy`) + **1B** (out-of-place `LinearSRGBToXYBFrom`) copy
eliminations in `ToXYB`. These fire only for linear-sRGB / non-sRGB-CMS inputs at
VarDCT+kKitten — the RAW→sRGB app path never reaches them (sRGB branch untouched).

Remaining ChatGPT enc_xyb ideas NOT pursued (deferred, not rejected):

1. **ScaleXYB → Highway SIMD + dispatch.** Real SIMD hole (scalar per-pixel,
   outside HWY_NAMESPACE). Worth it only if `ScaleXYB` is hot — it runs on the
   scaled-XYB VarDCT path. Needs a flipflop/micro-harness to justify; not
   byte-exact-trivial (must preserve op order, no MulAdd). Output unchanged.
2. **No-clamp template (skip 3× ZeroIfNegative for proven-nonnegative input).**
   3 vector clamps vs 3 cube roots — tiny. Needs an importer-propagated
   "samples nonnegative" invariant that the API doesn't carry today. Low EV.
3. **Shorten OpsinAbsorbance coeff lifetimes / YCbCr unit-mul deletion (kDiffR/
   kDiffB == 1.0).** Disassembly-gated; clang likely already folds. Low EV.
4. **Area-stripe scheduling for the 3 XYB paths** (they do one task/row; only
   RgbToYcbcr stripes). Geometric, not byte-exact-trivial; RAW images are large
   enough that per-row tasking rarely starves the pool. Needs benchmark.
5. **Direct RGB8→XYB ingest / prepared-constants cache / empty-image early-exit.**
   Architectural, belong at the import boundary, not inside enc_xyb.

Verify-harness note: the minimal static cjxl can't read PNG/JPEG pixels, so the
1B (CMS) vector needed `-DJPEGXL_ENABLE_APNG=1 -DJPEGXL_BUNDLE_LIBPNG=1` to read
an AdobeRGB-ICC PNG. A ToXYB micro-flipflop (to actually *measure* the copy-elim,
which is ~0.03% of an e9 encode and thus unmeasurable at process scope) was not
built — the win is provably-less-work and app-irrelevant. Build if a future pass
wants a number.

---

## CfL X-zero family — byte-exact follow-ups (deferred 2026-06-30)

Context: implemented decoder X-CfL-free dequant specialization in dec_group.cc
(branch `perf/dec-group-xzero-dequant-jun30-x4k9`, capebio, off submodule
00f4d7fc). When the X color-correlation factor is exactly 0 (XYB default for the
whole X channel), `MulAdd(0, dequant_y, dequant_x_cc) == dequant_x_cc` bit-exact,
so a `kXCfL=false` template variant drops one vector FMA per X lane. These
sibling items from the same ChatGPT CfL analysis are NOT done — clean, byte-exact,
worth a future pass:

1. **compressed_dc.cc DC X-zero specialization** — `DequantDCImpl<bool kUseXDCfL>`
   gated on `cfl_factors[0] == 0.0f`. Line 228 still unconditional
   `Store(MulAdd(in_y, cfl_fac_x, in_x), ...)`. Same byte-exact argument; smaller
   win (1 sample/8x8 block vs per-coeff) but pairs cleanly. DC path = early decode.

2. **dec_group JPEG `RatioJPEG` hoist** — JPEG-recon branch recomputes
   `ColorCorrelation::RatioJPEG(row_cmap[c][abs_tx])` per 8x8 block per channel
   (dec_group.cc ~617). Hoist to per-color-tile `jpeg_scale[3]`. Exact integer
   arithmetic, JPEG-reconstruction path only (irrelevant to RAW→JXL app workflow).

3. **chroma_from_luma.cc micro-cleanups** — transactional `DecodeDC` (parse into
   locals → validate both bases → commit once + single `RecomputeDCFactors`,
   currently `SetColorFactor` recomputes early then again at end); `GetColorFactor()`
   return `uint32_t` not `float` (stored type is already uint32_t). Header-decode
   micro, not ms-level.

WASM decode A/B (StandardMultifileTest / section bench, ~34min build) is the
integrator gate for the X-zero magnitude — native AVX2 harness only shows
direction (one FMA; WASM drops mul+add, no native FMA → larger win expected).

---

## ans_common.cc / .h — CreateFlatHistogram write-count tweak (2026-06-30)

**Deferred, not implemented.** ChatGPT pass proposed making `CreateFlatHistogram`
(ans_common.h) write `min(rem, len-rem)` adjusted entries instead of always `rem`
(start from `count+1` and decrement the suffix when the remainder is the larger
half). Byte-identical output, verified by inspection.

**Why deferred:** truly negligible — the function builds a tiny vector and is not
on any hot path; the change adds a branch + a second construction path for a
saving of at most len/2 integer increments. Fails the surgical/simplicity bar for
the marginal gain. Revisit only if a profile ever flags flat-histogram setup.

The real ans_common win (allocation-free `InitAliasTable`, 3.61x faster table
build, byte-exact) landed on submodule branch
`capebio/perf/ans-common-allocfree-jun30-z7k` (PUSHED, not merged). The three
ChatGPT "bug"/Lookup claims were debunked — see docs/1 rejected optimizations.md
(ANS-R1..R3).

---

## enc_cluster: merged-population-cost cache (2026-06-30)

Branch `capebio/perf/enc-cluster-fuse-reindex-jun30-v8n3` (PUSHED, not merged).

**Deferred (benchmark-gated, NOT landed):** In the kBest merge loop, a valid
`HistogramPair` already paid for the exact merged `ANSPopulationCost()`. When
that pair is accepted, the loop recomputes the same cost after `AddHistogram`.
Caching it in the heap entry would save one `ANSPopulationCost()` per accepted
merge — but it widens every `HistogramPair` from 16 to >=20 bytes, hurting
priority-queue cache density for ALL queued (mostly rejected) negative pairs.
Net effect is data-dependent (merge acceptance rate vs queue depth) and must be
measured on a real encoder corpus at e9 before landing. Not byte-affecting
(pure caching), so low risk — purely a perf trade-off.

**Also deferred — full timing gate:** the landed changes are byte-exact and
each is a strict work/alloc reduction (fused traversal, no deep-copy reindex,
O(α) union-find vs O(N) scan, no per-block branch in distance/KL). Per the
"byte-exact + theoretically better => choose new" rule they were taken without
a flip-flop, since the timing harness requires a full libjxl-012 encoder build
(native cjxl or WASM enc). Integrator gate: native/WASM enc A/B at e9 (kBest)
for end-to-end byte-identical output + a timing delta.

---

## 2026-06-30 — quantizer-inl.h AdjustQuantBias SIMD reschedule (needs assembly + bench)

**Deferred, not implemented.** Proposed reordering of `AdjustQuantBias`
(`quantizer-inl.h`): compute `ApproximateReciprocal(quant)` and the
`Set(df, biases[c])` / `Set(df, biases[3])` broadcasts up front so sign/mask work
overlaps reciprocal latency. Byte-exact (pure independent-op reorder, identical ops
and approximation).

**Why deferred:** no evidence it is a win. The ops are already independent and the
compiler scheduler reorders them at -O2/-O3; hoisting the reciprocal lengthens its
live range and may cost a register/spill. This helper is hot (dec_group + enc_group
AC dequant, instantiated SSE2/SSE4/AVX2 + WASM). Decision needs per-target generated
assembly inspection and a flipflop/A-B across the target matrix — not a source-level
guess. Revisit only with that evidence.

## 2026-06-30 — Quantizer lower-bound clamps (correctness question, not perf)

**Deferred as a correctness question.** A pass proposed `std::max(1, lround(...))` in
`ScaleGlobalScale` and `std::max(1.0f, fval)` in `ComputeGlobalScaleAndQuant`,
guarding against `global_scale`/`quant_dc` rounding to 0 (→ `inv_quant_dc_ = inf`).
Upstream has no such guard. Excluded from the byte-exact branch because it changes
output. **Open question for the maintainers:** is the zero/near-zero path actually
reachable from any encoder configuration? If yes, this is a real robustness fix worth
landing as an explicit (non-byte-exact) change; if no, leave upstream as-is. Needs a
reachability analysis over the quant_dc / global_scale derivation, not a blind clamp.

## 2026-06-30 — enc_bit_writer append pass: integrator verification gate (deferred)

Branch `perf/enc-bit-writer-append-jun30-w8k4` (capebio, off submodule main `00f4d7fc`)
is byte-exact-verified by a standalone A/B harness (192 cases, 0 mismatches) and
real `-fsyntax-only` compiles of `enc_bit_writer.cc` + 7 caller TUs, but two checks
need the integrator's full toolchain and are deferred:

1. **Full `enc_bit_writer_test` execution.** gtest source is absent from the worktree's
   `third_party`, so the extended `AppendUnaligned` gtest (all 8 dst offsets, multi-block
   + partial-bit sources, back-to-back appends, zero-tail trailing write) was logic-proven
   via the standalone harness but not run under gtest. Run `ninja enc_bit_writer_test`.
2. **WASM enc A/B byte-exact.** The templated `WithMaxBits` (was `std::function`) is
   codegen-dependent; confirm OLD-vs-NEW encoder output is SHA/size identical on a real
   RAW→JXL stream (e3 + e9). Theory says byte-exact (only call binding changed, no bit
   semantics), but the workflow gates output-shape changes on decode/enc SHA, not theory.

Harness to reproduce timing: `clang++ -O3 -std=c++17 tools/enc_bit_writer_append_ab.cc -o bw_ab`.

---

## LJPEG micro-ops — WASM confirmation of the hot-path codegen pieces (2026-06-30)

Branch `perf/ljpeg-microops-jun30-z7k` (super only; `crates/raw-pipeline/src/ljpeg.rs`).
Byte-exact pass: fast8 `[u32;256]`→`[u16;256]`, packed `lookup` `Vec<u16>`, const-generic
`BitReader` (telemetry compiles out of `decode_tile`), oversubscribed-DHT panic→bail guard,
struct DHT cache (no probe alloc), one-entry thread-local plan cache, generic-kernel stack
array + direct `&HuffTable` + unchecked store. Already verified byte-exact: 21 ljpeg unit
tests (known-output oracles unchanged), full crate suite 157 pass, **parity EXACT on 165 real
DNG tiles** (cps=2/prec=16; fast8 resolves 99.89% of symbols).

**Native timing — non-regression, modest floor win.** `cargo run --release --no-default-features
--example ljpeg_c1_flip` on `PXL_20260527_180319603.RAW-02.ORIGINAL.dng` (165 tiles), OLD
(unmodified main) vs NEW binaries, min-of-5 (machine is contended — 7 sibling worktrees — so
**min** = contention-free floor; upper samples are pure upward noise, incl. a 401/502 ms
outlier):

| | min (floor) | median band |
|---|---|---|
| OLD | 266.4 ms | ~285–316 |
| NEW | 248.3 ms | ~297–320 |

Floor ≈ **−7%**; medians overlap inside the noise band. Honest read: the dominant cost is the
per-symbol Huffman arithmetic (unchanged); the win is the smaller hot LUT + removed telemetry
stores + 164 skipped plan re-parses, which clears the noise floor only at the min.

**Open (integrator gate):** the app decodes RAW via the **WASM** raw-pipeline, not this native
build. The fast8-u16 shrink and the const-generic telemetry removal are **codegen-dependent**
(L1 footprint / store elision differ under emscripten/clang + wasm32). Confirm the same parity
+ non-regression on a `wasm32-unknown-unknown` build of `raw-pipeline` (the existing RAW→lightbox
flipflop / section bench), folded into the next shared WASM rebuild — not a per-opt build. Theory
+ native parity say byte-exact and ≥-neutral; this only re-checks the wasm codegen delta.

---

## LJPEG hot-path pass (2026-06-30) — deferred API + WASM gate

Branch `perf/ljpeg-hotpath-jun30-h4t9` (on z7k `@1c089828`): byte-exact hot-path micro-ops,
**~30% native decode floor** (min 84.2 ms vs z7k 119.8 ms; 165 real DNG tiles cps=2/prec=16;
FNV fingerprint `0x199b1481ead6ac12` identical OLD/NEW). Harness:
`examples/ljpeg_hotpath_flip.rs` (prints fingerprint + interleaved decode timing for cross-build
OLD/NEW comparison).

**Deferred — public prepared-plan execution API.** The proposal added `LjpegPlan::decode_into`
/ `decode_into_stats` + `execution_plan_check` so a caller can prepare a plan once and decode
many tiles against it. No caller exists today, and the thread-local one-entry `LAST_PLAN` cache
(z7k) already gives the same skip-the-reparse benefit transparently through `decode_tile`.
Deferred until a caller actually wants to hold an `LjpegPlan` across tiles — then expose the API
plus `execution_plan_check`.

**SWAR fill (kept, real-decode neutral).** The branchless u32 0xFF-detect clears its isolated
gate (5.4%, `ljpeg_fill_swar_flip`) but is **neutral in real decode** (fill is amortized off the
per-symbol critical chain; the 30% comes from the `real_in_buf`/guard/`extend` changes). Kept per
the example gate + rule 10; the integrator may drop commit `eee8564f` to keep `unsafe` minimal.

**Open (integrator gate):** the app decodes RAW via the **WASM** raw-pipeline, not this native
build. Branchless `extend`, the removed per-symbol masks, and the SWAR unaligned u32 load are all
**codegen-dependent** under emscripten/clang + wasm32. Confirm parity (fingerprint) +
non-regression on a `wasm32-unknown-unknown` build of `raw-pipeline` (RAW→lightbox flipflop /
section bench), folded into the next shared WASM rebuild. Native says byte-exact + ~30% faster;
this only re-checks the wasm codegen delta. Same gate class as the z7k pass above.
## 2026-06-30 — tone_simd.rs deferred (from the matrix-fused-seam pass)

Branch `perf/tone-simd-matrix-seam-jun30-t9k2` landed the byte-exact seam. Two ChatGPT
proposals are plausible but not worth landing now; revisit only with a flipflop win, and
note the ceiling: the tone matvec is **~4% of the frame** (post-LUT clamp+cast+gather is
~45% — the real bottleneck, already at its measured floor). Tone-math micro-ops cannot move
the frame much.

1. **`TonePlan` enum (LumaOnly / Matrix / Active), built once per render.** Would fold mode
   classification + coefficient prep out of `apply_tone_bulk` into a small state machine that
   the kernel matches on. The seam already gives the common (Matrix) path its "prepare once"
   benefit; the enum's extra value is only the LumaOnly branch (below) and removing the
   per-call `luma_weights`/`c1`/`c2` setup from the active path (a handful of flops, once per
   block). Larger surface (touches all 3 backends + the pipeline call sites). Gate on a
   flipflop showing the active-path setup is measurable.

2. **`sat == 0` luma-only SIMD kernel** (one `lm·rgb` dot + 3 broadcast stores vs a full 3×3
   matvec). Byte-exact to the current matrix path (rows all equal `lm`), ~3× fewer flops on
   that block. Triggers only when the saturation slider is at −1.0 AND vibrance is 0 (full
   monochrome). If B&W conversion ever becomes a measured hot path, add it (probably as the
   LumaOnly arm of the TonePlan enum); until then the matrix path covers it correctly.

3. **`BLK` tile sweep (512/1024/1536/2048).** Only with `tone_matrix_prepared_flip` /
   `process_simd_flip` evidence; the 24 KiB working set is currently deliberate.
## FS-D1: frame_stats u64 exact-integer luma accumulator (native + WASM, coordinated) (2026-06-30)
## FS-D1: frame_stats u64 exact-integer luma accumulator — ✅ DONE 2026-06-30

**Shipped** on `perf/frame-stats-u64accum-jun30-m4k2` (native-only). Replaced f64+Kahan
luma_sum/luma_sq in both scalar and AVX2 with exact u64 sums (luma²≤4.23e9 ⇒ u64 exact to
~4.3 Gpx). Result: scalar **−34%..−36%** (interleaved Kahan-vs-u64 A/B), AVX2 neutral-to-
faster, scalar==avx2 bit-identical **for every input** (prior Kahan parity was incidental).
On the 5-size dump corpus (incl 24MP) the u64 output is bit-identical to the prior Kahan
output — observed drift zero; ≤1 ULP only on adversarial inputs.

**The original "deferred" premise was WRONG and is corrected here:** native and WASM were
NOT one coordinated telemetry contract. The WASM kernel (`src/lib.rs` `fs_core_scalar`)
accumulates **plain f64, no Kahan**, *by design*, to byte-match the JS
`analyzeProgressiveFrame` reference (JS numbers are f64). Native used Kahan. So the two
were already non-identical past ~6 MP — two independent contracts. Porting u64 into the
WASM kernel would BREAK the wasm↔JS byte match (JS can't do u64-exact without BigInt), so
WASM is deliberately left on f64. D1 is correctly native-only; there is no cross-target
desync to coordinate.

**Still open (separate, genuinely cross-target):** the `luma_variance` divisor. It scales
variance by `1/65025` (NOT [0,1] — peaks ~16256.25). The doc is now corrected to state the
real range. Changing the *formula* to a true [0,1] metric (÷ `65025²/4`) would touch native
+ WASM + JS together and is a deliberate telemetry-versioned change — left deferred.

## FS-D2: hash-free metrics fast path — REJECTED (dead code, no caller) 2026-06-30

## FS-D2: hash-free metrics fast path (2026-06-30)

The 8-lane FNV hash is a serial recurrence across blocks (each block depends on the
prior) — it is the kernel's real throughput ceiling, not cache locality. Change-detection
needs the hash; exposure/contrast triage (`mean_luma`, `luma_variance`) does not. A
separate metrics-only entry (no hash, no `vpmulld` dependency chain) would let those
callers run faster. Worth it only as a deliberate API split with a real caller that wants
metrics without the change-id — not a runtime flag inside the hot loop.
## jxl_casaencoder.rs — deferred structural levers (2026-06-30)

Context: final optimization pass on the encoder wrapper. The landed change
(`perf/casaencoder-hint-norm-k9x`) is allocation-only and byte-exact. The wrapper
is now well-shaped; its remaining *real* cost is the libjxl-internal copy of every
submitted plane, which no Rust-side micro-op can remove. The items below are the
genuine large levers — all are **features needing new `jxl-ffi` bindings** and/or
behavioral changes, so they are out of scope for a surgical byte-exact pass and are
deferred to the integrator/owner with explicit cost notes.

1. **Chunked / streaming zero-copy input (highest peak-memory lever).**
   `JxlEncoderAddImageFrame` and `JxlEncoderSetExtraChannelBuffer` both **copy**
   their input into libjxl before any compression — a full extra memory-bandwidth
   pass over the whole RGB16/RGBA16 frame (the real RAW pipeline feeds u16). The
   only way around it is a second input path on `JxlEncoderAddChunkedFrame` +
   `JxlChunkedFrameInputSource` + `JxlEncoderSetOutputProcessor`, exposing
   callbacks that hand libjxl bounded rectangles straight from the caller's
   immutable buffers (also fixes padded-stride/tiled sources without a repack).
   **Needs:** new bindings in `jxl-ffi` (chunked input source, chunked frame,
   output processor, `FlushInput`); a separate `StreamingFrame`/`encode_to<W: Write>`
   API kept distinct from the compact in-memory `encode_into` (do not mix the two
   output modes — libjxl forbids it). Gate behind a `jxl-ffi` capability feature.
   Benchmark buffering modes 1/2 (lower peak memory, may trade density/progressive
   order). Use `AddImageFrame` for small images, chunked for large RAW frames.

2. **Explicit auto-threaded reusable encoder + resizable runner.**
   `Encoder::new` and the `encode_rgb8`/`encode_rgba8` helpers allocate no runner →
   default single-threaded. `casabio_encode.rs` already calls `with_threads` on the
   full-res path, but a `with_auto_threads` (via
   `JxlThreadParallelRunnerDefaultNumWorkerThreads`) and a resizable runner
   (`JxlResizableParallelRunner*` + `SuggestThreads(w,h)`) would right-size threads
   per frame for mixed thumbnail/full-RAW batches and let a batch scheduler cap
   `cores/active_encodes`. **Do NOT** silently auto-thread `new()` — a pipeline that
   already parallelizes image jobs externally would oversubscribe. **Needs:** runner
   bindings; behavioral (libjxl encode stays deterministic across thread counts, so
   output is unaffected). Adopt at the call site, not by changing `new()`.

3. **Native 10/12/14-bit-in-u16 input depth.** The `Sample for u16` impl hard-codes
   `bits_per_sample = 16`; many RAW paths carry right-aligned 12/14-bit code values
   in u16 storage. `JxlEncoderSetFrameBitDepth(JXL_BIT_DEPTH_FROM_CODESTREAM)` +
   a per-`Frame` `bits_per_sample`/`IntegerInputRange` lets libjxl read them
   correctly and can drop an upstream normalization pass. **Needs:** `SetFrameBitDepth`
   binding + `Frame` field. Feature/behavioral — defer.

4. **Mixed-precision planar extra channels.** `ExtraChannel<'a, S>` forces every
   extra plane to the color sample type, which can force a conversion buffer (e.g.
   float RGB + u16 depth/thermal, or mixed-precision HSI). libjxl accepts an
   independent `JxlPixelFormat` + `JxlExtraChannelInfo` per extra channel. Replacing
   the generic with a small tagged `ExtraData` enum (U8/U16/F16/F32) + optional
   per-extra distance preserves native side-channel layout. **Needs:** API change
   (breaks the `ExtraChannel<S>` signature); no FFI additions. Defer — out of scope
   for a byte-exact pass, but the cleanest of the four to land.

5. **Sealed `Sample` trait + `const` metadata.** `Sample` is `pub` and hands raw
   bytes to C; a downstream impl on a padded type declared as a libjxl pixel format
   is a footgun. Sealing it and turning `data_type()`/`bits_per_sample()` into assoc
   `const`s removes the extension point and lets LLVM drop the tiny metadata call
   layer. Pure safety/codegen; no external impls exist today, so it's churn-for-~0 —
   deferred as optional hardening, not a perf win.

**Measurement note (rule 9):** the landed hint change is not meaningfully
flip-floppable — encode wall time is libjxl-internal-bound and a same-format reuse
is neutral; the win is fewer first-frame grow-loop reallocations on u16/float/extra
frames and a footprint-stable estimate across reuse. Adopted under rule 10
(theoretically better metric, provably never worse, output byte-exact). A direct
reserve-accuracy micro-benchmark (count grow-loop iterations per format) is possible
if a number is wanted, but wall-time A/B would only measure libjxl noise.
Investigated and rejected; logged in `docs/1 rejected optimizations.md` as FS-R4. The 8-lane
FNV hash IS a serial recurrence (the real throughput ceiling), and a metrics-only entry
would skip it — but **every actual caller needs the hash**. The only production consumer is
the WASM `frame_stats` export, which emits `frameHashInt` AND luma stats; the only native
callers are two bench examples that discard the result. A hash-free native entry point would
have zero callers = unreachable abstraction. Revisit only when a concrete caller wants
metrics without the change-id.

---

## CASA-ENC-D1..D4: casabio_encode.rs structural opportunities (2026-06-30)

Surfaced during the casabio_encode.rs "warp & weft" sweep (branch
`perf/casabio-encode-sweep-jun30-c7x4`). Three byte-exact/safety wins landed in that
branch (general-branch count-hoist, pyramid input-length FFI guard, long-edge cascade
sort). The four below are real but out of scope for a byte-exact pass — each changes a
data shape, a schedule, or a public contract and needs its own parity + ratio/throughput
benchmark. Logged largest-lever first.

**D1 — RGB-native downscale + encode for opaque (RAW/RGB16) inputs.** *Biggest lever.*
**✅ LANDED (pyramid half) — branch `perf/casabio-rgb-native-jun30-d1x9` @cbcb5d73, stacked
on the sweep branch.** `pipeline::process_rgb` (byte-exact 3ch twin of `process_rgba`) +
`box_downscale_rgb8` (byte-exact: per-channel box averaging) + RGB-native `pyramid_encode_rgb`.
`encode_rgba8_pyramid` opaque path strips once up front then cascades in RGB; `_from_rgb16`
tone-maps straight to RGB (zero strips). Parity byte-identical (2 unit tests + flipflop
`box_downscale_rgb_parity_flip` all sizes); per-level downscale+strip +13.8..28.4%; 14/14
MSVC tests pass. **Still deferred: the variant-path half** (`encode_variants*`) — that path
resizes via the `image` crate (Lanczos/Triangle) in 4ch then strips; an RGB-native variant
needs an `image` RGB resize + parity check and is a separate pass. Original analysis below.
The dominant RAW path is `has_alpha == false`, yet the whole pipeline carries 4 channels:
`box_downscale_rgba8` averages and stores the alpha plane at every cascade level, then
`strip_rgba_to_rgb` discards it immediately before each `Frame::rgb` encode. For a 24 MP
frame that is ~25% wasted downscale bandwidth + a full-frame n*3 strip alloc/copy per
level. A parallel `box_downscale_rgb8` (3-channel) feeding `Frame::rgb` directly removes
both the alpha averaging/store and the separate strip pass on the hot path.
**Needs:** a second 3-ch downscale kernel (code duplication, not a generic — keep the hot
loops monomorphic), a `Raster` enum at the entry boundary to pick the route once, and
visual/byte parity vs the current RGBA→strip output (averaging then truncating α=255 is
*not* guaranteed bit-identical to never-averaging when rounding differs — must verify).
Est. −20..33% on the downscale+strip fraction of the opaque pyramid/variant path.

**D2 — Adaptive encode scheduling (treat `parallel` as capability, not policy).** In the
variant fan-out, thumb/preview/full run as three rayon branches each holding a
single-thread `Encoder`. The full-res encode dominates; thumb+preview finish early and
leave cores idle while full grinds single-threaded. `encode_rgba8_pyramid` already solved
the symmetric case (serial full-res encode after the sidecar barrier gets
`serial_encode_threads(px)`). The variant path could do the same: run thumb+preview in
parallel, then give the full-res encode libjxl-internal threads once the barrier clears.
**Needs:** restructure the `rayon::join` tree so the full encode runs *after* the small
two, plus a benchmark — resize and JXL both saturate memory bandwidth, so overlap is not
a guaranteed win. Heuristic/topology change ⇒ bench-gated per CLAUDE.md.

**D3 — Leaf coalescing: preview == full when preview isn't downscaled.** When
`max_dim <= 1080` the preview is the *original* full raster, and for
non-RAW + `progressive_dc == 0` the preview and full encodes share pixels, dims, effort,
group-order, and centre — i.e. the same encode performed twice. Predicate:
`pw == width && ph == height && !hq_override && source != Raw && opts.progressive_dc == 0
&& preview_opts == opts` → encode once, clone the compressed bytes into both outputs.
**Needs:** careful predicate (quality differs — preview is fixed 85, full is 85/90/95; so
this only coalesces when `full_quality == 85`, i.e. non-RAW non-HQ), and a byte-stream
regression test. High value for small/medium uploads where a second full-quality encode
is pure overhead. (Note: shared storage via `Arc<[u8]>` would be the stronger form but is
an API change to `VariantSet`.)

**D4 — Owned RGB16 entry points + serial-pyramid sidecar streaming.** Two memory wins for
the WASM/low-RAM target. (a) `encode_variants_from_rgb16_with_progressive` clones the
whole rgb16 buffer when texture/clarity ≠ 0 (`rgb16.to_vec()` before `apply_unsharp_masks`);
an `_owned(rgb16: Vec<u16>)` variant could mutate in place and drop it before encoding.
(b) The serial (`not(parallel)`) pyramid builds *all* sidecar buffers into `scaled_bufs`
before encoding any; it could stream — derive level N, encode N−1, retain only the
immediate previous scale. Both are real but bounded: the full-res `rgba` (≈91 MB @ 24 MP)
stays resident for the final encode regardless, so streaming sidecars saves only a few MB
relative to that floor. Land only if a WASM peak-RSS measurement shows it matters.
## avx2.rs perceptual SIMD — seams deferred from the XYB-gather pass (2026-06-30)

Branch `perf/xyb-gather-scalarlut-jun30-g3w7` landed only the XYB gather→scalar-LUT
swap (the user's scoped ask). These adjacent candidates in the same file were left
untouched and want their own flip/parity before any change:

- **`downsample_avx2` deinterleave network.** The interior fast path uses 8×
  `permutevar8x32` + 4× `permute2f128` per 8 output px. Candidate: `vhaddps(p00,p01)`
  + a fixed `vpermq 0xD8` reorder forms the same adjacent-pair sums with far fewer
  shuffle-port ops, preserving the horizontal-then-vertical association (so bit-exact
  by construction). Deferred: needs its own A/B flip + the existing `dn2` parity test
  extended to odd/one-vector widths. Separate seam from the XYB work; not blocking.

- **`scale_err_avx2` accumulator topology / `inv²` factoring.** Multiple accumulators
  or factoring `inv²` out of the per-lane error would cut a multiply, but both change
  the reduction/rounding order against the scalar `scale_err` oracle (tol 1e-4, not
  bit-exact). Deferred: only with a flip *and* a tolerance-parity check showing the new
  order stays within the oracle band. Do not reassociate silently.

- **Assert hardening (`n*4` overflow).** The length asserts use `px.len() >= n*4`,
  which can overflow on adversarial `n`. A division form (`n <= px.len()/4`) avoids it.
  Cosmetic robustness only (callers are always sized); fold into the next avx2.rs edit
  rather than a standalone change.

---

## enc_group.cc — video-throughput backlog (2026-07-01)

Branch `perf/enc-group-fuse-cfl-loopbound-jul01-e7g3` (libjxl-012 submodule). Landed this
pass: per-worker scratch reuse, CfL zero-ratio channel-skip dispatch, static AC mask, gbench
CfL-ratio launder. The following are the higher-level throughput levers from the video-codec
analysis — deferred because each needs a design decision, a full-encode byte-exact regression,
and/or a dedicated video/throughput config, i.e. beyond a byte-exact single-file pass. Ordered
by value for frame-after-frame throughput.

1. **Fast-video plane-collapse pipeline.** At `speed_tier > kHare`, Y quant no longer inspects
   X/B (`AdjustQuantBlockAC` skipped), so the dataflow only needs all three coefficient planes
   live when CfL is active. Stream by dependency: no-CfL tile → 1 float plane + reuse; one-CfL
   tile → 2 planes; both-CfL → 3. Transform Y → Y DC → quantize/reconstruct Y → per-chroma
   transform/quant/split, reusing buffers. Cuts the live coefficient working set (~24 KiB → ~8–16
   KiB at 32×32) so it stays in L1. **Gate:** gate behind a throughput/video cparams flag (do not
   change existing modes silently); full-encode byte-identical output across all AC strategies +
   speed tiers; measured frames/s win. Big refactor of `ComputeCoefficients`.

2. **Fuse CfL into chroma quantization + CfL-aware DC.** Today CfL writes corrected X/B to
   `coeffs_in` (~8 KiB at 32×32) then the quantizer reloads them. Fold `X' = X - x_factor*Y` into
   a chroma quantize kernel (load Y once, do X and B together for `cfl_mask==3`), eliminating the
   write→reload. Companion: a `DCFromLowestFrequenciesWithCfL` that applies the affine correction
   only to the DC-source coefficients instead of materializing the whole corrected plane.
   **Gate:** byte-exact vs current; per-ISA register-pressure benchmark (fused-both vs separate-X/B
   vs current) — two-channel fusion may spill on AVX2. Select by ISA/transform size.

3. **Two quantized buffers, not three.** Interleave quantize+split per channel so int32 scratch
   drops from `3*kMaxCoeffArea` to `2`. Byte-exact (per-channel `SplitACCoefficients` are
   independent, so split order is free). Marginal cache win; natural companion to #1. **Gate:**
   byte-exact + measured.

4. **Splitter bypass for 1-pass.** If `ProgressiveSplitter::SplitACCoefficients` is an identity/
   deterministic layout copy when `num_passes==1`, the quantizer could write straight into
   `coeffs[c][0]` and drop the int32 staging plane entirely. **Gate:** prove bit-identical
   coefficient output for every AC strategy + coeff order at 1 pass before write-through. Do NOT
   assume safe from `num_passes==1` alone (it takes `acs`, `bx`, `by`).

5. **Fused Y quantize→reconstruct — ISA nuance.** REJECTED on measured AVX2 (+25%, see
   `docs/1 rejected optimizations.md`). Analysis notes the AVX-512 case differs: `QuantizeBlockAC`
   is `kBlockDim`(8)-capped while the standalone reconstruct is `kDCTBlockSize`(16)-capped, so
   fusion narrows AVX-512 reconstruction 16→8. On AVX2/SSE/NEON widths coincide and it still
   regressed here. **Gate:** only revisit if AVX-512 is a target, with a per-ISA benchmark across
   8×8…32×32; otherwise stays rejected.

6. **Enriched AdjustQuantBlockAC (loop-bound + invariant hoist).** Loop-bound alone measured +6%
   (rejected). Analysis pairs it with hoisting `hfix`-Y and the corner predicates (`y>=7*ysize`,
   `y==H-1`, `y>=4*ysize`) out of the x-loop. **Off the fast/video path** (`effort≥5` only), so
   low priority. **Gate:** full-body harness (with `hfNonZeros`/`hfMaxError`/corner logic) +
   effort≥5 corpus parity before it can beat the current per-coeff branch.

7. **Temporal encoder-decision inheritance (Generation 4).** Seed each frame's AC-strategy / raw
   quant / CfL-mode / activity maps from the previous frame, then locally validate + mutate only
   where RD diverges. Biggest higher-level lever, but cross-frame + cross-file (enc_frame /
   enc_cache / scheduler) and needs a frame-sequence API — out of `enc_group.cc` scope.

8. **Pipeline group-produce → tokenize → entropy.** If the encoder imposes a full-frame barrier
   between `ComputeCoefficients` and tokenization, a producer/consumer pipeline (coeffs N+1 ‖
   tokenize N ‖ entropy N-1) may beat further scalar cleanup. Scheduler-level, out of file.

9. **gbench coverage expansion.** Add X-only/B-only/none CfL benches with runtime ratios; a
   batch of independent blocks per iteration (avoid the loop-carried store→load in the current
   both-active bench); block geometries 8×8/16×16/32×16/16×32/32×32; ≥3 Y coefficient
   distributions; and a full-group pipeline bench (transform→roundtrip→CfL→quant→split) reporting
   frames/s, allocs/frame, transient bytes, L1D/branch misses. Requires google/benchmark buildable
   locally (currently not vendored). The standalone A/B (`C:\Tmp\enc-group-ab`) already covers
   X-only/B-only/none at runtime.

Skipped as compiler-handled cosmetics (not worth diff churn): CSE of `acs.Strategy()`, hoist of
`DivCeil(xsize_blocks, kColorTileDimInBlocks)` out of the by-loop, skipping the fast-tier
`row_quant_ac[bx]=quant_ac` write-back, and removing the dead `error_diffusion` parameter (maint,
touches call sites).

---

## Entropy subsystem (enc_context_map / enc_cluster / ans_common) — deferred (2026-07-01)

Context: full "hologram/genetics-lens" analysis of the entropy-coding path. The byte-exact
micro-wins were either already landed (enc-cluster v8n3, ans-common z7k) or a `reserve()`
(branch perf/enc-ctxmap-candidate-plan-jul01-c3k7). The following are larger and NOT
byte-exact-by-construction — each needs a plan/emit refactor and/or a bitrate+fps corpus
A/B before it can ship:

1. **Plan/emit split in BuildAndEncodeHistograms** (enc_ans.cc). Factor into
   BuildEntropyCodePlan (cost + retained serialized header) + EmitPlan, so EncodeContextMap
   can decide the winner and emit it without the 3rd histogram construction. Blocker: the
   function is shared across DC/AC/modular/context-map encoding; changing its contract risks
   encoder-wide regressions. Byte-exact IF the retained header equals an inline build; gate =
   full cjxl OLD/NEW byte-compare across stills/animation/screen/multi-frame.

2. **ANS reverse-map direct expansion** — **DONE 2026-07-01**, branch
   perf/ans-reverse-map-direct-jul01-r5m8 @5bd2d2b5 (capebio). `ANSBuildInfoTable` now walks the
   alias table entry-by-entry (left run [0,cutoff)->symbol i, right run [cutoff,entry_size)->
   right_value at offsets1+pos) instead of ANS_TAB_SIZE per-state `AliasTable::Lookup` calls.
   Byte-exact (63/63 harness cases, tools/ans_reverse_map_ab.cc); full ANSBuildInfoTable ~45%
   faster. Decoder `AliasTable::Lookup` untouched.
   NOTE: the `assign(ANS_TAB_SIZE,0)` zero-fill was NOT dropped — the pool is a fresh
   `encoding_info.back().reverse_map_pool` each histogram, so `resize` value-inits to zero too;
   skipping the memset needs uninitialized storage (UB via std::vector). Left as-is.

2b. **Plan/emit split for EncodeContextMap's 3rd build** (was #1). Re-attempted 2026-07-01:
   a byte-exact version could build both candidates into temp writers (getting serialized
   headers) and reconstruct the no-writer decision cost as
   `writer_cost + Bundle::CanEncode(lz77).bits + prefix_alphabet_varlen_bits`. Blocked: the
   prefix-varlen term needs `StoreVarLenUint16`/its size, which are static internals of
   enc_ans.cc — not reachable from enc_context_map.cc. So it still requires a plan/emit
   refactor INSIDE BuildAndEncodeHistograms/BuildAndStoreEntropyCodes (retain the serialized
   header from the cost pass). Blast radius = shared across DC/AC/modular/context-map; payoff =
   2-vs-3 histogram builds on a low-freq setup fn (and #2 already sped those builds up ~45%).
   Risk >> reward — deferred.

3. **Video-throughput clustering policy / temporal seed lineage / joint cluster+context-map
   cost objective / worker-local EntropyWorkspace / genetic content-class policy table.**
   All speculative and non-byte-exact (they change bitstream and/or model decisions). Explicitly
   require benchmark evidence (bits/frame, enc fps, p95/p99 latency, peak transient bytes,
   decoder cycles/symbol) across a real temporal corpus. NOTE: prev_histograms is a LIVE table
   prefix (constrains reindex + disables exact kBest refinement — enc_cluster), NOT a generic
   previous-frame cache; a temporal cache must be a separate seed-only mechanism. Do not wire
   prior-frame histograms through prev_histograms.

---

## enc_ans / dec_ans entropy-path — deferred (2026-07-01, branch perf/enc-ans-encodetoken-writesplit-jul01-a4x7)

Byte-exact-or-plausible but need a WASM/decode benchmark the integrator runs on rebuild:

1. **Decoder degenerate-histogram fast path.** `ANSCode::degenerate_symbols` is already
   populated but unused by the reader. Wire a `const int* degenerate_symbols_` into
   `ANSSymbolReader` and early-return in `ReadSymbolANSWithoutRefill` (and drop the alias
   Lookup + per-element masked stores in `IsSingleValueAndAdvance`, using `std::fill_n`).
   Byte-exact for valid streams: a bin with `freq==ANS_TAB_SIZE` makes the state update an
   identity and never renormalizes. BUT it adds a load+predictable-branch to the hot AC-decode
   inner loop that only degenerate/zero-heavy contexts benefit from → photo-regression risk.
   Gate on an INTERLEAVED real-photo WASM decode flipflop before adopting. Genuinely promising
   for video/zero-heavy residuals; the analysis's own prompt-9 warns it "burdens normal
   contexts", so do NOT ship it blind.
2. **`reverse_map_pool` uninitialized-resize.** `ANSBuildInfoTable` overwrites all ANS_TAB_SIZE
   pool slots (verified: sum of freqs == ANS_TAB_SIZE, each written once), so the value-init
   from `resize/assign` is dead. Skipping it byte-exactly needs a raw/AlignedMemory buffer
   (pool must stay owned+movable so `reverse_map_` pointers survive `RemoveUnusedHistograms`
   moves). Modest: ~few histograms/frame × 8KiB.
3. **Split `ANSEncSymbolInfo`** into ANS-only (freq/ifreq/reverse-map-offset) vs Huffman-only
   (depth/bits), offset-based reverse map, single codebook arena. Cache-layout experiment —
   may reduce hot metadata to 16B but risks cache-line splits at a 24B stride. Needs
   cycles/token + L1-miss A/B; do not ship on nominal-size argument alone.
4. **LZ77 window:** worker-local pool (avoid the 4 MiB alloc per reader) + adaptive size
   `min(kWindowSize, RoundUpPow2(max_output_symbols))` + zero-run / distance-one (RLE) /
   batch-replay reader modes. Decoder memory + consumer API changes; needs decode bench.
5. **Branchless-vs-branchy ANS renorm + alias prefetch policy** — currently branchless
   unconditionally (comment cites Skylake-X parity only). Add a per-arch (Zen3 / WASM) decode
   benchmark toggle; do not flip globally without data.
## jxl_casadecoder.rs final-audit deferrals — 2026-07-01 (branch perf/casadecoder-jxtc-runraw-jul01-d4k8)

Landed this pass (byte-exact, 23/23 MSVC tests green): A progressive-timing borrowed
path (drop per-pass clone), B JXTC tiles `run_raw` not `decode` (skip dead extra-plane
decode) + `flatten()` collapse, C `decode_region` whole-image fast path, D
`decode_full_threaded` honours `num_threads` via new `Decoder::with_threads`, E
`ResetGuard` RAII reset on the two callback paths (`decode_view`/`decode_progressive`)
+ panic-reuse regression test. Deferred below:

- **JxtcRegionDecoder persistent session + byte-bounded tile cache.** A stateful
  viewport decoder that parses header/index once, caches decoded tiles across calls,
  and decodes only newly-exposed tiles on a pan. Potentially the largest interactive
  win, but: (1) `decode_jxtc_region` has **no in-crate caller** (only Tauri/WASM), so a
  cache benefits an interactive pan/zoom loop that isn't exercised here; (2) the LRU is
  a heuristic — repo rule requires benchmark evidence before adding tunables; (3) ~400
  lines of new public API + its own test suite. Needs a real interactive bench (hit/miss,
  decoded-tile, resident-byte metrics) before landing. Strip-staged compositing (decode
  one tile-row, composite, release) folds in here to cap peak transient memory.

- **Output-buffer `set_len`-before-fill restructure.** `run_full_into` does
  `reserve+set_len(elems)` *before* libjxl writes, so a decode that errors after the
  buffer is bound leaves the caller's reused `Vec` with `len==elems` over uninit bytes.
  Benign today (all `Sample` types are POD with no invalid bit-patterns, and the error
  is propagated so well-behaved callers don't read), but not strictly sound. Cleaner
  shape: bind the spare allocation at `len==0`, `set_len` only after the loop succeeds.
  Touches the hottest decode loop (the `!buf.is_empty()`/`buf.is_empty()` guards key off
  length) — defer until it can carry its own soundness test; no perf delta either way.

- **JXTC tile decoders inherit DecodeOptions.** Tile decode hard-codes
  `DecodeOptions::default()`, so a caller's `cancel`/`limits`/`keep_orientation` don't
  reach the fan-out (a region decode can't be cancelled). Wire an options param through
  `decode_jxtc_region` (or the session object above). Behavioural, needs API decision.

- **Strict vs preview JXTC failure policy + completeness reporting.** Failed/forbidden
  tiles currently become silent zeroed holes (`flatten()` drops the `None`); `DecodeError::Tile`
  exists but is unused on this path. A strict variant returning `Result` + a preview
  variant returning `missing_tiles` would make corruption visible. Behavioural split.

- **Extra-channel completeness contract.** `run_full_into` `continue`s on a failed
  extra-channel size/bind, so `decode` can return fewer planes than `meta.num_extra_channels`
  with no signal. Decide strict-fail vs declared-partial; matters for scientific planes.

- **Alpha-free JXTC native RGB path.** `JxtcHeader.has_alpha` is informational; tile
  decode always requests RGBA (4/8 bpp). An RGB-native layout would save ~25% output
  memory for alpha-free containers. New API; all current JXTC fixtures set has_alpha.

- **B runtime benchmark.** The `run_raw` swap is byte-exact and strictly-less-work, kept
  per the "not-a-regression + theoretically better" rule, but its saving only materialises
  for JXTC tiles that carry planar extras — not present in the test corpus. Quantify with
  an extra-channel JXTC fixture + flipflop before claiming a number.

### UPDATE 2026-07-01 — JxtcRegionDecoder LANDED (same branch, max-effort follow-up)

The "JxtcRegionDecoder persistent session + byte-bounded tile cache" item above is
now **implemented** in `jxl_casadecoder.rs` (user explicitly requested the build).
Shipped: `JxtcRegionDecoder<'a>` (borrows one container, parses header/index once),
`TileCache` (byte-bounded LRU), `JxtcRegionOptions`/`JxtcRegion`/`JxtcRegionMetrics`/
`JxtcRegionError`, strict-vs-preview failure policy, option inheritance into tile
decoders (cancel/limits/keep_orientation), cross-call serial-decoder reuse for the
1-tile pan + rayon fan-out for multi-miss. The free fn `decode_jxtc_region` now
delegates here (cache off, Preview) so its 5 tests cover the session path; 8 new
session tests added. Demonstrated: a 4-tile→pan→4-tile viewport sequence sharing one
tile column decodes **2 tiles instead of 4** (metrics `hits=2 decoded=2`), with a
cache-disabled control proving the reuse comes from the cache. 216/216 crate tests
green (MSVC). So these previously-deferred items are now DONE: option inheritance,
strict/preview split + missing-tile reporting.

Still deferred (now refinements on the landed session, not the session itself):
- **Strip-staged compositing** for the whole-image anti-pattern: decode one tile-row,
  composite, release, to cap peak transient memory below dest+all-misses. Current
  impl decodes all misses in one batch (better parallelism + simpler; peak ≈ dest for
  a normal viewport). Only matters when a viewport approaches the whole image — the
  case JXTC exists to avoid. Needs a peak-RSS bench to justify the added complexity.
- **Alpha-free native RGB tiles** (`has_alpha=false` → 3/6 bpp): the session still
  requests RGBA like the free fn. ~25% output saving for alpha-free containers; new
  result layout, all current fixtures set has_alpha.
- **Extra-channel completeness contract** on the monolithic `decode` path (unchanged).
- **Animation / multi-frame** explicit policy (decoder still returns first frame only).
- **Interactive wall-clock bench**: decode-COUNT reduction is proven by metrics; a
  real pan-loop timing (native Tauri or a bench harness) would quantify ms saved.

### UPDATE 2026-07-01b — alpha-free native RGB LANDED (same branch)

The "alpha-free native RGB tiles" refinement is now implemented. Added
`EmitAlpha { Always, FromHeader }` to `JxtcRegionOptions` (default `Always`).
`FromHeader` on a no-alpha container (`has_alpha=false`) decodes tiles as RGB
(3 bpp / 6 bpp@16-bit) instead of RGBA — ~25% less output and no alpha-synthesis.
The session fixes channel count + bytes_per_pixel once in `new()`; tile decode and
the compositor were already bpp-generic. `decode_jxtc_region` stays `EmitAlpha::Always`
(RGBA contract preserved; libjxl fills opaque alpha on no-alpha streams — verified).
New test `jxtc_session_alpha_free_emits_rgb_in_fromheader_mode` (RGB output + opaque-
alpha RGBA control + free-fn-unchanged guard). 217/217 crate tests green (MSVC).

Remaining deferred (with honest blockers):
- **Strip-staged compositing** — needs per-allocation peak-RSS measurement to justify;
  no clean way to measure that in a Win unit test, and it only helps the whole-image
  anti-pattern. Not tackled.
- **Extra-channel completeness contract** (monolithic `decode` path) — an API-semantics
  decision that ripples the `Image` type. Out of scope for the JXTC session.
- **Animation / multi-frame policy** — cheap doc clarification only (decoder returns
  first frame); real frame selection needs a new iterator API.
- **Wall-clock pan bench** — decode-COUNT reduction is proven by metrics; a wall-clock
  number is noise-dominated at test-tile scale and needs real-size fixtures + a native
  pan-loop (Tauri) to be meaningful.
## decompress.rs (branch perf/decompress-trunc-fold-jul01-q8z) — deferred

Landed this pass (byte-exact, +4.5% vs base on synthetic): D10 north-load hoist,
`#[cold]` error helper, dead `padded` field removal. Rejected: D9 truncation fold
(+13%, see rejected-optimizations). Deferred (not implemented):

- **Native u64 wide refill in `BitReader::fill`.** The refill is a byte-at-a-time loop
  (`buf = (buf<<8)|data[pos+i]`). A native unaligned u64 load + bswap could cut refill
  work, BUT fill already batches to 56 bits so it is called rarely (amortized near-free,
  cf. rejected D3 one-fill), and WASM lacks a cheap byteswap so it may regress the
  browser target. Needs a per-target flip (native AND wasm) before adopting.
- **Min-payload pre-alloc rejection in `decompress_rows`.** The convenience wrapper
  `vec![0u16; n]` (zero-fills the whole frame) before `decompress_rows_into` discovers a
  too-short payload — a malformed tiny input with huge claimed WxH causes a large zeroed
  alloc then immediate Err. A cheap lower-bound (>=6 bits/px + warmup) check could reject
  first. Hardening only (real callers pass genuine header dims); not a valid-image perf
  win. `decompress_rows_into` is already the zero-realloc path for hot callers.
- **`width == 0` degenerate guard.** With width 0 the row loop spins `nrows` times doing
  no reads/writes; a vast claimed height makes it a no-op DoS. Real ORF is never
  zero-width. One-line early return; cosmetic robustness.
- **Streaming two-row / window decode API.** The predictor needs only row, row-2, and
  two delay values, so a streaming form could hold ~2 rows instead of the full frame for
  preview/thumbnail/downstream-transform pipelines (mem WxH -> Wx3). New public API; the
  current full-frame `decompress_rows_into` (output-buffer-as-history) stays optimal for
  callers that need the whole image. Design task, not a micro-op.

## decompress.rs — UPDATE 2026-07-01: 3 of 4 deferred items ENACTED

Same branch perf/decompress-trunc-fold-jul01-q8z (2nd commit). After re-review at max
effort, three of the four deferred items were implementable + verifiable here:

- **[ENACTED] native u64 wide refill** — biggest win of the pass. `BitReader` is now
  `BitReader<const WIDE: bool>`; native uses a single unaligned `from_be_bytes` u64 load
  (keeping the top `in_bounds` bytes = byte-exact MSB-first packing) instead of up to 7
  dependent `(buf<<8)|byte` shifts on the inter-pixel critical path, with a byte-loop
  fallback in the last <8 bytes. Measured via the 6-way bisect (hst+wide vs hoist):
  ~-7% isolated; PROD -6.0..-8.9% vs original base, sign-stable x3. Byte-exact (the
  differential oracle uses `BitReader<false>` vs production `BitReader<WIDE_FILL=true>`).
  wasm keeps the byte loop (`WIDE_FILL=false` via cfg) — the deferral's byteswap concern
  is sidestepped, not risked; `cargo check --target wasm32` clean.
- **[ENACTED] min-payload pre-alloc rejection** — `decompress_rows` now rejects payloads
  below the 6-bits/pixel floor before the zero-fill alloc (identical Err text; safe lower
  bound, never false-rejects). Test `decompress_rows_rejects_giant_dims_without_alloc`
  (100000x100000 would need ~20 GB; passes = guard fired pre-alloc).
- **[ENACTED] width==0 guard** — early `Ok(nrows)` after the short-input check (preserves
  the sub-HEADER_SKIP "input too short" Err; kills the adversarial-height no-op spin).
  Test `decompress_zero_width_is_noop`.

- **[STILL DEFERRED] streaming two-row / window decode API** — unchanged. New public API
  + caller migration + design buy-in; not a verifiable micro-change. Needs brainstorming,
  not enactment.

## decompress.rs streaming — UPDATE 2026-07-01: IMPLEMENTED (last deferred item done)

The streaming two-row/window API (last remaining deferred item) is now IMPLEMENTED on
branch perf/decompress-trunc-fold-jul01-q8z, per spec
docs/superpowers/specs/2026-07-01-streaming-orf-preview-decode-design.md and plan
docs/superpowers/plans/2026-07-01-streaming-orf-preview-decode.md. Shipped:
- decompress.rs: decode_row_into shared helper (perf-neutral, bisect PROD -10%),
  RawRowSource trait, OrfRowDecoder (3-row ring), for_each_strip.
- demosaic.rs: demosaic_half_band (demosaic_rggb_half delegates).
- stream_preview.rs (new): StreamingBoxDownscale + build_previews_streaming (STRIP_ROWS=128).
- src/lib.rs: decode_orf_raw streaming fork (gate: previews && !full_rgb && wb_from_camera
  && preview_can_halve); rare no-camera-WB bails to the full path.

Verified: byte-exact at every layer (streamed rows==full decode; half-band==full; streaming
downscale==reference; fused previews==manual composition); MSVC lib suite 215 passed;
wasm32 check clean; peak-mem working-set ratio 0.269 (~3.7x, scales to ~6x at 24MP where
the lightbox deliverable dominates); preview-build flipflop -1.5%/-0.7% (neutral, no regression).

Remaining FUTURE (new specs, not deferred-from-this-pass): WB-stats fold-in (so no-camera-WB
also streams), progressive-paint JS wiring, ROI/window public API, DNG/CR2 RawRowSource impl.
- **`Comparer::new` is dominated by `blur::box_blur` (mask) + `ssim::ref_moments`,
  NOT XYB.** Wiring the reference pyramid through the SIMD kernels (landed on
  `perf/xyb-gather-scalarlut-jun30-g3w7`) only moved construction +4–10% (1/6/24 MP,
  parallel) — measured via `examples/ref_build_effect.rs`. The XYB conversion + pyramid
  downsample are a minor slice; the bulk is the scalar `box_blur` over the full-res Y
  plane (×1 per level) and the integer `ref_moments` pass. **Bigger ref-build win lives
  there**: a SIMD `box_blur` and/or folding the 3-level mask blur into the pyramid walk.
  Out of avx2.rs's seam scope (separate kernels), but the higher-ROI target if ref-build
  latency matters. Output shift from the SIMD-ref change measured 0.00e0 (f32 metric
  resolution), so it is purely a latency question.
## dec_group decode subsystem (2026-07-01, branch perf/dec-group-border-atomic-jul01-b3k9)

Reviewed `dec_group.cc/.h` + `dec_group_border.cc/.h` for video-throughput wins.
The files are already 5/5 (the 2026-06-29 work-elimination plan is fully landed:
component-aware qblock clear, per-channel dc_only + CfL gate, DequantSingleBlock,
JpegGroupParams hoist, ac_occupancy pre-size, no-draw split). LANDED: border
atomic coalescing (see rejected/notes). The following remain **deferred** because
each needs a full decode A/B (native `djxl` SHA and/or WASM flipflop) that this
agent could not run, or is conditional on data this agent could not measure.

- **No-CfL `DequantLane` variant (dec_group.cc).** When `no_cfl`
  (`x_cc_mul==0 && b_cc_mul==0`, already computed per color-tile at the block loop),
  the two `MulAdd(x_cc_mul, dequant_y, dequant_x_cc)` / `MulAdd(b_cc_mul, …)` reduce to
  `dequant_x_cc` / `dequant_b_cc`. **Byte-exact** by IEEE-754: `fma(0,y,x)==x` for finite
  x,y (dequant values are always finite; `dequant_x_cc` from a zero coeff is `+0.0`, never
  `-0.0`, so no sign-of-zero divergence). Implementation = template `DequantLane`/
  `DequantSingleBlock`/`DequantBlock` on `bool kNoCfl`, select the function pointer per
  color-tile (where `no_cfl` is already known). Saves 2 FMA/lane on no-CfL blocks.
  **Deferred, not landed**, because: (1) the win is *conditional* on no-CfL block
  frequency, which is content-dependent and unmeasured (CfL is signalled only when it
  helps, so photographic content is often CfL-active); (2) doubling the dequant template
  surface grows the i-cache footprint, a plausible regression on CfL-heavy content — so
  this is **not** an unambiguous "no-regression" change (rule 10 does not cleanly apply);
  (3) the routing change touches the hottest 5/5 decode file and the *control-flow*
  correctness (not just the FP identity) needs a full-decode SHA to confirm. Gate before
  landing: standalone HWY `dequant_lane_ab.cc` proving `DequantLane<...,true>` with
  `x_cc_mul=0` ≡ `DequantLane<...,false>` byte-for-byte, **plus** an interleaved decode
  flipflop on both CfL-heavy and no-CfL content to confirm net non-regression.

- **`ac_occupancy` sizing was a latent data race (dec_group.cc ~L1249) — NOW LANDED.**
  `DecodeGroup` runs per-group across the worker pool (`RunOnPool` over `ps_ac_runnable_`
  in `dec_frame.cc`), yet it lazily sized the frame-scoped sidecar with
  `if (ac_occupancy.size() < needed) ac_occupancy.assign(needed, 0);`. On the first
  accumulate-mode group of a frame, two worker threads can both see `size() < needed` and
  race on `assign()` (concurrent reallocation) while others `|=` into it → UB. Only fires
  in progressive/multi-pass decode (`!coefficients->IsEmpty()`). **Fixed** on branch
  `perf/dec-group-ac-occupancy-frame-owned-jul01-c5m2` (capebio): allocation moved to
  AC-global frame setup in `dec_frame.cc` (single-threaded, beside the retained coefficient
  store, before `decoded_ac_global_` / any AC group dispatch); `DecodeGroup` no longer
  touches the sidecar size; population keeps its `block_idx < size()` guard. Byte-exact by
  construction (write-only sidecar has no consumer → output independent of allocation site).
  Integrator build = compile gate.

- **Consume `ac_occupancy` to skip the redraw coefficient scan (the file's own TODO at
  `DecodeGroupFromStoredCoefficients`).** In stored-coefficient redraws the dc_only
  detection re-scans `qblock[c][1..64)` per channel; the pre-populated sidecar mask
  (bit c = channel c has nonzero AC) is exactly `!scan_ac_zero(c)` for `covered_blocks==1`,
  so it could replace the scan. **Deferred, and currently unsafe to land** — see the
  rejected log: `DecodeGroupNoDraw` populates coefficients but does **not** populate the
  sidecar, so a redraw after hidden passes would read a stale/empty mask and wrongly
  DC-fill blocks that actually have AC. Landing the consumer requires *also* populating the
  mask in `DecodeGroupNoDraw` (adds a scan to the hidden-pass path) and a progressive
  multi-pass corpus to verify byte-exact redraw output.

- **Avoid `GetInputBuffers` on no-draw AC passes (analysis item 2) — investigated, NOT a
  clean win.** `FrameDecoder::ProcessACGroup` (dec_frame.cc:498) calls
  `render_pipeline->GetInputBuffers(ac_group_id, thread)` unconditionally, then `DecodeGroup`
  decides draw/no-draw internally — so the analysis is right that render-buffer acquisition
  happens even on no-draw VarDCT passes. **But** the same `render_pipeline_input` is also
  consumed by the *modular* decode on every pass (dec_frame.cc:535 and :541), which runs
  regardless of the VarDCT draw decision. So the buffers can't simply be skipped when VarDCT
  is no-draw; making this safe means proving the modular path for that pass also needs no
  input, which is content/mode dependent. **Deferred**: real coupling, not surgical; needs
  the modular-decode buffer contract nailed down first.

- **Border geometry precompute + counter-layout experiments (dec_group_border.cc).**
  `GroupDone` recomputes `block_rect` / `is_last_group_*` / `xpos[4]` / `ypos[4]` per call;
  for constant-resolution video these are frame-invariant per group and could be cached in
  `Init` — but only amortizes if the assigner instance is reused across frames without
  re-`Init` (a lifecycle change). Also: replacing the `available_parts_mask[3][3]` bool
  grid with three 3-bit row masks + LUT (micro), and testing counter-array padding vs the
  packed layout for false-sharing at high core counts. All low-value until the *atomic*
  cost (now coalesced) is profiled as still-dominant. **Deferred**: need multi-frame /
  many-core decode profiling to justify; the analysis itself ranks these below the atomic
  coalescing that was landed.

- **Larger analysis restructures (frame-plan object, sparse/low-frequency-only dequant
  kernels, block-execution descriptors, supergroup/clustered scheduling, bounded
  multi-frame pipelining).** These are architecture-level throughput ideas for a JXL video
  profile, not surgical byte-exact edits. Each needs a design pass, a build, and a
  multi-frame benchmark harness. **Deferred** wholesale as out-of-scope for a byte-exact
  optimization branch; recorded so the video-codec effort can pick them up with evidence.

## DNG streaming — IMPLEMENTED 2026-07-01 (branch perf/dng-stream-preview-jul01-m2r7)

Extended the streaming preview pipeline to DNG (spec+plan+6-task TDD, off q8z). Approach A
(generic RawRowSource). Superpixel previews (phase-aware; NOT byte-exact to old full-MHC
DNG previews — accepted quality delta), full-res MHC path unchanged. comp=7 tile-band
streaming (~19× measured), comp=1 decode-then-dole (~3.5×). Verified: DngRowSource rows ==
decode_bytes().raw byte-exact (real comp=7 fixture); phase superpixel == reference (4
phases); ORF previews unchanged; peak-mem working-set ratio 0.052 (~19×); MSVC --lib 216
pass; wasm32 clean. Gate: preview-only && Bayer(cps=1) && comp∈{7,1}; else full path.

REMAINING DEFERRED: CR2 streaming — vertical-slice layout means every slice spans all rows,
so row-streaming requires decoding the whole frame first (no peak win for the raw). Only the
post-decode demosaic+downscale could stream (~43%). Do only if the half-RGB buffer matters.

## Streaming full-res JXL export P1 (native ORF) — IMPLEMENTED 2026-07-01 (branch m2r7)

Fused decode→demosaic_rggb_mhc_band→tone→encode_chunked over a rolling super-tile band
(spec+plan docs/superpowers/{specs,plans}/2026-07-01-streaming-jxl-export*). ChunkedColorSource
trait + encode_chunked(&mut dyn) + WholeImageSource + StreamingExportSource. BYTE-IDENTICAL to
the whole-frame export (source==whole + export-bytes==whole tests; encode_chunked==AddImageFrame
proven by density bench). ★★ CONSTANT-PEAK: streaming export peak = 57.8MB regardless of height
(O band), whole = O(height) (99MB@4096 -> 197MB@8192); win widens 1.7x@4096 -> 3.4x@8192 -> huge
@gigapixel. jxl-codec lib 218 pass; wasm clean.

DEFERRED (own specs): P2 WASM-bridge parity (bridge.cpp C++ chunked encode + browser fusion =
gigapixel-in-browser); DNG streaming export (needs phase-aware MHC band demosaic); NR/unsharp
spatial post (band-halo extension — P1 is tone-only export); lossless/modular streaming density.

## Lossless/modular streaming density — INVESTIGATED, GREEN 2026-07-01 (branch m2r7)

encode_chunked gained a lossless path (distance<=0 -> SetFrameLossless + uses_original_profile).
Probe examples/jxl_lossless_stream_density.rs (20.5MP real photo, effort 2/7/9): streaming
lossless is BYTE-IDENTICAL to whole-frame lossless at every effort (density +0.00%: 15264664@e2,
11583716@e7, 11309481@e9), EXACT round-trip (true lossless preserved), -60MB encoder peak
(-28%), neutral-to-faster. Locked by lib test streaming_export_lossless_bytes_equal_whole.
=> archival lossless exports can stream too, at zero density/quality cost. Streaming full-res
export (P1) already supports it via export_jxl_streaming_from_strip(distance=0).

Remaining deferred: P2 WASM-bridge parity (gigapixel-in-browser), DNG streaming export (phase-
aware MHC band), NR/unsharp spatial-post (band-halo).

### UPDATE 2026-07-01 — deferred #1 (decoder degenerate fast path) IMPLEMENTED + tested
Branch **perf/dec-ans-degenerate-fastpath-jul01-d5p2 @bb187e74** on capebio (submodule),
worktree C:\Foo\rcw-dec-degenerate, PUSHED not-merged. Wired degenerate_symbols_ into
ReadSymbolANSWithoutRefill (early return) + IsSingleValueAndAdvance (fill_n bulk fill).
**Byte-exact PROVEN**: djxl OLD vs NEW SHA-identical decoded pixels, 10 real streams
(5 production photos + fractal + degenerate-heavy synthetics), 0 mismatches. **Native decode:
NEUTRAL within noise** (in-process JxlDecoder loop; min NEW/OLD swings 0.987..1.059 both
directions, ~25% run variance — per-symbol ANS is a small non-isolable fraction of total
decode). Kept per user rule (0%/positive-step or potentially-positive-elsewhere). **Remaining
gate = WASM decode flipflop** (the intended win case: no HW prefetch / weaker branch predict on
WASM make the skipped ANS work relatively more expensive; + zero-heavy/video-residual content).
Native corpus can't exercise the video-residual case (RAW→JXL→decode of photographic content
has few degenerate hot contexts).

### 2026-07-01 — enc_patch_dictionary.cc deep pass (branch perf/enc-patch-subtractfrom-jul01-p4d7)
Landed (byte-exact): SubtractFrom blend-hoist + plane-major loop; Encode tokens.reserve. The whole
file is **app-cold** for the RAW converter — patch dict only fires on screenshot/text/flat-4×4
content; natural photos hit num_seeds==0 early-return (line ~345) before any flood/CC/atlas/
roundtrip. Items below are deferred because they are NOT byte-exact (change the codestream),
architectural, or only matter for the JXL-as-video ambition where the file becomes hot. Each needs
its own gate before landing.

- **"P0" seed-scan coverage off-by-one (`RunOnPool(pool,1,ph-2,…)` line ~332).** VERIFIED real:
  RunOnPool end is exclusive, `process_row(py)` is safe up to py=ph-2 (reads row (py+1)*4 < ysize),
  and the flood loop (line ~375) already iterates `py < ph-1` (=up to ph-2) — so detection skips
  its last valid tile row while the flood expects it. ChatGPT's fix `ph-2 → ph-1` is the maximal
  safe coverage. **NOT a byte-exact perf win**: it makes detection do MORE work and CHANGES which
  patches are found → changes the encoded codestream; it is an upstream-heuristic behavior change
  on a fork we ship. Gate = OLD-vs-NEW cjxl A/B on real >1-tile-row screenshot/UI content (size +
  decoded-pixel delta) + a decision on diverging from upstream libjxl detection. Candidate upstream
  bug report rather than a silent land.
- **Crop atlas WIDTH after packing (track max_x, `ref_xsize = max_x`).** Height is already cropped
  (`ref_ysize = max_y`) but width is not. NOT byte-exact: shrinks the reference-atlas image →
  different special-frame (modular/gradient) bytes → different codestream. ChatGPT itself flags
  shape-dependent modular rate effects. Gate = encoded-size A/B (rate experiment). Also crop→
  smaller special frame = less encode/decode/zero-fill (video-relevant).
- **Reusable GetPatchesForRow out-param** (`void GetPatchesForRow(y, vector*)`), reused across the
  image instead of per-row alloc+sort. Crosses the decoder-side dec_patch_dictionary API. App-cold.
  Byte-exact if ordering preserved. Defer (medium risk, cross-layer).
- **Source-label map replacing the copied 3-plane `background` Image3F** (+ merge is_background/
  visited into 2-bit flags). Big peak-RSS win on screenshot frames (~95MB→~32MB @4K); only runs
  when seeds>0 (app-cold). Byte-exact only if near-equal-tile source selection is preserved
  (canonicalise ONLY bit-identical flat tiles as the safe first step). Architectural.
- **Span/frontier flood + tiled parallel connected-components.** Replace pixel queue/stack with
  scanline spans; parallelize the serial tail. Byte-exactness is delicate (see rejected ledger:
  mark-on-discovery changes `reference`). Architectural, needs a background-mask regression oracle.
- **Marginal-gain patch planner** (select patch groups by estimated total-bit benefit, not just
  ≥2 occurrences / ≥20px), and **per-region dots-vs-patches** instead of the global either/or.
  Changes output; needs a real encoded-size scoring loop.
- **Encoder-owned reconstructed reference** (expose EncodeFrame's post-quant reconstruction, drop
  the internal DecodeFrame in RoundtripPatchFrame). High-value throughput when dicts are used
  (video), high risk; must match decoder reconstruction pixel-exactly. Also fold the second
  decode-and-consume branch (the encoded_size==0 assert path) into one helper.
- **Persistent inter-frame patch-atlas cache + reference-slot allocator** (replace hardcoded
  kPatchFrameReferenceId=3). The largest JXL-as-video win (reuse subtitle/HUD/UI atlases across
  frames with delta/rebuild/retire + hysteresis). Needs sequence-encoder/reference-lifetime work
  outside this file; see [[project-jxl-video-codec-20260701]].
- **Content/overlap-aware atlas layout** (place visually similar patches adjacent for the gradient
  predictor; exact-subrectangle overlap = 2-D CSE for shared glyph stems). Rate experiment.
- **Separate entropy-order (bitstream) from apply-schedule (cache).** All color patches are kAdd
  (commutative) so apply can be patch-centric/row-skipping/parallel while emission stays delta-
  friendly. Byte-exact for output; changes internal scheduling only. Deferred (medium).

### UPDATE 2026-07-03 — investigated the two "big video" items; DONE the one tractable piece
Investigated (2 read-only Explore passes) the two items I'd predicted as order-of-magnitude video
wins. Both are SMALLER or more BLOCKED than predicted — correcting the earlier over-optimism:

- **Encoder-owned reconstruction (drop internal DecodeFrame): my "-30–50% roundtrip" was WRONG.**
  The JXL encoder is not inter-predictive — it never computes decoder-exact float reconstruction;
  `ModularFrameEncoder::stream_images_` (enc_modular.h:115) is transformed-domain integers freed
  early by ReleaseImage. The XYB atlas is ALWAYS lossy (ModularPartIsLossless() false for XYB,
  enc_params.h:127-139), so the lossy decode is genuinely required. Only the **lossless** atlas
  case was a free win → **LANDED** (see below). Option B (retain stream_images_ + decoder
  inverse-modular) would save only entropy-decode+header-parse (inverse transform still runs =
  the bulk for a small atlas), adds decoder-logic drift hazard + a memory-lifetime change =
  Med-risk/modest-reward → **still deferred**.
- **Persistent inter-frame patch-atlas cache: architecturally BLOCKED + off-roadmap.** Decode-side
  reference persistence exists (dec_frame.cc:933) but the ENCODER reference array is per-EncodeFrame
  (enc_frame.cc:2073/2345, destroyed at return); the only cross-frame libjxl object (JxlEncoder)
  holds no reference pixels. The native sequence path (crates/raw-pipeline/src/casa_video.rs, CASV/
  JOLT) is Architecture-A = **independent codestreams** → cannot share a reference slot at all. The
  design doc (docs/superpowers/specs/2026-07-01-jxl-video-codec-design.md:340-345,489-490) EXPLICITLY
  parks multi-reference/background-modelling ("single previous frame is the best reference … not a
  lever here"); chosen mechanism is Rust-side REPLACE-skip, not JXL slots. Re-evaluate ONLY if the
  pipeline agent moves to single-codestream animation with save_as_reference. Slot-allocator
  groundwork (replace kPatchFrameReferenceId=3 + encode.cc:1019 cap; kMaxNumReferenceFrames=4) is
  mechanically easy but has NO consumer today → still deferred.

- **DONE — lossless decode-skip (Item 2 Option A).** Branch `perf/enc-patch-lossless-decode-skip-
  jul03-q2r8` @9d12b019 off sub main **2e5cb035** (capebio, PUSHED not-merged). RoundtripPatchFrame:
  when `cparams.IsLossless()`, install the source ImageBundle directly and skip the encode->decode
  round-trip (decoder reproduces it bit-for-bit); lossy + subtract==false paths untouched.
  **A/B PROVEN** (native clang-cl static cjxl/djxl OLD-vs-NEW on a lossless screenshot with patches,
  fixture tools/enc_patch_lossless_ab_gen.cc): bitstream byte-identical (SHA256), decoded pixels
  identical OLD==NEW==original (lossless), branch-probe shows PATCH_LOSSLESS_SKIP taken and
  PATCH_DECODE_PATH never → DecodeFrame on the patch atlas skipped (count 0), path exercised.
  Removes a full frame decode per lossless patch-dictionary encode. App-cold for RAW; helps lossless
  screenshot/UI encodes.

## enc_fast_lossless.cc — deferred candidates (jul01, from the seams pass)

Byte-exact wins already landed on branch `perf/enc-fast-lossless-seams-jul01-f7k3`
(align/alloc, residual dead-store, palette lazy-alloc, TOC-copy elision). The
following were identified but NOT taken; each needs a gate.

- **Adaptive streaming batch depth** (replace `constexpr kMaxLocalGroups = 16` in
  the streaming path with `min(total_groups, ~2·threads, mem_budget/worst_group_bytes)`).
  Behavior-changing scheduling/memory heuristic — needs benchmark evidence per
  CLAUDE.md (thread-count starvation vs 12 MiB RGBA16 batch reservation). Byte-exact
  (output order preserved). Gate: streaming throughput bench on a many-core box +
  peak-RSS measurement. Highest-value for JXL-as-video small frames.
- **SIMD predictor split: `PredictPixelsAndCountZeroPrefix` vs `PredictPixelsOnly`.**
  In `ProcessChunk` later vectors keep doing `Eq(0)`/`CountPrefix` after the run is
  already broken. Split so only residuals are produced past the break. Byte-exact.
  Wins NEON (2 vec/chunk), 16-bit AVX-512, MoreThan14Bits (multi 32-bit vec); ~neutral
  for 8-bit AVX2. Gate: per-ISA SIMD A/B (do NOT force one impl across ISAs).
- **Full-chunk vs tail-chunk packing fast path** (skip `ClipTo()`/`Skip()` dynamic
  masks on the common n==kChunkSize, skip==0 route). Byte-exact. Gate: SIMD A/B; keep
  general route for the last partial column + RLE-break chunks.
- **AVX-512 register-resident token/Huffman/pack** (keep tokenise→Huffman→interleave→
  Bits32 in registers instead of the ~5 stack round-trip arrays per vector batch).
  AVX-512-only (AVX2 has too few vector regs — do not apply globally). Gate: AVX-512 A/B.
- ~~**Reuse Huffman DP workspace.**~~ **DONE** — branch
  `perf/enc-fl-prefix-code-reuse-jul02-h5m3 @4da44ae8` (capebio). `ComputeCodeLengthsNonZeroImpl`
  now reuses a thread_local DP table (was a fresh multi-MiB `std::vector` per call, ~8 calls/frame).
  Byte-exact verified (fjxl A/B 10/10 identical vs 6479ef13). PUSHED not-merged.
- **Copy baseline prefix code into unused channels** (the companion idea) — STILL DEFERRED, but
  LOW value: unused channels are only [nb_chans,4), so grayscale saves 2 builds, GA saves 1,
  **RGB/RGBA save 0** — i.e. ~zero for the RAW path's dominant 3/4-channel inputs. Not worth the
  branch. Would need a real gray/GA-heavy workload to justify.
- **Lifecycle/persistence (video):** per-worker row scratch reuse across frames;
  `BitWriter` capacity/reset + per-batch arena/pool (also makes late DC-global padding
  explicit rather than relying on the 100000-bit over-reserve); expose the integrated
  seek-back streaming sink to the standalone/WASM path. Cross-function; needs a
  sequence-state owner above this file.
- **Fused colour-transform + predictor kernel** (deinterleave→YCoCg→predict in
  registers, store only current-row state). 2nd-gen kernel; higher register pressure +
  ISA divergence + left-neighbour complexity. Profile-gated: only if `FillRow*`+row-
  scratch loads dominate the 8-bit RGB(A) profile after the lifecycle work.
- **Temporal / JXL-as-video** (codebook inheritance with scene-change trigger; exact
  unchanged-group compressed-byte reuse behind an exact byte compare, not a hash;
  reference-frame coding). Architectural, above this file — see
  [[project-jxl-video-codec-20260701]] and the RAW/JXL concurrency evidence memo.

### UPDATE 2026-07-01b — deferred #1 WASM decode A/B done (byte-exact; timing unresolvable)
Built NEW dec WASM from d5p2 (build.mjs LIBJXL_SRC_DIR + JXL_WASM_ONLY_KIND=dec --host-toolchain;
needed sjpeg junctioned into worktree). Wrote node in-memory decode A/B (wasm_ab.mjs: createJxlModule
{wasmBinary} -> _jxl_wasm_decode_rgba8) vs shipped baseline dec.simd.wasm (== e4fbf789).
- **BYTE-EXACT on WASM confirmed**: base vs new decoded-pixel checksums identical, 15/15 residuals +
  3/3 production photos, 0 mismatches (adds to native djxl 10/10).
- **Timing: UNRESOLVABLE on this machine.** Built a video-residual corpus (consecutive Ghana video
  frames diffed -> mostly-zero = degenerate-context-dense; compress 5-7x smaller than frames). WASM
  residual aggregate NEW/OLD = 0.957 then 1.011 on re-run (straddles 1.0); large-photo per-file swings
  0.799..1.306 with IDENTICAL output. Machine thermally throttled after hours of builds; per-file
  variance +/-20-30% >> the ~3-5% effect. Only consistent signal: frame_000 (full frame, larger/more
  stable decode) favored NEW ~15% in both residual runs (0.846/0.862) — hint the direction is
  favorable on larger degenerate-dense decodes, but not statistically clean.
- **KEPT** (branch d5p2 @bb187e74) per user rule: byte-exact + does-provably-less-work on degenerate
  contexts + neutral-within-noise. NOT a demonstrated benchmark win — could not measure one cleanly.
- **Definitive number needs**: cold machine + INTERLEAVED per-decode A/B (flipflopdom browser harness
  with start-rotation cancels thermal drift; my node harness times OLD-block then NEW-block per file =
  drift-biased). That's the proper follow-up if a hard number is required.

---

## enc_lz77.cc — deferred (analysis 2026-07-01, branch perf/enc-lz77-byteexact-jul01-lz9k)

Deferred from the byte-exact perf pass because each changes the emitted bitstream or the cost
model and needs a **compression-ratio A/B (cjxl size/Butteraugli)**, not the byte-exact SHA gate.
Ordered by expected value.

1. **Range-relaxed / cost-plateau optimal parser.** Kill the Θ(n²) blow-up on periodic non-RLE
   input (`A B C D A B C D …`), where the current dense length loop relaxes ~every length at ~every
   position and the `skip_lz77` RLE-run heuristic does not fire. Correct form: intersect length-cost
   plateaus × distance-cost plateaus and issue one range-chmin per interval (segment tree). **Gate:**
   must prove no ratio regression AND a real speedup on a periodic corpus; float costs won't be
   byte-exact vs today (needs ratio gate + decode round-trip); fixed-point (1/16-bit) costs are
   deterministic but themselves a codestream change.
2. **Pareto match frontier** (drop `len + 2 >= best_len`, keep (length, distance-cost) non-dominated
   candidates). Lets a shorter match with a much cheaper special distance win. **Gate:** cjxl ratio
   A/B — expected small ratio gain, must not regress speed (frontier is ≤256 candidates).
3. **SymbolCostEstimator unseen-symbol cost** (ragged per-context rows + pseudocount/Huffman-aware
   default instead of the zero-filled matrix where an unseen symbol in a context reads cost 0). Add
   bounds asserts on `Bits(ctx, sym)`. **Gate:** ratio A/B; also a peak-memory win (avoids
   `num_contexts * max_alphabet_size_`).
4. **Worker-owned LZ77 scratch** (reuse HashChain `data_/head/chain/val/zeros/headz/chainz` + the
   special-dist table across streams/frames instead of reallocating per stream). Byte-exact if the
   active-path behavior is preserved; win is allocator churn + peak memory under multithread/video.
   Needs a lifecycle owner above ApplyLZ77 + careful reset. **Gate:** enc throughput + byte-exact A/B.
5. **Conditional/detached zero-run accelerator** (skip `zeros/headz/chainz` maintenance when the
   stream has no ≥3 zero runs). Byte-exact only if the when-active path is bit-identical; risky
   because `numzeros` feeds FindMatches every position. **Gate:** byte-exact A/B on zero-dense +
   textured corpora.
6. **`val` array int→uint16_t** (15-bit hash + 0xFFFF sentinel): ~64KB/chain, byte-exact, low value.
7. **Video/temporal regulation** (carry parse *policy* — chain depth, hash mode, zero-lane, entropy
   priors — across frames, never raw dictionary state; sparse in-span insertion for fast modes;
   special-distance geometric probe lane using `image_widths`). Architecture-level, belongs above
   enc_lz77 with the frame-base/reference-region planner. Ties into
   [[project-jxl-video-codec-20260701]]. **Gate:** full video encode ratio/throughput study.

### FINAL 2026-07-02 — deferred #1 REJECTED (flipflopdom = measured wash)
Ran the definitive flipflopdom (interleaved in-browser, drift-cancelled) A/B: residuals
(best case) geomean −0.3%, photos floor-neutral. No win anywhere; the node harness's "15% win"
was thermal-drift bias. Branch d5p2 DELETED (local+remote). Full write-up in
`docs/1 rejected optimizations.md`. The other deferred items (#2 reverse_map uninit-resize —
note: another agent landed reverse-map direct-expansion on branch r5m8; #3 ANSEncSymbolInfo split;
#4 LZ77 window pool; #5 renorm per-arch) remain untouched.

### UPDATE 2026-07-01c — decode_into error-path uninit exposure FIXED (same branch)

The first-pass "set_len-before-fill restructure" deferral is resolved (minimal form).
Proven real by a truncated-stream test: after `decode_into` errors post-buffer-bind, the
caller's reused Vec was left with `len == elems` (12288) over bytes libjxl never wrote —
an uninit read (benign only because samples are POD). Fix: `decode_into` clears `buf`
(len→0, capacity kept) on any error, so the caller can never observe uninitialised
samples. Kept the hot `run_full_into` loop untouched (its set_len feeds the partial/empty
guards); `decode_into` is the ONLY caller with a caller-owned buffer (decode/decode_view/
run_raw/time_* all use internal Vecs dropped on error), so the one-site fix is complete.
New test `decode_into_error_clears_buffer` (RED 12288≠0 → GREEN). 218/218 crate (MSVC).

The broader "defer set_len entirely in the loop" is NOT needed — that was the risky
restructure; the exposure is fully closed at the wrapper. Remaining deferred unchanged:
strip-staging (peak-RSS unmeasurable in unit test), extra-channel completeness contract
(API decision), animation policy (doc-only), wall-clock pan bench (needs Tauri pan-loop).
  **UPDATE (landed):** the SIMD `box_blur` shipped — `simd::avx2::box_blur_avx2`
  (8-wide vertical pass), dispatched via `blur_mask`. Bit-exact; flip +13.7/11.3/30.1%
  at 1/6/24 MP; aggregate ref-build now +27/20/26% (from +4–10%). Remaining ref-build
  follow-ups below.

- **`ref_moments` → reuse `ssim_moments_avx2_cal(b, b, np)`. LANDED.**
  `ref_moments_dispatch` (mod.rs) uses the channel-as-lane SSIM kernel for Avx2/Avx512:
  its `(sa, saa)` equals `(sb, sbb)` integer-exact (`sab = Σy² discarded`). Test
  `ref_moments_via_cal_matches_scalar`; scalar/wasm keep `ssim::ref_moments`.

- **`box_blur_avx2` uninit tmp/dst. LANDED.** `Vec::with_capacity`+`set_len` instead of
  `vec![0f32; n]` — both fully overwritten before read; f32 has no invalid bit patterns /
  no Drop → sound; output bit-identical. Saves the 2·n·4 B (192 MB @24MP) zero-init.
  **Still open:** the scalar `blur::box_blur` keeps `vec![0f32; n]` (adding `unsafe` to a
  safe fn), and the pyramid downsample targets `nx/ny/nb` in Comparer::new are also
  zeroed-then-fully-written — same wasted memset, same uninit opportunity.

- **Parallelise / widen box_blur (NOT cheap — deferred).** (a) H rows and V column-tiles
  are independent → rayon over `y` (H) and the `x` tile stride (V), gated on `parallel`.
  (b) AVX-512 / wasm-SIMD `box_blur` (currently fall back to scalar V). (c) Fold the
  3-level mask blur into the pyramid walk to avoid re-blurring re-read planes.

## CR2 pass deferrals (perf/cr2-fused-crop-jul02-c2f8, 2026-07-02)

- **Canon SensorInfo (MakerNote 0x00E0) true active area + real CFA phase.**
  **IMPLEMENTED 2026-07-02** on `perf/cr2-sensorinfo-jul02-a9e4` (user-approved
  non-byte-exact pathway). Probe result: ALL 11 fixtures had the WRONG rectangle —
  center-crop origin off by 72 (550D) / 132 (ADH) columns; the shipped output included
  optical-black masked pixels (band mean == black level exactly, see
  examples/cr2_activearea_evidence.rs) and discarded the same width of live image.
  SensorInfo origin is now the default (validated: active dims == IFD0 crop, sensor
  grid == decoded grid, fits) with even-snapped center-crop fallback; CFA phase =
  true origin parity. Remaining follow-up: bodies whose LJPEG origin is not RGGB
  still rely on the lib.rs green-channel net; a body with odd borders now gets the
  correct phase directly instead of triggering retry demosaics.

- **DecodeLimits before allocation.** decode_impl allows 200 MP (≈400 MB u16) before the
  browser caller's 50 MP policy check runs (post-decode). On wasm32 an adversarial header
  can force a huge allocation → OOM trap instead of graceful error. Fix = plumb a
  max_pixels/max_raw_bytes limit into the decoder (API/behavior change for native callers).

- **MaybeUninit LJPEG output sink.** First decode into a fresh buffer still pays a full
  resize zero-fill (~37 MB @550D) that the kernels then overwrite completely. The kernels'
  full-write invariant holds (write every row<out_rows × col<out_pixel_cols on success,
  bail on any entropy error), but eliding the zero-fill means set_len before write —
  an unsafe boundary that wants a mechanical full-write test harness first. (The warm
  scratch path no longer re-zeroes as of c2f8; this only affects cold/owned decodes.)

- **Caller-owned output pool (`decode_into(data, scratch, output)`).** Completes the
  batch/video ownership story (scratch stream buffer + reusable output frames). No
  production caller exists yet (decode_with_scratch itself is test-only); add when the
  batch RAW→JXL path materialises. Pairs with the memory-admission-gate work (rcw-mag).

- **LJPEG rolling-row / stripe emitter.** Deeper restructure: decode LJPEG into a few
  predictor rows and emit active-area stripes directly to demosaic/JXL (kills the
  full-frame raw buffer for raster CR2s; multi-slice needs stripe-aware scheduling since
  the stream is slice-major). Research-grade; mirrors the ORF streaming-preview pipeline

## EMU256 A/B — 2026-07-03 RESOLVED

**Question:** Does `relaxed-simd-mt` (HWY_WASM_EMU256, 8-lane) produce byte-identical JXL vs
`simd-mt` (4-lane)? Is the facade.ts `probeRelaxedSimd()` gate vestigial?

**A/B results** (512×384 synthetic gradient, headless Chrome, `_emu256_ab.mjs`):

Enc byte-exactness — **IDENTICAL at e3/5/7** (same SHA, same byte count both lanes).
Lane-width reductions in enc_cluster/enc_adaptive_quantization are data-parallel only;
no decision-making differs between 4-lane and 8-lane.

Enc timing (median):
- e3: relaxed 38ms / simd 37ms → within noise
- e7: relaxed 165ms / simd 183ms → **relaxed-simd-mt +11% faster**

Dec parity: tested with monolithic builds (not dec-only splits — those pthread-deadlock in
`_jxl_wasm_decode_rgba8` in headless Chrome, likely a headless-pthread interaction, not a
production issue). Monolithic SHA differed (different code paths in enc+dec combined builds;
not a valid apples-to-apples decode comparison). Production decode uses session API, not
C shim.

**Decision:** Facade gate removed. `relaxed-simd-mt` is now the default threaded tier for
ALL browsers with SAB+Worker (not just those passing `probeRelaxedSimd()`). The
`assert-no-relaxed-simd.mjs` build gate enforces 0 relaxed opcodes in the artifact,
making it safe on Firefox/Safari. Change landed in facade.ts + dist/facade.js.
  (decompress.rs q8z) which proved the pattern byte-exact there.

## JXL-LOWLEVEL video-codec reframe — DEFERRED (no still-image consumer) (2026-07-05)

**Context:** Optimisation pass on `raw-converter-tauri/raw-pipeline/src/jxl_lowlevel.rs`
(branch `jxl-lowlevel-borrow-surface-lepack-20260705`). A multi-pass analysis proposed
reframing the low-level JXL decoder as a streaming/video surface pump. Landed the grounded,
real-consumer wins (see below); deferred the architecture because this pipeline decodes
single stills (RAW→JXL) and has no animation/streaming/wgpu consumer yet. Building the
session/scheduler now = speculative abstraction.

**LANDED (this branch):**
- Borrowed progressive surface: `ProgressiveFrame<'a> { rgba: &'a [u8] }` — killed the
  per-pass `out_buf.clone()` (up to ~full-frame RGBA copy per flush). Sole hot consumer
  `pipeline.rs::prefill_jxl_lightbox_progressive` clones-then-discards (rgba→rgb8→downscale),
  so borrow is a pure win. Owned retention now caller-explicit (`rgba.to_vec()`).
- Metric bug fix: `first_ms.unwrap_or(0.0)` → `unwrap_or(total_ms)`. Non-progressive/
  final-only files were reporting a false 0.0 ms time-to-first-pixel.
- FFI hardening: `JxlDecoderSetImageOutBuffer` / `ImageOutBufferSize` failures now fatal
  (were silently `let _ =`) — an unbound-buffer decode produced meaningless timings.
- Micro: dropped needless `unsafe fn`/redundant `pf` reassignment/nested `unsafe`
  (`ptr::read`→`assume_init_read`), `#[inline] ms`, `std::ffi::c_int`.

**DEFERRED (revisit when a consumer exists):**
- **Temporal-frame model.** `FullImage` is per-displayed-frame, not end-of-stream; both
  loops break on it. Correct for stills (one frame, then Success), WRONG for animated JXL.
  Split `FrameComplete` vs `StreamComplete` + frame index only when animated JXL is a use case.
- **Reusable decode session / RAII `DecoderHandle` / decoder pool** — keep-alive across
  chunks, reuse scratch buffers. Needs a repeat-decode caller (grid/video); today it's
  one-shot per file.
- **Streaming input** — treat `NeedMoreInput` as suspend+resume (ReleaseInput/retain
  tail/SetInput), `CloseInput` for complete in-memory assets. Needs network/chunk source.
- **Parallel runner + global thread budget** — `JxlDecoderCreate(null)` = single-threaded;
  add runner only with a scheduler to avoid oversubscription across grid/prefetch/foreground.
- **Quality metadata** — replace `is_final: bool` with downsampling-ratio so callers can
  gate GPU uploads (skip full-res upload for a 1/8 DC preview). Needs a wgpu upload path.
- **Output-side ROI (scanline callback) + coalescing modes + GPU delta composition** —
  pre-crop transport before real `SetCropEnabled`/JXTC bindings land (still absent in
  jpegxl-sys 0.10, per file header).
- **Emit policy / frame-drop / cancellation** callback control (`Continue/Stop/Skip`) +
  decode byte limits — needs deadline-driven playback or hostile-input threat model.
- **RGB8 (drop alpha) / orientation-preserve fast paths** — profile-dependent; RGBA8 is
  the stable GPU/UI format here.

**Note on flipflop (rule 9):** the clone→borrow change is dead-work removal, not an
algorithmic A/B — borrow strictly dominates clone-then-discard (fewer allocs + no memcpy),
so an interleaved timing tournament would be degenerate. Verified via the existing
`jxl_lowlevel_progressive` integration test (real encode→decode) instead. Per rule 10,
newer method chosen: strictly better memory+speed, no regression path.

## DECOMPRESS-HOLO: Olympus decompress.rs — deferred follow-ups (2026-07-05)

**Landed (branch `decompress-holo-lz-20260705-q7x`, raw-converter-tauri):** table-free Huffman (12-bit prefix table ≡ unary rule, `clz(prefix)-19`), branchless adaptive width (`32 - carry_lo.leading_zeros()`, exact over all 65 536 carry values × both stability classes), edge/interior kernel split, paired even/odd interior loop with west+north-west held in registers (3 neighbour loads → 1). New `decompress_into(&mut [u16])` for buffer reuse; `decompress()` signature unchanged. Byte-exact vs baseline on 2 real 20 MP ORFs, +17.9% / +19.2% (interleaved A/B flip, B<A 20/20 & 19/20).

**DEFERRED (revisit when a consumer/threat-model exists):**
- **EOF-error hardening** — `BitReader::fill` still zero-pads past end-of-data (dcraw-faithful). Rejecting truncated streams (return `Truncated`) + a pre-alloc min-bits dimension check + `try_reserve_exact` is a real DoS-hardening item, but it changes the error contract and wants fuzz coverage. Belongs to a dedicated hardening pass, not the perf branch. No perf value.
- **Zero-fill elimination in the allocating wrapper** — `decompress()` still `vec![0u16; n]` then fully overwrites. Skipping the memset (MaybeUninit / `set_len`) is sound (every pixel written before read, proven) but needs `unsafe` for a marginal gain (~memset of 40 MB ≈ a few % of a ~600 ms decode). The higher-value mechanism — `decompress_into` with a pooled buffer — already exists; adopt that in the pipeline first.
- **Pipeline adoption of `decompress_into` + bounded frame-buffer pool** — the real memory/throughput win for a batch/video ORF→JXL path is reusing one raw buffer across frames (no per-frame 40 MB alloc+zero). Needs `pipeline.rs` / batch-loop changes (out of the single-file scope). Mechanism is now in place.
- **Delta-based predictor rewrite** (`dw=w-nw; dn=n-nw; between = (dw^dn)<0 && dw!=0 && dn!=0`) — kept the proven byte-identical ordered-comparison form. The delta form's equivalence was only *claimed*, not verified, and the gain is CPU/compiler-dependent (conditional-move vs branch). Revisit behind its own parity flip if the predictor ever shows up hot.
- **Direct CFA-plane output mode** — decoding into 4 Bayer planes instead of an interleaved mosaic could drop a later mosaic→plane shuffle in demosaic, but it's an end-to-end decision (interleaved raster stores are very cache-friendly today). Benchmark the whole decode→demosaic→JXL path, not the decoder alone.
- **Row/strip streaming + frame-level parallelism** — the decoder only needs current-row + row-2 history, so a strip-streaming raw intermediate could cut peak memory from O(w·h) to O(w). Parallelism belongs at the *frame* level (the bitstream is serial; per-row/per-pixel splitting is invalid). Both need demosaic/encoder co-design.

---

## 2026-07-05 — pipeline.rs holographic/genetics audit: deferred architecture

Implemented in branch `pipeline-holo-opt-lepack-20260705-k4z9` (raw-converter-tauri): fused blur+apply (2→1 scratch frame, +42%), 16-bit LUT cache reuse (~17.5 ms/render), u16 byte-budget + channels==0 + zero-dim + downscale-overflow + 13-tap DC-gain fixes, identity-resize fast path. The following audit items were **deferred** — each is API-breaking, cross-crate, or changes the visual/scheduling contract, so it exceeds the single-file (`pipeline.rs`) scope and needs its own benchmark + caller co-design:

- **CompiledLook / worker-owned RenderState renderer** — replace the global `Mutex<HashMap>` LUT cache with persistent per-worker compiled state and split the pre-LUT vs post-LUT cache keys (contrast-only edits shouldn't rebuild pre-LUTs). API + threading redesign spanning lib.rs/wasm/tauri; the current 8-entry Arc cache already covers the still path. Do behind a persistent-renderer entry point.
- **True RGBA fusion / skip alpha when the encoder takes RGB** — `process_rgba` still builds RGB8 then copies into RGBA8. Real fix duplicates the scalar+parallel+SIMD tone loops 4-wide and needs an encoder-capability signal from the caller. Modest memory gain, large code surface.
- **Orientation as JXL metadata** — pass EXIF orientation to the encoder instead of rotating pixels at the boundary. Encoder/caller-side (jxl_lowlevel / casabio_encode), not pipeline.rs alone.
- **Sensor-bit-depth-aware compact pre-LUTs** (4096-entry for 12-bit sensors) — changes LUT topology + indexing; needs source bit depth plumbed through and a quality check on true-16-bit sources.
- **Luminance-only NR + hue-preserving clarity** — blur one luma plane rather than 3 RGB channels (⅓ the convolution traffic, no chroma bleed). Changes visual output; needs perceptual validation vs the current per-channel behaviour.
- **Resolution-first previews / linear-space downscale before tone+spatial** — the largest throughput idea (preview ~9% of full-res pixels) but a caller-side scheduling decision; moves where downscale sits in the tauri/wasm pipeline. Note the early pre-LUT `[0,1]` clamp means downscale-first ≠ full-res reference near clipped highlights.
- **Headroom-aware scene-linear contract** — defer the pre-LUT clamp past the matrix + highlight stages so highlights are recoverable. Alters highlight rendering + embedded-JPEG match; a deliberate reference-pipeline evolution, not a patch.
- **Tile the whole render graph** (halo-based bounded scratch) + **single-owner parallelism** (avoid nested Rayon across stages) — architecture spanning every stage and a scheduler; large.
- **Typed colour-domain newtypes** (`CameraLinearRgb16`, `Srgb8`, `OpaqueRgba8`, …) — zero-cost enabler that enforces stage ordering; wide but mechanical, own pass.
- **Re-evaluate the x86 SIMD tone path** after the above — the vibrance-nonzero SIMD branch (vector→array→scalar→vector) is a regression candidate; needs a native profiling harness.
- **Temporal render epochs / smoothed auto-WB + exposure across frames** — belongs to a video/batch control layer above pipeline.rs (prevents colour/exposure flicker; also makes neighbouring frames more compressible). `auto_wb_rggb` doc says 4×4 sampling but strides 8 (one RGGB quad per 8×8) — fold into that rework rather than patching in isolation.

## casabio_encode.rs RAW/pyramid hardening — DEFERRED (2026-07-05, branch casabio-encode-hardening-lepack-20260705)

Landed on the branch (correctness + perf, flip-verified): master-derived 16-bit full, sorted/deduped sidecar cascade, sidecars-only RAW ladder (killed a discarded full 8-bit encode), process_rgba skipped when no grid level is requested, and opaque RAW 16-bit levels kept 3ch RGB16 instead of RGBA16 (+43.9% encode time, -0.2% size, byte-identical RGB, drops the RGBA16 master copy + alpha lane — flip: raw-pipeline/examples/rgb16_vs_rgba16_flip.rs). These were deferred:

- **Unsafe progressive frame-option transmute** (`enc.set_frame_option(std::mem::transmute(19i32/13i32), ..)` in encode_one, mirrored at src-tauri/src/pipeline.rs:463) — left as-is. Already tracked in QUESTIONS.md:18 under ADR `unify-jxl-encode-boundary` / BSD jxl-ffi migration; a partial local fix (safe enum, range-validate progressive_dc 0..=2 / group_order 0..=1, propagate the discarded Result) would be churn against the planned encode-boundary rewrite. Do it there, not here.
- **Box-resampler input hardening** — box_downscale_rgba8/rgba16/rgb16 silently `return` on malformed dims (zero-filling a level that is then happily JXL-encoded); box_downscale_rgba8 lacks the `sw==0||sh==0` guard its rgba16 twin has; no explicit upscale rejection (`dw>sw||dh>sh => Err`); the rgba8 path uses u32 accumulators that could overflow for extreme source→tiny reductions. Converting these to `Result<(), EncodeError>` changes public signatures (box_downscale_rgba16 is pub, WASM-parity) and wants its own error-contract + tests. The correctness fixes (sorted cascade, master-first full) already remove the real upscale call-sites, so this is defense-in-depth, not an active bug.
- **RGB8 (3ch) grid + variants path** — the ≤1024 grid levels and the RGBA8 variants still expand opaque RAW to 4ch via process_rgba. A 3ch RGB8 path would mirror the RGB16 win at small-level scale, but process_rgba's output contract and downstream (tiling, contenthash dedup) assume RGBA8; needs pipeline co-design. Lower value (small levels dominate neither time nor memory).
- **resize_rgba borrow** — resize_rgba still `src.to_vec()`s to build the RgbaImage. A borrowed `ImageBuffer<Rgba<u8>, &[u8]>` input would drop that clone but depends on the pinned `image` crate API; needs compile verification. Minor (the full-size variant clone is already gone via Cow).
- **Video-codec / temporal architecture** (the genetics-lens "4th dimension") — temporal inheritance (keyframe/residual GOP container), streaming `PyramidSink` (write each level out instead of retaining every encoded buffer in RAM), memory-budgeted scheduling (permit by estimated in-flight bytes, not thread count), and sequence-level rate control. The analysis itself notes the temporal layer must live ABOVE this file. Out of single-file scope; an architecture epic gated on a container + sequence-policy layer. Keep each stored frame independently decodable as JXL.

## demosaic.rs holographic/genetics audit — DEFERRED (2026-07-05, branch demosaic-cfaborder-mhcsym-perf-20260705-o48)

Landed on the branch (raw-converter-tauri, correctness + perf, flip-verified): checked w*h*3 output sizing (only w*h was guarded before) + demosaic_rggb_mhc_into now returns Err instead of assert_eq! panic; CFA-aware borders replacing colour-invalid coordinate clamping (bilinear 1px ring + MHC 2px halo now reconstruct a constant-colour mosaic exactly at every edge); symmetric MHC (added the missing B-at-R Laplacian mirroring R-at-B — no new raw loads); MhcKernel::Canonical (true Malvar-He-Cutler 8-filter, gamma=3/4) as a selectable variant for experimentation; and a branch-free, clamp-free, row-offset MHC interior (~45% serial / ~52-55% parallel faster, byte-identical to the clamped path which is retained as a #[cfg(test)] oracle — flip: raw-pipeline/examples/demosaic_flipflop.rs, journal docs/outputs/timing tests/flipflop/demosaic-interior-2026-07-05.md). The following audit items were deferred — none has a current consumer (every caller demosaics a full frame at the RGGB origin), so they build speculative infrastructure ahead of need and each needs its own benchmark + caller co-design:

- **BayerView + DemosaicPlan (stride + CFA-origin phase as first-class data)** — carry input stride, active-area, and (origin_x, origin_y) parity so crops/ROIs/tiles/padded decoder buffers demosaic as zero-copy views. Enables all four Bayer patterns and tiling without a realign copy. Larger API surface spanning dng::align_to_rggb + callers; no current caller passes stride/crop/origin.
- **All-4-CFA phase-specialised dispatch (drop align_to_rggb copy)** — replace "RGGB-only + realign" with a per-frame (pattern, origin parity) dispatch to red-row/blue-row kernels, so BGGR/GRBG/GBRG never materialise a realigned raw frame. Depends on the phase-plan above.
- **Tiled / halo-owned parallelism** — 16-32 row tiles with a 2px raw halo emitting only the interior core, instead of per-row Rayon; better 5-row window reuse + coarser work-stealing. Must stay byte-identical to the full-frame result (tile-equivalence test) and be co-scheduled with the JXL encoder's thread budget rather than oversubscribing.
- **Adaptive per-tile quality with temporal hysteresis** — pick bilinear vs MHC-lite vs canonical per tile from a cheap raw-gradient score, stabilised frame-to-frame to avoid shimmer. Belongs to a video/batch control layer above this file; needs the tile plan + a settled quality kernel first.
- **Output-layout selection driven by the encoder** — emit planar RGB16 / interleaved / reduced bit-depth / streaming stripes to match what the JXL prep stage consumes, instead of always interleaved RGB16 then transposing downstream. Caller/encoder-capability co-design.
- **SIMD interior** — only after phase branches, clamps, generic indexing and layout are settled (now done for the scalar interior). Wants the paired-Bayer-cell / planar-lane shape; native + WASM profiled separately.
- **Bayer-plane representation ("JXL as video" — demosaic at decode)** — deinterleave the mosaic into 4 half-res planes (R, G_mean, G_delta via reversible green lifting, B), compress in the sensor domain with CFA metadata, and demosaic at decode/display. Avoids the 2->6 byte RGB expansion + encode-side demosaic entirely. The largest idea and a whole separate species: needs CFA/black/white/WB/matrix/active-area metadata plumbing, a container + sequence policy, and a quality/compression evaluation. Architecture epic, not a single-file change.

**UPDATE (2026-07-05, same branch):** the "unchecked interior" lever is now LANDED
(not deferred). Const-generic checked/unchecked flip on the two 20 MP ORFs:
+5.8% / +4.0% median, byte-exact, B<A 17/20 both. Folded to a single unchecked
`decode_frame` (every index proven < out.len(); SAFETY docs + debug_assert).
Absolute also dropped ~629→~410 ms on an idle box — the earlier 629 ms was
machine-load-inflated (cv 9.9→7.4%). Remaining lever: MSVC toolchain build.

## demosaic.rs SIMD interior (Phase-2 #6) — DEFERRED (2026-07-05, branch demosaic-simd-interior-20260705-s1x, off Phase-1 tip)

Landed on the branch (raw-converter-tauri): the Symmetric MHC interior is now vectorised, byte-identical to the scalar oracle (guarded by simd_interior_matches_scalar + mhc_fast_matches_clamped). Native AVX2 (approach A, blend-of-consecutive) via runtime is_x86_feature_detected!("avx2"), behind the `simd` feature, scalar fallback + tail: ~2.3-2.5x serial, +34-50% parallel (20 MP parallel is memory-bandwidth-bound), flip-verified (raw-pipeline/examples/demosaic_flipflop.rs; journal docs/outputs/timing tests/flipflop/demosaic-simd-avx2-2026-07-05.md). wasm SIMD128 (i32x4, bit-exact mirror) added + dispatch wired; compiles clean for wasm32+simd128. Canonical stays scalar. The following were deferred:

- **wasm SIMD128 runtime golden-check** — the wasm path is compile-verified and is a line-by-line transliteration of the native-byte-verified AVX2 kernel (same i32x4 add/sub/arithmetic-shr_s/bitselect zero-extend loads), so it is bit-exact by construction, but it was not executed in a wasm runtime here (raw-pipeline has no wasm-bindgen-test harness). The consuming wasm crate (raw-converter-wasm) should run a byte-equality golden vs the scalar demosaic once, with RUSTFLAGS=-C target-feature=+simd128.
- **Approach B (256-bit deinterleave-to-phase AVX2)** — deprioritised, not attempted. Removes approach A's ~2x arithmetic waste but needs cross-128-lane permutes (permutevar8x32) for the ±1 neighbour shifts; expected marginal/no gain because the production case (parallel, 20 MP) is already memory-bandwidth-bound. Only worth it if a future compute-bound path (small tiles, serial) dominates. Must stay byte-identical (simd_interior_matches_scalar).
- **Canonical-kernel SIMD** — Canonical (experimental) stays scalar; vectorise only if it becomes a shipped quality tier.

### Build-wiring recommendation (NOT done — outside demosaic.rs, needs a decision)

To actually activate SIMD in production the `simd` feature must be enabled and, for wasm, simd128 turned on:
- **Tauri native build**: add `simd` to the enabled features of raw-pipeline (src-tauri dependency). AVX2 is runtime-detected so this is safe on non-AVX2 CPUs (falls back to scalar).
- **wasm-pack build (Casabio browser)**: build the wasm crate with `RUSTFLAGS=-C target-feature=+simd128` AND enable `simd`. Without +simd128 the wasm SIMD module is cfg'd out and falls back to scalar (correct, just slower). Most 2020+ browsers support wasm SIMD; gate/detect if older browsers must be supported.

## tiff.rs parser — architectural levers surfaced by hardening pass — DEFERRED (2026-07-05, branch perf/tiff-harden-gpsfix-lepack-7a3f2c, raw-converter-tauri)

Context: a full "holographic/genetic" audit of `raw-converter-tauri/raw-pipeline/src/tiff.rs`.
LANDED this pass (surgical, single-file, byte-safe): GPS inline-ASCII hemisphere fix
(S/W were mirrored positive), parse_header short-input panic guard, Reader::slice
overflow-safe reads, bench_decode_orf checked strip slice + checked_mul, thumbnail
checked/validated/capped, oversized-IFD reject, ASCII 4 KiB cap, GPS zero-denominator
reject + range-validate, IFD0 fast-path early-exit, and the JPEG-scanner single-pass
merge (+21%/+56% flip-verified). The following are the larger levers the audit
identified but that exceed a surgical single-file change (need cross-crate/API decisions):

- **Unified `OrfIndex` / validated container map.** Turn the file from stateless
  byte-query helpers into ONE validated parse result (endianness, orientation, dims,
  PreviewSource range, optional RawLayout) that drives orientation/thumbnail/metadata/
  decode. Removes repeat IFD walks across gallery intake; the single biggest structural win.
- **Separate metadata parse from RAW-layout validation** (`parse_container_metadata`
  vs `validate_raw_layout`). Today `parse_orf_metadata` calls full `parse`, which
  requires valid nonzero strip tags — so a corrupt pixel strip needlessly kills
  gallery metadata (make/model/date/GPS/thumb).
- **Zero-copy IFD iterator** replacing `read_ifd -> Vec<IfdEntry>` (validate the
  count*12 region once, iterate borrowed; drops the per-directory Vec allocations).
- **Explicit multi-strip rejection.** `as_u32` returns `value_off` for LONG[count>1],
  so a multi-strip TIFF misparses as single-strip with an array pointer as the offset.
  Currently *contained* by the new bench strip-bounds guard (OOB → Err, no panic), but
  should be an explicit `bail!("multiple strips unsupported")` once a strip/tile model exists.
- **Strict scalar TIFF accessors** (`scalar_u8/u16/u32` validating dtype AND count==1);
  in particular TIFF BYTE is not decoded for big-endian (GPS altitude ref 0x0005 works
  on LE by truncation only). Also dedicated `as_srational -> (i32,i32)` — `as_rational`
  currently accepts SRATIONAL (type 10) but returns unsigned.
- **`black_level` field is inert** — declared on OrfInfo, never assigned. Parse it from
  Olympus metadata or make it `Option<u16>` so downstream can't read a false 0.
- **WB provenance** — legacy RedBalance/BlueBalance, top-level WB_RBLevels, and
  ImageProcessing WB_RBLevels currently resolve by traversal order (last-tag-wins).
  Make precedence explicit (ImageProcessing > legacy) via a `WbSource` enum.
- **MakerNote inner byte-order.** Modern Olympus MakerNote headers carry their own II
  marker; the nested reader inherits the outer TIFF endianness. Harmless while all ORFs
  are LE, but a correctness risk if outer≠inner. Needs a legacy/E-system/OM fixture corpus.
- **Borrowed preview API** (`embedded_preview_slice -> &[u8]`) so native callers decode
  the embedded JPEG directly from the ORF backing buffer (no copy); WASM chooses its own
  transfer/copy boundary. `find_embedded_jpeg_range` already returns a `Range`, so the
  borrow API is one thin wrapper away.
- **Non-allocating internal `ParseError` enum** — fast helpers format a `String` error
  only to discard it as `None`/default; format at the public boundary only. Matters on
  drag-and-drop folders of mixed/partial files.
- **Preview scheduling split** — header+IFD0+direct-thumbnail-pointer are cheap enough
  pre-semaphore; the 3 MB fallback JPEG scan and decode belong in a bounded worker queue
  with cancellation for scrolled-away gallery items.
- **Streaming/tiled RAW seam** (row/tile decode with a 2-row MHC halo → immediate
  downscale/emit) to avoid holding full RAW + full RGB16 planes at once. Depends on
  `crate::decompress` exposing rows/blocks; align tiles to JXL group sizes (VarDCT 256²).
- **JXL-as-temporal-codec / CFA-planar reframing** (the "genetics" pass): classify ORF
  bursts from embedded previews (scene-cut/global-motion/changed-area) BEFORE full RAW
  decode; native JXL multi-frame for low-motion sequences, conventional video for
  high-motion, still-JXL for singles. Highest upside + highest format/decoder complexity;
  own-ecosystem territory, benchmark on a real burst corpus before committing.

## dng.rs hardening pass — deferred (2026-07-05, tauri branch perf/dng-landing1-hardening)

Landing 1 (correctness) + Landing 2 (uncompressed row-wise, +74–92%) landed. Deferred:

- **MaybeUninit frame pool** — `decode_bytes` zero-inits `vec![0u16; pixels]` then fully
  overwrites it. A reusable frame pool + `MaybeUninit<u16>` skips the zeroing memset, but
  is only sound once *every* successful decode path is proven to write every pixel (edge
  tiles, partial last band, error unwinds). Needs exhaustive coverage tests first.
- **Uncompressed strip layout** — `decode_uncompressed` still bails on strip-offset DNGs
  (tiled only). Implementing strips lets tiled+stripped share one row-oriented band
  decoder. Doc now states the true limitation.
- **Metadata bound to raw IFD (M4)** — AsShotNeutral / colour+forward matrices / ISO /
  make / model / orientation are collected globally on `WalkState` (last-writer-wins by
  traversal). Safe for standard DNGs (IFD0-carried, walked first) but a preview SubIFD
  carrying these would clobber. Bind to the chosen `RawIfd` with explicit IFD0 fallback.
- **`samples_per_pixel==1` invariant (M1)** — `cps` is threaded into `decode_tiles` then
  discarded (`let _ = cps`). Either validate SPP==1 in the parsed layout or let ljpeg
  enforce component count; don't carry a dead arg that hides a missing invariant.
- **`width > 1000` raw-selector heuristic** — crude thumbnail filter; rejects legitimately
  small raws. Replace with structural selection (NewSubFileType, PhotometricInterpretation,
  SPP, CFA tags, pixel area) rather than a magic dimension threshold.
- **IFD cycle/visited set** — `walk_depth` caps recursion depth (8) but has no visited-offset
  set; cyclic/duplicate SubIFD offsets cause duplicate work + metadata churn. Cheap HashSet.
- **CFA repeat-pattern validation** — `CFARepeatPatternDim` (0x828D) is ignored; a 2×2 Bayer
  layout is assumed. Validate and reject non-2×2 explicitly instead of silently assuming.
- **Sequence/video architecture** — no frame loop exists in `raw-pipeline` today; the
  sequence-profile / one-owner-of-cores / band-fused DNG→demosaic→JXL pipeline from the
  analysis is genuine future architecture, not a current bug (stages already run
  sequentially, each owning rayon in turn — no nested oversubscription exists). See the
  ORF-side "JXL-as-temporal-codec / CFA-planar reframing" bullet above; same territory.

## ljpeg.rs LJPEG decoder — deferred (2026-07-05, branch ljpeg-hotpath-holo-20260705-h7k, raw-converter-tauri)

Landed this pass: correctness hardening (oversubscribed-DHT / short-segment / category>precision
/ point-transform-restore / SOS-reorder-reject / truncation-detect), the cps==1 fast8 kernel,
removal of the eager 512 KB per-tile table zero-fill, and max_bits-sized lookup tables. Deferred
because each is either measure-only, an API-contract change, or genuine future architecture:

- **Top-aligned bit reservoir.** Keep valid bits in the *high* bits of the u64 so `peek16` is a
  fixed `>>48` and `consume` drops the per-symbol mask rebuild (`bits &= (1<<nbits)-1`). Sits
  directly on the serial entropy dependency chain — worth a dedicated native+WASM flip, but a
  full bitreader rewrite; not folded into a correctness pass.
- **Bulk 4/8-byte refill.** When the next N bytes contain no 0xFF, append in one op instead of
  byte-at-a-time; keep the stuffed-byte path for the 0xFF case. Portable bounds-checked first,
  benchmark before any unsafe unaligned load.
- **PreparedLjpegPlan / thread-local compiled-DHT cache.** Tiled DNG rebuilds the same Huffman
  tables + dispatch decision per tile. Cache an immutable compiled plan (Arc<CompiledHuff>,
  scan_to_component, kernel choice) keyed by header fingerprint; bounded + thread-local, no
  global lock. Biggest remaining structural win for tile-heavy / sequence workloads.
- **Compact canonical long-code fallback.** Replace the max_bits lookup entirely with fast8 +
  min_code/max_code/value_offset arrays scanned only on the rare >8-bit code. Ship only once
  counters confirm long-code fallback is genuinely rare on the real corpus.
- **Output-shape kernel split + edge policy.** full-tile vs right-edge (discard-decode the
  invisible suffix: consume entropy, no predictor write) vs bottom-edge (stop after the last
  required row in a non-strict mode). Needs an explicit strict-vs-fast decode-policy flag on the
  public API, so it is a contract change, not a local edit.
- **DecodeLimits / decoded-sample ceiling.** Bound total decode work so malformed dimensions
  can't create huge work for a tiny output rect.
- **Full SOS scan-order support.** Currently *rejected* rather than handled (real DNG/CR2 never
  reorder). If a reordering stream ever appears, decode entropy in scan order while indexing
  predictor/output through scan_to_component.
- **Cold DecodeFault enum + `#[cold]` error ctors** instead of `anyhow::bail!` inside the
  per-sample primitive — WASM code-size / i-cache. And **feature-gate LJPEG_FORCE_GENERIC** out
  of production builds (it is an always-compiled atomic today, read once per tile).
- **Stricter SOF/SOS acceptance:** reject non-1×1 sampling factors, non-zero SOS AC selector,
  and DRI/restart-interval streams explicitly (today the first restart marker just ends entropy).
- **JXL-as-temporal-codec sequence layer** — same territory as the ORF-side reframing bullet
  above; independent .jxl masters as germline, animated/delta JXL as derived product. Future
  architecture, not a decoder bug.

## src-tauri/src/pipeline.rs — strategic/hologram/genetics analysis pass (2026-07-06, branch fix/tauri-pipeline-rgba16-wire-k7m3q)

Context: strategic + "hologram/dark-room/UV" + genetics-lens review of the Tauri
orchestration file. The one shippable *in-file* item (P0 RGBA16 wire-packing panic +
crop checked-arithmetic hardening) was implemented on that branch. Everything below is
real signal but crosses module/repo boundaries, so it is deferred to an integrator with
a wider blast radius, not squeezed into a single-file edit.

- **Version the pixel wire header (u16 dims → magic/version/format/u32 dims).** The
  current 4-byte `u16 w | u16 h` header caps dims at 65535 and encodes no pixel format —
  the frontend infers RGB8 vs packed-RGBA16 from the command name. Real improvement, but
  the JS/TS decoder is **not in this repo**; header change must land in lockstep with the
  web repo. Cross-repo, not a pipeline.rs-local edit. (Code already loud-fails on >u16 dims.)
- **`mode: String` → `enum ProcessingMode { Full, Lightbox, Thumb }`.** Type-safety so a
  drifted frontend string can't silently fall back to full materialisation. Touches the
  serde request contract + every match site; do with the frontend enum change.
- **Per-image `AtomicU64` render generation** replacing the shared
  `Arc<Mutex<HashMap<u64,u64>>>` (`look_render_gens`). Removes the global slider-drag lock
  and stale map entries after eviction; cancellation becomes a cheap atomic compare. Needs
  the counter to live on the cache entry / `Rgb16State`, i.e. an `AppState` restructure.
- **Foreground-first scheduling: stop synchronous DC/pyramid prefill racing ingest
  completion.** Deliver thumb→lightbox first, then background 512/1024, then 2048/full/JXTC.
  Multi-site (process_file ordering + scheduler); architectural.
- **Opaque-RAW RGB path (skip RGBA end-to-end).** RAW alpha is always 255 yet the variant
  machinery builds/resizes RGBA then strips to RGB before encode. Tone RAW straight to RGB8,
  encode `Frame::rgb`. Spans casabio_encode + pyramid; ~25% off tone/resize/IPC for photos.
- **Byte-budgeted weighted cache eviction** (vs count-based LRU): full RGB16 masters and
  64 tiny previews are not equal residents. Spans the cache modules.
- **PyramidPlan + render-fingerprint key + eliminate encode-then-discard.** Declare the exact
  output set before rendering; key durable products by source+recipe+ABI+colour-policy+plan
  instead of path+mtime. Spans casabio_encode / pyramid_store / ingest. (See also the ORF-side
  pyramid bullets already in this file.)
- **Split `PipelineParams` into SensorGenome / DevelopRecipe / RenderPolicy.** Slider moves =
  recipe frame; compact-LUT/fast-demosaic = runtime phenotype. Different cache semantics per
  layer. Broad refactor across raw-pipeline.
- **Native↔WASM parity suite.** The Tauri and WASM pipelines have diverged; a fixture harness
  comparing RGB16/RGB8 checksums, dims/orientation, peak bytes, encode/decode timing, and JXL
  size would stop an optimisation/fix applying to only one fork. Cross-project infra.

<!-- casabio.rs upload-path holographic review — 2026-07-06 -->
- **JPEG full variant: lossless transcode instead of decode→re-encode.** `casabio_upload_file`
  decodes JPEG masters to RGBA then re-encodes the full level lossy (Q85) via `encode_one`.
  `jxl_native::transcode_jpeg_to_jxl` exists and the main pipeline already uses it (pipeline.rs:1845).
  Route JPEG full through transcode (lossless, skips the largest encode); decode only for thumb/preview.
  BLOCKED on an orientation contract: transcode preserves the original JPEG + its EXIF-orientation
  metadata, while casabio bakes orientation into pixels — consumers must honour one convention, not both.
  Needs a sidecars-only encoder (encode_variants always emits `full`). Spans casabio + casabio_encode + server contract.
- **DNG/CR2/NEF decode routing.** `classify_source` tags 20 RAW extensions as `Raw`, but
  `decode_raw_to_rgba` is ORF-only (tiff::parse + Olympus decompress + `default_olympus`, rejects
  `compression != 1`) so compressed DNG/CR2/NEF fail with "compression X not supported" and never reach
  the specialised (faster) DNG/CR2 kernels. Reuse pipeline.rs's multi-format DecodePlan. Correctness + perf. Cross-crate.
- **Shared `reqwest::Client` in AppState.** `list_expeditions` and the upload path each build a fresh
  `reqwest::Client::new()`, losing keep-alive/TLS reuse across a bulk upload batch. Hold one Client in
  AppState. Small AppState edit (lib.rs) — deferred to keep this pass casabio-scoped.
- **`resize_rgba` double full-frame copy.** casabio_encode.rs `resize_rgba` does `src.to_vec()` per call
  and is invoked for both thumb and preview → the full source RGBA is copied twice (24 MP ≈ 2×96 MB churn)
  just to build an `ImageBuffer`. Build one `RgbaImage` once, resize twice from `&img`. raw-pipeline crate; flipflop-able.

### CR2 slice-scatter fix (raw-converter-tauri, cr2/slice-scatter-lepack-20260706) — deferred follow-ups

Context: cr2.rs decoded sliced Canon CR2 (CR2Slices 0xC640) as flat raster → spatially
scrambled mosaic (confirmed visually on `_MG_1744.CR2`, fixed via dcraw-style band scatter
fused into the crop). These are the follow-ups intentionally left out of that surgical fix:

- **CR2 one-buffer direct decode (peak memory P1).** The fix keeps two full buffers
  (`raw_decoded` raster 35.8 MiB + cropped 34.2 MiB), same as before. To drop the raster
  staging buffer, `ljpeg::decode_tile` would need a sink/callback that writes each sample
  straight to its scattered sensor position (or a bounded slice-row stripe buffer). Touches
  the shared ljpeg module (risky) — deferred. flipflop-able: fused-2-buffer vs direct-1-buffer.
- **CR2 CFA as first-class.** `Cr2Image` has no `cfa` field; the consumer feeds `img.raw`
  straight into `demosaic_rggb_mhc` assuming RGGB (DNG path calls `align_to_rggb`, CR2 doesn't).
  The fix preserves RGGB by forcing even crop offsets (correct for the current Canon corpus).
  General fix: carry `cfa`, shift phase by crop parity instead of forcing even, align like DNG.
- **CR2 active area from metadata, not centered guess.** Crop offsets are `(full−active)/2`
  rounded even (left=80, top=30 here). Real Canon margins (SensorInfo) can be asymmetric →
  a few-px framing / phase error on some bodies. Resolve from Canon SensorInfo.
- **CR2 body/ISO black+white levels.** Still hardcoded per precision (14→2048/15300, 12→512/4095)
  and a single green WB coefficient (g2 discarded). Baked into the derived JXL if wrong.
- **cps=4 CR2 uses the ljpeg generic loop.** `_MG_1744.CR2` is cps=4/prec=14, so the cps==2
  fast8 kernel never runs on it. A cps==4 monomorphization would speed the dominant (serial
  Huffman) stage — decode measured ~347 ms best on this file. flipflop-able vs generic.

  - RESOLVED 2026-07-06 (cr2/slice-scatter-lepack-20260706): the one-buffer direct
    decode landed. `ljpeg::decode_sliced_cr2` fuses decode+scatter+crop via a
    `SampleSink` (RasterSink keeps DNG/cps2 byte-identical; SliceCropSink does the
    fused CR2 write). Peak decode memory 70→34 MiB. Flip: byte-identical, ~3.8%
    slower decode than decode-then-bulk-copy; memory-lean chosen, 2-buffer removed.

## src-tauri/src/pipeline.rs — ChatGPT "hologram/genetics" audit (2026-07-06, branch pipeline-realwins-qz74k)

Two ChatGPT audits proposed a demand-driven rearchitecture of the native Tauri pipeline.
The three grounded, verifiable wins were taken (see below); the architectural moonshots are
deferred here — each is multi-file, speculative, and needs its own spec + flipflop gate.
**Taken this pass:** (1) RGBA16 wire-packing panic — already fixed independently on branch
`fix/tauri-pipeline-rgba16-wire-k7m3q` (not re-done). (2) channel layout inferred via
`jxl_source_rgb.len() % 4 == 0` → replaced with the mode-known count returned from
`process_post_demosaic_for_mode` (thumb=3/full=4); the old heuristic mis-labels any even-area
RGB8 buffer as RGBA. (3) per-file `local_pool` sized off the `FILE_CONCURRENCY` **const**
(fixed `.max(2)` → 2 threads regardless of load) → now sizes off the **live** `PrioritySem::max()`
so `set_concurrency` is honoured and default 12× yields the benchmarked 1 thread/file (de-oversub).
(4) slider `apply_look_stream` spawned a full render per drag, discarding stale frames only
after paying render cost → latest-wins coalescer (≤1 render/image, newest pending wins).

Deferred architectural ideas (real, but out of scope for a pipeline.rs-local hardening pass):

- **In-flight singleflight dedup.** Coalesce concurrent decode/resize/JXL-decode requests for
  the same render fingerprint (thumbnail vs lightbox vs pyramid vs prefill arriving before the
  first completes) so a source isn't decoded/toned more than once. Highest-value idea; needs a
  per-image job registry keyed by a render fingerprint. flipflop-able: cold-gallery-open latency
  + duplicate-decode count with/without the registry.
- **Output-plan lattice (ThumbOnly / Lightbox / Master / Pyramid).** Replace the `mode` string +
  independent `skip_jxl`/`include_jxl`/`use_tiled_jxl` flags with an explicit output-dependency
  graph, and let a thumbnail job be *promoted* to a lightbox/master job instead of restarting
  from source. Also fixes the latent thumb-mode-3ch-into-encoder fragility structurally (the
  `src_channels` return is the tactical fix already landed).
- **Thumb mode truly thumb-only.** `mode="thumb"` still derives the 1800px RGB16 lightbox state,
  ingests a pyramid, and can pre-encode a lightbox JXL. A genuine gallery-prefetch path would
  decode at the smallest sensible scale and skip 1800 RGB16 / pyramid / JXL prefill. flipflop-able:
  first-360px-thumb latency + peak RSS, thumb-only vs current.
- **Cancellable, priority-bound JXL decode prefill.** After encode, the file synchronously
  DC-decodes and schedules a full/lightbox JXL prefill for *every* item, off-queue. Gate it to
  the selected image + viewport neighbourhood, pause under visible/interactive/encode load, cancel
  on viewport exit. flipflop-able: prefill-jobs-completed vs actually-consumed.
- **Weighted byte-budget cache + hot/warm/cold tiers.** Today there are ~8 independent 25-entry
  LRUs (RGB16, lightbox RGB8, thumb, full JXL, lightbox JXL, decoded JXL lightbox, fast-thumb) +
  a 100-entry subject-crop cache, none byte-budgeted or coordinated by image id. Replace with a
  weighted per-image bundle evicted by total resident bytes and active/nearby status; demote RGB16
  after interaction ends, retain compressed JXL. Needs peak-RSS instrumentation first.
- **Memory-aware self-shrinking RGB16 pool.** `pool::u16_pool()` can retain an unusually large
  RAW buffer's capacity for the process lifetime (looks like a leak). Add capacity classes, max
  pooled bytes, idle expiry, and immediate return of outsized (panorama/stitched) buffers.
- **Stage-aware admission / back-pressure.** The file semaphore caps job *count* but not job
  *stage*; 12 files can all hit RGB16-heavy or JXL-heavy stages at once (bursty RSS). Bounded
  per-stage lanes (decode / demosaic / transform / encode / pyramid / prefill) with shared CPU +
  memory permits, visible work outranking speculation.
- **Render-provenance (genome) keys.** Content-address artifacts by source hash + decoder/develop/
  color/encoder revisions + orientation + crop + output size + layout, so caches/disk artifacts are
  lineage-correct after edits and dedup-able across native/WASM. Prereq for a persistent disk cache
  of compressed artifacts (thumb / lightbox JXL / master JXL / pyramid tiles — not RGB16).
- **JXL-as-temporal-container (CASV).** SequenceEncoder distinct from the single-frame Encoder
  (no `JxlEncoderReset` per frame); start with an all-intra JXL baseline, then measure animated-JXL
  frame semantics, then a CASV manifest with tile/region inheritance (hold frames + changed tiles +
  content hashes before any motion estimation). Genuinely large; own project.
- **Pool-sizing full batch A/B (follow-up to the landed #3 fix).** The live-`sem_max` pool sizing
  was justified by the existing ORF sweep (12×1 optimum, thread-heavy configs cratered) + removing
  the const/runtime disconnect, NOT by a fresh end-to-end batch run — the batch `process_file` path
  isn't cheaply isolable in flipflop (it needs Tauri `State`). Deferred: extend `lightbox_bench.rs`/
  `strategy_bench.rs` to exercise the real `local_pool` under `PrioritySem` and A/B `.max(1)` vs
  `.max(2)` vs live-sem at c∈{1,3,6,12}. Expected: parity-or-better at 12×, wins at lowered c.
