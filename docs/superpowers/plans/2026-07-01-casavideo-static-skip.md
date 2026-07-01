# CasaVideo Static Skip — Bounding-Box P-frames (first speed lever) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounding-box P-frames to CasaVideo: a P-frame encodes only the *changed rectangle* vs the previous frame, so localized-motion content (trail-cam, screen, static-cam) encodes AND decodes far less per frame — the first speed+bandwidth lever.

**Architecture:** Extends P2's delta. A new encoder `encode_casv_delta_bbox_rgb8` marks bounding-box P-frames with a **second index flag bit** (`CASV_BBOX_FLAG`, additive — P2's full-residual P-frames and all-intra files are untouched). A bbox P-frame's payload is an 8-byte `[x,y,w,h]` header + the lossless JXL residual of just that rectangle; identical frames carry a zero-area header and no image. Decode copies the previous reconstructed frame and wrapping-adds the decoded rectangle residual into that region — byte-exact. On scattered/noisy content the bbox grows to the whole frame (graceful fallback to a full P-frame, never worse).

**Tech Stack:** Rust, existing `casa_video`. Native + `jxl-codec`, MSVC-tested. Reuses `encode_rgb8` / `decode_interleaved::<u8>` on the cropped rectangle.

**Test command (from `crates/raw-pipeline`):** `cargo +stable-x86_64-pc-windows-msvc test --features jxl-codec casa_video` (or `..\..\build-msvc.ps1 test --features jxl-codec casa_video`).

---

### Task 1: Bounding-box of changed pixels

**Files:**
- Modify: `crates/raw-pipeline/src/casa_video.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:

```rust
    #[test]
    fn changed_bbox_is_tight() {
        let (w, h) = (10u32, 8u32);
        let a = vec![0u8; (w * h * 3) as usize];
        // identical → None
        assert_eq!(changed_bbox(&a, &a, w, h), None);
        // one changed pixel at (x=4,y=3) → 1x1 bbox there
        let mut b = a.clone();
        let o = ((3 * w + 4) * 3) as usize;
        b[o + 1] = 200;
        assert_eq!(changed_bbox(&b, &a, w, h), Some((4, 3, 1, 1)));
        // two corners changed → bbox spans them
        let mut c = a.clone();
        c[0] = 5; // (0,0)
        let o2 = ((7 * w + 9) * 3) as usize;
        c[o2] = 5; // (9,7)
        assert_eq!(changed_bbox(&c, &a, w, h), Some((0, 0, 10, 8)));
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo +stable-x86_64-pc-windows-msvc test --features jxl-codec casa_video::tests::changed_bbox_is_tight`
Expected: FAIL to compile — `cannot find function changed_bbox`.

- [ ] **Step 3: Implement `changed_bbox`**

Add to `casa_video.rs` (above the `tests` module):

```rust
/// Tight bounding box `(x, y, w, h)` of pixels that differ between `cur` and
/// `prev` (interleaved RGB8, `stride = width*3`). `None` if the frames are
/// identical.
fn changed_bbox(cur: &[u8], prev: &[u8], width: u32, height: u32) -> Option<(u32, u32, u32, u32)> {
    let w = width as usize;
    let (mut minx, mut miny, mut maxx, mut maxy) = (usize::MAX, usize::MAX, 0usize, 0usize);
    let mut any = false;
    for y in 0..height as usize {
        for x in 0..w {
            let o = (y * w + x) * 3;
            if cur[o] != prev[o] || cur[o + 1] != prev[o + 1] || cur[o + 2] != prev[o + 2] {
                any = true;
                if x < minx { minx = x; }
                if x > maxx { maxx = x; }
                if y < miny { miny = y; }
                if y > maxy { maxy = y; }
            }
        }
    }
    if !any {
        return None;
    }
    Some((minx as u32, miny as u32, (maxx - minx + 1) as u32, (maxy - miny + 1) as u32))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo +stable-x86_64-pc-windows-msvc test --features jxl-codec casa_video::tests::changed_bbox_is_tight`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs
git commit -m "feat(casa_video): changed-pixel bounding box helper"
```

---

### Task 2: Crop helper + bbox flag + flag-aware len masking

**Files:**
- Modify: `crates/raw-pipeline/src/casa_video.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:

```rust
    #[test]
    fn crop_and_bbox_flag() {
        // crop_rgb extracts a sub-rectangle row-by-row.
        let (w, _h) = (4u32, 3u32);
        // 4x3 RGB where each pixel = (x, y, 0)
        let mut src = Vec::new();
        for y in 0..3u8 { for x in 0..4u8 { src.push(x); src.push(y); src.push(0); } }
        let sub = crop_rgb(&src, w, 1, 1, 2, 2); // x=1,y=1,2x2
        assert_eq!(sub, vec![1,1,0, 2,1,0, 1,2,0, 2,2,0]);

        // Masking both flag bits recovers the true length.
        let raw = 123u32;
        let field = raw | CASV_PFRAME_FLAG | CASV_BBOX_FLAG;
        assert_eq!(field & !(CASV_PFRAME_FLAG | CASV_BBOX_FLAG), raw);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo +stable-x86_64-pc-windows-msvc test --features jxl-codec casa_video::tests::crop_and_bbox_flag`
Expected: FAIL to compile — `cannot find function crop_rgb` / `cannot find value CASV_BBOX_FLAG`.

- [ ] **Step 3: Add the flag, fix len masking, add `crop_rgb`**

Add the constant next to `CASV_PFRAME_FLAG`:

```rust
/// Second flag bit: a P-frame stored as a bounding-box (changed-rectangle) frame.
pub const CASV_BBOX_FLAG: u32 = 0x4000_0000;
```

In `casv_frame_info`, change the `len` computation to mask **both** flag bits:

```rust
    let len = (len_field & !(CASV_PFRAME_FLAG | CASV_BBOX_FLAG)) as usize;
```

Add `crop_rgb` (above the `tests` module):

```rust
/// Copy a `bw×bh` RGB8 sub-rectangle at `(x,y)` out of a `width`-wide image.
fn crop_rgb(src: &[u8], width: u32, x: u32, y: u32, bw: u32, bh: u32) -> Vec<u8> {
    let (w, x, y, bw, bh) = (width as usize, x as usize, y as usize, bw as usize, bh as usize);
    let mut out = Vec::with_capacity(bw * bh * 3);
    for row in 0..bh {
        let start = ((y + row) * w + x) * 3;
        out.extend_from_slice(&src[start..start + bw * 3]);
    }
    out
}

/// Report whether P-frame `index` is stored in bounding-box form.
pub fn casv_frame_is_bbox(data: &[u8], index: usize) -> Option<bool> {
    let hdr = parse_casv_header(data)?;
    if index >= hdr.frame_count as usize {
        return None;
    }
    let entry = CASV_HEADER_BYTES + index * CASV_INDEX_ENTRY_BYTES;
    if data.len() < entry + CASV_INDEX_ENTRY_BYTES {
        return None;
    }
    let len_field = u32::from_le_bytes(data[entry + 4..entry + 8].try_into().ok()?);
    Some((len_field & CASV_BBOX_FLAG) != 0)
}
```

- [ ] **Step 4: Run to verify it passes (and P2/phase-1 tests still pass)**

Run: `cargo +stable-x86_64-pc-windows-msvc test --features jxl-codec casa_video`
Expected: PASS — the widened len mask is a no-op for existing files (bbox bit clear).

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs
git commit -m "feat(casa_video): bbox flag, crop_rgb, flag-aware len masking"
```

---

### Task 3: Bounding-box delta encoder

**Files:**
- Modify: `crates/raw-pipeline/src/casa_video.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:

```rust
    #[test]
    fn bbox_encoder_marks_frames_and_shrinks() {
        let (w, h) = (64u32, 64u32);
        let src = low_motion(w, h, 8); // fixed bg + small moving square
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_delta_bbox_rgb8(&refs, w, h, 24, 1, 8, EncodeOptions::lossless()).unwrap();

        // Frame 0 = I; frames 1..8 = bbox P-frames.
        assert!(!casv_frame_info(&bytes, 0).unwrap().0);
        for i in 1..8 {
            assert!(casv_frame_info(&bytes, i).unwrap().0, "frame {i} is P");
            assert!(casv_frame_is_bbox(&bytes, i).unwrap(), "frame {i} is bbox");
        }
        // Bbox delta must beat the full-residual delta (only a tiny rect changes).
        let full = encode_casv_delta_rgb8(&refs, w, h, 24, 1, 8, EncodeOptions::lossless()).unwrap();
        assert!(
            (bytes.len() as f64) < (full.len() as f64),
            "bbox ({}) should be smaller than full-residual delta ({})",
            bytes.len(),
            full.len()
        );
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo +stable-x86_64-pc-windows-msvc test --features jxl-codec casa_video::tests::bbox_encoder_marks_frames_and_shrinks`
Expected: FAIL to compile — `cannot find function encode_casv_delta_bbox_rgb8`.

- [ ] **Step 3: Implement the bbox encoder**

Add to `casa_video.rs` (above the `tests` module):

```rust
/// Encode RGB8 frames with GOP + **bounding-box** P-frames: each P-frame stores
/// an 8-byte `[x,y,w,h]` (u16 LE) header followed by the lossless JXL residual of
/// just that changed rectangle (empty rect ⇒ no image). Best for localized-motion
/// content; falls back to a full-frame rect on scattered change. Lossless ⇒
/// drift-free.
pub fn encode_casv_delta_bbox_rgb8(
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

    // (is_p, is_bbox, payload_bytes) per frame.
    let mut streams: Vec<(bool, bool, Vec<u8>)> = Vec::with_capacity(frames.len());
    for (idx, px) in frames.iter().enumerate() {
        if px.len() != expected {
            return Err(VideoError::FrameSize { idx, expected, got: px.len() });
        }
        if idx % gop == 0 {
            streams.push((false, false, encode_rgb8(px, width, height, opts.clone())?));
            continue;
        }
        let prev = frames[idx - 1];
        let mut payload = Vec::new();
        match changed_bbox(px, prev, width, height) {
            None => {
                // identical: zero-area header, no image.
                payload.extend_from_slice(&0u16.to_le_bytes()); // x
                payload.extend_from_slice(&0u16.to_le_bytes()); // y
                payload.extend_from_slice(&0u16.to_le_bytes()); // w
                payload.extend_from_slice(&0u16.to_le_bytes()); // h
            }
            Some((x, y, bw, bh)) => {
                let cur_crop = crop_rgb(px, width, x, y, bw, bh);
                let prev_crop = crop_rgb(prev, width, x, y, bw, bh);
                let resid = wrapping_residual(&cur_crop, &prev_crop);
                let jxl = encode_rgb8(&resid, bw, bh, opts.clone())?;
                payload.extend_from_slice(&(x as u16).to_le_bytes());
                payload.extend_from_slice(&(y as u16).to_le_bytes());
                payload.extend_from_slice(&(bw as u16).to_le_bytes());
                payload.extend_from_slice(&(bh as u16).to_le_bytes());
                payload.extend_from_slice(&jxl);
            }
        }
        streams.push((true, true, payload));
    }

    let header = CasvHeader {
        width, height, frame_count: frames.len() as u32, fps_num, fps_den, flags: 0,
    };
    let index_bytes = frames.len() * CASV_INDEX_ENTRY_BYTES;
    let data_start = CASV_HEADER_BYTES + index_bytes;
    let total: usize = data_start + streams.iter().map(|(_, _, s)| s.len()).sum::<usize>();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&build_casv_header(&header));

    let mut offset = data_start;
    for (is_p, is_bbox, s) in &streams {
        let mut len_field = s.len() as u32;
        if *is_p { len_field |= CASV_PFRAME_FLAG; }
        if *is_bbox { len_field |= CASV_BBOX_FLAG; }
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        out.extend_from_slice(&len_field.to_le_bytes());
        offset += s.len();
    }
    for (_, _, s) in &streams {
        out.extend_from_slice(s);
    }
    Ok(out)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo +stable-x86_64-pc-windows-msvc test --features jxl-codec casa_video::tests::bbox_encoder_marks_frames_and_shrinks`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs
git commit -m "feat(casa_video): bounding-box delta encoder"
```

---

### Task 4: Bounding-box decode (byte-exact) + random access

**Files:**
- Modify: `crates/raw-pipeline/src/casa_video.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:

```rust
    #[test]
    fn bbox_roundtrip_is_byte_exact() {
        let (w, h) = (64u32, 48u32);
        let src = low_motion(w, h, 10);
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        // GOP=5 → I at 0 and 5; bbox P-frames elsewhere.
        let bytes = encode_casv_delta_bbox_rgb8(&refs, w, h, 24, 1, 5, EncodeOptions::lossless()).unwrap();

        let all = decode_casv_all_rgb8(&bytes).expect("decode all");
        assert_eq!(all.len(), 10);
        for (i, (px, _, _)) in all.iter().enumerate() {
            assert_eq!(px, &src[i], "bbox frame {i} must reconstruct byte-exact");
        }
        // Random access into a bbox P-frame (frame 8; I at 5).
        let (px8, _, _) = decode_casv_frame_rgb8(&bytes, 8).unwrap();
        assert_eq!(px8, src[8]);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo +stable-x86_64-pc-windows-msvc test --features jxl-codec casa_video::tests::bbox_roundtrip_is_byte_exact`
Expected: FAIL — the current decode treats a bbox payload as a full residual image; pixels won't match.

- [ ] **Step 3: Add a unified P-frame apply + route bbox frames through it**

Add the apply helper (above the `tests` module):

```rust
/// Reconstruct a P-frame in place: `prev` holds the previous reconstructed
/// frame and is mutated into the current frame. Handles both full-residual and
/// bounding-box P-frames. Returns `None` on malformed payloads.
fn apply_pframe(prev: &mut [u8], is_bbox: bool, slice: &[u8], width: u32) -> Option<()> {
    if !is_bbox {
        let (resid, _, _) = decode_interleaved::<u8>(slice, 3)?;
        if resid.len() != prev.len() {
            return None;
        }
        wrapping_add_into(prev, &resid);
        return Some(());
    }
    // bbox: 8-byte [x,y,w,h] header + optional residual JXL.
    if slice.len() < 8 {
        return None;
    }
    let rd = |o: usize| u16::from_le_bytes(slice[o..o + 2].try_into().unwrap()) as u32;
    let (x, y, bw, bh) = (rd(0), rd(2), rd(4), rd(6));
    if bw == 0 || bh == 0 {
        return Some(()); // identical frame: prev already correct
    }
    let (resid, dw, dh) = decode_interleaved::<u8>(&slice[8..], 3)?;
    if dw != bw || dh != bh || resid.len() != (bw * bh * 3) as usize {
        return None;
    }
    let w = width as usize;
    for row in 0..bh as usize {
        let dst = ((y as usize + row) * w + x as usize) * 3;
        let srow = row * bw as usize * 3;
        for c in 0..(bw as usize * 3) {
            prev[dst + c] = prev[dst + c].wrapping_add(resid[srow + c]);
        }
    }
    Some(())
}
```

Now replace the two decode functions so P-frames route through `apply_pframe`:

```rust
pub fn decode_casv_frame_rgb8(data: &[u8], index: usize) -> Option<(Vec<u8>, u32, u32)> {
    let start = preceding_iframe(data, index)?;
    let hdr = parse_casv_header(data)?;
    let (w, h) = (hdr.width, hdr.height);
    let mut cur: Option<Vec<u8>> = None;
    for i in start..=index {
        let (is_p, slice) = casv_frame_info(data, i)?;
        if is_p {
            let mut prev = cur.take()?;
            apply_pframe(&mut prev, casv_frame_is_bbox(data, i)?, slice, w)?;
            cur = Some(prev);
        } else {
            let (px, dw, dh) = decode_interleaved::<u8>(slice, 3)?;
            if (dw, dh) != (w, h) {
                return None;
            }
            cur = Some(px);
        }
    }
    cur.map(|px| (px, w, h))
}

pub fn decode_casv_all_rgb8(data: &[u8]) -> Option<Vec<(Vec<u8>, u32, u32)>> {
    let hdr = parse_casv_header(data)?;
    let (w, h) = (hdr.width, hdr.height);
    let mut out = Vec::with_capacity(hdr.frame_count as usize);
    let mut prev: Option<Vec<u8>> = None;
    for i in 0..hdr.frame_count as usize {
        let (is_p, slice) = casv_frame_info(data, i)?;
        let recon = if is_p {
            let mut base = prev.take()?;
            apply_pframe(&mut base, casv_frame_is_bbox(data, i)?, slice, w)?;
            base
        } else {
            let (px, dw, dh) = decode_interleaved::<u8>(slice, 3)?;
            if (dw, dh) != (w, h) {
                return None;
            }
            px
        };
        prev = Some(recon.clone());
        out.push((recon, w, h));
    }
    Some(out)
}
```

- [ ] **Step 4: Run the whole suite**

Run: `cargo +stable-x86_64-pc-windows-msvc test --features jxl-codec casa_video`
Expected: PASS — all prior tests (all-intra + full-residual delta, now routed through `apply_pframe` with `is_bbox=false`) plus the new bbox tests.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs
git commit -m "feat(casa_video): bounding-box P-frame decode (byte-exact) + unified apply"
```

---

### Task 5: Doc + full verification

**Files:**
- Modify: `crates/raw-pipeline/src/casa_video.rs` (doc only)

- [ ] **Step 1: Append to the module doc**

```rust
//!
//! Static skip: `encode_casv_delta_bbox_rgb8(..., gop_len, opts)` codes each
//! P-frame as only the changed bounding rectangle (`CASV_BBOX_FLAG`), so
//! localized-motion content decodes/encodes far fewer pixels. Byte-exact.
```

- [ ] **Step 2: Full suite + wasm-gated check**

Run: `cargo +stable-x86_64-pc-windows-msvc test --features jxl-codec casa_video`
Expected: PASS — 13 tests.

Run (from `crates/raw-pipeline`): `cargo check --lib --target wasm32-unknown-unknown`
Expected: `Finished` (module cfg-gated out of wasm).

- [ ] **Step 3: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs
git commit -m "docs(casa_video): static-skip usage + verified"
```

---

## What this deliberately does NOT do (next plans)

- **Per-tile skip** (scattered-change content — a tile-grid + skip-bitmap generalization of bbox). Follow-on.
- **Lossy near-static skip** (threshold > 0; needs drift/in-loop). Belongs with lossy-delta.
- Temporal noise/chroma/ROI levers, layered horizontal shift, muxing.

## Self-review notes

- **Spec coverage:** implements the §7/§8 "static block-skip" lever as bounding-box P-frames (localized-motion form); tile-grid and lossy variants deferred.
- **Type consistency:** `changed_bbox`, `crop_rgb`, `CASV_BBOX_FLAG`, `casv_frame_is_bbox`, `encode_casv_delta_bbox_rgb8`, `apply_pframe` used consistently; `apply_pframe` unifies full-residual (P2) and bbox reconstruction so both decode paths stay byte-exact.
- **Backward compatibility:** the widened `len` mask (`!(PFRAME|BBOX)`) is a no-op when the bbox bit is clear, so all-intra + P2 full-residual files decode unchanged; P2 P-frames now flow through `apply_pframe(is_bbox=false)`.
- **No placeholders:** every step has complete code and an exact command with expected result.
