//! CASV decode golden harness (cv-dec agent, 2026-07-02).
//!
//! Two modes:
//!   encode <corpus_dir> [frames_dir]  — encode the Ghana frames into every
//!       decode-relevant CASV tier/format and write the .casv files to disk.
//!       Run ONCE at baseline; the files are then frozen inputs.
//!   decode <corpus_dir>               — decode every .casv in the dir with the
//!       current library and print SHA256 of the concatenated RGB frames plus
//!       random-access probes. Byte-exact changes must reproduce this output
//!       exactly.
//!
//! Run (MSVC, release), from `crates/raw-pipeline`:
//!   cargo run --release --example casv_decode_golden -- encode C:\Tmp\jf-cvdec-golden
//!   cargo run --release --example casv_decode_golden -- decode C:\Tmp\jf-cvdec-golden

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn main() {
    use raw_pipeline::casa_video::*;
    use raw_pipeline::jxl_casaencoder::EncodeOptions;
    use sha2::{Digest, Sha256};

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
                let f = self.frames[self.i].clone();
                self.i += 1;
                Some(f)
            } else {
                None
            }
        }
    }

    let mode = std::env::args().nth(1).expect("mode: encode|decode");
    let dir = std::env::args().nth(2).expect("corpus dir");

    if mode == "encode" {
        let frames_dir = std::env::args()
            .nth(3)
            .unwrap_or_else(|| r"C:\Foo\raw-converter\tests\real_video_ghana".to_string());
        let mut paths: Vec<_> = std::fs::read_dir(&frames_dir)
            .expect("read frames dir")
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "png"))
            .collect();
        paths.sort();
        assert!(!paths.is_empty(), "no PNG frames in {frames_dir}");
        let mut frames: Vec<Vec<u8>> = Vec::with_capacity(paths.len());
        let (mut w, mut h) = (0u32, 0u32);
        for p in &paths {
            let img = image::open(p).expect("open png").to_rgb8();
            w = img.width();
            h = img.height();
            frames.push(img.into_raw());
        }
        let refs: Vec<&[u8]> = frames.iter().map(|v| v.as_slice()).collect();
        std::fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, bytes: &[u8]| {
            std::fs::write(format!("{dir}\\{name}"), bytes).unwrap();
            println!("wrote {name}: {} bytes", bytes.len());
        };

        // Header-format tiers (each exercises a distinct decode path):
        // lossless archive preset (bbox residual, gop 24, e3) — jolt_bench arm.
        write(
            "arch_bbox_g24.casv",
            &encode_casv_video(&refs, w, h, 24, 1, &CasaVideoOptions::lossless_archive()).unwrap(),
        );
        // full-frame residual P-frames (SkipMode::None), 6 GOPs.
        write(
            "none_g8_e1.casv",
            &encode_casv_delta_rgb8(&refs, w, h, 24, 1, 8, EncodeOptions::lossless().with_effort(1))
                .unwrap(),
        );
        // lossless tile residual, 6 GOPs.
        write(
            "tile_g8_e1.casv",
            &encode_casv_delta_tiled_rgb8(
                &refs,
                w,
                h,
                24,
                1,
                8,
                32,
                EncodeOptions::lossless().with_effort(1),
            )
            .unwrap(),
        );
        // lossy bbox REPLACE, 6 GOPs.
        write(
            "lossybbox_g8.casv",
            &encode_casv_delta_lossy_bbox_rgb8(&refs, w, h, 24, 1, 8, 1.0, 6).unwrap(),
        );
        // JOLT batch (header format, tile REPLACE).
        write("jolt_bal_hdr.casv", &jolt_encode(&refs, w, h, 24, 1, JoltPreset::Balanced).unwrap());
        // streaming header-format encode (chunked I-frames + bbox replace).
        let sopts = CasaVideoOptions {
            rate: VideoRate::Lossy(1.0),
            gop_len: 8,
            skip: SkipMode::Bbox,
            tile: 32,
            effort: 3,
            thresh: None,
        };
        let mut src = VecFrames { frames: frames.clone(), i: 0, w, h };
        write("stream_hdr_bbox_g8.casv", &encode_casv_video_streaming(&mut src, &sopts).unwrap());

        // Footer-format (streamed) JOLT presets — the jolt_bench decode path.
        for (name, preset) in [
            ("jolt_rt_ftr.casv", JoltPreset::Realtime),
            ("jolt_bal_ftr.casv", JoltPreset::Balanced),
            ("jolt_q_ftr.casv", JoltPreset::Quality),
        ] {
            let mut src = VecFrames { frames: frames.clone(), i: 0, w, h };
            let mut sink: Vec<u8> = Vec::new();
            jolt_encode_stream_to(&mut src, preset, &mut sink).unwrap();
            write(name, &sink);
        }
        return;
    }

    assert_eq!(mode, "decode");
    let mut names: Vec<_> = std::fs::read_dir(&dir)
        .expect("read corpus dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "casv"))
        .collect();
    names.sort();
    assert!(!names.is_empty(), "no .casv files in {dir}");

    for p in &names {
        let data = std::fs::read(p).unwrap();
        let name = p.file_name().unwrap().to_string_lossy();
        let is_footer = parse_casv_header(&data).is_none();
        let frames = if is_footer {
            decode_casv_footer_all_rgb8(&data).expect("footer decode")
        } else {
            decode_casv_all_rgb8(&data).expect("header decode")
        };
        let mut hasher = Sha256::new();
        for (px, _, _) in &frames {
            hasher.update(px);
        }
        println!("{name} all[{}] sha256={:x}", frames.len(), hasher.finalize());

        // Random-access probes (header format only): I-frame, early P, GOP edges, last.
        if !is_footer {
            let n = frames.len();
            for idx in [0usize, 1, 7, 8, 23, 24, n - 1] {
                if idx >= n {
                    continue;
                }
                let (px, _, _) = decode_casv_frame_rgb8(&data, idx).expect("frame decode");
                let mut hasher = Sha256::new();
                hasher.update(&px);
                println!("{name} frame[{idx}] sha256={:x}", hasher.finalize());
            }
        }
    }
}

#[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("casv_decode_golden requires --features jxl-codec on a native target");
}
