# Streaming DNG Preview Decode — Design

- **Date:** 2026-07-01
- **Status:** design approved (brainstorm); implementation not started
- **Branch:** `perf/dng-stream-preview-jul01-m2r7` (off `perf/decompress-trunc-fold-jul01-q8z`)
- **Area:** `crates/raw-pipeline/src/dng.rs`, `demosaic.rs`, `stream_preview.rs`, `decompress.rs`; `src/lib.rs` (`decode_dng_raw`)
- **Builds on:** the ORF streaming pipeline (`RawRowSource`, `for_each_strip`,
  `demosaic_half_band`, `StreamingBoxDownscale`, `build_previews_streaming`) shipped on the
  parent branch — see `docs/superpowers/specs/2026-07-01-streaming-orf-preview-decode-design.md`.

## 1. Goal

Extend the streaming preview pipeline to DNG so preview-only DNG decodes never
materialize the full raw or the full-resolution demosaiced RGB. Today `decode_dng_raw`
always does a full-frame MHC demosaic (`demosaic_bayer_mhc`, 5×5) then downscales the
full RGB for previews — peak ≈ full raw (`W·H·2`) + full RGB16 (`W·H·3·2`) ≈ **360 MB at
45 MP**. Streaming a tile-band at a time through a ¼-res superpixel demosaic + box
downscale drops peak to ≈ **25 MB (~14×)**, floored by the lightbox deliverable.

## 2. Key decisions (from brainstorm)

1. **Superpixel previews (match ORF), not MHC.** The streaming DNG preview uses the same
   phase-aware ¼-res 2×2 superpixel demosaic ORF uses — halo-free, ¼ the RGB, and
   "perceptually equivalent at preview size". **Consequence:** preview-only DNG previews
   are NOT byte-exact to today's MHC-based previews (a small, accepted quality delta), and
   differ depending on whether full-res output was co-requested. Full-res output is
   unchanged (still MHC).
2. **Both compressions.** compression=7 (LJPEG, tiled) and compression=1 (uncompressed
   strips). Non-Bayer (cps≠1) / unsupported → fall back to the existing full path.
3. **Approach A — unify via `RawRowSource`.** One generic fusion serves ORF and DNG; the
   trait was built for exactly this. (Rejected: B = duplicate fusion; C = keep full raw,
   only ~4×.)

## 3. Constraints

1. **Component byte-exactness.** Although preview *output* changes (superpixel vs MHC),
   every streaming component is byte-exact-verifiable: streamed decode rows == full
   `decode_bytes().raw`; phased superpixel == reference; fused == manual composition.
   RGGB superpixel stays byte-identical to the existing `demosaic_half_band`.
2. **Additive.** The existing full-MHC DNG path and all its tests are unchanged; streaming
   is a gated fork.
3. **wasm-safe.** Compiles + runs on `wasm32-unknown-unknown` (the shipping target).
4. **Caps enforced.** The 8192-dim / 50 MP guards apply before any band buffer alloc.

## 4. Scope

**In:** preview-only DNG decodes (`OUT_LIGHTBOX|OUT_THUMB` requested, `OUT_FULL_*` not),
Bayer (cps=1), compression 7 or 1.

**Out:** full-res DNG output path (needs the full RGB anyway — no streaming benefit);
non-Bayer / X-Trans / cps>1 (fall back); CR2 (separate, deferred — vertical slices block
row streaming; see `Questions_deferred.md`).

## 5. Architecture (Approach A)

```
DngRowSource: RawRowSource            OrfRowDecoder: RawRowSource (existing)
  comp=7: tile-band decode                     │
  comp=1: strip row reads                      │
        └──────────────┬──────────────────────┘
                       ▼
  build_previews_streaming<S: RawRowSource>(source, w, h, phase, targets)
     for_each_strip → demosaic_half_band(phase) → StreamingBoxDownscale×N
                       ▼
                 Vec<Vec<u8>> packed LE previews
```

### Unit changes

1. **`demosaic_half_band` → phase-aware** (`demosaic.rs`). Add `phase: (u8,u8)` = the
   position of R in the 2×2 tile (RGGB=(0,0), Grbg=(0,1), Gbrg=(1,0), Bggr=(1,1) — the
   same mapping `decode_dng_raw` already uses). Per superpixel: `R = tile[pr][pc]`,
   `B = tile[1-pr][1-pc]`, `G = mean(tile[pr][1-pc], tile[1-pr][pc])`. RGGB reduces to the
   current expression exactly. Existing `half_band_matches_full` (RGGB) guards it; the
   ORF caller passes `(0,0)`.

2. **`build_previews_streaming` → generic** (`stream_preview.rs`):
   ```rust
   pub fn build_previews_streaming<S: RawRowSource>(
       mut source: S, w: usize, h: usize, phase: (u8,u8), targets: &[(usize,usize)],
   ) -> Result<Vec<Vec<u8>>, String>
   ```
   Threads `phase` into `demosaic_half_band`. ORF call site becomes
   `build_previews_streaming(OrfRowDecoder::new(strip,w,h)?, w,h,(0,0), targets)` —
   byte-identical to today.

3. **`DngRowSource`** (`dng.rs`): holds `&data` + parsed IFD/metadata + one reused band
   buffer + cursors. `new(data)` parses metadata + geometry only (no decode) and enforces
   the dim/pixel caps. `next_row_into` lazily decodes the next band into the buffer and
   doles rows in true top-to-bottom order:
   - **comp=7:** band `tr` covers rows `[tr·tl, min((tr+1)·tl, h))`; for each of `coltiles`
     tiles, `ljpeg::decode_tile` writes its sub-rect into the band buffer (reuses the
     existing `decode_band` body verbatim).
   - **comp=1:** read `active_h` rows of `w` u16 from the strip at the row offset,
     endianness per IFD (reuses the existing uncompressed unpack).
   No history ring is needed (superpixel is halo-free; tile/strip decode exposes no
   cross-band state). Accessors: `phase()`, `meta()` (black/white/wb/matrix/iso/w/h).

4. **`decode_dng_raw` gate** (`src/lib.rs`): if `need_previews && !need_full_rgb` and
   `DngRowSource::new` succeeds with compression∈{7,1} and cps==1 → build previews via
   streaming, return `DngDecoded` with previews filled and `rgb16` empty; else the existing
   full-MHC path runs unchanged. `DngDecoded` gains `lb_packed/lb_w/lb_h/thumb_packed/
   thumb_w/thumb_h` + a `fast_preview` flag (mirroring `OrfDecoded`); `process_dng_impl`
   uses them when present and skips the `rgb16` downscale. Params (black/white/wb/matrix)
   come from `DngRowSource::meta()` — no full-raw scan (DNG WB is metadata).

## 6. Data flow & memory

```
data ─► DngRowSource ─(one tile-band buf)─► for_each_strip ─► strip[128×W]
                                              demosaic_half_band(phase) (par)
                                                     │  half-RGB rows
                                        ┌────────────┴───────────┐
                                 StreamingBoxDownscale       StreamingBoxDownscale
                                    (lightbox 1800)            (thumb 360)
```
**Peak (45 MP, tl=512):** tile-band buffer (512·8192·2 ≈ 8 MB) + for_each_strip scratch
(128·8192·2 ≈ 2 MB) + one half-strip (≈ 0.6 MB) + lb deliverable (≈ 13 MB) + thumb + accs
≈ **~25 MB vs ~360 MB → ~14×**.

## 7. Edge cases

- **Odd `tl`:** rows are still yielded in order; `for_each_strip`'s even-strip regroup +
  odd-trailing-row drop handles it, matching `hh = h/2`.
- **comp=1 endianness:** reuse the existing uncompressed unpack (IFD byte order).
- **Malformed tile grid:** reuse `decode_tiles`' expected-count validation before decode.
- **Non-Bayer / cps>1 / X-Trans:** gate fails → existing full path (which handles/bails).
- **Caps:** enforce 8192-dim / 50 MP in `DngRowSource::new` before allocating buffers.
- **Truncated/corrupt tile:** `ljpeg::decode_tile` error → `next_row_into` returns `Err`;
  fusion propagates; no partial previews.

## 8. Verification plan

1. **Decode byte-exact:** `DngRowSource` rows concatenated == `dng::decode_bytes(data).raw`,
   for a comp=7 and a comp=1 input. ⚠️ **test-data dependency** — needs DNG fixtures; check
   for an existing one (examples/benches may reference one), else add a small fixture or a
   minimal synthetic DNG, else gate the test on a fixture-path env var. Resolve in the plan.
2. **Phase superpixel:** `demosaic_half_band` phased == a reference phased superpixel for
   all 4 phases; RGGB byte-identical to the existing kernel.
3. **Fusion:** `build_previews_streaming(DngRowSource)` == manual (collected raw → phased
   half → reference downscale). Reuses the Task-5 `StreamingBoxDownscale` proof.
4. **ORF regression:** the generalized `build_previews_streaming` still produces
   byte-identical ORF previews (existing `build_previews_matches_manual_composition`).
5. **Peak memory:** extend the `stream_peak_mem` probe with a DNG case (working set above
   input < ¼ of the full path). Same fixture dependency as (1).
6. **Throughput:** flipflop DNG preview build (streaming vs full MHC+downscale); gate = not
   a regression on the streaming axis (this is primarily a memory win — full MHC is a
   different, heavier computation, so expect streaming to be *faster* here, not slower).
7. **Build:** `cargo check --target wasm32` clean; MSVC `--lib` + the DNG integration test.

## 9. Success criteria

- Preview-only DNG (comp 7 & 1) produces superpixel previews via streaming; peak working
  set < ¼ of the full-MHC path.
- Every streaming component byte-exact (decode rows, phased superpixel, fusion); ORF
  previews unchanged (byte-identical).
- Full-res DNG output path + tests unchanged.
- `cargo check --target wasm32` clean; MSVC lib suite green.
- The preview-output change (superpixel vs MHC) is documented.

## 10. Out of scope / future

CR2 streaming (vertical slices block row-streaming; partial win only — deferred). MHC-band
streaming (byte-exact-to-old previews) — rejected in favor of superpixel per §2. WB-stats
fold-in — not needed for DNG (metadata WB).
