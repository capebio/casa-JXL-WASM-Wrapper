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
