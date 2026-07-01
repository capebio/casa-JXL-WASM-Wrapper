# Streaming DNG Preview Decode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the streaming preview pipeline to DNG so preview-only DNG decodes stream one band at a time (phase-aware ¼-res superpixel + box downscale) instead of materializing the full raw + full-res MHC RGB, cutting peak memory ~14× (comp=7) / ~3.5× (comp=1).

**Architecture:** Approach A — one generic `build_previews_streaming<S: RawRowSource>` serves ORF and DNG. Add a phase param to `demosaic_half_band`, a `DngRowSource` (comp=7 tile-band streaming; comp=1 decode-full-then-dole), and a gated fork in `decode_dng_raw`. Full-res MHC path unchanged; DNG previews become superpixel (accepted quality delta).

**Tech Stack:** Rust, `raw-pipeline` crate; MSVC toolchain for native tests (native GNU blocked by `dlltool`); `wasm32-unknown-unknown` for the browser build.

**Reference spec:** `docs/superpowers/specs/2026-07-01-streaming-dng-preview-decode-design.md`
**Builds on:** the ORF streaming infra already on this branch (`RawRowSource`, `for_each_strip`, `demosaic_half_band`, `StreamingBoxDownscale`, `build_previews_streaming`).

**Deviation from spec (§5.3/§6):** comp=1 is implemented as *decode-full-raw-then-dole rows* inside `DngRowSource` (reusing the crate's `decode_uncompressed`) rather than a band-wise strip reader — the band-wise reader would duplicate `decode_uncompressed`'s strip/tile/endianness logic for a rare format. comp=1 still avoids the full-res RGB (the dominant DNG buffer) → ~3.5× peak; comp=7 truly streams → ~14×.

**Test command (native, MSVC).** Set once per shell (from the worktree root `C:\Foo\rcw-dng-stream`):
```powershell
$env:PATH="C:\Program Files\LLVM\bin;$env:PATH"
$env:LLVMInstallDir="C:\Program Files\LLVM"; $env:LLVMToolsVersion="22"
$env:CARGO_TARGET_DIR="C:\Tmp\rcw-dng-msvc-target"
$vc="C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
function ct($f){ cmd /c "call `"$vc`" >nul && cargo +stable-x86_64-pc-windows-msvc $f" }
```
Run raw-pipeline tests with `cd crates\raw-pipeline; ct "test --lib <filter>"`. **DNG fixture** (comp=7, present on this machine): `C:\Foo\raw-converter-wasm\.timing-source\PXL_20260527_180319603.RAW-02.ORIGINAL.dng`. Fixture-dependent tests read it and **skip gracefully if absent** (CI-safe; run locally to actually verify).

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `crates/raw-pipeline/src/demosaic.rs` | `demosaic_half_band` gains `phase`; RGGB byte-identical | Modify |
| `crates/raw-pipeline/src/stream_preview.rs` | `build_previews_streaming` generic over `RawRowSource` + `phase` | Modify |
| `crates/raw-pipeline/src/dng.rs` | extract `decode_band_into`; add `DngMeta`, `DngRowSource` (comp 7+1) | Modify |
| `src/lib.rs` | `decode_dng_raw` streaming gate; `DngDecoded` preview fields; `process_dng_impl` uses them | Modify |
| `crates/raw-pipeline/tests/dng_stream.rs` | DNG decode byte-exact + peak-mem (fixture-gated) | Create |

---

## Task 1: Phase-aware `demosaic_half_band`

**Files:**
- Modify: `crates/raw-pipeline/src/demosaic.rs` (`demosaic_half_band` + `demosaic_rggb_half` caller)
- Test: `crates/raw-pipeline/src/demosaic.rs` (`mod tests`)

- [ ] **Step 1: Write the failing test** (add to demosaic.rs `mod tests`):

```rust
    #[test]
    fn half_band_phase_matches_reference() {
        // R at phase (pr,pc) in each 2x2; B diagonal-opposite; G = mean of the other two.
        fn ref_half(raw: &[u16], w: usize, h: usize, phase: (u8, u8)) -> Vec<u16> {
            let (hw, hh) = (w / 2, h / 2);
            let (pr, pc) = (phase.0 as usize, phase.1 as usize);
            let mut out = vec![0u16; hw * hh * 3];
            for qr in 0..hh {
                for qc in 0..hw {
                    let at = |dr: usize, dc: usize| raw[(2 * qr + dr) * w + (2 * qc + dc)] as u32;
                    let r = at(pr, pc);
                    let b = at(1 - pr, 1 - pc);
                    let g = (at(pr, 1 - pc) + at(1 - pr, pc)) >> 1;
                    let o = (qr * hw + qc) * 3;
                    out[o] = r as u16; out[o + 1] = g as u16; out[o + 2] = b as u16;
                }
            }
            out
        }
        let (w, h) = (8usize, 6usize);
        let raw: Vec<u16> = (0..(w * h)).map(|i| ((i * 53 + 11) & 0x0fff) as u16).collect();
        for phase in [(0u8, 0u8), (0, 1), (1, 0), (1, 1)] {
            let want = ref_half(&raw, w, h, phase);
            let mut got = vec![0u16; (w / 2) * (h / 2) * 3];
            demosaic_half_band(&raw, w, h, phase, &mut got);
            assert_eq!(got, want, "phase {:?}", phase);
        }
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ct "test --lib half_band_phase_matches_reference"`
Expected: FAIL — `demosaic_half_band` takes 4 args, not 5.

- [ ] **Step 3: Add `phase` to `demosaic_half_band`** (replace the current fn):

```rust
/// Demosaic `k_rows` raw rows (k_rows even, starting at an even raw row) into
/// half-resolution interleaved RGB16. `out_half` len must be (k_rows/2)*(width/2)*3.
/// `phase` = position of R in the 2x2 tile (RGGB=(0,0), Grbg=(0,1), Gbrg=(1,0),
/// Bggr=(1,1)). RGGB reduces to the original expression (byte-identical).
pub fn demosaic_half_band(
    raw_strip: &[u16], width: usize, k_rows: usize, phase: (u8, u8), out_half: &mut [u16],
) {
    let hw = width / 2;
    let (pr, pc) = (phase.0 as usize, phase.1 as usize);
    let do_row = |qr: usize, out_row: &mut [u16]| {
        let r0 = &raw_strip[(2 * qr) * width..(2 * qr) * width + width];
        let r1 = &raw_strip[(2 * qr + 1) * width..(2 * qr + 1) * width + width];
        let rows = [r0, r1];
        for qc in 0..hw {
            let c0 = 2 * qc;
            let at = |dr: usize, dc: usize| rows[dr][c0 + dc] as u32;
            let r = at(pr, pc);
            let b = at(1 - pr, 1 - pc);
            let g = (at(pr, 1 - pc) + at(1 - pr, pc)) >> 1;
            let o = qc * 3;
            out_row[o] = r as u16;
            out_row[o + 1] = g as u16;
            out_row[o + 2] = b as u16;
        }
    };
    #[cfg(feature = "parallel")]
    out_half.par_chunks_mut(hw * 3).enumerate().for_each(|(qr, out_row)| do_row(qr, out_row));
    #[cfg(not(feature = "parallel"))]
    out_half.chunks_mut(hw * 3).enumerate().for_each(|(qr, out_row)| do_row(qr, out_row));
    let _ = k_rows;
}
```

- [ ] **Step 4: Update `demosaic_rggb_half` to pass RGGB phase.** In its body change the delegate call:

```rust
    demosaic_half_band(&raw[..(2 * hh) * width], width, 2 * hh, (0, 0), &mut rgb);
```

- [ ] **Step 5: Run tests to verify pass** (new phase test + existing `half_band_matches_full` + all demosaic tests)

Run: `ct "test --lib demosaic::"`
Expected: PASS — RGGB stays byte-identical, all 4 phases correct.

- [ ] **Step 6: Commit**

```bash
git add crates/raw-pipeline/src/demosaic.rs
git commit -m "feat(demosaic): phase-aware demosaic_half_band (RGGB byte-identical)"
```

---

## Task 2: Generalize `build_previews_streaming` over `RawRowSource` + `phase`

**Files:**
- Modify: `crates/raw-pipeline/src/stream_preview.rs`
- Modify: `src/lib.rs` (the one ORF call site)
- Test: `crates/raw-pipeline/src/stream_preview.rs` (existing `build_previews_matches_manual_composition` updated)

- [ ] **Step 1: Change the signature + demosaic call.** Replace the current `build_previews_streaming` with:

```rust
/// Fully streaming preview build over any RawRowSource. Decodes in even strips,
/// half-demosaics each strip with `phase`, box-downscales into one packed LE u16
/// buffer per target. `w`/`h` are the full mosaic dims of `source`.
pub fn build_previews_streaming<S: RawRowSource>(
    mut source: S,
    w: usize,
    h: usize,
    phase: (u8, u8),
    targets: &[(usize, usize)],
) -> Result<Vec<Vec<u8>>, String> {
    let (hw, hh) = (w / 2, h / 2);
    if hw == 0 || hh == 0 {
        return Err(format!("stream_preview: {}×{} too small for half-res", w, h));
    }
    debug_assert_eq!(source.width(), w);
    debug_assert_eq!(source.height(), h);
    let mut downs: Vec<StreamingBoxDownscale> =
        targets.iter().map(|&(dw, dh)| StreamingBoxDownscale::new(hw, hh, dw, dh)).collect();
    let mut scratch: Vec<u16> = Vec::new();
    let mut half_strip = vec![0u16; (STRIP_ROWS / 2) * hw * 3];

    for_each_strip(&mut source, STRIP_ROWS, &mut scratch, |_first_row, k, raw_strip| {
        let keven = k & !1;
        if keven == 0 {
            return Ok(());
        }
        let half_rows = keven / 2;
        let hs = &mut half_strip[..half_rows * hw * 3];
        demosaic_half_band(&raw_strip[..keven * w], w, keven, phase, hs);
        for hr in 0..half_rows {
            let row = &hs[hr * hw * 3..(hr + 1) * hw * 3];
            for d in downs.iter_mut() {
                d.push_row(row);
            }
        }
        Ok(())
    })?;
    Ok(downs.into_iter().map(|d| d.finish()).collect())
}
```

Note: `source` is now taken by value (`mut source: S`) instead of constructing `OrfRowDecoder` internally.

- [ ] **Step 2: Update the in-module fusion test** `build_previews_matches_manual_composition` to construct the source and pass RGGB phase:

```rust
        // streaming
        let got = build_previews_streaming(
            crate::decompress::OrfRowDecoder::new(&payload, w, h).unwrap(),
            w, h, (0, 0), &[(20, 15), (8, 6)],
        ).unwrap();
```
(and the same in `preview_build_ab_timing`: replace `build_previews_streaming(&payload, w, h, &targets)` with `build_previews_streaming(OrfRowDecoder::new(&payload,w,h).unwrap(), w, h, (0,0), &targets)`.)

- [ ] **Step 3: Update the ORF call site in `src/lib.rs`** (`decode_orf_raw` streaming fork):

```rust
            let previews = raw_pipeline::stream_preview::build_previews_streaming(
                raw_pipeline::decompress::OrfRowDecoder::new(strip, w, h)
                    .map_err(|e| JsError::new(&e))?,
                w, h, (0, 0), &[(lb_w, lb_h), (thumb_w, thumb_h)],
            ).map_err(|e| JsError::new(&e))?;
```

- [ ] **Step 4: Run ORF regression (byte-identical previews) + wasm check**

Run: `ct "test --lib stream_preview::"`
Expected: PASS (fusion test unchanged output).
Run: `cd ..\..; $env:CARGO_TARGET_DIR="C:\Tmp\rcw-dng-wasm-target"; cargo check --target wasm32-unknown-unknown --lib`
Expected: `Finished`.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/stream_preview.rs src/lib.rs
git commit -m "refactor(stream_preview): build_previews_streaming generic over RawRowSource + phase"
```

---

## Task 3: Extract `decode_band_into` (DRY, byte-exact)

**Files:**
- Modify: `crates/raw-pipeline/src/dng.rs` (`decode_tiles`)

- [ ] **Step 1: Add a standalone band decoder** (place above `decode_tiles`):

```rust
/// Decode one row-tile band `tr` (comp=7 LJPEG tiles) into `band` (len == active_h*width,
/// rows [tr*tl, min((tr+1)*tl, height))). Shared by `decode_tiles` (parallel full-frame
/// blit) and the streaming `DngRowSource`. Byte-identical to the previous inline closure.
fn decode_band_into(
    data: &[u8], raw: &RawIfd, width: usize, height: usize,
    tw: usize, tl: usize, coltiles: usize, tr: usize, band: &mut [u16],
) -> Result<()> {
    let row_start = tr * tl;
    let row_end = ((tr + 1) * tl).min(height);
    let active_h = row_end - row_start;
    for tc in 0..coltiles {
        let idx = tr * coltiles + tc;
        let off = raw.tile_offsets[idx] as usize;
        let bc = raw.tile_byte_counts[idx] as usize;
        let end = off.checked_add(bc).ok_or_else(|| anyhow!("tile {idx} OOB"))?;
        let src = data.get(off..end).ok_or_else(|| anyhow!("tile {idx} OOB"))?;
        let col_start = tc * tw;
        let col_end = ((tc + 1) * tw).min(width);
        let active_w = col_end - col_start;
        ljpeg::decode_tile(src, band, col_start, width, active_w, active_h)
            .with_context(|| format!("tile r={tr} c={tc}"))?;
    }
    let _ = active_h;
    Ok(())
}
```

- [ ] **Step 2: Replace the closure in `decode_tiles`** with a call:

```rust
    let decode_band = |tr: usize, band: &mut [u16]| -> Result<()> {
        decode_band_into(data, raw, width, height, tw, tl, coltiles, tr, band)
    };
```
(Leave the `par_chunks_mut`/serial dispatch below it unchanged.)

- [ ] **Step 3: Run DNG tests (byte-exact regression)**

Run: `ct "test --lib dng::"`
Expected: PASS (existing DNG decode tests unchanged — the extraction is a pure refactor).

- [ ] **Step 4: Commit**

```bash
git add crates/raw-pipeline/src/dng.rs
git commit -m "refactor(dng): extract decode_band_into for reuse by streaming"
```

---

## Task 4: `DngRowSource` (comp=7 stream + comp=1 decode-then-dole) + metadata

**Files:**
- Modify: `crates/raw-pipeline/src/dng.rs` (add `DngMeta`, `DngRowSource`; a `dng_meta` helper)
- Test: `crates/raw-pipeline/tests/dng_stream.rs` (create)

- [ ] **Step 1: Add a metadata helper + struct** (near `decode_bytes_inner`, so both it and `DngRowSource` compute identical params). Extract the existing metadata math into:

```rust
/// Preview-path metadata (no raw). Mirrors the fields decode_bytes_inner derives.
pub struct DngMeta {
    pub width: usize,
    pub height: usize,
    pub cfa: Cfa,
    pub black: u16,
    pub white: u16,
    pub wb_r: f32,
    pub wb_b: f32,
    pub color_matrix: Option<[[f32; 3]; 3]>,
    pub iso: Option<u32>,
    pub orientation: u16,
}

fn dng_meta(state: &WalkState, raw: &RawIfd, width: usize, height: usize, cfa: Cfa) -> DngMeta {
    let wb_g_neutral = state.as_shot_neutral.map(|n| n[1]).unwrap_or(1.0);
    let wb_r_neutral = state.as_shot_neutral.map(|n| n[0]).unwrap_or(1.0);
    let wb_b_neutral = state.as_shot_neutral.map(|n| n[2]).unwrap_or(1.0);
    DngMeta {
        width, height, cfa,
        black: raw.black_level.unwrap_or(0),
        white: raw.white_level.unwrap_or(16383),
        wb_r: wb_g_neutral / wb_r_neutral.max(1e-6),
        wb_b: wb_g_neutral / wb_b_neutral.max(1e-6),
        color_matrix: choose_camera_to_srgb_matrix(
            state.forward_matrix_1, state.forward_matrix_2,
            state.color_matrix_1, state.color_matrix_2,
        ),
        iso: state.iso,
        orientation: state.orientation.unwrap_or(1),
    }
}

/// Map a parsed CFA to the (pr,pc) R-position phase used by demosaic_half_band.
pub fn cfa_phase(cfa: Cfa) -> (u8, u8) {
    match cfa {
        Cfa::Rggb => (0, 0),
        Cfa::Grbg => (0, 1),
        Cfa::Gbrg => (1, 0),
        Cfa::Bggr => (1, 1),
    }
}
```
(Refactor `decode_bytes_inner` to build its `DngImage` fields from `dng_meta(...)` too, so the two paths cannot drift. Keep behavior byte-identical — the values are the same expressions.)

- [ ] **Step 2: Add `DngRowSource`.** It parses via `load_dng`, then either sets up comp=7 band streaming or decodes the comp=1 full raw once. `next_row_into` doles rows top-to-bottom.

```rust
use crate::decompress::RawRowSource;

pub struct DngRowSource<'a> {
    data: &'a [u8],
    raw: RawIfd,
    meta: DngMeta,
    row: usize,
    // comp=7 tile-band streaming state
    tiled: bool,
    tw: usize,
    tl: usize,
    coltiles: usize,
    band_buf: Vec<u16>,   // active_h * width for the current band (comp=7)
    band_first: usize,    // first row of the buffered band
    band_rows: usize,     // rows currently in band_buf
    // comp=1 fallback: whole raw decoded up front
    full: Vec<u16>,
}

impl<'a> DngRowSource<'a> {
    /// Parse a DNG for streaming. Errors if unsupported (caller falls back to the full path):
    /// compression not in {1,7}, cps != 1, or dims exceed caps.
    pub fn new(data: &'a [u8]) -> Result<Self, String> {
        let (state, raw, le) = load_dng(data).map_err(|e| format!("DNG parse: {e}"))?;
        let width = raw.width as usize;
        let height = raw.height as usize;
        if width == 0 || height == 0 {
            return Err("DNG: zero dimension".into());
        }
        if (width as u64).saturating_mul(height as u64) > 200_000_000 {
            return Err(format!("DNG: implausible dimensions {width}×{height}"));
        }
        let cps = raw.samples_per_pixel.max(1) as usize;
        if cps != 1 {
            return Err(format!("DNG: streaming needs single-sample Bayer (cps={cps})"));
        }
        let cfa = match raw.cfa_pattern {
            Some([0, 1, 1, 2]) => Cfa::Rggb,
            Some([1, 2, 0, 1]) => Cfa::Gbrg,
            Some([1, 0, 2, 1]) => Cfa::Grbg,
            Some([2, 1, 1, 0]) => Cfa::Bggr,
            Some(p) => return Err(format!("DNG: unsupported CFA {p:?}")),
            None => Cfa::Rggb,
        };
        let meta = dng_meta(&state, &raw, width, height, cfa);

        match raw.compression {
            7 => {
                let tw = raw.tile_width.ok_or("DNG: missing TileWidth")? as usize;
                let tl = raw.tile_length.ok_or("DNG: missing TileLength")? as usize;
                if tw == 0 || tl == 0 {
                    return Err("DNG: zero TileWidth/TileLength".into());
                }
                let coltiles = width.div_ceil(tw);
                let rowtiles = height.div_ceil(tl);
                let expected = coltiles.checked_mul(rowtiles).ok_or("DNG: tile grid overflow")?;
                if raw.tile_offsets.len() != expected || raw.tile_byte_counts.len() != expected {
                    return Err("DNG: tile count mismatch".into());
                }
                Ok(Self {
                    data, raw, meta, row: 0, tiled: true, tw, tl, coltiles,
                    band_buf: Vec::new(), band_first: 0, band_rows: 0, full: Vec::new(),
                })
            }
            1 => {
                // Uncompressed: decode the whole raw once (cheap, no entropy) and dole rows.
                // Reuses the crate's endianness/strip/tile-aware unpack. Avoids the full-res
                // RGB (the dominant DNG buffer); keeps the raw (~3.5× peak, vs ~14× tiled).
                let mut full = vec![0u16; width * height];
                decode_uncompressed(data, &raw, width, height, le, &mut full)
                    .map_err(|e| format!("DNG uncompressed: {e}"))?;
                Ok(Self {
                    data, raw, meta, row: 0, tiled: false, tw: 0, tl: 0, coltiles: 0,
                    band_buf: Vec::new(), band_first: 0, band_rows: 0, full,
                })
            }
            c => Err(format!("DNG: compression {c} not streamable")),
        }
    }

    pub fn phase(&self) -> (u8, u8) { cfa_phase(self.meta.cfa) }
    pub fn meta(&self) -> &DngMeta { &self.meta }
}

impl RawRowSource for DngRowSource<'_> {
    fn width(&self) -> usize { self.meta.width }
    fn height(&self) -> usize { self.meta.height }

    fn next_row_into(&mut self, dst: &mut [u16]) -> Result<bool, String> {
        let (w, h) = (self.meta.width, self.meta.height);
        if self.row >= h {
            return Ok(false);
        }
        let r = self.row;
        if self.tiled {
            // (Re)fill the band buffer when r leaves the current band.
            if self.band_rows == 0 || r >= self.band_first + self.band_rows {
                let tr = r / self.tl;
                let row_start = tr * self.tl;
                let active_h = ((tr + 1) * self.tl).min(h) - row_start;
                self.band_buf.resize(active_h * w, 0);
                decode_band_into(
                    self.data, &self.raw, w, h, self.tw, self.tl, self.coltiles, tr, &mut self.band_buf,
                ).map_err(|e| format!("DNG band {tr}: {e}"))?;
                self.band_first = row_start;
                self.band_rows = active_h;
            }
            let local = r - self.band_first;
            dst[..w].copy_from_slice(&self.band_buf[local * w..local * w + w]);
        } else {
            dst[..w].copy_from_slice(&self.full[r * w..r * w + w]);
        }
        self.row += 1;
        Ok(true)
    }
}
```

- [ ] **Step 2b: Register the streaming test binary** — nothing to add in `lib.rs` for `DngRowSource` (it's `pub` in `dng.rs`, already `pub mod dng`).

- [ ] **Step 3: Write the byte-exact decode test** (create `crates/raw-pipeline/tests/dng_stream.rs`):

```rust
//! DNG streaming decode: DngRowSource rows must equal the full decode_bytes().raw.
//! Fixture-gated (comp=7 real DNG); skips gracefully in CI without the asset.
use raw_pipeline::decompress::RawRowSource;
use raw_pipeline::dng;

fn find_dng() -> Option<Vec<u8>> {
    for p in [
        r"C:\Foo\raw-converter-wasm\.timing-source\PXL_20260527_180319603.RAW-02.ORIGINAL.dng",
        "PXL_20260527_180319603.RAW-02.ORIGINAL.dng",
    ] {
        if let Ok(d) = std::fs::read(p) { return Some(d); }
    }
    None
}

#[test]
fn dng_rowsource_rows_equal_full_decode() {
    let Some(data) = find_dng() else {
        eprintln!("skip: no DNG fixture");
        return;
    };
    let full = dng::decode_bytes(&data).expect("full decode");
    let mut src = dng::DngRowSource::new(&data).expect("streaming parse");
    assert_eq!(src.width(), full.width);
    assert_eq!(src.height(), full.height);
    let w = full.width;
    let mut rowbuf = vec![0u16; w];
    let mut streamed = Vec::with_capacity(full.raw.len());
    while src.next_row_into(&mut rowbuf).expect("row") {
        streamed.extend_from_slice(&rowbuf);
    }
    assert_eq!(streamed.len(), full.raw.len());
    assert!(streamed == full.raw, "streamed rows != full decode raw");
}
```

- [ ] **Step 4: Run the byte-exact decode test** (locally, fixture present)

Run: `ct "test --test dng_stream -- --nocapture"`
Expected: PASS (or "skip: no DNG fixture" if the asset is absent — then run on a machine that has it before landing).

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/dng.rs crates/raw-pipeline/tests/dng_stream.rs
git commit -m "feat(dng): DngRowSource (comp=7 tile-band stream, comp=1 dole) + meta"
```

---

## Task 5: Gate + wire into `decode_dng_raw`

**Files:**
- Modify: `src/lib.rs` (`DngDecoded`, `decode_dng_raw`, `process_dng_impl`)

- [ ] **Step 1: Add preview fields to `DngDecoded`** (mirror `OrfDecoded`):

```rust
struct DngDecoded {
    rgb16: Vec<u16>,
    aw: usize,
    ah: usize,
    params: pipeline::PipelineParams,
    color_matrix_flat: [f32; 9],
    decode_ms: f64,
    demosaic_ms: f64,
    orientation: u16,
    make: String,
    model: String,
    iso: u32,
    // Streaming preview cache (empty unless the streaming fast path filled it).
    lb_packed: Vec<u8>,
    lb_w: usize,
    lb_h: usize,
    thumb_packed: Vec<u8>,
    thumb_w: usize,
    thumb_h: usize,
    fast_preview: bool,
}
```
Update the existing `Ok(DngDecoded { ... })` in the full path to set `lb_packed: Vec::new(), lb_w: 0, lb_h: 0, thumb_packed: Vec::new(), thumb_w: 0, thumb_h: 0, fast_preview: false,`.

- [ ] **Step 2: Add the streaming fork at the top of `decode_dng_raw`**, right after `let data`/`output_flags` are in scope and before `let img = raw_pipeline::dng::decode_bytes(data)`:

```rust
    // Streaming preview-only fast path: previews requested, full-res output not. Build
    // superpixel previews band-by-band without the full raw / full-res MHC RGB. Falls
    // through to the full-MHC path on any unsupported case (compression, CFA, dims).
    let need_previews = output_flags & (OUT_LIGHTBOX | OUT_THUMB) != 0;
    let need_full_rgb = output_flags & (OUT_FULL_RGB8 | OUT_FULL_16) != 0;
    if need_previews && !need_full_rgb {
        if let Ok(src) = raw_pipeline::dng::DngRowSource::new(data) {
            let m = src.meta();
            let (w, h) = (m.width, m.height);
            if (w as u32) <= 8192 && (h as u32) <= 8192 && w.checked_mul(h).unwrap_or(usize::MAX) <= 50_000_000 {
                let phase = src.phase();
                let (lb_w, lb_h) = target_dims(w, h, 1800);
                let (thumb_w, thumb_h) = target_dims(w, h, 360);
                let mut params = pipeline::PipelineParams::default_olympus();
                params.black = m.black;
                params.white = m.white;
                params.wb_r = m.wb_r;
                params.wb_b = m.wb_b;
                params.color_matrix = m.color_matrix;
                let color_matrix_flat: [f32; 9] = {
                    let mm = params.color_matrix.unwrap_or(pipeline::CAM_TO_SRGB);
                    [mm[0][0], mm[0][1], mm[0][2], mm[1][0], mm[1][1], mm[1][2], mm[2][0], mm[2][1], mm[2][2]]
                };
                let (orientation, iso) = (m.orientation, m.iso.unwrap_or(100));
                let t = now_ms();
                let previews = raw_pipeline::stream_preview::build_previews_streaming(
                    src, w, h, phase, &[(lb_w, lb_h), (thumb_w, thumb_h)],
                ).map_err(|e| JsError::new(&format!("DNG stream: {e}")))?;
                let decode_ms = now_ms() - t;
                let mut it = previews.into_iter();
                let lb_packed = it.next().unwrap_or_default();
                let thumb_packed = it.next().unwrap_or_default();
                return Ok(DngDecoded {
                    rgb16: Vec::new(), aw: w, ah: h, params, color_matrix_flat,
                    decode_ms, demosaic_ms: 0.0, orientation,
                    make: String::new(), model: String::new(), iso,
                    lb_packed, lb_w, lb_h, thumb_packed, thumb_w, thumb_h, fast_preview: true,
                });
            }
        }
    }
```

- [ ] **Step 3: Use the cached previews in `process_dng_impl`.** Destructure the new fields, and short-circuit the lb/thumb downscale when `fast_preview`:

```rust
    let DngDecoded {
        mut rgb16, aw, ah, mut params, color_matrix_flat, decode_ms, demosaic_ms,
        orientation, make, model, iso,
        lb_packed, lb_w, lb_h, thumb_packed, thumb_w, thumb_h, fast_preview,
    } = decoded;
```
Then replace the lb/thumb computation blocks:

```rust
    let (lb_w2, lb_h2) = target_dims(aw, ah, 1800);
    let (rgb16_lb, out_lb_w, out_lb_h) = if fast_preview {
        (lb_packed.clone(), lb_w, lb_h)
    } else if output_flags & OUT_LIGHTBOX != 0 {
        (downscale_rgb16_impl(&rgb16, aw, ah, lb_w2, lb_h2), lb_w2, lb_h2)
    } else {
        (vec![], 0, 0)
    };
    let (thumb_w2, thumb_h2) = target_dims(aw, ah, 360);
    let (rgb16_thumb, out_thumb_w, out_thumb_h) = if fast_preview {
        (thumb_packed, thumb_w, thumb_h)
    } else if output_flags & OUT_THUMB != 0 {
        let thumb = if output_flags & OUT_LIGHTBOX != 0 {
            downscale_packed_rgb16_le(&rgb16_lb, lb_w2, lb_h2, thumb_w2, thumb_h2)
        } else {
            downscale_rgb16_impl(&rgb16, aw, ah, thumb_w2, thumb_h2)
        };
        (thumb, thumb_w2, thumb_h2)
    } else {
        (vec![], 0, 0)
    };
```
(`fast_preview` implies `rgb16` is empty and `need_full_rgb` was false, so the downstream full-RGB8/full16 branches are naturally skipped — they gate on `output_flags & OUT_FULL_*` which is 0 here. Verify that path treats empty `rgb16` safely: the `OUT_FULL_*` blocks are not entered, so `rgb16` is only moved/dropped.)

- [ ] **Step 4: Add the gate-helper reuse** — the ORF `should_stream_previews` already exists; DNG's gate is inline (`need_previews && !need_full_rgb`) because DNG has no `wb_from_camera` condition. No new helper needed.

- [ ] **Step 5: Build both targets**

Run (native, compiles + runs the small lib tests): `ct "test --lib stream_gate_tests"` → PASS (unchanged).
Run (wasm): `cd ..\..; $env:CARGO_TARGET_DIR="C:\Tmp\rcw-dng-wasm-target"; cargo check --target wasm32-unknown-unknown --lib` → `Finished`.

- [ ] **Step 6: Commit**

```bash
git add src/lib.rs
git commit -m "feat(dng): stream superpixel previews when preview-only (no full raw/RGB)"
```

---

## Task 6: Verify — peak memory, throughput, suites, docs

**Files:**
- Modify: `crates/raw-pipeline/tests/dng_stream.rs` (add peak-mem probe)
- Modify: `Questions_deferred.md`

- [ ] **Step 1: Add a fixture-gated DNG peak-mem probe** to `tests/dng_stream.rs`. Own counting allocator (separate test binary):

```rust
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
struct Counting;
static CUR: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() { let c = CUR.fetch_add(l.size(), Ordering::Relaxed) + l.size(); PEAK.fetch_max(c, Ordering::Relaxed); }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) { CUR.fetch_sub(l.size(), Ordering::Relaxed); System.dealloc(p, l); }
}
#[global_allocator]
static A: Counting = Counting;

#[test]
fn dng_peak_mem_stream_vs_full() {
    let Some(data) = find_dng() else { eprintln!("skip: no DNG fixture"); return; };
    // full path working set: full raw + full-res MHC RGB
    let base_full = CUR.load(Ordering::Relaxed);
    PEAK.store(base_full, Ordering::Relaxed);
    {
        let img = dng::decode_bytes(&data).unwrap();
        let phase = dng::cfa_phase(img.cfa);
        let (pr, pc) = (phase.0, phase.1);
        let rgb = raw_pipeline::demosaic::demosaic_bayer_mhc(&img.raw, img.width, img.height, (pr, pc)).unwrap();
        std::hint::black_box((&img.raw, &rgb));
    }
    let full_peak = PEAK.load(Ordering::Relaxed) - base_full;

    let base_s = CUR.load(Ordering::Relaxed);
    PEAK.store(base_s, Ordering::Relaxed);
    {
        let src = dng::DngRowSource::new(&data).unwrap();
        let (w, h, phase) = (src.width(), src.height(), src.phase());
        let prev = raw_pipeline::stream_preview::build_previews_streaming(src, w, h, phase, &[(1800, 1200), (360, 240)]).unwrap();
        std::hint::black_box(&prev);
    }
    let stream_peak = PEAK.load(Ordering::Relaxed) - base_s;
    println!("DNG working-set peak: full={} stream={} ratio={:.3}", full_peak, stream_peak, stream_peak as f64 / full_peak as f64);
    // comp=7 target ~1/14; comp=1 ~1/3.5. Assert a robust < 1/2 (covers both).
    assert!(stream_peak * 2 < full_peak, "stream peak {} not < full/2 {}", stream_peak, full_peak);
}
```
(`demosaic_bayer_mhc` phase arg is `(u8,u8)` — matches `decode_dng_raw`'s usage.)

- [ ] **Step 2: Run the probe** (locally)

Run: `ct "test --test dng_stream -- --nocapture"`
Expected: prints a ratio well under 0.5 for the comp=7 fixture; assertion holds. (Skips if no fixture.)

- [ ] **Step 3: Full suites + wasm**

Run: `ct "test --lib"` → all pass (ORF streaming + demosaic + decompress unaffected).
Run: `ct "test --test dng_stream"` → pass/skip.
Run: `ct "test --test stream_peak_mem"` → pass (ORF probe unaffected).
Run: `cd ..\..; $env:CARGO_TARGET_DIR="C:\Tmp\rcw-dng-wasm-target"; cargo check --target wasm32-unknown-unknown` → `Finished`.

- [ ] **Step 4: Update `Questions_deferred.md`** — note DNG streaming implemented (link spec+plan); CR2 remains deferred (vertical-slice blocker).

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/tests/dng_stream.rs Questions_deferred.md
git commit -m "test(dng): peak-mem probe; docs — DNG streaming done, CR2 deferred"
```

---

## Self-Review

- **Spec coverage:** §5.1 demosaic phase → Task 1; §5.2 generic fusion → Task 2; §5.3 DngRowSource (comp 7+1) → Tasks 3+4; §5.4 gate + DngDecoded/process_dng_impl → Task 5; §8 verification (decode byte-exact, phase, fusion, ORF regression, peak-mem, wasm) → Tasks 1/2/4/6. Deviation (comp=1 = decode-then-dole) documented in the header.
- **Placeholder scan:** all code steps concrete; fixture-gated tests skip explicitly rather than fake-pass; the only "verify manually where fixture present" note is inherent to needing a real DNG.
- **Type consistency:** `demosaic_half_band(raw, w, k, phase, out)`, `build_previews_streaming<S: RawRowSource>(source, w, h, phase, targets)`, `DngRowSource::{new, phase, meta, width, height, next_row_into}`, `DngMeta` fields, `cfa_phase(Cfa)->(u8,u8)`, `decode_band_into(...)` are used consistently across tasks. `demosaic_bayer_mhc(raw,w,h,(u8,u8))` matches existing usage in `decode_dng_raw`.

## Known risks for the executor

- **Fixture:** comp=7 byte-exact + peak-mem tests need the real DNG at the known path; they skip otherwise. Run them on this machine (fixture present) before landing. **No comp=1 fixture** — comp=1's decode-then-dole reuses `decode_uncompressed` (already tested in dng.rs), and its dole path is trivial; a comp=1 container round-trip test is deferred until a fixture exists.
- **`process_dng_impl` empty-`rgb16` safety** (Task 5 Step 3): confirm the `OUT_FULL_*` branches are truly skipped when `fast_preview` (they gate on `OUT_FULL_*`, which is 0 on this path) so the empty `rgb16` is never demosaiced/toned.
- **`load_dng` / `decode_uncompressed` / `choose_camera_to_srgb_matrix` / `WalkState` / `RawIfd` visibility:** all are in `dng.rs` (same module as `DngRowSource`) — no visibility changes needed. `demosaic_bayer_mhc` and `cfa_phase` must be `pub` for the integration test.
