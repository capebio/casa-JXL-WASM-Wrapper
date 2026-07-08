//! Pure-Rust **FableBraid** CASV video encoder — the libjxl-free lossless tier.
//!
//! This is the piece that lets the browser encode a RAW timelapse to `.casv` with **no
//! native `casv_encode` sidecar**: it uses only [`crate::fable_braid`] (pure Rust, with
//! wasm `simd128` kernels) for the per-frame codec and [`crate::casv_container`] (pure
//! byte layout) for the container — neither pulls the native `jxl-codec`/libjxl FFI, so
//! this module compiles and runs on `wasm32` as well as native.
//!
//! [`FableVideoEncoder`] is a **push** encoder (`new` → `push_rgb8` per frame → `finish`),
//! the shape a WASM caller wants: JavaScript decodes each RAW still (`process_orf`/`_dng`/
//! `_cr2`) to RGB8 and pushes it; the encoder GOP-keys I-frames / P-frames and assembles
//! the v1 container. The output is **byte-identical** to the native streaming encoder
//! [`crate::casa_video::encode_casv_fable_streaming`] for the same frames + GOP (proven by
//! `parity_with_native_streaming`), so the shipping browser decoder plays it unchanged.

use crate::casv_container::{write_container_v1, CASV_HDR_FABLE_FLAG, CASV_PFRAME_FLAG};
use crate::fable_braid;

/// Errors from [`FableVideoEncoder`].
#[derive(thiserror::Error, Debug, PartialEq, Eq)]
pub enum FableVideoError {
    /// A pushed frame was not exactly `width * height * 3` bytes.
    #[error("frame {idx}: expected {expected} bytes (w*h*3), got {got}")]
    FrameSize { idx: usize, expected: usize, got: usize },
    /// `finish` called with no frames pushed.
    #[error("no frames pushed")]
    Empty,
}

/// Stateful FableBraid CASV **video** encoder. Push RGB8 frames (`w*h*3` interleaved,
/// top-to-bottom); every `gop`-th frame is an I-frame (`fable_braid::encode_rgb8`), the
/// rest are P-frames delta-coded against the previous frame
/// (`fable_braid::encode_rgb8_delta`). [`Self::finish`] returns the v1 `.casv` bytes with
/// the `CASV_HDR_FABLE_FLAG` header bit set.
pub struct FableVideoEncoder {
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    gop: usize,
    index: Vec<(u32, u32)>, // (frame flags, payload len) per frame
    data: Vec<u8>,          // concatenated payloads
    prev: Vec<u8>,          // previous source frame (RGB8) for delta coding
    idx: usize,
}

impl FableVideoEncoder {
    /// New encoder for `width`×`height` frames at `fps_num/fps_den`, with a keyframe
    /// every `gop_len` frames (clamped to ≥1, matching the native encoder).
    pub fn new(width: u32, height: u32, fps_num: u32, fps_den: u32, gop_len: u32) -> Self {
        Self {
            width,
            height,
            fps_num,
            fps_den,
            gop: gop_len.max(1) as usize,
            index: Vec::new(),
            data: Vec::new(),
            prev: Vec::new(),
            idx: 0,
        }
    }

    /// Encode + append one RGB8 frame (`len == width*height*3`). I-frame on GOP
    /// boundaries, else a P-frame delta vs the previous pushed frame.
    pub fn push_rgb8(&mut self, cur: &[u8]) -> Result<(), FableVideoError> {
        let expected = self.width as usize * self.height as usize * 3;
        if cur.len() != expected {
            return Err(FableVideoError::FrameSize {
                idx: self.idx,
                expected,
                got: cur.len(),
            });
        }
        let (flags, payload) = if self.idx % self.gop == 0 {
            (0u32, fable_braid::encode_rgb8(cur, self.width, self.height))
        } else {
            (
                CASV_PFRAME_FLAG,
                fable_braid::encode_rgb8_delta(cur, &self.prev, self.width, self.height),
            )
        };
        self.index.push((flags, payload.len() as u32));
        self.data.extend_from_slice(&payload);
        // Retain this frame as the delta reference for the next push.
        self.prev.clear();
        self.prev.extend_from_slice(cur);
        self.idx += 1;
        Ok(())
    }

    /// Frames pushed so far.
    pub fn frame_count(&self) -> usize {
        self.idx
    }

    /// Finish: assemble the v1 fable `.casv`. Errors if no frames were pushed.
    pub fn finish(self) -> Result<Vec<u8>, FableVideoError> {
        if self.index.is_empty() {
            return Err(FableVideoError::Empty);
        }
        let data = self.data;
        Ok(write_container_v1(
            self.width,
            self.height,
            self.index.len() as u32,
            self.fps_num,
            self.fps_den,
            CASV_HDR_FABLE_FLAG,
            &self.index,
            data.len(),
            move |out| out.extend_from_slice(&data),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casv_container::parse_container;

    /// Deterministic RGB8 frame: a moving gradient so consecutive frames differ
    /// (exercises the P-frame delta path).
    fn frame(w: u32, h: u32, t: u8) -> Vec<u8> {
        let (w, h) = (w as usize, h as usize);
        let mut v = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let o = (y * w + x) * 3;
                v[o] = (x as u8).wrapping_add(t);
                v[o + 1] = (y as u8).wrapping_mul(2).wrapping_add(t);
                v[o + 2] = ((x + y) as u8) ^ t;
            }
        }
        v
    }

    /// Encode → parse → decode (I via decode_rgb8, P via decode_rgb8_delta) must
    /// reproduce every source frame exactly. Pure — no libjxl.
    #[test]
    fn round_trips_lossless() {
        let (w, h, gop) = (32u32, 24u32, 3u32);
        let frames: Vec<Vec<u8>> = (0..7).map(|t| frame(w, h, t as u8)).collect();

        let mut enc = FableVideoEncoder::new(w, h, 24, 1, gop);
        for f in &frames {
            enc.push_rgb8(f).unwrap();
        }
        assert_eq!(enc.frame_count(), frames.len());
        let bytes = enc.finish().unwrap();

        let c = parse_container(&bytes).expect("parse");
        assert_eq!(c.flags & CASV_HDR_FABLE_FLAG, CASV_HDR_FABLE_FLAG, "fable header flag");
        assert_eq!(c.frames.len(), frames.len());
        assert_eq!((c.width, c.height, c.fps_num, c.fps_den), (w, h, 24, 1));

        let mut prev: Vec<u8> = Vec::new();
        for (i, want) in frames.iter().enumerate() {
            let payload = c.frame_payload(&bytes, i).expect("payload");
            let got = if c.frames[i].keyframe {
                // Every gop-th frame is a keyframe.
                assert_eq!(i % gop as usize, 0, "frame {i} keyframe scheduling");
                let (rgb, dw, dh) = fable_braid::decode_rgb8(payload).expect("decode I");
                assert_eq!((dw, dh), (w, h));
                rgb
            } else {
                fable_braid::decode_rgb8_delta(payload, &prev, w, h).expect("decode P")
            };
            assert_eq!(&got, want, "frame {i} mismatch");
            prev = got;
        }
    }

    #[test]
    fn empty_finish_errors() {
        let enc = FableVideoEncoder::new(4, 4, 24, 1, 1);
        assert_eq!(enc.finish().unwrap_err(), FableVideoError::Empty);
    }

    #[test]
    fn wrong_frame_size_errors() {
        let mut enc = FableVideoEncoder::new(4, 4, 24, 1, 1);
        assert!(matches!(
            enc.push_rgb8(&[0u8; 10]).unwrap_err(),
            FableVideoError::FrameSize { expected: 48, got: 10, .. }
        ));
    }

    /// Single source of truth: the push encoder must be **byte-identical** to the native
    /// streaming encoder `casa_video::encode_casv_fable_streaming` for the same frames +
    /// GOP. Runs only where the native (jxl-codec) module exists.
    #[cfg(feature = "jxl-codec")]
    #[test]
    fn parity_with_native_streaming() {
        use crate::casa_video::{encode_casv_fable_streaming, VideoFrameSource};

        struct VecFrames {
            w: u32,
            h: u32,
            frames: Vec<Vec<u8>>,
            i: usize,
        }
        impl VideoFrameSource for VecFrames {
            fn dims(&self) -> (u32, u32) {
                (self.w, self.h)
            }
            fn fps(&self) -> (u32, u32) {
                (24, 1)
            }
            fn next_frame(&mut self) -> Option<Vec<u8>> {
                let f = self.frames.get(self.i).cloned();
                if f.is_some() {
                    self.i += 1;
                }
                f
            }
        }

        for &(w, h, gop) in &[(16u32, 16u32, 1u32), (32, 20, 3), (40, 30, 4)] {
            let frames: Vec<Vec<u8>> = (0..9).map(|t| frame(w, h, t as u8)).collect();

            let mut enc = FableVideoEncoder::new(w, h, 24, 1, gop);
            for f in &frames {
                enc.push_rgb8(f).unwrap();
            }
            let mine = enc.finish().unwrap();

            let mut src = VecFrames { w, h, frames: frames.clone(), i: 0 };
            let native = encode_casv_fable_streaming(&mut src, gop).unwrap();

            assert_eq!(mine, native, "byte parity failed @ {w}x{h} gop {gop}");
        }
    }
}
