//! Design-validation probe: what ORDER does libjxl's chunked encoder PULL input rects?
//! The streaming-export design assumes a forward-only sliding window (ypos monotonic
//! non-decreasing) so the fused decode→demosaic→tone can produce bands just-in-time and
//! discard them. If pulls are random / go backward, the window must retain more (or the
//! whole frame), which changes the architecture. This records every
//! get_color_channel_data_at(xpos,ypos,xsize,ysize) and reports the order stats.
//!
//!   cargo run --release --no-default-features --features jxl-codec \
//!     --example jxl_chunked_pull_order -- [source.jxl] [effort]

use jxl_ffi as ffi;
use raw_pipeline::jxl_casadecoder::decode_interleaved;
use std::os::raw::c_void;
use std::ptr;

struct Src {
    data: *const u8,
    stride: usize,
    rects: *mut Vec<[usize; 4]>,
}
struct Out {
    buf: Vec<u8>,
    pos: usize,
    high: usize,
}

unsafe extern "C" fn color_pf(_op: *mut c_void, pf: *mut ffi::JxlPixelFormat) {
    (*pf).num_channels = 3;
    (*pf).data_type = ffi::JxlDataType::JXL_TYPE_UINT8;
    (*pf).endianness = ffi::JxlEndianness::JXL_NATIVE_ENDIAN;
    (*pf).align = 0;
}
unsafe extern "C" fn color_at(
    op: *mut c_void,
    xpos: usize,
    ypos: usize,
    xs: usize,
    ys: usize,
    row_offset: *mut usize,
) -> *const c_void {
    let s = &*(op as *const Src);
    (*s.rects).push([xpos, ypos, xs, ys]);
    *row_offset = s.stride;
    s.data.add(ypos * s.stride + xpos * 3) as *const c_void
}
unsafe extern "C" fn src_release(_op: *mut c_void, _b: *const c_void) {}
unsafe extern "C" fn out_get(op: *mut c_void, size: *mut usize) -> *mut c_void {
    let o = &mut *(op as *mut Out);
    let want = (*size).max(1 << 16);
    if o.buf.len() < o.pos + want {
        o.buf.resize(o.pos + want, 0);
    }
    *size = o.buf.len() - o.pos;
    o.buf.as_mut_ptr().add(o.pos) as *mut c_void
}
unsafe extern "C" fn out_release(op: *mut c_void, w: usize) {
    let o = &mut *(op as *mut Out);
    o.pos += w;
    if o.pos > o.high {
        o.high = o.pos;
    }
}
unsafe extern "C" fn out_seek(op: *mut c_void, p: u64) {
    (*(op as *mut Out)).pos = p as usize;
}
unsafe extern "C" fn out_final(_op: *mut c_void, _p: u64) {}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let src = args.get(1).cloned().unwrap_or_else(|| {
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/Benchmark results/P2200619-prog-p6-q85.jxl"
        )
        .into()
    });
    let effort: i64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(3);
    let jxl = std::fs::read(&src).expect("read");
    let (rgb, w, h) = decode_interleaved::<u8>(&jxl, 3).expect("decode");
    let (w, h) = (w as usize, h as usize);

    let mut rects: Vec<[usize; 4]> = Vec::new();
    unsafe {
        let enc = ffi::JxlEncoderCreate(ptr::null());
        let mut info = std::mem::MaybeUninit::<ffi::JxlBasicInfo>::uninit();
        ffi::JxlEncoderInitBasicInfo(info.as_mut_ptr());
        let mut info = info.assume_init();
        info.xsize = w as u32;
        info.ysize = h as u32;
        info.bits_per_sample = 8;
        info.exponent_bits_per_sample = 0;
        info.num_color_channels = 3;
        info.num_extra_channels = 0;
        info.uses_original_profile = 0;
        ffi::JxlEncoderSetBasicInfo(enc, &info);
        let mut ce = std::mem::MaybeUninit::<ffi::JxlColorEncoding>::uninit();
        ffi::JxlColorEncodingSetToSRGB(ce.as_mut_ptr(), 0);
        let ce = ce.assume_init();
        ffi::JxlEncoderSetColorEncoding(enc, &ce);
        let fs = ffi::JxlEncoderFrameSettingsCreate(enc, ptr::null());
        use ffi::JxlEncoderFrameSettingId as F;
        ffi::JxlEncoderFrameSettingsSetOption(fs, F::JXL_ENC_FRAME_SETTING_EFFORT, effort);
        ffi::JxlEncoderFrameSettingsSetOption(fs, F::JXL_ENC_FRAME_SETTING_BUFFERING, 2);
        ffi::JxlEncoderFrameSettingsSetOption(fs, F::JXL_ENC_FRAME_SETTING_OUTPUT_MODE, 0);
        ffi::JxlEncoderFrameSettingsSetOption(
            fs,
            F::JXL_ENC_FRAME_SETTING_USE_FULL_IMAGE_HEURISTICS,
            0,
        );
        ffi::JxlEncoderSetFrameDistance(fs, 1.0);
        let mut out = Out {
            buf: Vec::new(),
            pos: 0,
            high: 0,
        };
        let op = ffi::JxlEncoderOutputProcessor {
            opaque: &mut out as *mut _ as *mut c_void,
            get_buffer: Some(out_get),
            release_buffer: Some(out_release),
            seek: Some(out_seek),
            set_finalized_position: Some(out_final),
        };
        ffi::JxlEncoderSetOutputProcessor(enc, op);
        let s = Src {
            data: rgb.as_ptr(),
            stride: w * 3,
            rects: &mut rects as *mut _,
        };
        let source = ffi::JxlChunkedFrameInputSource {
            opaque: &s as *const _ as *mut c_void,
            get_color_channels_pixel_format: Some(color_pf),
            get_color_channel_data_at: Some(color_at),
            get_extra_channel_pixel_format: None,
            get_extra_channel_data_at: None,
            release_buffer: Some(src_release),
        };
        let st = ffi::JxlEncoderAddChunkedFrame(fs, 1, source);
        ffi::JxlEncoderDestroy(enc);
        assert_eq!(st, ffi::JxlEncoderStatus::JXL_ENC_SUCCESS, "encode failed");
    }

    // Analyze pull order.
    println!(
        "=== chunked pull order: {w}x{h}, e={effort}, {} rect requests ===",
        rects.len()
    );
    let mut monotonic_y = true;
    let mut max_backward_y = 0usize;
    let mut max_xs = 0usize;
    let mut max_ys = 0usize;
    let mut prev_y = 0usize;
    let mut distinct_y: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
    for (i, r) in rects.iter().enumerate() {
        let [x, y, xs, ys] = *r;
        max_xs = max_xs.max(xs);
        max_ys = max_ys.max(ys);
        distinct_y.insert(y);
        if i > 0 && y < prev_y {
            monotonic_y = false;
            max_backward_y = max_backward_y.max(prev_y - y);
        }
        prev_y = y;
        let _ = x;
    }
    println!("ypos monotonic non-decreasing: {}", monotonic_y);
    println!("max backward y-jump: {} rows", max_backward_y);
    println!("max rect: {} wide x {} tall", max_xs, max_ys);
    println!(
        "distinct ypos values: {} (image is {} rows => ~{} bands)",
        distinct_y.len(),
        h,
        (h + 255) / 256
    );
    println!(
        "first 8 rects (x,y,xs,ys): {:?}",
        &rects[..rects.len().min(8)]
    );
    if rects.len() > 8 {
        println!("last 4 rects: {:?}", &rects[rects.len() - 4..]);
    }
    // window estimate: with monotonic y, the live window = max ys (a band) + halo.
    println!(
        "=> sliding-window feasible: {} ; window rows needed ~ {}",
        monotonic_y,
        if monotonic_y { max_ys } else { h }
    );
}
