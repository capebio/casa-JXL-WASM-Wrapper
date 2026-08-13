# CR2 `ADH 1234` colour divergence — the matrix was camera→XYZ used as camera→sRGB (2026-08-13)

**FIXED for the two bodies in the corpus** (EOS M5, EOS 550D/Kiss X4/Rebel T2i). Bodies
outside the table keep the previous generic fallback and are still affected — see "Not done"
at the end. Not a regression: predates the lens-2 merge and the WB-scaled MHC gains work.

## Symptom

`tools/colour-verify-corpus.mjs` (headless Chromium, real shipped pipeline) on the CR2
corpus:

```
ADH 1234.CR2  DIVERGES ours(1.091,0.9)  lib(1.74,0.918)  jpg(1.637,0.939)  Δours=0.584 Δlib=0.124
ADH 1248.CR2  FAITHFUL ours(1.009,0.853) lib(1.046,0.631) jpg(1.022,0.71)  Δours=0.156 Δlib=0.104
ADH 1455.CR2  FAITHFUL ours(0.989,0.843) lib(0.914,0.588) jpg(0.912,0.65)  Δours=0.27  Δlib=0.064
ADH 1490.CR2  FAITHFUL ours(0.99,1.05)   lib(0.865,1.128) jpg(0.911,1.087) Δours=0.116 Δlib=0.087
```

Our red is far too weak: R/G 1.09 where both LibRaw (1.74) and the camera's own JPEG
(1.64) agree it should be ~1.6-1.7. All four files are the same body (EOS M5).

## What has been ruled out

**White balance is correct.** LibRaw's `cam_mul` for this file is `[1331, 1024, 1537, 1024]`
→ R/G 1.2998, B/G 1.5010. We parse 1.300/1.501 — an exact match. Same for the three
faithful files. Run `META=1 ONLY="ADH 1234" node tools/colour-verify-corpus.mjs` to
reproduce (the META dump now includes levels and ISO).

**Black level is correct.** `ADH 1234` is the only one of the four at high ISO (640 vs
100/100/200) and the only one whose black is 2048 rather than 512. That looks like the
culprit and is not: `cr2.rs::extract_black_from_raw` reads ColorData short 333 precisely
because the M5 black is ISO-dependent (512 at ISO 100, 2048 above), and its doc comment
records that value as verified bit-exact against dcraw's computed darkness on these very
files (ADH 1234/1490/1570). Over-subtraction would push R/G down, which matches the
direction of the error — but the pedestal is right, so that is a coincidence of
direction, not the cause.

## Probable cause: the CR2 matrix looks like camera→XYZ, used as camera→sRGB

Both inputs are correct, so the error is in the matrix. Comparing ours against LibRaw's
`rgb_cam` for this file:

| | row 0 (R out) | row 1 (G out) | row 2 (B out) |
|---|---|---|---|
| LibRaw `rgb_cam` | `2.006, -1.234, 0.228` | `-0.237, 1.801, -0.564` | `-0.016, -0.555, 1.571` |
| ours | `0.459, 0.381, 0.160` | `0.164, 0.772, 0.064` | `0.039, 0.079, 0.882` |

Both have unit row sums, so both preserve grey — which is why this does not show up as a
cast on neutral test material and why the daylight files still pass. But the structure is
different in kind:

- A camera→**sRGB** matrix has large **negative** off-diagonals (LibRaw's does). Those
  negatives are what preserve saturation.
- Ours is **all-positive**. An all-positive row-normalised matrix is a weighted average of
  the channels, so it can only pull them together — it desaturates by construction.

Our row 0 `0.459, 0.381, 0.160` also sits close to the sRGB→XYZ primaries row
(`0.4124, 0.3576, 0.1805`), which is what a camera→XYZ matrix looks like. The reading that
fits every observation: the CR2 path carries a camera→**XYZ** matrix and applies it as if
it were camera→sRGB, i.e. the XYZ→sRGB step is missing or folded in wrongly.

This predicts exactly what we see: saturation is lost on every Canon file, and the damage
is proportional to how far the scene sits from neutral. The daylight frames are mild
(Δours 0.12-0.27, still passing) and the one tungsten frame is severe (Δours 0.58, R/G
1.09 vs 1.64). It also fits `Closer to camera JPEG: ours 0, LibRaw 4` on the CR2 slice
while DNG scores ours 9 / LibRaw 1 — DNG takes its matrix down a different path.

## Confirmed by measurement, and the fix is already half-written

`examples/cr2_matrix_probe.rs` renders each Canon file twice — once with the matrix the
pipeline resolves today, once with the matrix derived dcraw's way from LibRaw's `cam_xyz`
— and scores both against the file's own embedded JPEG (same `|dR/G| + |dB/G|` distance
the browser harness uses):

```
11 files: ours closer on 2, dcraw rgb_cam closer on 9
  mean distance to camera JPEG:  ours 0.183   dcraw rgb_cam 0.045
  ADH 1234 (the diverger):       ours 0.595   dcraw rgb_cam 0.029
```

The two files where ours wins are near-neutral scenes decided by <0.02. So the structural
argument holds numerically: the matrix is the cause, and the correct one is ~4x closer to
what the camera itself produced.

**Where it comes from.** `cr2.rs::resolved_color_matrix` prefers a per-model matrix and
falls back to `CANON_CAM_TO_SRGB`. The per-model path (`canon_color_matrix`) already does
the right derivation — invert the published XYZ->cam, then `XYZ_D50_TO_SRGB` — but it is
**disabled**: `canon_cam_xyz` returns `None` unconditionally, so *every* Canon body gets
the fallback. That fallback is documented as "camera->sRGB (dcraw/LibRaw coefficients)"
but is all-positive, which no camera->sRGB matrix is.

**Why it was deferred, and why that reason no longer blocks.** The disabling comment says
the adobe matrices "assume un-WB-normalised camera values" and that CasaWASM applies WB
before the matrix, so proper use "requires scene-relative WB correction derived from the
matrix's implied D65 neutral — a non-trivial change deferred". dcraw's derivation already
contains that correction: it builds `cam_rgb = cam_xyz . xyz_rgb`, **normalises each row to
unit sum** (that normalisation is literally where dcraw's `pre_mul` comes from, i.e. the
implied neutral), and only then inverts to get `rgb_cam`. A row-normalised-then-inverted
matrix maps camera neutral to sRGB neutral by construction, which is why it composes
correctly with the WB-first pre-LUT — as the numbers above show empirically.

So the deferred "non-trivial change" is: normalise rows before inverting. See
`derive_rgb_cam` in the probe for the exact 20 lines.

## What was implemented

`canon_cam_xyz` now returns per-model coefficients for the two bodies in the corpus, and
`canon_color_matrix` derives the matrix dcraw's way (normalise rows of `cam_xyz · xyz_rgb`
to unit sum, then invert). Re-running the probe with the shipped resolver:

```
11 files: mean distance to camera JPEG 0.183 -> 0.042, closer on 9 of 11
```

The shipped arm and the derived arm are now identical per file, as they should be.

The **EOS 550D is the body the old comment named** as the channel-collapse counterexample
(`G→0 with r_mult≈2.2`). Its files improve 0.260→0.055, 0.106→0.020, 0.131→0.033, and no
channel collapses — the objection is answered on its own evidence, because the row
normalisation supplies exactly the neutral correction it said was missing.

Two things worth knowing for anyone extending the table:

- **One body, several names.** Our decoder reports the raw EXIF model, so the corpus says
  `Canon EOS Kiss X4` where LibRaw says `EOS 550D`. LibRaw normalises; we do not. Each
  regional alias (550D / Kiss X4 / Rebel T2i) needs its own row or the lookup silently
  misses and the body quietly keeps the wrong matrix.
- **The tests now pin the two properties that make it safe**, not the numbers: every row
  sums to 1 (grey stays grey — this is the neutral preservation), and at least one
  off-diagonal is negative (a real camera→sRGB matrix, not an all-positive averaging one).

`src/lib.rs` needed no change: it already routes through `cr2::resolved_color_matrix`, so
finding 52's "byte-identical across the FFI boundary" requirement holds automatically.

## Not done

Canon bodies outside the table still get `CANON_CAM_TO_SRGB`, the all-positive generic, and
so are still desaturated. Fixing them means extending `canon_cam_xyz` with that body's
adobe coefficients — read them out with `META=1 node tools/colour-verify-corpus.mjs`, which
prints LibRaw's `cam_xyz` per file — and re-running `cr2_matrix_probe` on samples from it.
The generic fallback itself is likely the same XYZ-shaped mistake, but no corpus file
exercises it, so it was left alone rather than changed blind.

`ADH 1570.CR2` is a second high-ISO sample if another tungsten case is wanted.

## Reproduce

```
ONLY=cr2 LIMIT=4 node tools/colour-verify-corpus.mjs      # verdicts
META=1 ONLY="ADH 1234" node tools/colour-verify-corpus.mjs # cam_mul / black / ISO
node tools/cr2-colour-diagnose.mjs                          # our parse + embedded-JPEG stats
```
