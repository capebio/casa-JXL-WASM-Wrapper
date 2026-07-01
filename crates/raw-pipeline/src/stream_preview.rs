//! Streaming, bounded-memory ORF preview build: decode → half-demosaic →
//! box-downscale, one strip at a time. Byte-identical to the full-frame path.

use crate::decompress::{for_each_strip, OrfRowDecoder};
use crate::demosaic::demosaic_half_band;

/// Even strip height. Larger = fewer rayon dispatches + coarser demosaic grain
/// (better throughput); smaller = lower peak. 128 keeps the raw strip ~1 MB at
/// 4000 px while roughly halving par-dispatch overhead vs 64. Bench-adjustable
/// const (see `preview_build_ab_timing`), not a user tunable.
pub const STRIP_ROWS: usize = 128;

#[inline(always)]
fn write_rgb16_le(out: &mut [u8], o: usize, r: u16, g: u16, b: u16) {
    out[o] = r as u8; out[o + 1] = (r >> 8) as u8;
    out[o + 2] = g as u8; out[o + 3] = (g >> 8) as u8;
    out[o + 4] = b as u8; out[o + 5] = (b >> 8) as u8;
}

/// Streaming box-downscale. Accepts source rows in top-to-bottom order via
/// `push_row`, accumulates one output row at a time, and produces the same packed
/// LE u16 buffer (6 bytes/pixel) as `src/lib.rs::downscale_rgb16_impl`.
///
/// Byte-exactness: for downscaling (sh >= dh) the vertical spans [y0,y1) form a
/// non-overlapping partition of [0,sh) — each input row feeds exactly one output
/// row — so the streamed per-pixel sums equal the one-shot sums in the same order.
/// Only valid for downscaling (sh >= dh); callers never upscale a preview.
pub struct StreamingBoxDownscale {
    sh: usize,
    dw: usize,
    dh: usize,
    out: Vec<u8>,           // dw*dh*6 (the deliverable)
    acc: Vec<u32>,          // dw*3 accumulator for the current output row
    dy: usize,              // current output row being filled
    y_in: usize,            // next input row index expected
    y1: usize,              // end (exclusive) of the current output row's input span
    xspan: Vec<(u32, u32)>, // (x0, x1) per output column
    integer: bool,
}

impl StreamingBoxDownscale {
    pub fn new(sw: usize, sh: usize, dw: usize, dh: usize) -> Self {
        let integer = sw % dw == 0 && sh % dh == 0;
        let xr = sw as f32 / dw as f32;
        let xstep = if integer { sw / dw } else { 0 };
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
            sh, dw, dh,
            out: vec![0u8; dw * dh * 6],
            acc: vec![0u32; dw * 3],
            dy: 0,
            y_in: 0,
            y1: 0,
            xspan,
            integer,
        };
        s.set_span_for_dy(0);
        s
    }

    fn y_span(&self, dy: usize) -> (usize, usize) {
        if self.integer {
            let ystep = self.sh / self.dh;
            (dy * ystep, dy * ystep + ystep)
        } else {
            let yr = self.sh as f32 / self.dh as f32;
            let y0 = (dy as f32 * yr) as usize;
            let y1 = (((dy as f32 + 1.0) * yr).min(self.sh as f32) as usize).max(y0 + 1);
            (y0, y1)
        }
    }

    fn set_span_for_dy(&mut self, dy: usize) {
        if dy >= self.dh {
            return;
        }
        let (y0, y1) = self.y_span(dy);
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
            let (y0, _) = self.y_span(self.dy);
            let rows = (self.y1 - y0).max(1) as u32;
            let mut o = self.dy * self.dw * 6;
            for dx in 0..self.dw {
                let (x0, x1) = self.xspan[dx];
                let n = rows * (x1 - x0).max(1);
                let a = dx * 3;
                write_rgb16_le(
                    &mut self.out, o,
                    (self.acc[a] / n) as u16,
                    (self.acc[a + 1] / n) as u16,
                    (self.acc[a + 2] / n) as u16,
                );
                self.acc[a] = 0;
                self.acc[a + 1] = 0;
                self.acc[a + 2] = 0;
                o += 6;
            }
            self.dy += 1;
            self.set_span_for_dy(self.dy);
        }
    }

    pub fn finish(self) -> Vec<u8> {
        debug_assert_eq!(self.y_in, self.sh, "must feed exactly sh rows");
        self.out
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;

    // Verbatim reference of src/lib.rs::downscale_rgb16_impl (int + float paths),
    // kept as the byte-exact oracle. If the production downscaler changes, update both.
    fn reference_downscale(src: &[u16], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
        let mut out = vec![0u8; dw * dh * 6];
        if sw % dw == 0 && sh % dh == 0 {
            let xstep = sw / dw;
            let ystep = sh / dh;
            let pc = (xstep * ystep) as u32;
            let mut o = 0usize;
            for dy in 0..dh {
                for dx in 0..dw {
                    let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
                    let xb = dx * xstep;
                    let mut rb = dy * ystep * sw;
                    for _ in 0..ystep {
                        let mut i = (rb + xb) * 3;
                        for _ in 0..xstep {
                            rr += src[i] as u32;
                            gg += src[i + 1] as u32;
                            bb += src[i + 2] as u32;
                            i += 3;
                        }
                        rb += sw;
                    }
                    write_rgb16_le(&mut out, o, (rr / pc) as u16, (gg / pc) as u16, (bb / pc) as u16);
                    o += 6;
                }
            }
            return out;
        }
        let xr = sw as f32 / dw as f32;
        let yr = sh as f32 / dh as f32;
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
                    for x in x0..x1 {
                        let i = (rb + x) * 3;
                        rr += src[i] as u32;
                        gg += src[i + 1] as u32;
                        bb += src[i + 2] as u32;
                    }
                    rb += sw;
                }
                write_rgb16_le(&mut out, o, (rr / n) as u16, (gg / n) as u16, (bb / n) as u16);
                o += 6;
            }
        }
        out
    }

    fn stream_all(src: &[u16], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
        let mut d = StreamingBoxDownscale::new(sw, sh, dw, dh);
        for y in 0..sh {
            d.push_row(&src[y * sw * 3..(y + 1) * sw * 3]);
        }
        d.finish()
    }

    #[test]
    fn streaming_downscale_matches_reference() {
        // (sw, sh, dw, dh): exact-integer and aspect/float cases.
        for &(sw, sh, dw, dh) in &[
            (64usize, 48usize, 16usize, 12usize), // exact 4x
            (100, 75, 30, 21),                    // float
            (99, 60, 25, 17),                     // float, odd
            // Float floor-boundary ratios — a sibling agent flagged a 7:3 fusion
            // counterexample; prove the streaming accumulator still matches the
            // one-shot box filter exactly at these boundaries (both axes).
            (7, 7, 3, 3),
            (7, 5, 3, 2),
            (13, 9, 4, 3),
            (33, 17, 10, 6),
            (7, 4, 3, 3),   // dh=3 from sh=4 (thin vertical spans)
        ] {
            let src: Vec<u16> = (0..(sw * sh * 3)).map(|i| ((i * 31 + 7) & 0xffff) as u16).collect();
            let want = reference_downscale(&src, sw, sh, dw, dh);
            let got = stream_all(&src, sw, sh, dw, dh);
            assert_eq!(got, want, "{}x{} -> {}x{}", sw, sh, dw, dh);
        }
    }

    #[test]
    fn build_previews_matches_manual_composition() {
        use crate::{decompress, demosaic};

        let (w, h) = (64usize, 48usize);
        let payload = decompress::tests_synth_payload(w, h, 0xC0FFEE);
        let (hw, hh) = (w / 2, h / 2);

        // manual: full decode -> half demosaic -> downscale (the current path)
        let raw = decompress::decompress(&payload, w, h).unwrap();
        let half = demosaic::demosaic_rggb_half(&raw, w, h).unwrap();
        let lb = reference_downscale(&half, hw, hh, 20, 15); // float dims
        let th = reference_downscale(&half, hw, hh, 8, 6);   // integer dims

        // streaming
        let got = build_previews_streaming(&payload, w, h, &[(20, 15), (8, 6)]).unwrap();
        assert_eq!(got[0], lb, "lightbox differs");
        assert_eq!(got[1], th, "thumb differs");
    }

    // Rule-9 perf gate: streamed preview build vs the manual full composition. Run:
    // cargo test --release -p raw-pipeline --lib preview_build_ab_timing -- --ignored --nocapture
    #[test]
    #[ignore]
    fn preview_build_ab_timing() {
        use crate::{decompress, demosaic};
        use std::time::Instant;
        let (w, h) = (2048usize, 2048usize);
        let payload = decompress::tests_synth_payload(w, h, 0xABBA);
        let (hw, hh) = (w / 2, h / 2);
        let targets = [(300usize, 300usize), (120usize, 120usize)];

        let full = || {
            let raw = decompress::decompress(&payload, w, h).unwrap();
            let half = demosaic::demosaic_rggb_half(&raw, w, h).unwrap();
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
}
