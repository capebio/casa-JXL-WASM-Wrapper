# CasaVideo Per-Tile Skip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize bounding-box skip to a **tile grid**: a P-frame codes only the tiles that changed vs the previous frame, so *scattered / multi-region* motion (multiple subjects, screen widgets) skips unchanged tiles instead of spanning them with one loose rectangle.

**Architecture:** Extends the static-skip work. A new encoder `encode_casv_delta_tiled_rgb8` marks tile P-frames with a **third index flag bit** (`CASV_TILE_FLAG`, additive — all-intra / P2 full-residual / bbox frames untouched). A tile P-frame's payload is `[tile_size u16][changed-tile bitmap][atlas JXL]`, where the atlas is a single `tile_size`-wide image stacking each changed tile's residual in a `tile_size×tile_size` slot (edge tiles zero-padded). Decode copies the previous reconstructed frame, decodes the atlas once, and wrapping-adds each changed tile back into place — byte-exact. Decode cost scales with *changed tile count*, not frame size.

**Tech Stack:** Rust, existing `casa_video`. Native + `jxl-codec`, MSVC-tested.

**Test command (from `crates/raw-pipeline`):** `cargo +stable-x86_64-pc-windows-msvc test --features jxl-codec casa_video`.

---

### Task 1: Tile geometry + changed-tile map

**Files:**
- Modify: `crates/raw-pipeline/src/casa_video.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:

```rust
    #[test]
    fn tile_map_flags_changed_tiles() {
        let (w, h, tile) = (8u32, 8u32, 4u32); // 2x2 tiles
        let a = vec![0u8; (w * h * 3) as usize];
        assert_eq!(tile_grid(w, h, tile), (2, 2));
        assert_eq!(changed_tile_map(&a, &a, w, h, tile), vec![false; 4]);
        // change one pixel in the bottom-right tile (x=6,y=6) → only tile index 3.
        let mut b = a.clone();
        b[((6 * w + 6) * 3) as usize] = 99;
        assert_eq!(changed_tile_map(&b, &a, w, h, tile), vec![false, false, false, true]);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo +stable-x86_64-pc-windows-msvc test --features jxl-codec casa_video::tests::tile_map_flags_changed_tiles`
Expected: FAIL to compile — `cannot find function tile_grid` / `changed_tile_map`.

- [ ] **Step 3: Implement geometry + change map**

Add to `casa_video.rs` (above the `tests` module):

```rust
/// `(tiles_x, tiles_y)` for a `width×height` image at `tile` size.
fn tile_grid(width: u32, height: u32, tile: u32) -> (u32, u32) {
    (width.div_ceil(tile), height.div_ceil(tile))
}

/// Per-tile changed flags (row-major, index = ty*tiles_x + tx): a tile is
/// changed if any pixel in it differs between `cur` and `prev`.
fn changed_tile_map(cur: &[u8], prev: &[u8], width: u32, height: u32, tile: u32) -> Vec<bool> {
    let (txn, tyn) = tile_grid(width, height, tile);
    let (w, t) = (width as usize, tile as usize);
    let mut map = vec![false; (txn * tyn) as usize];
    for ty in 0..tyn as usize {
        for tx in 0..txn as usize {
            let x0 = tx * t;
            let y0 = ty * t;
            let bw = t.min(w - x0);
            let bh = t.min(height as usize - y0);
            let mut changed = false;
            'tile: for row in 0..bh {
                let base = ((y0 + row) * w + x0) * 3;
                for c in 0..bw * 3 {
                    if cur[base + c] != prev[base + c] {
                        changed = true;
                        break 'tile;
                    }
                }
            }
            map[ty * txn as usize + tx] = changed;
        }
    }
    map
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo +stable-x86_64-pc-windows-msvc test --features jxl-codec casa_video::tests::tile_map_flags_changed_tiles`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs
git commit -m "feat(casa_video): tile grid + changed-tile map"
```

---

### Task 2: Tile flag + form dispatch

**Files:**
- Modify: `crates/raw-pipeline/src/casa_video.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:

```rust
    #[test]
    fn tile_flag_and_mask() {
        let raw = 77u32;
        let field = raw | CASV_PFRAME_FLAG | CASV_TILE_FLAG;
        assert_eq!(field & !(CASV_PFRAME_FLAG | CASV_BBOX_FLAG | CASV_TILE_FLAG), raw);
        assert_ne!(CASV_TILE_FLAG, CASV_BBOX_FLAG);
        assert_ne!(CASV_TILE_FLAG, CASV_PFRAME_FLAG);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo +stable-x86_64-pc-windows-msvc test --features jxl-codec casa_video::tests::tile_flag_and_mask`
Expected: FAIL to compile — `cannot find value CASV_TILE_FLAG`.

- [ ] **Step 3: Add the flag, widen the len mask, add the form query**

Add the constant next to `CASV_BBOX_FLAG`:

```rust
/// Third flag bit: a P-frame stored as a tile-grid (changed-tiles) frame.
pub const CASV_TILE_FLAG: u32 = 0x2000_0000;
```

In `casv_frame_info`, widen the `len` mask to exclude all three flag bits:

```rust
    let len = (len_field & !(CASV_PFRAME_FLAG | CASV_BBOX_FLAG | CASV_TILE_FLAG)) as usize;
```

Add the tile-form query (next to `casv_frame_is_bbox`):

```rust
/// Report whether P-frame `index` is stored in tile-grid form.
pub fn casv_frame_is_tile(data: &[u8], index: usize) -> Option<bool> {
    let hdr = parse_casv_header(data)?;
    if index >= hdr.frame_count as usize {
        return None;
    }
    let entry = CASV_HEADER_BYTES + index * CASV_INDEX_ENTRY_BYTES;
    if data.len() < entry + CASV_INDEX_ENTRY_BYTES {
        return None;
    }
    let len_field = u32::from_le_bytes(data[entry + 4..entry + 8].try_into().ok()?);
    Some((len_field & CASV_TILE_FLAG) != 0)
}
```

- [ ] **Step 4: Run to verify it passes (and existing suite still passes)**

Run: `cargo +stable-x86_64-pc-windows-msvc test --features jxl-codec casa_video`
Expected: PASS — the widened mask is a no-op when the tile bit is clear.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs
git commit -m "feat(casa_video): tile flag + widened len mask + casv_frame_is_tile"
```

---

### Task 3: Tile encoder (atlas of changed tiles)

**Files:**
- Modify: `crates/raw-pipeline/src/casa_video.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:

```rust
    // Two small squares far apart move each frame → scattered change.
    fn two_region_motion(w: u32, h: u32, n: usize) -> Vec<Vec<u8>> {
        let base = gradient(w, h, 7);
        (0..n)
            .map(|f| {
                let mut v = base.clone();
                for (bx, by, col) in [
                    ((2 + f as u32) % (w / 2 - 4), 4u32, [255u8, 0, 0]),
                    (w / 2 + (2 + f as u32) % (w / 2 - 4), h - 8, [0u8, 0, 255]),
                ] {
                    for yy in by..by + 3 {
                        for xx in bx..bx + 3 {
                            let o = ((yy * w + xx) * 3) as usize;
                            v[o] = col[0]; v[o + 1] = col[1]; v[o + 2] = col[2];
                        }
                    }
                }
                v
            })
            .collect()
    }

    #[test]
    fn tile_encoder_marks_and_beats_bbox_on_scatter() {
        let (w, h) = (64u32, 64u32);
        let src = two_region_motion(w, h, 8);
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let tiled = encode_casv_delta_tiled_rgb8(&refs, w, h, 24, 1, 8, 16, EncodeOptions::lossless()).unwrap();

        assert!(!casv_frame_info(&tiled, 0).unwrap().0);
        for i in 1..8 {
            assert!(casv_frame_is_tile(&tiled, i).unwrap(), "frame {i} is tile");
        }
        // Two far-apart regions: bbox spans the gap; tiles skip it ⇒ tiled smaller.
        let bbox = encode_casv_delta_bbox_rgb8(&refs, w, h, 24, 1, 8, EncodeOptions::lossless()).unwrap();
        assert!(
            (tiled.len() as f64) < (bbox.len() as f64),
            "tiled ({}) should beat bbox ({}) on scattered change",
            tiled.len(),
            bbox.len()
        );
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo +stable-x86_64-pc-windows-msvc test --features jxl-codec casa_video::tests::tile_encoder_marks_and_beats_bbox_on_scatter`
Expected: FAIL to compile — `cannot find function encode_casv_delta_tiled_rgb8`.

- [ ] **Step 3: Implement the tile encoder**

Add to `casa_video.rs` (above the `tests` module):

```rust
/// Encode RGB8 frames with GOP + **tile-grid** P-frames. Each P-frame payload is
/// `[tile_size u16][changed-tile bitmap][atlas JXL]`; the atlas is one
/// `tile_size`-wide image stacking each changed tile's residual in a
/// `tile_size×tile_size` slot (edge tiles zero-padded). Best for scattered /
/// multi-region motion. Lossless ⇒ drift-free.
pub fn encode_casv_delta_tiled_rgb8(
    frames: &[&[u8]],
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    gop_len: u32,
    tile: u32,
    opts: EncodeOptions,
) -> Result<Vec<u8>, VideoError> {
    if frames.is_empty() {
        return Err(VideoError::Empty);
    }
    let expected = (width as usize) * (height as usize) * 3;
    let gop = gop_len.max(1) as usize;
    let t = tile.max(1);
    let (txn, _tyn) = tile_grid(width, height, t);
    let (w, ts) = (width as usize, t as usize);

    let mut streams: Vec<(bool, Vec<u8>)> = Vec::with_capacity(frames.len());
    for (idx, px) in frames.iter().enumerate() {
        if px.len() != expected {
            return Err(VideoError::FrameSize { idx, expected, got: px.len() });
        }
        if idx % gop == 0 {
            streams.push((false, encode_rgb8(px, width, height, opts.clone())?));
            continue;
        }
        let prev = frames[idx - 1];
        let map = changed_tile_map(px, prev, width, height, t);
        let changed: Vec<usize> = map.iter().enumerate().filter(|(_, &c)| c).map(|(i, _)| i).collect();

        let mut payload = Vec::new();
        payload.extend_from_slice(&(t as u16).to_le_bytes());
        let bitmap_len = map.len().div_ceil(8);
        let mut bitmap = vec![0u8; bitmap_len];
        for &i in &changed {
            bitmap[i / 8] |= 1 << (i % 8);
        }
        payload.extend_from_slice(&bitmap);

        if !changed.is_empty() {
            // atlas: tile wide × (count*tile) tall, zero-padded, residuals per slot.
            let mut atlas = vec![0u8; ts * ts * 3 * changed.len()];
            for (slot, &i) in changed.iter().enumerate() {
                let tx = (i as u32 % txn) as usize;
                let ty = (i as u32 / txn) as usize;
                let bw = ts.min(w - tx * ts);
                let bh = ts.min(height as usize - ty * ts);
                for row in 0..bh {
                    for col in 0..bw {
                        let src = ((ty * ts + row) * w + tx * ts + col) * 3;
                        let dst = ((slot * ts + row) * ts + col) * 3;
                        for c in 0..3 {
                            atlas[dst + c] = px[src + c].wrapping_sub(prev[src + c]);
                        }
                    }
                }
            }
            let jxl = encode_rgb8(&atlas, t, t * changed.len() as u32, opts.clone())?;
            payload.extend_from_slice(&jxl);
        }
        streams.push((true, payload));
    }

    let header = CasvHeader {
        width, height, frame_count: frames.len() as u32, fps_num, fps_den, flags: 0,
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
            len_field |= CASV_PFRAME_FLAG | CASV_TILE_FLAG;
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

Run: `cargo +stable-x86_64-pc-windows-msvc test --features jxl-codec casa_video::tests::tile_encoder_marks_and_beats_bbox_on_scatter`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs
git commit -m "feat(casa_video): tile-grid delta encoder (changed-tile atlas)"
```

---

### Task 4: Tile decode (byte-exact scatter)

**Files:**
- Modify: `crates/raw-pipeline/src/casa_video.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:

```rust
    #[test]
    fn tile_roundtrip_is_byte_exact() {
        let (w, h) = (64u32, 64u32);
        let src = two_region_motion(w, h, 10);
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_delta_tiled_rgb8(&refs, w, h, 24, 1, 5, 16, EncodeOptions::lossless()).unwrap();

        let all = decode_casv_all_rgb8(&bytes).expect("decode all");
        assert_eq!(all.len(), 10);
        for (i, (px, _, _)) in all.iter().enumerate() {
            assert_eq!(px, &src[i], "tile frame {i} must reconstruct byte-exact");
        }
        let (px8, _, _) = decode_casv_frame_rgb8(&bytes, 8).unwrap();
        assert_eq!(px8, src[8]);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo +stable-x86_64-pc-windows-msvc test --features jxl-codec casa_video::tests::tile_roundtrip_is_byte_exact`
Expected: FAIL — current decode has no tile branch; pixels won't match.

- [ ] **Step 3: Add the tile branch to `apply_pframe` and thread `is_tile` + `height` through the decoders**

Replace the `apply_pframe` signature and body so it also handles tiles (note the new `is_tile` and `height` params):

```rust
fn apply_pframe(
    prev: &mut [u8],
    is_bbox: bool,
    is_tile: bool,
    slice: &[u8],
    width: u32,
    height: u32,
) -> Option<()> {
    if is_tile {
        if slice.len() < 2 {
            return None;
        }
        let t = u16::from_le_bytes(slice[0..2].try_into().unwrap()) as u32;
        if t == 0 {
            return None;
        }
        let (txn, tyn) = tile_grid(width, height, t);
        let n = (txn * tyn) as usize;
        let bitmap_len = n.div_ceil(8);
        if slice.len() < 2 + bitmap_len {
            return None;
        }
        let bitmap = &slice[2..2 + bitmap_len];
        let changed: Vec<usize> = (0..n).filter(|&i| bitmap[i / 8] & (1 << (i % 8)) != 0).collect();
        if changed.is_empty() {
            return Some(());
        }
        let (atlas, aw, ah) = decode_interleaved::<u8>(&slice[2 + bitmap_len..], 3)?;
        if aw != t || ah != t * changed.len() as u32 {
            return None;
        }
        let (w, ts) = (width as usize, t as usize);
        for (slot, &i) in changed.iter().enumerate() {
            let tx = (i as u32 % txn) as usize;
            let ty = (i as u32 / txn) as usize;
            let bw = ts.min(w - tx * ts);
            let bh = ts.min(height as usize - ty * ts);
            for row in 0..bh {
                for col in 0..bw {
                    let asrc = ((slot * ts + row) * ts + col) * 3;
                    let fdst = ((ty * ts + row) * w + tx * ts + col) * 3;
                    for c in 0..3 {
                        prev[fdst + c] = prev[fdst + c].wrapping_add(atlas[asrc + c]);
                    }
                }
            }
        }
        return Some(());
    }
    if !is_bbox {
        let (resid, _, _) = decode_interleaved::<u8>(slice, 3)?;
        if resid.len() != prev.len() {
            return None;
        }
        wrapping_add_into(prev, &resid);
        return Some(());
    }
    if slice.len() < 8 {
        return None;
    }
    let rd = |o: usize| u16::from_le_bytes(slice[o..o + 2].try_into().unwrap()) as u32;
    let (x, y, bw, bh) = (rd(0), rd(2), rd(4), rd(6));
    if bw == 0 || bh == 0 {
        return Some(());
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

Update the two `apply_pframe` call sites to pass `is_tile` and `height`. In `decode_casv_frame_rgb8`:

```rust
            apply_pframe(&mut prev, casv_frame_is_bbox(data, i)?, casv_frame_is_tile(data, i)?, slice, w, h)?;
```

In `decode_casv_all_rgb8`:

```rust
            apply_pframe(&mut base, casv_frame_is_bbox(data, i)?, casv_frame_is_tile(data, i)?, slice, w, h)?;
```

- [ ] **Step 4: Run the whole suite**

Run: `cargo +stable-x86_64-pc-windows-msvc test --features jxl-codec casa_video`
Expected: PASS — all prior tests (routed through the extended `apply_pframe`, `is_tile=false`) plus `tile_roundtrip_is_byte_exact`.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs
git commit -m "feat(casa_video): tile P-frame decode (byte-exact scatter)"
```

---

### Task 5: Doc + full verification

**Files:**
- Modify: `crates/raw-pipeline/src/casa_video.rs` (doc only)

- [ ] **Step 1: Append to the module doc**

```rust
//!
//! Per-tile skip: `encode_casv_delta_tiled_rgb8(..., gop_len, tile, opts)` codes
//! only changed tiles (`CASV_TILE_FLAG`, atlas of residual tiles), for scattered
//! multi-region motion. Byte-exact.
```

- [ ] **Step 2: Full suite + wasm-gated check**

Run: `cargo +stable-x86_64-pc-windows-msvc test --features jxl-codec casa_video`
Expected: PASS — 17 tests.

Run (from `crates/raw-pipeline`): `cargo check --lib --target wasm32-unknown-unknown`
Expected: `Finished`.

- [ ] **Step 3: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs
git commit -m "docs(casa_video): per-tile skip usage + verified"
```

---

## What this deliberately does NOT do (next plans)

- **Atlas packing efficiency** (2-D bin-pack instead of vertical stack) — minor size win, deferred.
- **Lossy near-static tile skip** (threshold > 0; drift/in-loop) — with the lossy-delta plan.
- Temporal noise/chroma/ROI levers, layered horizontal shift, muxing.

## Self-review notes

- **Spec coverage:** implements the per-tile-skip generalization of the §7/§8 static-skip lever.
- **Type consistency:** `tile_grid`, `changed_tile_map`, `CASV_TILE_FLAG`, `casv_frame_is_tile`, `encode_casv_delta_tiled_rgb8`, extended `apply_pframe(is_bbox, is_tile, …, width, height)` used consistently; atlas layout (`tile`-wide, `count*tile`-tall, per-slot top-left residual) matches between encoder and decoder.
- **Backward compatibility:** the widened `len` mask is a no-op when the tile bit is clear; all prior forms (all-intra, P2 full-residual, bbox) decode unchanged through `apply_pframe` with `is_tile=false`.
- **No placeholders:** every step has complete code and an exact command with expected result.
