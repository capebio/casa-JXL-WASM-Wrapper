//! Phase 3.2 overlap-potential probe (MEASURE-ONLY — does not modify casa_video).
//!
//! The CASV streaming encode loop (`encode_casv_video_streaming_to_progress`) runs,
//! per frame, `src.next_frame_into()` (SOURCE DECODE N) THEN `encode_stream_frame()`
//! (CASV ENCODE N) serially on one thread. Phase 3.2 proposes overlapping
//! decode(N+1) ∥ encode(N). That only wins if the encode leg leaves cores idle.
//!
//! This probe measures, on real data:
//!   A. per-frame SOURCE-DECODE cost (PNG `image::load_from_memory`, and RAW via
//!      `RawVideoSource` = full decompress+demosaic+tone photo pipeline).
//!   B. per-frame streaming ENCODE cost, split I-frame vs P-frame, run at
//!      `CASV_ENC_THREADS=1` vs auto — P-frame time invariant to thread count
//!      confirms P-frame encode is single-threaded (cores idle → overlap headroom);
//!      I-frame time shrinking confirms I-frame encode is MT (cores busy → wash).
//!   C. combines A+B into a realistic serial-vs-overlapped wall-clock estimate for
//!      (a) PNG-source video and (b) RAW timelapse.
//!
//! Run (MSVC, release), from `crates/raw-pipeline`:
//!   ..\..\build-msvc.ps1 run --release --features jxl-codec --example overlap_probe -- <png_dir> <cr2_dir>

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn mean(v: &[f64]) -> f64 {
    if v.is_empty() {
        0.0
    } else {
        v.iter().sum::<f64>() / v.len() as f64
    }
}

/// In-memory frame source over pre-decoded RGB8 frames. `next_frame_into` is a
/// pure memcpy so the streaming per-frame time is ENCODE-dominated (source decode
/// is trivially cheap here — we measure real decode separately in Part A/C).
#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
struct VecSource<'a> {
    frames: &'a [Vec<u8>],
    i: usize,
    w: u32,
    h: u32,
}

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
impl<'a> raw_pipeline::casa_video::VideoFrameSource for VecSource<'a> {
    fn dims(&self) -> (u32, u32) {
        (self.w, self.h)
    }
    fn fps(&self) -> (u32, u32) {
        (24, 1)
    }
    fn next_frame(&mut self) -> Option<Vec<u8>> {
        if self.i < self.frames.len() {
            let f = self.frames[self.i].clone();
            self.i += 1;
            Some(f)
        } else {
            None
        }
    }
    fn next_frame_into(&mut self, buf: &mut Vec<u8>) -> bool {
        if self.i < self.frames.len() {
            buf.clear();
            buf.extend_from_slice(&self.frames[self.i]);
            self.i += 1;
            true
        } else {
            false
        }
    }
}

/// Run the real streaming encoder over pre-decoded `frames`, timestamp each frame
/// via the progress callback, and split per-frame ms into I-frame vs P-frame.
/// Returns (i_mean_ms, p_mean_ms, total_ms, per_frame_ms).
#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn stream_split(
    frames: &[Vec<u8>],
    w: u32,
    h: u32,
    opts: &raw_pipeline::casa_video::CasaVideoOptions,
) -> (f64, f64, f64, Vec<f64>) {
    use raw_pipeline::casa_video::encode_casv_video_streaming_to_progress;
    use std::time::Instant;

    let gop = opts.gop_len.max(1) as usize;
    let mut src = VecSource {
        frames,
        i: 0,
        w,
        h,
    };
    let mut sink: Vec<u8> = Vec::new();
    let mut marks: Vec<Instant> = Vec::new();
    let start = Instant::now();
    {
        let mut on_frame = |_done: usize| marks.push(Instant::now());
        encode_casv_video_streaming_to_progress(&mut src, opts, &mut sink, &mut on_frame)
            .expect("streaming encode");
    }
    let mut per = Vec::with_capacity(marks.len());
    let mut prev = start;
    for m in &marks {
        per.push(m.duration_since(prev).as_secs_f64() * 1000.0);
        prev = *m;
    }
    let mut i_ms = Vec::new();
    let mut p_ms = Vec::new();
    for (idx, &ms) in per.iter().enumerate() {
        if idx % gop == 0 {
            i_ms.push(ms);
        } else {
            p_ms.push(ms);
        }
    }
    let total: f64 = per.iter().sum();
    (mean(&i_ms), mean(&p_ms), total, per)
}

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn main() {
    use raw_pipeline::casa_video::CasaVideoOptions;
    use raw_pipeline::raw_video::{RawVideoLook, RawVideoSource};
    use raw_pipeline::casa_video::VideoFrameSource;
    use std::path::PathBuf;
    use std::time::Instant;

    let png_dir = std::env::args()
        .nth(1)
        .unwrap_or_else(|| r"C:\Foo\raw-converter\tests\real_video_ghana_1080".to_string());
    let cr2_dir = std::env::args()
        .nth(2)
        .unwrap_or_else(|| r"C:\Foo\raw-converter\tests".to_string());

    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    println!("machine: {cores} logical cores\n");

    // ===================== Part A: PNG source decode =====================
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&png_dir)
        .expect("read png dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map_or(false, |x| x == "png"))
        .collect();
    paths.sort();
    assert!(!paths.is_empty(), "no PNG frames in {png_dir}");
    let raw_bytes: Vec<Vec<u8>> = paths.iter().map(|p| std::fs::read(p).unwrap()).collect();

    let mut frames: Vec<Vec<u8>> = Vec::with_capacity(paths.len());
    let (mut w, mut h) = (0u32, 0u32);
    let mut png_ms = Vec::new();
    for b in &raw_bytes {
        let t = Instant::now();
        let img = image::load_from_memory(b).expect("decode png").to_rgb8();
        png_ms.push(t.elapsed().as_secs_f64() * 1000.0);
        w = img.width();
        h = img.height();
        frames.push(img.into_raw());
    }
    let n = frames.len();
    let png_dec = mean(&png_ms);
    println!("== Part A: PNG source decode ({n} frames @ {w}x{h}) ==");
    println!(
        "  per-frame PNG decode: mean {:.1} ms  (min {:.1}, max {:.1})",
        png_dec,
        png_ms.iter().cloned().fold(f64::MAX, f64::min),
        png_ms.iter().cloned().fold(0.0, f64::max)
    );

    // ===================== Part B: streaming encode, I vs P =====================
    // Balanced default (== CasaVideoOptions::streaming(1.0)): lossy d1.0, tile skip,
    // gop 24, effort 3 — the JOLT profile the CASV streaming loop actually ships.
    let opts = CasaVideoOptions::streaming(1.0);
    let gop = opts.gop_len as usize;
    println!("\n== Part B: streaming ENCODE per-frame, I vs P (lossy d1.0/e3 tile, gop {gop}) ==");

    std::env::set_var("CASV_ENC_THREADS", "1");
    let (i1, p1, t1, per1) = stream_split(&frames, w, h, &opts);
    std::env::remove_var("CASV_ENC_THREADS");
    let (ia, pa, ta, _pera) = stream_split(&frames, w, h, &opts);

    let n_i = (n + gop - 1) / gop;
    let n_p = n - n_i;
    println!(
        "  enc_threads=1    : total {:.0} ms | I n={} mean {:.1} ms | P n={} mean {:.1} ms",
        t1, n_i, i1, n_p, p1
    );
    println!(
        "  enc_threads=auto : total {:.0} ms | I n={} mean {:.1} ms | P n={} mean {:.1} ms",
        ta, n_i, ia, n_p, pa
    );
    println!(
        "  I-frame speedup 1->auto: {:.2}x  (MT works)   P-frame ratio 1->auto: {:.2}x  (~1.0 => P is single-threaded, cores idle)",
        i1 / ia.max(1e-9),
        p1 / pa.max(1e-9)
    );
    // first few per-frame (auto) for eyeballing
    print!("  per-frame ms (auto, first 8): ");
    for v in per1.iter().take(8) {
        print!("{:.0} ", v);
    }
    println!();

    // ===================== Part C: overlap estimate (PNG) =====================
    // Serial loop:   T = Σ(dec_i + enc_i)
    // Ideal overlap: decode(N+1) ∥ encode(N). For each ADJACENT pair the wall cost
    // is max(dec, enc) instead of dec+enc — but ONLY when the encode leg (frame N)
    // leaves cores idle. I-frame encode saturates cores => its decode-overlap is a
    // wash (charge dec+enc); P-frame encode is ST => overlap hides min(dec,enc).
    let est_overlap = |dec: f64, enc_i: f64, enc_p: f64, n: usize, gop: usize| -> (f64, f64) {
        // serial: every frame decode + encode
        let n_i = (n + gop - 1) / gop;
        let n_p = n - n_i;
        let serial = n as f64 * dec + n_i as f64 * enc_i + n_p as f64 * enc_p;
        // overlapped: pipeline decode(N+1) with encode(N).
        // P-frame (encode ST, cores idle): wall for that stage pair ~ max(dec, enc_p).
        // I-frame (encode MT, saturates): decode cannot overlap => dec + enc_i.
        // Approximate steady state: sum over frames of the encode-leg wall, plus one
        // extra decode (the initial prime) — dec of N+1 hides behind enc of N when P.
        // wall ≈ dec(prime) + Σ_frames( enc_leg where P-frame hides its *next* decode )
        // Simpler equivalent: overlapped ≈ dec + Σ enc_i(I) + Σ max(dec, enc_p)(P over
        //   the frames whose *encode* is ST) + dec charged for frames whose next
        //   decode couldn't hide (after an I-frame's MT encode).
        // Use the clean lower-bound model: overlapped = dec + n_i*(enc_i + dec) + n_p*max(dec,enc_p)
        //   (each I-frame forces a serial decode+encode; each P-frame hides one decode).
        let overlapped =
            dec + n_i as f64 * (enc_i + dec) + n_p as f64 * dec.max(enc_p);
        (serial, overlapped)
    };

    let (s_png, o_png) = est_overlap(png_dec, ia, pa, n, gop);
    println!("\n== Part C: overlap estimate — PNG-source video ==");
    println!(
        "  dec {:.1} ms | enc_I {:.1} ms | enc_P {:.1} ms | frames {} (I {} / P {})",
        png_dec, ia, pa, n, n_i, n_p
    );
    println!(
        "  serial wall {:.0} ms ({:.1} ms/f) -> overlapped wall {:.0} ms ({:.1} ms/f) => speedup {:.2}x",
        s_png,
        s_png / n as f64,
        o_png,
        o_png / n as f64,
        s_png / o_png
    );

    // ===================== RAW timelapse =====================
    let mut cr2: Vec<PathBuf> = std::fs::read_dir(&cr2_dir)
        .expect("read cr2 dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .map_or(false, |f| f.to_string_lossy().starts_with("ADH"))
                && p.extension()
                    .map_or(false, |x| x.eq_ignore_ascii_case("CR2"))
        })
        .collect();
    cr2.sort();
    if cr2.is_empty() {
        println!("\n(no ADH*.CR2 in {cr2_dir} — skipping RAW timelapse)");
        return;
    }

    println!(
        "\n== Part A/C: RAW timelapse decode ({} CR2 frames, cap 1920 long-edge) ==",
        cr2.len()
    );
    let look = RawVideoLook::default();
    // new() decodes frame 0 (full 24MP photo pipeline) — time it as frame-0 decode.
    let t0 = Instant::now();
    let mut src =
        RawVideoSource::new(cr2.clone(), look, 0.0, 6, 1, Some(1920), None).expect("raw source");
    let new_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let (dw, dh) = src.dims();

    // Decode-only loop: frame 0's next_frame_into is cheap (cached), so its real
    // decode cost is `new_ms`. Frames 1.. actually decode inside next_frame_into.
    let mut raw_frames: Vec<Vec<u8>> = Vec::new();
    let mut dec_ms: Vec<f64> = vec![new_ms];
    let mut buf = Vec::new();
    let mut fi = 0usize;
    loop {
        let t = Instant::now();
        let ok = src.next_frame_into(&mut buf);
        let e = t.elapsed().as_secs_f64() * 1000.0;
        if !ok {
            break;
        }
        if fi >= 1 {
            dec_ms.push(e);
        }
        raw_frames.push(buf.clone());
        fi += 1;
    }
    if let Some(err) = src.take_error() {
        println!("  RAW decode error: {err}");
    }
    let raw_dec = mean(&dec_ms);
    println!(
        "  decoded {} frames @ {dw}x{dh} | per-frame RAW decode: mean {:.1} ms (frame0 {:.1}, rest mean {:.1})",
        raw_frames.len(),
        raw_dec,
        new_ms,
        mean(&dec_ms[1.min(dec_ms.len())..])
    );

    // RAW-dims streaming encode (I vs P) over the decoded frames.
    let (ri, rp, rt, _rper) = stream_split(&raw_frames, dw, dh, &opts);
    let rn = raw_frames.len();
    let rn_i = (rn + gop - 1) / gop;
    let rn_p = rn - rn_i;
    println!(
        "  streaming encode @ {dw}x{dh}: total {:.0} ms | I n={} mean {:.1} ms | P n={} mean {:.1} ms",
        rt, rn_i, ri, rn_p, rp
    );
    let (s_raw, o_raw) = est_overlap(raw_dec, ri, rp, rn, gop);
    println!("\n== Part C: overlap estimate — RAW timelapse ==");
    println!(
        "  dec {:.1} ms | enc_I {:.1} ms | enc_P {:.1} ms | frames {} (I {} / P {})",
        raw_dec, ri, rp, rn, rn_i, rn_p
    );
    println!(
        "  serial wall {:.0} ms ({:.1} ms/f) -> overlapped wall {:.0} ms ({:.1} ms/f) => speedup {:.2}x",
        s_raw,
        s_raw / rn as f64,
        o_raw,
        o_raw / rn as f64,
        s_raw / o_raw
    );
}

#[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("overlap_probe requires --features jxl-codec on a native target");
}
