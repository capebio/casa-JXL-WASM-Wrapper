//! dng_unpack_flip — thermal-cancelled A/B for the uncompressed-DNG strip unpack (dng.rs).
//! Same principle as CR2 reassembly / rgb16 pack: a per-pixel scatter of a contiguous u16
//! run (with per-element checked-mul/add + get_mut + from_le_bytes) → one per-row
//! fill_u16_row (memcpy on LE).
//!
//!   A = scalar per-pixel (checked index + from_le_bytes)   B = per-row fill (memcpy LE)
//!
//! Interleaved start-rotated rounds; round 0 dropped; median + %saved. Parity byte-EXACT.
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example dng_unpack_flip
use std::time::Instant;

// B kernel: mirror of dng::fill_u16_row (LE fast path).
fn fill_u16_row(dst: &mut [u16], bytes: &[u8], le: bool) {
    if le {
        let dstb =
            unsafe { core::slice::from_raw_parts_mut(dst.as_mut_ptr() as *mut u8, dst.len() * 2) };
        dstb.copy_from_slice(bytes);
        return;
    }
    for (o, c) in dst.iter_mut().zip(bytes.chunks_exact(2)) {
        *o = u16::from_be_bytes([c[0], c[1]]);
    }
}

// A: the pre-optimization strip inner loop (per-element scatter + checked arith).
fn strip_scalar(src: &[u8], width: usize, height: usize, le: bool) -> Vec<u16> {
    let mut out = vec![0u16; width * height];
    let mut sp = 0usize;
    for r in 0..height {
        for c in 0..width {
            let dst = r
                .checked_mul(width)
                .and_then(|v| v.checked_add(c))
                .and_then(|i| out.get_mut(i))
                .unwrap();
            *dst = if le {
                u16::from_le_bytes([src[sp], src[sp + 1]])
            } else {
                u16::from_be_bytes([src[sp], src[sp + 1]])
            };
            sp += 2;
        }
    }
    out
}
// B: the new per-row form.
fn strip_rowcopy(src: &[u8], width: usize, height: usize, le: bool) -> Vec<u16> {
    let mut out = vec![0u16; width * height];
    let need = width * 2;
    let mut sp = 0usize;
    for r in 0..height {
        let base = r * width;
        fill_u16_row(&mut out[base..base + width], &src[sp..sp + need], le);
        sp += need;
    }
    out
}

fn med(v: &[f64]) -> f64 {
    let mut w: Vec<f64> = v[1..].to_vec();
    w.sort_by(|a, b| a.partial_cmp(b).unwrap());
    w[w.len() / 2]
}

fn main() {
    let (w, h) = (6000usize, 4000usize); // 24 MP DNG
    let mut s: u32 = 0x9e37_79b9;
    let src: Vec<u8> = (0..w * h * 2)
        .map(|_| {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (s >> 16) as u8
        })
        .collect();

    assert_eq!(
        strip_scalar(&src, w, h, true),
        strip_rowcopy(&src, w, h, true),
        "LE parity broken"
    );
    assert_eq!(
        strip_scalar(&src, w, h, false),
        strip_rowcopy(&src, w, h, false),
        "BE parity broken"
    );

    let run_a = || strip_scalar(&src, w, h, true);
    let run_b = || strip_rowcopy(&src, w, h, true);
    let rounds = 11usize;
    let (mut ta, mut tb) = (Vec::new(), Vec::new());
    let mut sink = 0u64;
    let time = |f: &dyn Fn() -> Vec<u16>, sink: &mut u64| {
        let t = Instant::now();
        let out = f();
        *sink = sink.wrapping_add(out[out.len() / 2] as u64);
        t.elapsed().as_secs_f64() * 1e3
    };
    for r in 0..rounds {
        if r % 2 == 0 {
            ta.push(time(&run_a, &mut sink));
            tb.push(time(&run_b, &mut sink));
        } else {
            tb.push(time(&run_b, &mut sink));
            ta.push(time(&run_a, &mut sink));
        }
    }
    std::hint::black_box(sink);
    let (ma, mb) = (med(&ta), med(&tb));
    println!("uncompressed DNG strip unpack flip  {w}x{h} (24 MP)  parity: EXACT (LE+BE)");
    println!(
        "  scalar={ma:.3}ms  rowcopy(memcpy LE)={mb:.3}ms  saved={:.1}% ({:.1}ms)",
        (ma - mb) / ma * 100.0,
        ma - mb
    );
}
