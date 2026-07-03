//! Peak-memory: batch vs **streaming** CasaVideo encode. The batch API holds all
//! N raw frames at once; the streaming API pulls one at a time (only prev+cur
//! resident). This proves the streaming path's working set is ~constant in N while
//! the batch path grows with N.
//!
//! Own counting global allocator (this test binary only). It tracks **Rust-side**
//! allocations — where the frame-buffer difference lives; the libjxl C++ super-tile
//! saving from `encode_chunked` is additional and not counted here.
#![cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]

use raw_pipeline::casa_video::{
    encode_casv_video, encode_casv_video_streaming, CasaVideoOptions, SkipMode, VideoFrameSource,
    VideoRate,
};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Counting;
static CUR: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            let c = CUR.fetch_add(l.size(), Ordering::Relaxed) + l.size();
            PEAK.fetch_max(c, Ordering::Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        CUR.fetch_sub(l.size(), Ordering::Relaxed);
        System.dealloc(p, l);
    }
}
#[global_allocator]
static A: Counting = Counting;

/// Static gradient background + a small square that moves each frame (low-motion,
/// so the bbox skip codes only a tiny changed region).
fn gen_frame(width: u32, height: u32, f: usize) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    let mut v = vec![0u8; w * h * 3];
    for y in 0..h {
        for x in 0..w {
            let o = (y * w + x) * 3;
            v[o] = (x & 0xff) as u8;
            v[o + 1] = (y & 0xff) as u8;
            v[o + 2] = ((x + y) & 0xff) as u8;
        }
    }
    let cx = (2 + f) % (w - 6);
    let cy = h / 2;
    for yy in cy..cy + 4 {
        for xx in cx..cx + 4 {
            let o = (yy * w + xx) * 3;
            v[o] = 255;
            v[o + 1] = 0;
            v[o + 2] = 0;
        }
    }
    v
}

/// Generative source — holds no pre-materialized frames (makes each on demand), so
/// the streaming path genuinely never buffers the whole video.
struct GenSource {
    n: usize,
    i: usize,
    w: u32,
    h: u32,
}
impl VideoFrameSource for GenSource {
    fn dims(&self) -> (u32, u32) {
        (self.w, self.h)
    }
    fn fps(&self) -> (u32, u32) {
        (24, 1)
    }
    fn next_frame(&mut self) -> Option<Vec<u8>> {
        if self.i < self.n {
            let f = gen_frame(self.w, self.h, self.i);
            self.i += 1;
            Some(f)
        } else {
            None
        }
    }
}

fn measure(f: impl FnOnce()) -> usize {
    let base = CUR.load(Ordering::Relaxed);
    PEAK.store(base, Ordering::Relaxed);
    f();
    PEAK.load(Ordering::Relaxed).saturating_sub(base)
}

fn batch_peak(n: usize, w: u32, h: u32, opts: &CasaVideoOptions) -> usize {
    measure(|| {
        // The batch API forces all N raw frames to be resident.
        let frames: Vec<Vec<u8>> = (0..n).map(|f| gen_frame(w, h, f)).collect();
        let refs: Vec<&[u8]> = frames.iter().map(|v| v.as_slice()).collect();
        let out = encode_casv_video(&refs, w, h, 24, 1, opts).unwrap();
        std::hint::black_box((&frames, &out));
    })
}

fn stream_peak(n: usize, w: u32, h: u32, opts: &CasaVideoOptions) -> usize {
    measure(|| {
        let mut src = GenSource { n, i: 0, w, h };
        let out = encode_casv_video_streaming(&mut src, opts).unwrap();
        std::hint::black_box(&out);
    })
}

#[test]
fn streaming_peak_is_constant_while_batch_grows() {
    let (w, h) = (256u32, 256u32); // 196 KB/frame — frame buffers dominate overhead
    let opts = CasaVideoOptions {
        rate: VideoRate::Lossy(1.0),
        gop_len: 8,
        skip: SkipMode::Bbox,
        tile: 32,
        effort: 3,
        thresh: Some(2),
        rate_control: None,
    };
    let kb = |b: usize| b / 1024;

    let b8 = batch_peak(8, w, h, &opts);
    let b32 = batch_peak(32, w, h, &opts);
    let s8 = stream_peak(8, w, h, &opts);
    let s32 = stream_peak(32, w, h, &opts);

    eprintln!("frame = {} KB", kb((w * h * 3) as usize));
    eprintln!("batch  peak: N=8 {} KB   N=32 {} KB", kb(b8), kb(b32));
    eprintln!("stream peak: N=8 {} KB   N=32 {} KB", kb(s8), kb(s32));
    let grow = b32 as f64 / b8 as f64;
    let flat = s32 as f64 / s8 as f64;
    let ratio = s32 as f64 / b32 as f64;
    eprintln!("stream/batch @N=32: {:.1}%  (batch grow {grow:.2}x, stream flat {flat:.2}x)", 100.0 * ratio);

    // Batch peak grows with N (holds all raw frames): 4x frames => well over 2.5x.
    assert!(grow > 2.5, "batch peak should grow with N: N=8 {b8} vs N=32 {b32}");
    // Streaming peak stays ~constant (only prev+cur resident).
    assert!(flat < 1.5, "streaming peak should be ~constant in N: N=8 {s8} vs N=32 {s32}");
    // And streaming is far below batch at N=32.
    assert!(ratio < 0.5, "streaming peak ({s32}) should be well under batch ({b32}) at N=32");
}
