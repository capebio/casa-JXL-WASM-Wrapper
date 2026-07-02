//! Golden-output dump for FableBraid byte-exactness gating.
//!
//! Writes encoded and decoded artifacts to `<outdir>`; hash them externally
//! (SHA256) and compare across code changes — every landed FBR1 change must
//! reproduce all files byte-identically.
//!
//! Usage: fable_golden <rgb-file> <w> <h> <frames> <outdir>

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 6 {
        eprintln!("usage: fable_golden <rgb-file> <w> <h> <frames> <outdir>");
        std::process::exit(1);
    }
    let (path, w, h, count) = (&a[1], a[2].parse::<u32>().unwrap(),
                               a[3].parse::<u32>().unwrap(), a[4].parse::<usize>().unwrap());
    let outdir = std::path::Path::new(&a[5]);
    std::fs::create_dir_all(outdir).unwrap();
    let flen = (w * h * 3) as usize;
    let raw = std::fs::read(path).expect("read rgb");
    let frames: Vec<&[u8]> = (0..count).map(|i| &raw[i * flen..(i + 1) * flen]).collect();

    use raw_pipeline::casa_video::*;

    // Whole-clip casv at several GOP shapes (gop 1 = all-I, exercises intra only).
    for gop in [24u32, 4, 1] {
        let casv = encode_casv_fable_rgb8(&frames, w, h, 24, 1, gop).unwrap();
        std::fs::write(outdir.join(format!("fable_gop{gop}.casv")), &casv).unwrap();
        let dec = decode_casv_all_rgb8(&casv).expect("decode all");
        assert_eq!(dec.len(), count);
        let mut cat = Vec::with_capacity(raw.len());
        for (i, (px, dw, dh)) in dec.iter().enumerate() {
            assert_eq!((*dw, *dh), (w, h));
            assert_eq!(px, frames[i], "gop {gop} frame {i} byte-exact vs source");
            cat.extend_from_slice(px);
        }
        std::fs::write(outdir.join(format!("decoded_gop{gop}.rgb")), &cat).unwrap();
        println!("gop {gop}: casv {} B, decoded {} B (all frames byte-exact)", casv.len(), cat.len());
    }

    // Random access via decode_casv_frame_rgb8 (mid-GOP P-frame).
    {
        let casv = encode_casv_fable_rgb8(&frames, w, h, 24, 1, 24).unwrap();
        for idx in [0usize, 7, 23, 24, count - 1] {
            let (px, _, _) = decode_casv_frame_rgb8(&casv, idx).expect("random access");
            assert_eq!(px, frames[idx], "random access frame {idx}");
        }
        println!("random access: byte-exact at 0/7/23/24/{}", count - 1);
    }

    // Single-image intra + delta artifacts.
    let intra = raw_pipeline::fable_braid::encode_rgb8(frames[0], w, h);
    std::fs::write(outdir.join("intra_f0.fbr"), &intra).unwrap();
    let (px, dw, dh) = raw_pipeline::fable_braid::decode_rgb8(&intra).unwrap();
    assert_eq!(((dw, dh), px.as_slice()), ((w, h), frames[0]));
    let delta = raw_pipeline::fable_braid::encode_rgb8_delta(frames[1], frames[0], w, h);
    std::fs::write(outdir.join("delta_f1.fbr"), &delta).unwrap();
    let dpx = raw_pipeline::fable_braid::decode_rgb8_delta(&delta, frames[0], w, h).unwrap();
    assert_eq!(dpx.as_slice(), frames[1]);
    println!("intra {} B, delta {} B (roundtrips byte-exact)", intra.len(), delta.len());
    println!("GOLDEN OK");
}
