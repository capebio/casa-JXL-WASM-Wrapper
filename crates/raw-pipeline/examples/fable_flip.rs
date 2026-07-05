//! Interleaved-friendly timing harness for the FableBraid casv tier.
//!
//! One invocation times `reps` passes of one arm; interleave OLD/NEW *binaries*
//! (A,B,B,A,... with start rotation) to cancel thermal drift per the flipflop
//! house rule. Prints per-pass times and min/med.
//!
//! Usage: fable_flip <rgb-file> <w> <h> <frames> <gop> <reps> <dec|enc>
//!   dec: encode once, then reps x decode_casv_all_rgb8 (whole clip)
//!   enc: reps x serial per-frame fable_braid encode (intra f0 + deltas)

use std::time::Instant;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 8 {
        eprintln!("usage: fable_flip <rgb-file> <w> <h> <frames> <gop> <reps> <dec|enc>");
        std::process::exit(1);
    }
    let (path, w, h, count) = (
        &a[1],
        a[2].parse::<u32>().unwrap(),
        a[3].parse::<u32>().unwrap(),
        a[4].parse::<usize>().unwrap(),
    );
    let gop = a[5].parse::<u32>().unwrap();
    let reps = a[6].parse::<usize>().unwrap();
    let mode = a[7].as_str();
    let flen = (w * h * 3) as usize;
    let raw = std::fs::read(path).expect("read rgb");
    let frames: Vec<&[u8]> = (0..count).map(|i| &raw[i * flen..(i + 1) * flen]).collect();

    use raw_pipeline::casa_video::*;

    let mut times = Vec::with_capacity(reps);
    match mode {
        "dec" => {
            let casv = encode_casv_fable_rgb8(&frames, w, h, 24, 1, gop).unwrap();
            // warmup + correctness
            let dec = decode_casv_all_rgb8(&casv).expect("decode");
            for (i, (px, _, _)) in dec.iter().enumerate() {
                assert_eq!(px, frames[i], "frame {i} byte-exact");
            }
            drop(dec);
            for _ in 0..reps {
                let t = Instant::now();
                let out = decode_casv_all_rgb8(&casv).unwrap();
                times.push(t.elapsed().as_secs_f64() * 1e3);
                std::hint::black_box(&out);
            }
        }
        "enc" => {
            use raw_pipeline::fable_braid::{encode_rgb8, encode_rgb8_delta};
            // warmup
            std::hint::black_box(encode_rgb8(frames[0], w, h));
            for _ in 0..reps {
                let t = Instant::now();
                let mut total = 0usize;
                total += encode_rgb8(frames[0], w, h).len();
                for i in 1..count {
                    total += encode_rgb8_delta(frames[i], frames[i - 1], w, h).len();
                }
                times.push(t.elapsed().as_secs_f64() * 1e3);
                std::hint::black_box(total);
            }
        }
        _ => panic!("mode must be dec|enc"),
    }
    for (i, t) in times.iter().enumerate() {
        println!("PASS {i} {t:.3}");
    }
    let mut s = times.clone();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "STAT {mode} gop{gop} x{reps}: min {:.3} med {:.3} ms  ({:.3} ms/f min)",
        s[0],
        s[s.len() / 2],
        s[0] / count as f64
    );
}
