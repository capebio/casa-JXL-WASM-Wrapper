# CR2 Fused Reassembly+Crop & LJPEG C4 Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Byte-exact perf pass on `crates/raw-pipeline/src/cr2.rs` (+ `ljpeg.rs` cps=4 kernel): fuse multi-slice reassembly with crop directly into the output buffer, eliminate warm-scratch zero-refill, specialize the 4-component LJPEG kernel, add reassembly timing, and close file-controlled multiply-overflow micro-holes.

**Architecture:** The multi-slice path currently builds a full temp raster (zero-fill + full copy), crops in place, then truncates/clones. Replace with a row-major segment walk that `extend_from_slice`s only crop-window intersections into the final output Vec (no zero-fill, no temp raster, no separate crop pass). Scratch mode stops truncating so the next `resize` is a no-op. `decode_impl` gains a bench-only `ReassemblyVariant` (Fused default / SplitBulk / SplitScatter) so the legacy pipeline stays callable for parity + flip. `ljpeg.rs` gains `decode_c4` mirroring the shipped `decode_c2` pattern (bit-identical to `decode_generic`).

**Tech Stack:** Rust (stable-gnu native for examples with `--no-default-features`, MSVC for full test suite via `build-msvc.ps1`, `wasm32-unknown-unknown` check). Fixtures: 11 real CR2s in `C:\Foo\raw-converter\tests` (4× multi-slice cps=4 p14 `[2,1728,1888]` 550D; 7× single-slice cps=2 p14 6000×4000).

**Verified evidence (2026-07-02):**
- `cr2_slice_scan`: multi files total−ljpeg ≈ 150 ms overhead (untimed reassemble + crop); singles ≈ 90 ms.
- `cr2_ljpeg_probe`: `_MG_1744.CR2` → cps=4 p14 → `decode_generic` (635 ms, dominant); `ADH 1234.CR2` → cps=2 p14 → `decode_c2`.
- ljpeg kernels write every `(row < out_rows, col < out_pixel_cols)` sample on success and bail on any entropy error → full-write invariant holds; zero-fill elision safe.
- Production entry: `src/lib.rs decode_cr2_raw` → `cr2::decode_bytes_with_clock` (move_buf=true). `decode_with_scratch` has no production callers (tests only).

---

### Task 1: Overflow micro-fixes + alloc-free canon make check

**Files:**
- Modify: `crates/raw-pipeline/src/cr2.rs` (`entry_first_u32` ~line 138, MakerNote 0x4001 visitor ~line 486, 0xC640 visitor ~line 513, `canon_color_matrix` ~line 258)
- Test: same file `mod tests`

- [x] **Step 1: Write failing/locking tests**

```rust
#[test]
fn entry_first_u32_huge_count_no_wrap() {
    // cnt*ts would wrap 32-bit usize; must fall through to the out-of-line branch
    // (val as usize = OOB) and return None — not read the inline area.
    let data = vec![0xABu8; 32];
    // dtype=3 (SHORT, ts=2), cnt = 0x8000_0003 → bytes wraps to 6 on 32-bit.
    assert_eq!(entry_first_u32(&data, 3, 0x8000_0003, 0xFFFF_FFFF, 4, true), None);
}

#[test]
fn canon_color_matrix_no_alloc_semantics() {
    // Same behavior for all case variants; still None while canon_cam_xyz is disabled.
    assert!(canon_color_matrix("CANON", "Canon EOS 550D").is_none());
    assert!(canon_color_matrix("canon inc.", "Canon EOS 550D").is_none());
    assert!(canon_color_matrix("Nikon", "D850").is_none());
}
```

- [x] **Step 2: Run to verify current behavior** — `entry_first_u32_huge_count_no_wrap` may already pass on 64-bit (usize wide); it locks 32-bit semantics via the code change. Run: `cargo test -p raw-pipeline --no-default-features cr2` (from `crates/raw-pipeline`: `cargo test --no-default-features cr2::`).

- [x] **Step 3: Implement**

In `entry_first_u32`, replace
```rust
let bytes = ts * cnt as usize;
let p = if bytes <= 4 { inline_pos } else { val as usize };
```
with
```rust
// u64 math: ts*cnt is file-controlled and can wrap usize on 32-bit/wasm,
// spuriously selecting the inline branch. Same result for all valid files.
let inline = (ts as u64) * (cnt as u64) <= 4;
let p = if inline { inline_pos } else { val as usize };
```

In the 0x4001 visitor replace
```rust
let bytes = 2 * cnt as usize;
let p = if bytes <= 4 { ip } else { val as usize };
```
with
```rust
// cnt<=2 ⟺ 2*cnt<=4 without the file-controlled multiply (wraps on 32-bit).
let p = if cnt <= 2 { ip } else { val as usize };
```
Same replacement in the 0xC640 visitor.

In `canon_color_matrix` replace
```rust
if !make.to_ascii_lowercase().contains("canon") {
```
with
```rust
// Alloc-free ASCII case-insensitive "canon" search (was a String alloc per decode).
let has_canon = make.as_bytes()
    .windows(5)
    .any(|w| w.eq_ignore_ascii_case(b"canon"));
if !has_canon {
```

- [x] **Step 4: Run tests** — expect PASS.

- [x] **Step 5: Commit** — `perf(cr2): overflow-safe inline detection + alloc-free canon make check`

### Task 2: Fused reassemble+crop function + property tests

**Files:**
- Modify: `crates/raw-pipeline/src/cr2.rs` (add fn after `reassemble_slices_scatter`)
- Test: same file `mod tests`

- [x] **Step 1: Write failing property test**

```rust
#[test]
fn fused_reassemble_crop_matches_split_composition() {
    // (n, nw, lw, high, left, top, crop_w, crop_h); stride = n*nw + lw.
    // left/top even (decode_impl snaps), crop within bounds. Includes real 550D
    // geometry, lw==0 (no remainder), crop==full, crop inside one slice, crop
    // spanning all slices.
    let cases = [
        (2usize, 4usize, 6usize, 5usize, 2usize, 0usize, 8usize, 4usize),
        (3, 8, 8, 7, 0, 2, 32, 5),
        (1, 16, 4, 9, 4, 2, 10, 6),
        (2, 1728, 1888, 12, 80, 2, 5184, 8),  // real Canon widths
        (4, 5, 3, 6, 0, 0, 23, 6),             // crop == full frame
        (2, 8, 0, 5, 2, 0, 12, 5),             // lw == 0
        (3, 10, 5, 8, 12, 2, 6, 4),            // crop inside slice 1
    ];
    for &(n, nw, lw, high, left, top, cw, ch) in &cases {
        let stride = n * nw + lw;
        assert!(left + cw <= stride && top + ch <= high, "bad case");
        let src: Vec<u16> = (0..stride * high).map(|i| (i % 65535) as u16).collect();
        // Split composition: full reassemble then crop.
        let raster = reassemble_slices(&src, stride, high, n, nw, lw);
        let mut want = Vec::with_capacity(cw * ch);
        for row in 0..ch {
            let s = (top + row) * stride + left;
            want.extend_from_slice(&raster[s..s + cw]);
        }
        let got = reassemble_slices_crop(&src, stride, high, n, nw, lw, left, top, cw, ch);
        assert_eq!(got, want, "n={n} nw={nw} lw={lw} high={high} l={left} t={top} {cw}x{ch}");
    }
}
```

- [x] **Step 2: Run — FAIL (fn missing).**

- [x] **Step 3: Implement**

```rust
/// Fused multi-slice reassembly + crop. Builds the final crop_w×crop_h raster
/// directly from the STACKED slice decode buffer — no full-raster temp, no
/// zero-fill, no separate crop pass. Row-major output construction: for each
/// output row, append the crop-window intersection of each vertical slice in
/// left-to-right order (the intersections tile [0, crop_w) exactly because the
/// slices tile [0, stride) and decode_impl enforces stride == n*nw + lw).
/// Byte-identical to reassemble_slices(..) followed by the row crop (see
/// tests::fused_reassemble_crop_matches_split_composition).
fn reassemble_slices_crop(
    src: &[u16],
    stride: usize,
    high: usize,
    n: usize,
    nw: usize,
    lw: usize,
    left: usize,
    top: usize,
    crop_w: usize,
    crop_h: usize,
) -> Vec<u16> {
    // Per-slice crop intersection: source block base, slice width, first source
    // column, run length. ≤ n+1 entries — computed once, reused for every row.
    struct Seg { src_base: usize, sw: usize, src_col: usize, run: usize }
    let block = nw * high;
    let crop_right = left + crop_w;
    let mut segs: Vec<Seg> = Vec::with_capacity(n + 1);
    for i in 0..=n {
        let sw = if i < n { nw } else { lw };
        if sw == 0 { continue; } // lw==0 → no remainder slice
        let col0 = i * nw;
        if col0 >= stride { break; }
        let sw_eff = sw.min(stride - col0);
        let lo = col0.max(left);
        let hi = (col0 + sw_eff).min(crop_right);
        if lo >= hi { continue; }
        segs.push(Seg { src_base: i * block, sw, src_col: lo - col0, run: hi - lo });
    }
    let mut out = Vec::with_capacity(crop_w * crop_h);
    for row in 0..crop_h {
        let y = top + row;
        for s in &segs {
            let p = s.src_base + y * s.sw + s.src_col;
            out.extend_from_slice(&src[p..p + s.run]);
        }
    }
    out
}
```

- [x] **Step 4: Run tests — PASS.**

- [x] **Step 5: Commit** — `perf(cr2): fused slice-reassembly+crop builder (row-major, zero-fill-free)`

### Task 3: decode_impl restructure — Fused default, ReassemblyVariant, scratch no-truncate, reassemble_ms

**Files:**
- Modify: `crates/raw-pipeline/src/cr2.rs` (`Cr2Timings`, variant plumbing, decode_impl tail from the `if have_slices` block ~line 630 to return)

- [x] **Step 1: Add `ReassemblyVariant` + plumb through entry points**

```rust
/// Bench/parity-only selector for the slice-reassembly pipeline.
/// Fused is the shipped path; Split* preserve the legacy two-pass pipeline.
#[doc(hidden)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ReassemblyVariant { Fused, SplitBulk, SplitScatter }
```
`decode_impl(..., variant: ReassemblyVariant)` replaces `use_scatter: bool`.
- `decode_bytes`, `decode_bytes_bench`, `decode_bytes_with_clock`, `decode_bytes_with_ljpeg_stats`, `decode_with_scratch` → `Fused`.
- `decode_bytes_variant(data, use_scatter)` → `SplitScatter`/`SplitBulk` (keeps `cr2_fulldecode_flip` semantics).
- New: `#[doc(hidden)] pub fn decode_bytes_reassembly(data: &[u8], v: ReassemblyVariant) -> Result<Cr2Image>`.

- [x] **Step 2: Add `reassemble_ms` to `Cr2Timings`**

```rust
/// Slice reassembly time. Fused path: the single fused reassemble+crop pass
/// (crop_ms is 0). Split path (bench-only): the full-raster rebuild.
/// 0 for single-slice files.
pub reassemble_ms: f64,
```

- [x] **Step 3: Replace decode_impl tail (reassembly → return)**

```rust
    // ---- Crop geometry (unchanged) ----
    ...existing crop_w/crop_h/left/top/cfa_phase/bounds code...

    let crop_len = crop_w * crop_h;
    let mut reassemble_ms = 0.0;
    let mut crop_ms = 0.0;
    let raw_out: Vec<u16>;

    if have_slices {
        let n  = cr2_slices[0] as usize;
        let nw = cr2_slices[1] as usize;
        let lw = cr2_slices[2] as usize;
        nw.checked_mul(sof_h).ok_or_else(|| anyhow!("CR2: slice block overflow"))?;
        if variant == ReassemblyVariant::Fused {
            // Shipped path: build the final crop directly from the stacked buffer.
            // raw_buf keeps the full-length stacked decode → in scratch mode the
            // next resize(total_pixels) is a no-op (no tail re-zero-fill).
            let t = mark();
            let out = reassemble_slices_crop(
                raw_buf, stride, sof_h, n, nw, lw, left, top, crop_w, crop_h);
            reassemble_ms = elapsed(t);
            if out.len() != crop_len {
                bail!("CR2: fused reassembly produced {} px, expected {}", out.len(), crop_len);
            }
            raw_out = out;
        } else {
            // Legacy split pipeline (bench/parity only): full raster, then crop.
            let t = mark();
            let raster = if variant == ReassemblyVariant::SplitScatter {
                reassemble_slices_scatter(raw_buf, stride, sof_h, n, nw, lw)
            } else {
                reassemble_slices(raw_buf, stride, sof_h, n, nw, lw)
            };
            *raw_buf = raster;
            reassemble_ms = elapsed(t);
            let t_crop = mark();
            let crop_needed = top != 0 || left != 0 || decoded_width != crop_w;
            if crop_needed {
                for row in 0..crop_h {
                    let srow = (top + row) * stride + left;
                    raw_buf.copy_within(srow..srow + crop_w, row * crop_w);
                }
            }
            raw_buf.truncate(crop_len);
            crop_ms = elapsed(t_crop);
            raw_out = if move_buf { std::mem::take(raw_buf) }
                      else { raw_buf[..crop_len].to_vec() };
        }
    } else if move_buf {
        // Single-slice owned path: in-place compaction (no second Vec) as before.
        let t_crop = mark();
        let crop_needed = top != 0 || left != 0 || decoded_width != crop_w;
        if crop_needed {
            for row in 0..crop_h {
                let srow = (top + row) * stride + left;
                raw_buf.copy_within(srow..srow + crop_w, row * crop_w);
            }
        }
        raw_buf.truncate(crop_len);
        crop_ms = elapsed(t_crop);
        raw_out = std::mem::take(raw_buf);
    } else {
        // Single-slice scratch path: copy crop rows straight into the output —
        // raw_buf is untouched and stays full-length, so the next decode's
        // resize(total_pixels) is a no-op (kills the warm-path tail re-zero and
        // the old crop-in-place + clone double copy).
        let t_crop = mark();
        let mut out = Vec::with_capacity(crop_len);
        for row in 0..crop_h {
            let s = (top + row) * stride + left;
            out.extend_from_slice(&raw_buf[s..s + crop_w]);
        }
        crop_ms = elapsed(t_crop);
        raw_out = out;
    }

    let total_ms = elapsed(t_total);
    let timings = Cr2Timings {
        total_ms, parse_ms, ljpeg_ms, reassemble_ms, crop_ms,
        raw_buf_bytes, crop_buf_bytes: crop_len * 2,
        slices: if have_slices { cr2_slices } else { [0; 3] },
    };
    ...return unchanged...
```

- [x] **Step 4: Tests** — existing `scratch_produces_same_output`, `slice_reassembly_matches_scalar_reference` must pass. Add:

```rust
#[test]
fn variants_byte_identical_on_real_files() {
    // Every fixture: Fused == SplitBulk == SplitScatter, all fields.
    for path in real_cr2_fixtures() {   // helper: glob C:\Foo\raw-converter\tests\*.CR2, skip if absent
        let data = std::fs::read(&path).unwrap();
        let f = decode_bytes_reassembly(&data, ReassemblyVariant::Fused).expect("fused");
        let b = decode_bytes_reassembly(&data, ReassemblyVariant::SplitBulk).expect("bulk");
        assert_eq!(f.raw, b.raw, "{path}");
        assert_eq!((f.width, f.height, f.black, f.white), (b.width, b.height, b.black, b.white));
        assert_eq!(f.wb_r.to_bits(), b.wb_r.to_bits());
        assert_eq!(f.wb_b.to_bits(), b.wb_b.to_bits());
    }
}

#[test]
fn scratch_warm_reuse_across_geometries() {
    // multi → single → multi with ONE scratch: byte-identical to fresh decodes.
    // Exercises the no-truncate warm path (stale tail must be fully overwritten).
    let multi = first_fixture_matching(|t| t.slices != [0,0,0]);
    let single = first_fixture_matching(|t| t.slices == [0,0,0]);
    let (Some(m), Some(s)) = (multi, single) else { return };
    let mut sc = ScratchBuffers::default();
    for data in [&m, &s, &m] {
        let a = decode_with_scratch(data, &mut sc).unwrap();
        let b = decode_bytes(data).unwrap();
        assert_eq!(a.raw, b.raw);
    }
}
```

- [x] **Step 5: Run cr2 test module — PASS. Commit** — `perf(cr2): ship fused reassembly+crop; scratch keeps full-length buffer (no warm re-zero); reassemble_ms timing`

### Task 4: cr2_fused_flip harness + measurement (rule 9)

**Files:**
- Create: `crates/raw-pipeline/examples/cr2_fused_flip.rs` (mirror `cr2_fulldecode_flip.rs`, arms = SplitBulk vs Fused)

- [x] **Steps:** create example (same interleaved start-rotated pattern, 11 rounds, round-0 dropped, parity assert), run on 1 multi (`_MG_1750.CR2`) + 1 single (`ADH 1234.CR2` — expect ≈0, checks no regression) + scratch-mode arm if trivial. Record numbers in commit message. Keep Fused if ≥ Split (rule 10: strictly less work — no zero-fill, no temp raster, no second pass).

Result (2026-07-02, 13 rounds): MULTI −53.5 ms (−7.2%) owned, −64.9 ms (−8.5%) scratch; single-slice scratch −9.9 ms; all parity EXACT. Fused shipped, split retained doc(hidden) for parity/bench.

### Task 5: ljpeg decode_c4 kernel + dispatch

**Files:**
- Modify: `crates/raw-pipeline/src/ljpeg.rs` (add `decode_c4` after `decode_c2` ~line 979; dispatch arms in `execute` ~line 700)
- Test: `mod tests` in same file + real-strip parity

- [x] **Step 1: Write failing test** (real-file parity; synthetic 1×1 cps=4 stream analog of `l17_decode_c2_matches_generic_and_known_p14` if the existing stream-builder helper extends cleanly)

```rust
#[test]
fn c4_matches_generic_on_real_cr2_strip() {
    // Extract the LJPEG strip from a real cps=4 CR2 and compare the dispatched
    // decode_tile (→ decode_c4) against decode_tile_generic sample-for-sample.
    let Some(data) = read_fixture("_MG_1744.CR2") else { return };
    let (strip, w, h) = cr2_strip_geometry(&data);  // helper using cr2-style header walk or raw_pipeline::cr2 internals
    let mut a = vec![0u16; w * h];
    let mut b = vec![0u16; w * h];
    decode_tile(strip, &mut a, 0, w, w, h).unwrap();
    decode_tile_generic(strip, &mut b, 0, w, w, h).unwrap();
    assert_eq!(a, b);
}
```

- [x] **Step 2: Run — currently passes trivially (both route generic). Add dispatch first to see it exercise c4, or accept as regression lock.**

- [x] **Step 3: Implement `decode_c4`** — copy `decode_c2` structure exactly; 4 tables (`plan.tables[0..4]`), 4 predictor chains (`prev0..prev3`, `left0..left3`), per-pixel emit:

```rust
/// Monomorphized four-component kernel — Canon multi-slice CR2 layout
/// (5D/550D-era bodies encode cps=4). Same unrolling rationale as decode_c2:
/// four independent scalar predictor chains and four fixed Huffman tables
/// remove the inner component loop and per-pixel array indexing. Bit-identical
/// to decode_generic for components == 4.
#[inline(always)]
fn decode_c4<const PRECISION: u8, const COLLECT_STATS: bool>(...) -> Result<LjpegStats> {
    let table0..table3 = plan.tables[0..4] as_deref expect;
    ... base_pred, width, height, BitReader — identical preamble ...
    let mut prev0..prev3 = base_pred; 
    for row in 0..height {
        let row_base = base + row * stride_pixels;
        let emit_row = row < out_rows;
        let mut left0..left3 = 0i32;
        for col in 0..width {
            let at_col0 = col == 0;
            // comp 0..3 sequential: pred → next_category → decode_diff → val,
            // left_k = val, if at_col0 { prev_k = val }
            // emit: raw_col = col*4 + k, guarded raw_col < out_pixel_cols,
            // unsafe get_unchecked_mut(row_base + raw_col) = ((val << pt) & 0xFFFF) as u16
        }
    }
    Ok(LjpegStats { cps: 4, ... })
}
```
(Full expansion in code — four copies of the c2 per-component block; SAFETY comments identical to c2.)

Dispatch: add
```rust
(4, 12) => decode_c4::<12, COLLECT_STATS>(...),
(4, 14) => decode_c4::<14, COLLECT_STATS>(...),
(4, 16) => decode_c4::<16, COLLECT_STATS>(...),
```

- [x] **Step 4: Run ljpeg + cr2 tests — PASS (parity test now exercises c4).**

- [x] **Step 5: Commit** — `perf(ljpeg): monomorphized decode_c4 kernel for cps=4 CR2 (550D/5D-era)`

### Task 6: ljpeg_c4_flip harness + measurement

**Files:**
- Create: `crates/raw-pipeline/examples/ljpeg_c4_flip.rs` (mirror `ljpeg_c1_flip.rs` pattern: real CR2 strip, arms = `decode_tile` (c4) vs `decode_tile_generic`, interleaved, parity-asserted)

- [x] **Steps:** create, run on `_MG_1744.CR2`. Expect c2-like gain (−10..30% of ljpeg stage). Keep c4 if ≥ generic (rule 10: strictly less per-symbol work). Record numbers.

Result (2026-07-02, 13 rounds): −80.6 ms = −12.9% on the LJPEG stage (627.2 → 546.6 ms), parity EXACT.

### Task 7: Full verification sweep

- [x] All 11 fixtures: `variants_byte_identical_on_real_files` (Fused == SplitBulk == SplitScatter) — via `cargo test --no-default-features` + fixture-gated tests, and end-to-end flips assert parity.
- [x] Full suite MSVC: `.\build-msvc.ps1 test` equivalent from repo root (memory: run tests from `crates/raw-pipeline`; MSVC for casaencoder FFI). Expect ≥ 216 pass, 0 fail. → 262 passed / 0 failed (`cargo +msvc test --features parallel` full crate).
- [x] WASM: `cargo check --target wasm32-unknown-unknown --no-default-features` from `crates/raw-pipeline` — clean (0 warnings for touched files).
- [x] Re-run `cr2_slice_scan` on all fixtures — confirm reassemble_ms now visible, totals improved. → multi total 785→624 ms (−20%), c4 ljpeg −80 ms + fused −54 ms.

### Task 8: Ledger updates + push

- [x] Append rejections to `docs/1 rejected optimizations.md`: (a) double-SOF3-parse elimination — header scan is µs-scale, ljpeg has a plan cache; no measurable gain; (b) in-place slice permutation (cycle-walk) — cache-hostile irregular access, fused-into-output strictly better.
- [x] Append deferred to `Questions_deferred.md`: (a) SensorInfo 0x00E0 true active-area + real CFA phase (NOT byte-exact — changes crop geometry; kills demosaic phase-retry; needs golden refs + sign-off); (b) DecodeLimits before allocation (WASM 50 MP policy into decoder — behavior/API change); (c) MaybeUninit LJPEG output sink (first-decode zero-fill elision; unsafe boundary needs full-write invariant harness); (d) caller-owned output pool `decode_into` API (no production caller yet).
- [x] Final commit + `git push -u origin perf/cr2-fused-crop-jul02-c2f8`.

---

## Self-review notes

- Spec coverage: fused reassembly+crop (§2C/§3 of analysis) → Tasks 2–4; zero-fill/truncate (§2D) → Task 3; timing gap (§3 micro 5) → Task 3; overflow micros (§3 micro 1–2) → Task 1; dead lowercase alloc (§3 micro 3) → Task 1; C4 kernel (§2E) → Tasks 5–6; active-area/CFA + limits + uninit + decode_into → deferred ledger (Task 8). Double-SOF3 + in-place permutation → rejected ledger (Task 8).
- Byte-exactness gates: property tests (synthetic), 11-fixture three-variant equality, ljpeg real-strip c4-vs-generic parity, full MSVC suite, wasm32 check.
- Types consistent: `ReassemblyVariant` used in Tasks 3–4; `reassemble_slices_crop` defined Task 2, called Task 3.
