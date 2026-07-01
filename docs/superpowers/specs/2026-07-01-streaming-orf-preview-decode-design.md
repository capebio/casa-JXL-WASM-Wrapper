# Streaming / Window ORF Preview Decode — Design

- **Date:** 2026-07-01
- **Status:** design approved (brainstorm); implementation not started
- **Area:** `crates/raw-pipeline/src/decompress.rs`, `demosaic.rs`, `src/lib.rs` (`decode_orf_raw`)
- **Author:** David + Claude (brainstorming session)
- **Related:** [[project-decompress-trunc-fold-20260701]] (the decode hot-loop pass this extends);
  `Questions_deferred.md` — "streaming two-row/window API" (this is its design).

## 1. Goal

Cut **peak memory** of Olympus ORF **preview-only** decodes by streaming the raw through
decode → half-demosaic → downscale in bands and discarding each band, so the full
`W×H×2` raw frame (48 MB @ 24 MP) and the `¼-res` RGB intermediate (~36 MB) are never
materialized at once. Target peak ≈ the lightbox deliverable itself (~13 MB) + small
change, down from ~84 MB — a ~6× reduction.

**This is a memory play, not a speed play.** The ORF entropy stream is strictly serial
(each pixel's bit position and adaptive carry depend on the previous), so the CPU still
decodes every row top-to-bottom; there is no row-parallelism or early-out to be had in
the decode itself. The win is bounded working set, plus the second-order capabilities
in §9.

## 2. Constraints

1. **Byte-exact.** Streamed previews (lightbox + thumb) must be *bit-identical* to the
   current full-frame path. No tolerance. (Shown achievable in §6.)
2. **Additive, not a rewrite.** All existing public decode/demosaic/downscale functions
   stay unchanged. Streaming is a new path selected by a gate; the old path remains for
   every case the new one does not cover.
3. **ORF only.** `decompress.rs` is Olympus-specific and the traced win is the ORF
   preview path. DNG/CR2 (LJPEG) are out of scope for implementation, but the row-source
   contract is a trait so they can adopt it later with no redesign.
4. **wasm-safe.** Must compile and run on `wasm32-unknown-unknown` (the browser target).
   No native-only assumptions in the streaming path.
5. **No new user tunables without evidence.** Strip size is an internal const, bench-
   adjustable, not a knob.

## 3. Scope

**In:** the ORF preview-only path — `decode_orf_raw` when previews are requested
(`OUT_LIGHTBOX | OUT_THUMB`), full-res output is *not* (`!(OUT_FULL_RGB8 | OUT_FULL_16)`),
and `preview_can_halve(w,h,lb_w,lb_h)` holds (the common ¼-res superpixel path).

**Out:**
- Full-res output path (`need_full_rgb`) — it already holds the whole raw for the MHC
  demosaic, so streaming the preview saves nothing there.
- The small-frame full-res bilinear preview fallback (`demosaic_rggb_planar`) — rare;
  keep as-is.
- DNG/CR2 streaming — trait seam only, no implementation.

## 4. Architecture — three layers

Each layer has one purpose, a narrow interface, and is independently testable.

### Layer 1 — pull core (`decompress.rs`)

```rust
/// A source of decoded raw rows, produced strictly top-to-bottom. The extension
/// seam for other decoders (LJPEG/DNG) — unused by anything but ORF today.
pub trait RawRowSource {
    fn width(&self) -> usize;
    fn height(&self) -> usize;
    /// Decode the next row into `dst` (len >= width). Returns:
    ///   Ok(true)  — a row was written to dst[..width]
    ///   Ok(false) — end of image (no more rows)
    ///   Err(_)    — corrupt/truncated stream (same messages as decompress_rows_into)
    fn next_row_into(&mut self, dst: &mut [u16]) -> Result<bool, String>;
}

pub struct OrfRowDecoder<'a> {
    br: BitReader<'a, WIDE_FILL>,
    width: usize,
    height: usize,
    row: usize,
    ring: [Box<[u16]>; 3], // rows r, r-1, r-2 — the only history the predictor needs
}
impl RawRowSource for OrfRowDecoder<'_> { /* next_row_into decodes one row */ }
```

Reuses the **exact** inner `for col` decode loop, `BitReader<WIDE_FILL>`, the branchless
predictor, and the per-row `acarry` reset. The single change vs `decompress_rows_into`:
the predictor reads north (row `r-2`, same parity) from `ring[(r) % 3]`'s sibling slot
instead of from a full `W×H` output buffer. `west`/`north_west` stay per-row register
delay-lines exactly as today. After decoding row `r` into its ring slot, the row is
copied into the caller's `dst` (one `width`-u16 memcpy — the cost of returning owned data
instead of a borrow into the ring; chosen for borrow/lifetime simplicity).

**Chosen shape:** buffer-filling `next_row_into` (alloc-free, borrow-free) over a
borrowed-slice iterator. An optional `next_row(&mut self) -> Option<Result<&[u16]>>`
sugar wrapper may be added later if a consumer wants zero-copy; not required now.

### Layer 2 — strip push wrapper (`decompress.rs`)

```rust
/// Pull rows from `src` into a reused `scratch` (strip_rows*width) and hand each
/// full strip (and the final partial strip) to `sink`. strip_rows must be even.
fn for_each_strip<S: RawRowSource>(
    src: &mut S,
    strip_rows: usize,
    scratch: &mut Vec<u16>,
    sink: impl FnMut(usize /*first_row*/, usize /*n_rows*/, &[u16]) -> Result<(), String>,
) -> Result<(), String>;
```

One reused `scratch` allocation for the whole decode. Strips (not single rows) so the
downstream demosaic keeps its `par_chunks` parallelism and cache-friendly block size —
pure 2-row streaming would serialize `demosaic_rggb_half` and lose the rayon win.

### Layer 3 — fused streaming preview (`raw-pipeline` + wired into `lib.rs`)

```rust
pub struct PreviewTarget { pub w: usize, pub h: usize } // e.g. lightbox 1800, thumb 360
pub struct PreviewSet { pub packed: Vec<Vec<u8>> }      // one packed LE buffer per target

pub fn build_previews_streaming(
    strip_bytes: &[u8], w: usize, h: usize, targets: &[PreviewTarget],
) -> Result<PreviewSet, String>;
```

For each raw strip (from Layer 2):
1. `demosaic_half_band(strip, w, k_rows) -> half_rgb_strip` — the extracted body of
   `demosaic_rggb_half`'s `do_row`, run `par_chunks` over the strip's `k/2` half-rows.
2. Feed each half-RGB row into every target's `StreamingBoxDownscale` accumulator.
3. Flush an output row when its input span `[y0, y1)` is complete.

`StreamingBoxDownscale` holds, per target: a `dw*3` `u32` row-accumulator (the current
output row), the output `Vec<u8>` (the deliverable), the current output-row index, and
the `[y0,y1)` span bookkeeping. See §6 for why this is byte-exact.

## 5. Data flow & memory

```
strip_bytes ──► OrfRowDecoder ──(3-row ring)──► for_each_strip ──► strip[K×W]
                                                                      │
                                    demosaic_half_band (par) ─────────┘
                                                     │  half_rgb rows (K/2 × hw×3)
                                        ┌────────────┴────────────┐
                                 StreamingBoxDownscale        StreamingBoxDownscale
                                     (lightbox 1800)             (thumb 360)
                                        │                            │
                                   lb Vec<u8> (deliverable)     thumb Vec<u8>
```

**Peak (24 MP example, 6000×4000, K=64):** lightbox output (~13 MB, irreducible
deliverable) + thumb (~0.5 MB) + raw strip (64×6000×2 ≈ 0.75 MB) + one half-RGB strip
(32×3000×3×2 ≈ 1.2 MB) + two accumulator rows (~25 KB) + 3-row ring (~35 KB) ≈
**~15.5 MB**, vs **~84 MB** today (48 raw + 36 half-RGB). Floor is the lightbox
deliverable, not the pipeline.

## 6. Byte-exactness argument

- **Decode:** identical inner loop, identical `BitReader<WIDE_FILL>`; the predictor reads
  the same row-`(r-2)` values (from the ring) it reads today (from the output buffer).
  → streamed rows are byte-identical to `decompress_rows_into`.
- **Half-demosaic:** `demosaic_half_band` is `do_row` verbatim; output half-row `qr`
  depends only on raw rows `2qr`, `2qr+1` (no cross-band halo). A strip of `k/2` half-rows
  equals the corresponding chunk of `demosaic_rggb_half`.
- **Downscale:** the float path (`downscale_rgb_float_path`) is an integer-boundary,
  equal-weight box filter. For downscaling (`sh > dh` ⇒ `yr > 1`), the vertical spans
  satisfy `y0(dy+1) == y1(dy)` — a non-overlapping partition of `[0, sh)`. Each input row
  feeds exactly one output row, so a streaming accumulator sums the same rows in the same
  order → identical sum → identical `/n`. Byte-identical to the one-shot.
- **Composition** of three byte-exact stages is byte-exact. Verified end-to-end by an
  A/B test on real ORF (§8).

## 7. Edge cases

- **Auto-WB (no camera WB tags, rare):** the only residual full-raw dependency in
  preview-only mode. `auto_wb_rggb` is gray-world (per-channel means). Fold a per-channel
  running-sum accumulator into the same streaming pass (byte-exact vs the one-shot mean).
  Fallback if it proves awkward: bail this rare case to the existing full-frame path.
  Black level is a constant (`OLYMPUS_BLACK_LEVEL`), no scan.
- **Odd height / final partial strip:** `for_each_strip` emits a final strip of
  `h % strip_rows` rows; `demosaic_rggb_half` already drops the last odd raw row
  (`hh = height/2`), so the streaming path mirrors that truncation.
- **Frame too small to halve:** gate falls through to the existing bilinear path.
- **Truncated / corrupt stream:** `next_row_into` returns `Err` (reusing
  `bitstream_exhausted`); `build_previews_streaming` propagates and returns no partial
  previews — same "whole decode fails" behavior as today.
- **Non-Bayer / unexpected dims:** reuse existing `validate`.

## 8. Verification plan

1. **Decoder differential (byte-exact):** golden 4×3 + large synthetic (reuse
   `synth_payload`) — concatenated `next_row_into` output == `decompress_rows_into`.
2. **Half-demosaic band (byte-exact):** strip-concatenated `demosaic_half_band` ==
   `demosaic_rggb_half(full)`.
3. **Streaming downscale (byte-exact):** `StreamingBoxDownscale` ==
   `downscale_rgb16_impl` for both exact-integer dims and aspect/float dims.
4. **Integration (byte-exact):** `build_previews_streaming(real ORF)` == current
   `lb_packed` / `thumb_packed` bytes.
5. **WB fold-in (byte-exact):** incremental gray-world == `auto_wb_rggb(full)`.
6. **Peak memory:** allocation-counting probe (or the flipflop memory column) — assert
   streaming peak < full-path peak / 4.
7. **Throughput (flipflop):** preview build, strip-stream vs current full path. Gate =
   **not a regression** (mem win is primary; strip parallelism should hold throughput).
   Pick strip size from this bench.
8. **Build:** `cargo check --target wasm32-unknown-unknown` clean; tests via the MSVC
   toolchain (native GNU is blocked by `dlltool` per project notes). Browser peak-mem, if
   it needs confirming, via `flipflopdom`.

## 9. What this enables (second-order)

One serial raw pass · bounded memory · many consumers:
1. **Progressive paint** — emit downscaled rows to JS as they complete (incremental
   lightbox render; perceived-latency win).
2. **ROI / window decode** — pull-then-stop = crop/tile/region re-decode; the deferred
   "window" goal falls out (CPU still reaches the row, but work + mem bound to the ROI).
3. **DNG/CR2 later** — implement `RawRowSource` for the LJPEG decoder; the same Layer-2/3
   fusion works unchanged.
4. **Bounded-mem batch/thumbnailing** — ~6× lower per-file peak ⇒ ~6× more ORFs decoded
   concurrently in the same wasm32 heap.
5. **Free stats fold-in** — auto-WB, histogram, clipping/black checks ride the same pass
   as running accumulators instead of extra full-raw scans.
6. **Per-row transforms** — hot-pixel correction, per-row black subtract, linearization
   LUT slot between decode and demosaic without buffering the frame.
7. **Test surface** — Layer 1 gives a clean "streamed == full" byte-exact oracle for the
   whole decode path.

## 10. Alternatives considered

- **Inlined preview fn (no primitive/trait):** least surface, ships fastest; loses reuse
  (progressive/ROI/DNG) and per-layer testability. Rejected in favor of the layered form.
- **Borrowed-slice iterator core (`next_row -> &[u16]`):** zero-copy but borrow/lifetime
  friction; kept as optional future sugar, not the core.
- **Pure 2-row streaming:** serializes `demosaic_rggb_half`, losing rayon. Rejected for
  strip granularity.
- **OPFS/temp spill:** trades RAM for I/O; in-RAM streaming is strictly better here.
- **Shrink buffers in place (no streaming):** doesn't remove the 48 MB raw. Strictly
  weaker.

## 11. Success criteria

- Streamed lightbox + thumb are byte-identical to the current path on a real ORF corpus.
- Preview-only decode peak memory < ¼ of the current full-frame path.
- Preview-build throughput is not a regression (flipflop-gated).
- Existing full-frame decode/demosaic/downscale paths and their tests are unchanged.
- `cargo check --target wasm32` clean; MSVC test suite green.

## 12. Out of scope / future

DNG/CR2 `RawRowSource` impls; progressive-paint JS wiring; ROI/window public API; stats
fold-in beyond auto-WB. Each is a separate spec built on this foundation.
