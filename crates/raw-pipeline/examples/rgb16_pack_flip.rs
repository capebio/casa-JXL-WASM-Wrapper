//! rgb16_pack_flip — thermal-cancelled A/B for the rgb16 pack/unpack repack (src/lib.rs).
//! Same principle as the CR2 reassembly win: a per-element loop whose access is actually a
//! contiguous run → on a little-endian target the whole thing is one memcpy.
//!
//!   PACK:   Vec<u16> (3/px) → packed LE 6B/px.   A=scalar byte-split loop  B=memcpy(LE)
//!   UNPACK: packed LE 6B/px → Vec<u16>.          A=scalar from_le_bytes     B=memcpy(LE)
//!
//! Interleaved start-rotated rounds; round 0 dropped; median + %saved. Parity byte-EXACT.
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example rgb16_pack_flip
use std::time::Instant;

fn pack_scalar(src: &[u16], w: usize, h: usize) -> Vec<u8> {
    let mut out = vec![0u8; w * h * 6];
    for i in 0..(w * h) {
        let o = i * 6;
        let (r, g, b) = (src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
        out[o] = (r & 0xff) as u8;
        out[o + 1] = (r >> 8) as u8;
        out[o + 2] = (g & 0xff) as u8;
        out[o + 3] = (g >> 8) as u8;
        out[o + 4] = (b & 0xff) as u8;
        out[o + 5] = (b >> 8) as u8;
    }
    out
}
fn pack_memcpy(src: &[u16], w: usize, h: usize) -> Vec<u8> {
    let n = w * h * 3;
    let mut out = vec![0u8; n * 2];
    let src_bytes = unsafe { core::slice::from_raw_parts(src.as_ptr() as *const u8, n * 2) };
    out.copy_from_slice(src_bytes);
    out
}
fn unpack_scalar(src: &[u8]) -> Vec<u16> {
    let n = src.len() / 2;
    let mut out = Vec::with_capacity(n);
    let mut i = 0;
    while i < src.len() {
        out.push(u16::from_le_bytes([src[i], src[i + 1]]));
        i += 2;
    }
    out
}
fn unpack_memcpy(src: &[u8]) -> Vec<u16> {
    let n = src.len() / 2;
    let mut out = vec![0u16; n];
    let dst = unsafe { core::slice::from_raw_parts_mut(out.as_mut_ptr() as *mut u8, n * 2) };
    dst.copy_from_slice(&src[..n * 2]);
    out
}

fn med(v: &[f64]) -> f64 {
    let mut w: Vec<f64> = v[1..].to_vec();
    w.sort_by(|a, b| a.partial_cmp(b).unwrap());
    w[w.len() / 2]
}

fn flip<T, A: Fn() -> T, B: Fn() -> T>(label: &str, a: A, b: B, sink: impl Fn(&T) -> u64) {
    let rounds = 11usize;
    let (mut ta, mut tb) = (Vec::new(), Vec::new());
    let mut s = 0u64;
    let time = |f: &dyn Fn() -> T, s: &mut u64| {
        let t = Instant::now();
        let out = f();
        *s = s.wrapping_add(sink(&out));
        t.elapsed().as_secs_f64() * 1e3
    };
    for r in 0..rounds {
        if r % 2 == 0 {
            ta.push(time(&a, &mut s));
            tb.push(time(&b, &mut s));
        } else {
            tb.push(time(&b, &mut s));
            ta.push(time(&a, &mut s));
        }
    }
    std::hint::black_box(s);
    let (ma, mb) = (med(&ta), med(&tb));
    println!(
        "  {label:<8} scalar={ma:7.3}ms  memcpy={mb:7.3}ms  saved={:5.1}%",
        (ma - mb) / ma * 100.0
    );
}

fn main() {
    let (w, h) = (6000usize, 4000usize); // 24 MP full-master
    let mut s: u32 = 0x9e37_79b9;
    let src16: Vec<u16> = (0..w * h * 3)
        .map(|_| {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            ((s >> 8) & 0xffff) as u16
        })
        .collect();
    let packed = pack_memcpy(&src16, w, h);

    assert_eq!(
        pack_scalar(&src16, w, h),
        pack_memcpy(&src16, w, h),
        "PACK parity broken"
    );
    assert_eq!(
        unpack_scalar(&packed),
        unpack_memcpy(&packed),
        "UNPACK parity broken"
    );
    assert_eq!(unpack_memcpy(&packed), src16, "round-trip broken");

    println!("rgb16 pack/unpack flip  {w}x{h} (24 MP)  parity: EXACT");
    flip(
        "PACK",
        || pack_scalar(&src16, w, h),
        || pack_memcpy(&src16, w, h),
        |o| o[o.len() / 2] as u64,
    );
    flip(
        "UNPACK",
        || unpack_scalar(&packed),
        || unpack_memcpy(&packed),
        |o| o[o.len() / 2] as u64,
    );
}
