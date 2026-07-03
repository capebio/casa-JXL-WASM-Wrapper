//! casv_web_fixtures — generates small synthetic .casv fixtures + expected
//! native decodes for the @casabio/casv-web browser player tests.
//!
//! Writes into packages/casv-web/test/fixtures/ (relative to the repo root or
//! pass an output dir):
//!   tile_v2.casv        header format, JOLT tile skip (v2 square atlas), GOP 3
//!   bbox.casv           header format, JOLT bbox skip, GOP 3
//!   sink_ratebox.casv   footer format + CASR rate box, tile skip
//!   intra.casv          all-intra lossy (no P-frames)
//!   <name>.expected.rgb native decode_casv_all_rgb8 output, frames concatenated
//!   manifest.json       { name: { width, height, frames } }
//!
//! Run from crates/raw-pipeline:
//!   ..\..\build-msvc.ps1 run --release --example casv_web_fixtures --features jxl-codec
#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn main() {
    use raw_pipeline::casa_video::{
        decode_casv_all_rgb8, decode_casv_footer_all_rgb8, encode_casv_video,
        encode_casv_video_streaming_to, CasaVideoOptions, SkipMode, VideoFrameSource, VideoRate,
    };
    use std::path::PathBuf;

    struct VecFrames {
        frames: Vec<Vec<u8>>,
        i: usize,
        w: u32,
        h: u32,
    }
    impl VideoFrameSource for VecFrames {
        fn dims(&self) -> (u32, u32) {
            (self.w, self.h)
        }
        fn fps(&self) -> (u32, u32) {
            (24, 1)
        }
        fn next_frame(&mut self) -> Option<Vec<u8>> {
            if self.i < self.frames.len() {
                self.i += 1;
                Some(self.frames[self.i - 1].clone())
            } else {
                None
            }
        }
    }

    // Deterministic textured frames with two moving regions (exercises multi-tile
    // payloads and bbox rects; texture keeps lossy payloads non-trivial).
    fn frames(w: u32, h: u32, n: usize) -> Vec<Vec<u8>> {
        let mut s: u32 = 0xc0ffee;
        let mut rnd = move || {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (s >> 24) as u8
        };
        let base: Vec<u8> = (0..(w * h * 3) as usize).map(|_| rnd()).collect();
        (0..n)
            .map(|f| {
                let mut v = base.clone();
                for (k, (sx, sy)) in [(5 * f as u32, 3 * f as u32), (2 * f as u32, 7 * f as u32)]
                    .into_iter()
                    .enumerate()
                {
                    let bx = (8 + sx) % (w - 20);
                    let by = (4 + sy) % (h - 20);
                    for yy in by..by + 20 {
                        for xx in bx..bx + 20 {
                            let o = ((yy * w + xx) * 3) as usize;
                            v[o] = (xx * 3 + f as u32 * 11) as u8;
                            v[o + 1] = (yy * 5 + k as u32 * 90) as u8;
                            v[o + 2] = 200u8.wrapping_add((f as u32 * 17) as u8);
                        }
                    }
                }
                v
            })
            .collect()
    }

    let out_dir = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("../../packages/casv-web/test/fixtures"));
    std::fs::create_dir_all(&out_dir).expect("create fixtures dir");

    let (w, h) = (80u32, 56u32);
    let n = 7usize;
    let fx = frames(w, h, n);
    let refs: Vec<&[u8]> = fx.iter().map(|v| v.as_slice()).collect();

    let mut manifest = String::from("{\n");
    let mut emit = |name: &str, casv: Vec<u8>, expected: Vec<(Vec<u8>, u32, u32)>| {
        assert_eq!(expected.len(), n, "{name}: frame count");
        let mut rgb = Vec::with_capacity(expected.len() * (w * h * 3) as usize);
        for (px, dw, dh) in &expected {
            assert_eq!((*dw, *dh), (w, h), "{name}: dims");
            rgb.extend_from_slice(px);
        }
        std::fs::write(out_dir.join(format!("{name}.casv")), &casv).unwrap();
        std::fs::write(out_dir.join(format!("{name}.expected.rgb")), &rgb).unwrap();
        manifest.push_str(&format!(
            "  \"{name}\": {{ \"width\": {w}, \"height\": {h}, \"frames\": {n} }},\n"
        ));
        println!("{name}: {} bytes casv, {} bytes expected", casv.len(), rgb.len());
    };

    // tile v2 (header format)
    let mut tile_opts = CasaVideoOptions::streaming(1.0);
    tile_opts.gop_len = 3;
    tile_opts.tile = 16;
    tile_opts.thresh = Some(0);
    let tile_casv = encode_casv_video(&refs, w, h, 24, 1, &tile_opts).unwrap();
    let tile_exp = decode_casv_all_rgb8(&tile_casv).unwrap();
    emit("tile_v2", tile_casv, tile_exp);

    // bbox (header format)
    let mut bbox_opts = CasaVideoOptions::streaming(1.0);
    bbox_opts.gop_len = 3;
    bbox_opts.skip = SkipMode::Bbox;
    bbox_opts.thresh = Some(0);
    let bbox_casv = encode_casv_video(&refs, w, h, 24, 1, &bbox_opts).unwrap();
    let bbox_exp = decode_casv_all_rgb8(&bbox_casv).unwrap();
    emit("bbox", bbox_casv, bbox_exp);

    // footer format + rate box (tile skip via the streaming-to-sink encoder)
    let mut sink = Vec::new();
    let mut src = VecFrames { frames: fx.clone(), i: 0, w, h };
    encode_casv_video_streaming_to(&mut src, &tile_opts, &mut sink).unwrap();
    let sink_exp = decode_casv_footer_all_rgb8(&sink).unwrap();
    emit("sink_ratebox", sink, sink_exp);

    // all-intra lossy (SkipMode::None + Lossy = independent frames, flags 0)
    let intra_opts = CasaVideoOptions {
        rate: VideoRate::Lossy(1.0),
        gop_len: 1,
        skip: SkipMode::None,
        tile: 16,
        effort: 3,
        thresh: Some(0),
        rate_control: None,
    };
    let intra_casv = encode_casv_video(&refs, w, h, 24, 1, &intra_opts).unwrap();
    let intra_exp = decode_casv_all_rgb8(&intra_casv).unwrap();
    emit("intra", intra_casv, intra_exp);

    let mut m = manifest.trim_end().trim_end_matches(',').to_string();
    m.push_str("\n}\n");
    std::fs::write(out_dir.join("manifest.json"), m).unwrap();
    println!("fixtures written to {}", out_dir.display());
}

#[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("casv_web_fixtures requires --features jxl-codec on a native target");
}
