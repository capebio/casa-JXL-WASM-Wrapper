# CasaVideo Zero-Motion Delta (P2 — P-frames) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add zero-motion delta (P-frames) to the CasaVideo container so low-motion sequences encode to a fraction of the all-intra size, decoding back byte-exactly.

**Architecture:** GOP structure over the existing `casa_video` module — a periodic **I-frame** (full JXL) followed by **P-frames** whose payload is the **wrapping 8-bit residual** `current − previous` (single previous-frame reference, confirmed optimal by the deepened diagnostic). Coded **lossless**, so `prev + residual == current` exactly by modular arithmetic — **drift-free with no in-loop decode** (that machinery is only needed for the lossy tier, a later plan). Reuses the entire 8-bit encode/decode path (`encode_rgb8` / `decode_interleaved::<u8>`). The P-frame flag rides the **top bit of the index `len` field**, so existing all-intra `.casv` files (top bit always 0) stay valid.

**Tech Stack:** Rust, existing `casa_video` + `jxl_casaencoder`/`jxl_casadecoder`. Native + `jxl-codec`, MSVC-tested.

**Test command (from repo root):** `.\build-msvc.ps1 test -p raw-pipeline --features jxl-codec casa_video` — or from `crates/raw-pipeline`: `cargo +stable-x86_64-pc-windows-msvc test --features jxl-codec casa_video`.

**Why wrapping 8-bit residual:** `r = cur.wrapping_sub(prev)`; `cur = prev.wrapping_add(r)` — exact for all `u8`, so lossless JXL of the residual image round-trips byte-exactly with zero drift. Low-motion residuals stay near 0 (compress well); high-motion wrap is accepted (not the target — that is the lossy/motion tiers later).

---

### Task 1: Frame-type in the index (P-frame flag)

**Files:**
- Modify: `crates/raw-pipeline/src/casa_video.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `casa_video.rs`:

```rust
    #[test]
    fn frame_flag_encodes_in_len_top_bit() {
        // All-intra file: every frame must report is_p == false, slice intact.
        let (w, h) = (12u32, 8u32);
        let src: Vec<Vec<u8>> = (0..3).map(|s| gradient(w, h, (s * 20) as u8)).collect();
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_rgb8(&refs, w, h, 24, 1, EncodeOptions::lossless()).unwrap();
        for i in 0..3 {
            let (is_p, slice) = casv_frame_info(&bytes, i).expect("info");
            assert!(!is_p, "all-intra frame {i} must be I");
            assert_eq!(slice, casv_frame_slice(&bytes, i).unwrap());
        }
        assert!(casv_frame_info(&bytes, 3).is_none()); // out of range
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `.\build-msvc.ps1 test -p raw-pipeline --features jxl-codec casa_video::tests::frame_flag_encodes_in_len_top_bit`
Expected: FAIL to compile — `cannot find function casv_frame_info`.

- [ ] **Step 3: Implement the flag + `casv_frame_info`; make `casv_frame_slice` flag-aware**

In `casa_video.rs`, add the constant near the other consts:

```rust
/// Top bit of an index `len` field flags a P-frame (delta vs previous frame).
/// All-intra files leave it 0, so they remain valid.
pub const CASV_PFRAME_FLAG: u32 = 0x8000_0000;
```

Replace the body of `casv_frame_slice` so it masks the flag out of `len`:

```rust
pub fn casv_frame_slice(data: &[u8], index: usize) -> Option<&[u8]> {
    casv_frame_info(data, index).map(|(_, slice)| slice)
}

/// Like `casv_frame_slice` but also reports whether the frame is a P-frame
/// (delta) vs an I-frame (keyframe).
pub fn casv_frame_info(data: &[u8], index: usize) -> Option<(bool, &[u8])> {
    let hdr = parse_casv_header(data)?;
    if index >= hdr.frame_count as usize {
        return None;
    }
    let entry = CASV_HEADER_BYTES + index * CASV_INDEX_ENTRY_BYTES;
    if data.len() < entry + CASV_INDEX_ENTRY_BYTES {
        return None;
    }
    let offset = u32::from_le_bytes(data[entry..entry + 4].try_into().ok()?) as usize;
    let len_field = u32::from_le_bytes(data[entry + 4..entry + 8].try_into().ok()?);
    let is_p = (len_field & CASV_PFRAME_FLAG) != 0;
    let len = (len_field & !CASV_PFRAME_FLAG) as usize;
    let end = offset.checked_add(len)?;
    if offset < CASV_HEADER_BYTES || end > data.len() {
        return None;
    }
    Some((is_p, &data[offset..end]))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `.\build-msvc.ps1 test -p raw-pipeline --features jxl-codec casa_video::tests::frame_flag_encodes_in_len_top_bit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs
git commit -m "feat(casa_video): P-frame flag in index len top bit + casv_frame_info"
```

---

### Task 2: Delta encoder (GOP + wrapping residual)

**Files:**
- Modify: `crates/raw-pipeline/src/casa_video.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:

```rust
    #[test]
    fn delta_encode_sets_gop_frame_types() {
        let (w, h) = (16u32, 16u32);
        // 8 frames, GOP=4 → I at 0 and 4, P elsewhere.
        let src: Vec<Vec<u8>> = (0..8).map(|s| gradient(w, h, (s * 8) as u8)).collect();
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_delta_rgb8(&refs, w, h, 24, 1, 4, EncodeOptions::lossless()).unwrap();

        let expect_i = [true, false, false, false, true, false, false, false];
        for i in 0..8 {
            let (is_p, _) = casv_frame_info(&bytes, i).unwrap();
            assert_eq!(is_p, !expect_i[i], "frame {i} type");
        }
        // gop_len == 1 ⇒ all-intra.
        let all_i = encode_casv_delta_rgb8(&refs, w, h, 24, 1, 1, EncodeOptions::lossless()).unwrap();
        for i in 0..8 {
            assert!(!casv_frame_info(&all_i, i).unwrap().0, "gop=1 frame {i} must be I");
        }
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `.\build-msvc.ps1 test -p raw-pipeline --features jxl-codec casa_video::tests::delta_encode_sets_gop_frame_types`
Expected: FAIL to compile — `cannot find function encode_casv_delta_rgb8`.

- [ ] **Step 3: Implement the delta encoder + residual helper**

Add to `casa_video.rs` (above the `tests` module):

```rust
/// Per-byte wrapping residual `cur - prev`. Reconstructs exactly via
/// `prev.wrapping_add(residual)`.
fn wrapping_residual(cur: &[u8], prev: &[u8]) -> Vec<u8> {
    cur.iter().zip(prev).map(|(&c, &p)| c.wrapping_sub(p)).collect()
}

/// Encode RGB8 frames with a GOP: frame `i` is an I-frame when `i % gop_len == 0`,
/// otherwise a P-frame carrying the wrapping residual vs the previous frame.
/// `gop_len == 1` ⇒ all-intra (identical bytes to `encode_casv_rgb8`).
///
/// Coded lossless ⇒ drift-free (reconstruction equals source), so no in-loop
/// decode is needed. `opts` should be `EncodeOptions::lossless()` for v0.
pub fn encode_casv_delta_rgb8(
    frames: &[&[u8]],
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    gop_len: u32,
    opts: EncodeOptions,
) -> Result<Vec<u8>, VideoError> {
    if frames.is_empty() {
        return Err(VideoError::Empty);
    }
    let expected = (width as usize) * (height as usize) * 3;
    let gop = gop_len.max(1) as usize;

    // (is_p, jxl_bytes) per frame.
    let mut streams: Vec<(bool, Vec<u8>)> = Vec::with_capacity(frames.len());
    for (idx, px) in frames.iter().enumerate() {
        if px.len() != expected {
            return Err(VideoError::FrameSize { idx, expected, got: px.len() });
        }
        let is_p = idx % gop != 0;
        let payload = if is_p {
            wrapping_residual(px, frames[idx - 1])
        } else {
            px.to_vec()
        };
        streams.push((is_p, encode_rgb8(&payload, width, height, opts.clone())?));
    }

    let header = CasvHeader {
        width,
        height,
        frame_count: frames.len() as u32,
        fps_num,
        fps_den,
        flags: 0,
    };
    let index_bytes = frames.len() * CASV_INDEX_ENTRY_BYTES;
    let data_start = CASV_HEADER_BYTES + index_bytes;
    let total: usize = data_start + streams.iter().map(|(_, s)| s.len()).sum::<usize>();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&build_casv_header(&header));

    let mut offset = data_start;
    for (is_p, s) in &streams {
        let mut len_field = s.len() as u32;
        if *is_p {
            len_field |= CASV_PFRAME_FLAG;
        }
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        out.extend_from_slice(&len_field.to_le_bytes());
        offset += s.len();
    }
    for (_, s) in &streams {
        out.extend_from_slice(s);
    }
    Ok(out)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `.\build-msvc.ps1 test -p raw-pipeline --features jxl-codec casa_video::tests::delta_encode_sets_gop_frame_types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs
git commit -m "feat(casa_video): GOP delta encoder (wrapping residual P-frames)"
```

---

### Task 3: Delta decoder (byte-exact reconstruct)

**Files:**
- Modify: `crates/raw-pipeline/src/casa_video.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:

```rust
    #[test]
    fn delta_roundtrip_is_byte_exact() {
        let (w, h) = (32u32, 24u32);
        let src: Vec<Vec<u8>> = (0..8).map(|s| gradient(w, h, (s * 11) as u8)).collect();
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_delta_rgb8(&refs, w, h, 24, 1, 4, EncodeOptions::lossless()).unwrap();

        let all = decode_casv_all_rgb8(&bytes).expect("decode all");
        assert_eq!(all.len(), 8);
        for (i, (px, dw, dh)) in all.iter().enumerate() {
            assert_eq!((*dw, *dh), (w, h), "frame {i} dims");
            assert_eq!(px, &src[i], "frame {i} must reconstruct byte-exact through P-frames");
        }
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `.\build-msvc.ps1 test -p raw-pipeline --features jxl-codec casa_video::tests::delta_roundtrip_is_byte_exact`
Expected: FAIL — the current `decode_casv_all_rgb8` treats P-frame payloads as full images, so pixels won't match.

- [ ] **Step 3: Implement reconstruction (replace the decode functions)**

In `casa_video.rs`, replace `decode_casv_frame_rgb8` and `decode_casv_all_rgb8` with the P-aware versions, and add the reconstruction helper:

```rust
/// In-place `base[i] = base[i].wrapping_add(residual[i])`.
fn wrapping_add_into(base: &mut [u8], residual: &[u8]) {
    for (b, &r) in base.iter_mut().zip(residual) {
        *b = b.wrapping_add(r);
    }
}

/// Index of the I-frame at or before `index` (the GOP start needed to decode it).
fn preceding_iframe(data: &[u8], index: usize) -> Option<usize> {
    (0..=index).rev().find(|&j| casv_frame_info(data, j).map(|(is_p, _)| !is_p).unwrap_or(false))
}

/// Decode a single frame to interleaved RGB8. For a P-frame this decodes forward
/// from the preceding I-frame (O(GOP)), reconstructing each residual.
pub fn decode_casv_frame_rgb8(data: &[u8], index: usize) -> Option<(Vec<u8>, u32, u32)> {
    let start = preceding_iframe(data, index)?;
    let mut recon: Option<(Vec<u8>, u32, u32)> = None;
    for i in start..=index {
        let (is_p, slice) = casv_frame_info(data, i)?;
        let (payload, w, h) = decode_interleaved::<u8>(slice, 3)?;
        recon = Some(if is_p {
            let (mut prev, _, _) = recon.take()?;
            wrapping_add_into(&mut prev, &payload);
            (prev, w, h)
        } else {
            (payload, w, h)
        });
    }
    recon
}

/// Decode every frame in order, reconstructing P-frames against the running
/// previous frame. `None` if any frame fails to decode.
pub fn decode_casv_all_rgb8(data: &[u8]) -> Option<Vec<(Vec<u8>, u32, u32)>> {
    let hdr = parse_casv_header(data)?;
    let mut out = Vec::with_capacity(hdr.frame_count as usize);
    let mut prev: Option<Vec<u8>> = None;
    for i in 0..hdr.frame_count as usize {
        let (is_p, slice) = casv_frame_info(data, i)?;
        let (payload, w, h) = decode_interleaved::<u8>(slice, 3)?;
        let recon = if is_p {
            let mut base = prev.take()?;
            wrapping_add_into(&mut base, &payload);
            base
        } else {
            payload
        };
        prev = Some(recon.clone());
        out.push((recon, w, h));
    }
    Some(out)
}
```

- [ ] **Step 4: Run to verify it passes (and the all-intra tests still pass)**

Run: `.\build-msvc.ps1 test -p raw-pipeline --features jxl-codec casa_video`
Expected: PASS — all tests incl. `lossless_roundtrip_is_byte_exact` (all-intra, unaffected) and `delta_roundtrip_is_byte_exact`.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs
git commit -m "feat(casa_video): P-frame reconstruct decode (byte-exact, drift-free)"
```

---

### Task 4: Bandwidth win on low-motion content

**Files:**
- Modify: `crates/raw-pipeline/src/casa_video.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:

```rust
    // A near-static sequence: fixed background + a small moving square.
    fn low_motion(w: u32, h: u32, n: usize) -> Vec<Vec<u8>> {
        let base = gradient(w, h, 7);
        (0..n)
            .map(|f| {
                let mut v = base.clone();
                let cx = (2 + f as u32) % (w - 4);
                for yy in (h / 2)..(h / 2 + 3) {
                    for xx in cx..cx + 3 {
                        let o = ((yy * w + xx) * 3) as usize;
                        v[o] = 255; v[o + 1] = 0; v[o + 2] = 0;
                    }
                }
                v
            })
            .collect()
    }

    #[test]
    fn delta_beats_intra_on_low_motion() {
        let (w, h) = (64u32, 64u32);
        let src = low_motion(w, h, 8);
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let intra = encode_casv_rgb8(&refs, w, h, 24, 1, EncodeOptions::lossless()).unwrap();
        let delta = encode_casv_delta_rgb8(&refs, w, h, 24, 1, 8, EncodeOptions::lossless()).unwrap();
        assert!(
            (delta.len() as f64) < 0.6 * (intra.len() as f64),
            "delta ({}) should be well under 60% of intra ({}) on low-motion",
            delta.len(),
            intra.len()
        );
        // And it must still reconstruct exactly.
        let out = decode_casv_all_rgb8(&delta).unwrap();
        for (i, (px, _, _)) in out.iter().enumerate() {
            assert_eq!(px, &src[i], "low-motion frame {i} exact");
        }
    }
```

- [ ] **Step 2: Run to verify it passes**

Run: `.\build-msvc.ps1 test -p raw-pipeline --features jxl-codec casa_video::tests::delta_beats_intra_on_low_motion`
Expected: PASS (the moving square is a few px; residual frames are tiny vs full intra frames). If the ratio assertion fails, inspect the printed sizes — a value near intra means the residual path is not being taken; do **not** weaken the threshold without understanding why.

- [ ] **Step 3: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs
git commit -m "test(casa_video): delta beats intra on low-motion (bandwidth win)"
```

---

### Task 5: Random access to a P-frame + full verification

**Files:**
- Modify: `crates/raw-pipeline/src/casa_video.rs` (doc only)

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:

```rust
    #[test]
    fn random_access_to_pframe_reconstructs() {
        let (w, h) = (24u32, 20u32);
        let src: Vec<Vec<u8>> = (0..8).map(|s| gradient(w, h, (s * 9) as u8)).collect();
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_delta_rgb8(&refs, w, h, 24, 1, 4, EncodeOptions::lossless()).unwrap();

        // Frame 6 is a P-frame (GOP=4 ⇒ I at 4, P at 5,6,7). Random access must
        // walk back to frame 4 and reconstruct forward.
        let (px6, _, _) = decode_casv_frame_rgb8(&bytes, 6).expect("frame 6");
        assert_eq!(px6, src[6]);
        // The I-frame itself decodes directly.
        let (px4, _, _) = decode_casv_frame_rgb8(&bytes, 4).expect("frame 4");
        assert_eq!(px4, src[4]);
    }
```

- [ ] **Step 2: Run to verify it passes**

Run: `.\build-msvc.ps1 test -p raw-pipeline --features jxl-codec casa_video::tests::random_access_to_pframe_reconstructs`
Expected: PASS (implemented in Task 3's `preceding_iframe` walk-back).

- [ ] **Step 3: Run the whole `casa_video` suite**

Run: `.\build-msvc.ps1 test -p raw-pipeline --features jxl-codec casa_video`
Expected: PASS — 8 tests (4 all-intra from phase 1 + `frame_flag_encodes_in_len_top_bit`, `delta_encode_sets_gop_frame_types`, `delta_roundtrip_is_byte_exact`, `delta_beats_intra_on_low_motion`, `random_access_to_pframe_reconstructs`).

- [ ] **Step 4: Update the module doc**

At the top of `casa_video.rs`, append to the module doc comment:

```rust
//!
//! GOP delta (P2): `encode_casv_delta_rgb8(frames, w, h, fps_num, fps_den, gop_len, opts)`
//! codes frame `i%gop_len==0` as an I-frame and the rest as wrapping-residual
//! P-frames vs the previous frame (single-reference, lossless ⇒ drift-free).
```

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs
git commit -m "feat(casa_video): random access to P-frames + P2 doc"
```

---

## What this deliberately does NOT do (next plans)

- **Lossy delta + rate control** — needs in-loop reconstruct (drift) + VBV. Follow-on.
- **Static block-skip** — the shared speed+bandwidth lever; needs a per-block changed/unchanged map against the reference. Its own plan (biggest speed win for 4K/WASM/lossless).
- **Temporal noise/grain reuse** (`photon_noise`), **temporal chroma**, **ROI-adaptive quant**, **layered horizontal shift** (train), **muxing/seek/audio**.

## Self-review notes

- **Spec coverage:** implements §3.1–§3.3 prediction model 1 (zero-motion delta, single reference) from the design doc; lossy/skip/motion deferred per the phased plan.
- **Type consistency:** `casv_frame_info`, `encode_casv_delta_rgb8`, `decode_casv_frame_rgb8`, `decode_casv_all_rgb8`, `CASV_PFRAME_FLAG`, `wrapping_residual`/`wrapping_add_into`/`preceding_iframe` used consistently; reuses real `encode_rgb8` / `decode_interleaved::<u8>(_, 3)` / `EncodeOptions::lossless()`.
- **Backward compatibility:** `casv_frame_slice` now delegates to `casv_frame_info` (flag-masked); all-intra files have the flag clear, so Task 3's decode reconstructs them unchanged (I-frames only) — the phase-1 tests must still pass.
- **No placeholders:** every step has complete code and an exact command with expected result.
