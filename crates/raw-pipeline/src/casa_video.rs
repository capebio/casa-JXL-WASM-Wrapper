//! CasaVideo (`.casv`) — an all-intra JPEG-XL video container.
//!
//! Pure container math layered over the BSD-clean `jxl_casaencoder` /
//! `jxl_casadecoder`, exactly as `JXTC` layers spatial tiles. Every frame is an
//! independent JXL codestream (Architecture A); a 32-byte header + an
//! `(offset,len)` index give O(1) random access. Native + `jxl-codec` only.
//!
//! ```ignore
//! let casv = encode_casv_rgb8(&[&frame0, &frame1], w, h, 24, 1, EncodeOptions::lossless())?;
//! let (px, w, h) = decode_casv_frame_rgb8(&casv, 1).unwrap(); // O(1) random access
//! ```
//!
//! GOP delta (P2): `encode_casv_delta_rgb8(frames, w, h, fps_num, fps_den, gop_len, opts)`
//! codes frame `i%gop_len==0` as an I-frame and the rest as wrapping-residual
//! P-frames vs the previous frame (single-reference, lossless ⇒ drift-free).
//!
//! Static skip: `encode_casv_delta_bbox_rgb8(..., gop_len, opts)` codes each
//! P-frame as only the changed bounding rectangle (`CASV_BBOX_FLAG`), so
//! localized-motion content decodes/encodes far fewer pixels. Byte-exact.
//!
//! Per-tile skip: `encode_casv_delta_tiled_rgb8(..., gop_len, tile, opts)` codes
//! only changed tiles (`CASV_TILE_FLAG`, atlas of residual tiles), for scattered
//! multi-region motion. Byte-exact.

#![cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]

use crate::jxl_casaencoder::{encode_rgb8, EncodeOptions};
use crate::jxl_casadecoder::decode_interleaved;

pub const CASV_MAGIC: u32 = 0x5641_5343; // 'CASV' little-endian
pub const CASV_VERSION: u32 = 1;
pub const CASV_HEADER_BYTES: usize = 32;
pub const CASV_INDEX_ENTRY_BYTES: usize = 8;
/// Top bit of an index `len` field flags a P-frame (delta vs previous frame).
/// All-intra files leave it 0, so they remain valid.
pub const CASV_PFRAME_FLAG: u32 = 0x8000_0000;
/// Second flag bit: a P-frame stored as a bounding-box (changed-rectangle) frame.
pub const CASV_BBOX_FLAG: u32 = 0x4000_0000;
/// Third flag bit: a P-frame stored as a tile-grid (changed-tiles) frame.
pub const CASV_TILE_FLAG: u32 = 0x2000_0000;

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
    let rd = |o: usize| u32::from_le_bytes(data[o..o + 4].try_into().unwrap());
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

/// Borrow the JXL codestream bytes for frame `index`, validated against the
/// index table and file bounds. `None` if `index` is out of range or the index
/// entry points outside the file.
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
    let len = (len_field & !(CASV_PFRAME_FLAG | CASV_BBOX_FLAG | CASV_TILE_FLAG)) as usize;
    let end = offset.checked_add(len)?;
    if offset < CASV_HEADER_BYTES || end > data.len() {
        return None;
    }
    Some((is_p, &data[offset..end]))
}

/// In-place `base[i] = base[i].wrapping_add(residual[i])`.
fn wrapping_add_into(base: &mut [u8], residual: &[u8]) {
    for (b, &r) in base.iter_mut().zip(residual) {
        *b = b.wrapping_add(r);
    }
}

/// Index of the I-frame at or before `index` (the GOP start needed to decode it).
fn preceding_iframe(data: &[u8], index: usize) -> Option<usize> {
    (0..=index)
        .rev()
        .find(|&j| casv_frame_info(data, j).map(|(is_p, _)| !is_p).unwrap_or(false))
}

/// Tight bounding box `(x, y, w, h)` of pixels that differ between `cur` and
/// `prev` (interleaved RGB8). `None` if the frames are identical.
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
        let changed: Vec<usize> =
            map.iter().enumerate().filter(|(_, &c)| c).map(|(i, _)| i).collect();

        let mut payload = Vec::new();
        payload.extend_from_slice(&(t as u16).to_le_bytes());
        let bitmap_len = map.len().div_ceil(8);
        let mut bitmap = vec![0u8; bitmap_len];
        for &i in &changed {
            bitmap[i / 8] |= 1 << (i % 8);
        }
        payload.extend_from_slice(&bitmap);

        if !changed.is_empty() {
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
                for _ in 0..4 {
                    payload.extend_from_slice(&0u16.to_le_bytes());
                }
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

/// Reconstruct a P-frame in place: `prev` holds the previous reconstructed frame
/// and is mutated into the current frame. Handles both full-residual and
/// bounding-box P-frames. `None` on malformed payloads.
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
        let changed: Vec<usize> =
            (0..n).filter(|&i| bitmap[i / 8] & (1 << (i % 8)) != 0).collect();
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

/// Decode a single frame to interleaved RGB8. For a P-frame this decodes forward
/// from the preceding I-frame (O(GOP)), reconstructing each residual.
pub fn decode_casv_frame_rgb8(data: &[u8], index: usize) -> Option<(Vec<u8>, u32, u32)> {
    let start = preceding_iframe(data, index)?;
    let hdr = parse_casv_header(data)?;
    let (w, h) = (hdr.width, hdr.height);
    let mut cur: Option<Vec<u8>> = None;
    for i in start..=index {
        let (is_p, slice) = casv_frame_info(data, i)?;
        if is_p {
            let mut prev = cur.take()?;
            apply_pframe(&mut prev, casv_frame_is_bbox(data, i)?, casv_frame_is_tile(data, i)?, slice, w, h)?;
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

/// Decode every frame in order, reconstructing P-frames against the running
/// previous frame. `None` if any frame fails to decode.
pub fn decode_casv_all_rgb8(data: &[u8]) -> Option<Vec<(Vec<u8>, u32, u32)>> {
    let hdr = parse_casv_header(data)?;
    let (w, h) = (hdr.width, hdr.height);
    let mut out = Vec::with_capacity(hdr.frame_count as usize);
    let mut prev: Option<Vec<u8>> = None;
    for i in 0..hdr.frame_count as usize {
        let (is_p, slice) = casv_frame_info(data, i)?;
        let recon = if is_p {
            let mut base = prev.take()?;
            apply_pframe(&mut base, casv_frame_is_bbox(data, i)?, casv_frame_is_tile(data, i)?, slice, w, h)?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let last = parse_casv_header(&bytes).unwrap().frame_count as usize - 1;
        assert!(casv_frame_slice(truncated, last).is_none());
    }

    #[test]
    fn frame_flag_encodes_in_len_top_bit() {
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

    #[test]
    fn delta_encode_sets_gop_frame_types() {
        let (w, h) = (16u32, 16u32);
        let src: Vec<Vec<u8>> = (0..8).map(|s| gradient(w, h, (s * 8) as u8)).collect();
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_delta_rgb8(&refs, w, h, 24, 1, 4, EncodeOptions::lossless()).unwrap();

        let expect_i = [true, false, false, false, true, false, false, false];
        for i in 0..8 {
            let (is_p, _) = casv_frame_info(&bytes, i).unwrap();
            assert_eq!(is_p, !expect_i[i], "frame {i} type");
        }
        let all_i = encode_casv_delta_rgb8(&refs, w, h, 24, 1, 1, EncodeOptions::lossless()).unwrap();
        for i in 0..8 {
            assert!(!casv_frame_info(&all_i, i).unwrap().0, "gop=1 frame {i} must be I");
        }
    }

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
                        v[o] = 255;
                        v[o + 1] = 0;
                        v[o + 2] = 0;
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
        let out = decode_casv_all_rgb8(&delta).unwrap();
        for (i, (px, _, _)) in out.iter().enumerate() {
            assert_eq!(px, &src[i], "low-motion frame {i} exact");
        }
    }

    #[test]
    fn random_access_to_pframe_reconstructs() {
        let (w, h) = (24u32, 20u32);
        let src: Vec<Vec<u8>> = (0..8).map(|s| gradient(w, h, (s * 9) as u8)).collect();
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_delta_rgb8(&refs, w, h, 24, 1, 4, EncodeOptions::lossless()).unwrap();

        let (px6, _, _) = decode_casv_frame_rgb8(&bytes, 6).expect("frame 6");
        assert_eq!(px6, src[6]);
        let (px4, _, _) = decode_casv_frame_rgb8(&bytes, 4).expect("frame 4");
        assert_eq!(px4, src[4]);
    }

    #[test]
    fn changed_bbox_is_tight() {
        let (w, h) = (10u32, 8u32);
        let a = vec![0u8; (w * h * 3) as usize];
        assert_eq!(changed_bbox(&a, &a, w, h), None);
        let mut b = a.clone();
        let o = ((3 * w + 4) * 3) as usize;
        b[o + 1] = 200;
        assert_eq!(changed_bbox(&b, &a, w, h), Some((4, 3, 1, 1)));
        let mut c = a.clone();
        c[0] = 5;
        let o2 = ((7 * w + 9) * 3) as usize;
        c[o2] = 5;
        assert_eq!(changed_bbox(&c, &a, w, h), Some((0, 0, 10, 8)));
    }

    #[test]
    fn crop_and_bbox_flag() {
        let w = 4u32;
        let mut src = Vec::new();
        for y in 0..3u8 {
            for x in 0..4u8 {
                src.push(x);
                src.push(y);
                src.push(0);
            }
        }
        let sub = crop_rgb(&src, w, 1, 1, 2, 2);
        assert_eq!(sub, vec![1, 1, 0, 2, 1, 0, 1, 2, 0, 2, 2, 0]);

        let raw = 123u32;
        let field = raw | CASV_PFRAME_FLAG | CASV_BBOX_FLAG;
        assert_eq!(field & !(CASV_PFRAME_FLAG | CASV_BBOX_FLAG), raw);
    }

    #[test]
    fn bbox_encoder_marks_frames_and_shrinks() {
        let (w, h) = (64u32, 64u32);
        let src = low_motion(w, h, 8);
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_delta_bbox_rgb8(&refs, w, h, 24, 1, 8, EncodeOptions::lossless()).unwrap();

        assert!(!casv_frame_info(&bytes, 0).unwrap().0);
        for i in 1..8 {
            assert!(casv_frame_info(&bytes, i).unwrap().0, "frame {i} is P");
            assert!(casv_frame_is_bbox(&bytes, i).unwrap(), "frame {i} is bbox");
        }
        let full = encode_casv_delta_rgb8(&refs, w, h, 24, 1, 8, EncodeOptions::lossless()).unwrap();
        assert!(
            (bytes.len() as f64) < (full.len() as f64),
            "bbox ({}) should be smaller than full-residual delta ({})",
            bytes.len(),
            full.len()
        );
    }

    #[test]
    fn bbox_roundtrip_is_byte_exact() {
        let (w, h) = (64u32, 48u32);
        let src = low_motion(w, h, 10);
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_delta_bbox_rgb8(&refs, w, h, 24, 1, 5, EncodeOptions::lossless()).unwrap();

        let all = decode_casv_all_rgb8(&bytes).expect("decode all");
        assert_eq!(all.len(), 10);
        for (i, (px, _, _)) in all.iter().enumerate() {
            assert_eq!(px, &src[i], "bbox frame {i} must reconstruct byte-exact");
        }
        let (px8, _, _) = decode_casv_frame_rgb8(&bytes, 8).unwrap();
        assert_eq!(px8, src[8]);
    }

    #[test]
    fn tile_map_flags_changed_tiles() {
        let (w, h, tile) = (8u32, 8u32, 4u32);
        let a = vec![0u8; (w * h * 3) as usize];
        assert_eq!(tile_grid(w, h, tile), (2, 2));
        assert_eq!(changed_tile_map(&a, &a, w, h, tile), vec![false; 4]);
        let mut b = a.clone();
        b[((6 * w + 6) * 3) as usize] = 99;
        assert_eq!(changed_tile_map(&b, &a, w, h, tile), vec![false, false, false, true]);
    }

    #[test]
    fn tile_flag_and_mask() {
        let raw = 77u32;
        let field = raw | CASV_PFRAME_FLAG | CASV_TILE_FLAG;
        assert_eq!(field & !(CASV_PFRAME_FLAG | CASV_BBOX_FLAG | CASV_TILE_FLAG), raw);
        assert_ne!(CASV_TILE_FLAG, CASV_BBOX_FLAG);
        assert_ne!(CASV_TILE_FLAG, CASV_PFRAME_FLAG);
    }

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
                            v[o] = col[0];
                            v[o + 1] = col[1];
                            v[o + 2] = col[2];
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
        let bbox = encode_casv_delta_bbox_rgb8(&refs, w, h, 24, 1, 8, EncodeOptions::lossless()).unwrap();
        assert!(
            (tiled.len() as f64) < (bbox.len() as f64),
            "tiled ({}) should beat bbox ({}) on scattered change",
            tiled.len(),
            bbox.len()
        );
    }

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
}
