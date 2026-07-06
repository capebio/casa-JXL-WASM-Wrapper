//! rgb_to_rgba_flip — thermal-cancelled A/B for the RGB8→RGBA8 expand (src/lib.rs).
//! 3-stride→4-stride is not a memcpy, but it IS a fixed byte-shuffle: one pshufb
//! (x86 SSSE3) / i8x16_swizzle (wasm) turns 4 RGB pixels (12B) into 4 RGBA (16B),
//! alpha set by OR-ing a constant 0xFF mask. Mirrors the shipped kernel; the wasm
//! build uses the swizzle twin of this SSSE3 path.
//!
//!   A = scalar per-pixel 3→4 scatter   B = SSSE3 pshufb (4 px/shuffle)
//!
//! Interleaved start-rotated rounds; round 0 dropped; median + %saved. Parity byte-EXACT.
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example rgb_to_rgba_flip
use std::time::Instant;

fn simd_blocks(src_len: usize, n: usize) -> usize {
    if src_len < 16 {
        0
    } else {
        ((src_len - 16) / 12 + 1).min(n / 4)
    }
}

fn scalar(rgb: &[u8]) -> Vec<u8> {
    let n = rgb.len() / 3;
    let mut out = vec![255u8; n * 4];
    let (mut si, mut di) = (0usize, 0usize);
    for _ in 0..n {
        out[di] = rgb[si];
        out[di + 1] = rgb[si + 1];
        out[di + 2] = rgb[si + 2];
        si += 3;
        di += 4;
    }
    out
}

#[cfg(target_arch = "x86_64")]
fn simd(rgb: &[u8]) -> Vec<u8> {
    let n = rgb.len() / 3;
    let mut out = vec![255u8; n * 4];
    let blocks = if std::is_x86_feature_detected!("ssse3") {
        simd_blocks(rgb.len(), n)
    } else {
        0
    };
    if blocks > 0 {
        unsafe { ssse3(rgb, &mut out, blocks) };
    }
    let (mut si, mut di) = (blocks * 4 * 3, blocks * 4 * 4);
    for _ in (blocks * 4)..n {
        out[di] = rgb[si];
        out[di + 1] = rgb[si + 1];
        out[di + 2] = rgb[si + 2];
        si += 3;
        di += 4;
    }
    out
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "ssse3")]
unsafe fn ssse3(rgb: &[u8], out: &mut [u8], blocks: usize) {
    use core::arch::x86_64::*;
    let shuf = _mm_setr_epi8(0, 1, 2, -128, 3, 4, 5, -128, 6, 7, 8, -128, 9, 10, 11, -128);
    let amask = _mm_setr_epi8(0, 0, 0, -1, 0, 0, 0, -1, 0, 0, 0, -1, 0, 0, 0, -1);
    for b in 0..blocks {
        let v = _mm_loadu_si128(rgb.as_ptr().add(b * 12) as *const __m128i);
        let res = _mm_or_si128(_mm_shuffle_epi8(v, shuf), amask);
        _mm_storeu_si128(out.as_mut_ptr().add(b * 16) as *mut __m128i, res);
    }
}

#[cfg(not(target_arch = "x86_64"))]
fn simd(rgb: &[u8]) -> Vec<u8> {
    scalar(rgb)
}

fn med(v: &[f64]) -> f64 {
    let mut w: Vec<f64> = v[1..].to_vec();
    w.sort_by(|a, b| a.partial_cmp(b).unwrap());
    w[w.len() / 2]
}

fn main() {
    let (w, h) = (6000usize, 4000usize); // 24 MP
    let mut s: u32 = 0x9e37_79b9;
    let rgb: Vec<u8> = (0..w * h * 3)
        .map(|_| {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (s >> 24) as u8
        })
        .collect();

    // parity across tricky lengths too
    for &px in &[0usize, 1, 3, 4, 5, 7, 16, 17, 1001] {
        let r = &rgb[..px * 3];
        assert_eq!(scalar(r), simd(r), "parity broken at {px} px");
    }

    let run_a = || scalar(&rgb);
    let run_b = || simd(&rgb);
    let rounds = 11usize;
    let (mut ta, mut tb) = (Vec::new(), Vec::new());
    let mut sink = 0u64;
    let time = |f: &dyn Fn() -> Vec<u8>, sink: &mut u64| {
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
    println!("rgb_to_rgba flip  {w}x{h} (24 MP)  parity: EXACT (incl tail)");
    println!(
        "  scalar={ma:.3}ms  pshufb={mb:.3}ms  saved={:.1}% ({:.1}ms)",
        (ma - mb) / ma * 100.0,
        ma - mb
    );
}
