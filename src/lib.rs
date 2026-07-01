//! Browser entry point for the Olympus ORF → RGB pipeline.
//!
//! Exports `process_orf(bytes)` which parses an ORF blob, decompresses the
//! 12-bit predictive stream, demosaics RGGB → RGB, applies WB/sRGB tone curve
//! and EXIF orientation, returning an interleaved RGB8 buffer plus dims.
//!
//! Encoding (JXL / WebP) is left to JS via jSquash — keeps the wasm small.
//! Stages use rayon (when built with `parallel-wasm` feature + initThreadPool()
//! called). Requires COOP/COEP (already needed for libjxl MT).

use raw_pipeline::decompress;
use raw_pipeline::demosaic;
use raw_pipeline::pipeline;
use raw_pipeline::tiff;

use wasm_bindgen::prelude::*;

// A2: expose rayon thread-pool init to JS when built with --features parallel-wasm
#[cfg(feature = "parallel-wasm")]
pub use wasm_bindgen_rayon::init_thread_pool;

// === Lens 22 demosaic SIMD flip-flop (bench-only; driven by tools/demosaic-flipflop.mjs) ===
// Times are taken in the JS host (wasm32-unknown-unknown has no wall clock); these exports just
// run one demosaic and return a cheap checksum so wasm-bindgen marshalling is constant.
use std::cell::RefCell;
thread_local! {
    static DEMO_BENCH: RefCell<(Vec<u16>, usize, usize)> = const { RefCell::new((Vec::new(), 0, 0)) };
    // Scratch buffer for LookRenderer::render() texture/clarity path — avoids Vec::clone on every slider drag.
    static RENDER_SCRATCH: RefCell<Vec<u16>> = const { RefCell::new(Vec::new()) };
}
fn demo_checksum(v: &[u16]) -> u32 {
    v.iter().fold(0u32, |a, &x| a.wrapping_mul(31).wrapping_add(x as u32))
}
#[wasm_bindgen]
pub fn demosaic_bench_prepare(w: usize, h: usize) {
    let raw: Vec<u16> = (0..w * h).map(|i| (i.wrapping_mul(2654435761) & 0x3fff) as u16).collect();
    DEMO_BENCH.with(|b| *b.borrow_mut() = (raw, w, h));
}
#[wasm_bindgen]
pub fn demosaic_bench_scalar() -> u32 {
    DEMO_BENCH.with(|b| {
        let g = b.borrow();
        demo_checksum(&demosaic::demosaic_rggb(&g.0, g.1, g.2).unwrap())
    })
}
#[wasm_bindgen]
pub fn demosaic_bench_simd() -> u32 {
    DEMO_BENCH.with(|b| {
        let g = b.borrow();
        demo_checksum(&demosaic::demosaic_rggb_simd(&g.0, g.1, g.2).unwrap())
    })
}
#[wasm_bindgen]
pub fn demosaic_bench_equal() -> bool {
    DEMO_BENCH.with(|b| {
        let g = b.borrow();
        demosaic::demosaic_rggb(&g.0, g.1, g.2).unwrap() == demosaic::demosaic_rggb_simd(&g.0, g.1, g.2).unwrap()
    })
}
#[wasm_bindgen]
pub fn demosaic_bench_first_diff() -> i32 {
    DEMO_BENCH.with(|b| {
        let g = b.borrow();
        let a = demosaic::demosaic_rggb(&g.0, g.1, g.2).unwrap();
        let s = demosaic::demosaic_rggb_simd(&g.0, g.1, g.2).unwrap();
        for i in 0..a.len() {
            if a[i] != s[i] { return i as i32; }
        }
        -1
    })
}

fn demo_checksum3(r: &[u16], g: &[u16], b: &[u16]) -> u32 {
    let mut c = demo_checksum(r);
    c = c.wrapping_mul(31).wrapping_add(demo_checksum(g));
    c = c.wrapping_mul(31).wrapping_add(demo_checksum(b));
    c
}

#[wasm_bindgen]
pub fn demosaic_bench_planar_scalar() -> u32 {
    DEMO_BENCH.with(|b| {
        let g = b.borrow();
        let (r, gp, bp) = demosaic::demosaic_rggb_planar(&g.0, g.1, g.2).unwrap();
        demo_checksum3(&r, &gp, &bp)
    })
}

#[wasm_bindgen]
pub fn demosaic_bench_planar_simd() -> u32 {
    DEMO_BENCH.with(|b| {
        let g = b.borrow();
        let (r, gp, bp) = demosaic::demosaic_rggb_planar_simd(&g.0, g.1, g.2).unwrap();
        demo_checksum3(&r, &gp, &bp)
    })
}

#[wasm_bindgen]
pub fn demosaic_bench_planar_equal() -> bool {
    DEMO_BENCH.with(|b| {
        let g = b.borrow();
        demosaic::demosaic_rggb_planar(&g.0, g.1, g.2).unwrap()
            == demosaic::demosaic_rggb_planar_simd(&g.0, g.1, g.2).unwrap()
    })
}

#[wasm_bindgen]
pub fn demosaic_bench_planar_first_diff() -> i32 {
    DEMO_BENCH.with(|b| {
        let g = b.borrow();
        let (ra, ga, ba) = demosaic::demosaic_rggb_planar(&g.0, g.1, g.2).unwrap();
        let (rs, gs, bs) = demosaic::demosaic_rggb_planar_simd(&g.0, g.1, g.2).unwrap();
        let n = ra.len();
        for i in 0..n {
            if ra[i] != rs[i] { return i as i32; }
            if ga[i] != gs[i] { return (n + i) as i32; }
            if ba[i] != bs[i] { return (2 * n + i) as i32; }
        }
        -1
    })
}

#[wasm_bindgen]
pub fn demosaic_bench_shuffle_simd() -> u32 {
    DEMO_BENCH.with(|b| {
        let g = b.borrow();
        demo_checksum(&demosaic::demosaic_rggb_shuffle_simd(&g.0, g.1, g.2).unwrap())
    })
}

#[wasm_bindgen]
pub fn demosaic_bench_shuffle_equal() -> bool {
    DEMO_BENCH.with(|b| {
        let g = b.borrow();
        demosaic::demosaic_rggb(&g.0, g.1, g.2).unwrap()
            == demosaic::demosaic_rggb_shuffle_simd(&g.0, g.1, g.2).unwrap()
    })
}

#[wasm_bindgen]
pub fn demosaic_bench_shuffle_first_diff() -> i32 {
    DEMO_BENCH.with(|b| {
        let g = b.borrow();
        let a = demosaic::demosaic_rggb(&g.0, g.1, g.2).unwrap();
        let s = demosaic::demosaic_rggb_shuffle_simd(&g.0, g.1, g.2).unwrap();
        for i in 0..a.len() {
            if a[i] != s[i] { return i as i32; }
        }
        -1
    })
}

/// Result of processing an ORF: RGB8 buffer + dims (post-orientation).
#[wasm_bindgen]
pub struct ProcessResult {
    rgb: Vec<u8>,
    #[wasm_bindgen(readonly)]
    pub width: u32,
    #[wasm_bindgen(readonly)]
    pub height: u32,
    #[wasm_bindgen(readonly)]
    pub orientation: u16,
    #[wasm_bindgen(readonly)]
    pub decompress_ms: f64,
    #[wasm_bindgen(readonly)]
    pub demosaic_ms: f64,
    #[wasm_bindgen(readonly)]
    pub tonemap_ms: f64,
    #[wasm_bindgen(readonly)]
    pub orient_ms: f64,
    #[wasm_bindgen(readonly)]
    pub preview_demosaic_ms: f64,  // fast planar bilinear demosaic for lb/thumb previews
    #[wasm_bindgen(readonly)]
    pub preview_downscale_ms: f64,  // planar downscales for previews (lb + thumb)
    #[wasm_bindgen(readonly)]
    pub fast_preview: bool,  // true if fast planar bilinear + planar down was used for lb/thumb (vs full mhc path)
    #[wasm_bindgen(readonly)]
    pub wb_r_used: f32,
    #[wasm_bindgen(readonly)]
    pub wb_b_used: f32,
    /// Black pedestal subtracted by the pipeline (per-format). The live
    /// LookRenderer must use this same value or slider edits revert to the
    /// black=0 magenta cast. Olympus = OLYMPUS_BLACK_LEVEL; CR2/DNG = file tag.
    #[wasm_bindgen(readonly)]
    pub black_used: u16,
    #[wasm_bindgen(readonly)]
    pub color_matrix_from_mn: bool,
    make: String,
    model: String,
    rgb16_lb: Vec<u8>,
    #[wasm_bindgen(readonly)]
    pub lb_w: u32,
    #[wasm_bindgen(readonly)]
    pub lb_h: u32,
    rgb16_thumb: Vec<u8>,
    #[wasm_bindgen(readonly)]
    pub thumb_w: u32,
    #[wasm_bindgen(readonly)]
    pub thumb_h: u32,
    // M3: full master-size 16-bit for pyramid big levels + 16-bit lightbox path.
    // Only populated when OUT_FULL_16 requested (memory opt; current callers that pass 7 stay 8-bit + lb/thumb only).
    // A-5: held as Vec<u16> (RGB triples) and packed to LE bytes lazily in take_rgb16_full —
    // avoids allocating a second full-res buffer alongside the live rgb16 during tone
    // (~121 MB off the process-compute peak on the 16-bit path). Output bytes are unchanged.
    rgb16_full: Vec<u16>,
    #[wasm_bindgen(readonly)]
    pub full16_w: u32,
    #[wasm_bindgen(readonly)]
    pub full16_h: u32,
    color_matrix_flat: [f32; 9],
    // EXIF / metadata exposed for the lightbox info panel.
    lens: String,
    datetime: String,
    #[wasm_bindgen(readonly)]
    pub exposure_num: u32,
    #[wasm_bindgen(readonly)]
    pub exposure_den: u32,
    #[wasm_bindgen(readonly)]
    pub fnumber_num: u32,
    #[wasm_bindgen(readonly)]
    pub fnumber_den: u32,
    #[wasm_bindgen(readonly)]
    pub iso: u32,
    #[wasm_bindgen(readonly)]
    pub focal_length_num: u32,
    #[wasm_bindgen(readonly)]
    pub focal_length_den: u32,
    #[wasm_bindgen(readonly)]
    pub focal_length_35: u16,
    #[wasm_bindgen(readonly)]
    pub gps_lat: f64,
    #[wasm_bindgen(readonly)]
    pub gps_lon: f64,
    #[wasm_bindgen(readonly)]
    pub gps_alt: f64,
    #[wasm_bindgen(readonly)]
    pub has_gps: bool,
    #[wasm_bindgen(readonly)]
    pub quality: u16,
    /// Olympus WhiteBalance2 mode tag (MakerNote 0x0500).
    /// `0xFFFF` = absent / unknown — JS callers must check for this sentinel before
    /// interpreting the value (e.g. to decide whether to show a WB-mode label).
    /// For DNG and CR2 files this field is always `0xFFFF` (no per-shot WB mode tag).
    #[wasm_bindgen(readonly)]
    pub wb_mode: u16,
    #[wasm_bindgen(readonly)]
    pub wb_from_camera: bool,
}

#[wasm_bindgen]
impl ProcessResult {
    #[wasm_bindgen(getter)]
    pub fn make(&self) -> String {
        self.make.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn model(&self) -> String {
        self.model.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn lens(&self) -> String {
        self.lens.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn datetime(&self) -> String {
        self.datetime.clone()
    }
}

#[wasm_bindgen]
impl ProcessResult {
    /// Move the RGB buffer out as a `Uint8Array`.  Caller owns the bytes.
    // wasm-bindgen copies Vec<u8> into a JS-owned Uint8Array via
    // getUint8Memory0().slice() before returning, so the Uint8Array remains
    // valid even after the caller calls result.free().
    // Returns empty on subsequent calls (ownership transferred).
    pub fn take_rgb(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.rgb)
    }

    /// Borrow the RGB buffer; copies into a fresh JS `Uint8Array`.
    pub fn rgb(&self) -> Vec<u8> {
        self.rgb.clone()
    }

    /// Move the lightbox-sized packed u16 LE buffer out.  Caller owns the bytes.
    // Same copy semantics as take_rgb — safe to use after result.free().
    pub fn take_rgb16_lb(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.rgb16_lb)
    }

    /// Move the thumb-sized packed u16 LE buffer out.  Caller owns the bytes.
    // Transfers ownership; returns empty Vec<u8> on subsequent calls.
    pub fn take_rgb16_thumb(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.rgb16_thumb)
    }

    /// Move the full-resolution 16-bit buffer out, packed to LE bytes (M3 16-bit path).
    /// Packed 6 bytes per pixel LE (r g b u16). Only non-empty if OUT_FULL_16 was requested.
    /// A-5: the master is held as Vec<u16> and packed here (not eagerly during process), so
    /// no second full-res buffer coexists with the live rgb16 during tone. Byte-identical to
    /// the former eager pack — same pack_rgb16_full over the same pre-unsharp data.
    pub fn take_rgb16_full(&mut self) -> Vec<u8> {
        let v = std::mem::take(&mut self.rgb16_full);
        if v.is_empty() {
            return Vec::new();
        }
        pack_rgb16_full(&v, self.full16_w as usize, self.full16_h as usize)
        // v drops here, freeing the 16-bit master buffer.
    }

    /// Move the RGBA8 buffer out. Caller owns the bytes.
    /// Performs RGB→RGBA conversion inside WASM using the same tight loop as the
    /// JS-facing rgb_to_rgba, then transfers ownership. This still avoids the
    /// JS-side 3x buffer allocation that the old take_rgb + rgb_to_rgba pattern
    /// required for "encode only" paths.
    pub fn take_rgba(&mut self) -> Vec<u8> {
        rgb_to_rgba(&std::mem::take(&mut self.rgb))
    }

    /// Borrow the RGBA8 buffer (copies).
    pub fn rgba(&self) -> Vec<u8> {
        rgb_to_rgba(&self.rgb)
    }

    /// Return the color matrix used (9 floats, row-major).
    pub fn color_matrix_used(&self) -> Vec<f32> {
        self.color_matrix_flat.to_vec()
    }
}

fn now_ms() -> f64 {
    thread_local! {
        static PERF: std::cell::OnceCell<web_sys::Performance> = const { std::cell::OnceCell::new() };
    }
    PERF.with(|cell| {
        if let Some(perf) = cell.get() {
            return perf.now();
        }
        let perf = web_sys::window()
            .and_then(|w| w.performance())
            .or_else(|| {
                js_sys::global()
                    .dyn_into::<web_sys::WorkerGlobalScope>()
                    .ok()
                    .and_then(|w| w.performance())
            });
        if let Some(perf) = perf {
            let now = perf.now();
            let _ = cell.set(perf);
            now
        } else {
            js_sys::Date::now()
        }
    })
}

#[inline(always)]
fn write_rgb16_le(out: &mut [u8], o: usize, r: u16, g: u16, b: u16) {
    // Manual LE writes — eliminates three small copy_from_slice(2) per pixel in the
    // general (non-integer) downscale fallback path.
    out[o]     = (r & 0xff) as u8;
    out[o + 1] = (r >> 8) as u8;
    out[o + 2] = (g & 0xff) as u8;
    out[o + 3] = (g >> 8) as u8;
    out[o + 4] = (b & 0xff) as u8;
    out[o + 5] = (b >> 8) as u8;
}

/// Pack full-res rgb16 (Vec<u16>, 3 per pixel) to the packed LE 6-byte form used by take_*16.
/// The packed form is exactly the source u16 slice in little-endian byte order, so on a
/// little-endian target (wasm32, x86_64) this is a single memcpy — no per-pixel index math
/// or byte-splitting. Big-endian falls back to the explicit per-pixel LE writes.
#[inline]
fn pack_rgb16_full(src: &[u16], w: usize, h: usize) -> Vec<u8> {
    let n = w * h * 3; // u16 count
    let mut out = vec![0u8; n * 2];
    #[cfg(target_endian = "little")]
    {
        // SAFETY: reinterpret the &[u16] as &[u8] (len*2 bytes). u8 has alignment 1, so any
        // u16 slice is validly aligned for u8 reads; we copy exactly n*2 bytes into `out`.
        let src_bytes = unsafe { core::slice::from_raw_parts(src.as_ptr() as *const u8, n * 2) };
        out.copy_from_slice(src_bytes);
    }
    #[cfg(target_endian = "big")]
    {
        for i in 0..(w * h) {
            write_rgb16_le(&mut out, i * 6, src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
        }
    }
    out
}

fn downscale_rgb_float_path<F>(
    sw: usize,
    sh: usize,
    dw: usize,
    dh: usize,
    out: &mut Vec<u8>,
    read_pixel: F,
) where
    F: Fn(usize) -> (u32, u32, u32),
{
    // Integer fast path (same principle as the public downscalers).
    // Even if callers usually guard, this makes the helper itself robust.
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw;
        let ystep = sh / dh;
        let pixel_count = (xstep * ystep) as u32;
        for dy in 0..dh {
            for dx in 0..dw {
                let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
                let x_base = dx * xstep;
                let mut row_base = dy * ystep * sw;
                for _yy in 0..ystep {
                    let mut idx = row_base + x_base;
                    for _xx in 0..xstep {
                        let (r, g, b) = read_pixel(idx);
                        rr += r; gg += g; bb += b;
                        idx += 1;
                    }
                    row_base += sw;
                }
                let o = (dy * dw + dx) * 6;
                write_rgb16_le(out, o, (rr / pixel_count) as u16, (gg / pixel_count) as u16, (bb / pixel_count) as u16);
            }
        }
        return;
    }

    let xr = sw as f32 / dw as f32;
    let yr = sh as f32 / dh as f32;
    let mut o = 0usize;
    for dy in 0..dh {
        let y0 = (dy as f32 * yr) as usize;
        let y1 = ((dy as f32 + 1.0) * yr).min(sh as f32) as usize;
        let y1 = y1.max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f32 * xr) as usize;
            let x1 = ((dx as f32 + 1.0) * xr).min(sw as f32) as usize;
            let x1 = x1.max(x0 + 1);
            let n = ((y1 - y0) * (x1 - x0)).max(1) as u32;
            let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
            let mut row_base = y0 * sw;
            for _y in y0..y1 {
                for x in x0..x1 {
                    let (r, g, b) = read_pixel(row_base + x);
                    rr += r;
                    gg += g;
                    bb += b;
                }
                row_base += sw;
            }
            write_rgb16_le(out, o, (rr / n) as u16, (gg / n) as u16, (bb / n) as u16);
            o += 6;
        }
    }
}

#[allow(clippy::too_many_arguments)]
/// Box-filter downscale an RGB16 (u16) buffer, outputting packed u16 LE bytes
/// (6 bytes per pixel).  Used to cache a lightbox-sized buffer for live re-render.
///
/// Fast path for integer factors (benefits lb/thumb generation for all RAW formats).
fn downscale_rgb16_impl(src: &[u16], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    let mut out = vec![0u8; dw * dh * 6];

    // Integer fast path for common exact factors (same win as the RGB8/RGBA8 versions).
    // Benefits every lightbox + thumb generation for RAW images.
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw;
        let ystep = sh / dh;
        let pixel_count = (xstep * ystep) as u32;
        let mut o = 0usize;
        for dy in 0..dh {
            for dx in 0..dw {
                let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
                let x_base = dx * xstep;
                let mut row_base = dy * ystep * sw;
                for _yy in 0..ystep {
                    let mut i = (row_base + x_base) * 3;
                    for _xx in 0..xstep {
                        rr += src[i] as u32;
                        gg += src[i + 1] as u32;
                        bb += src[i + 2] as u32;
                        i += 3;
                    }
                    row_base += sw;
                }
                write_rgb16_le(&mut out, o, (rr / pixel_count) as u16, (gg / pixel_count) as u16, (bb / pixel_count) as u16);
                o += 6;
            }
        }
        return out;
    }

    downscale_rgb_float_path(sw, sh, dw, dh, &mut out, |idx| {
        let i = idx * 3;
        (src[i] as u32, src[i + 1] as u32, src[i + 2] as u32)
    });
    out
}

/// Box-filter downscale directly from the packed LE u8 form (6 bytes/pixel)
/// produced by downscale_rgb16_impl. Avoids a full unpack to Vec<u16> when
/// generating the 360 px thumb from the 1800 px lightbox buffer.
///
/// Also has the integer fast path for common exact scale factors.
fn downscale_packed_rgb16_le(src: &[u8], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    let mut out = vec![0u8; dw * dh * 6];

    // Integer fast path for the packed format too (e.g. 1800→360 thumb from lb is exact 5x).
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw;
        let ystep = sh / dh;
        let pixel_count = (xstep * ystep) as u32;
        let sw6 = sw * 6;
        let mut o = 0usize;
        for dy in 0..dh {
            for dx in 0..dw {
                let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
                let x_base = dx * xstep;
                let mut row_base = dy * ystep * sw6;
                for _yy in 0..ystep {
                    let mut i = row_base + x_base * 6;
                    for _xx in 0..xstep {
                        let r = u16::from_le_bytes([src[i], src[i + 1]]) as u32;
                        let g = u16::from_le_bytes([src[i + 2], src[i + 3]]) as u32;
                        let b = u16::from_le_bytes([src[i + 4], src[i + 5]]) as u32;
                        rr += r;
                        gg += g;
                        bb += b;
                        i += 6;
                    }
                    row_base += sw6;
                }
                write_rgb16_le(&mut out, o, (rr / pixel_count) as u16, (gg / pixel_count) as u16, (bb / pixel_count) as u16);
                o += 6;
            }
        }
        return out;
    }

    downscale_rgb_float_path(sw, sh, dw, dh, &mut out, |idx| {
        let i = idx * 6;
        let r = u16::from_le_bytes([src[i], src[i + 1]]) as u32;
        let g = u16::from_le_bytes([src[i + 2], src[i + 3]]) as u32;
        let b = u16::from_le_bytes([src[i + 4], src[i + 5]]) as u32;
        (r, g, b)
    });
    out
}

fn unpack_rgb16_le(src: &[u8]) -> Vec<u16> {
    // Packed LE bytes are exactly the u16 slice's byte image on a little-endian target
    // (wasm32, x86_64), so this is a single memcpy into the u16 buffer — no per-element
    // from_le_bytes. Big-endian falls back to the explicit per-element decode.
    let n = src.len() / 2;
    let mut out = vec![0u16; n];
    #[cfg(target_endian = "little")]
    {
        // SAFETY: write n*2 bytes into `out` (n u16). out is u16-aligned (stricter than the
        // u8 view), and we copy exactly the first n*2 source bytes.
        let dst = unsafe { core::slice::from_raw_parts_mut(out.as_mut_ptr() as *mut u8, n * 2) };
        dst.copy_from_slice(&src[..n * 2]);
    }
    #[cfg(target_endian = "big")]
    {
        for (o, c) in out.iter_mut().zip(src.chunks_exact(2)) {
            *o = u16::from_le_bytes([c[0], c[1]]);
        }
    }
    out
}

#[inline(always)]
fn target_dims(w: usize, h: usize, long_edge: usize) -> (usize, usize) {
    if w >= h {
        let lw = w.min(long_edge);
        (lw, ((h * lw) / w).max(1))
    } else {
        let lh = h.min(long_edge);
        (((w * lh) / h).max(1), lh)
    }
}

/// May the ORF preview use the ¼-res 2×2 superpixel demosaic instead of full-res
/// bilinear? Only when the half-resolution plane (w/2 × h/2) still *supersamples* the
/// largest preview (the 1800 px lightbox `lb_w`×`lb_h`) — so demosaicing at ¼ res then
/// downscaling never upsamples. ~4× faster preview demosaic + ¼ the peak heap, and
/// perceptually equivalent at preview size (Butteraugli 0.063, PSNR 40 dB on a real
/// 20 MP ORF; see examples/demosaic_preview_demo). Smaller sensors / larger preview
/// targets fall through to the full-res bilinear path.
#[inline(always)]
fn preview_can_halve(w: usize, h: usize, lb_w: usize, lb_h: usize) -> bool {
    w / 2 >= lb_w && h / 2 >= lb_h
}

// Output flag bits for process_orf_with_flags.
const OUT_FULL_RGB8: u32 = 1; // full-resolution RGB8 for JXL encoding
const OUT_LIGHTBOX: u32 = 2; // 1800 px RGB16 for LookRenderer
const OUT_THUMB: u32 = 4; // 360 px RGB16 for thumb LookRenderer
const OUT_FULL_16: u32 = 8; // full-resolution RGB16 (M3: RAW {2048,full} pyramid levels; 16-bit lightbox/ROI/export). Grid levels and JPG stay 8-bit.
// Skip apply_orientation on the OUT_FULL_RGB8 output. Pixels and width/height
// stay in sensor orientation; consumer reads `orientation` to know how to display
// (or to pass to JXL encoder via basic info). Saves the 60–200 MB intermediate
// rotate when feeding the encoder (JXL stores orientation as metadata).
// bit 4. Previously bit 8, accidentally shared with OUT_FULL_16 — b2cb8dc9 added
// OUT_NO_ORIENT=8, then 1674aa11 added OUT_FULL_16=8 five days later. Split to its own
// bit so full-res-16 and skip-orientation are independent. No caller sets bit 8 (all
// pass 7 = RGB8|LIGHTBOX|THUMB), so this changed no behavior. The mhc three-sweep review
// and the lib.rs review caught this independently and both corrected it to 16.
const OUT_NO_ORIENT: u32 = 16;

/// Olympus 12-bit sensor black pedestal (counts). Subtracted before WB so the
/// per-channel multipliers don't inflate the pedestal into a magenta cast. See
/// the rationale block in `decode_orf_raw`. Canonical Olympus value; the raw
/// histogram floor of real E-M1 III files sits here (~256).
const OLYMPUS_BLACK_LEVEL: u16 = 256;

struct LookOverrides {
    wb_r: f32,
    wb_b: f32,
    exposure_ev: f32,
    contrast: f32,
    highlights: f32,
    shadows: f32,
    whites: f32,
    blacks: f32,
    saturation: f32,
    vibrance: f32,
    temp: f32,
    tint: f32,
    texture: f32,
    clarity: f32,
}

struct OrfDecoded {
    rgb16: Vec<u16>,
    w: usize,
    h: usize,
    info: tiff::OrfInfo,
    decompress_ms: f64,
    demosaic_ms: f64,
    wb_from_camera: bool,
    params: pipeline::PipelineParams,
    color_matrix_from_mn: bool,
    color_matrix_flat: [f32; 9],
    // Hypercar: precomputed fast planar bilinear + planar down for lb/thumb (cheap SIMD path, no mhc cost for preview).
    // Packed LE u8 6B/px. Avoids full-res interleaved materialization for common preview paths.
    lb_packed: Vec<u8>,
    lb_w: usize,
    lb_h: usize,
    thumb_packed: Vec<u8>,
    thumb_w: usize,
    thumb_h: usize,
    preview_demosaic_ms: f64,  // fast planar bilinear demosaic for previews
    preview_downscale_ms: f64,  // planar downscales for lb + thumb previews
    fast_preview: bool,  // fast planar path used for previews
}

/// Gate for the streaming preview-only fast path: previews requested, full-res output
/// NOT requested (so the raw is needed for nothing else), camera WB tags present (so no
/// full-raw auto-WB scan is needed), and the frame is halve-able (¼-res superpixel path).
fn should_stream_previews(need_previews: bool, need_full_rgb: bool, wb_from_camera: bool, can_halve: bool) -> bool {
    need_previews && !need_full_rgb && wb_from_camera && can_halve
}

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

/// Shared ORF decode path: parse → validate → decompress → demosaic → NR → WB/matrix setup.
/// Returns pre-tonemapped RGB16 and all metadata.  Called by process_orf_impl.
fn decode_orf_raw(data: &[u8], output_flags: u32) -> Result<OrfDecoded, JsError> {
    let info = tiff::parse(data).map_err(|e| JsError::new(&e.to_string()))?;

    if info.compression != 1 {
        return Err(JsError::new(&format!(
            "compression {} not supported (expected Olympus 12-bit, comp=1)",
            info.compression
        )));
    }

    validate_orf_structure(data, &info)?;

    let w = info.width as usize;
    let h = info.height as usize;
    // strip bounds already validated by validate_orf_structure above
    let strip_end = info.strip_offset as usize + info.strip_byte_count as usize;
    let strip = &data[info.strip_offset as usize..strip_end];

    // Streaming preview-only fast path (see docs/superpowers/specs/2026-07-01-...).
    // When previews are wanted, full-res output is not, the frame is halve-able, and
    // camera WB tags are present, build previews without ever materializing the full
    // raw (~6× lower peak). Byte-identical to the full path (stream_preview tests).
    {
        let (lb_w, lb_h) = target_dims(w, h, 1800);
        let (thumb_w, thumb_h) = target_dims(w, h, 360);
        let need_previews = output_flags & (OUT_LIGHTBOX | OUT_THUMB) != 0;
        let need_full_rgb = output_flags & (OUT_FULL_RGB8 | OUT_FULL_16) != 0;
        let wb_from_camera = info.wb_r.is_some() && info.wb_b.is_some();
        if should_stream_previews(need_previews, need_full_rgb, wb_from_camera, preview_can_halve(w, h, lb_w, lb_h)) {
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
    }

    let t = now_ms();
    let raw = decompress::decompress(strip, w, h).map_err(|e| JsError::new(&e))?;
    let decompress_ms = now_ms() - t;

    // Hypercar fast path for previews (OUT_LIGHTBOX/THUMB). CRAWL A-1: gate the whole
    // preview build on whether a preview output was actually requested — a pure full-RGB8
    // batch encode (OUT_FULL_RGB8 only) must not pay a preview demosaic + downscales whose
    // buffers are discarded. The mhc demosaic below runs only when OUT_FULL_RGB8/OUT_FULL_16
    // is set (need_full_rgb gate).
    //
    // P2: when the half-resolution plane still supersamples the lightbox (preview_can_halve),
    // build previews from the 2×2 superpixel demosaic (¼ res) instead of full-res bilinear —
    // ~4× faster demosaic + ¼ the peak heap, perceptually equivalent at preview size
    // (Butteraugli 0.063 @20 MP; examples/demosaic_preview_demo). The superpixel output is
    // interleaved, so it downscales via downscale_rgb16_impl (byte-identical packed LE format
    // to the planar downscale). Small frames fall back to the full-res planar bilinear path.
    let need_previews = output_flags & (OUT_LIGHTBOX | OUT_THUMB) != 0;
    let (lb_w, lb_h) = target_dims(w, h, 1800);
    let (thumb_w, thumb_h) = target_dims(w, h, 360);
    let (lb_packed, thumb_packed, preview_demosaic_ms, preview_downscale_ms, fast_preview) =
        if !need_previews {
            (Vec::new(), Vec::new(), 0.0, 0.0, false)
        } else if preview_can_halve(w, h, lb_w, lb_h) {
            let (hw, hh) = (w / 2, h / 2);
            let t_dem = now_ms();
            let half = demosaic::demosaic_rggb_half(&raw, w, h).map_err(|e| JsError::new(&e))?;
            let preview_demosaic_ms = now_ms() - t_dem; // ¼-res 2×2 superpixel demosaic
            let t_down = now_ms();
            let lb_packed = downscale_rgb16_impl(&half, hw, hh, lb_w, lb_h);
            let thumb_packed = downscale_rgb16_impl(&half, hw, hh, thumb_w, thumb_h);
            let preview_downscale_ms = now_ms() - t_down; // two downs (lb + thumb) over ¼ pixels
            (lb_packed, thumb_packed, preview_demosaic_ms, preview_downscale_ms, true)
        } else {
            // Full-res bilinear fallback: frame too small to halve without upsampling the lightbox.
            let t_dem = now_ms();
            let (pr, pg, pb) =
                demosaic::demosaic_rggb_planar(&raw, w, h).map_err(|e| JsError::new(&e))?;
            let preview_demosaic_ms = now_ms() - t_dem; // fast planar bilinear demosaic
            let t_down = now_ms();
            let lb_packed = downscale_rgb16_planar(&pr, &pg, &pb, w, h, lb_w, lb_h);
            let thumb_packed = downscale_rgb16_planar(&pr, &pg, &pb, w, h, thumb_w, thumb_h);
            let preview_downscale_ms = now_ms() - t_down; // two planar downs (lb + thumb)
            (lb_packed, thumb_packed, preview_demosaic_ms, preview_downscale_ms, true)
        };

    let mut params = pipeline::PipelineParams::default_olympus();
    // Olympus 12-bit sensors sit on a ~256-count black pedestal that `default_olympus`
    // (black=0) never subtracted — uniquely among formats (DNG/CR2 read their black
    // tags). With black=0 the pre-LUT multiplies the pedestal by the per-channel WB
    // (R,B ×~1.8, G ×1.0), inflating R,B over G → a magenta/purple cast that is
    // strongest in shadows and washes the whole frame lighter. Proven two ways:
    // a synthetic neutral grey goes magenta +86 at black=0 vs 0 at black=256
    // (examples/synthetic_calib.rs), and the raw histogram floor of real files sits
    // at ~256 (min 251, p0.1% 260; examples/orf_black_sweep.rs). Subtracting it both
    // removes the cast (camera WB 1.797/1.797 then renders neutral) and restores
    // contrast/darkness. 256 is the canonical Olympus 12-bit pedestal — validated on
    // E-M1 Mark III; other bodies share this floor but were not individually checked.
    params.black = OLYMPUS_BLACK_LEVEL;
    // Trust camera WB_RBLevels (ImageProcessing 0x0100 / MakerNote 0x1017/1018/1029)
    // unconditionally.  This is the calibration the in-camera JPEG uses, so
    // matching it gives colour fidelity to the embedded preview.  Gray-world
    // fallback only when the camera didn't store WB at all (very rare).
    //
    // Earlier versions discarded camera WB for "manual" modes 16..=67 (presets)
    // and 256..=259 / 512..=515 (One-Touch / Custom) — but those modes still
    // store the correct per-shot WB and discarding them produced washed-out,
    // colour-cast output vs. the embedded JPEG.
    let wb_from_camera = info.wb_r.is_some() && info.wb_b.is_some();
    if wb_from_camera {
        if let Some(r) = info.wb_r {
            params.wb_r = r;
        }
        if let Some(b) = info.wb_b {
            params.wb_b = b;
        }
    } else {
        let (ar, ab) = pipeline::auto_wb_rggb(&raw, w, h, params.black);
        params.wb_r = ar;
        params.wb_b = ab;
    }
    let color_matrix_from_mn = info.color_matrix.is_some();
    if let Some(m) = info.color_matrix {
        params.color_matrix = Some(m);
    }

    let color_matrix_flat: [f32; 9] = {
        let m = params.color_matrix.unwrap_or(pipeline::CAM_TO_SRGB);
        [
            m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2],
        ]
    };

    // Gate MHC demosaic: only needed when full-resolution output is requested.
    // Preview paths (OUT_LIGHTBOX/THUMB) use the planar bilinear demosaic above.
    let need_full_rgb = output_flags & (OUT_FULL_RGB8 | OUT_FULL_16) != 0;
    let t = now_ms();
    let mut rgb16 = if need_full_rgb {
        demosaic::demosaic_rggb_mhc(&raw, w, h).map_err(|e| JsError::new(&e))?
    } else {
        Vec::new()
    };
    let demosaic_ms = if need_full_rgb { now_ms() - t } else { 0.0 };
    drop(raw);

    // ISO-gated luminance NR on the MHC output — only relevant for full-rgb paths.
    if need_full_rgb {
        let nr_strength = match info.iso.unwrap_or(0) {
            iso if iso >= 6400 => 0.50f32,
            iso if iso >= 3200 => 0.35,
            iso if iso >= 1600 => 0.20,
            _ => 0.0,
        };
        if nr_strength > 0.0 {
            pipeline::apply_luminance_nr(&mut rgb16, w, h, nr_strength);
        }
    }

    Ok(OrfDecoded {
        rgb16,
        w,
        h,
        info,
        decompress_ms,
        demosaic_ms,
        wb_from_camera,
        params,
        color_matrix_from_mn,
        color_matrix_flat,
        lb_packed,
        lb_w,
        lb_h,
        thumb_packed,
        thumb_w,
        thumb_h,
        preview_demosaic_ms,
        preview_downscale_ms,
        fast_preview,
    })
}

/// Shared output stage: conditionally compute lb, thumb, and full RGB8 from
/// pre-decoded ORF data according to `output_flags`.  Absent outputs have empty
/// buffers and zero dims in the returned `ProcessResult`.
fn process_orf_impl(
    decoded: OrfDecoded,
    output_flags: u32,
    look: &LookOverrides,
) -> Result<ProcessResult, JsError> {
    let OrfDecoded {
        mut rgb16,
        w,
        h,
        info,
        decompress_ms,
        demosaic_ms,
        wb_from_camera,
        mut params,
        color_matrix_from_mn,
        color_matrix_flat,
        lb_packed,
        lb_w,
        lb_h,
        thumb_packed,
        thumb_w,
        thumb_h,
        preview_demosaic_ms,
        preview_downscale_ms,
        fast_preview,
    } = decoded;

    // Hypercar: use precomputed fast planar bilinear + planar down for lb/thumb (cheap SIMD, no mhc for preview paths).
    // The old down from (mhc) rgb16 is bypassed for previews; full rgb16 only for OUT_FULL_RGB8 tone.
    // M3 full-res 16-bit (for pyramid RAW 2048/full levels). Only when OUT_FULL_16 flag set.
    // A-5: capture the 16-bit master *after* the tone path's last read of rgb16 (moving it
    // out, no copy) instead of packing a second full-res buffer here while rgb16 is still
    // live. Packed to LE bytes lazily in take_rgb16_full; output bytes are unchanged.
    let want_full16 = output_flags & OUT_FULL_16 != 0;
    let (out_full16_w, out_full16_h) = if want_full16 {
        (w as u32, h as u32)
    } else {
        (0, 0)
    };
    let (rgb16_lb, out_lb_w, out_lb_h) = if output_flags & OUT_LIGHTBOX != 0 {
        (lb_packed, lb_w, lb_h)
    } else {
        (vec![], 0, 0)
    };

    let (rgb16_thumb, out_thumb_w, out_thumb_h) = if output_flags & OUT_THUMB != 0 {
        (thumb_packed, thumb_w, thumb_h)
    } else {
        (vec![], 0, 0)
    };

    if look.wb_r.is_finite() && look.wb_r > 0.0 {
        params.wb_r = look.wb_r.min(8.0);
    }
    if look.wb_b.is_finite() && look.wb_b > 0.0 {
        params.wb_b = look.wb_b.min(8.0);
    }
    raw_pipeline::pipeline::apply_look_params(
        &mut params,
        look.exposure_ev,
        look.contrast,
        look.highlights,
        look.shadows,
        look.whites,
        look.blacks,
        look.saturation,
        look.vibrance,
        look.temp,
        look.tint,
        look.texture,
        look.clarity,
    );

    let t = now_ms();
    let (final_rgb, final_w, final_h, tonemap_ms, orient_ms, rgb16_full) =
        if output_flags & OUT_FULL_RGB8 != 0 {
            // Unsharp mutates rgb16 in place; the 16-bit master export is the *pre-unsharp*
            // image (as the former eager pack was), so snapshot before mutating in that
            // (rare) case. The common path runs no unsharp and moves rgb16 out for free.
            let will_unsharp = params.texture != 0.0 || params.clarity != 0.0;
            let full16_pre = if want_full16 && will_unsharp {
                Some(rgb16.clone())
            } else {
                None
            };
            if will_unsharp {
                pipeline::apply_unsharp_masks(&mut rgb16, w, h, &params);
            }
            // Lens 23/24: use process_into + preallocated buffer to avoid internal Vec alloc
            // inside the tone path (reuses the "into" pattern from demosaic/pipeline).
            let mut rgb8 = vec![0u8; w * h * 3];
            // Chapter 1: SIMD bulk tone on wasm/x86 for the plain path (the 90% case),
            // scalar parity path only for perceptual_constancy. The big full-res win.
            pipeline::process_into_auto(&rgb16, &params, &mut rgb8);
            let tonemap_ms = now_ms() - t;
            // rgb16's last read is done: move it into the 16-bit master (common, no copy),
            // use the pre-unsharp snapshot, or release it. Freed before orientation either way.
            let rgb16_full = if want_full16 {
                full16_pre.unwrap_or(rgb16)
            } else {
                drop(rgb16);
                Vec::new()
            };
            let t2 = now_ms();
            // OUT_NO_ORIENT lets the encoder use JXL's basic-info orientation field
            // — no CPU rotate, no 60–200 MB intermediate buffer.
            let skip_orient = (output_flags & OUT_NO_ORIENT) != 0;
            let (fr, fw, fh) = if skip_orient || info.orientation == 1 {
                (rgb8, w, h)
            } else {
                pipeline::apply_orientation(rgb8, w, h, info.orientation)
            };
            (fr, fw, fh, tonemap_ms, now_ms() - t2, rgb16_full)
        } else {
            let rgb16_full = if want_full16 { rgb16 } else { Vec::new() };
            (vec![], 0, 0, 0.0, 0.0, rgb16_full)
        };

    Ok(ProcessResult {
        rgb: final_rgb,
        width: final_w as u32,
        height: final_h as u32,
        orientation: info.orientation,
        decompress_ms,
        demosaic_ms,
        tonemap_ms,
        orient_ms,
        preview_demosaic_ms,
        preview_downscale_ms,
        fast_preview,
        wb_r_used: params.wb_r,
        wb_b_used: params.wb_b,
        black_used: params.black,
        color_matrix_from_mn,
        make: info.make,
        model: info.model,
        rgb16_lb,
        lb_w: out_lb_w as u32,
        lb_h: out_lb_h as u32,
        rgb16_thumb,
        thumb_w: out_thumb_w as u32,
        thumb_h: out_thumb_h as u32,
        rgb16_full,
        full16_w: out_full16_w,
        full16_h: out_full16_h,
        color_matrix_flat,
        lens: info.lens,
        datetime: info.datetime,
        // Rational fields use 0/0 as absent-sentinel (JS checks den==0 before dividing).
        exposure_num: info.exposure.map(|(n, _)| n).unwrap_or(0),
        exposure_den: info.exposure.map(|(_, d)| d).unwrap_or(0),
        fnumber_num: info.fnumber.map(|(n, _)| n).unwrap_or(0),
        fnumber_den: info.fnumber.map(|(_, d)| d).unwrap_or(0),
        iso: info.iso.unwrap_or(0),
        focal_length_num: info.focal_length.map(|(n, _)| n).unwrap_or(0),
        focal_length_den: info.focal_length.map(|(_, d)| d).unwrap_or(0),
        focal_length_35: info.focal_length_35.unwrap_or(0),
        gps_lat: info.gps_lat.unwrap_or(0.0),
        gps_lon: info.gps_lon.unwrap_or(0.0),
        gps_alt: info.gps_alt.unwrap_or(0.0),
        has_gps: info.gps_lat.is_some() && info.gps_lon.is_some(),
        quality: info.quality.unwrap_or(0),
        wb_mode: info.wb_mode.unwrap_or(0xFFFF),
        wb_from_camera,
    })
}

/// Central structural validation for ORF inputs.  Runs before the pipeline so
/// user-facing errors are produced in one place rather than scattered across
/// individual functions.  Internal guards in demosaic/decompress remain as
/// defence-in-depth but should never fire if this passes.
fn validate_orf_structure(data: &[u8], info: &tiff::OrfInfo) -> Result<(), JsError> {
    const MAX_DIM: u32 = 16_384;
    const MAX_PIXELS: usize = 50_000_000; // 50 MP

    if info.width == 0 || info.height == 0 {
        return Err(JsError::new("ORF: zero image dimension"));
    }
    if info.width > MAX_DIM || info.height > MAX_DIM {
        return Err(JsError::new(&format!(
            "ORF: dimension {}×{} exceeds maximum {}",
            info.width, info.height, MAX_DIM
        )));
    }
    let n = (info.width as usize)
        .checked_mul(info.height as usize)
        .ok_or_else(|| JsError::new("ORF: width×height overflows"))?;
    if n > MAX_PIXELS {
        return Err(JsError::new(&format!(
            "ORF: {} pixels exceeds 50 MP limit",
            n
        )));
    }
    let strip_end = (info.strip_offset as usize)
        .checked_add(info.strip_byte_count as usize)
        .ok_or_else(|| JsError::new("ORF: strip offset+length overflows"))?;
    if strip_end > data.len() {
        return Err(JsError::new("ORF: strip extends past end of file"));
    }
    Ok(())
}

/// Parse + decode an ORF file blob.  Returns an error string on failure.
///
/// All look params are LR-style, zero-centred (-1..+1 normalised), except
/// `exposure_ev` which is in stops.  `wb_r_override` / `wb_b_override`:
/// pass NaN (or ≤0) to use MakerNote / defaults.
///
/// Always generates full RGB8, 1800 px lightbox RGB16, and 360 px thumbnail RGB16.
/// Use `process_orf_with_flags` to skip unused outputs (e.g. batch JXL encoding
/// only needs full RGB8, not lb/thumb).
#[wasm_bindgen]
pub fn process_orf(
    data: &[u8],
    exposure_ev: f32,
    contrast: f32,
    highlights: f32,
    shadows: f32,
    whites: f32,
    blacks: f32,
    saturation: f32,
    vibrance: f32,
    temp: f32,
    tint: f32,
    wb_r_override: f32,
    wb_b_override: f32,
    texture: f32,
    clarity: f32,
) -> Result<ProcessResult, JsError> {
    let look = LookOverrides {
        wb_r: wb_r_override,
        wb_b: wb_b_override,
        exposure_ev,
        contrast,
        highlights,
        shadows,
        whites,
        blacks,
        saturation,
        vibrance,
        temp,
        tint,
        texture,
        clarity,
    };
    process_orf_impl(
        decode_orf_raw(data, OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB)?,
        OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB,
        &look,
    )
}

/// Variant of `process_orf` with explicit output flags to skip unused pipeline stages.
///
/// `output_flags` is a bitmask of:
/// - `1` (`OUT_FULL_RGB8`): full-resolution RGB8 (needed for JXL encoding)
/// - `2` (`OUT_LIGHTBOX`): 1800 px lightbox RGB16 cache (needed to construct a `LookRenderer`)
/// - `4` (`OUT_THUMB`): 360 px thumbnail RGB16 cache (needed to construct a thumb `LookRenderer`)
/// - `8` (`OUT_FULL_16`): full-resolution packed u16 LE (6 bytes/pixel) for pyramid big levels
///   and the 16-bit lightbox/ROI/export path. Grid levels and JPG stay 8-bit.
/// - `16` (`OUT_NO_ORIENT`): skip `apply_orientation` on the RGB8 output. Pixels stay in sensor
///   orientation; the consumer reads `orientation` to display or encode with JXL basic-info.
///   Saves the 60–200 MB intermediate rotate when feeding a JXL encoder.
///   (Note: bit 8 was previously used for `OUT_NO_ORIENT` before `OUT_FULL_16=8` was added;
///   `OUT_NO_ORIENT` was moved to bit 16 to avoid the collision — commit b2cb8dc9 / 1674aa11.)
///
/// Absent outputs have empty buffers and zero dims in `ProcessResult`.
/// Pass `7` for classic (no full16). For M3 16-bit big levels pass e.g. 15 (7|8).
#[wasm_bindgen]
pub fn process_orf_with_flags(
    data: &[u8],
    output_flags: u32,
    exposure_ev: f32,
    contrast: f32,
    highlights: f32,
    shadows: f32,
    whites: f32,
    blacks: f32,
    saturation: f32,
    vibrance: f32,
    temp: f32,
    tint: f32,
    wb_r_override: f32,
    wb_b_override: f32,
    texture: f32,
    clarity: f32,
) -> Result<ProcessResult, JsError> {
    let look = LookOverrides {
        wb_r: wb_r_override,
        wb_b: wb_b_override,
        exposure_ev,
        contrast,
        highlights,
        shadows,
        whites,
        blacks,
        saturation,
        vibrance,
        temp,
        tint,
        texture,
        clarity,
    };
    process_orf_impl(decode_orf_raw(data, output_flags)?, output_flags, &look)
}

/// Rotated RGB8 buffer with updated dimensions.
#[wasm_bindgen]
pub struct RotateResult {
    rgb: Vec<u8>,
    #[wasm_bindgen(readonly)]
    pub width: u32,
    #[wasm_bindgen(readonly)]
    pub height: u32,
}

#[wasm_bindgen]
impl RotateResult {
    // Transfers ownership; returns empty Vec<u8> on subsequent calls.
    pub fn take_rgb(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.rgb)
    }
}

/// Rotate an RGB8 buffer clockwise by `turns` × 90°  (0=0°, 1=90°, 2=180°, 3=270°).
/// Returns the rotated buffer and new (width, height).
#[wasm_bindgen]
pub fn rotate_rgb8(
    src: &[u8],
    width: u32,
    height: u32,
    turns: u32,
) -> Result<RotateResult, JsError> {
    let w = width as usize;
    let h = height as usize;
    let expected = w
        .checked_mul(h)
        .and_then(|n| n.checked_mul(3))
        .ok_or_else(|| JsError::new("rotate_rgb8: dimensions overflow"))?;
    if src.len() != expected {
        return Err(JsError::new(&format!(
            "rotate_rgb8: src length {} != {}×{}×3",
            src.len(),
            w,
            h
        )));
    }
    let (rgb, nw, nh) = match turns % 4 {
        0 => (src.to_vec(), w, h),
        1 => (pipeline::rotate_90_cw(src, w, h), h, w),
        2 => (pipeline::rotate_180(src, w, h), w, h),
        3 => (pipeline::rotate_90_ccw(src, w, h), h, w),
        _ => unreachable!(),
    };
    Ok(RotateResult {
        rgb,
        width: nw as u32,
        height: nh as u32,
    })
}

/// Box-filter downscale an RGB8 buffer.  Useful for thumbnail generation.
///
/// Fast path: when src dims are exact integer multiple of dst (common for 1/2, 1/4, 1/8 thumbs),
/// uses a much faster integer stepping loop with no f32 math or edge cases.
#[wasm_bindgen]
pub fn downscale_rgb(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
) -> Result<Vec<u8>, JsError> {
    let (sw, sh, dw, dh) = (
        src_w as usize,
        src_h as usize,
        dst_w as usize,
        dst_h as usize,
    );
    let expected_len = sw
        .checked_mul(sh)
        .and_then(|n| n.checked_mul(3))
        .ok_or_else(|| JsError::new("downscale_rgb: dimensions overflow"))?;
    if src.len() != expected_len {
        return Err(JsError::new("src length mismatch"));
    }
    if dst_w == 0 || dst_h == 0 {
        return Err(JsError::new("downscale_rgb: dst dimensions must be > 0"));
    }
    if src_w == 0 || src_h == 0 {
        return Err(JsError::new("downscale_rgb: src dimensions must be > 0"));
    }
    let mut out = vec![0u8; dw * dh * 3];

    // Big-brain fast path: exact integer downsample factors (very common for thumbs 1/2, 1/4, 1/8).
    // This is dramatically faster and has better cache behavior than the general box filter.
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw;
        let ystep = sh / dh;
        let pixel_count = (xstep * ystep) as u32;
        let mut o = 0usize;
        for dy in 0..dh {
            for dx in 0..dw {
                let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
                let x_base = dx * xstep;
                let mut row_base = dy * ystep * sw;
                for _yy in 0..ystep {
                    let mut i = (row_base + x_base) * 3;
                    for _xx in 0..xstep {
                        rr += src[i] as u32;
                        gg += src[i + 1] as u32;
                        bb += src[i + 2] as u32;
                        i += 3;
                    }
                    row_base += sw;
                }
                out[o]     = (rr / pixel_count) as u8;
                out[o + 1] = (gg / pixel_count) as u8;
                out[o + 2] = (bb / pixel_count) as u8;
                o += 3;
            }
        }
        return Ok(out);
    }

    let xr = sw as f32 / dw as f32;
    let yr = sh as f32 / dh as f32;
    let mut o = 0usize;
    for dy in 0..dh {
        let y0 = (dy as f32 * yr) as usize;
        let y1 = ((dy as f32 + 1.0) * yr).min(sh as f32) as usize;
        let y1 = y1.max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f32 * xr) as usize;
            let x1 = ((dx as f32 + 1.0) * xr).min(sw as f32) as usize;
            let x1 = x1.max(x0 + 1);
            let x_count = x1 - x0;
            let n = ((y1 - y0) * x_count).max(1) as u32;
            let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
            let mut row_base = (y0 * sw + x0) * 3;
            for _y in y0..y1 {
                let mut i = row_base;
                for _ in 0..x_count {
                    rr += src[i] as u32;
                    gg += src[i + 1] as u32;
                    bb += src[i + 2] as u32;
                    i += 3;
                }
                row_base += sw * 3;
            }
            out[o]     = (rr / n) as u8;
            out[o + 1] = (gg / n) as u8;
            out[o + 2] = (bb / n) as u8;
            o += 3;
        }
    }
    Ok(out)
}

/// Planar SoA downscale (hypercar layer): 3 separate contiguous planes in (R/G/B from demosaic_planar).
/// Zero interleave cost. Sequential per-channel box filter = massive cache win vs interleaved scatter.
/// Outputs packed LE u8 6B/px (same as before) for drop-in use in lb/thumb paths. Integer fast path per plane.
fn downscale_rgb16_planar(r: &[u16], g: &[u16], b: &[u16], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    let mut out = vec![0u8; dw * dh * 6];
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw;
        let ystep = sh / dh;
        let pixel_count = (xstep * ystep) as u32;
        let mut o = 0usize;
        for dy in 0..dh {
            for dx in 0..dw {
                let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
                let x_base = dx * xstep;
                let mut row_base = dy * ystep * sw;
                for _yy in 0..ystep {
                    let mut idx = row_base + x_base;
                    for _xx in 0..xstep {
                        rr += r[idx] as u32; gg += g[idx] as u32; bb += b[idx] as u32;
                        idx += 1;
                    }
                    row_base += sw;
                }
                write_rgb16_le(&mut out, o, (rr / pixel_count) as u16, (gg / pixel_count) as u16, (bb / pixel_count) as u16);
                o += 6;
            }
        }
        return out;
    }
    downscale_rgb_float_path(sw, sh, dw, dh, &mut out, |idx| {
        (r[idx] as u32, g[idx] as u32, b[idx] as u32)
    });
    out
}

/// Box-filter downscale an RGBA8 buffer.  Useful for thumbnail generation.
///
/// Fast path: when src dims are exact integer multiple of dst (common for 1/2, 1/4, 1/8 thumbs),
/// uses a much faster integer stepping loop with no f32 math or edge cases.
#[wasm_bindgen]
pub fn downscale_rgba(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
) -> Result<Vec<u8>, JsError> {
    let (sw, sh, dw, dh) = (
        src_w as usize,
        src_h as usize,
        dst_w as usize,
        dst_h as usize,
    );
    let expected_len = sw
        .checked_mul(sh)
        .and_then(|n| n.checked_mul(4))
        .ok_or_else(|| JsError::new("downscale_rgba: dimensions overflow"))?;
    if src.len() != expected_len {
        return Err(JsError::new("src length mismatch"));
    }
    if dst_w == 0 || dst_h == 0 {
        return Err(JsError::new("downscale_rgba: dst dimensions must be > 0"));
    }
    if src_w == 0 || src_h == 0 {
        return Err(JsError::new("downscale_rgba: src dimensions must be > 0"));
    }

    let mut out = vec![0u8; dw * dh * 4];

    // Same big-brain integer fast path as downscale_rgb for common power-of-two thumbnail cases.
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw;
        let ystep = sh / dh;
        let pixel_count = (xstep * ystep) as u32;
        let mut o = 0usize;
        for dy in 0..dh {
            for dx in 0..dw {
                let (mut rr, mut gg, mut bb, mut aa) = (0u32, 0u32, 0u32, 0u32);
                let x_base = dx * xstep;
                let mut row_base = dy * ystep * sw;
                for _yy in 0..ystep {
                    let mut i = (row_base + x_base) * 4;
                    for _xx in 0..xstep {
                        rr += src[i]     as u32;
                        gg += src[i + 1] as u32;
                        bb += src[i + 2] as u32;
                        aa += src[i + 3] as u32;
                        i += 4;
                    }
                    row_base += sw;
                }
                out[o]     = (rr / pixel_count) as u8;
                out[o + 1] = (gg / pixel_count) as u8;
                out[o + 2] = (bb / pixel_count) as u8;
                out[o + 3] = (aa / pixel_count) as u8;
                o += 4;
            }
        }
        return Ok(out);
    }

    let xr = sw as f32 / dw as f32;
    let yr = sh as f32 / dh as f32;
    let mut o = 0usize;
    for dy in 0..dh {
        let y0 = (dy as f32 * yr) as usize;
        let y1 = ((dy as f32 + 1.0) * yr).min(sh as f32) as usize;
        let y1 = y1.max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f32 * xr) as usize;
            let x1 = ((dx as f32 + 1.0) * xr).min(sw as f32) as usize;
            let x1 = x1.max(x0 + 1);
            let x_count = x1 - x0;
            let n = ((y1 - y0) * x_count).max(1) as u32;
            let (mut rr, mut gg, mut bb, mut aa) = (0u32, 0u32, 0u32, 0u32);
            let mut row_base = (y0 * sw + x0) * 4;
            for _y in y0..y1 {
                let mut i = row_base;
                for _ in 0..x_count {
                    rr += src[i]     as u32;
                    gg += src[i + 1] as u32;
                    bb += src[i + 2] as u32;
                    aa += src[i + 3] as u32;
                    i += 4;
                }
                row_base += sw * 4;
            }
            out[o]     = (rr / n) as u8;
            out[o + 1] = (gg / n) as u8;
            out[o + 2] = (bb / n) as u8;
            out[o + 3] = (aa / n) as u8;
            o += 4;
        }
    }
    Ok(out)
}

/// Re-apply tonemap + orientation to a cached lightbox-sized rgb16 buffer.
///
/// `rgb16_src` is flat RGB16 (3 u16 per pixel, interleaved).  For repeated slider
/// edits prefer `LookRenderer`, which owns the buffer inside WASM and avoids the
/// JS→WASM transfer on each call.
/// `color_matrix_flat` is 9 f32s row-major; pass a slice of len != 9 to use the
/// built-in fallback.
#[wasm_bindgen]
pub fn apply_look(
    rgb16_src: &[u16],
    width: u32,
    height: u32,
    orientation: u16,
    wb_r: f32,
    wb_b: f32,
    color_matrix_flat: &[f32],
    exposure_ev: f32,
    contrast: f32,
    highlights: f32,
    shadows: f32,
    whites: f32,
    blacks: f32,
    saturation: f32,
    vibrance: f32,
    temp: f32,
    tint: f32,
    texture: f32,
    clarity: f32,
) -> Result<Vec<u8>, JsError> {
    let w = width as usize;
    let h = height as usize;
    let expected_len = w
        .checked_mul(h)
        .and_then(|px| px.checked_mul(3))
        .ok_or_else(|| JsError::new("apply_look: dimensions overflow"))?;
    if rgb16_src.len() != expected_len {
        return Err(JsError::new(&format!(
            "apply_look: rgb16 length {} != {}×{}×3",
            rgb16_src.len(),
            w,
            h
        )));
    }
    let mut params = pipeline::PipelineParams::default_olympus();
    if wb_r.is_finite() && wb_r > 0.0 {
        params.wb_r = wb_r;
    }
    if wb_b.is_finite() && wb_b > 0.0 {
        params.wb_b = wb_b;
    }
    if color_matrix_flat.len() == 9 {
        let mut m = [[0f32; 3]; 3];
        for r in 0..3 {
            for c in 0..3 {
                m[r][c] = color_matrix_flat[r * 3 + c];
            }
        }
        params.color_matrix = Some(m);
    }
    raw_pipeline::pipeline::apply_look_params(
        &mut params,
        exposure_ev,
        contrast,
        highlights,
        shadows,
        whites,
        blacks,
        saturation,
        vibrance,
        temp,
        tint,
        texture,
        clarity,
    );

    // Defer clone to only when unsharp masking is needed (texture or clarity nonzero).
    // For the common no-sharpening path the borrow is sufficient and we avoid an
    // unnecessary full-resolution copy.
    // SIMD-fused tone path (process_auto → process_into_simd). ≤1-LUT-step vs the byte-exact
    // scalar `process`; same tolerance the heavy RAW decode already ships, invisible for display.
    let rgb8 = if params.texture != 0.0 || params.clarity != 0.0 {
        let mut rgb16 = rgb16_src.to_vec();
        pipeline::apply_unsharp_masks(&mut rgb16, w, h, &params);
        pipeline::process_auto(&rgb16, &params)
    } else {
        pipeline::process_auto(rgb16_src, &params)
    };
    if orientation == 1 {
        Ok(rgb8)
    } else {
        let (final_rgb, _, _) = pipeline::apply_orientation(rgb8, w, h, orientation);
        Ok(final_rgb)
    }
}

/// Convert interleaved RGB8 → RGBA8 (alpha = 255).  HTML canvas wants RGBA.
// Input must be a multiple of 3 bytes; trailing bytes are ignored.
//
// 3-stride → 4-stride is not a memcpy, but it is a fixed byte-shuffle: a single
// pshufb/i8x16_swizzle turns 4 source pixels (12 bytes) into 4 RGBA pixels (16 bytes),
// with alpha set by OR-ing a constant 0xFF mask. SIMD handles the bulk; a scalar tail
// finishes the last <4 pixels (and the whole buffer when no SIMD is available).
#[wasm_bindgen]
pub fn rgb_to_rgba(rgb: &[u8]) -> Vec<u8> {
    let n = rgb.len() / 3;
    let mut out = vec![255u8; n * 4];
    let done = rgb_to_rgba_simd(rgb, &mut out, n);
    let (mut si, mut di) = (done * 3, done * 4);
    for _ in done..n {
        out[di] = rgb[si];
        out[di + 1] = rgb[si + 1];
        out[di + 2] = rgb[si + 2];
        si += 3;
        di += 4;
    }
    out
}

// Number of safe 4-pixel SIMD blocks: each reads 16 bytes (uses 12) from `rgb` and writes
// 16 bytes to `out`, so the last block must satisfy block*12 + 16 <= rgb.len().
#[inline]
fn rgb_to_rgba_simd_blocks(src_len: usize, n: usize) -> usize {
    if src_len < 16 { 0 } else { ((src_len - 16) / 12 + 1).min(n / 4) }
}

#[cfg(target_arch = "wasm32")]
fn rgb_to_rgba_simd(rgb: &[u8], out: &mut [u8], n: usize) -> usize {
    use core::arch::wasm32::*;
    let blocks = rgb_to_rgba_simd_blocks(rgb.len(), n);
    if blocks == 0 {
        return 0;
    }
    // Swizzle indices: lanes with the high bit set (here -128) emit 0; the alpha lanes
    // are then forced to 0xFF by the OR mask. RGB lanes pull bytes 0..11 (4 pixels).
    let idx = i8x16(0, 1, 2, -128, 3, 4, 5, -128, 6, 7, 8, -128, 9, 10, 11, -128);
    let amask = u8x16(0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255);
    for b in 0..blocks {
        unsafe {
            let v = v128_load(rgb.as_ptr().add(b * 12) as *const v128);
            let res = v128_or(i8x16_swizzle(v, idx), amask);
            v128_store(out.as_mut_ptr().add(b * 16) as *mut v128, res);
        }
    }
    blocks * 4
}

#[cfg(target_arch = "x86_64")]
fn rgb_to_rgba_simd(rgb: &[u8], out: &mut [u8], n: usize) -> usize {
    if !std::is_x86_feature_detected!("ssse3") {
        return 0;
    }
    let blocks = rgb_to_rgba_simd_blocks(rgb.len(), n);
    if blocks == 0 {
        return 0;
    }
    // SAFETY: ssse3 verified above; block bounds verified by rgb_to_rgba_simd_blocks.
    unsafe { rgb_to_rgba_ssse3(rgb, out, blocks) }
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "ssse3")]
unsafe fn rgb_to_rgba_ssse3(rgb: &[u8], out: &mut [u8], blocks: usize) -> usize {
    use core::arch::x86_64::*;
    // pshufb: index byte with the high bit set emits 0; alpha lanes (-128) become 0,
    // then OR'd to 0xFF (-1i8). RGB lanes pull bytes 0..11.
    let shuf = _mm_setr_epi8(0, 1, 2, -128, 3, 4, 5, -128, 6, 7, 8, -128, 9, 10, 11, -128);
    let amask = _mm_setr_epi8(0, 0, 0, -1, 0, 0, 0, -1, 0, 0, 0, -1, 0, 0, 0, -1);
    for b in 0..blocks {
        let v = _mm_loadu_si128(rgb.as_ptr().add(b * 12) as *const __m128i);
        let res = _mm_or_si128(_mm_shuffle_epi8(v, shuf), amask);
        _mm_storeu_si128(out.as_mut_ptr().add(b * 16) as *mut __m128i, res);
    }
    blocks * 4
}

#[cfg(not(any(target_arch = "wasm32", target_arch = "x86_64")))]
fn rgb_to_rgba_simd(_rgb: &[u8], _out: &mut [u8], _n: usize) -> usize {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_unpack_rgb16_match_scalar_reference_and_roundtrip() {
        // Scalar references = the pre-memcpy implementations.
        fn pack_scalar(src: &[u16], w: usize, h: usize) -> Vec<u8> {
            let mut out = vec![0u8; w * h * 6];
            for i in 0..(w * h) {
                let o = i * 6;
                let (r, g, b) = (src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
                out[o] = (r & 0xff) as u8; out[o + 1] = (r >> 8) as u8;
                out[o + 2] = (g & 0xff) as u8; out[o + 3] = (g >> 8) as u8;
                out[o + 4] = (b & 0xff) as u8; out[o + 5] = (b >> 8) as u8;
            }
            out
        }
        fn unpack_scalar(src: &[u8]) -> Vec<u16> {
            src.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect()
        }
        let (w, h) = (37usize, 19usize); // odd dims, full RGB triples
        let mut s: u32 = 0x1234_5678;
        let src: Vec<u16> = (0..w * h * 3).map(|_| {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            ((s >> 8) & 0xffff) as u16
        }).collect();
        let packed = pack_rgb16_full(&src, w, h);
        assert_eq!(packed, pack_scalar(&src, w, h), "pack != scalar reference");
        let unpacked = unpack_rgb16_le(&packed);
        assert_eq!(unpacked, unpack_scalar(&packed), "unpack != scalar reference");
        assert_eq!(unpacked, src, "pack→unpack round-trip lost data");
    }

    // A-5: the deferred (lazy) full-res 16-bit pack must produce byte-identical output to the
    // former eager pack. The capture contract is "export = the pre-unsharp rgb16": the common
    // no-unsharp path MOVES rgb16 out unchanged; the rare unsharp path SNAPSHOTS before
    // mutating. This test pins that invariant on synthetic data (the eager pack used to run on
    // the pre-unsharp buffer, so both deferred paths must match it bytewise).
    #[test]
    fn full16_deferred_capture_is_pre_unsharp_byte_exact() {
        let (w, h) = (16usize, 12usize);
        let rgb16: Vec<u16> = (0..w * h * 3)
            .map(|i| (i as u16).wrapping_mul(257).wrapping_add(7))
            .collect();
        // Eager reference: pack the pre-unsharp image (what the old code did at decode time).
        let eager = pack_rgb16_full(&rgb16, w, h);

        // Common path: no unsharp → rgb16 moved out untouched, packed lazily at take time.
        let moved = rgb16.clone(); // stands in for the move into rgb16_full
        assert_eq!(
            pack_rgb16_full(&moved, w, h),
            eager,
            "no-unsharp deferred pack must match eager pre-unsharp pack",
        );

        // Rare path: unsharp mutates rgb16 → we keep a pre-unsharp snapshot for the export.
        let snapshot = rgb16.clone();
        let mut mutated = rgb16.clone();
        for v in mutated.iter_mut() {
            *v = v.wrapping_add(1234); // stand-in for apply_unsharp_masks
        }
        assert_eq!(
            pack_rgb16_full(&snapshot, w, h),
            eager,
            "unsharp-path snapshot pack must match eager pre-unsharp pack",
        );
        assert_ne!(
            pack_rgb16_full(&mutated, w, h),
            eager,
            "sanity: packing the post-unsharp buffer would change the export bytes",
        );
    }

    #[test]
    fn preview_can_halve_guards_lightbox_supersample() {
        // 20 MP-ish: w/2 = 2620 ≥ lb 1800 → halve.
        let (lb_w, lb_h) = target_dims(5240, 3912, 1800);
        assert!(preview_can_halve(5240, 3912, lb_w, lb_h));
        // 12 MP: w/2 = 2016 ≥ 1800 → halve.
        let (lb_w, lb_h) = target_dims(4032, 3024, 1800);
        assert!(preview_can_halve(4032, 3024, lb_w, lb_h));
        // Small frame: w/2 = 1000 < 1800 → must NOT halve (¼-res would upsample the lightbox).
        let (lb_w, lb_h) = target_dims(2000, 1500, 1800);
        assert!(!preview_can_halve(2000, 1500, lb_w, lb_h));
    }

    #[test]
    fn half_res_preview_matches_full_res_within_tolerance() {
        // P2 quality contract: the ¼-res superpixel preview must stay close to the full-res
        // bilinear preview at lightbox size (proven Butteraugli 0.063 @20 MP visually in
        // examples/demosaic_preview_demo). This locks it as a native regression guard — a
        // wiring fault (wrong stride/plane/dims/CFA phase) blows the delta up 10–100×.
        // Spatially-coherent synthetic RGGB field (smooth gradient + mid-frequency texture),
        // representative of real scene content where the two converge after downscaling.
        let (w, h) = (3600usize, 2400);
        let mut raw = vec![0u16; w * h];
        for y in 0..h {
            for x in 0..w {
                let g = 300.0 + 1600.0 * (x as f32 / w as f32) + 800.0 * (y as f32 / h as f32);
                let tex = 220.0 * ((x as f32 / 11.0).sin() + (y as f32 / 13.0).cos());
                raw[y * w + x] = (g + tex).clamp(0.0, 4095.0) as u16;
            }
        }
        let (lb_w, lb_h) = target_dims(w, h, 1800);
        assert!(preview_can_halve(w, h, lb_w, lb_h));

        // Production full-res path (fallback arm).
        let (pr, pg, pb) = demosaic::demosaic_rggb_planar(&raw, w, h).unwrap();
        let full = unpack_rgb16_le(&downscale_rgb16_planar(&pr, &pg, &pb, w, h, lb_w, lb_h));
        // Production half-res path (fast arm).
        let (hw, hh) = (w / 2, h / 2);
        let half_rgb = demosaic::demosaic_rggb_half(&raw, w, h).unwrap();
        let half = unpack_rgb16_le(&downscale_rgb16_impl(&half_rgb, hw, hh, lb_w, lb_h));

        assert_eq!(full.len(), half.len(), "preview lengths differ");
        let (mut sum, mut maxd) = (0u64, 0u16);
        for (&a, &b) in full.iter().zip(&half) {
            let d = a.abs_diff(b);
            sum += d as u64;
            maxd = maxd.max(d);
        }
        let mean = sum as f64 / full.len() as f64;
        // 12-bit scale (0..4095). Correct wiring keeps the mean delta tiny on coherent content;
        // the generous bound exists to catch a gross regression, not to assert bit-equality.
        assert!(mean < 40.0, "half preview mean delta {mean:.1} too high (12-bit 0..4095)");
    }

    #[test]
    fn rgb_to_rgba_simd_matches_scalar() {
        fn scalar(rgb: &[u8]) -> Vec<u8> {
            let n = rgb.len() / 3;
            let mut out = vec![255u8; n * 4];
            let (mut si, mut di) = (0, 0);
            for _ in 0..n {
                out[di] = rgb[si]; out[di + 1] = rgb[si + 1]; out[di + 2] = rgb[si + 2];
                si += 3; di += 4;
            }
            out
        }
        // Pixel counts spanning: empty, <4 (no SIMD), exact blocks, blocks+tail, large.
        for &px in &[0usize, 1, 2, 3, 4, 5, 7, 8, 15, 16, 17, 1000, 1001] {
            let mut s: u32 = 0xC0FFEE ^ px as u32;
            let rgb: Vec<u8> = (0..px * 3).map(|_| {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (s >> 24) as u8
            }).collect();
            assert_eq!(rgb_to_rgba(&rgb), scalar(&rgb), "mismatch at {px} px");
        }
    }

    /// 100×100 explicit parity check matching the benchmark spec.
    /// Verifies that the SIMD shuffle path (x86 SSSE3 / wasm32 i8x16_swizzle) is
    /// byte-identical to the reference scalar scatter for a typical thumbnail size.
    #[test]
    fn rgb_to_rgba_100x100_scalar_simd_parity() {
        const W: usize = 100;
        const H: usize = 100;
        let mut s: u32 = 0xDEAD_BEEF;
        let rgb: Vec<u8> = (0..W * H * 3).map(|_| {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (s >> 24) as u8
        }).collect();
        // Reference scalar: straightforward 3→4 stride scatter.
        let n = W * H;
        let mut expected = vec![255u8; n * 4];
        let (mut si, mut di) = (0usize, 0usize);
        for _ in 0..n {
            expected[di] = rgb[si]; expected[di + 1] = rgb[si + 1]; expected[di + 2] = rgb[si + 2];
            si += 3; di += 4;
        }
        let got = rgb_to_rgba(&rgb);
        assert_eq!(got.len(), n * 4, "output length wrong");
        assert_eq!(got, expected, "SIMD vs scalar mismatch on 100x100 input");
        // Alpha channel must be 0xFF for every pixel.
        assert!(got.chunks_exact(4).all(|px| px[3] == 255), "alpha != 0xFF");
    }

    #[test]
    fn take_rgba_via_rgb_to_rgba_roundtrip() {
        // Basic sanity: the take_rgba path ultimately uses the same conversion
        // as the public rgb_to_rgba helper.
        let rgb = vec![10, 20, 30, 40, 50, 60];
        // We can't easily unit-test take_rgba without a full ProcessResult,
        // but we can at least ensure the shared helper is stable.
        let expected = rgb_to_rgba(&rgb);
        assert_eq!(expected.len(), 8);
        assert_eq!(&expected[0..4], &[10, 20, 30, 255]);
    }

    #[test]
    fn raw_pipeline_direct_rgba_available_for_native_parity() {
        // Smoke that the direct-RGBA entry (for Tauri P3 encode parity) is linked
        // and produces correct channel count + sentinel alpha. The heavy impl
        // and benches live in the raw-pipeline crate.
        let rgb16 = vec![2048u16; 2 * 2 * 3];
        let params = raw_pipeline::pipeline::PipelineParams::default_olympus();
        let rgba = raw_pipeline::pipeline::process_rgba(&rgb16, &params);
        assert_eq!(rgba.len(), 16);
        assert!(rgba.chunks_exact(4).all(|px| px[3] == 255));
    }
}

/// WASM-resident rendering state for a single image (lightbox or thumbnail).
///
/// Owns the pre-tonemapped RGB16 buffer.  Slider changes call `render()` without
/// transferring pixel data between JS and WASM — the JS→WASM transfer happens once
/// at construction; every subsequent edit stays inside WASM.
///
/// When `texture` and `clarity` are both zero (the common case), `render` reads the
/// internal buffer without cloning.  When either is nonzero, a thread-local scratch
/// buffer is reused for in-place sharpening so the cached buffer is never mutated
/// and no per-call Vec::clone occurs.
#[wasm_bindgen]
pub struct LookRenderer {
    rgb16: Vec<u16>,
    width: usize,
    height: usize,
    orientation: u16,
    // When false, `render()` returns sensor-orientation RGB8 (sensor width/height)
    // and the consumer is responsible for applying the rotation — typically via
    // a CSS / canvas-transform draw, which is free on the GPU. When true (legacy
    // default), the rotation is baked into pixels during render.
    apply_rotation: bool,
    color_matrix: [[f32; 3]; 3],
    // Per-format black pedestal (Olympus 256, CR2/DNG from file). Applied in
    // every render() so live slider edits subtract the same black as the initial
    // decode — otherwise edits revert to the black=0 magenta cast.
    black: u16,
}

#[wasm_bindgen]
impl LookRenderer {
    /// Construct from a packed u16-LE buffer (6 bytes per pixel, as returned by
    /// `take_rgb16_lb` / `take_rgb16_thumb`), dims, EXIF orientation, and a
    /// 9-element row-major colour matrix.  Pass a slice of length != 9 to use
    /// the built-in `CAM_TO_SRGB` fallback.
    #[wasm_bindgen(constructor)]
    pub fn new(
        rgb16_bytes: &[u8],
        width: u32,
        height: u32,
        orientation: u16,
        color_matrix_flat: &[f32],
    ) -> Result<LookRenderer, JsError> {
        // Legacy 5-arg constructor (used by the perf benchmark): black=0. The
        // colour-correct app path uses new_with_options with the per-format black.
        Self::new_with_options(rgb16_bytes, width, height, orientation, color_matrix_flat, true, 0)
    }

    /// Variant of `new` that lets the caller opt out of CPU rotation in
    /// `render()`. When `apply_rotation` is `false`, `render()` returns
    /// sensor-orientation RGB8 (same dims as `rgb16` source) and the JS side
    /// must apply the EXIF rotation at display time (canvas/CSS transform).
    /// Saves a full-buffer transpose per slider tick for non-identity orientations.
    pub fn new_with_options(
        rgb16_bytes: &[u8],
        width: u32,
        height: u32,
        orientation: u16,
        color_matrix_flat: &[f32],
        apply_rotation: bool,
        black: u16,
    ) -> Result<LookRenderer, JsError> {
        let w = width as usize;
        let h = height as usize;
        let expected = w
            .checked_mul(h)
            .and_then(|px| px.checked_mul(6))
            .ok_or_else(|| JsError::new("LookRenderer: dimensions overflow"))?;
        if rgb16_bytes.len() != expected {
            return Err(JsError::new(&format!(
                "LookRenderer: bytes {} != {}×{}×6",
                rgb16_bytes.len(),
                w,
                h
            )));
        }
        let color_matrix = if color_matrix_flat.len() == 9 {
            [
                [
                    color_matrix_flat[0],
                    color_matrix_flat[1],
                    color_matrix_flat[2],
                ],
                [
                    color_matrix_flat[3],
                    color_matrix_flat[4],
                    color_matrix_flat[5],
                ],
                [
                    color_matrix_flat[6],
                    color_matrix_flat[7],
                    color_matrix_flat[8],
                ],
            ]
        } else {
            pipeline::CAM_TO_SRGB
        };
        let rgb16 = unpack_rgb16_le(rgb16_bytes);
        Ok(Self {
            rgb16,
            width: w,
            height: h,
            orientation,
            apply_rotation,
            color_matrix,
            black,
        })
    }

    /// EXIF orientation tag (1..8) stored at construction. Consumers using
    /// `apply_rotation=false` read this to drive display-time rotation.
    #[wasm_bindgen(getter)]
    pub fn orientation(&self) -> u16 {
        self.orientation
    }

    /// Source-buffer dimensions (sensor orientation, pre-rotation).
    #[wasm_bindgen(getter)]
    pub fn native_width(&self) -> u32 {
        self.width as u32
    }

    #[wasm_bindgen(getter)]
    pub fn native_height(&self) -> u32 {
        self.height as u32
    }

    /// Apply look parameters and return an RGB8 buffer (post-orientation).
    /// Only the output RGB8 crosses the WASM boundary on each call.
    #[allow(clippy::too_many_arguments)]
    pub fn render(
        &self,
        wb_r: f32,
        wb_b: f32,
        exposure_ev: f32,
        contrast: f32,
        highlights: f32,
        shadows: f32,
        whites: f32,
        blacks: f32,
        saturation: f32,
        vibrance: f32,
        temp: f32,
        tint: f32,
        texture: f32,
        clarity: f32,
    ) -> Result<Vec<u8>, JsError> {
        let mut params = pipeline::PipelineParams::default_olympus();
        // Subtract the same per-format black the initial decode used, else live
        // edits revert to the black=0 magenta cast (Olympus) / wrong shadows.
        params.black = self.black;
        if wb_r.is_finite() && wb_r > 0.0 {
            params.wb_r = wb_r;
        }
        if wb_b.is_finite() && wb_b > 0.0 {
            params.wb_b = wb_b;
        }
        params.color_matrix = Some(self.color_matrix);
        raw_pipeline::pipeline::apply_look_params(
            &mut params,
            exposure_ev,
            contrast,
            highlights,
            shadows,
            whites,
            blacks,
            saturation,
            vibrance,
            temp,
            tint,
            texture,
            clarity,
        );

        // SIMD-fused tone path (process_auto → process_into_simd). ≤1-LUT-step vs the byte-exact
        // scalar `process`; same tolerance the heavy RAW decode already ships, invisible for display.
        let rgb8 = if params.texture != 0.0 || params.clarity != 0.0 {
            // M8: reuse thread-local scratch instead of Vec::clone (~6.5 MB on every slider drag).
            RENDER_SCRATCH.with(|cell| {
                let mut scratch = cell.borrow_mut();
                scratch.resize(self.rgb16.len(), 0);
                scratch.copy_from_slice(&self.rgb16);
                pipeline::apply_unsharp_masks(&mut scratch, self.width, self.height, &params);
                pipeline::process_auto(&scratch, &params)
            })
        } else {
            pipeline::process_auto(&self.rgb16, &params)
        };

        if !self.apply_rotation || self.orientation == 1 {
            Ok(rgb8)
        } else {
            let (final_rgb, _, _) =
                pipeline::apply_orientation(rgb8, self.width, self.height, self.orientation);
            Ok(final_rgb)
        }
    }
}

/// EXIF metadata extracted without demosaic/tonemap.  Use for gallery thumbnails,
/// batch preflight, and sort-by-date/lens/GPS without a full decode.
#[wasm_bindgen]
pub struct OrfMetadata {
    make: String,
    model: String,
    lens: String,
    datetime: String,
    #[wasm_bindgen(readonly)]
    pub width: u32,
    #[wasm_bindgen(readonly)]
    pub height: u32,
    #[wasm_bindgen(readonly)]
    pub orientation: u16,
    #[wasm_bindgen(readonly)]
    pub iso: u32,
    #[wasm_bindgen(readonly)]
    pub has_gps: bool,
    #[wasm_bindgen(readonly)]
    pub gps_lat: f64,
    #[wasm_bindgen(readonly)]
    pub gps_lon: f64,
}

#[wasm_bindgen]
impl OrfMetadata {
    #[wasm_bindgen(getter)]
    pub fn make(&self) -> String {
        self.make.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn model(&self) -> String {
        self.model.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn lens(&self) -> String {
        self.lens.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn datetime(&self) -> String {
        self.datetime.clone()
    }
}

/// Parse ORF EXIF metadata only — no decompress, no demosaic, no tonemap.
/// Returns camera, lens, exposure, GPS for batch ingest and gallery views.
#[wasm_bindgen]
pub fn parse_orf_metadata(data: &[u8]) -> Result<OrfMetadata, JsError> {
    let info = tiff::parse(data).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(OrfMetadata {
        make: info.make,
        model: info.model,
        lens: info.lens,
        datetime: info.datetime,
        width: info.width,
        height: info.height,
        orientation: info.orientation,
        iso: info.iso.unwrap_or(0),
        has_gps: info.gps_lat.is_some() && info.gps_lon.is_some(),
        gps_lat: info.gps_lat.unwrap_or(0.0),
        gps_lon: info.gps_lon.unwrap_or(0.0),
    })
}

/// Timing results for the decompress + demosaic stages only.
/// Skips tonemap, downscale, and orientation — isolates raw decode cost.
#[wasm_bindgen]
pub struct DecodeBench {
    #[wasm_bindgen(readonly)]
    pub decompress_ms: f64,
    #[wasm_bindgen(readonly)]
    pub demosaic_ms: f64,
    #[wasm_bindgen(readonly)]
    pub width: u32,
    #[wasm_bindgen(readonly)]
    pub height: u32,
}

/// Benchmark ORF decompress + demosaic without tonemap/downscale/orientation.
/// Use to measure decoder cost in isolation when tuning WASM flags or algorithms.
#[wasm_bindgen]
pub fn bench_decode_orf(data: &[u8]) -> Result<DecodeBench, JsError> {
    let info = tiff::parse(data).map_err(|e| JsError::new(&e.to_string()))?;
    validate_orf_structure(data, &info)?;
    let w = info.width as usize;
    let h = info.height as usize;
    let strip_end = info.strip_offset as usize + info.strip_byte_count as usize;
    let strip = &data[info.strip_offset as usize..strip_end];
    let t = now_ms();
    let raw = decompress::decompress(strip, w, h).map_err(|e| JsError::new(&e))?;
    let decompress_ms = now_ms() - t;
    let t = now_ms();
    let _rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).map_err(|e| JsError::new(&e))?;
    let demosaic_ms = now_ms() - t;
    Ok(DecodeBench {
        decompress_ms,
        demosaic_ms,
        width: info.width,
        height: info.height,
    })
}

struct DngDecoded {
    rgb16: Vec<u16>,
    aw: usize,
    ah: usize,
    params: pipeline::PipelineParams,
    color_matrix_flat: [f32; 9],
    decode_ms: f64,
    demosaic_ms: f64,
    orientation: u16,
    make: String,
    model: String,
    iso: u32,
}

/// Shared DNG decode path: decode bytes → validate → align CFA → demosaic → NR → WB/params setup.
/// Returns pre-tonemapped RGB16 and all metadata.  Called by process_dng_impl.
fn decode_dng_raw(data: &[u8]) -> Result<DngDecoded, JsError> {
    const MAX_DIM: u32 = 8192;
    const MAX_PIXELS: usize = 50_000_000;

    let t = now_ms();
    let img = raw_pipeline::dng::decode_bytes(data)
        .map_err(|e| JsError::new(&format!("DNG decode: {}", e)))?;
    let decode_ms = now_ms() - t;

    let w = img.width;
    let h = img.height;
    if w == 0 || h == 0 {
        return Err(JsError::new("DNG: zero image dimension"));
    }
    if (w as u32) > MAX_DIM || (h as u32) > MAX_DIM {
        return Err(JsError::new(&format!(
            "DNG: dimension {}×{} exceeds maximum {}",
            w, h, MAX_DIM
        )));
    }
    if w.checked_mul(h).unwrap_or(MAX_PIXELS + 1) > MAX_PIXELS {
        return Err(JsError::new(&format!(
            "DNG: {} pixels exceeds 50 MP limit",
            w * h
        )));
    }

    let t = now_ms();
    let phase = match img.cfa {
        raw_pipeline::dng::Cfa::Rggb => (0, 0),
        raw_pipeline::dng::Cfa::Grbg => (0, 1),
        raw_pipeline::dng::Cfa::Gbrg => (1, 0),
        raw_pipeline::dng::Cfa::Bggr => (1, 1),
    };
    let mut rgb16 = demosaic::demosaic_bayer_mhc(&img.raw, w, h, phase)
        .map_err(|e| JsError::new(&format!("DNG demosaic: {}", e)))?;
    let demosaic_ms = now_ms() - t;
    let aw = w;
    let ah = h;

    // Build pipeline params from DNG metadata (full-mosaic path)
    let mut params = pipeline::PipelineParams::default_olympus();
    params.black = img.black;
    params.white = img.white;
    params.wb_r = img.wb_r;
    params.wb_b = img.wb_b;
    params.color_matrix = img.color_matrix;
    let color_matrix_flat: [f32; 9] = {
        let m = params.color_matrix.unwrap_or(pipeline::CAM_TO_SRGB);
        [
            m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2],
        ]
    };

    // Use ISO from DNG metadata for NR strength; fall back to 100 if absent.
    let iso = img.iso.unwrap_or(100);
    let nr_strength = match iso {
        iso if iso >= 6400 => 0.50f32,
        iso if iso >= 3200 => 0.35,
        iso if iso >= 1600 => 0.20,
        _ => 0.0,
    };
    if nr_strength > 0.0 {
        pipeline::apply_luminance_nr(&mut rgb16, aw, ah, nr_strength);
    }

    Ok(DngDecoded {
        rgb16,
        aw,
        ah,
        params,
        color_matrix_flat,
        decode_ms,
        demosaic_ms,
          orientation: img.orientation,
          make: img.make,
          model: img.model,
        iso,
    })
}

/// Shared DNG output stage: conditionally compute lb, thumb, and full RGB8 from
/// pre-decoded DNG data according to `output_flags`.  Absent outputs have empty
/// buffers and zero dims in the returned `ProcessResult`.
fn process_dng_impl(
    decoded: DngDecoded,
    output_flags: u32,
    look: &LookOverrides,
) -> Result<ProcessResult, JsError> {
    let DngDecoded {
        mut rgb16,
        aw,
        ah,
        mut params,
        color_matrix_flat,
        decode_ms,
        demosaic_ms,
        orientation,
        make,
        model,
        iso,
    } = decoded;

    // M3 full-res 16-bit (DNG/CR2 path). A-5: capture after tone (move, no copy) and pack
    // lazily in take_rgb16_full instead of a second full-res buffer here. Byte-identical.
    let want_full16 = output_flags & OUT_FULL_16 != 0;
    let (out_full16_w, out_full16_h) = if want_full16 {
        (aw as u32, ah as u32)
    } else {
        (0, 0)
    };

    // Compute lightbox + thumb caches (pre-tonemap, pre-orientation)
    let (lb_w, lb_h) = target_dims(aw, ah, 1800);
    let (rgb16_lb, out_lb_w, out_lb_h) = if output_flags & OUT_LIGHTBOX != 0 {
        let lb = downscale_rgb16_impl(&rgb16, aw, ah, lb_w, lb_h);
        (lb, lb_w, lb_h)
    } else {
        (vec![], 0, 0)
    };

    let (thumb_w, thumb_h) = target_dims(aw, ah, 360);
    let (rgb16_thumb, out_thumb_w, out_thumb_h) = if output_flags & OUT_THUMB != 0 {
        let thumb = if output_flags & OUT_LIGHTBOX != 0 {
            // Same packed optimization as the main path for consistency and speed.
            downscale_packed_rgb16_le(&rgb16_lb, lb_w, lb_h, thumb_w, thumb_h)
        } else {
            downscale_rgb16_impl(&rgb16, aw, ah, thumb_w, thumb_h)
        };
        (thumb, thumb_w, thumb_h)
    } else {
        (vec![], 0, 0)
    };

    // Apply look parameters
    if look.wb_r.is_finite() && look.wb_r > 0.0 {
        params.wb_r = look.wb_r.min(8.0);
    }
    if look.wb_b.is_finite() && look.wb_b > 0.0 {
        params.wb_b = look.wb_b.min(8.0);
    }
    raw_pipeline::pipeline::apply_look_params(
        &mut params,
        look.exposure_ev,
        look.contrast,
        look.highlights,
        look.shadows,
        look.whites,
        look.blacks,
        look.saturation,
        look.vibrance,
        look.temp,
        look.tint,
        look.texture,
        look.clarity,
    );

    let t = now_ms();
    let (final_rgb, final_w, final_h, tonemap_ms, orient_ms, rgb16_full) =
        if output_flags & OUT_FULL_RGB8 != 0 {
            // 16-bit master export is the pre-unsharp image; snapshot only when unsharp
            // would mutate rgb16 (rare). Common path moves rgb16 out for free.
            let will_unsharp = params.texture != 0.0 || params.clarity != 0.0;
            let full16_pre = if want_full16 && will_unsharp {
                Some(rgb16.clone())
            } else {
                None
            };
            if will_unsharp {
                pipeline::apply_unsharp_masks(&mut rgb16, aw, ah, &params);
            }
            // Chapter 1: SIMD bulk tone (DNG + CR2 share this impl). See process_into_auto.
            let rgb8 = pipeline::process_auto(&rgb16, &params);
            let tonemap_ms = now_ms() - t;
            // rgb16's last read is done: move it into the 16-bit master (common, no copy),
            // use the pre-unsharp snapshot, or release it. Freed before orientation either way.
            let rgb16_full = if want_full16 {
                full16_pre.unwrap_or(rgb16)
            } else {
                drop(rgb16);
                Vec::new()
            };
            let t2 = now_ms();
            let skip_orient = (output_flags & OUT_NO_ORIENT) != 0;
            let (fr, fw, fh) = if skip_orient || orientation == 1 {
                (rgb8, aw, ah)
            } else {
                pipeline::apply_orientation(rgb8, aw, ah, orientation)
            };
            (fr, fw, fh, tonemap_ms, now_ms() - t2, rgb16_full)
        } else {
            let rgb16_full = if want_full16 { rgb16 } else { Vec::new() };
            (vec![], 0, 0, 0.0, 0.0, rgb16_full)
        };

    Ok(ProcessResult {
        rgb: final_rgb,
        width: final_w as u32,
        height: final_h as u32,
        orientation,
        decompress_ms: decode_ms,
        demosaic_ms,
        tonemap_ms,
        orient_ms,
        preview_demosaic_ms: 0.0,
        preview_downscale_ms: 0.0,
        fast_preview: false,
        wb_r_used: params.wb_r,
        wb_b_used: params.wb_b,
        black_used: params.black,
        color_matrix_from_mn: params.color_matrix.is_some(),
        make,
        model,
        rgb16_lb,
        lb_w: out_lb_w as u32,
        lb_h: out_lb_h as u32,
        rgb16_thumb,
        thumb_w: out_thumb_w as u32,
        thumb_h: out_thumb_h as u32,
        rgb16_full,
        full16_w: out_full16_w,
        full16_h: out_full16_h,
        color_matrix_flat,
        lens: String::new(),
        datetime: String::new(),
        // den=0 is the absent-sentinel (same as ORF); JS checks den==0 before dividing.
        exposure_num: 0,
        exposure_den: 0,
        fnumber_num: 0,
        fnumber_den: 0,
        iso,
        focal_length_num: 0,
        focal_length_den: 0,
        focal_length_35: 0,
        gps_lat: 0.0,
        gps_lon: 0.0,
        gps_alt: 0.0,
        has_gps: false,
        quality: 0,
        wb_mode: 0xFFFF,
        wb_from_camera: true,
    })
}

/// Parse + decode a DNG file blob. Returns an error string on failure.
/// (Rayon when parallel-wasm feature active.) Look params: LR-style (-1..+1), except
/// exposure_ev in stops.  Pass NaN/≤0 for wb_r_override/wb_b_override to use defaults.
///
/// Always generates full RGB8, 1800 px lightbox RGB16, and 360 px thumbnail RGB16.
/// Use `process_dng_with_flags` to skip unused outputs (e.g. batch JXL encoding
/// only needs full RGB8, not lb/thumb).
#[wasm_bindgen]
pub fn process_dng(
    data: &[u8],
    exposure_ev: f32,
    contrast: f32,
    highlights: f32,
    shadows: f32,
    whites: f32,
    blacks: f32,
    saturation: f32,
    vibrance: f32,
    temp: f32,
    tint: f32,
    wb_r_override: f32,
    wb_b_override: f32,
    texture: f32,
    clarity: f32,
) -> Result<ProcessResult, JsError> {
    let look = LookOverrides {
        wb_r: wb_r_override,
        wb_b: wb_b_override,
        exposure_ev,
        contrast,
        highlights,
        shadows,
        whites,
        blacks,
        saturation,
        vibrance,
        temp,
        tint,
        texture,
        clarity,
    };
    process_dng_impl(
        decode_dng_raw(data)?,
        OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB,
        &look,
    )
}

/// Variant of `process_dng` with explicit output flags to skip unused pipeline stages.
///
/// `output_flags` is a bitmask of:
/// - `1`: full-resolution RGB8 (needed for JXL encoding)
/// - `2`: 1800 px lightbox RGB16 cache (needed to construct a `LookRenderer`)
/// - `4`: 360 px thumbnail RGB16 cache (needed to construct a thumb `LookRenderer`)
///
/// Absent outputs have empty buffers and zero dims in `ProcessResult`.
/// Pass `7` to match the behaviour of `process_dng`.
#[wasm_bindgen]
pub fn process_dng_with_flags(
    data: &[u8],
    output_flags: u32,
    exposure_ev: f32,
    contrast: f32,
    highlights: f32,
    shadows: f32,
    whites: f32,
    blacks: f32,
    saturation: f32,
    vibrance: f32,
    temp: f32,
    tint: f32,
    wb_r_override: f32,
    wb_b_override: f32,
    texture: f32,
    clarity: f32,
) -> Result<ProcessResult, JsError> {
    let look = LookOverrides {
        wb_r: wb_r_override,
        wb_b: wb_b_override,
        exposure_ev,
        contrast,
        highlights,
        shadows,
        whites,
        blacks,
        saturation,
        vibrance,
        temp,
        tint,
        texture,
        clarity,
    };
    process_dng_impl(decode_dng_raw(data)?, output_flags, &look)
}

// ─── CR2 pipeline ─────────────────────────────────────────────────────────────

struct Cr2Decoded {
    rgb16: Vec<u16>,
    aw: usize,
    ah: usize,
    params: pipeline::PipelineParams,
    color_matrix_flat: [f32; 9],
    decode_ms: f64,
    demosaic_ms: f64,
    orientation: u16,
    make: String,
    model: String,
    iso: u32,
}

/// Generic Canon EOS cam-to-sRGB matrix (dcraw/LibRaw coefficients).
/// Used as the fallback when a CR2 file does not embed its own color matrix.
const CANON_CAM_TO_SRGB: [[f32; 3]; 3] = [
    [ 0.4592, 0.3810, 0.1595],
    [ 0.1638, 0.7718, 0.0644],
    [ 0.0388, 0.0791, 0.8824],
];

fn decode_cr2_raw(data: &[u8]) -> Result<Cr2Decoded, JsError> {
    const MAX_DIM: u32 = 8192;
    const MAX_PIXELS: usize = 50_000_000;

    // Time the LJPEG entropy decode specifically (not parse + slice-reassembly + crop)
    // so CR2 decompress_ms is apples-to-apples with the ORF path, whose decompress_ms
    // is also entropy-only. now_ms() is the wasm-safe clock (Instant panics on wasm32).
    let clock = || now_ms();
    let (cr2, cr2_timings) = raw_pipeline::cr2::decode_bytes_with_clock(data, &clock)
        .map_err(|e| JsError::new(&format!("CR2 decode: {}", e)))?;
    let decode_ms = cr2_timings.ljpeg_ms;

    let w = cr2.width;
    let h = cr2.height;
    if w == 0 || h == 0 {
        return Err(JsError::new("CR2: zero image dimension"));
    }
    if (w as u32) > MAX_DIM || (h as u32) > MAX_DIM {
        return Err(JsError::new(&format!(
            "CR2: dimension {}×{} exceeds maximum {}",
            w, h, MAX_DIM
        )));
    }
    if w.checked_mul(h).unwrap_or(MAX_PIXELS + 1) > MAX_PIXELS {
        return Err(JsError::new(&format!(
            "CR2: {} pixels exceeds 50 MP limit",
            w * h
        )));
    }

    // Use the CFA phase carried out of the CR2 decoder.  The center-crop
    // heuristic in cr2.rs may land on a non-RGGB Bayer site (e.g. on
    // _MG_1744-class bodies whose true sensor margins differ from the
    // geometric center).  demosaic_bayer_mhc accepts an explicit phase so
    // the demosaicer assigns R/G/B correctly regardless of crop origin.
    let t = now_ms();
    let mut rgb16 = demosaic::demosaic_bayer_mhc(&cr2.raw, w, h, cr2.cfa_phase)
        .map_err(|e| JsError::new(&format!("CR2 demosaic: {}", e)))?;

    // Guard: detect Bayer phase mismatch by checking green channel sanity.
    // A correctly demosaiced natural image has G roughly between R and B and
    // the green mean > 1/8 of the red mean.  When the crop origin lands on a
    // wrong CFA site (e.g. due to odd left_margin on this body), green
    // collapses to near-zero while R and B stay plausible.  In that case
    // re-try the three remaining Bayer phases and accept the first one that
    // restores G to a sensible fraction of max(R, B).  This fires only on
    // pathological input and does not change output for correctly-phased files.
    {
        let n = rgb16.len() / 3;
        if n > 0 {
            let (mut sum_r, mut sum_g, mut sum_b) = (0u64, 0u64, 0u64);
            // Sample at most 4096 pixels evenly to keep the check O(1) for large images.
            let step = (n / 4096).max(1);
            let mut count = 0u64;
            let mut i = 0;
            while i < n {
                sum_r += rgb16[i * 3    ] as u64;
                sum_g += rgb16[i * 3 + 1] as u64;
                sum_b += rgb16[i * 3 + 2] as u64;
                count += 1;
                i += step;
            }
            let mean_r = (sum_r / count) as u32;
            let mean_g = (sum_g / count) as u32;
            let mean_b = (sum_b / count) as u32;
            let max_rb = mean_r.max(mean_b);
            // Phase error signature: G << max(R,B)/8 while R and B are plausible.
            if max_rb > 0 && mean_g < max_rb / 8 {
                // Try the other three phases; accept the first that brings G into
                // the range [max_rb/4 .. 4*max_rb].
                const ALT_PHASES: [(u8, u8); 4] = [(0, 0), (0, 1), (1, 0), (1, 1)];
                for &phase in &ALT_PHASES {
                    if phase == cr2.cfa_phase { continue; }
                    if let Ok(candidate) = demosaic::demosaic_bayer_mhc(&cr2.raw, w, h, phase) {
                        let (mut sr, mut sg, mut sb) = (0u64, 0u64, 0u64);
                        let mut ci = 0;
                        let mut k = 0u64;
                        while ci < n {
                            sr += candidate[ci * 3    ] as u64;
                            sg += candidate[ci * 3 + 1] as u64;
                            sb += candidate[ci * 3 + 2] as u64;
                            k += 1;
                            ci += step;
                        }
                        let cg = (sg / k) as u32;
                        let crb = ((sr / k) as u32).max((sb / k) as u32);
                        if crb > 0 && cg >= crb / 4 && cg <= crb * 4 {
                            rgb16 = candidate;
                            break;
                        }
                    }
                }
            }
        }
    }
    let demosaic_ms = now_ms() - t;

    let mut params = pipeline::PipelineParams::default_olympus();
    params.black = cr2.black;
    params.white = cr2.white;
    params.wb_r = cr2.wb_r;
    params.wb_b = cr2.wb_b;
    params.color_matrix = cr2.color_matrix;
    let color_matrix_flat: [f32; 9] = {
        let m = params.color_matrix.unwrap_or(CANON_CAM_TO_SRGB);
        [m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2]]
    };

    let iso = cr2.iso.unwrap_or(100);
    let nr_strength = match iso {
        iso if iso >= 6400 => 0.50f32,
        iso if iso >= 3200 => 0.35,
        iso if iso >= 1600 => 0.20,
        _ => 0.0,
    };
    if nr_strength > 0.0 {
        pipeline::apply_luminance_nr(&mut rgb16, w, h, nr_strength);
    }

    Ok(Cr2Decoded {
        rgb16,
        aw: w,
        ah: h,
        params,
        color_matrix_flat,
        decode_ms,
        demosaic_ms,
        orientation: cr2.orientation,
        make: cr2.make,
        model: cr2.model,
        iso,
    })
}

impl From<Cr2Decoded> for DngDecoded {
    fn from(c: Cr2Decoded) -> Self {
        DngDecoded {
            rgb16:              c.rgb16,
            aw:                 c.aw,
            ah:                 c.ah,
            params:             c.params,
            color_matrix_flat:  c.color_matrix_flat,
            decode_ms:          c.decode_ms,
            demosaic_ms:        c.demosaic_ms,
            orientation:        c.orientation,
            make:               c.make,
            model:              c.model,
            iso:                c.iso,
        }
    }
}

fn process_cr2_impl(
    decoded: Cr2Decoded,
    output_flags: u32,
    look: &LookOverrides,
) -> Result<ProcessResult, JsError> {
    process_dng_impl(decoded.into(), output_flags, look)
}

/// Parse + decode a Canon CR2 file blob.
///
/// Always generates full RGB8, 1800 px lightbox RGB16, and 360 px thumbnail RGB16.
/// Use `process_cr2_with_flags` to skip unused outputs.
#[wasm_bindgen]
pub fn process_cr2(
    data: &[u8],
    exposure_ev: f32,
    contrast: f32,
    highlights: f32,
    shadows: f32,
    whites: f32,
    blacks: f32,
    saturation: f32,
    vibrance: f32,
    temp: f32,
    tint: f32,
    wb_r_override: f32,
    wb_b_override: f32,
    texture: f32,
    clarity: f32,
) -> Result<ProcessResult, JsError> {
    let look = LookOverrides {
        wb_r: wb_r_override,
        wb_b: wb_b_override,
        exposure_ev,
        contrast,
        highlights,
        shadows,
        whites,
        blacks,
        saturation,
        vibrance,
        temp,
        tint,
        texture,
        clarity,
    };
    process_cr2_impl(
        decode_cr2_raw(data)?,
        OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB,
        &look,
    )
}

/// Variant of `process_cr2` with explicit output flags.
///
/// `output_flags` bitmask: 1 = full RGB8, 2 = 1800 px lightbox RGB16, 4 = 360 px thumb RGB16, 8 = full RGB16 (M3).
/// Pass `7` for classic; 15 for M3 full16 too.
#[wasm_bindgen]
pub fn process_cr2_with_flags(
    data: &[u8],
    output_flags: u32,
    exposure_ev: f32,
    contrast: f32,
    highlights: f32,
    shadows: f32,
    whites: f32,
    blacks: f32,
    saturation: f32,
    vibrance: f32,
    temp: f32,
    tint: f32,
    wb_r_override: f32,
    wb_b_override: f32,
    texture: f32,
    clarity: f32,
) -> Result<ProcessResult, JsError> {
    let look = LookOverrides {
        wb_r: wb_r_override,
        wb_b: wb_b_override,
        exposure_ev,
        contrast,
        highlights,
        shadows,
        whites,
        blacks,
        saturation,
        vibrance,
        temp,
        tint,
        texture,
        clarity,
    };
    process_cr2_impl(decode_cr2_raw(data)?, output_flags, &look)
}

// ---------------------------------------------------------------------------
// Perceptual metrics (Butteraugli-approx / SSIM / PSNR) — wasm-bindgen binding.
// Precompute the reference once, evaluate many test images against it. The kernel
// lives in raw-pipeline (shared with native/Tauri); here we only expose it.
// ---------------------------------------------------------------------------

use raw_pipeline::perceptual::{Comparer as PerceptualCore, Metrics, Opts};

#[wasm_bindgen]
pub struct PerceptualComparer {
    inner: PerceptualCore,
    scratch: Vec<u8>, // grow-only RGBA staging for the zero-copy path
}

#[wasm_bindgen]
impl PerceptualComparer {
    #[wasm_bindgen(constructor)]
    // CRAWL C-7: take the reference RGBA by value. wasm-bindgen already copies the JS bytes into
    // an owned Vec<u8> at the FFI boundary; taking Vec<u8> (not &[u8]) lets that buffer be MOVED
    // into the Comparer instead of copied a second time via to_vec (a full n*4 = 96 MB @24MP copy).
    pub fn new(ref_rgba: Vec<u8>, width: usize, height: usize) -> PerceptualComparer {
        let expected = width.saturating_mul(height).saturating_mul(4);
        assert!(
            ref_rgba.len() == expected,
            "PerceptualComparer: ref_rgba.len() ({}) != width*height*4 ({}×{}×4={})",
            ref_rgba.len(), width, height, expected,
        );
        let n = width.saturating_mul(height);
        let inner = PerceptualCore::new(ref_rgba, width, height, Opts::default());
        PerceptualComparer { inner, scratch: vec![0u8; n.saturating_mul(4)] }
    }

    /// Copying convenience path: pass RGBA, get {butteraugli, ssim, psnr} as a JS object.
    pub fn all(&mut self, test_rgba: &[u8]) -> JsValue {
        metrics_to_js(&self.inner.all(test_rgba))
    }

    pub fn butteraugli(&mut self, test_rgba: &[u8]) -> f32 {
        self.inner.butteraugli(test_rgba)
    }
    pub fn ssim(&self, test_rgba: &[u8]) -> f32 {
        self.inner.ssim(test_rgba)
    }
    pub fn psnr(&self, test_rgba: &[u8]) -> f32 {
        self.inner.psnr(test_rgba)
    }

    /// Zero-copy: returns a pointer into the wasm heap staging buffer of `len`
    /// bytes. JS writes the test RGBA straight here (no ArrayBuffer copy across
    /// the boundary), then calls `all_at(len)`. Grows the buffer if needed; the
    /// returned pointer is valid until the next `input_ptr` call.
    pub fn input_ptr(&mut self, len: usize) -> *mut u8 {
        if self.scratch.len() < len {
            self.scratch.resize(len, 0);
        }
        self.scratch.as_mut_ptr()
    }

    /// Compute all three metrics over the `len` bytes previously written into the
    /// staging buffer via `input_ptr`.
    pub fn all_at(&mut self, len: usize) -> JsValue {
        // Split the borrow: take the staging buffer out, evaluate, put it back.
        let buf = std::mem::take(&mut self.scratch);
        // Guard against a mismatched/early `len` from JS (e.g. `all_at` called
        // before `input_ptr`, or with a stale length): slicing past the staging
        // buffer would trap the module. Clamp to what is actually allocated.
        let n = len.min(buf.len());
        let m = self.inner.all(&buf[..n]);
        self.scratch = buf;
        metrics_to_js(&m)
    }
}

fn metrics_to_js(m: &Metrics) -> JsValue {
    let o = js_sys::Object::new();
    let _ = js_sys::Reflect::set(&o, &"butteraugli".into(), &JsValue::from_f64(m.butteraugli as f64));
    let _ = js_sys::Reflect::set(&o, &"ssim".into(), &JsValue::from_f64(m.ssim as f64));
    let _ = js_sys::Reflect::set(&o, &"psnr".into(), &JsValue::from_f64(m.psnr as f64));
    o.into()
}

// =====================================================================================
// frame-stats telemetry flip-flop (bench-only; driven by tools/frame-stats-flipflop.mjs)
//
// Diagnosis (JS): analyzeProgressiveFrame is COMPUTE-bound, not bandwidth-bound. ~32% of
// the time is the serial FNV hash dependency chain; the rest is the per-pixel stats math.
// These exports let us A/B, on a wasm-resident RGBA buffer (no per-call copy), the cost of:
//   - exact byte-wise FNV (parity-identical to the shipped JS)        -> fstats_scalar
//   - a de-serialized word-hash + 4-pixel ILP unrolled stats          -> fstats_fast
//   - the wasm-bindgen &[u8] copy overhead vs the resident path       -> fstats_copy
// The buffer is filled by the SAME LCG the JS harness uses, so results are byte-comparable.
// =====================================================================================

thread_local! {
    static FS_BENCH: RefCell<(Vec<u8>, usize, usize)> = const { RefCell::new((Vec::new(), 0, 0)) };
}

const FS_FNV_PRIME: u32 = 0x0100_0193;
const FS_FNV_OFFSET: u32 = 0x811c_9dc5;

/// Fill the resident buffer with the same LCG byte stream the JS harness uses:
///   s = s*1103515245 + 12345 (wrapping u32); byte = s & 0xff
#[wasm_bindgen]
pub fn fstats_prepare(w: usize, h: usize) {
    let len = w * h * 4;
    let mut buf = vec![0u8; len];
    let mut s: u32 = 12345;
    for slot in buf.iter_mut() {
        s = s.wrapping_mul(1103515245).wrapping_add(12345);
        *slot = (s & 0xff) as u8;
    }
    FS_BENCH.with(|b| *b.borrow_mut() = (buf, w, h));
}

struct FsRaw {
    a_min: u32,
    a_max: u32,
    a_zero: u32,
    rgb_nz: u32,
    l_sum: f64,
    l_sq: f64,
    hash: u32,
}

fn fs_to_js(r: &FsRaw, px: usize) -> JsValue {
    let a_min = if px == 0 { 0 } else { r.a_min };
    let mean = if px > 0 { r.l_sum / px as f64 } else { 0.0 };
    let var = if px > 0 {
        // Normalize by 65025.0 (max luma = 54×255 + 183×255 + 18×255 = 255×255).
        // Matches the native FrameStats::luma_variance() in frame_stats.rs.
        ((r.l_sq / px as f64) - mean * mean).max(0.0) / 65025.0
    } else {
        0.0
    };
    let o = js_sys::Object::new();
    let set = |k: &str, v: f64| {
        let _ = js_sys::Reflect::set(&o, &k.into(), &JsValue::from_f64(v));
    };
    set("alphaMin", a_min as f64);
    set("alphaMax", r.a_max as f64);
    set("alphaZeroPct", if px > 0 { (r.a_zero as f64 / px as f64) * 100.0 } else { 0.0 });
    set("rgbNonzeroCount", r.rgb_nz as f64);
    set("lumaVariance", var);
    set("meanLuma", mean / 256.0);
    set("frameHashInt", (r.hash) as f64);
    set("pixelCount", px as f64);
    o.into()
}

/// Exact byte-wise FNV (identical hash + stats to the shipped JS analyzeProgressiveFrame).
fn fs_core_scalar(d: &[u8], px: usize) -> FsRaw {
    let (mut a_min, mut a_max, mut a_zero, mut rgb_nz) = (255u32, 0u32, 0u32, 0u32);
    let (mut l_sum, mut l_sq) = (0f64, 0f64);
    let mut hash = FS_FNV_OFFSET;
    for p in 0..px {
        let i = p * 4;
        let r = d[i] as u32;
        let g = d[i + 1] as u32;
        let b = d[i + 2] as u32;
        let a = d[i + 3] as u32;
        hash ^= r; hash = hash.wrapping_mul(FS_FNV_PRIME);
        hash ^= g; hash = hash.wrapping_mul(FS_FNV_PRIME);
        hash ^= b; hash = hash.wrapping_mul(FS_FNV_PRIME);
        hash ^= a; hash = hash.wrapping_mul(FS_FNV_PRIME);
        rgb_nz += (r != 0) as u32 + (g != 0) as u32 + (b != 0) as u32;
        if a < a_min { a_min = a; }
        if a > a_max { a_max = a; }
        if a == 0 { a_zero += 1; }
        let l = 54 * r + 183 * g + 18 * b;
        let lf = l as f64;
        l_sum += lf;
        l_sq += lf * lf;
    }
    FsRaw { a_min, a_max, a_zero, rgb_nz, l_sum, l_sq, hash }
}

/// De-serialized word-hash + 4-pixel-unrolled stats. The hash mixes the whole 32-bit
/// pixel word with 4 independent lanes (ILP), breaking FNV's serial dependency chain.
/// Hash identity differs from byte-FNV (migration-allowed); all other stats are identical.
fn fs_core_fast(d: &[u8], px: usize) -> FsRaw {
    let (mut a_min, mut a_max, mut a_zero, mut rgb_nz) = (255u32, 0u32, 0u32, 0u32);
    let (mut l_sum, mut l_sq) = (0f64, 0f64);
    let mut h0 = FS_FNV_OFFSET;
    let mut h1 = FS_FNV_OFFSET ^ 0x9e37_79b9;
    let mut h2 = FS_FNV_OFFSET ^ 0x85eb_ca6b;
    let mut h3 = FS_FNV_OFFSET ^ 0xc2b2_ae35;
    let chunks = px / 4;
    for c in 0..chunks {
        let i = c * 16;
        let w0 = u32::from_le_bytes([d[i], d[i + 1], d[i + 2], d[i + 3]]);
        let w1 = u32::from_le_bytes([d[i + 4], d[i + 5], d[i + 6], d[i + 7]]);
        let w2 = u32::from_le_bytes([d[i + 8], d[i + 9], d[i + 10], d[i + 11]]);
        let w3 = u32::from_le_bytes([d[i + 12], d[i + 13], d[i + 14], d[i + 15]]);
        h0 = (h0 ^ w0).wrapping_mul(FS_FNV_PRIME);
        h1 = (h1 ^ w1).wrapping_mul(FS_FNV_PRIME);
        h2 = (h2 ^ w2).wrapping_mul(FS_FNV_PRIME);
        h3 = (h3 ^ w3).wrapping_mul(FS_FNV_PRIME);
        for &w in &[w0, w1, w2, w3] {
            let r = w & 0xff;
            let g = (w >> 8) & 0xff;
            let b = (w >> 16) & 0xff;
            let a = w >> 24;
            rgb_nz += (r != 0) as u32 + (g != 0) as u32 + (b != 0) as u32;
            if a < a_min { a_min = a; }
            if a > a_max { a_max = a; }
            if a == 0 { a_zero += 1; }
            let l = 54 * r + 183 * g + 18 * b;
            let lf = l as f64;
            l_sum += lf;
            l_sq += lf * lf;
        }
    }
    // tail
    for p in (chunks * 4)..px {
        let i = p * 4;
        let r = d[i] as u32;
        let g = d[i + 1] as u32;
        let b = d[i + 2] as u32;
        let a = d[i + 3] as u32;
        rgb_nz += (r != 0) as u32 + (g != 0) as u32 + (b != 0) as u32;
        if a < a_min { a_min = a; }
        if a > a_max { a_max = a; }
        if a == 0 { a_zero += 1; }
        let l = 54 * r + 183 * g + 18 * b;
        let lf = l as f64;
        l_sum += lf;
        l_sq += lf * lf;
    }
    let hash = (h0 ^ h1).wrapping_mul(FS_FNV_PRIME) ^ (h2 ^ h3).wrapping_mul(FS_FNV_PRIME);
    FsRaw { a_min, a_max, a_zero, rgb_nz, l_sum, l_sq, hash }
}

/// Scan the resident buffer with the exact byte-FNV kernel (no per-call copy).
#[wasm_bindgen]
pub fn fstats_scalar() -> JsValue {
    FS_BENCH.with(|b| {
        let g = b.borrow();
        let px = g.1 * g.2;
        fs_to_js(&fs_core_scalar(&g.0, px), px)
    })
}

/// Scan the resident buffer with the fast word-hash + ILP kernel (no per-call copy).
#[wasm_bindgen]
pub fn fstats_fast() -> JsValue {
    FS_BENCH.with(|b| {
        let g = b.borrow();
        let px = g.1 * g.2;
        fs_to_js(&fs_core_fast(&g.0, px), px)
    })
}

/// Exact byte-FNV kernel over a buffer passed across the boundary (wasm-bindgen copies
/// `pixels` into wasm linear memory on every call). Isolates the copy cost vs resident.
#[wasm_bindgen]
pub fn fstats_copy(pixels: &[u8], width: usize, height: usize) -> JsValue {
    let px = width.saturating_mul(height);
    fs_to_js(&fs_core_scalar(pixels, px), px)
}

/// Hand-written wasm128 v128 kernel. Vectorizes the whole per-pixel reduction across
/// 4 pixels (16 bytes) per load:
///   - alpha min/max: masked u8x16_min/max accumulators (RGB lanes neutralized)
///   - alpha-zero + rgb-nonzero: u8x16_eq(0) -> i8x16_bitmask -> popcount on lane masks
///   - luma 54r+183g+18b: u16x8 widen + i16x8_mul by weight vector + extadd_pairwise -> i32x4
/// Hash uses the de-serialized 4-lane word-hash (identity migration allowed). The luma
/// sum/sq are flushed to f64 per chunk to stay numerically identical to the scalar path.
#[cfg(target_arch = "wasm32")]
fn fs_core_simd(d: &[u8], px: usize) -> FsRaw {
    use core::arch::wasm32::*;
    let (mut a_zero, mut rgb_nz) = (0u32, 0u32);
    let (mut l_sum, mut l_sq) = (0f64, 0f64);
    let mut h0 = FS_FNV_OFFSET;
    let mut h1 = FS_FNV_OFFSET ^ 0x9e37_79b9;
    let mut h2 = FS_FNV_OFFSET ^ 0x85eb_ca6b;
    let mut h3 = FS_FNV_OFFSET ^ 0xc2b2_ae35;

    // RGB lanes -> 0xff so they never lower the running min; alpha lanes stay.
    let rgb_or = u8x16(255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255, 0);
    // Alpha lanes -> kept, RGB lanes -> 0 so they never raise the running max.
    let alpha_and = u8x16(0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255);
    // Per-channel luma weights, one 8-lane half = 2 pixels: [54,183,18,0, 54,183,18,0].
    let wmul = i16x8(54, 183, 18, 0, 54, 183, 18, 0);
    let zero16 = u8x16_splat(0);
    let mut vmin = u8x16_splat(255);
    let mut vmax = u8x16_splat(0);

    let chunks = px / 4;
    for c in 0..chunks {
        let i = c * 16;
        let v = unsafe { v128_load(d.as_ptr().add(i) as *const v128) };

        vmin = u8x16_min(vmin, v128_or(v, rgb_or));
        vmax = u8x16_max(vmax, v128_and(v, alpha_and));

        let zmask = i8x16_bitmask(u8x16_eq(v, zero16)) as u32;
        a_zero += ((zmask >> 3) & 1) + ((zmask >> 7) & 1) + ((zmask >> 11) & 1) + ((zmask >> 15) & 1);
        // RGB lanes mask = 0b0111 repeated; nonzero rgb = 12 - (zero rgb bytes)
        rgb_nz += 12 - (zmask & 0b0111_0111_0111_0111).count_ones();

        // luma: widen bytes -> u16, multiply by weights, pairwise-add to i32 per channel-pair.
        let lo = u16x8_extend_low_u8x16(v); // pixels 0,1: r0 g0 b0 a0 r1 g1 b1 a1
        let hi = u16x8_extend_high_u8x16(v); // pixels 2,3
        // i16x8_mul keeps low 16 bits; 183*255=46665 < 65536 so products are exact.
        let plo = i32x4_extadd_pairwise_u16x8(i16x8_mul(lo, wmul)); // [54r0+183g0, 18b0+0, 54r1+183g1, 18b1+0]
        let phi = i32x4_extadd_pairwise_u16x8(i16x8_mul(hi, wmul));
        // L per pixel = lane0+lane1, lane2+lane3.
        let l0 = i32x4_extract_lane::<0>(plo) + i32x4_extract_lane::<1>(plo);
        let l1 = i32x4_extract_lane::<2>(plo) + i32x4_extract_lane::<3>(plo);
        let l2 = i32x4_extract_lane::<0>(phi) + i32x4_extract_lane::<1>(phi);
        let l3 = i32x4_extract_lane::<2>(phi) + i32x4_extract_lane::<3>(phi);
        let (f0, f1, f2, f3) = (l0 as f64, l1 as f64, l2 as f64, l3 as f64);
        l_sum += f0 + f1 + f2 + f3;
        l_sq += f0 * f0 + f1 * f1 + f2 * f2 + f3 * f3;

        let w0 = u32::from_le_bytes([d[i], d[i + 1], d[i + 2], d[i + 3]]);
        let w1 = u32::from_le_bytes([d[i + 4], d[i + 5], d[i + 6], d[i + 7]]);
        let w2 = u32::from_le_bytes([d[i + 8], d[i + 9], d[i + 10], d[i + 11]]);
        let w3 = u32::from_le_bytes([d[i + 12], d[i + 13], d[i + 14], d[i + 15]]);
        h0 = (h0 ^ w0).wrapping_mul(FS_FNV_PRIME);
        h1 = (h1 ^ w1).wrapping_mul(FS_FNV_PRIME);
        h2 = (h2 ^ w2).wrapping_mul(FS_FNV_PRIME);
        h3 = (h3 ^ w3).wrapping_mul(FS_FNV_PRIME);
    }

    let mut a_min = 255u32;
    let mut a_max = 0u32;
    for &lane in &[
        u8x16_extract_lane::<3>(vmin), u8x16_extract_lane::<7>(vmin),
        u8x16_extract_lane::<11>(vmin), u8x16_extract_lane::<15>(vmin),
    ] {
        if (lane as u32) < a_min { a_min = lane as u32; }
    }
    for &lane in &[
        u8x16_extract_lane::<3>(vmax), u8x16_extract_lane::<7>(vmax),
        u8x16_extract_lane::<11>(vmax), u8x16_extract_lane::<15>(vmax),
    ] {
        if (lane as u32) > a_max { a_max = lane as u32; }
    }

    // tail (px not a multiple of 4): fold remaining pixels into the same 4 lanes by index%4
    // so the hash covers every pixel (content-sensitive) regardless of px alignment.
    let mut lanes = [h0, h1, h2, h3];
    for p in (chunks * 4)..px {
        let i = p * 4;
        let r = d[i] as u32;
        let g = d[i + 1] as u32;
        let b = d[i + 2] as u32;
        let a = d[i + 3] as u32;
        let w = u32::from_le_bytes([d[i], d[i + 1], d[i + 2], d[i + 3]]);
        let lane = p & 3;
        lanes[lane] = (lanes[lane] ^ w).wrapping_mul(FS_FNV_PRIME);
        rgb_nz += (r != 0) as u32 + (g != 0) as u32 + (b != 0) as u32;
        if a < a_min { a_min = a; }
        if a > a_max { a_max = a; }
        if a == 0 { a_zero += 1; }
        let l = 54 * r + 183 * g + 18 * b;
        let lf = l as f64;
        l_sum += lf;
        l_sq += lf * lf;
    }
    if px == 0 { a_min = 255; a_max = 0; }
    let hash = (lanes[0] ^ lanes[1]).wrapping_mul(FS_FNV_PRIME)
        ^ (lanes[2] ^ lanes[3]).wrapping_mul(FS_FNV_PRIME);
    FsRaw { a_min, a_max, a_zero, rgb_nz, l_sum, l_sq, hash }
}

#[cfg(not(target_arch = "wasm32"))]
fn fs_core_simd(d: &[u8], px: usize) -> FsRaw {
    fs_core_word_scalar(d, px)
}

/// Scan the resident buffer with the hand-written v128 kernel (no per-call copy).
#[wasm_bindgen]
pub fn fstats_simd() -> JsValue {
    FS_BENCH.with(|b| {
        let g = b.borrow();
        let px = g.1 * g.2;
        fs_to_js(&fs_core_simd(&g.0, px), px)
    })
}

// -------------------------------------------------------------------------------------
// PRODUCTION kernel: hand-v128 SIMD stats + EXACT byte-wise FNV hash.
// This is the kernel wired into web/jxl-progressive-frame-stats.js (via the worker). It
// keeps frameHash bit-identical to the shipped JS (no dedup/export/test migration) while
// vectorizing the per-pixel stats. The full-buffer fast path is SIMD; a truncated buffer
// falls back to the zero-filling scalar path (identical semantics to the JS kernel).
// -------------------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
fn fs_core_simd_exact(d: &[u8], px: usize) -> FsRaw {
    use core::arch::wasm32::*;
    let (mut a_zero, mut rgb_nz) = (0u32, 0u32);
    let (mut l_sum, mut l_sq) = (0f64, 0f64);
    let mut hash = FS_FNV_OFFSET;

    let rgb_or = u8x16(255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255, 0);
    let alpha_and = u8x16(0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255);
    let wmul = i16x8(54, 183, 18, 0, 54, 183, 18, 0);
    let zero16 = u8x16_splat(0);
    let mut vmin = u8x16_splat(255);
    let mut vmax = u8x16_splat(0);

    let chunks = px / 4;
    for c in 0..chunks {
        let i = c * 16;
        let v = unsafe { v128_load(d.as_ptr().add(i) as *const v128) };
        vmin = u8x16_min(vmin, v128_or(v, rgb_or));
        vmax = u8x16_max(vmax, v128_and(v, alpha_and));
        let zmask = i8x16_bitmask(u8x16_eq(v, zero16)) as u32;
        a_zero += ((zmask >> 3) & 1) + ((zmask >> 7) & 1) + ((zmask >> 11) & 1) + ((zmask >> 15) & 1);
        rgb_nz += 12 - (zmask & 0b0111_0111_0111_0111).count_ones();
        let lo = i16x8_extend_low_u8x16(v);
        let hi = i16x8_extend_high_u8x16(v);
        let plo = i32x4_extadd_pairwise_u16x8(i16x8_mul(lo, wmul));
        let phi = i32x4_extadd_pairwise_u16x8(i16x8_mul(hi, wmul));
        let l0 = i32x4_extract_lane::<0>(plo) + i32x4_extract_lane::<1>(plo);
        let l1 = i32x4_extract_lane::<2>(plo) + i32x4_extract_lane::<3>(plo);
        let l2 = i32x4_extract_lane::<0>(phi) + i32x4_extract_lane::<1>(phi);
        let l3 = i32x4_extract_lane::<2>(phi) + i32x4_extract_lane::<3>(phi);
        let (f0, f1, f2, f3) = (l0 as f64, l1 as f64, l2 as f64, l3 as f64);
        l_sum += f0 + f1 + f2 + f3;
        l_sq += f0 * f0 + f1 * f1 + f2 * f2 + f3 * f3;
        // EXACT byte-wise FNV over the 16 chunk bytes, in memory order (== JS r,g,b,a).
        for k in 0..16 {
            hash ^= d[i + k] as u32;
            hash = hash.wrapping_mul(FS_FNV_PRIME);
        }
    }

    let mut a_min = 255u32;
    let mut a_max = 0u32;
    for &lane in &[
        u8x16_extract_lane::<3>(vmin), u8x16_extract_lane::<7>(vmin),
        u8x16_extract_lane::<11>(vmin), u8x16_extract_lane::<15>(vmin),
    ] {
        if (lane as u32) < a_min { a_min = lane as u32; }
    }
    for &lane in &[
        u8x16_extract_lane::<3>(vmax), u8x16_extract_lane::<7>(vmax),
        u8x16_extract_lane::<11>(vmax), u8x16_extract_lane::<15>(vmax),
    ] {
        if (lane as u32) > a_max { a_max = lane as u32; }
    }

    for p in (chunks * 4)..px {
        let i = p * 4;
        let r = d[i] as u32;
        let g = d[i + 1] as u32;
        let b = d[i + 2] as u32;
        let a = d[i + 3] as u32;
        hash ^= r; hash = hash.wrapping_mul(FS_FNV_PRIME);
        hash ^= g; hash = hash.wrapping_mul(FS_FNV_PRIME);
        hash ^= b; hash = hash.wrapping_mul(FS_FNV_PRIME);
        hash ^= a; hash = hash.wrapping_mul(FS_FNV_PRIME);
        rgb_nz += (r != 0) as u32 + (g != 0) as u32 + (b != 0) as u32;
        if a < a_min { a_min = a; }
        if a > a_max { a_max = a; }
        if a == 0 { a_zero += 1; }
        let l = 54 * r + 183 * g + 18 * b;
        let lf = l as f64;
        l_sum += lf;
        l_sq += lf * lf;
    }
    if px == 0 { a_min = 255; a_max = 0; }
    FsRaw { a_min, a_max, a_zero, rgb_nz, l_sum, l_sq, hash }
}

#[cfg(not(target_arch = "wasm32"))]
fn fs_core_simd_exact(d: &[u8], px: usize) -> FsRaw {
    fs_core_scalar(d, px)
}

/// Tail-safe 4-lane word-hash scalar kernel (full buffer). Same hash definition as the
/// hand-v128 path (lanes by pixel index % 4), so the native fallback and the wasm SIMD
/// path agree. Used as the non-wasm `fs_core_simd` fallback.
fn fs_core_word_scalar(d: &[u8], px: usize) -> FsRaw {
    let (mut a_min, mut a_max, mut a_zero, mut rgb_nz) = (255u32, 0u32, 0u32, 0u32);
    let (mut l_sum, mut l_sq) = (0f64, 0f64);
    let mut lanes = [
        FS_FNV_OFFSET,
        FS_FNV_OFFSET ^ 0x9e37_79b9,
        FS_FNV_OFFSET ^ 0x85eb_ca6b,
        FS_FNV_OFFSET ^ 0xc2b2_ae35,
    ];
    for p in 0..px {
        let i = p * 4;
        let r = d[i] as u32;
        let g = d[i + 1] as u32;
        let b = d[i + 2] as u32;
        let a = d[i + 3] as u32;
        let w = u32::from_le_bytes([d[i], d[i + 1], d[i + 2], d[i + 3]]);
        let lane = p & 3;
        lanes[lane] = (lanes[lane] ^ w).wrapping_mul(FS_FNV_PRIME);
        rgb_nz += (r != 0) as u32 + (g != 0) as u32 + (b != 0) as u32;
        if a < a_min { a_min = a; }
        if a > a_max { a_max = a; }
        if a == 0 { a_zero += 1; }
        let l = 54 * r + 183 * g + 18 * b;
        let lf = l as f64;
        l_sum += lf;
        l_sq += lf * lf;
    }
    if px == 0 { a_min = 255; a_max = 0; }
    let hash = (lanes[0] ^ lanes[1]).wrapping_mul(FS_FNV_PRIME)
        ^ (lanes[2] ^ lanes[3]).wrapping_mul(FS_FNV_PRIME);
    FsRaw { a_min, a_max, a_zero, rgb_nz, l_sum, l_sq, hash }
}

/// Truncation-safe word-hash kernel: zero-fills bytes past `limit`. Matches the JS
/// truncated semantics for the stats; hash uses the 4-lane word-hash.
fn fs_core_trunc_word(d: &[u8], px: usize, limit: usize) -> FsRaw {
    let (mut a_min, mut a_max, mut a_zero, mut rgb_nz) = (255u32, 0u32, 0u32, 0u32);
    let (mut l_sum, mut l_sq) = (0f64, 0f64);
    let mut lanes = [
        FS_FNV_OFFSET,
        FS_FNV_OFFSET ^ 0x9e37_79b9,
        FS_FNV_OFFSET ^ 0x85eb_ca6b,
        FS_FNV_OFFSET ^ 0xc2b2_ae35,
    ];
    for p in 0..px {
        let i = p * 4;
        let r = if i < limit { d[i] as u32 } else { 0 };
        let g = if i + 1 < limit { d[i + 1] as u32 } else { 0 };
        let b = if i + 2 < limit { d[i + 2] as u32 } else { 0 };
        let a = if i + 3 < limit { d[i + 3] as u32 } else { 0 };
        let w = r | (g << 8) | (b << 16) | (a << 24);
        let lane = p & 3;
        lanes[lane] = (lanes[lane] ^ w).wrapping_mul(FS_FNV_PRIME);
        rgb_nz += (r != 0) as u32 + (g != 0) as u32 + (b != 0) as u32;
        if a < a_min { a_min = a; }
        if a > a_max { a_max = a; }
        if a == 0 { a_zero += 1; }
        let l = 54 * r + 183 * g + 18 * b;
        let lf = l as f64;
        l_sum += lf;
        l_sq += lf * lf;
    }
    if px == 0 { a_min = 255; a_max = 0; }
    let hash = (lanes[0] ^ lanes[1]).wrapping_mul(FS_FNV_PRIME)
        ^ (lanes[2] ^ lanes[3]).wrapping_mul(FS_FNV_PRIME);
    FsRaw { a_min, a_max, a_zero, rgb_nz, l_sum, l_sq, hash }
}

/// Truncation-safe exact kernel: zero-fills bytes past `limit` (identical to the JS
/// truncated path). Used when the supplied buffer is shorter than width*height*4.
fn fs_core_trunc_exact(d: &[u8], px: usize, limit: usize) -> FsRaw {
    let (mut a_min, mut a_max, mut a_zero, mut rgb_nz) = (255u32, 0u32, 0u32, 0u32);
    let (mut l_sum, mut l_sq) = (0f64, 0f64);
    let mut hash = FS_FNV_OFFSET;
    for p in 0..px {
        let i = p * 4;
        let r = if i < limit { d[i] as u32 } else { 0 };
        let g = if i + 1 < limit { d[i + 1] as u32 } else { 0 };
        let b = if i + 2 < limit { d[i + 2] as u32 } else { 0 };
        let a = if i + 3 < limit { d[i + 3] as u32 } else { 0 };
        hash ^= r; hash = hash.wrapping_mul(FS_FNV_PRIME);
        hash ^= g; hash = hash.wrapping_mul(FS_FNV_PRIME);
        hash ^= b; hash = hash.wrapping_mul(FS_FNV_PRIME);
        hash ^= a; hash = hash.wrapping_mul(FS_FNV_PRIME);
        rgb_nz += (r != 0) as u32 + (g != 0) as u32 + (b != 0) as u32;
        if a < a_min { a_min = a; }
        if a > a_max { a_max = a; }
        if a == 0 { a_zero += 1; }
        let l = 54 * r + 183 * g + 18 * b;
        let lf = l as f64;
        l_sum += lf;
        l_sq += lf * lf;
    }
    if px == 0 { a_min = 255; a_max = 0; }
    FsRaw { a_min, a_max, a_zero, rgb_nz, l_sum, l_sq, hash }
}

/// PRODUCTION export. Returns the same numeric fields the JS analyzeProgressiveFrame
/// produces (the JS wrapper adds the hex frameHash, byteLength, truncated, validPixels).
/// frameHashInt is the exact FNV-1a value — bit-identical to the shipped JS hash.
///
/// Uses the hand-v128 word-hash kernel (~4.7x over JS). An audit of every frameHash
/// consumer (web/jxl-single-progressive.js, jxl-progressive-paint.js; nothing in packages/
/// or the cache) confirmed the hash never escapes a single run — it drives only within-run
/// pass-dedup, unique-frame counts, per-session cache keys, and current-run exports, and is
/// always a hex string. So the algorithm is free to change; the 4-lane word-hash is stable
/// and content-sensitive (tail pixels included), which is all those consumers require.
/// frameHashInt therefore differs from the JS FNV value (by design, post-audit).
#[wasm_bindgen]
pub fn frame_stats(pixels: &[u8], width: usize, height: usize) -> JsValue {
    let px = width.saturating_mul(height);
    let expected = px.saturating_mul(4);
    let limit = pixels.len().min(expected);
    let raw = if limit == expected {
        fs_core_simd(pixels, px)
    } else {
        fs_core_trunc_word(pixels, px, limit)
    };
    fs_to_js(&raw, px)
}

/// Bench probe for the production exact-hash SIMD kernel (resident buffer, no copy).
#[wasm_bindgen]
pub fn fstats_simd_exact() -> JsValue {
    FS_BENCH.with(|b| {
        let g = b.borrow();
        let px = g.1 * g.2;
        fs_to_js(&fs_core_simd_exact(&g.0, px), px)
    })
}

// ─── Multi-format image ingestion (TIFF / EXR) ───────────────────────────────
// Browser-only non-RAW decoders. SDR formats (png/jpg/gif/webp/avif) decode
// browser-native via createImageBitmap; these two cover the high-bit path.

/// Decoded non-RAW image handed to JS. One of the take_* buffers is non-empty,
/// selected by `bit_depth` (8 -> take_rgba8, 16 -> take_rgba16_le, 32 -> take_rgba_f32).
#[wasm_bindgen]
pub struct DecodedImage {
    width: u32,
    height: u32,
    bit_depth: u8,
    u8buf: Vec<u8>,
    u16buf: Vec<u16>,
    f32buf: Vec<f32>,
}

#[wasm_bindgen]
impl DecodedImage {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }
    #[wasm_bindgen(getter)]
    pub fn bit_depth(&self) -> u8 {
        self.bit_depth
    }

    /// RGBA8 (bit_depth == 8). Empty otherwise.
    pub fn take_rgba8(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.u8buf)
    }
    /// RGBA16 packed little-endian, 8 bytes/px (bit_depth == 16). Empty otherwise.
    pub fn take_rgba16_le(&mut self) -> Vec<u8> {
        let v = std::mem::take(&mut self.u16buf);
        let mut out = Vec::with_capacity(v.len() * 2);
        for s in v {
            out.extend_from_slice(&s.to_le_bytes());
        }
        out
    }
    /// RGBA f32 (bit_depth == 32). Returned as Float32Array. Empty otherwise.
    pub fn take_rgba_f32(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.f32buf)
    }
    /// Display-ready RGBA8 regardless of source depth (f32 -> linear->sRGB).
    pub fn to_display_rgba8(&self) -> Vec<u8> {
        match self.bit_depth {
            32 => raw_pipeline::image_formats::f32_linear_to_srgb8(&self.f32buf),
            16 => self.u16buf.iter().map(|&s| (s >> 8) as u8).collect(),
            _ => self.u8buf.clone(),
        }
    }
}

fn decoded_to_wasm(d: raw_pipeline::image_formats::DecodedRgba) -> DecodedImage {
    DecodedImage {
        width: d.width,
        height: d.height,
        bit_depth: d.bit_depth,
        u8buf: d.u8,
        u16buf: d.u16,
        f32buf: d.f32,
    }
}

/// Decode a general RGB(A) TIFF (u8 or u16) to RGBA.
#[wasm_bindgen]
pub fn decode_tiff(bytes: &[u8]) -> Result<DecodedImage, JsValue> {
    raw_pipeline::image_formats::decode_tiff_bytes(bytes)
        .map(decoded_to_wasm)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Decode an OpenEXR image to RGBA f32 (linear HDR preserved).
#[wasm_bindgen]
pub fn decode_exr(bytes: &[u8]) -> Result<DecodedImage, JsValue> {
    raw_pipeline::image_formats::decode_exr_bytes(bytes)
        .map(decoded_to_wasm)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
