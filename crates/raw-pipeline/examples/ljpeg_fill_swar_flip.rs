//! ljpeg_fill_swar_flip — thermal-cancelled A/B for BitReader::fill's bulk 4-byte path.
//!
//!   A = current: load 4 bytes, 4 separate `!= 0xFF` branches, OR into a word
//!   B = SWAR:    load one big-endian word, detect any 0xFF byte via the
//!                zero-byte trick on (!word): ((x-0x01010101) & !x & 0x80808080) != 0
//!
//! Both accumulate the same words and fall to a per-byte slow path on an FF byte.
//! This isolates the bulk-detection cost (the real decode is latency-bound on the
//! predictor chain; memory rejected bit-op fusion there — measuring whether the
//! bulk FF-detect itself is worth changing). Parity = identical accumulator + pos.
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example ljpeg_fill_swar_flip

use std::time::Instant;

// Scan the buffer the way fill() consumes it: 4-byte bulk when no FF, else 1 byte.
// Returns (xor-folded accumulator, bytes consumed) as a parity fingerprint.
fn scan_a(src: &[u8]) -> (u64, usize) {
    let mut acc = 0u64;
    let mut pos = 0;
    while pos < src.len() {
        let remaining = src.len() - pos;
        if remaining >= 4 {
            let b0 = src[pos];
            let b1 = src[pos + 1];
            let b2 = src[pos + 2];
            let b3 = src[pos + 3];
            if b0 != 0xFF && b1 != 0xFF && b2 != 0xFF && b3 != 0xFF {
                let word =
                    ((b0 as u64) << 24) | ((b1 as u64) << 16) | ((b2 as u64) << 8) | (b3 as u64);
                acc = acc.wrapping_mul(31).wrapping_add(word);
                pos += 4;
                continue;
            }
        }
        // slow: one byte (FF handling elided for the micro-bench; same in both arms)
        acc = acc.wrapping_mul(31).wrapping_add(src[pos] as u64);
        pos += 1;
    }
    (acc, pos)
}

fn scan_b(src: &[u8]) -> (u64, usize) {
    let mut acc = 0u64;
    let mut pos = 0;
    while pos < src.len() {
        let remaining = src.len() - pos;
        if remaining >= 4 {
            let word4 = u32::from_be_bytes([src[pos], src[pos + 1], src[pos + 2], src[pos + 3]]);
            let x = !word4;
            let has_ff = (x.wrapping_sub(0x0101_0101) & !x & 0x8080_8080) != 0;
            if !has_ff {
                acc = acc.wrapping_mul(31).wrapping_add(word4 as u64);
                pos += 4;
                continue;
            }
        }
        acc = acc.wrapping_mul(31).wrapping_add(src[pos] as u64);
        pos += 1;
    }
    (acc, pos)
}

fn median(v: &[f64]) -> f64 {
    let mut w: Vec<f64> = v[1..].to_vec();
    w.sort_by(|a, b| a.partial_cmp(b).unwrap());
    w[w.len() / 2]
}

fn main() {
    // ~16 MB synthetic entropy stream, FF ~1/256 (realistic for RAW LJPEG residuals).
    let n = 16 * 1024 * 1024;
    let mut src = vec![0u8; n];
    let mut s = 0x12345678u32;
    for b in src.iter_mut() {
        s = s.wrapping_mul(1664525).wrapping_add(1013904223);
        *b = (s >> 24) as u8; // uniform bytes => FF at ~1/256
    }

    let ra = scan_a(&src);
    let rb = scan_b(&src);
    let parity = ra == rb;

    let rounds = 11usize;
    let (mut ta, mut tb) = (Vec::new(), Vec::new());
    let mut sink = 0u64;
    let time = |f: &dyn Fn(&[u8]) -> (u64, usize), sink: &mut u64| {
        let t = Instant::now();
        let r = f(&src);
        *sink = sink.wrapping_add(r.0).wrapping_add(r.1 as u64);
        t.elapsed().as_secs_f64() * 1e3
    };
    for r in 0..rounds {
        if r % 2 == 0 {
            ta.push(time(&scan_a, &mut sink));
            tb.push(time(&scan_b, &mut sink));
        } else {
            tb.push(time(&scan_b, &mut sink));
            ta.push(time(&scan_a, &mut sink));
        }
    }
    std::hint::black_box(sink);
    let (ma, mb) = (median(&ta), median(&tb));
    let saved = (ma - mb) / ma * 100.0;
    println!("ljpeg fill bulk FF-detect flip @16MB  A=4-branch  B=SWAR\n");
    println!("  A 4-branch {:>8.3} ms", ma);
    println!("  B SWAR     {:>8.3} ms   saved {:.1}%", mb, saved);
    println!("  parity (acc+pos): {}", parity);
    println!("\n  Gate >=2% AND parity=true -> apply to BitReader::fill. (decode is latency-bound; expect little.)");
}
