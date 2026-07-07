# HANDOFF — CR2 colour correctness (2026-07-07)

**Surfaced during** the S3 browser measurement session (dropping real CR2s into the
viewer): CR2 thumbnails start white (embedded preview, too bright — same as DNG),
then the RAW-decoded image renders **black+green** on some bodies, **purple/pink**
on others. Diagnosed natively (current source) — NOT introduced by S3.

## How it was diagnosed

`cargo test --no-default-features --features parallel --test cr2_color_diag --
--nocapture` — a temp test (removed after this writeup; code below) that decodes
the real corpus `C:\Foo\raw-converter\tests\*.CR2` with `raw_pipeline::cr2::decode_bytes`
+ `demosaic::demosaic_bayer_mhc`, and dumps metadata + channel means through the
WB-first → matrix pipeline order.

## Findings — 4 stacked issues, two bodies

### Canon EOS M5 (`ADH*.CR2`)
- **`wb_from_camera = false` on every M5 file** → the Canon MakerNote ColorData
  (`0x4001`) WB parse FAILED → fell back to the hardcoded `wb_r=2.0 / wb_g=1.0 /
  wb_b=1.7`. **Concrete fixable bug**: the M5 ColorData version/offset layout is
  not handled (`cr2.rs`, the 0x4001 reader).
- **Black-clamp → pure black frames.** black=2048, white=15300. 5 of 7 M5 frames
  have demosaic mean **below** 2048 (e.g. ADH 1248 R=1293/G=1553/B=1113) → the
  black-subtract clamps to `0,0,0`. Brighter ISO640/800 frames (mean > 2048)
  decode fine (ADH 1234 → R/G≈1.37). → **black level 2048 too high for the M5, or
  the LJPEG output is not scaled to full 14-bit** (a bit-depth/shift issue — 5
  daylight frames should not all be sub-black). Verify the M5 raw value range and
  the per-model black level.

### Canon EOS Kiss X4 / 550D (`_MG*.CR2`)
- **`wb_from_camera = true`** → WB parses fine (wb_r 2.05–2.19, wb_b 1.63–1.75).
  Not a WB bug.
- **Green sits low → magenta/pink.** `G−black ≈ ½·(R−black)`, so after WB:
  `R=1531 G=333 B=1262` → R/G=4.6, B/G=3.8 → green crushed → magenta. After the
  generic matrix: R/G≈1.6, B/G≈2.0 → pink cast. Likely a **CFA-phase / black-level
  interaction** (green sites reading low). The green-collapse guard in
  `src/lib.rs` (`mean_g < max(R,B)/8`) is **too lax** to catch moderate magenta —
  green here is ~1/4, not <1/8.

### Both bodies
- **Generic colour matrix only.** `cr2.rs canon_cam_xyz(_model)` returns `None`
  for every model (the `model` arg is unused), so all Canon bodies fall through to
  the generic `CANON_CAM_TO_SRGB`. This is the **documented deferral** at
  `cr2.rs:304–311`: adobe_coeff XYZ→cam matrices break the WB-first pipeline
  (channel collapse), so per-model matrices were disabled pending "scene-relative
  WB correction derived from the matrix's implied D65 neutral."

## Recommended fix path (dedicated — do NOT hack under wrap-up)

Ordered by value/risk:
1. **M5 WB parse (0x4001 ColorData).** Add the M5 ColorData version/offset so
   `wb_from_camera=true`. Cross-ref dcraw/LibRaw `Canon` ColorData tables. Low
   risk (only affects the currently-broken fallback path). Gate: `wb_from_camera`
   flips true + wb_r/wb_b land near the 550D range.
2. **M5 black level / raw scaling.** Confirm whether M5 raw is full-14-bit and
   black=2048 is correct, or values need a shift. This is what makes M5 frames go
   black. Gate: normal daylight M5 frame's demosaic mean > black.
3. **550D green-low magenta.** Determine whether it's CFA phase (try the 4 phases,
   compare green balance) or black-level; tighten the lib.rs green-guard threshold
   and/or make it two-sided (also catch R/B collapse — the "black+green" case is
   the mirror the current guard ignores).
4. **Per-model matrices (the cr2.rs:304 deferral).** The real colour-accuracy
   work: proper scene-relative WB from the matrix's D65 neutral so adobe_coeff
   matrices can be re-enabled per model. Biggest, do last, needs visual gating.

**Verification:** each fix needs a `web/pkg` **WASM rebuild** + visual check in the
viewer (the shipped pkg is stale — it also predates the lib.rs green guard). Keep a
before/after channel-mean table per body. Butteraugli/ΔE gating against a known-good
developer (RawTherapee/dcraw) on the corpus is the objective oracle.

## Reproduction test (removed from tree; paste back to re-run)

Was `crates/raw-pipeline/tests/cr2_color_diag.rs` — decodes every
`C:\Foo\raw-converter\tests\*.CR2`, prints make/model/black/white/wb_r/g/b/
wb_from_camera/cfa_phase/matrix + demosaic means through black→WB→matrix. Skips
cleanly if the corpus dir is absent. (Full source in the S3 session transcript.)
