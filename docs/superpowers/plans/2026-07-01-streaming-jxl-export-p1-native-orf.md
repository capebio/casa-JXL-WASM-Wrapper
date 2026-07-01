# Streaming Full-Res JXL Export — Phase 1 (Native ORF) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native ORF→JXL full-res export that fuses decode→demosaic→tone→encode over a sliding ~2048-row super-tile band, at O(band) peak memory, producing bytes byte-identical to the whole-frame export.

**Architecture:** Generalize the proven chunked encoder over a `ChunkedColorSource` trait (`WholeImageSource` + `StreamingExportSource`). `StreamingExportSource` drives `OrfRowDecoder` → `demosaic_rggb_mhc_band` (halo) → `process_into_auto` (per-pixel tone) forward into a rolling RGB8 window; libjxl pulls super-tiles from it (validated monotonic). Byte-exactness reduces to demosaic_band==whole + tone_band==whole + the already-proven encode_chunked==whole.

**Tech Stack:** Rust, `raw-pipeline` (`jxl-codec` feature → libjxl FFI), MSVC toolchain for native tests. Scope: tone-only export (no NR/unsharp spatial post — that's a future band-halo extension).

**Reference spec:** `docs/superpowers/specs/2026-07-01-streaming-jxl-export-design.md`

**Test env (MSVC, from `crates/raw-pipeline`):**
```powershell
$env:PATH="C:\Program Files\LLVM\bin;$env:PATH"; $env:LLVMInstallDir="C:\Program Files\LLVM"; $env:LLVMToolsVersion="22"
$env:CARGO_TARGET_DIR="C:\Tmp\rcw-dng-msvc-target"
$vc="C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
function ct($f){ cmd /c "call `"$vc`" >nul && cargo +stable-x86_64-pc-windows-msvc $f" }
```
Tests need libjxl: `ct "test --no-default-features --features jxl-codec --lib <filter>"`. `synth_payload` (a valid ORF strip bitstream, no container) is `pub(crate)` in `decompress::tests` + bridged via `decompress::tests_synth_payload`.

---

## File Structure
| File | Responsibility | Action |
|------|----------------|--------|
| `crates/raw-pipeline/src/jxl_casaencoder.rs` | `ChunkedColorSource` trait; `encode_chunked(&mut dyn ..)`; `WholeImageSource`; refactor `encode_chunked_rgb8` to use them | Modify |
| `crates/raw-pipeline/src/stream_export.rs` | `StreamingExportSource` + `export_jxl_streaming_from_strip` + `export_orf_jxl_streaming` | Create |
| `crates/raw-pipeline/src/lib.rs` | `pub mod stream_export;` | Modify |
| tests | in the two src files + a `tests/stream_export_peak.rs` probe | Create/Modify |

---

## Task 1: `ChunkedColorSource` trait + generalize the encoder

Refactor the proven `encode_chunked_rgb8` into a source-driven `encode_chunked`, keeping byte-identical output.

**Files:** Modify `crates/raw-pipeline/src/jxl_casaencoder.rs`

- [ ] **Step 1: Add the trait + `WholeImageSource`** (near `encode_chunked_rgb8`):

```rust
/// A pull source of interleaved u8 color pixels for the chunked encoder. libjxl calls
/// `rect` synchronously during encode, in monotonic-ypos order; `rect` may drive lazy
/// decode. `num_channels` is 3 (RGB) here.
pub trait ChunkedColorSource {
    fn num_channels(&self) -> u32;
    /// Pointer to pixel data for rect [xpos,ypos, xsize×ysize] + byte stride between rows.
    fn rect(&mut self, xpos: usize, ypos: usize, xsize: usize, ysize: usize) -> (*const u8, usize);
}

/// Whole-image-in-RAM source (today's `encode_chunked_rgb8` behavior).
pub struct WholeImageSource<'a> { pub data: &'a [u8], pub width: usize }
impl ChunkedColorSource for WholeImageSource<'_> {
    fn num_channels(&self) -> u32 { 3 }
    fn rect(&mut self, xpos: usize, ypos: usize, _xs: usize, _ys: usize) -> (*const u8, usize) {
        let stride = self.width * 3;
        unsafe { (self.data.as_ptr().add(ypos * stride + xpos * 3), stride) }
    }
}
```

- [ ] **Step 2: Add `encode_chunked` (source-driven)** — same FFI as `encode_chunked_rgb8` but the input-source callbacks bridge to `&mut dyn ChunkedColorSource`. Add this fn; then make `encode_chunked_rgb8` call it.

```rust
pub fn encode_chunked(
    w: u32, h: u32, distance: f32, effort: i64,
    src: &mut dyn ChunkedColorSource, out: &mut Vec<u8>,
) -> Result<(), EncodeError> {
    struct Out<'a> { buf: &'a mut Vec<u8>, pos: usize, high: usize, final_pos: Option<usize> }

    unsafe extern "C" fn color_pf(op: *mut c_void, pf: *mut ffi::JxlPixelFormat) {
        let s = &mut *(op as *mut &mut dyn ChunkedColorSource);
        (*pf).num_channels = s.num_channels();
        (*pf).data_type = ffi::JxlDataType::JXL_TYPE_UINT8;
        (*pf).endianness = ffi::JxlEndianness::JXL_NATIVE_ENDIAN;
        (*pf).align = 0;
    }
    unsafe extern "C" fn color_at(op: *mut c_void, x: usize, y: usize, xs: usize, ys: usize, ro: *mut usize) -> *const c_void {
        let s = &mut *(op as *mut &mut dyn ChunkedColorSource);
        let (p, stride) = s.rect(x, y, xs, ys);
        *ro = stride;
        p as *const c_void
    }
    unsafe extern "C" fn src_release(_op: *mut c_void, _b: *const c_void) {}
    unsafe extern "C" fn out_get(op: *mut c_void, size: *mut usize) -> *mut c_void {
        let o = &mut *(op as *mut Out);
        let want = (*size).max(1 << 16);
        if o.buf.len() < o.pos + want { o.buf.resize(o.pos + want, 0); }
        *size = o.buf.len() - o.pos;
        o.buf.as_mut_ptr().add(o.pos) as *mut c_void
    }
    unsafe extern "C" fn out_release(op: *mut c_void, wn: usize) { let o=&mut *(op as *mut Out); o.pos+=wn; if o.pos>o.high {o.high=o.pos;} }
    unsafe extern "C" fn out_seek(op: *mut c_void, p: u64) { (*(op as *mut Out)).pos = p as usize; }
    unsafe extern "C" fn out_final(op: *mut c_void, p: u64) { (*(op as *mut Out)).final_pos = Some(p as usize); }

    unsafe {
        let enc = ffi::JxlEncoderCreate(ptr::null());
        if enc.is_null() { return Err(EncodeError::Create); }
        let mut info = std::mem::MaybeUninit::<ffi::JxlBasicInfo>::uninit();
        ffi::JxlEncoderInitBasicInfo(info.as_mut_ptr());
        let mut info = info.assume_init();
        info.xsize = w; info.ysize = h; info.bits_per_sample = 8; info.exponent_bits_per_sample = 0;
        info.num_color_channels = 3; info.num_extra_channels = 0; info.uses_original_profile = JXL_FALSE;
        if ffi::JxlEncoderSetBasicInfo(enc, &info) != ffi::JxlEncoderStatus::JXL_ENC_SUCCESS { ffi::JxlEncoderDestroy(enc); return Err(EncodeError::Jxl("SetBasicInfo".into())); }
        let mut ce = std::mem::MaybeUninit::<ffi::JxlColorEncoding>::uninit();
        ffi::JxlColorEncodingSetToSRGB(ce.as_mut_ptr(), JXL_FALSE);
        let ce = ce.assume_init();
        ffi::JxlEncoderSetColorEncoding(enc, &ce);
        let fs = ffi::JxlEncoderFrameSettingsCreate(enc, ptr::null());
        use ffi::JxlEncoderFrameSettingId as FS;
        ffi::JxlEncoderFrameSettingsSetOption(fs, FS::JXL_ENC_FRAME_SETTING_EFFORT, effort);
        ffi::JxlEncoderFrameSettingsSetOption(fs, FS::JXL_ENC_FRAME_SETTING_BUFFERING, 2);
        ffi::JxlEncoderFrameSettingsSetOption(fs, FS::JXL_ENC_FRAME_SETTING_OUTPUT_MODE, 0);
        ffi::JxlEncoderFrameSettingsSetOption(fs, FS::JXL_ENC_FRAME_SETTING_USE_FULL_IMAGE_HEURISTICS, 0);
        ffi::JxlEncoderSetFrameDistance(fs, distance);

        let base = out.len();
        let mut ostate = Out { buf: out, pos: base, high: base, final_pos: None };
        let op = ffi::JxlEncoderOutputProcessor { opaque: &mut ostate as *mut _ as *mut c_void,
            get_buffer: Some(out_get), release_buffer: Some(out_release), seek: Some(out_seek), set_finalized_position: Some(out_final) };
        if ffi::JxlEncoderSetOutputProcessor(enc, op) != ffi::JxlEncoderStatus::JXL_ENC_SUCCESS { ffi::JxlEncoderDestroy(enc); return Err(EncodeError::Jxl("SetOutputProcessor".into())); }

        let mut dynsrc: &mut dyn ChunkedColorSource = src;
        let source = ffi::JxlChunkedFrameInputSource { opaque: &mut dynsrc as *mut _ as *mut c_void,
            get_color_channels_pixel_format: Some(color_pf), get_color_channel_data_at: Some(color_at),
            get_extra_channel_pixel_format: None, get_extra_channel_data_at: None, release_buffer: Some(src_release) };
        let st = ffi::JxlEncoderAddChunkedFrame(fs, JXL_TRUE, source);
        let code = encoder_error_code(enc);
        ffi::JxlEncoderDestroy(enc);
        if st != ffi::JxlEncoderStatus::JXL_ENC_SUCCESS { return Err(EncodeError::Jxl(format!("AddChunkedFrame (code {code})"))); }
        let end = ostate.final_pos.unwrap_or(ostate.high.max(ostate.pos));
        out.truncate(end);
        Ok(())
    }
}
```

- [ ] **Step 3: Reimplement `encode_chunked_rgb8` as a thin wrapper** (delete its FFI body, keep the signature):

```rust
pub fn encode_chunked_rgb8(rgb: &[u8], w: u32, h: u32, distance: f32, effort: i64) -> Result<Vec<u8>, EncodeError> {
    assert_eq!(rgb.len(), w as usize * h as usize * 3, "rgb must be w*h*3");
    let mut src = WholeImageSource { data: rgb, width: w as usize };
    let mut out = Vec::new();
    encode_chunked(w, h, distance, effort, &mut src, &mut out)?;
    Ok(out)
}
```

- [ ] **Step 4: Run the density bench (byte-identical output preserved through the refactor)**

Run: `ct "run --release --no-default-features --features jxl-codec --example jxl_stream_encode_density"`
Expected: `density: stream is +0.00% vs whole` — unchanged (the refactor must not alter output).

- [ ] **Step 5: Commit**
```bash
git add crates/raw-pipeline/src/jxl_casaencoder.rs
git commit -m "refactor(encoder): ChunkedColorSource trait + encode_chunked over it (byte-exact)"
```

---

## Task 2: tone-band equivalence (safety check before fusion)

**Files:** Test in `crates/raw-pipeline/src/pipeline.rs` (`mod tests`)

- [ ] **Step 1: Write the failing test** — `process_into_auto` on a row-band == the matching slice of a whole-frame call (proves per-pixel band-safety, the spec §7 caveat).

```rust
    #[test]
    fn tone_band_equals_whole() {
        let (w, h) = (64usize, 40usize);
        let rgb16: Vec<u16> = (0..(w * h * 3)).map(|i| ((i * 29 + 7) & 0xffff) as u16).collect();
        let params = PipelineParams::default_olympus();
        let mut whole = vec![0u8; w * h * 3];
        process_into_auto(&rgb16, &params, &mut whole);
        // process in 8-row bands; each band's output must equal the whole slice.
        for b0 in (0..h).step_by(8) {
            let b1 = (b0 + 8).min(h);
            let mut band = vec![0u8; (b1 - b0) * w * 3];
            process_into_auto(&rgb16[b0 * w * 3..b1 * w * 3], &params, &mut band);
            assert_eq!(band, whole[b0 * w * 3..b1 * w * 3], "band {b0}..{b1}");
        }
    }
```

- [ ] **Step 2: Run — expect PASS** (process_into_auto is per-pixel; this documents+locks it)

Run: `ct "test --no-default-features --features jxl-codec --lib tone_band_equals_whole"`
Expected: PASS. If it FAILS, `process_into_auto` has whole-frame state → STOP: the design's tone-band assumption is void; revisit (tone would stay whole-frame).

- [ ] **Step 3: Commit**
```bash
git add crates/raw-pipeline/src/pipeline.rs
git commit -m "test(pipeline): lock process_into_auto per-pixel band-safety"
```

---

## Task 3: `StreamingExportSource` (sliding fused pipeline) + module

**Files:** Create `crates/raw-pipeline/src/stream_export.rs`; Modify `crates/raw-pipeline/src/lib.rs`

- [ ] **Step 1: Register the module.** In `crates/raw-pipeline/src/lib.rs` add:
```rust
#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
pub mod stream_export;
```

- [ ] **Step 2: Create `stream_export.rs` with the source.**

```rust
//! Fused streaming full-res JXL export: OrfRowDecoder → demosaic_rggb_mhc_band → tone,
//! served to the chunked encoder through a rolling ~2048-row RGB8 window. Byte-identical
//! to the whole-frame export at O(band) peak. Native + jxl-codec only.
#![cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]

use crate::decompress::OrfRowDecoder;
use crate::demosaic::demosaic_rggb_mhc_band;
use crate::jxl_casaencoder::{encode_chunked, ChunkedColorSource, EncodeError};
use crate::pipeline::{self, PipelineParams};

/// Forward-only fused source. Maintains a rolling RGB8 window [win_first, win_first+win_rows)
/// and a 2-row raw halo carried across extends. Requires monotonic ypos (validated).
pub struct StreamingExportSource<'a> {
    dec: OrfRowDecoder<'a>,
    w: usize,
    h: usize,
    params: PipelineParams,
    win_first: usize,     // global row index of rgb8[0..]
    win_rows: usize,      // rows currently in rgb8
    rgb8: Vec<u8>,        // win_rows * w * 3 (front-dropped as ypos advances)
    produced: usize,      // global rows produced so far (== win_first + win_rows)
    // raw halo: the last up-to-2 decoded raw rows above `produced` (for the next band's top).
    halo: Vec<u16>,       // 0, w, or 2*w
    halo_rows: usize,
}

impl<'a> StreamingExportSource<'a> {
    pub fn new(strip: &'a [u8], w: usize, h: usize, params: PipelineParams) -> Result<Self, String> {
        let dec = OrfRowDecoder::new(strip, w, h)?;
        Ok(Self { dec, w, h, params, win_first: 0, win_rows: 0, rgb8: Vec::new(),
                  produced: 0, halo: Vec::new(), halo_rows: 0 })
    }

    /// Materialize RGB8 rows forward until `produced >= target` (clamped to h).
    fn extend_to(&mut self, target: usize) -> Result<(), String> {
        let target = target.min(self.h);
        if self.produced >= target { return Ok(()); }
        let w = self.w;
        let first = self.produced;
        let n = target - first;

        // Decode this chunk's raw rows + 2 lookahead (bottom halo), clamped at image end.
        let mut rowbuf = vec![0u16; w];
        let mut chunk_raw: Vec<u16> = Vec::with_capacity((n + 2) * w);
        let mut decoded = 0usize;
        while decoded < n + 2 && (first + decoded) < self.h {
            if !self.dec.next_row_into(&mut rowbuf)? { break; }
            chunk_raw.extend_from_slice(&rowbuf);
            decoded += 1;
        }
        // Build ctx = [top halo (2 rows, replicated at frame top)] ++ chunk_raw ++
        // [bottom halo (last row replicated if we hit image end)].
        let mut ctx: Vec<u16> = Vec::with_capacity((2 + decoded + 2) * w);
        // top halo
        if first == 0 {
            // replicate row 0 twice (matches whole demosaic clamp c-1/c-2 -> 0)
            ctx.extend_from_slice(&chunk_raw[0..w]);
            ctx.extend_from_slice(&chunk_raw[0..w]);
        } else {
            debug_assert_eq!(self.halo_rows, 2, "interior extend needs 2 carried halo rows");
            ctx.extend_from_slice(&self.halo);
        }
        ctx.extend_from_slice(&chunk_raw[..decoded * w]);
        // bottom halo: if we decoded fewer than n+2 (image end), replicate last row.
        let have_bottom = decoded.saturating_sub(n); // 0,1,2 lookahead rows already in ctx tail
        let last = &chunk_raw[(decoded - 1) * w..decoded * w];
        for _ in have_bottom..2 { ctx.extend_from_slice(last); }

        // Demosaic the n band rows (local start = halo=2, global phase = first) then tone.
        let mut rgb16 = vec![0u16; n * w * 3];
        demosaic_rggb_mhc_band(&ctx, w, ctx.len() / w, 2, first, 0, n, &mut rgb16)?;
        let mut rgb8 = vec![0u8; n * w * 3];
        pipeline::process_into_auto(&rgb16, &self.params, &mut rgb8);

        self.rgb8.extend_from_slice(&rgb8);
        self.win_rows += n;
        self.produced += n;
        // carry the last 2 raw rows of this chunk as the next extend's top halo.
        self.halo.clear();
        let carry_from = decoded.saturating_sub(2);
        self.halo.extend_from_slice(&chunk_raw[carry_from * w..decoded * w]);
        self.halo_rows = decoded.min(2);
        Ok(())
    }

    fn drop_front_to(&mut self, y: usize) {
        if y > self.win_first {
            let drop = (y - self.win_first) * self.w * 3;
            self.rgb8.drain(0..drop.min(self.rgb8.len()));
            self.win_rows -= (y - self.win_first).min(self.win_rows);
            self.win_first = y;
        }
    }
}

impl ChunkedColorSource for StreamingExportSource<'_> {
    fn num_channels(&self) -> u32 { 3 }
    fn rect(&mut self, xpos: usize, ypos: usize, _xs: usize, ysize: usize) -> (*const u8, usize) {
        assert!(ypos >= self.win_first, "non-monotonic pull ypos {ypos} < win_first {}", self.win_first);
        self.drop_front_to(ypos);
        self.extend_to(ypos + ysize).expect("streaming decode/demosaic failed");
        let stride = self.w * 3;
        let local = ypos - self.win_first;
        let off = local * stride + xpos * 3;
        (unsafe { self.rgb8.as_ptr().add(off) }, stride)
    }
}

/// Export a full-res JXL from an ORF strip bitstream (no container) — the testable core.
pub fn export_jxl_streaming_from_strip(
    strip: &[u8], w: usize, h: usize, params: PipelineParams, distance: f32, effort: i64, out: &mut Vec<u8>,
) -> Result<(), String> {
    let mut src = StreamingExportSource::new(strip, w, h, params)?;
    encode_chunked(w as u32, h as u32, distance, effort, &mut src, out).map_err(|e| format!("{e:?}"))
}
```

- [ ] **Step 3: Write the byte-exact source test** (whole demosaic+tone vs the source pulled over the whole image). Add to `stream_export.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{decompress, demosaic};

    #[test]
    fn streaming_source_matches_whole() {
        for (w, h) in [(64usize, 96usize), (66, 130), (17, 300)] {
            let strip = decompress::tests_synth_payload(w, h, 0xEE11);
            // reference: whole decode -> whole MHC demosaic -> whole tone
            let raw = decompress::decompress(&strip, w, h).unwrap();
            let rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).unwrap();
            let params = pipeline::PipelineParams::default_olympus();
            let mut want = vec![0u8; w * h * 3];
            pipeline::process_into_auto(&rgb16, &params, &mut want);

            // pull the source in monotonic bands mimicking libjxl (border overlap included).
            let mut src = StreamingExportSource::new(&strip, w, h, params.clone()).unwrap();
            let mut got = vec![0u8; w * h * 3];
            let band = 64usize;
            let mut y = 0usize;
            while y < h {
                let ys = (band + 2).min(h - y); // +2 border overlap like the real pulls
                let (p, stride) = src.rect(0, y, w, ys);
                for r in 0..ys.min(h - y) {
                    // only copy rows not already written (handle overlap)
                    let gy = y + r;
                    if gy * w * 3 >= (y * w * 3) { }
                    unsafe {
                        let srow = std::slice::from_raw_parts(p.add(r * stride), w * 3);
                        got[gy * w * 3..gy * w * 3 + w * 3].copy_from_slice(srow);
                    }
                }
                y += band;
            }
            assert_eq!(got, want, "{}x{}", w, h);
        }
    }
}
```

- [ ] **Step 4: Run**

Run: `ct "test --no-default-features --features jxl-codec --lib streaming_source_matches_whole"`
Expected: PASS (source RGB8 byte-identical to whole demosaic+tone, across sizes incl. odd width/height + border overlap).

- [ ] **Step 5: Commit**
```bash
git add crates/raw-pipeline/src/stream_export.rs crates/raw-pipeline/src/lib.rs
git commit -m "feat(stream_export): StreamingExportSource (fused sliding decode->demosaic->tone)"
```

---

## Task 4: End-to-end byte-exact export

**Files:** Test in `crates/raw-pipeline/src/stream_export.rs` (`mod tests`)

- [ ] **Step 1: Write the failing test** — streamed export bytes == whole-frame export bytes.

```rust
    #[test]
    fn streaming_export_bytes_equal_whole() {
        use crate::jxl_casaencoder::{encode_chunked_rgb8};
        for (w, h) in [(64usize, 96usize), (300, 520)] {
            let strip = decompress::tests_synth_payload(w, h, 0x7A5);
            let params = pipeline::PipelineParams::default_olympus();

            // whole-frame reference bytes
            let raw = decompress::decompress(&strip, w, h).unwrap();
            let rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).unwrap();
            let mut rgb8 = vec![0u8; w * h * 3];
            pipeline::process_into_auto(&rgb16, &params, &mut rgb8);
            let whole = encode_chunked_rgb8(&rgb8, w as u32, h as u32, 1.0, 3).unwrap();

            // streamed
            let mut streamed = Vec::new();
            export_jxl_streaming_from_strip(&strip, w, h, params.clone(), 1.0, 3, &mut streamed).unwrap();

            assert_eq!(streamed, whole, "export bytes differ {}x{}", w, h);
        }
    }
```

- [ ] **Step 2: Run — expect PASS**

Run: `ct "test --no-default-features --features jxl-codec --lib streaming_export_bytes_equal_whole"`
Expected: PASS — streamed export byte-identical to whole-frame encode of the same pixels. (Both use `encode_chunked` → the comparison isolates the fused source; combined with Task 1's density bench proving `encode_chunked==AddImageFrame`, the export is byte-exact to the true whole-frame path.)

- [ ] **Step 3: Commit**
```bash
git add crates/raw-pipeline/src/stream_export.rs
git commit -m "test(stream_export): end-to-end byte-exact vs whole-frame export"
```

---

## Task 5: ORF container entry + peak-mem probe + verify

**Files:** Modify `stream_export.rs`; Create `crates/raw-pipeline/tests/stream_export_peak.rs`

- [ ] **Step 1: Add the container entry** (parses the ORF, calls the strip core). Append to `stream_export.rs`:

```rust
/// Export a full-res JXL from ORF container bytes (parses TIFF, then streams).
pub fn export_orf_jxl_streaming(
    orf: &[u8], distance: f32, effort: i64, out: &mut Vec<u8>,
) -> Result<(usize, usize), String> {
    let info = crate::tiff::parse(orf).map_err(|e| format!("tiff::parse: {e}"))?;
    let w = info.width as usize;
    let h = info.height as usize;
    let end = info.strip_offset as usize + info.strip_byte_count as usize;
    let strip = orf.get(info.strip_offset as usize..end).ok_or("strip OOB")?;
    let mut params = PipelineParams::default_olympus();
    params.black = crate::pipeline::OLYMPUS_BLACK_LEVEL_OR_DEFAULT; // see note
    if let Some(r) = info.wb_r { params.wb_r = r; }
    if let Some(b) = info.wb_b { params.wb_b = b; }
    params.color_matrix = info.color_matrix;
    export_jxl_streaming_from_strip(strip, w, h, params, distance, effort, out)?;
    Ok((w, h))
}
```
Note: use the same black-level constant the ORF full path uses (grep `OLYMPUS_BLACK_LEVEL` in `src/lib.rs` — it lives in the wasm crate; mirror the value `256` as a `pub const` in `pipeline.rs` if not already exposed, or set `params.black = 256`). Keep parity with `decode_orf_raw` so full-res parity holds; verify the constant in the plan-execution.

- [ ] **Step 2: Create the peak-mem probe** `crates/raw-pipeline/tests/stream_export_peak.rs` (own counting allocator; compares whole-export vs streaming-export working set on a synthetic strip):

```rust
//! Peak-memory: streaming export vs whole-frame export (working set above input baseline).
#![cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
use raw_pipeline::{decompress, demosaic, pipeline, stream_export, jxl_casaencoder};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
struct C; static CUR: AtomicUsize = AtomicUsize::new(0); static PK: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for C {
    unsafe fn alloc(&self, l: Layout)->*mut u8 { let p=System.alloc(l); if !p.is_null(){let c=CUR.fetch_add(l.size(),Ordering::Relaxed)+l.size(); PK.fetch_max(c,Ordering::Relaxed);} p }
    unsafe fn dealloc(&self, p:*mut u8, l:Layout){ CUR.fetch_sub(l.size(),Ordering::Relaxed); System.dealloc(p,l);} }
#[global_allocator] static A: C = C;

#[test]
fn streaming_export_peak_below_whole() {
    let (w, h) = (2048usize, 4096usize); // tall -> ~2 super-tile bands
    let strip = decompress::tests_synth_payload(w, h, 0x5EED);
    let params = pipeline::PipelineParams::default_olympus();

    let base = CUR.load(Ordering::Relaxed); PK.store(base, Ordering::Relaxed);
    {
        let raw = decompress::decompress(&strip, w, h).unwrap();
        let rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).unwrap();
        let mut rgb8 = vec![0u8; w*h*3];
        pipeline::process_into_auto(&rgb16, &params, &mut rgb8);
        let out = jxl_casaencoder::encode_chunked_rgb8(&rgb8, w as u32, h as u32, 1.0, 3).unwrap();
        std::hint::black_box((&raw,&rgb16,&rgb8,&out));
    }
    let whole = PK.load(Ordering::Relaxed) - base;

    let base = CUR.load(Ordering::Relaxed); PK.store(base, Ordering::Relaxed);
    {
        let mut out = Vec::new();
        stream_export::export_jxl_streaming_from_strip(&strip, w, h, params.clone(), 1.0, 3, &mut out).unwrap();
        std::hint::black_box(&out);
    }
    let stream = PK.load(Ordering::Relaxed) - base;
    println!("export working-set peak: whole={} stream={} ratio={:.3}", whole, stream, stream as f64/whole as f64);
    assert!(stream * 2 < whole, "stream peak {} not < whole/2 {}", stream, whole);
}
```
(`tests_synth_payload` must be reachable from an integration test — it is `#[cfg(test)]` in the lib, so integration tests can't see it. **Resolve in execution:** either expose a `#[doc(hidden)] pub fn` synth generator in `decompress`, or inline the xorshift generator in this test file. Prefer inlining the ~8-line generator here.)

- [ ] **Step 3: Run peak probe**

Run: `ct "test --no-default-features --features jxl-codec --test stream_export_peak -- --nocapture"`
Expected: prints ratio < 0.5; assertion holds (streaming holds ~1 band vs whole holds raw+rgb16+rgb8).

- [ ] **Step 4: Throughput flipflop (informal) + full lib suite + wasm check**

Run: `ct "test --no-default-features --features jxl-codec --lib stream_export::"` → all pass.
Run: `ct "test --lib"` (default features) → unaffected pass.
Run: `cargo check --target wasm32-unknown-unknown --lib` (own target dir) → clean (stream_export is cfg'd out on wasm; ensure the cfg gate compiles).

- [ ] **Step 5: Commit**
```bash
git add crates/raw-pipeline/src/stream_export.rs crates/raw-pipeline/tests/stream_export_peak.rs
git commit -m "feat(stream_export): ORF container entry + peak-mem probe (streaming < whole/2)"
```

---

## Self-Review

- **Spec coverage:** §5.1 trait+encode_chunked → Task 1; §5.2 StreamingExportSource → Task 3; §5.3 entry → Tasks 3/5; byte-exact (demosaic_band==whole is pre-existing/covered by Task 3's source test; tone_band==whole → Task 2; encode==whole → Task 1 density bench; composed → Task 4); peak-mem → Task 5; edge cases (top/bottom halo, border overlap, monotonic assert) → Task 3 code + Task 3 test (odd sizes) ; wasm → Task 5.
- **Placeholder scan:** one deliberate execution-time resolution flagged (black-level constant location + `tests_synth_payload` reach from integration test) — both given concrete fallbacks (set `256` / inline the generator), not open TODOs.
- **Type consistency:** `ChunkedColorSource::{num_channels, rect}`, `encode_chunked(w,h,distance,effort,&mut dyn,&mut Vec)`, `WholeImageSource{data,width}`, `StreamingExportSource::new(strip,w,h,params)`, `export_jxl_streaming_from_strip(strip,w,h,params,distance,effort,&mut out)`, `export_orf_jxl_streaming(orf,distance,effort,&mut out)`, `demosaic_rggb_mhc_band(ctx,w,ctx_h,halo,global_row0,first_local,num_rows,&mut rgb)` used consistently.

## Known risks for the executor
- **Black-level constant** parity with `decode_orf_raw` — confirm the value (256) before the container entry claims full-res parity; the strip-core tests use `default_olympus()` so they're unaffected.
- **`demosaic_rggb_mhc_band` halo/ctx construction** — the ctx must reproduce the whole demosaic's clamped edge refs exactly; Task 3's odd-size source test is the guard. If a size fails, inspect the top/bottom halo replication vs `demosaic_rggb_mhc`'s clamp rule.
- **Monotonic pull** is asserted in `rect`; if a real image ever violates it (not seen in the probe), the export panics rather than corrupts — safe, and a signal to widen the window.
- This is native P1; **Phase 2 (WASM bridge) is a separate spec** — do not attempt here.
