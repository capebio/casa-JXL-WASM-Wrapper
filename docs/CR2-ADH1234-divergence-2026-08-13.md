# CR2 `ADH 1234` colour divergence — metadata cleared, cause is downstream (2026-08-13)

Open. Not a regression: predates the lens-2 merge and the WB-scaled MHC gains work.
Recorded so the next person does not re-derive the two checks that are already done.

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

Not fixed here: correcting it changes the colour of every CR2 render, so it wants the
embedded-JPEG census over the full Canon corpus (the method used in
`examples/cr2_gains_census.rs`), not a change validated by one file. Check
`cr2.rs`'s matrix resolver ("Finding 52": per-model table plus Canon-generic fallback) and
whether the consumer expects sRGB.

`ADH 1570.CR2` is a second high-ISO sample if another tungsten case is wanted; it was not
in the 4-file slice above.

## Reproduce

```
ONLY=cr2 LIMIT=4 node tools/colour-verify-corpus.mjs      # verdicts
META=1 ONLY="ADH 1234" node tools/colour-verify-corpus.mjs # cam_mul / black / ISO
node tools/cr2-colour-diagnose.mjs                          # our parse + embedded-JPEG stats
```
