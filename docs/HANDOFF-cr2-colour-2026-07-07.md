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

## UPDATE 2026-07-07 — deeper diagnosis + first fix LANDED

Native probes (temp `tests/cr2_color_diag.rs` + env-gated dumps in `cr2.rs`, both
removed) refined the four issues to exact mechanisms:

- **550D magenta = WRONG CFA PHASE. ✅ FIXED.** 4-phase demosaic proved the 550D's
  greens sit on the MAIN diagonal (the two corner sites read *exactly equal* —
  they are the greens), but `choose_crop_origin` derived RGGB `(0,0)` (greens on
  the anti-diagonal) → green↔R/B swap → magenta. Fix: `refine_cfa_phase_by_green`
  in `cr2.rs` — data-driven, scene-independent (greens are the more-equal
  diagonal), flips the phase when the derived one disagrees; no-op otherwise.
  Verified: 550D `(0,0)→(0,1)`, green now highest, cast R/G≈1.0 B/G≈0.8 (was
  R/G≈1.6 B/G≈2.0); **M5 stays `(0,0)`**; all 22 `cr2` tests + 2 new unit tests
  pass. Applied to the **batch** path (`Cr2Image`, what the browser CR2 decode
  uses). *Streaming `Cr2RowSource` not yet corrected* (uncropped/stacked raw makes
  green-detect crop-aware; CR2 card decode is batch so browser is covered).
- **M5 WB = `0x4001` is `dtype=7` (UNDEFINED byte blob, 5120 B), code only accepts
  `dtype==3` (SHORT).** So the M5 ColorData is skipped → `wb_from_camera=false` →
  2.0/1.7 fallback. Within the M5 blob, **short-offset 71 holds the AsShot WB**
  (only per-file-*varying* candidate: r≈1331–1576 / g=1024 / b≈1306–1540 → ~1.3–1.5×;
  offsets 95/103 are constant = presets). The `version` word reads garbage at the
  naïve base, so **the exact offset needs an exiftool/dcraw Canon-ColorData
  cross-check before shipping** — not guessed. NOT yet fixed.
- **M5 "black" frames = exposure, not (only) a bug.** Bright M5 frames have RAW
  `min≈2010≈2048` (black level right); the dark ADH frames have low means
  (mostly-shadow forest floor) so black-subtract crushes them — compounded by the
  wrong fallback WB giving a green cast. Fixing the M5 WB is the real lever.
- **Generic matrix** — unchanged (documented deferral, below).

## UPDATE 2 (2026-07-07 pm) — reference obtained; matrix/tone need full-pipeline validation

**Reference render captured** (user-supplied, correct): `_MG_1747 small 1080.jpg`
(Canon 550D) → mean **R/G=0.935, B/G=0.910** (near-neutral, faintly green — right
for foliage). User confirms the CR2 sequence: embedded preview **correct** → RAW
decode goes **yellow** → final.

- **CR2 residual yellow = generic colour matrix.** After the phase fix, our
  pre-tone means are R/G≈1.02, B/G≈0.88 → **red ~8% high, blue ~8% low = yellow**
  vs the reference. The lever is the per-model matrix (the deferral).
- **Attempted + REVERTED: enable the 550D adobe_coeff matrix + row-normalise.**
  Result was inconsistent (R/G swung 0.67–3.2 across near-identical shots, B/G
  still low). Two reasons it can't be validated this way: (1) comparing our
  *pre-tone* channel means to the reference's *post-tone* means is not
  apples-to-apples — the tone curve reshapes ratios; (2) the matrix amplifies
  scene variance. **The colour-accuracy fix needs the FULL pipeline (incl. the
  wasm `src/lib.rs` tone stage) run against the reference** — make the tone stage
  native-testable, or build a wasm node harness, so WB+matrix can be tuned
  end-to-end with the reference as the oracle. Do NOT ship a matrix by pre-tone
  eyeballing.

**DNG "too bright" = the TONE/EXPOSURE stage, not the decode.** Native decode
params are sane: `black=0` (Pixel HDR+ pre-subtracts — correct), `white≈15340`,
WB≈2.0/1.0/1.8 (from AsShotNeutral), ColorMatrix present; raw linear-mean is only
0.04–0.09 (dark), naïve sRGB(mean)≈56–84/255. So the brightness is added in the
wasm tone/exposure stage (baseline-exposure / curve), a separate item from the
decode. Same "make tone native-testable" unblocks tuning it.

**DNG has no fast embedded preview (latent gap).** Pixel DNG's display JPEG (IFD0,
`Compression=7`, 1280×964) sits at **4.73 MB — past the 3 MB `PREVIEW_SLICE`** →
Phase A finds no JPEG → the card shows the (too-bright) RAW decode instead of a
correct fast preview. A TIFF-aware `findTiffJpegPreview` (walk IFD0+SubIFDs, pick
the strip-based — not tiled — JPEG, read exactly its bytes) works in testing
(returns offset 4956026 / 1280×964) but is **not wired**. Wiring it as a fallback
when the 3 MB scan yields nothing would give DNGs a correct instant preview
(and mask the too-bright decode until tone is fixed). CR2/ORF unaffected.

## UPDATE 3 (2026-07-07, viewed actual output) — it's EXPOSURE + R/B, not a matrix cast

Viewing the user's screenshots vs the reference (`_MG_1747 small 1080.jpg`, a
bright landscape: blue sky, green lily pads) reframed everything:

- **The dominant bug is GROSS OVEREXPOSURE.** `pipeline.rs:320`
  **`BASELINE_EXP_EV = 1.40`** — an always-on **+1.40 EV (2.64×)** gain added to
  *every* decode (`exp_gain = 2^(exposure_ev + BASELINE_EXP_EV)`, line 1853),
  "tuned to embedded JPEG luminance" = tuned for **Olympus ORF** (which needs the
  boost). Applied to already-well-exposed **Canon CR2 + Pixel DNG** → blown-out,
  milky, yellow highlights. `BASELINE_SAT=1.40→1.30` and `BASELINE_CONTRAST=0.55`
  are likewise Olympus-tuned always-on. **This is the "too bright" for BOTH CR2
  and DNG.** Fix = make the baseline exposure/sat **format-specific or adaptive**
  (measure the embedded-JPEG luminance per file and match it, which is the stated
  intent) instead of a fixed Olympus constant. Needs validation across
  bright/normal/dark references + a wasm rebuild.
- **Orange sky (final) = R/B phase assignment.** `refine_cfa_phase_by_green`
  (shipped) correctly resolves the GREEN diagonal (magenta→gone) but the R/B
  choice between the two green-correct phases `(0,1)`/`(1,0)` is a coin-flip on
  the near-neutral whole-frame mean — wrong for the 550D → blue sky renders
  orange (green foliage stays correct). Fix = reliable R/B disambiguation: sample
  a region of known hue, use the CFAPattern/SensorInfo metadata correctly, or
  validate against the reference (sky must be blue).
- The earlier "yellow = generic matrix" read was a red herring — the pre-tone
  mean was mildly off, but the VISIBLE damage is the +1.40 EV blow-out.

**Right approach (stop guessing): make the tone/exposure stage native-testable**
(extract `apply_tone`/exposure into a native harness, or a `wasm-pack --target
nodejs` A/B) so exposure + R/B + matrix can be tuned end-to-end against the
reference images as the oracle, WITHOUT a full wasm rebuild per iteration. Only
then ship. (Lesson this session: a per-model matrix eyeballed on pre-tone means
was inconsistent and got reverted.)

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
