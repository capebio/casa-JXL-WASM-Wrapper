# CasaVideo Container MVP (Architecture A — all-intra GOP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A self-contained `CasaVideo` (`.casv`) container in the Rust raw-pipeline that encodes a sequence of RGB8 frames as an all-intra JPEG-XL video and decodes them back byte-exactly, with random access by frame index.

**Architecture:** A pure-container format layered over the existing BSD-clean `jxl_casaencoder`/`jxl_casadecoder` (exactly as `JXTC` layers spatial tiles), living in a new native-only module `crates/raw-pipeline/src/casa_video.rs`. Every frame is an independent JXL codestream (Architecture A); a 32-byte little-endian header + an `(offset,len)` index table + concatenated codestreams give O(1) random access. This is the spine that later plans (zero-motion delta, the diagnostic levers, muxing) extend — none of that is in scope here.

**Tech Stack:** Rust, `jxl_casaencoder::encode_rgb8`, `jxl_casadecoder::decode_interleaved`, `thiserror`. Native + `jxl-codec` feature only (mirrors `jxl_casaencoder`'s `#![cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]`). Tested natively under the **MSVC** toolchain (the GNU toolchain can't link the `jxl-codec` C-FFI here).

**Container layout (all little-endian):**
```
[0..32)                       header (32 bytes)
    0..4    magic   = 0x5641_5343  ('CASV')
    4..8    version = 1
    8..12   width
    12..16  height
    16..20  frame_count
    20..24  fps_num
    24..28  fps_den
    28..32  flags   (reserved, 0 for v0 — future: bit0 has_alpha, bit1 16-bit, bit2 has_P_frames)
[32 .. 32 + 8*frame_count)    index: per frame { offset:u32 (absolute), len:u32 }
[data ...]                    concatenated per-frame JXL codestreams
```

**Test command (run from repo root, MSVC toolchain):**
`.\build-msvc.ps1 test -p raw-pipeline --features jxl-codec casa_video`
If the workspace form is awkward, the equivalent is: `cd crates/raw-pipeline; cargo +stable-x86_64-pc-windows-msvc test --features jxl-codec casa_video`.

---

### Task 1: Module scaffold + header build/parse

**Files:**
- Create: `crates/raw-pipeline/src/casa_video.rs`
- Modify: `crates/raw-pipeline/src/lib.rs` (add the module declaration next to `jxl_casaencoder`)

- [ ] **Step 1: Create the module with constants, header type, and the failing test**

Create `crates/raw-pipeline/src/casa_video.rs`:

```rust
//! CasaVideo (`.casv`) — an all-intra JPEG-XL video container.
//!
//! Pure container math layered over the BSD-clean `jxl_casaencoder` /
//! `jxl_casadecoder`, exactly as `JXTC` layers spatial tiles. Every frame is an
//! independent JXL codestream (Architecture A); a 32-byte header + an
//! `(offset,len)` index give O(1) random access. Native + `jxl-codec` only.

#![cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]

use crate::jxl_casaencoder::{encode_rgb8, EncodeOptions};

pub const CASV_MAGIC: u32 = 0x5641_5343; // 'CASV' little-endian
pub const CASV_VERSION: u32 = 1;
pub const CASV_HEADER_BYTES: usize = 32;
pub const CASV_INDEX_ENTRY_BYTES: usize = 8;

#[derive(thiserror::Error, Debug)]
pub enum VideoError {
    #[error("frame encode: {0}")]
    Encode(#[from] crate::jxl_casaencoder::EncodeError),
    #[error("no frames supplied")]
    Empty,
    #[error("frame {idx}: expected {expected} RGB8 bytes, got {got}")]
    FrameSize { idx: usize, expected: usize, got: usize },
}

/// Parsed 32-byte CasaVideo header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CasvHeader {
    pub width: u32,
    pub height: u32,
    pub frame_count: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub flags: u32,
}

/// Serialize the 32-byte little-endian header.
pub fn build_casv_header(h: &CasvHeader) -> [u8; CASV_HEADER_BYTES] {
    let mut b = [0u8; CASV_HEADER_BYTES];
    b[0..4].copy_from_slice(&CASV_MAGIC.to_le_bytes());
    b[4..8].copy_from_slice(&CASV_VERSION.to_le_bytes());
    b[8..12].copy_from_slice(&h.width.to_le_bytes());
    b[12..16].copy_from_slice(&h.height.to_le_bytes());
    b[16..20].copy_from_slice(&h.frame_count.to_le_bytes());
    b[20..24].copy_from_slice(&h.fps_num.to_le_bytes());
    b[24..28].copy_from_slice(&h.fps_den.to_le_bytes());
    b[28..32].copy_from_slice(&h.flags.to_le_bytes());
    b
}

/// Parse and validate the header. `None` on bad magic/version/zero dims.
pub fn parse_casv_header(data: &[u8]) -> Option<CasvHeader> {
    if data.len() < CASV_HEADER_BYTES {
        return None;
    }
    let rd = |o: usize| u32::from_le_bytes(data[o..o + 4].try_into().ok().unwrap());
    if rd(0) != CASV_MAGIC || rd(4) != CASV_VERSION {
        return None;
    }
    let h = CasvHeader {
        width: rd(8),
        height: rd(12),
        frame_count: rd(16),
        fps_num: rd(20),
        fps_den: rd(24),
        flags: rd(28),
    };
    if h.width == 0 || h.height == 0 || h.frame_count == 0 || h.fps_den == 0 {
        return None;
    }
    Some(h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_roundtrips_and_rejects_garbage() {
        let h = CasvHeader { width: 64, height: 48, frame_count: 10, fps_num: 24, fps_den: 1, flags: 0 };
        let bytes = build_casv_header(&h);
        assert_eq!(parse_casv_header(&bytes), Some(h));

        let mut bad = bytes;
        bad[0] ^= 0xFF; // corrupt magic
        assert_eq!(parse_casv_header(&bad), None);

        assert_eq!(parse_casv_header(&bytes[..16]), None); // truncated

        let mut zero_fps = build_casv_header(&h);
        zero_fps[24..28].copy_from_slice(&0u32.to_le_bytes()); // fps_den = 0
        assert_eq!(parse_casv_header(&zero_fps), None);
    }
}
```

- [ ] **Step 2: Declare the module in `lib.rs`**

In `crates/raw-pipeline/src/lib.rs`, find the declaration of `jxl_casaencoder` (search for `mod jxl_casaencoder`) and add directly after it:

```rust
#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
pub mod casa_video;
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `.\build-msvc.ps1 test -p raw-pipeline --features jxl-codec casa_video::tests::header_roundtrips_and_rejects_garbage`
Expected: PASS (1 passed).

- [ ] **Step 4: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs crates/raw-pipeline/src/lib.rs
git commit -m "feat(casa_video): CASV container header build/parse"
```

---

### Task 2: All-intra encoder

**Files:**
- Modify: `crates/raw-pipeline/src/casa_video.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `casa_video.rs`:

```rust
    // Deterministic gradient RGB8 frame; `seed` shifts colours so frames differ.
    fn gradient(w: u32, h: u32, seed: u8) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 3) as usize);
        for y in 0..h {
            for x in 0..w {
                v.push((x as u8).wrapping_add(seed));
                v.push((y as u8).wrapping_add(seed.wrapping_mul(2)));
                v.push(((x + y) as u8).wrapping_add(seed.wrapping_mul(3)));
            }
        }
        v
    }

    #[test]
    fn encode_produces_valid_header() {
        let (w, h) = (16u32, 12u32);
        let f0 = gradient(w, h, 0);
        let f1 = gradient(w, h, 40);
        let frames: [&[u8]; 2] = [&f0, &f1];
        let bytes = encode_casv_rgb8(&frames, w, h, 24, 1, EncodeOptions::lossless()).unwrap();

        let hdr = parse_casv_header(&bytes).expect("valid header");
        assert_eq!(hdr.width, w);
        assert_eq!(hdr.height, h);
        assert_eq!(hdr.frame_count, 2);
        assert_eq!(hdr.fps_num, 24);
        assert_eq!(hdr.fps_den, 1);

        // empty input rejected
        assert!(matches!(encode_casv_rgb8(&[], w, h, 24, 1, EncodeOptions::lossless()), Err(VideoError::Empty)));

        // wrong-sized frame rejected
        let short = vec![0u8; 10];
        let bad: [&[u8]; 1] = [&short];
        assert!(matches!(
            encode_casv_rgb8(&bad, w, h, 24, 1, EncodeOptions::lossless()),
            Err(VideoError::FrameSize { idx: 0, .. })
        ));
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.\build-msvc.ps1 test -p raw-pipeline --features jxl-codec casa_video::tests::encode_produces_valid_header`
Expected: FAIL to compile — `cannot find function encode_casv_rgb8`.

- [ ] **Step 3: Implement the encoder**

Add to `casa_video.rs` (above the `tests` module):

```rust
/// Encode a sequence of interleaved RGB8 frames into a `.casv` byte vector.
/// Every frame is an independent JXL codestream (all-intra, Architecture A).
///
/// `frames[i]` must be exactly `width*height*3` bytes. `opts` is applied to every
/// frame (use `EncodeOptions::lossless()` for byte-exact round-trips).
pub fn encode_casv_rgb8(
    frames: &[&[u8]],
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    opts: EncodeOptions,
) -> Result<Vec<u8>, VideoError> {
    if frames.is_empty() {
        return Err(VideoError::Empty);
    }
    let expected = (width as usize) * (height as usize) * 3;

    // Encode every frame first so we know each codestream length for the index.
    let mut streams: Vec<Vec<u8>> = Vec::with_capacity(frames.len());
    for (idx, px) in frames.iter().enumerate() {
        if px.len() != expected {
            return Err(VideoError::FrameSize { idx, expected, got: px.len() });
        }
        streams.push(encode_rgb8(px, width, height, opts.clone())?);
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

    let total: usize = data_start + streams.iter().map(|s| s.len()).sum::<usize>();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&build_casv_header(&header));

    // Index: absolute offsets from file start.
    let mut offset = data_start;
    for s in &streams {
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        out.extend_from_slice(&(s.len() as u32).to_le_bytes());
        offset += s.len();
    }
    // Data.
    for s in &streams {
        out.extend_from_slice(s);
    }
    Ok(out)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `.\build-msvc.ps1 test -p raw-pipeline --features jxl-codec casa_video::tests::encode_produces_valid_header`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs
git commit -m "feat(casa_video): all-intra RGB8 encoder"
```

---

### Task 3: Frame slice + byte-exact decode round-trip

**Files:**
- Modify: `crates/raw-pipeline/src/casa_video.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:

```rust
    #[test]
    fn lossless_roundtrip_is_byte_exact() {
        let (w, h) = (24u32, 16u32);
        let src: Vec<Vec<u8>> = (0..3).map(|s| gradient(w, h, (s * 50) as u8)).collect();
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_rgb8(&refs, w, h, 24, 1, EncodeOptions::lossless()).unwrap();

        let all = decode_casv_all_rgb8(&bytes).expect("decode all");
        assert_eq!(all.len(), 3);
        for (i, (px, dw, dh)) in all.iter().enumerate() {
            assert_eq!((*dw, *dh), (w, h), "frame {i} dims");
            assert_eq!(px, &src[i], "frame {i} must be byte-exact (lossless)");
        }
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.\build-msvc.ps1 test -p raw-pipeline --features jxl-codec casa_video::tests::lossless_roundtrip_is_byte_exact`
Expected: FAIL to compile — `cannot find function decode_casv_all_rgb8`.

- [ ] **Step 3: Implement the decode path**

Add to `casa_video.rs` (above `tests`):

```rust
use crate::jxl_casadecoder::decode_interleaved;

/// Borrow the JXL codestream bytes for frame `index`, validated against the
/// index table and file bounds. `None` if `index` is out of range or the index
/// entry points outside the file.
pub fn casv_frame_slice(data: &[u8], index: usize) -> Option<&[u8]> {
    let hdr = parse_casv_header(data)?;
    if index >= hdr.frame_count as usize {
        return None;
    }
    let entry = CASV_HEADER_BYTES + index * CASV_INDEX_ENTRY_BYTES;
    if data.len() < entry + CASV_INDEX_ENTRY_BYTES {
        return None;
    }
    let offset = u32::from_le_bytes(data[entry..entry + 4].try_into().ok()?) as usize;
    let len = u32::from_le_bytes(data[entry + 4..entry + 8].try_into().ok()?) as usize;
    let end = offset.checked_add(len)?;
    if offset < CASV_HEADER_BYTES || end > data.len() {
        return None;
    }
    Some(&data[offset..end])
}

/// Decode a single frame to interleaved RGB8 `(pixels, width, height)`.
pub fn decode_casv_frame_rgb8(data: &[u8], index: usize) -> Option<(Vec<u8>, u32, u32)> {
    let stream = casv_frame_slice(data, index)?;
    decode_interleaved::<u8>(stream, 3)
}

/// Decode every frame in order. `None` if any frame fails to decode.
pub fn decode_casv_all_rgb8(data: &[u8]) -> Option<Vec<(Vec<u8>, u32, u32)>> {
    let hdr = parse_casv_header(data)?;
    (0..hdr.frame_count as usize)
        .map(|i| decode_casv_frame_rgb8(data, i))
        .collect()
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `.\build-msvc.ps1 test -p raw-pipeline --features jxl-codec casa_video::tests::lossless_roundtrip_is_byte_exact`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs
git commit -m "feat(casa_video): frame-slice + byte-exact RGB8 decode"
```

---

### Task 4: Random access + robustness

**Files:**
- Modify: `crates/raw-pipeline/src/casa_video.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:

```rust
    #[test]
    fn random_access_and_corruption_are_safe() {
        let (w, h) = (20u32, 20u32);
        let src: Vec<Vec<u8>> = (0..4).map(|s| gradient(w, h, (s * 30) as u8)).collect();
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_rgb8(&refs, w, h, 30, 1, EncodeOptions::lossless()).unwrap();

        // O(1) random access: frame 2 decodes to frame 2 without touching others.
        let (px2, _, _) = decode_casv_frame_rgb8(&bytes, 2).expect("frame 2");
        assert_eq!(px2, src[2]);

        // Out-of-range index.
        assert!(decode_casv_frame_rgb8(&bytes, 4).is_none());
        assert!(casv_frame_slice(&bytes, 99).is_none());

        // Corrupt magic → no header → no frames.
        let mut corrupt = bytes.clone();
        corrupt[1] ^= 0xFF;
        assert!(decode_casv_all_rgb8(&corrupt).is_none());

        // Truncated file (index says more bytes than exist) → safe None, no panic.
        let truncated = &bytes[..bytes.len() - 5];
        // last frame slice now runs past the end:
        let last = parse_casv_header(&bytes).unwrap().frame_count as usize - 1;
        assert!(casv_frame_slice(truncated, last).is_none());
    }
```

- [ ] **Step 2: Run the test to verify it passes**

The bounds checks from Task 3 already make this safe. Run:
`.\build-msvc.ps1 test -p raw-pipeline --features jxl-codec casa_video::tests::random_access_and_corruption_are_safe`
Expected: PASS. (If it fails, the failure points to a missing bounds check in `casv_frame_slice` — fix it there, do not weaken the test.)

- [ ] **Step 3: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs
git commit -m "test(casa_video): random access + corruption safety"
```

---

### Task 5: Full-suite verification + module doc

**Files:**
- Modify: `crates/raw-pipeline/src/casa_video.rs` (doc only)

- [ ] **Step 1: Confirm the whole `casa_video` suite passes together**

Run: `.\build-msvc.ps1 test -p raw-pipeline --features jxl-codec casa_video`
Expected: PASS — 4 tests (`header_roundtrips_and_rejects_garbage`, `encode_produces_valid_header`, `lossless_roundtrip_is_byte_exact`, `random_access_and_corruption_are_safe`).

- [ ] **Step 2: Confirm the wasm build is unaffected (module is cfg-gated out)**

Run: `cargo check -p raw-pipeline --target wasm32-unknown-unknown`
Expected: PASS (the `#![cfg(...)]` excludes `casa_video` from wasm; no new errors vs. baseline).

- [ ] **Step 3: Add a one-line usage example to the module doc**

At the top of `casa_video.rs`, append to the module doc comment:

```rust
//!
//! ```ignore
//! let casv = encode_casv_rgb8(&[&frame0, &frame1], w, h, 24, 1, EncodeOptions::lossless())?;
//! let (px, w, h) = decode_casv_frame_rgb8(&casv, 1).unwrap(); // O(1) random access
//! ```
```

- [ ] **Step 4: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs
git commit -m "docs(casa_video): usage example + verified wasm-gated"
```

---

## What this deliberately does NOT do (next plans)

- **Zero-motion delta / P-frames** (Architecture B, prediction model 1): reference + ADD-residual + in-loop reconstruct + rate control. Needs a `flags` bit2 + per-frame type in the index. Separate plan.
- **Diagnostic levers**: temporal noise/grain reuse (`photon_noise`), static block-skip, temporal chroma, ROI-adaptive quant. Separate plan(s).
- **Layered horizontal shift** (prediction model 2, train parallax) and **muxing/seek/audio**. Separate plans.

## Self-review notes

- **Spec coverage:** implements the §3.1 container + §4 Architecture-A MVP spine from `docs/superpowers/specs/2026-07-01-jxl-video-codec-design.md`; delta/levers/mux are explicitly deferred per that spec's phased plan.
- **Type consistency:** `CasvHeader`, `VideoError`, `encode_casv_rgb8`, `casv_frame_slice`, `decode_casv_frame_rgb8`, `decode_casv_all_rgb8` used identically across all tasks; `EncodeOptions::lossless()` and `encode_rgb8`/`decode_interleaved::<u8>(_, 3)` match the real signatures in `jxl_casaencoder.rs` / `jxl_casadecoder.rs`.
- **No placeholders:** every step has complete code and an exact command with expected result.
