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
- **S2-Q4 main.js CardState refactor** (WeakMap + discriminated union). Large ADR-level; staged plan
  in handoff. Cheap wins (cancel-on-delete, peepCache LRU, closeLightbox reset) done.
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
# Wave-2 — Deferred questions / user-only calls

Items an overnight autonomous run cannot decide or safely land. Each is a
decision or an environment/tooling dependency, not a blocker for the work that
did land. Revert any landed commit freely if a decision goes the other way.

## S4 — verification & hardening (2026-07-07, overnight)

### D1. Loose root bench-script relocation — NOT done (needs a dependency audit)
Strategic map §S4.5 asks to move loose root `*.mjs`/`*.js` benches into `bench/`
or `tools/`. Not landed: the ~33 root scripts are **not** all inert scratch —
`flipflop.mjs`, `flipflop-corpus.mjs`, `flipflop-journal.mjs`, `flipflopMem.mjs`,
`flipflopdom.mjs`, `flipflop-metrics.mjs`, `flipflop-byte-cutoff.mjs`,
`flipflop.test.mjs` are the **flipflop skill vehicle** (the skill invokes them by
path); the `*Test.mjs` harnesses carry relative-path reads (`./web/pkg`,
`./packages/...`) and cross-`import` each other. A blind `git mv` breaks the
skill and every relative path. **Decision needed:** (a) which scripts are keep-at-
root skill infrastructure vs relocatable, and (b) approval to update the
references (skill config + docs + inter-script imports) in the same PR. Mechanical
once that list exists; unsafe to guess overnight.

### D2. WASM simd128 parity oracle — deferred (needs a node+wasm harness)
Native AVX2/AVX512-vs-scalar oracles exist for `scale_err` and `pixels_to_xyb`
(see `tests/parity_oracles.rs` index), and the whole-pipeline SIMD-vs-scalar
identity is proven by the golden ledger (ORF/DNG digests reproduce byte-for-byte
under `-C target-cpu=native` and scalar builds). The **wasm** backend
(`perceptual/simd/wasm.rs`) has no scalar-parity oracle because wasm SIMD can't
run under native `cargo test`. Closing it needs a node harness that loads the
wasm export and pins its `scale_err`/`pixels_to_xyb` output against the scalar
reference. Not "quick"; deferred. **No decision needed** — just scheduling.

### D3. cargo-fuzz real runs — tooling gap on this box
`cargo fuzz build/run` cannot execute here: `cargo-fuzz` is not installed, and the
only nightly toolchain is `nightly-*-windows-gnu` (GNU is broken — no `dlltool`);
there is no nightly-MSVC with a libFuzzer/ASAN runtime. The targets + seed corpora
are scaffolded and the harness logic is verified via `tests/fuzz_smoke.rs`
(mutation sweep, no panic) and `cargo check` (all 9 targets compile). To run real
fuzzing: install cargo-fuzz + a nightly-MSVC sanitizer toolchain (or run on Linux
CI), then `cargo +nightly fuzz run <target> -- -max_total_time=...`. The four
CASV/JXTC targets additionally need `--features codec` (libjxl:
`LIBJXL_SOURCE_DIR` + `LIBCLANG_PATH`). **Decision:** where do long fuzz runs live
— Linux CI nightly, or a local nightly-MSVC install?

### D4. CI workflow — added but not runnable/verifiable locally
The repo had **no** `.github/workflows/`. This pass adds `verify.yml` wiring the
S4 verification surface (parser tests + golden ledger + fuzz-smoke + parity
oracles + `cargo fuzz build` + the bun FFI-ABI contract test). Every step's
command is verified locally, but GitHub Actions itself cannot be executed here, so
the YAML is unverified end-to-end (runner image, toolchain install, action
versions). **Decision:** confirm the runner (ubuntu vs windows), whether to build
libjxl in CI for the codec/ffi-abi legs, and whether this should gate merges.

### D5. Tracked reference binaries `external/libjxlJun26/bin/*.exe` (27 exes) — left as-is
`.gitignore` ignores `*.exe`, but these 27 were committed before that rule and
are **not** removed here — they look like intentional prebuilt libjxl reference
tools (cjxl/djxl/benchmark_xl/…), not scratch, and the global rule is "don't
delete tracked meaningful files." **Decision:** keep tracked, or untrack (they're
~large) and document a rebuild path?
# Wave-2 — Deferred questions (user judgment calls)

Items an autonomous session flagged rather than deciding. Each has options + a recommended default;
where a reversible default was taken, it is marked. Challenge/revert freely.

## S1 — raw-pipeline fork unification

Context: `docs/S1-G1-report.md` (G1 trial complete; canonical crate is a −6 %, parity-clean,
compile-verified superset of the vendored fork and of nearly every holo win). These are the
per-item decisions that block G2 or that change user-visible output.

### S1-Q1 — Adopt canonical's tone rendering as the app ingest? (report §4 / §8-A)
- **Fact:** canonical `PipelineParams::default_olympus()` runs a richer tone chain (tone matrix +
  saturation/vibrance + unsharp LUT) absent from the old fork → images differ visually (more accurate
  colour), tone stage +40 % (pipeline still −6 % end-to-end).
- **Options:** (a) adopt canonical tone as ingest after a one-time visual sign-off *(recommended)*;
  (b) keep old-fork tone semantics behind a flag for a transition period; (c) block cutover until a
  per-camera golden set is approved.
- **Default taken:** none applied — this is the one behaviour delta that must not be adopted silently.
  Matches STRATEGIC-MAP open decision #2 (behaviour-reconciliation policy).

### S1-Q2 — Demosaic colour/quality holo items (report §6.3 / §8-B)
- **Fact:** three MISSING holo changes alter decoded pixels: CFA-aware bilinear borders (1 px ring);
  **symmetric MHC B-at-R correction (~25 % of pixels, frame-wide colour shift)**; `MhcKernel::Canonical`
  (Malvar) opt-in variant. Canonical is deliberately asymmetric/clamped today. The wasm-SIMD128 MHC
  perf win is baked onto the symmetric formula, so it cannot be adopted byte-exact without either the
  colour change or a re-derivation against canonical's asymmetric kernel.
- **Options:** (a) route all three through **S5 (scene-referred colour)** with golden-image sign-off
  *(recommended — the user is strict on colour parity)*; (b) adopt as canonical behaviour now (they are
  arguably more correct); (c) keep canonical as-is and only re-derive the wasm-MHC perf against the
  asymmetric kernel (perf without colour change).
- **Default taken:** none — not ported. Deferred to S5.

### S1-Q3 — Identity-downscale black-frame fix (report §6.4 / §8-C)
- **Fact:** canonical's exact-factor downscale computes reciprocal `(1<<64)/1 = 0` for an identity
  resize → **black output**. The holo `sw==dw && sh==dh → copy_from_slice` guard fixes it but changes
  the identity-case pixels (black → correct).
- **Options:** (a) port the guard after confirming reachability from live call sites *(recommended — if
  callers guarantee `dw<sw` the bug is dormant and the guard is harmless belt-and-braces)*; (b) leave as
  a documented latent bug; (c) fix by special-casing `n_px==1` in the reciprocal path instead.
- **Default taken:** none — not ported (output-changing; strict-parity mandate). Written up as a G2 task.

### S1-Q4 — G2 destructive steps (report §7)
- **Fact:** vendored-copy deletion, GPL `jpegxl-rs`/`jpegxl-sys` removal, and dependency packaging are
  all G2 and mostly live in the **app repo** (out of this worktree).
- **Options / recommendation:** proceed with G2 in the report's order — packaging (git-dep + tag pin) →
  `.cargo/config.toml` (`target-cpu=native`) → app builds green → vendored deletion (keep a revert tag)
  → GPL removal (migrate `encode_rgba16_jxl` + pyramid client to the BSD `jxl_casaencoder` shims) →
  freeze rule. ~4–6 engineer-days excluding user-gated colour work.
- **Default taken:** none — G2 is a separate user-approved handoff; not started.
# Wave-2 — Deferred questions (user judgment calls)

Autonomous overnight runs park user-only decisions here instead of blocking.
Each item: context → options → **recommended default**. David can override any.

---

## S5 — Scene-referred colour core

Stage 1 (typed `ColorMatrix` + `ColourPolicy` owner + `wb_from_camera`) landed
byte-neutral on `s5/wave2-overnight` (commits `7cad3600`, `404de84c`, `5a37869d`;
proof in `docs/HANDOFF-S5-colour-core-2026-07-06.md`). The questions below gate the
*output-changing* stages 2–4.

### S5-Q1 — Golden-approval workflow (BLOCKS stage 3)
Strategic-map open decision #4. Intentional colour shifts need a sign-off process.
- **Options:** (a) checked-in golden PNG corpus + per-image human diff review on a
  named viewer; (b) numeric gate (ΔE/butteraugli threshold) auto-approved under a
  bound, human review above; (c) both — numeric gate as tripwire, human on trips.
- **Recommended default:** (c). Viewer = the shipping web lightbox at fixed slider
  defaults (matches what users see). Define the corpus from the S4 golden set.
- **Owner to name:** who is the colour authority (David?) for sign-off.

### S5-Q2 — Re-enable CR2 per-model matrices (stage 2)
`cr2::canon_cam_xyz` returns `None` on purpose: the WB-first pipeline applies WB
gain *before* the matrix, so raw XYZ→cam matrices channel-collapse (e.g. G→0 on the
550D). Proper fix needs scene-relative WB from the matrix's implied D65 neutral
(cr2.rs:300 note).
- **Options:** (a) ship linear-16 mode first (additive, opt-in), leave CR2 matrices
  disabled until the WB-normalization is designed; (b) do the WB-normalization
  rework and re-enable CR2 matrices together in stage 2.
- **Recommended default:** (a). Linear-16 is additive and unblocks photogrammetry/ML
  without touching default CR2 colour. Re-enable is a separate, golden-gated PR.
- Hook ready: `ColourPolicy::resolve(embedded, per_make)` — pass the Canon table as
  `per_make` when re-enabling.

### S5-Q3 — Consume `wb_from_camera` (output-changing)
The flag is surfaced but unread. Most valuable use: when `false` on CR2 (2.0/1.7
fallback fired), fall back to gray-world instead of the magic constants.
- **Options:** (a) leave unread (metadata only); (b) gray-world when
  `!wb_from_camera`; (c) expose in the WASM `*_meta` result so the UI can warn.
- **Recommended default:** (a) tonight (done). (c) is low-risk next (informational).
  (b) is output-changing → stage-2/golden-gated.

### S5-Q4 — Headroom-aware clamp deferral (stage 3)
Moving the pre-LUT [0,1] clamp past matrix+highlight stages changes highlight
rendering on *every* image (the most visible stage-4 item).
- **Options:** (a) keep current clamp until S5-Q1 workflow exists; (b) prototype
  behind a default-OFF flag and A/B on the golden corpus; (c) adopt as the new
  reference pipeline after sign-off.
- **Recommended default:** (a) now → (b) once the workflow lands → (c) on approval.

### S5-Q5 — Home for the colour types
`ColorMatrix` / `ColourPolicy` currently live in `pipeline.rs` (next to
`CAM_TO_SRGB`, cohesive, lowest-churn). Strategic map frames S5 as a "colour core".
- **Options:** (a) keep in `pipeline.rs`; (b) extract a `colour.rs` module owning
  `ColorMatrix`, `ColourPolicy`, `CAM_TO_SRGB`, `IDENTITY_3X3`, and (stage 2) the
  `RawImageMeta` colour/level fields.
- **Recommended default:** (a) for now; do (b) when stage 2 adds linear-mode +
  black/white/iso/bits types (natural moment to carve out the module).
# Wave-2 — Deferred Questions (user judgment calls)

Created by the S6 overnight run (2026-07-06/07). Each item lists options + a recommended
default so David can accept the default or redirect in the morning. Nothing here blocked
implementation; the landed work uses the recommended defaults where a choice was forced.

## S6 — LOD/ROI unification

### S6-1. CASV v2 encoder/decoder wiring (rider P3)

The pure container format + reader/writer landed (`crates/raw-pipeline/src/casv_container.rs`,
tested). Wiring it into the actual video encode/decode (`casa_video.rs`) was NOT done because
that module is gated behind `jxl-codec` (libjxl), and this run must not trigger a libjxl build.

- **Options.** (a) Wire v2 as an opt-in path in `casa_video.rs`, keeping v1 the default
  writer until callers migrate. (b) Also add a v2 *footer/streaming* variant (v1 has both a
  header format and a footer format — see `CASV_FOOTER_MAGIC`) so streaming encodes get u64
  offsets too. (c) Leave v1 as the only writer indefinitely and treat v2 as
  format-reserved.
- **Recommended default.** (a) + (b): v2 opt-in behind a `CasaVideoOptions` flag, header AND
  footer variants, v1 remains default until a >4-GiB / >256-MiB-frame case appears. When
  wiring lands, **promote the `CASV2_*` constants into `casv-format.json` + the casv-web
  constants** (keep the K6#3 single-source-of-truth invariant; the existing parity test's
  `== 15` key count and the casv-web mirror must be updated together).

### S6-2. WASM `#[wasm_bindgen]` surface for `process_region`

The verified core (`pipeline::process_region`) is in the raw-pipeline crate. A browser/AR
consumer needs a `#[wasm_bindgen]` wrapper in the (large) `src/lib.rs` returning
`{ width, height, rgb8 }`.

- **Options.** (a) Add the thin wrapper now (mirrors `process_orf_with_flags`). (b) Defer
  until an actual JS caller exists.
- **Recommended default.** (a) — it is a ~15-line additive export; kept out of tonight's
  run only because building/verifying the wasm crate is heavier and the task said land only
  what is verified. Low risk; do it next session with a `wasm-pack build` smoke check.

### S6-3. Haloed spatial ROI (texture/clarity across tile edges)

`process_region` covers the **per-pixel** tone/colour stage exactly. The spatial unsharp
(`texture` σ=1 / `clarity` σ=3) is a separate pre-pass with a neighbourhood, so a sub-rect
that wants sharpening needs a haloed input.

- **Options.** (a) Add a rect variant of `stream_band` (which already carries an 8-row
  spatial halo) to feed `process_region` a haloed crop, then trim. (b) Document that ROI
  export runs with unsharp disabled (sharpening applied full-frame only).
- **Recommended default.** (a) when ROI export needs sharpening; the halo math already
  exists in `stream_band.rs` — generalize its row-halo to a rect-halo. Until then (b).

### S6-4. Producers must EMIT the new v2 manifest fields

Readers tolerate their absence, but the resolver's resolution-over-progressive path and any
capability-driven UI only light up once producers WRITE per-tier `pixelWidth`/`pixelHeight`
and `capabilities`.

- **Options.** (a) Emit per-tier intrinsic dims from the K2 encoder pass (it knows each
  progressive pass's resolution) + set `capabilities` at ingest. (b) Backfill via a
  migration tool over existing manifests. (c) Leave producers on v1 and rely on the
  resolver's default-fill.
- **Recommended default.** (a) for new assets (cheap — the encoder already has the numbers),
  (c) for old assets (default-fill is safe). No blanket migration.

### S6-5. Where should the unified resolver live long-term?

It currently lives in `@casabio/jxl-progressive` (`lod-resolver.ts`) as a dependency-free,
structurally-typed module so it runs under `node --test` and does not couple the packages.

- **Options.** (a) Keep it in jxl-progressive. (b) Extract to a new `@casabio/lod-resolver`
  package once a second consumer (grid, AR, ML) imports it.
- **Recommended default.** (a) now; (b) at the second consumer. Extraction is mechanical
  (no jxl-progressive imports to sever).

### S6-6. `quality` numeric semantics in the resolver

`resolveLod({ quality: 0.5 })` currently means "the smallest tier covering ≥ 50% of the full
byte budget."

- **Options.** (a) fraction-of-bytes (current). (b) fraction-of-tier-index (0.5 = middle
  tier). (c) map a number to a Butteraugli target via the tier `score`s.
- **Recommended default.** (a) — intuitive ("at least X% of the data"), monotone, and needs
  no per-tier scores. (c) is the richer future option once every tier carries a `score`.
# Wave-2 — Deferred Questions (for David)

User-only judgment calls surfaced during autonomous Wave-2 implementation. Each
has options + a recommended default so nothing blocked overnight; revert/redecide
in the morning.

---

## S3 — Memory-governed asset store

### S3-Q1 — peepCache LRU: keep count-cap or switch to a real byte budget?
The decoded-RGBA LRU was migrated to `AssetStore` **behavior-preservingly**:
`size = 1` per entry + `maxBytes = 24` reproduces the exact old count cap. A real
byte budget (e.g. 512 MB) would be a strict improvement (a 24 MP variant is
~96 MB, so 24 full-res variants is theoretically ~2.3 GB) but changes eviction
timing → possible extra re-decodes I could not measure in-browser.
- **Options**: (a) keep count-cap 24 [current]; (b) switch to a byte budget —
  one-line `maxBytes` change once a target is chosen; (c) hybrid (byte budget +
  a min-entry floor so at least the current photo's ladder stays hot).
- **Recommended default**: (a) now; move to (b) with `maxBytes ≈ 384 MB` after a
  scripted peep session under `performance.memory` / flipflopMem confirms the
  re-decode rate stays acceptable.

### S3-Q2 — Should the file-picker + peep imports point at `src/` or a built `dist/`?
`@casabio/asset-store` is plain ESM (no build), so `web/` imports
`../packages/asset-store/src/index.js`. Every other web/ package import targets
`dist/`. Functionally identical here (source *is* the distributable), but it's a
convention wrinkle.
- **Options**: (a) keep `src/` [current, zero build]; (b) add a trivial
  `tsc`/copy build so it ships a `dist/` like its siblings; (c) rename `src/` →
  `dist/` to match by convention.
- **Recommended default**: (a). Revisit if/when asset-store gains TS-checked
  internals.

### S3-Q3 — Wire `estimate_decode_peak` into a real admission gate now?
The WASM export exists and is verified, but nothing calls it yet. Wiring it into
the worker/scheduler decode-admission path (and replacing the arbitrary 1 GiB
`MAX_OUTPUT_BYTES_GUARD` with `peak_bytes × safety`) is output-visible policy
(could start *refusing* decodes it used to accept).
- **Options**: (a) land the export only, wire later [current]; (b) wire it as a
  soft signal (log-only, no refusal) to gather traces first; (c) wire it as a
  hard gate with a generous multiplier (≥1.5×).
- **Recommended default**: (b) — instrument first, then (c) once the model-vs-RSS
  multiplier is measured on this machine.

### S3-Q4 — Per-session decode-memory governor: which layer owns it?
Designed in the handoff, **not implemented** (touches the sensitive
scheduler/worker backpressure boundary; CLAUDE.md forbids drain/backpressure in
facade/session). Capping *concurrent retained decoded frames* is a new axis
alongside the scheduler's existing in-flight-**bytes** HWM.
- **Options**: (a) extend the scheduler's HWM to also count retained decoded
  pixels (one governor, right layer); (b) a standalone `RetainedFrameGovernor`
  the scheduler consults; (c) leave to `AssetStore` on the main thread governing
  decoded outputs after they cross back from workers.
- **Recommended default**: (a) — it is the same layer the byte-HWM already lives
  in; (c) is the cheapest first step (no worker-protocol change) and is a good
  interim. Do **not** put it in facade/session.

### S3-Q5 — Should `AssetStore` drive `jxl-cache` as its OPFS L2 now?
`AssetStore.PersistentBackend` is structurally satisfied by `JxlCacheBrowser`
(`get`/`set`/`delete`/`has`), so an adapter is ~10 lines. Not wired — jxl-cache
is currently constructed and used directly by the session/scheduler layers, and
routing it under AssetStore is a larger, verify-in-browser change.
- **Options**: (a) leave jxl-cache as-is, AssetStore governs only the in-memory
  clients [current]; (b) add the adapter and let AssetStore write-through to
  jxl-cache for content-addressed assets; (c) full unification (all OPFS traffic
  through AssetStore).
- **Recommended default**: (a) now; (b) when the pyramid-level byte cache is
  migrated (that's the natural first OPFS-backed client).

---
*(S1/S2/S4/S5/S6 sections appended by their respective overnight runs.)*
