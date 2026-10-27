//! Cross-repo vector for blizz FB-1: writes the fable `.casv` blizz pins in
//! `tests/data/casv/fable_gop4.casv` (`casv_fable_fixture_is_frozen`). The
//! generator must stay identical to blizz `src/casv.rs` `fixture_frames`.
//!
//! Usage: fable_vector <out.casv>   (build with --no-default-features)

fn fixture_frames(w: usize, h: usize, n: usize) -> Vec<Vec<u8>> {
    let mut s = 0x9E37_79B9_7F4A_7C15u64;
    let tex: Vec<u8> = (0..w * h * 3)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            (s >> 56) as u8 & 15
        })
        .collect();
    (0..n)
        .map(|t| {
            let mut v = vec![0u8; w * h * 3];
            for y in 0..h {
                for x in 0..w {
                    for c in 0..3 {
                        let o = (y * w + x) * 3 + c;
                        v[o] = ((x + t) * 3 + y * 2 + c * 50) as u8 ^ tex[o];
                    }
                }
            }
            v
        })
        .collect()
}

fn main() {
    let out = std::env::args().nth(1).expect("usage: fable_vector <out.casv>");
    let frames = fixture_frames(37, 21, 9);
    let mut enc = raw_pipeline::fable_video::FableVideoEncoder::new(37, 21, 24, 1, 4);
    for f in &frames {
        enc.push_rgb8(f).unwrap();
    }
    let casv = enc.finish().unwrap();
    std::fs::write(&out, &casv).unwrap();
    let mut h = 0xcbf29ce484222325u64;
    for &b in &casv {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    println!("{out}: {} B fnv={h:#018x}", casv.len());
}
