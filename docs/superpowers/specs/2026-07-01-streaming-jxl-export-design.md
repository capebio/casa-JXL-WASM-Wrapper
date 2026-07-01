# Fused Streaming Full-Res JXL Export — Design

- **Date:** 2026-07-01
- **Status:** design approved (brainstorm); implementation not started
- **Branch:** `perf/dng-stream-preview-jul01-m2r7`
- **Area:** `crates/raw-pipeline/src/jxl_casaencoder.rs`, `demosaic.rs`, a new export entry;
  Phase 2: `packages/jxl-wasm/src/bridge.cpp`
- **Builds on:** `encode_chunked_rgb8` (proven byte-identical to whole-frame, ~60 MB lower
  encoder peak — see `docs/streaming-jxl-encode-map-2026-07-01.md` §8) and the pull-order
  probe (`examples/jxl_chunked_pull_order.rs`).

## 1. Goal

Export a full-resolution RAW→JXL at **O(super-tile band)** peak memory instead of
materializing the full raw + full-res demosaiced RGB + libjxl's whole-frame copy. Fuse
decode → demosaic → tone → encode so no whole-frame pixel buffer exists at any stage,
while producing a JXL **byte-identical** to today's full-frame export.

## 2. Validated ground truth

- libjxl 0.12 chunked input (`JxlEncoderAddChunkedFrame` + `JxlChunkedFrameInputSource` +
  `JxlEncoderSetOutputProcessor`) works natively; `encode_chunked_rgb8` implements it and
  is **byte-identical** to whole-frame across effort {1,3,5,7} × distance {0.5,1,2}, at
  ~60 MB lower encoder peak, neutral-to-faster.
- **Pull order (probe):** the encoder pulls a grid of **≤2048² super-tiles**, `ypos`
  monotonic non-decreasing, **zero backward jumps**; consecutive bands **overlap by the
  border** (e.g. band0 rows 0–2056, band1 rows 2040–3912). Max rect ≈ 2064×2056. 6 pulls
  for 20 MP. → a forward-only sliding window is feasible; granularity ≈ 2048 rows.
- `demosaic_rggb_mhc_band` (halo-padded, scalar `mhc_pixel`) exists and is byte-exact with
  the whole MHC demosaic (RGGB, phase (0,0)).

## 3. Constraints

1. **Byte-exact** to today's full-frame export (a property — the exported JXL is unchanged;
   only peak memory drops). Reduces to: `demosaic_band == whole` + `tone_band == whole` +
   the already-proven `encode_chunked == whole`.
2. **Additive** — the whole-frame export path and its tests are untouched; streaming is a
   new entry + a generalized encoder seam.
3. **Forward-only decode** — `OrfRowDecoder` cannot re-decode; the sliding window must never
   need a row below `win_first` (guaranteed by monotonic `ypos`).
4. **wasm-safe** — P1 is native, but must not break the wasm build.

## 4. Scope & phasing (two subsystems)

- **Phase 1 — native ORF streaming export** (this spec, detailed): all pieces exist/proven;
  RGGB band demosaic; byte-exact; native entry. Lowest risk.
- **Phase 2 — WASM-bridge parity** (§9 sketch, its own spec+plan): replicate chunked encode
  + browser decode→demosaic→tone fusion in `bridge.cpp`; unlocks gigapixel-in-browser.
- **DNG** (needs a phase-aware MHC band demosaic) — extension, not in P1.

## 5. Architecture (Phase 1)

### 5.1 Generalize the encoder over a source
```rust
pub trait ChunkedColorSource {
    fn pixel_format(&self) -> (u32 /*channels*/, /* u8 */);
    /// Return a pointer to the pixel data for rect [xpos,ypos, xsize×ysize] and the byte
    /// stride between its rows. Called synchronously by libjxl during the encode, in
    /// monotonic-ypos order. May drive lazy decode as a side effect.
    fn rect(&mut self, xpos: usize, ypos: usize, xsize: usize, ysize: usize) -> (*const u8, usize);
}

pub fn encode_chunked<S: ChunkedColorSource>(
    w: u32, h: u32, distance: f32, effort: i64, src: &mut S, out: &mut Vec<u8>,
) -> Result<(), EncodeError>;
```
The FFI `get_color_channel_data_at` callback bridges `opaque → &mut S` (a thin pointer to a
`&mut dyn ChunkedColorSource`, since `extern "C"` fns can't be generic) and calls
`src.rect(..)`. `encode_chunked_rgb8` is refactored into `encode_chunked` +
`WholeImageSource { data, stride }` (rect = pointer into the whole buffer — today's behavior,
stays byte-identical).

### 5.2 `StreamingExportSource` (the sliding fused pipeline)
```rust
struct StreamingExportSource<'a> {
    dec: OrfRowDecoder<'a>,       // forward row producer
    width: usize, height: usize,
    params: PipelineParams,       // tone/WB/matrix (fixed, per-pixel)
    win_first: usize,             // first materialized row (global)
    rgb8: VecDeque<u8> | Vec<u8>, // materialized RGB8 rows [win_first, win_end)
    raw_halo: Vec<u16>,           // last ≤2 decoded raw rows (MHC bottom-of-prev / top halo)
    raw_decoded: usize,           // rows decoded so far (>= win_end + lookahead)
}
```
`rect(x,y,xs,ys)`:
1. **front-drop:** if `y > win_first`, discard rows `[win_first, y)`, set `win_first = y`.
2. **grow-back:** while `win_end() < y+ys`: decode the next raw row(s) via `dec`, keep a
   2-row halo; once ≥2 rows past the target row are available, `demosaic_rggb_mhc_band`
   (halo above from carry/window, halo below from lookahead) → rgb16 row → `tone` per-pixel
   → append RGB8 row to the window. At the image bottom, clamp the bottom halo.
3. return `(ptr to window row (y-win_first) at column x, stride=width*3)`.

Window size stays ≈ max pull height (~2056) + border. Front-drop happens ~once per band
(cheap). `x`/`xs` are served as sub-rects of the full-width window (pointer + stride), like
`WholeImageSource`.

### 5.3 Entry point
```rust
pub fn export_orf_jxl_streaming(
    orf: &[u8], params: &PipelineParams, distance: f32, effort: i64, out: &mut Vec<u8>,
) -> Result<(), String>;
```
Parses ORF (`tiff::parse`), builds `OrfRowDecoder` + `StreamingExportSource`, calls
`encode_chunked`. Output = single full-res JXL, byte-exact to
`decompress → demosaic_rggb_mhc → process_into_auto → encode`.

## 6. Data flow & memory
```
orf ─► OrfRowDecoder ─(rows)─► [demosaic_mhc_band + tone] ─► RGB8 window (~2056 rows)
                                                               │  (libjxl pulls super-tiles)
                                             encode_chunked ◄──┘ ──► out (compressed)
```
Peak ≈ RGB8 window (`~2056·W·3`) + raw halo (~2 rows) + libjxl streaming working set +
compressed output. **20 MP (5240 w): ~32 MB vs ~215 MB today (~6×).** Win ≈ `height/2048`
— best for tall images; a frame ≤2048 rows = one pull = no win (acceptable; not the target).
Irreducible: the compressed `out` must accumulate.

## 7. Edge cases
- **Border overlap** between super-tiles → handled by the rolling window (front-drop only
  below the monotonic `ypos`; never discards a row a later pull needs).
- **MHC halo at frame top/bottom** → replicate/clamp (matches whole demosaic's edge rule).
- **Image ≤2048 rows** → single pull; window = whole image (no win, still correct).
- **Non-monotonic pull** (shouldn't happen per probe) → assert; if ever violated, the source
  errors rather than returning a dropped row (fail-safe, no silent corruption).
- **`process_into_auto` whole-frame state** → MUST be pure per-pixel for band-tone to match;
  verified in the plan (if it computes any whole-frame stat, tone stays whole-frame and only
  demosaic+encode stream — a smaller but still-valid win).
- **effort/distance gating** → streaming engages at fast/VarDCT/>2048px (as measured);
  smaller/slower cases fall back to whole-frame export (the existing path).

## 8. Test plan
1. `demosaic_rggb_mhc_band` == whole `demosaic_rggb_mhc` (synthetic raw, several sizes incl.
   odd/edge) — byte-exact.
2. `tone_band` == whole tone (synthetic rgb16) — byte-exact (after the per-pixel check).
3. **Integration byte-exact:** for an in-RAM RGB8 image, `encode_chunked(StreamingExportSource
   over it)` == `encode_chunked(WholeImageSource)` == whole-frame `encode` (hash) — proves the
   sliding window + generalized seam produce identical bytes.
4. End-to-end (if an ORF fixture is available): `export_orf_jxl_streaming` bytes ==
   `decompress→demosaic→tone→encode` bytes.
5. Peak-mem probe: streaming export peak < full-export peak / 3 (sampler-thread, per-run
   baseline-subtracted), scaling with fixture height.
6. Throughput flipflop: streaming vs whole export; gate = **not a regression**.
7. `cargo check --target wasm32` clean.

## 9. Phase 2 — WASM-bridge parity (sketch, separate spec)
Replicate in `bridge.cpp`: a C++ `JxlChunkedFrameInputSource` whose `get_color_channel_data_at`
drives the browser decode→demosaic→tone fusion over a sliding window, + output processor. The
browser RAW decode path (`web/pkg`) must expose a row/band producer (or reuse a wasm
`OrfRowDecoder`). Unlocks gigapixel-in-browser + constant-memory batch. Its own ~34-min wasm
build cycle, so decoupled from P1.

## 10. Success criteria
- `export_orf_jxl_streaming` output byte-identical to the whole-frame export (hash) on the
  test corpus.
- Peak memory < ⅓ of the full-export path (20 MP), scaling with height.
- Throughput not a regression; whole-frame path + tests unchanged.
- `cargo check --target wasm32` clean; MSVC lib suite green.

## 11. Out of scope / future
DNG streaming export (phase-aware MHC band); Phase 2 WASM bridge; lossless/modular streaming;
progressive-DC-from-first-band; ROI/JXTC streaming (Route B). Each a separate spec.
