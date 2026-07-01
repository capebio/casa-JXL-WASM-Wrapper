# Streaming ORF Preview Decode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut ORF preview-only decode peak memory ~6× (~84 MB → ~15 MB) by streaming raw rows through decode → half-demosaic → box-downscale in strips, byte-identical to today.

**Architecture:** Three layers in `raw-pipeline` (natively testable under MSVC): a pull-core row decoder (`OrfRowDecoder: RawRowSource`) reusing the existing byte-exact decode loop over a 3-row ring; a `for_each_strip` push wrapper; and a fused `build_previews_streaming` (banded `demosaic_half_band` + `StreamingBoxDownscale`). `src/lib.rs::decode_orf_raw` gains a gate that calls the streaming path when previews are requested, full-res output is not, the frame is halve-able, and camera WB tags are present.

**Tech Stack:** Rust, `raw-pipeline` crate (rayon `parallel` feature), MSVC toolchain for native tests (native GNU is blocked by `dlltool`), `wasm32-unknown-unknown` for the browser build.

**Reference spec:** `docs/superpowers/specs/2026-07-01-streaming-orf-preview-decode-design.md`

**Test command (native, MSVC).** Every `cargo test` / `cargo check` step below assumes this environment is set once per shell (from repo root of the worktree):
```powershell
$env:PATH="C:\Program Files\LLVM\bin;$env:PATH"
$env:LLVMInstallDir="C:\Program Files\LLVM"; $env:LLVMToolsVersion="22"
$env:CARGO_TARGET_DIR="C:\Tmp\rcw-decompress-msvc-target"
$vc="C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
function ct($f){ cmd /c "call `"$vc`" >nul && cargo +stable-x86_64-pc-windows-msvc $f" }
```
Then e.g. `ct "test -p raw-pipeline --lib stream_"`. Run raw-pipeline tests from the repo root with `-p raw-pipeline` OR `cd crates/raw-pipeline` and drop `-p` (the crate is its own package).

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `crates/raw-pipeline/src/decompress.rs` | Extract `decode_row_into` shared helper; add `RawRowSource` trait, `OrfRowDecoder`, `for_each_strip` | Modify |
| `crates/raw-pipeline/src/demosaic.rs` | Add `demosaic_half_band`; make `demosaic_rggb_half` delegate to it | Modify |
| `crates/raw-pipeline/src/stream_preview.rs` | `StreamingBoxDownscale` + `build_previews_streaming` + `STRIP_ROWS` | Create |
| `crates/raw-pipeline/src/lib.rs` | `pub mod stream_preview;` + re-exports | Modify |
| `src/lib.rs` | Gate + call `build_previews_streaming` in `decode_orf_raw` | Modify |

Phases: **A** = raw-pipeline primitives (Tasks 1–4), **B** = fusion (Tasks 5–6), **C** = integration + verification (Tasks 7–8). Phase A alone is independently landable (enables the differential oracle + future ROI).

---

## Task 1: Extract `decode_row_into` shared helper (perf-neutral refactor)

Refactor the per-row body of `decompress_rows_into` into an `#[inline(always)]` helper so `OrfRowDecoder` can reuse the *exact* byte-exact loop. Must stay byte-exact AND perf-neutral (this loop is perf-sensitive — see the D9 rejection).

**Files:**
- Modify: `crates/raw-pipeline/src/decompress.rs` (the `for row` loop, ~lines 78–190)

- [ ] **Step 1: Add the helper above `decompress_rows_into`.** Insert after the `bitstream_exhausted` fn:

```rust
/// Decode one full row of `width` pixels into `cur_row` (len == width).
/// `north_row` is the row two above (same CFA parity), length == width, or `&[]`
/// for the first two rows. `acarry`/`west`/`north_west` are row-local and reset
/// here every call (dcraw resets carry per row). Byte-exact with the pre-refactor
/// inline loop; `#[inline(always)]` so `decompress_rows_into` codegen is unchanged.
#[inline(always)]
fn decode_row_into<const WIDE: bool>(
    br: &mut BitReader<'_, WIDE>,
    row: usize,
    width: usize,
    nrows: usize,
    north_row: &[u16],
    cur_row: &mut [u16],
) -> Result<(), String> {
    let mut acarry = [[0i32; 3]; 2];
    let mut west = [0i32; 2];
    let mut north_west = [0i32; 2];
    let cur_row_ptr = cur_row.as_mut_ptr();
    for col in 0..width {
        let parity = col & 1;
        let i = if acarry[parity][2] < 3 { 2 } else { 0 };
        let carry_lo = (acarry[parity][0] as u16) as u32;
        let bitlen = 32 - carry_lo.leading_zeros() as i32;
        let nbits = (2 + i as i32).max(bitlen - i as i32).min(16) as usize;

        let sb = br.read_bits(3);
        if br.truncated { return Err(bitstream_exhausted(width, nrows)); }
        let low = (sb & 3) as i32;
        let sign = (((sb as i32) << 29) >> 31) as i32;

        let high0 = br.read_huff();
        if br.truncated { return Err(bitstream_exhausted(width, nrows)); }
        let high = if high0 == 12 {
            let extra = (16u32).saturating_sub(nbits as u32);
            (br.read_bits(extra) >> 1) as i32
        } else {
            high0 as i32
        };
        if br.truncated { return Err(bitstream_exhausted(width, nrows)); }

        acarry[parity][0] = (high << (nbits as u32)) | (br.read_bits(nbits as u32) as i32);
        if br.truncated { return Err(bitstream_exhausted(width, nrows)); }
        let diff = (acarry[parity][0] ^ sign) + acarry[parity][1];
        acarry[parity][1] = (diff * 3 + acarry[parity][1]) >> 5;
        acarry[parity][2] = if acarry[parity][0] > 16 { 0 } else { acarry[parity][2] + 1 };

        let north = if row >= 2 { north_row[col] as i32 } else { 0 };
        let pred = if row < 2 && col < 2 {
            0
        } else if row < 2 {
            west[parity]
        } else if col < 2 {
            north
        } else {
            let w_ = west[parity];
            let n_ = north;
            let nw = north_west[parity];
            let awn = (w_ - nw).abs();
            let ann = (n_ - nw).abs();
            let between = ((w_ < nw) & (nw < n_)) | ((n_ < nw) & (nw < w_));
            let far = (awn > 32) | (ann > 32);
            let p_between = if far { w_ + n_ - nw } else { (w_ + n_) >> 1 };
            let p_else = if awn > ann { w_ } else { n_ };
            if between { p_between } else { p_else }
        };

        let v = (pred + ((diff << 2) | low)) & 0xFFFF;
        // SAFETY: cur_row_ptr from cur_row (len == width); col < width; north_row is a
        // disjoint borrow. Same invariant as the pre-refactor loop.
        unsafe { *cur_row_ptr.add(col) = v as u16; }
        west[parity] = v;
        if row >= 2 {
            north_west[parity] = north;
        }
    }
    Ok(())
}
```

- [ ] **Step 2: Replace the `for row` loop body in `decompress_rows_into`** with a call to the helper:

```rust
    for row in 0..nrows {
        let row_base = row * width;
        let row2_base = if row >= 2 { (row - 2) * width } else { 0 };
        let (above, cur) = out[..n].split_at_mut(row_base);
        let north_row: &[u16] = if row >= 2 { &above[row2_base..row2_base + width] } else { &[] };
        decode_row_into::<WIDE_FILL>(&mut br, row, width, nrows, north_row, &mut cur[..width])?;
    }
    if br.truncated {
        return Err(bitstream_exhausted(width, nrows));
    }
    Ok(nrows)
```

- [ ] **Step 3: Verify byte-exact + all decompress tests pass**

Run: `ct "test -p raw-pipeline --lib decompress::"`
Expected: `13 passed; 0 failed` (golden, sweeps, `decompress_old_vs_new_byteexact`, guards).

- [ ] **Step 4: Verify perf unchanged (the refactor must not regress the hot loop)**

Run: `ct "test --release -p raw-pipeline --lib decompress_ab_timing -- --ignored --nocapture"`
Expected: `PROD` still ≈ `-6%..-9% vs base` (within noise of the pre-refactor number). If `PROD` regressed toward `base`, the `#[inline(always)]` did not reproduce codegen — investigate before continuing.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/decompress.rs
git commit -m "refactor(decompress): extract decode_row_into helper (byte-exact, perf-neutral)"
```

---

## Task 2: `RawRowSource` trait + `OrfRowDecoder`

**Files:**
- Modify: `crates/raw-pipeline/src/decompress.rs` (add after `decompress_rows_into`, before `BitReader`)
- Test: `crates/raw-pipeline/src/decompress.rs` (in `mod tests`)

- [ ] **Step 1: Write the failing test** (add to `mod tests`, which already has `synth_payload`):

```rust
    #[test]
    fn stream_rows_equal_full_decode() {
        for (w, h, seed) in [(128usize, 96usize, 0x1234u64), (255, 64, 0xBEEF), (64, 255, 0xABCD), (3, 257, 0x55)] {
            let payload = synth_payload(w, h, seed);
            let mut full = vec![0u16; w * h];
            decompress_rows_into(&payload, w, h, h, &mut full).unwrap();

            let mut dec = OrfRowDecoder::new(&payload, w, h).unwrap();
            assert_eq!(dec.width(), w);
            assert_eq!(dec.height(), h);
            let mut streamed = Vec::with_capacity(w * h);
            let mut rowbuf = vec![0u16; w];
            while dec.next_row_into(&mut rowbuf).unwrap() {
                streamed.extend_from_slice(&rowbuf);
            }
            assert_eq!(streamed, full, "streamed != full for {}x{}", w, h);
        }
        // truncation surfaces as Err mid-stream
        let short = synth_payload(64, 64, 7)[..HEADER_SKIP + 40].to_vec();
        let mut dec = OrfRowDecoder::new(&short, 64, 64).unwrap();
        let mut rowbuf = vec![0u16; 64];
        let mut err = false;
        loop {
            match dec.next_row_into(&mut rowbuf) {
                Ok(true) => continue,
                Ok(false) => break,
                Err(_) => { err = true; break; }
            }
        }
        assert!(err, "truncated stream should error");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ct "test -p raw-pipeline --lib stream_rows_equal_full_decode"`
Expected: FAIL — `cannot find type OrfRowDecoder` / `RawRowSource`.

- [ ] **Step 3: Implement the trait + decoder** (insert after `decompress_rows_into`):

```rust
/// A source of decoded raw rows, produced strictly top-to-bottom. The extension
/// seam for other decoders (LJPEG/DNG) — implemented only by ORF today.
pub trait RawRowSource {
    fn width(&self) -> usize;
    fn height(&self) -> usize;
    /// Decode the next row into `dst` (len >= width). Ok(true) = a row was written
    /// to dst[..width]; Ok(false) = end of image; Err = corrupt/truncated stream.
    fn next_row_into(&mut self, dst: &mut [u16]) -> Result<bool, String>;
}

/// Streaming Olympus ORF row decoder. Holds only a 3-row ring (the predictor needs
/// row r-2), not the full frame. Yields rows byte-identical to `decompress_rows_into`.
pub struct OrfRowDecoder<'a> {
    br: BitReader<'a, WIDE_FILL>,
    width: usize,
    height: usize,
    row: usize,
    ring: Vec<u16>, // 3 * max(width,1); row r lives in slot (r % 3)
}

impl<'a> OrfRowDecoder<'a> {
    pub fn new(compressed: &'a [u8], width: usize, height: usize) -> Result<Self, String> {
        if compressed.len() <= HEADER_SKIP {
            return Err(format!(
                "decompress: input too short ({} bytes, need > {})",
                compressed.len(), HEADER_SKIP
            ));
        }
        Ok(Self {
            br: BitReader::<WIDE_FILL>::new(&compressed[HEADER_SKIP..]),
            width,
            height,
            row: 0,
            ring: vec![0u16; 3 * width.max(1)],
        })
    }
}

impl RawRowSource for OrfRowDecoder<'_> {
    fn width(&self) -> usize { self.width }
    fn height(&self) -> usize { self.height }

    fn next_row_into(&mut self, dst: &mut [u16]) -> Result<bool, String> {
        if self.row >= self.height {
            return Ok(false);
        }
        let r = self.row;
        let w = self.width;
        if w == 0 {
            self.row += 1;
            return Ok(true); // zero-width: no pixels, matches decompress_rows_into contract
        }
        // north = row r-2 from the ring (immutable), disjoint field from br/dst.
        let north: &[u16] = if r >= 2 {
            let s = ((r - 2) % 3) * w;
            &self.ring[s..s + w]
        } else {
            &[]
        };
        decode_row_into::<WIDE_FILL>(&mut self.br, r, w, self.height, north, &mut dst[..w])?;
        // Stash into the ring so rows r+2 can read it as north.
        let cs = (r % 3) * w;
        self.ring[cs..cs + w].copy_from_slice(&dst[..w]);
        self.row += 1;
        Ok(true)
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ct "test -p raw-pipeline --lib stream_rows_equal_full_decode"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/decompress.rs
git commit -m "feat(decompress): RawRowSource trait + streaming OrfRowDecoder (3-row ring)"
```

---

## Task 3: `for_each_strip` push wrapper

**Files:**
- Modify: `crates/raw-pipeline/src/decompress.rs`
- Test: `crates/raw-pipeline/src/decompress.rs` (`mod tests`)

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn for_each_strip_reconstructs_full() {
        let (w, h) = (17usize, 20usize); // odd width, strip not dividing height
        let payload = synth_payload(w, h, 0xF00D);
        let mut full = vec![0u16; w * h];
        decompress_rows_into(&payload, w, h, h, &mut full).unwrap();

        let mut dec = OrfRowDecoder::new(&payload, w, h).unwrap();
        let mut scratch = Vec::new();
        let mut got = Vec::new();
        let mut strips = 0;
        for_each_strip(&mut dec, 6, &mut scratch, |first, k, band| {
            assert_eq!(first, got.len() / w);
            assert!(k <= 6 && k > 0);
            got.extend_from_slice(&band[..k * w]);
            strips += 1;
            Ok(())
        }).unwrap();
        assert_eq!(got, full);
        assert_eq!(strips, 4); // 6+6+6+2
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ct "test -p raw-pipeline --lib for_each_strip_reconstructs_full"`
Expected: FAIL — `cannot find function for_each_strip`.

- [ ] **Step 3: Implement** (add after `OrfRowDecoder`):

```rust
/// Pull rows from `src` into a reused `scratch` (strip_rows * width) and hand each
/// full strip — and the final partial strip — to `sink(first_row, n_rows, &band)`.
/// One `scratch` allocation for the whole decode. `strip_rows` should be even when
/// the consumer pairs rows (e.g. half-demosaic); this wrapper itself is parity-agnostic.
pub fn for_each_strip<S: RawRowSource>(
    src: &mut S,
    strip_rows: usize,
    scratch: &mut Vec<u16>,
    mut sink: impl FnMut(usize, usize, &[u16]) -> Result<(), String>,
) -> Result<(), String> {
    assert!(strip_rows > 0, "strip_rows must be > 0");
    let w = src.width();
    scratch.resize(strip_rows * w.max(1), 0);
    let mut first = 0usize;
    loop {
        let mut k = 0usize;
        while k < strip_rows {
            let dst = &mut scratch[k * w..(k + 1) * w];
            if !src.next_row_into(dst)? {
                break;
            }
            k += 1;
        }
        if k == 0 {
            break;
        }
        sink(first, k, &scratch[..k * w])?;
        first += k;
        if k < strip_rows {
            break;
        }
    }
    Ok(())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `ct "test -p raw-pipeline --lib for_each_strip_reconstructs_full"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/decompress.rs
git commit -m "feat(decompress): for_each_strip push wrapper over RawRowSource"
```

---

## Task 4: `demosaic_half_band` (banded half-demosaic)

**Files:**
- Modify: `crates/raw-pipeline/src/demosaic.rs` (`demosaic_rggb_half` at ~line 693)
- Test: `crates/raw-pipeline/src/demosaic.rs` (`mod tests`)

- [ ] **Step 1: Write the failing test** (add to demosaic.rs `mod tests`):

```rust
    #[test]
    fn half_band_matches_full() {
        let (w, h) = (16usize, 12usize);
        let raw: Vec<u16> = (0..(w * h)).map(|i| ((i * 37 + 5) & 0x0fff) as u16).collect();
        let full = demosaic_rggb_half(&raw, w, h).unwrap();
        let (hw, hh) = (w / 2, h / 2);

        // Decode in bands of 2 raw rows (1 half-row) and 4 raw rows (2 half-rows).
        for band_rows in [2usize, 4] {
            let mut got = Vec::new();
            let mut r = 0;
            while r + band_rows <= h {
                let strip = &raw[r * w..(r + band_rows) * w];
                let mut out = vec![0u16; (band_rows / 2) * hw * 3];
                demosaic_half_band(strip, w, band_rows, &mut out);
                got.extend_from_slice(&out);
                r += band_rows;
            }
            assert_eq!(got.len(), hh * hw * 3);
            assert_eq!(got, full, "band_rows={}", band_rows);
        }
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ct "test -p raw-pipeline --lib half_band_matches_full"`
Expected: FAIL — `cannot find function demosaic_half_band`.

- [ ] **Step 3: Add `demosaic_half_band` and make `demosaic_rggb_half` delegate.** Replace the body of `demosaic_rggb_half` (keep its validation + allocation) so the per-half-row work routes through the new fn:

```rust
/// Demosaic `k_rows` raw rows (k_rows even, starting at an even raw row) into
/// half-resolution interleaved RGB16. `out_half` len must be (k_rows/2) * (width/2) * 3.
/// Byte-identical to the matching chunk of `demosaic_rggb_half`.
pub fn demosaic_half_band(raw_strip: &[u16], width: usize, k_rows: usize, out_half: &mut [u16]) {
    let hw = width / 2;
    let do_row = |qr: usize, out_row: &mut [u16]| {
        let top = &raw_strip[(2 * qr) * width..(2 * qr) * width + width];
        let bot = &raw_strip[(2 * qr + 1) * width..(2 * qr + 1) * width + width];
        for qc in 0..hw {
            let c0 = 2 * qc;
            let o = qc * 3;
            out_row[o] = top[c0];
            out_row[o + 1] = ((top[c0 + 1] as u32 + bot[c0] as u32) >> 1) as u16;
            out_row[o + 2] = bot[c0 + 1];
        }
    };
    #[cfg(feature = "parallel")]
    out_half.par_chunks_mut(hw * 3).enumerate().for_each(|(qr, out_row)| do_row(qr, out_row));
    #[cfg(not(feature = "parallel"))]
    out_half.chunks_mut(hw * 3).enumerate().for_each(|(qr, out_row)| do_row(qr, out_row));
    let _ = k_rows; // length is carried by out_half; k_rows documents the caller contract
}

pub fn demosaic_rggb_half(raw: &[u16], width: usize, height: usize) -> Result<Vec<u16>, String> {
    validate(raw, width, height)?;
    let (hw, hh) = (width / 2, height / 2);
    if hw == 0 || hh == 0 {
        return Err(format!("demosaic: {}×{} too small for half-res", width, height));
    }
    let n3 = hw.checked_mul(hh)
        .and_then(|n| n.checked_mul(3))
        .ok_or_else(|| format!("demosaic: half {}×{}×3 overflows usize", hw, hh))?;
    let mut rgb = vec![0u16; n3];
    // Delegate to the banded kernel over the whole frame (first 2*hh rows).
    demosaic_half_band(&raw[..(2 * hh) * width], width, 2 * hh, &mut rgb);
    Ok(rgb)
}
```

- [ ] **Step 4: Run tests to verify pass (new + existing demosaic tests)**

Run: `ct "test -p raw-pipeline --lib demosaic::"`
Expected: PASS — `half_band_matches_full` plus all existing demosaic tests green.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/demosaic.rs
git commit -m "feat(demosaic): demosaic_half_band; demosaic_rggb_half delegates to it"
```

---

## Task 5: `StreamingBoxDownscale`

Byte-exact streaming equivalent of `src/lib.rs::downscale_rgb16_impl` (packed LE u16, 6 bytes/pixel). Lives in `raw-pipeline` so it is natively testable; the test oracle is a verbatim copy of the reference box filter.

**Files:**
- Create: `crates/raw-pipeline/src/stream_preview.rs`
- Modify: `crates/raw-pipeline/src/lib.rs` (add `pub mod stream_preview;`)
- Test: `crates/raw-pipeline/src/stream_preview.rs` (`mod tests`)

- [ ] **Step 1: Create the module with the type + a reference oracle + the failing test.**

```rust
//! Streaming, bounded-memory ORF preview build: decode → half-demosaic →
//! box-downscale, one strip at a time. Byte-identical to the full-frame path.

/// Streaming box-downscale. Accepts source rows in top-to-bottom order via
/// `push_row`, accumulates one output row at a time, and produces the same packed
/// LE u16 buffer (6 bytes/pixel) as `src/lib.rs::downscale_rgb16_impl`.
///
/// Byte-exactness: for downscaling (sh > dh) the vertical spans [y0,y1) form a
/// non-overlapping partition of [0,sh) — each input row feeds exactly one output
/// row — so the streamed per-pixel sums equal the one-shot sums in the same order.
pub struct StreamingBoxDownscale {
    sw: usize,
    sh: usize,
    dw: usize,
    dh: usize,
    out: Vec<u8>,     // dw*dh*6 (the deliverable)
    acc: Vec<u32>,    // dw*3 accumulator for the current output row
    dy: usize,        // current output row being filled
    y_in: usize,      // next input row index expected
    y1: usize,        // end (exclusive) of the current output row's input span
    xspan: Vec<(u32, u32)>, // (x0, x1) per output column
    integer: bool,
    xstep: usize,
}

#[inline(always)]
fn write_rgb16_le(out: &mut [u8], o: usize, r: u16, g: u16, b: u16) {
    out[o] = r as u8; out[o + 1] = (r >> 8) as u8;
    out[o + 2] = g as u8; out[o + 3] = (g >> 8) as u8;
    out[o + 4] = b as u8; out[o + 5] = (b >> 8) as u8;
}

impl StreamingBoxDownscale {
    pub fn new(sw: usize, sh: usize, dw: usize, dh: usize) -> Self {
        let integer = sw % dw == 0 && sh % dh == 0;
        let xstep = if integer { sw / dw } else { 0 };
        let xr = sw as f32 / dw as f32;
        let mut xspan = Vec::with_capacity(dw);
        for dx in 0..dw {
            let (x0, x1) = if integer {
                let x0 = dx * xstep;
                (x0, x0 + xstep)
            } else {
                let x0 = (dx as f32 * xr) as usize;
                let x1 = (((dx as f32 + 1.0) * xr).min(sw as f32) as usize).max(x0 + 1);
                (x0, x1)
            };
            xspan.push((x0 as u32, x1 as u32));
        }
        let mut s = Self {
            sw, sh, dw, dh,
            out: vec![0u8; dw * dh * 6],
            acc: vec![0u32; dw * 3],
            dy: 0,
            y_in: 0,
            y1: 0,
            xspan,
            integer,
            xstep,
        };
        s.set_span_for_dy(0);
        s
    }

    fn set_span_for_dy(&mut self, dy: usize) {
        if dy >= self.dh { return; }
        let (y0, y1) = if self.integer {
            let ystep = self.sh / self.dh;
            (dy * ystep, dy * ystep + ystep)
        } else {
            let yr = self.sh as f32 / self.dh as f32;
            let y0 = (dy as f32 * yr) as usize;
            let y1 = (((dy as f32 + 1.0) * yr).min(self.sh as f32) as usize).max(y0 + 1);
            (y0, y1)
        };
        debug_assert_eq!(y0, self.y_in, "streaming span must start where input is");
        self.y1 = y1;
    }

    /// Feed one source row (interleaved RGB16, len == sw*3). Rows must arrive in
    /// increasing y, exactly sh of them total.
    pub fn push_row(&mut self, row: &[u16]) {
        if self.dy >= self.dh {
            self.y_in += 1;
            return;
        }
        for dx in 0..self.dw {
            let (x0, x1) = self.xspan[dx];
            let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
            let mut i = (x0 as usize) * 3;
            for _ in x0..x1 {
                rr += row[i] as u32;
                gg += row[i + 1] as u32;
                bb += row[i + 2] as u32;
                i += 3;
            }
            let a = dx * 3;
            self.acc[a] += rr;
            self.acc[a + 1] += gg;
            self.acc[a + 2] += bb;
        }
        self.y_in += 1;
        if self.y_in == self.y1 {
            // flush output row dy
            let y0 = self.span_y0();
            let rows = (self.y1 - y0).max(1) as u32;
            let mut o = self.dy * self.dw * 6;
            for dx in 0..self.dw {
                let (x0, x1) = self.xspan[dx];
                let n = (rows * (x1 - x0).max(1)) as u32;
                let a = dx * 3;
                write_rgb16_le(
                    &mut self.out, o,
                    (self.acc[a] / n) as u16,
                    (self.acc[a + 1] / n) as u16,
                    (self.acc[a + 2] / n) as u16,
                );
                self.acc[a] = 0; self.acc[a + 1] = 0; self.acc[a + 2] = 0;
                o += 6;
            }
            self.dy += 1;
            self.set_span_for_dy(self.dy);
        }
    }

    fn span_y0(&self) -> usize {
        if self.integer {
            let ystep = self.sh / self.dh;
            self.dy * ystep
        } else {
            let yr = self.sh as f32 / self.dh as f32;
            (self.dy as f32 * yr) as usize
        }
    }

    pub fn finish(self) -> Vec<u8> {
        debug_assert_eq!(self.y_in, self.sh, "must feed exactly sh rows");
        self.out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Verbatim reference of src/lib.rs::downscale_rgb16_impl (int + float paths),
    // kept as the byte-exact oracle. If the production downscaler changes, update both.
    fn reference_downscale(src: &[u16], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
        let mut out = vec![0u8; dw * dh * 6];
        if sw % dw == 0 && sh % dh == 0 {
            let xstep = sw / dw; let ystep = sh / dh;
            let pc = (xstep * ystep) as u32;
            let mut o = 0usize;
            for dy in 0..dh { for dx in 0..dw {
                let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
                let xb = dx * xstep; let mut rb = dy * ystep * sw;
                for _ in 0..ystep {
                    let mut i = (rb + xb) * 3;
                    for _ in 0..xstep { rr += src[i] as u32; gg += src[i+1] as u32; bb += src[i+2] as u32; i += 3; }
                    rb += sw;
                }
                write_rgb16_le(&mut out, o, (rr/pc) as u16, (gg/pc) as u16, (bb/pc) as u16);
                o += 6;
            }}
            return out;
        }
        let xr = sw as f32 / dw as f32; let yr = sh as f32 / dh as f32;
        let mut o = 0usize;
        for dy in 0..dh {
            let y0 = (dy as f32 * yr) as usize;
            let y1 = (((dy as f32 + 1.0) * yr).min(sh as f32) as usize).max(y0 + 1);
            for dx in 0..dw {
                let x0 = (dx as f32 * xr) as usize;
                let x1 = (((dx as f32 + 1.0) * xr).min(sw as f32) as usize).max(x0 + 1);
                let n = ((y1 - y0) * (x1 - x0)).max(1) as u32;
                let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
                let mut rb = y0 * sw;
                for _ in y0..y1 {
                    for x in x0..x1 { let i = (rb + x) * 3; rr += src[i] as u32; gg += src[i+1] as u32; bb += src[i+2] as u32; }
                    rb += sw;
                }
                write_rgb16_le(&mut out, o, (rr/n) as u16, (gg/n) as u16, (bb/n) as u16);
                o += 6;
            }
        }
        out
    }

    fn stream_all(src: &[u16], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
        let mut d = StreamingBoxDownscale::new(sw, sh, dw, dh);
        for y in 0..sh { d.push_row(&src[y * sw * 3..(y + 1) * sw * 3]); }
        d.finish()
    }

    #[test]
    fn streaming_downscale_matches_reference() {
        // (sw, sh, dw, dh): exact-integer and aspect/float cases.
        for &(sw, sh, dw, dh) in &[(64usize, 48usize, 16usize, 12usize),  // exact 4x
                                   (100, 75, 30, 21),                     // float
                                   (99, 60, 25, 17)] {                    // float, odd
            let src: Vec<u16> = (0..(sw * sh * 3)).map(|i| ((i * 31 + 7) & 0xffff) as u16).collect();
            let want = reference_downscale(&src, sw, sh, dw, dh);
            let got = stream_all(&src, sw, sh, dw, dh);
            assert_eq!(got, want, "{}x{} -> {}x{}", sw, sh, dw, dh);
        }
    }
}
```

- [ ] **Step 2: Register the module.** In `crates/raw-pipeline/src/lib.rs` add near the other `mod` declarations:

```rust
pub mod stream_preview;
```

- [ ] **Step 3: Run test to verify it passes**

Run: `ct "test -p raw-pipeline --lib stream_preview::"`
Expected: PASS — `streaming_downscale_matches_reference`.

- [ ] **Step 4: Commit**

```bash
git add crates/raw-pipeline/src/stream_preview.rs crates/raw-pipeline/src/lib.rs
git commit -m "feat(stream_preview): byte-exact StreamingBoxDownscale"
```

---

## Task 6: `build_previews_streaming` (fusion)

**Files:**
- Modify: `crates/raw-pipeline/src/stream_preview.rs`
- Test: `crates/raw-pipeline/src/stream_preview.rs` (`mod tests`)

- [ ] **Step 1: Write the failing test.** Reuse the decompress test corpus by re-deriving previews the manual way and comparing.

```rust
    #[test]
    fn build_previews_matches_manual_composition() {
        use crate::decompress;
        use crate::demosaic;

        let (w, h) = (64usize, 48usize);
        let payload = crate::decompress::tests_synth_payload(w, h, 0xC0FFEE);
        let (hw, hh) = (w / 2, h / 2);

        // manual: full decode -> half demosaic -> downscale (the current path)
        let raw = decompress::decompress(&payload, w, h).unwrap();
        let half = demosaic::demosaic_rggb_half(&raw, w, h).unwrap();
        let lb = reference_downscale(&half, hw, hh, 20, 15);
        let th = reference_downscale(&half, hw, hh, 8, 6);

        // streaming
        let got = build_previews_streaming(&payload, w, h, &[(20, 15), (8, 6)]).unwrap();
        assert_eq!(got[0], lb, "lightbox differs");
        assert_eq!(got[1], th, "thumb differs");
    }
```

Note: this needs `synth_payload` reachable from `stream_preview::tests`. In `decompress.rs`, expose a thin `#[cfg(test)] pub(crate) fn tests_synth_payload` that forwards to the existing `synth_payload`, OR move `synth_payload` to a `#[cfg(test)] pub(crate)` location. Add to `decompress.rs`:

```rust
#[cfg(test)]
pub(crate) fn tests_synth_payload(width: usize, height: usize, seed: u64) -> Vec<u8> {
    tests::synth_payload(width, height, seed)
}
```
and make `synth_payload` / the module visible: change `mod tests` to `pub(crate) mod tests` and `fn synth_payload` to `pub(crate) fn synth_payload`.

- [ ] **Step 2: Run test to verify it fails**

Run: `ct "test -p raw-pipeline --lib build_previews_matches_manual_composition"`
Expected: FAIL — `cannot find function build_previews_streaming`.

- [ ] **Step 3: Implement** (add to `stream_preview.rs`):

```rust
use crate::decompress::{for_each_strip, OrfRowDecoder, RawRowSource};
use crate::demosaic::demosaic_half_band;

/// Even strip height. ~512 KB raw strip at 4000 px width; keeps demosaic par grain.
/// Bench-adjustable const (see the perf flipflop), not a user tunable.
pub const STRIP_ROWS: usize = 64;

/// Fully streaming ORF preview build. Decodes `compressed` in even strips, half-
/// demosaics each strip, and box-downscales into one packed LE u16 buffer per target
/// (width,height). Never materializes the full raw or the full half-res image. Byte-
/// identical to `decompress -> demosaic_rggb_half -> downscale_rgb16_impl`.
pub fn build_previews_streaming(
    compressed: &[u8],
    w: usize,
    h: usize,
    targets: &[(usize, usize)],
) -> Result<Vec<Vec<u8>>, String> {
    let (hw, hh) = (w / 2, h / 2);
    if hw == 0 || hh == 0 {
        return Err(format!("stream_preview: {}×{} too small for half-res", w, h));
    }
    let mut dec = OrfRowDecoder::new(compressed, w, h)?;
    let mut downs: Vec<StreamingBoxDownscale> =
        targets.iter().map(|&(dw, dh)| StreamingBoxDownscale::new(hw, hh, dw, dh)).collect();

    let mut scratch: Vec<u16> = Vec::new();
    let mut half_strip = vec![0u16; (STRIP_ROWS / 2) * hw * 3];

    for_each_strip(&mut dec, STRIP_ROWS, &mut scratch, |_first_row, k, raw_strip| {
        // Only whole 2-row pairs demosaic; a trailing odd row (only possible on the
        // final strip when h is odd) is dropped, matching hh = h/2.
        let keven = k & !1;
        if keven == 0 {
            return Ok(());
        }
        let half_rows = keven / 2;
        let hs = &mut half_strip[..half_rows * hw * 3];
        demosaic_half_band(&raw_strip[..keven * w], w, keven, hs);
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

- [ ] **Step 4: Run test to verify it passes**

Run: `ct "test -p raw-pipeline --lib stream_preview::"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/stream_preview.rs crates/raw-pipeline/src/decompress.rs
git commit -m "feat(stream_preview): build_previews_streaming fusion (byte-exact vs full path)"
```

---

## Task 7: Wire into `decode_orf_raw` behind the gate

**Files:**
- Modify: `src/lib.rs` (`decode_orf_raw`, ~lines 662–820)

- [ ] **Step 1: Add the gate + streaming fork.** Immediately after `strip` is computed (~line 680) and before `let raw = decompress::decompress(...)`, insert:

```rust
    // Streaming preview-only fast path: when previews are requested, full-res output
    // is NOT, the frame is halve-able, and camera WB tags are present (so the raw is
    // needed for nothing but previews), build previews without ever materializing the
    // full raw. Byte-identical to the full path (see stream_preview tests). Rare
    // no-camera-WB frames fall through to the full path (auto_wb needs the whole raw).
    let (lb_w, lb_h) = target_dims(w, h, 1800);
    let (thumb_w, thumb_h) = target_dims(w, h, 360);
    let need_previews = output_flags & (OUT_LIGHTBOX | OUT_THUMB) != 0;
    let need_full_rgb = output_flags & (OUT_FULL_RGB8 | OUT_FULL_16) != 0;
    let wb_from_camera = info.wb_r.is_some() && info.wb_b.is_some();
    let stream_previews = need_previews
        && !need_full_rgb
        && wb_from_camera
        && preview_can_halve(w, h, lb_w, lb_h);

    if stream_previews {
        let t = now_ms();
        let previews = raw_pipeline::stream_preview::build_previews_streaming(
            strip, w, h, &[(lb_w, lb_h), (thumb_w, thumb_h)],
        ).map_err(|e| JsError::new(&e))?;
        let stream_ms = now_ms() - t;
        let mut it = previews.into_iter();
        let lb_packed = it.next().unwrap_or_default();
        let thumb_packed = it.next().unwrap_or_default();

        let mut params = pipeline::PipelineParams::default_olympus();
        params.black = OLYMPUS_BLACK_LEVEL;
        if let Some(r) = info.wb_r { params.wb_r = r; }
        if let Some(b) = info.wb_b { params.wb_b = b; }
        if let Some(m) = info.color_matrix { params.color_matrix = Some(m); }
        let color_matrix_from_mn = info.color_matrix.is_some();
        let color_matrix_flat: [f32; 9] = {
            let m = params.color_matrix.unwrap_or(pipeline::CAM_TO_SRGB);
            [m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2]]
        };

        return Ok(OrfDecoded {
            rgb16: Vec::new(),
            w, h, info,
            decompress_ms: stream_ms,
            demosaic_ms: 0.0,
            wb_from_camera,
            params,
            color_matrix_from_mn,
            color_matrix_flat,
            lb_packed, lb_w, lb_h,
            thumb_packed, thumb_w, thumb_h,
            preview_demosaic_ms: 0.0,
            preview_downscale_ms: 0.0,
            fast_preview: true,
        });
    }
```

Then leave the existing full-frame body unchanged (it now runs only when `stream_previews` is false). Remove the now-duplicated `let (lb_w, lb_h) = ...`, `let (thumb_w, thumb_h) = ...`, and `let need_previews = ...` lines further down (they are computed above now); keep the existing `let (lb_packed, thumb_packed, ...) = if !need_previews {...}` block as-is otherwise.

- [ ] **Step 2: Confirm the crate name for the re-export.** `build_previews_streaming` is referenced as `raw_pipeline::stream_preview::build_previews_streaming`. Verify the dependency name in `Cargo.toml` (the crate may be imported as `raw_pipeline` or via a `use`). If `src/lib.rs` already does `use raw_pipeline::...` or aliases it, match that. Run:

Run: `ct "check"` (from repo root, builds the wasm crate natively under MSVC if it builds; otherwise see Step 4)
Expected: resolves the path or a clear name error to fix.

- [ ] **Step 3: Smoke test the gate logic (native, pure function).** If `decode_orf_raw` cannot run natively (wasm-bindgen), extract the gate boolean into a tiny pure helper and test that instead:

```rust
// in src/lib.rs
fn should_stream_previews(need_previews: bool, need_full_rgb: bool, wb_from_camera: bool, can_halve: bool) -> bool {
    need_previews && !need_full_rgb && wb_from_camera && can_halve
}
```
and add (guarded so it compiles for the host test target):
```rust
#[cfg(test)]
mod stream_gate_tests {
    use super::should_stream_previews;
    #[test]
    fn gate_truth_table() {
        assert!(should_stream_previews(true, false, true, true));
        assert!(!should_stream_previews(true, true, true, true));   // full-res wanted
        assert!(!should_stream_previews(true, false, false, true)); // no camera WB
        assert!(!should_stream_previews(false, false, true, true)); // no previews
        assert!(!should_stream_previews(true, false, true, false)); // not halve-able
    }
}
```
Replace the inline `let stream_previews = ...` expression with a call to `should_stream_previews(...)`.

- [ ] **Step 4: Build the wasm target (the real consumer target)**

Run: `cargo check --target wasm32-unknown-unknown` (GNU toolchain; set `CARGO_TARGET_DIR` to a wasm-specific dir)
Expected: `Finished` with no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib.rs
git commit -m "feat(orf): stream previews when preview-only + camera-WB (no full raw)"
```

---

## Task 8: Verify — byte-exact end-to-end, perf, peak memory, docs

**Files:**
- Test/harness: `crates/raw-pipeline/src/stream_preview.rs` (perf + mem probes as `#[ignore]`)
- Modify: `Questions_deferred.md`, memory index

- [ ] **Step 1: Add an `#[ignore]` peak-memory probe** to `stream_preview::tests` using a counting global allocator scoped to the test binary:

```rust
    // A tiny counting allocator to bound peak resident bytes of each path.
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Counting;
    static CUR: AtomicUsize = AtomicUsize::new(0);
    static PEAK: AtomicUsize = AtomicUsize::new(0);
    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, l: Layout) -> *mut u8 {
            let p = System.alloc(l);
            if !p.is_null() {
                let c = CUR.fetch_add(l.size(), Ordering::Relaxed) + l.size();
                PEAK.fetch_max(c, Ordering::Relaxed);
            }
            p
        }
        unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
            CUR.fetch_sub(l.size(), Ordering::Relaxed);
            System.dealloc(p, l);
        }
    }
    #[global_allocator]
    static A: Counting = Counting;

    #[test]
    #[ignore]
    fn peak_mem_stream_vs_full() {
        let (w, h) = (1024usize, 1024usize); // ~1 MP; scale conclusion to 24 MP
        let payload = crate::decompress::tests_synth_payload(w, h, 0x5EED);
        let (hw, hh) = (w / 2, h / 2);

        PEAK.store(CUR.load(Ordering::Relaxed), Ordering::Relaxed);
        let raw = crate::decompress::decompress(&payload, w, h).unwrap();
        let half = crate::demosaic::demosaic_rggb_half(&raw, w, h).unwrap();
        let _lb = reference_downscale(&half, hw, hh, 300, 300);
        let full_peak = PEAK.load(Ordering::Relaxed);

        PEAK.store(CUR.load(Ordering::Relaxed), Ordering::Relaxed);
        let _ = build_previews_streaming(&payload, w, h, &[(300, 300)]).unwrap();
        let stream_peak = PEAK.load(Ordering::Relaxed);

        println!("peak full={} stream={} ratio={:.2}", full_peak, stream_peak, stream_peak as f64 / full_peak as f64);
        assert!(stream_peak * 4 < full_peak, "streaming peak not < full/4");
    }
```

Run: `ct "test -p raw-pipeline --lib peak_mem_stream_vs_full -- --ignored --nocapture"`
Expected: prints a ratio well under 0.25; assertion holds.

- [ ] **Step 2: Add an `#[ignore]` perf flipflop** comparing streamed preview build vs the manual full composition:

```rust
    #[test]
    #[ignore]
    fn preview_build_ab_timing() {
        use std::time::Instant;
        let (w, h) = (2048usize, 2048usize);
        let payload = crate::decompress::tests_synth_payload(w, h, 0xABBA);
        let (hw, hh) = (w / 2, h / 2);
        let targets = [(300usize, 300usize), (120usize, 120usize)];

        let full = || {
            let raw = crate::decompress::decompress(&payload, w, h).unwrap();
            let half = crate::demosaic::demosaic_rggb_half(&raw, w, h).unwrap();
            let _a = reference_downscale(&half, hw, hh, targets[0].0, targets[0].1);
            let _b = reference_downscale(&half, hw, hh, targets[1].0, targets[1].1);
        };
        let stream = || { let _ = build_previews_streaming(&payload, w, h, &targets).unwrap(); };

        let iters = 30u32;
        let (mut tf, mut ts) = (0u128, 0u128);
        for k in 0..iters {
            if k & 1 == 0 {
                let t = Instant::now(); full();   tf += t.elapsed().as_nanos();
                let t = Instant::now(); stream(); ts += t.elapsed().as_nanos();
            } else {
                let t = Instant::now(); stream(); ts += t.elapsed().as_nanos();
                let t = Instant::now(); full();   tf += t.elapsed().as_nanos();
            }
        }
        let (mf, ms) = (tf as f64 / iters as f64 / 1e6, ts as f64 / iters as f64 / 1e6);
        println!("preview build: FULL {:.3} ms  STREAM {:.3} ms  delta {:+.2}%", mf, ms, (ms - mf) / mf * 100.0);
    }
```

Run: `ct "test --release -p raw-pipeline --lib preview_build_ab_timing -- --ignored --nocapture"`
Expected: STREAM within noise of FULL or faster. **Gate: not a regression.** If STREAM is materially slower, tune `STRIP_ROWS` (try 32 / 96 / 128) and re-run; keep the best non-regressing value.

- [ ] **Step 3: Full suites + wasm build**

Run: `ct "test -p raw-pipeline --lib"`
Expected: all pass (210 prior + the new streaming tests).

Run: `cargo check --target wasm32-unknown-unknown`
Expected: `Finished`, no errors.

- [ ] **Step 4: Update deferred log + memory.** In `Questions_deferred.md`, mark the streaming API item as designed + implemented (link the spec + plan). Add a one-line memory pointer noting the streaming preview path landed byte-exact with the measured peak-mem ratio.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/stream_preview.rs Questions_deferred.md
git commit -m "test(stream_preview): peak-mem probe + preview-build flipflop; docs"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** Layer 1 → Tasks 1–3; Layer 2 → Task 3; Layer 3 demosaic → Task 4; downscale → Task 5; fusion → Task 6; gating/integration → Task 7; byte-exact + peak-mem + perf + wasm verification → Tasks 2/4/5/6/8. WB fold-in is intentionally reduced to a **gate-and-bail** (Task 7) per the YAGNI decision; the fold-in accumulator remains future work (spec §7 / §12).
- **Placeholder scan:** every code step contains complete code; test steps contain full assertions; commands are exact.
- **Type consistency:** `RawRowSource::next_row_into`, `OrfRowDecoder::new`, `for_each_strip(src, strip_rows, scratch, sink)`, `demosaic_half_band(raw_strip, width, k_rows, out_half)`, `StreamingBoxDownscale::{new,push_row,finish}`, `build_previews_streaming(compressed, w, h, targets) -> Vec<Vec<u8>>` are used consistently across tasks.
- **Known risks flagged inline:** (a) Task 1 must hold perf (re-run the bisect); (b) `src/lib.rs` may not compile natively — Task 7 falls back to a pure gate helper + wasm check; (c) the `reference_downscale` oracle must stay a verbatim copy of `downscale_rgb16_impl` — noted at its definition.

## Open items for the executor

- Confirm the exact import name for the `raw-pipeline` crate in `src/lib.rs` (`raw_pipeline` vs an alias) — Task 7 Step 2.
- Confirm `preview_can_halve`, `target_dims`, `OUT_*`, `OLYMPUS_BLACK_LEVEL`, `now_ms`, `OrfDecoded` field list are in scope at the insertion point (they are, in `decode_orf_raw`) and that `OrfDecoded` has exactly the fields written in Task 7 Step 1 (cross-check against the struct definition before compiling).
