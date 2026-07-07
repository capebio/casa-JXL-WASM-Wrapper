# HANDOFF — S5: Scene-referred colour core (stage 1)

**Branch:** `s5/wave2-overnight`  worktree `C:\Foo\rcw-s5` (isolated; not pushed)
**Author:** overnight autonomous run (Opus 4.8)  **Landed:** 2026-07-07
**Scope contract:** BEHAVIOUR-NEUTRAL structural refactor ONLY. Nothing in this
handoff changes default output pixels. Every output-changing stage is written up
below for David's per-stage golden sign-off (S5 gate: user is strict on colour
parity).

---

## Goal

S5 (strategic map §S5) turns scattered, owner-less colour policy into a
scene-referred colour core. The colour code had three specific smells this stage
targets:

1. `PipelineParams.color_matrix: Option<[[f32;3];3]>` **conflated three states** —
   *absent* (→ generic-Olympus fallback), an *explicit camera matrix*, and
   *identity / no-transform* (which the `Option` could only smuggle as
   `Some(identity)` and never distinguish from a real matrix).
2. Matrix precedence (embedded → per-make → `CAM_TO_SRGB`) had **no single owner**;
   it was split across `dng::choose_camera_to_srgb_matrix`,
   `cr2::canon_color_matrix`, and a bare `.unwrap_or(CAM_TO_SRGB)` at ~10 call sites.
3. The WB fallback (ORF 1.0, DNG 1.0, **CR2 2.0/1.7**) fired **with no caller
   signal** — a consumer couldn't tell camera-provided WB from the hardcoded default.

Stage 1 (this handoff) fixes 1–3 **byte-neutrally**. Stages 2–4 (below) are the
output-changing evolutions and are NOT applied.

---

## Landed (byte-neutral) + PROOF

### 1. Typed `ColorMatrix` + `ColourPolicy` owner  (commits `7cad3600`, `404de84c`)

New in `crates/raw-pipeline/src/pipeline.rs` (next to `CAM_TO_SRGB`):

```rust
pub const IDENTITY_3X3: [[f32;3];3] = [[1,0,0],[0,1,0],[0,0,1]];

pub enum ColorMatrix { Identity, Camera([[f32;3];3]), GenericOlympus }
impl ColorMatrix {
    fn as_matrix(&self) -> &[[f32;3];3]   // == old .as_ref().unwrap_or(&CAM_TO_SRGB)
    fn matrix(&self)    -> [[f32;3];3]    // == old .unwrap_or(CAM_TO_SRGB)
    fn to_option(&self) -> Option<..>     // bridge for is_some() / non-CAM fallbacks
    fn from_option(Option<..>) -> Self    // None->GenericOlympus, Some(m)->Camera(m)
}
// + Default (GenericOlympus), From<Option<..>>, From<[[f32;3];3]>

pub struct ColourPolicy;                  // THE owner
impl ColourPolicy {
    fn resolve(embedded: Option<..>, per_make: Option<..>) -> ColorMatrix
      // precedence: embedded -> per_make -> GenericOlympus
}
```

`PipelineParams.color_matrix` changed `Option<[[f32;3];3]>` → `ColorMatrix`
(default `GenericOlympus`, was `None`).

**Why it is byte-identical (by construction):**
| old | new | resolves to |
|---|---|---|
| `None` | `GenericOlympus` | `CAM_TO_SRGB` |
| `Some(m)` | `Camera(m)` | `m` |
| `Some(identity)` | `Identity` | `IDENTITY_3X3` (same literal) |
| `.unwrap_or(CAM_TO_SRGB)` | `.matrix()` | identical |
| `.as_ref().unwrap_or(&CAM_TO_SRGB)` | `.as_matrix()` | identical `&` |
| `.unwrap_or(CANON_CAM_TO_SRGB)` | `.to_option().unwrap_or(CANON_CAM_TO_SRGB)` | identical |
| `.is_some()` | `.to_option().is_some()` | identical |

Migrated: 9 consumption sites in `pipeline.rs`; assignments in `stream_band.rs`,
`raw_video.rs`; all consumers (`src/lib.rs`, `src/bin/raw_decode_bench.rs`,
13 examples, `tests/dng_stream.rs`) via mechanical `.into()` / `.to_option()`.
`ColourPolicy::resolve` is the documented owner; at every current call site the
per-format extraction still folds embedded-or-per-make into one `Option`, so the
runtime result is unchanged (per_make is `None` until stage 2).

New unit tests: `pipeline::colour_policy_tests` (5) lock the legacy-equivalence
contract (matrix parity, to_option round-trip, identity literal, precedence,
default).

### 2. `wb_from_camera: bool` surfaced  (commit — see git log)

Added an informational `wb_from_camera` to `RawImageMeta` (+ `DngImage`,
`Cr2Image`), populated from the existing per-format signal, with **zero change to
WB math** (the 2.0/1.7 CR2 constants and 1.0 ORF/DNG fallbacks are numerically
untouched):

* ORF (`OrfInfo::meta`): `wb_r.is_some() && wb_b.is_some()`.
* DNG (`DngImage`): `state.as_shot_neutral.is_some()`.
* CR2 (`Cr2Image`): `true` iff MakerNote 0x4001 (WB_RGGBLevels) was extracted;
  `false` = the 2.0/1.7 fallback fired.

### PROOF (mandatory hash A/B gate)

Harness: `cargo test --release --no-default-features --features parallel,image-formats
--lib --test parity_corpus` with `RUSTFLAGS=-C target-cpu=native`, run from
`crates/raw-pipeline` (no libjxl — the colour/pipeline/parser paths are pure Rust).
Real fixtures present (ORF `C:\Foo\raw-converter\tests\P1110226.ORF`, DNG
`C:\Foo\raw-converter-wasm\.timing-source\PXL_...ORIGINAL.dng`).

| | expected (S1 report) | baseline (pre-change) | after stage 1 |
|---|---|---|---|
| ORF rgba8 | `0x8806822277eac608` | `0x8806822277eac608` | `0x8806822277eac608` ✓ |
| DNG rgb8  | `0x3c3fb14139efec5c` | `0x3c3fb14139efec5c` | `0x3c3fb14139efec5c` ✓ |

Hashes **UNCHANGED** ⇒ refactor is byte-neutral on both real files.
`lib` 212 passed / 0 failed (incl. 5 new colour tests); `parity_corpus` 6/6.
Root WASM entry verified: `cargo check --target wasm32-unknown-unknown --lib` passes.

---

## STOP — sign-off-gated stages (written up, NOT applied)

Each stage below changes default output pixels and therefore needs an explicit
golden-image approval from David before it lands. Order matches strategic-map §S5.
The refactor above was designed to make each one a *small, local* change.

### Stage 2 — Calibrated scene-referred (linear-16) mode  (ADR-3)
* **Change:** `RawImageMeta` carries `black/white/iso/bits`; add a "linear, not
  tone-mapped" decode mode; **re-enable CR2 per-model matrices**
  (`cr2::canon_cam_xyz` currently returns `None` on purpose — WB-first pipeline
  channel-collapses on raw XYZ→cam matrices; see cr2.rs:300 note).
* **Output impact:** re-enabling per-model matrices changes CR2 colour; linear
  mode is a new path (opt-in) but the scene-referred contract must be signed off.
* **Golden approval:** per-camera ground-truth for level/matrix on a CR2 corpus;
  linear-16 output validated against a reference (dcraw/rawpy) neutral.
* **Hook already in place:** `ColourPolicy::resolve(embedded, per_make)` — thread
  the Canon table result as `per_make` instead of pre-folding it to `None`.

### Stage 3 — Headroom-aware clamp deferral
* **Change:** move the pre-LUT `[0,1]` clamp past the matrix + highlight stages so
  highlight headroom survives into tone-mapping (reference-pipeline evolution).
* **Output impact:** **changes highlight rendering on every image** — the most
  visible of the four. Deliberate.
* **Golden approval:** REQUIRED, whole-corpus. Define the approval viewer first
  (open decision — see QUESTIONS §S5).

### Stage 4 — Perceptual-constancy wiring (ADR-8) + EXR HDR through the engine
* **Change:** add the missing `LookOverrides` field to wire the existing
  perceptual-constancy engine; route EXR HDR through the engine and tone-map last
  (today EXR is clamped before the constancy engine).
* **Output impact:** changes perceptual-mode + HDR output.
* **Golden approval:** HDR/constancy reference set; likely a new metric contract
  (Comparer currently assumes 8-bit — needs a documented range contract).

---

## Verification (commands + results)

```
# from crates/raw-pipeline, RUSTFLAGS=-C target-cpu=native
cargo test --release --no-default-features --features parallel,image-formats \
      --lib --test parity_corpus -- --nocapture
# => lib 212 passed / 0 failed ; parity_corpus 6/6 ; hashes unchanged (see table)

# from repo root (root WASM entry, no libjxl)
cargo check --target wasm32-unknown-unknown --lib          # => Finished (ok)
```

**Not run (would trigger a libjxl build — out of scope/disk tonight):**
native root bins (`raw_decode_bench`), the 13 `jxl-codec` examples, and the
`dng_stream` / `cross_encoder` integration tests. Their edits are the *same*
mechanical `.into()` / `.to_option()` transform, but are **build-unverified**.
The `raw_decode_bench` bin is native-only and already fails a *wasm* check
(pre-existing: it imports `jxl_casaencoder`, gated off on wasm) — unrelated to S5.

---

## Remaining / NEXT

1. **Verify the libjxl-gated targets** once a libjxl build is cheap: `cargo build
   --examples` and `cargo test` (native, `--features jxl-codec`) on this branch —
   expect only mechanical fixes if anything.
2. **Consume `wb_from_camera`**: nothing reads it yet. Natural first consumer is a
   gray-world fallback decision (CR2 2.0/1.7 is a poor default) and the WASM
   `*_meta` exports — but any behaviour off this flag is output-changing → gate it.
3. **Stages 2–4** above, each behind its own golden-approval PR.
4. Optional cleanup: `ColourPolicy` could also own the DNG
   `choose_camera_to_srgb_matrix` folding, but that is byte-sensitive — leave until
   stage 2 threads `per_make` properly.
