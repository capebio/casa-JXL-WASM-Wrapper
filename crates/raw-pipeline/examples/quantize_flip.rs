//! quantize_flip — does handoff item 1 (move the f32→u16 quantize out of the post gather loop)
//! actually win? The current post stage does clamp+cast+gather INLINE per channel. Item 1 splits it:
//!   A inline : out[i] = post[(f[i].clamp(0,65535) as u16) as usize]            (current)
//!   B split  : pass1 q[i] = f[i].clamp(0,65535) as u16  (auto-vectorizable);   then
//!              pass2 out[i] = post[q[i] as usize]        (bare scalar gather)
//! B trades a vectorizable convert pass for an extra u16 buffer round-trip (memory traffic). This
//! decides whether item 1 is a real win or whether the inline loop is already near-optimal.
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --features parallel --example quantize_flip
use std::time::Instant;

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn main() {
    let n = 24_000_000usize * 3;
    let post: Vec<u8> = (0..65536usize).map(|i| (i >> 8) as u8).collect();
    // realistic post-matrix f32 tone values (some out of range to exercise clamp)
    let mut s: u32 = 0x9e37_79b9;
    let f: Vec<f32> = (0..n)
        .map(|_| {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            ((s >> 8) & 0x1ffff) as f32 - 8192.0
        })
        .collect();
    let mut out = vec![0u8; n];
    let mut q = vec![0u16; n];

    let run_a = |out: &mut [u8]| {
        let t = Instant::now();
        for (o, &v) in out.iter_mut().zip(f.iter()) {
            *o = post[(v.clamp(0.0, 65535.0) as u16) as usize];
        }
        std::hint::black_box(&out);
        t.elapsed().as_secs_f64() * 1e3
    };
    let run_b = |out: &mut [u8], q: &mut [u16]| {
        let t = Instant::now();
        for (qq, &v) in q.iter_mut().zip(f.iter()) {
            *qq = v.clamp(0.0, 65535.0) as u16;
        }
        for (o, &i) in out.iter_mut().zip(q.iter()) {
            *o = post[i as usize];
        }
        std::hint::black_box(&out);
        t.elapsed().as_secs_f64() * 1e3
    };

    let rounds = 11usize;
    let (mut ta, mut tb) = (Vec::new(), Vec::new());
    for r in 0..rounds {
        if r % 2 == 0 {
            ta.push(run_a(&mut out));
            tb.push(run_b(&mut out, &mut q));
        } else {
            tb.push(run_b(&mut out, &mut q));
            ta.push(run_a(&mut out));
        }
    }
    let (a, b) = (median(&mut ta[1..]), median(&mut tb[1..]));
    println!("quantize_flip  {} M elems", n / 1_000_000);
    println!("  A inline clamp+cast+gather : {a:.2} ms");
    println!(
        "  B split convert + gather   : {b:.2} ms   ({:+.1}% vs A)",
        (a - b) / a * 100.0
    );
    println!(
        "  verdict: {}",
        if b < a * 0.97 {
            "item 1 WINS — split it"
        } else if b > a * 1.03 {
            "item 1 LOSES — inline already optimal"
        } else {
            "wash"
        }
    );
}
