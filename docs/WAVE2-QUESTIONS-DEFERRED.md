# Wave-2 — Deferred Questions (consolidated, for David)

Overnight run 2026-07-06→07 drove S1–S6 as far as each could go **without your judgment**.
Every call that changes user-visible output, or that needs an environment/policy decision,
was parked here instead of being decided silently. Each item: context → options →
**recommended default**. Nothing below blocked the work that landed; revert/redecide freely.

Per-item full detail lives in each branch's `docs/HANDOFF-S{n}-*.md` and its own copy of this
file. This is the union.

---

## ★ The decisions that actually matter (read these first)

1. **S1-Q1 / S1-Q2 / S1-Q3 — canonical vs old-fork behavior deltas.** The unified crate produces
   *different pixels* in three places (richer tone chain; symmetric-MHC demosaic ~25% of pixels;
   identity-downscale black-frame fix). None adopted silently. These are STRATEGIC-MAP open-decision
   #2 (behavior-reconciliation policy). → route the colour ones through **S5's golden workflow**.
2. **S5-Q1 — golden-approval workflow.** Blocks every output-changing colour stage (S5 stages 2–4,
   and S1-Q2). Needs: a corpus, a viewer, and a named colour authority (you?). Until it exists,
   all colour-shifting work stays parked.
3. **S4-D3 / S4-D4 — fuzzing + CI home.** `cargo-fuzz` can't run on this box (no nightly-MSVC
   sanitizer); the new `verify.yml` is the repo's first CI but is un-runnable locally. Decide where
   fuzz/CI live (Linux CI nightly?) and whether CI gates merges.
4. **S1-Q4 — G2 (fork deletion + GPL removal).** ~4–6 eng-days, mostly in the **app repo**
   (out of tonight's scope). Sequenced in `docs/S1-G1-report.md §7`.

---

## S1 — raw-pipeline fork unification
Context: `docs/S1-G1-report.md`. Canonical crate is a −6%, parity-clean, compile-verified superset.

- **S1-Q1 Adopt canonical tone rendering as app ingest?** Richer tone chain → visibly different
  (more accurate) colour, tone +40% but −6% end-to-end. Rec: adopt after a one-time visual sign-off;
  none applied.
- **S1-Q2 Demosaic colour/quality holo items.** 3 MISSING changes alter pixels (CFA borders;
  **symmetric MHC B-at-R ~25% of pixels**; Malvar kernel). The wasm-SIMD MHC perf win is baked on the
  symmetric formula. Rec: route through S5 golden sign-off; not ported.
- **S1-Q3 Identity-downscale black-frame fix.** `(1<<64)/1 = 0 → black`; holo guard fixes it but
  changes identity-case pixels. Rec: port after confirming call-site reachability; not ported (parity).
- **S1-Q4 G2 destructive steps.** Vendored deletion + GPL `jpegxl-rs` removal + packaging; app-repo,
  separate approved handoff. Not started.

## S2 — browser delivery engine
Note: most of the S2 safe-subset was **already on `main`** (QUESTIONS §002/§003 evidence stale).

- **S2-Q1 WebGL 16-bit path.** fix-vs-drop is **moot** — already consolidated onto one engine
  (`renderRgba16AdjustedToCanvas`). Only browser render/slider parity is UNVERIFIED. Rec: keep GL.
- **S2-Q2 Tone-math divergence** (8-bit preview vs 16-bit GL shaders). Unifying is output-visible,
  needs same-slider browser parity. Rec: single-source the tone op in a browser-verified change.
- **S2-Q3 Route lightbox `loadLevel` through pooled tiled path.** Worker now speaks pool v1 protocol
  (landed), but lightbox still full-decodes. Rec: region-route later, browser-verified.
- **S2-Q4 main.js CardState refactor** — ASSESSED & DROPPED 2026-07-07 (commit c1d8fcf8). The
  WeakMap+discriminated-union plan rested on a stale (pre-cleanup) premise: main.js has NO per-card
  Maps (`liveStateMap` is worker-internal; `peepCache`/`cardBy*` are cross-card indices), per-card
  state already lives as expando props on each card element, and `_lightbox` is a decoded RAW-pixel
  cache — not lightbox open-state (that is the module global `lightboxIndex`). Migrating ~300 expando
  sites on this 5/5, unit-test-free browser entry is high-risk/low-gain, and the `_lightbox` union
  would break `havePair`/raw-mode gating. Delivered instead: a JSDoc `@typedef CardState` contract +
  lifecycle invariants above `makeCard`, `removeCard` now closes per-card ImageBitmaps, and a central
  detached-card guard in `_onJxlDecodeResponse`. Cheap wins (cancel-on-delete, peepCache LRU,
  closeLightbox reset) were already done. Do not re-attempt the WeakMap migration without new
  evidence it pays off.
- **S2-Q5 Stale `dist/worker-protocol.js`.** Harmless (nothing imports the runtime validator). Rec:
  `tsc` rebuild dist, or wire the validator in dev.

## S3 — memory-governed asset store
- **S3-Q1 peepCache: count-cap vs byte budget.** Migrated behavior-preservingly (count 24). Rec:
  keep now → `maxBytes ≈ 384 MB` after a scripted peep session under `performance.memory`.
- **S3-Q2 asset-store import `src/` vs `dist/`.** Plain ESM, no build; `src/` works. Rec: keep.
- **S3-Q3 Wire `estimate_decode_peak` into admission gate.** Export exists, unused. Rec: wire as a
  soft log-only signal first, then a hard gate ≥1.5× once model-vs-RSS multiplier is measured; retire
  the arbitrary 1 GiB `MAX_OUTPUT_BYTES_GUARD`.
- **S3-Q4 Per-session retained-frame governor — which layer.** Designed, NOT implemented (CLAUDE.md
  forbids backpressure in facade/session). Rec: extend the scheduler's byte-HWM to also count retained
  pixels; AssetStore-on-main-thread is the cheap interim.
- **S3-Q5 AssetStore drives jxl-cache OPFS?** ~10-line adapter, not wired. Rec: wire when pyramid
  level-byte cache migrates.

## S4 — verification & hardening
- **S4-D1 Loose bench-script relocation — NOT done.** ~33 root scripts are not all scratch
  (flipflop skill vehicle invoked by path; `*Test.mjs` carry relative-path reads + cross-imports). A
  blind `git mv` breaks the skill. Needs a keep-at-root-vs-relocatable list + approval to update refs.
- **S4-D2 WASM simd128 parity oracle — deferred.** Native SIMD-vs-scalar oracles exist + whole-pipeline
  identity proven by the golden ledger; wasm backend needs a node harness. Scheduling, no decision.
- **S4-D3 cargo-fuzz real runs — tooling gap.** No cargo-fuzz + only broken GNU nightly on this box.
  Targets + seeds scaffolded, verified via `fuzz_smoke.rs` + `cargo check`. Decide: Linux CI nightly or
  local nightly-MSVC install for real fuzzing.
- **S4-D4 CI `verify.yml` — added, un-runnable locally.** First CI in the repo. Decide runner
  (ubuntu/windows), whether to build libjxl in CI, and whether it gates merges.
- **S4-D5 27 tracked `external/libjxlJun26/bin/*.exe`.** Look like intentional prebuilt libjxl tools,
  not scratch → left tracked. Decide: keep, or untrack (large) + document rebuild path.

## S5 — scene-referred colour core
Stage 1 (typed `ColorMatrix` + `ColourPolicy` + `wb_from_camera`) landed **byte-neutral** (ORF/DNG
hashes unchanged). Questions gate the output-changing stages 2–4.
- **S5-Q1 Golden-approval workflow (BLOCKS stage 3).** Rec: numeric ΔE/butteraugli tripwire + human
  review on trips, viewer = shipping web lightbox at fixed sliders, corpus from S4 golden set. Name the
  colour authority.
- **S5-Q2 Re-enable CR2 per-model matrices.** Disabled on purpose (WB-first collapses XYZ→cam). Rec:
  ship additive linear-16 mode first; re-enable is a separate golden-gated PR. Hook ready.
- **S5-Q3 Consume `wb_from_camera`.** Surfaced but unread. Rec: keep metadata-only now; expose in WASM
  `*_meta` next (informational); gray-world-when-false is output-changing → golden-gated.
- **S5-Q4 Headroom-aware clamp deferral (stage 3).** Changes highlight rendering on every image. Rec:
  keep current clamp → prototype behind default-OFF flag + A/B on golden → adopt on sign-off.
- **S5-Q5 Home for colour types.** In `pipeline.rs` now. Rec: extract `colour.rs` when stage-2 adds
  linear-mode + level types.

## S6 — LOD/ROI unification
- **S6-1 CASV v2 encoder/decoder wiring (P3).** Pure container landed; wiring into `casa_video.rs`
  needs libjxl → deferred. Rec: v2 opt-in behind a `CasaVideoOptions` flag (header AND footer variants),
  v1 default; promote `CASV2_*` into `casv-format.json` + casv-web together (K6#3 invariant).
- **S6-2 WASM `process_region` export.** Core verified; ~15-line `#[wasm_bindgen]` wrapper deferred
  (wasm build heavier). Rec: add next session with a `wasm-pack` smoke check.
- **S6-3 Haloed spatial ROI.** `process_region` is exact for the per-pixel stage; unsharp needs a
  haloed crop. Rec: generalize `stream_band`'s row-halo to a rect-halo when ROI export needs sharpening.
- **S6-4 Producers must EMIT v2 manifest fields.** Readers tolerate absence; resolver's
  resolution-over-progressive path lights up only when written. Rec: emit per-tier dims from K2 encoder
  for new assets; default-fill for old; no blanket migration.
- **S6-5 Resolver's long-term home.** In `@casabio/jxl-progressive` now. Rec: extract to
  `@casabio/lod-resolver` at the second consumer.
- **S6-6 `quality` numeric semantics.** Currently fraction-of-bytes. Rec: keep (intuitive, monotone);
  Butteraugli-target mapping is the richer future option.
