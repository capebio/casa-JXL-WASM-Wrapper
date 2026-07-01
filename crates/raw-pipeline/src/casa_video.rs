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

#![cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]

use crate::jxl_casaencoder::{encode_rgb8, EncodeOptions};
use crate::jxl_casadecoder::decode_interleaved;

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
}
