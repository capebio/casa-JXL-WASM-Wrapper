# FableBraid — SIMD-rate lossless image/residual codec (spec)

2026-07-02. Response to the "Huffman challenge": profiling (casa_prof, compile-gated
in libjxl-012) shows lossless JXL decode is ~93-100% inside the serial per-pixel
modular loop — prefix/Huffman symbol reads chained through one bit position, plus a
serial gradient/WP predictor. BBB 854×480 keyframe: effort-1 (fjxl) 16 ms
(33 cyc/px, `maans.grad_rle_fjxl`), effort-3 46 ms (`maans.wp_lut`), effort-7 89 ms.
Huffman *table building* is noise (<0.3%). No local rewrite removes a bit-serial
dependency chain — the fix is a format whose decode has no such chain.

## Goal

A lossless codec for casv/ShareNat tiers where **decode is SIMD/ILP-bound, not
dependency-bound**: braided (N-way interleaved) rANS entropy + mod-256 row
predictors, so entropy decode overlaps 8 independent streams and prediction is one
`vpaddb` pass. Owned format — bypasses libjxl entirely (new Rust module; the brotli
/ jpegli / dec_huffman.cc files were never the right lever).

## Non-goals (v1)

- Not a JXL bitstream: casv gains a new frame flavour; JXL tiers stay untouched.
- No 16-bit tier yet (casv u16 residual P-frames keep JXL; FableBraid P-frames use
  mod-256 temporal deltas instead — exact by ring arithmetic).
- Encoder speed is secondary (two-pass is fine); decode speed is the deliverable.

## Format

Image container: `"FBR1" | u32 w | u32 h | u8 nplanes | u8 rct` then per plane
`u32 len | plane blob`. rct: 0 = none, 1 = subtract-green (R-=G, B-=G mod 256).

Plane blob:
```
u8  predictor        0=Zero 1=Top 2=External(prev frame plane)
u8  reserved (0)
h × u8 row modes     0=COPY (row == prediction) 1=RANS 2=RAW
u32 n_syms           total rANS-coded residual bytes
[if n_syms>0] 256 × u16 freqs (normalized to 4096)
              8 × u32 initial rANS states
              u32 rans_len | rans bytes (+decoder overread slack is encoder-padded)
u32 raw_len | raw residual bytes (RAW rows, verbatim)
```

Residual = (cur − pred) mod 256 per byte. Prediction of row y: Zero→0,
Top→decoded row y−1 (row 0 → 0), External→same row of external plane.

Entropy: rANS, 12-bit precision, 32-bit state, 16-bit renorm, **8 braided lanes**
(symbol i → lane i&7) sharing one byte stream; encoder runs in reverse so the
decoder reads forward. Decode table: `u32[4096]` = freq(12b)|off(12b)|sym(8b),
16 KiB, one load per symbol.

## Edge cases

- w or h = 0: reject. 1×1, 1×h, w×1, odd widths: must roundtrip.
- Constant-residual rows → COPY only when residual is all-zero; other constants go
  through rANS (freq table handles it; single-unique-symbol planes still get a
  legal table via a forced second slot? No — normalization keeps present symbols
  ≥1 and caps at 4095 by construction: if only one symbol present, encoder emits
  freq 4095 + 1 for the lowest other symbol. Decoder never sees freq 4096.)
- Incompressible rows: encoder marks RAW when estimated bits > 8.05 bpp.
- Truncated/corrupt input: decoder returns None (bounds-checked reads), never UB.

## Success criteria

1. Roundtrip byte-exact: unit tests (edge dims, random, gradient, screen-like,
   photo frames) + whole-clip casv roundtrip.
2. Decode ≥3× faster than the current fjxl-e1 JXL decode on BBB frame 0 native
   single-thread (target 5-10×; report interleaved A/B, flipflop lesson).
3. Encoded size ≤ +15% vs fjxl e1 on BBB / Sintel / ToS keyframes (report actuals;
   stretch ≤ +5%).
4. `cargo check --target wasm32-unknown-unknown` clean (SIMD cfg-gated, scalar
   fallback byte-identical).

## Results (2026-07-02, i7-10850H, single-thread, MSVC/clang-cl release)

All gates met. Interleaved A/B, byte-exact asserted on every decoded frame.

Single keyframe (fable_ab, intra vs lossless JXL):

| frame | FB bpp | vs fjxl e1 bytes | vs e1 decode | vs e3 bytes | vs e3 decode |
|---|---|---|---|---|---|
| BBB #0 854×480 | 7.35 | +0.6% | 4.7× (3.9 vs 18.2 ms med) | −22.8% | 14.0× |
| Sintel #100 | 2.18 | +0.4% | 3.4× | +24.7% | 14.1× |
| ToS #100 | 2.67 | +10.2% | 3.6× | −4.5% | 15.9× |

Whole clip, casv lossless tier (fable_video_ab, gop 24, vs JXL bbox e3):

| clip | FB dec ms/f (fps) | JXL dec ms/f (fps) | speedup | bytes |
|---|---|---|---|---|
| BBB 360f | 7.08 (141) | 111.4 (9) | **15.7×** | +5.8% |
| Sintel 527f | 4.05 (247) | 54.9 (18) | **13.6×** | **−29.4%** |
| ToS 527f | 6.11 (164) | 44.7 (22) | **7.3×** | **−5.4%** |

Encode is also 6-7× faster than the JXL lossless tier. Key design points that
made it: left-delta transform (≡ unclamped-Gradient prediction, decoded as a
mod-256 SIMD prefix sum), per-plane {External, Top} predictor choice on delta
frames (high-motion planes fall back to intra prediction), identity-frame
short-circuit, branchless 16-bit renorm with a bounds-free fast region.

Profiling evidence that motivated the design (casa_prof, patch in
`docs/casa-prof-instrumentation.patch`): lossless JXL decode on BBB is ~93%
(e1, prefix/Huffman `maans.grad_rle_fjxl`) to ~100% (e3 `maans.wp_lut`,
e7 `maans.slowest`) inside the serial per-pixel modular loop; Huffman *table
build* is <0.3% — the chain, not the tables, was the enemy.
