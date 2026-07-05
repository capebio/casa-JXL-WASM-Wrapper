# Part 3c — True HDR (PQ/HLG, Rec.2020) follow-up

Companion to `2026-07-05-16bit-hdr-codec-pipeline-design.md`. The 16-bit path (2026-07-05) covers
**16-bit SDR** from RAW-derived content: the RAW pipeline's display-referred render (`OUT_FULL_DISP16`
→ `take_rgb16_disp`) at full 16-bit precision, encoded by JXL (`rgba16`) and AVIF (10/12-bit), with
PNG-16 as the lossless anchor, scored by 16-bit PSNR/SSIM and a 16-bit Butteraugli WASM bridge. True
HDR is deferred pending three pieces, none of which the current harness has:

1. **HDR corpus.** Need PQ or HLG, Rec.2020, wider-than-SDR dynamic-range source frames. RAW gives
   bit depth but the display render is SDR-referred (an SDR tone curve is baked in by `process_16bit`).
   Options: curate/capture an HDR test set, or add an HDR-referred tone path (a `process_16bit`
   variant targeting a PQ/HLG transfer + Rec.2020 primaries instead of the SDR look).

2. **Float substrate (already present).** The JXL facade already supports `rgbaf32` encode+decode,
   and the image-format layer can emit f32 (`decode_exr`, or a future `process_f32` RAW variant). So
   the *plumbing* for HDR pixels exists — only the source content and the metric are missing.

3. **HDR-aware metric.** Butteraugli assumes an SDR display transfer (the 16-bit bridge linearises via
   gamma 2.2, matching the 8-bit path). For HDR, either PU21-encode before Butteraugli, tone-map to
   SDR first, or add an `rgbaf32` Butteraugli bridge with a PQ/HLG linearise. PSNR/SSIM must move to the
   PQ/HLG-encoded (or PU) domain to remain perceptually meaningful across the extended range.

When a corpus exists, mirror the 16-bit pass end to end: `loadTargetHdr` (f32 RGBA) → `rgbaf32`
JXL / AVIF-10/12 adapters → PU21/PQ metric → a `sweepHdr` array → `rd-*-hdr.svg` figures + a gallery
section. The 16-bit path — `sweep16`, `benchmark/metrics16.mjs`, the conditional figure block in
`benchmark/codec-paper-figures-full.mjs`, and the RAW-only pass in `CodecPaperFullTest.mjs` — is the
template to copy. The additive-metric pattern (emit a perceptual curve only when its bridge is present)
carries over directly: an `rgbaf32` Butteraugli/PU bridge would be the optional add on top of always-on
float PSNR/SSIM.
