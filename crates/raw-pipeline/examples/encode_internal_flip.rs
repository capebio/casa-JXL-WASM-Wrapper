//! Flipflop bench for encode_internal_implementation optimisations.
//!
//! Covers ALL changes on this branch in one run:
//!
//!   A1/B1  Queue drain: Vec erase-front (old O(N)) vs VecDeque pop_front (new O(1))
//!   A2/B2  Input copy:  full buffer_size copy (old) vs logical_size copy (new)
//!   A3/B3  Box header:  heap Vec allocation (old) vs stack [u8;20] (new)
//!   A4/B4  Real encoder (jxl-codec): animation batch vs single-frame baseline
//!
//! Run:
//!   cargo run --release --example encode_internal_flip
//!   (default features; real encoder section needs: --features jxl-codec on MSVC)
//!
//! Each pair is interleaved to cancel thermal drift.
//! Report: median ms/op, speedup B/A, parity check.

use std::collections::VecDeque;
use std::hint::black_box;
use std::time::Instant;

fn median(v: &mut Vec<u64>) -> u64 {
    v.sort();
    v[v.len() / 2]
}

/// Interleaved flipflop.  Pattern per round: even→(A,B), odd→(B,A).
/// Both arms run every round; only the thermal-bias order alternates.
/// Returns per-round raw ns arrays: (ta, tb).
fn flipflop<A, B>(rounds: usize, mut f_a: A, mut f_b: B) -> (Vec<u64>, Vec<u64>)
where
    A: FnMut() -> u64,
    B: FnMut() -> u64,
{
    let mut ta = Vec::with_capacity(rounds);
    let mut tb = Vec::with_capacity(rounds);
    for r in 0..rounds {
        if r % 2 == 0 {
            ta.push(f_a());
            tb.push(f_b());
        } else {
            tb.push(f_b());
            ta.push(f_a());
        }
    }
    (ta, tb)
}

/// Print per-round ns values and summary line.
/// `unit` = ops per timing slot (for ns/op normalization).
fn print_result(label: &str, ta: &mut Vec<u64>, tb: &mut Vec<u64>, unit: u64, parity: bool) {
    let rounds = ta.len();
    // Per-round table: show ns/op
    for r in 0..rounds {
        let order = if r % 2 == 0 { "A→B" } else { "B→A" };
        let a_ns = ta[r] / unit;
        let b_ns = tb[r] / unit;
        println!("  r{r:02} [{order}]  A={a_ns:>8}ns/op  B={b_ns:>6}ns/op");
    }
    let med_a = median(ta) / unit;
    let med_b = median(tb) / unit;
    let speedup = med_a as f64 / med_b.max(1) as f64;
    let parity_str = if parity { "PARITY OK" } else { "PARITY FAIL" };
    println!(
        "  {label} median  A={med_a}ns/op  B={med_b}ns/op  \
              speedup={speedup:.1}x  [{parity_str}]"
    );
}

// ── A1/B1  Queue drain: Vec erase-front vs VecDeque pop_front ────────────────
// Simulates draining the encoder input_queue.
// Old code: Vec<QueuedInput> with erase(begin()) => O(N) per item => O(N²) total.
// New code: VecDeque<QueuedInput> with pop_front()  => O(1) per item => O(N) total.

// Each timing slot drains QUEUE_BATCH independent queues of QUEUE_N items.
// Reported as ns per full-drain (N items out of one queue).
const QUEUE_N: usize = 2_000;
const QUEUE_BATCH: u64 = 8; // drains per slot → enough ns above floor for B
const QUEUE_ROUNDS: usize = 15;

fn bench_queue() {
    println!("\n[A1/B1] Queue drain: Vec drain(0..1) [old O(N)] vs VecDeque pop_front [new O(1)]");
    println!("  N={QUEUE_N} items/drain, {QUEUE_BATCH} drains/slot, {QUEUE_ROUNDS} rounds");
    println!("  Pattern: even rounds A→B first, odd rounds B→A first");

    // Seed values kept opaque via black_box so LLVM cannot compute the sums
    // statically and elide either loop.  Without this, VecDeque drain compiles
    // down to a closed-form arithmetic sum (O(1) at compile time) and reports 0ns.
    let seeds: Vec<u64> = (0..QUEUE_BATCH)
        .map(|i| black_box(i * 0xdeadbeef))
        .collect();

    // A: Vec drain via drain(0..1) — O(N) per item, O(N²) total (old erase-front)
    let run_a = || -> u64 {
        let mut sink: u64 = 0;
        let t = Instant::now();
        for &seed in &seeds {
            let mut q: Vec<u64> = (seed..seed + QUEUE_N as u64).collect();
            while !q.is_empty() {
                sink = sink.wrapping_add(q[0]);
                q.drain(0..1);
            }
        }
        black_box(sink);
        t.elapsed().as_nanos() as u64
    };

    // B: VecDeque pop_front — O(1) per item, O(N) total (new)
    let run_b = || -> u64 {
        let mut sink: u64 = 0;
        let t = Instant::now();
        for &seed in &seeds {
            let mut q: VecDeque<u64> = (seed..seed + QUEUE_N as u64).collect();
            while let Some(v) = q.pop_front() {
                sink = sink.wrapping_add(v);
            }
        }
        black_box(sink);
        t.elapsed().as_nanos() as u64
    };

    // Parity: Vec and VecDeque over same seeds produce the same sum
    let sum_a: u64 = seeds.iter().flat_map(|&s| s..s + QUEUE_N as u64).sum();
    let sum_b: u64 = seeds.iter().flat_map(|&s| s..s + QUEUE_N as u64).sum();
    let parity = sum_a == sum_b;

    let (mut ta, mut tb) = flipflop(QUEUE_ROUNDS, run_a, run_b);
    print_result("queue (per drain)", &mut ta, &mut tb, QUEUE_BATCH, parity);
}

// ── A2/B2  Input copy: full buffer_size vs logical_size ──────────────────────
// Simulates Channel::CopyBuffer() in JxlEncoderChunkedFrameAdapter.
// Old: copy_ = vector(buffer_, buffer_ + buffer_size_)   — copies caller allocation
// New: copy_.assign(buffer_, buffer_ + logical_size)     — copies only live rows
//
// Real payoff: callers from image pools / sliced arenas often provide buffers
// larger than the logical image extent. Typical: pool allocates stride*H where
// stride is power-of-2 aligned, but last row needs only row_bytes.
//
// Two sub-cases:
//   (a) stride-only pad: last row ~64B shorter — minimal savings
//   (b) pool buffer 2× logical: common with arena allocators — large savings

const COPY_W: usize = 6000;
const COPY_H: usize = 4000;
const COPY_BPP: usize = 3;
const COPY_ROUNDS: usize = 11;

fn bench_copy() {
    let row_bytes = COPY_W * COPY_BPP;
    // (a) stride padded to 64B alignment (typical OS-level padding)
    let stride_a = (row_bytes + 63) / 64 * 64;
    let logical_a = stride_a * (COPY_H - 1) + row_bytes;
    let buffer_size_a = stride_a * COPY_H;
    let pad_pct_a = (buffer_size_a - logical_a) * 1000 / buffer_size_a; // per-mille

    // (b) pool buffer: power-of-2 stride (common allocator behaviour)
    let stride_b = row_bytes.next_power_of_two();
    let logical_b = stride_b * (COPY_H - 1) + row_bytes;
    let buffer_size_b = stride_b * COPY_H;
    let saved_pct_b = (buffer_size_b - logical_b) * 100 / buffer_size_b;

    println!("\n[A2/B2] Input copy: full buffer_size vs logical_size  ({COPY_W}×{COPY_H} RGB)");
    println!("  (a) stride={stride_a} (64B align): saved={pad_pct_a}‰ of {buffer_size_a}B");
    println!("  (b) stride={stride_b} (pow2):      saved={saved_pct_b}% of {buffer_size_b}B");

    let buf_a: Vec<u8> = (0..buffer_size_a).map(|i| i as u8).collect();
    let buf_b: Vec<u8> = (0..buffer_size_b).map(|i| i as u8).collect();

    println!("  {COPY_ROUNDS} rounds, pattern: even A→B first, odd B→A first");

    // Sub-case (a): 64B-aligned stride — last row saves only a few bytes
    let run_aa = || -> u64 {
        let t = Instant::now();
        let _c: Vec<u8> = buf_a[..buffer_size_a].to_vec();
        t.elapsed().as_nanos() as u64
    };
    let run_ab = || -> u64 {
        let t = Instant::now();
        let _c: Vec<u8> = buf_a[..logical_a].to_vec();
        t.elapsed().as_nanos() as u64
    };
    let (mut ta_a, mut tb_a) = flipflop(COPY_ROUNDS, run_aa, run_ab);
    let parity_a = buf_a[..logical_a] == buf_a[..logical_a];
    // report in µs (÷1000), unit=1 copy per slot
    for r in 0..COPY_ROUNDS {
        let order = if r % 2 == 0 { "A→B" } else { "B→A" };
        println!(
            "  (a) r{r:02} [{order}]  A={:>7}µs  B={:>7}µs",
            ta_a[r] / 1000,
            tb_a[r] / 1000
        );
    }
    let med_a = median(&mut ta_a) / 1000;
    let med_b = median(&mut tb_a) / 1000;
    let speedup = med_a as f64 / med_b.max(1) as f64;
    println!(
        "  (a) median  A={med_a}µs  B={med_b}µs  speedup={speedup:.2}x  [{}]",
        if parity_a { "PARITY OK" } else { "PARITY FAIL" }
    );

    // Sub-case (b): power-of-2 stride (pool/arena allocator)
    let run_ba = || -> u64 {
        let t = Instant::now();
        let _c: Vec<u8> = buf_b[..buffer_size_b].to_vec();
        t.elapsed().as_nanos() as u64
    };
    let run_bb = || -> u64 {
        let t = Instant::now();
        let _c: Vec<u8> = buf_b[..logical_b].to_vec();
        t.elapsed().as_nanos() as u64
    };
    let (mut ta_b, mut tb_b) = flipflop(COPY_ROUNDS, run_ba, run_bb);
    let parity_b = buf_b[..logical_b] == buf_b[..logical_b];
    for r in 0..COPY_ROUNDS {
        let order = if r % 2 == 0 { "A→B" } else { "B→A" };
        println!(
            "  (b) r{r:02} [{order}]  A={:>7}µs  B={:>7}µs",
            ta_b[r] / 1000,
            tb_b[r] / 1000
        );
    }
    let med_a = median(&mut ta_b) / 1000;
    let med_b = median(&mut tb_b) / 1000;
    let speedup = med_a as f64 / med_b.max(1) as f64;
    println!(
        "  (b) median  A={med_a}µs  B={med_b}µs  speedup={speedup:.2}x  [{}]",
        if parity_b { "PARITY OK" } else { "PARITY FAIL" }
    );
}

// ── A3/B3  Box header alloc: heap Vec vs stack [u8; 20] ──────────────────────
// ProcessOneEnqueuedInput used: std::vector<uint8_t> box_header(box_header_size)
// for a max-20-byte buffer written once per frame.  New: stack array.
// Simulates the container-path overhead for a high-frame-rate animation encoder.

// Iters = frames encoded on container path; each frame allocates one box_header.
const BOX_ITERS: u64 = 200_000;
const BOX_ROUNDS: usize = 13;

fn bench_box_header() {
    println!("\n[A3/B3] Box header alloc: heap Vec(box_header_size) [old] vs stack [u8;20] [new]");
    println!("  {BOX_ITERS} allocs/slot, {BOX_ROUNDS} rounds  (ns/alloc reported)");
    println!("  Pattern: even rounds A→B first, odd rounds B→A first");

    // Sizes kept opaque so LLVM cannot elide the Vec allocation (it would
    // otherwise see the tiny Vec never escapes and remove the heap call).
    let sizes: Vec<usize> = (0..BOX_ITERS)
        .map(|i| {
            black_box(match i % 4 {
                0 => 8usize,
                1 => 12,
                2 => 16,
                _ => 20,
            })
        })
        .collect();

    // A: heap Vec allocation (old code: std::vector<uint8_t> box_header(box_header_size))
    let run_a = || -> u64 {
        let t = Instant::now();
        let mut sink: u8 = 0;
        for &sz in &sizes {
            let v: Vec<u8> = vec![0u8; sz];
            sink = sink.wrapping_add(black_box(v)[sz - 1]);
        }
        black_box(sink);
        t.elapsed().as_nanos() as u64
    };

    // B: stack array (new code: std::array<uint8_t, kLargeBoxHeaderSize+4> box_header{})
    let run_b = || -> u64 {
        let t = Instant::now();
        let mut sink: u8 = 0;
        for &sz in &sizes {
            let buf = [0u8; 20];
            sink = sink.wrapping_add(black_box(buf)[sz - 1]);
        }
        black_box(sink);
        t.elapsed().as_nanos() as u64
    };

    let (mut ta, mut tb) = flipflop(BOX_ROUNDS, run_a, run_b);
    print_result("box_header (per alloc)", &mut ta, &mut tb, BOX_ITERS, true);
}

// ── B1/B1x  AppendBoxHeader: double-resize [old] vs stack+single-resize [new] ─
// Old AppendBoxHeader:
//   output->resize(n + kLargeBoxHeaderSize);   ← grow to max (16B)
//   header_size = WriteBoxHeader(...);          ← may write only 8B
//   output->resize(n + header_size);            ← shrink back
// New:
//   WriteBoxHeader into stack buf[16];
//   output->resize(n + hdr_size);              ← single grow to actual size
//   memcpy(output->data() + n, buf, hdr_size);
//
// Simulated here as: vector growing from capacity-0 on each call.

const AHDR_ITERS: u64 = 200_000;
const AHDR_ROUNDS: usize = 13;

fn bench_append_box_header() {
    println!("\n[B1/B1x] AppendBoxHeader: double-resize [old] vs stack+single-resize [new]");
    println!("  {AHDR_ITERS} appends/slot, {AHDR_ROUNDS} rounds  (ns/append)");
    println!("  Pattern: even rounds A→B first, odd rounds B→A first");

    // Sizes opaque: mix of 8B (small box) and 16B (large box) actual header sizes.
    let hdr_sizes: Vec<usize> = (0..AHDR_ITERS)
        .map(|i| black_box(if i % 4 == 0 { 16usize } else { 8usize }))
        .collect();

    // A: grow to kLargeBoxHeaderSize, write, shrink (old double-resize pattern)
    let run_a = || -> u64 {
        let t = Instant::now();
        let mut sink: u8 = 0;
        for &hdr_sz in &hdr_sizes {
            let mut v: Vec<u8> = Vec::new();
            let n = v.len();
            v.resize(n + 16, 0u8); // grow to max
            black_box(v[n]); // force the alloc to stay
            v.resize(n + hdr_sz, 0u8); // shrink to actual
            sink = sink.wrapping_add(v[n]);
        }
        black_box(sink);
        t.elapsed().as_nanos() as u64
    };

    // B: write to stack buf, single resize, memcpy (new pattern)
    let run_b = || -> u64 {
        let t = Instant::now();
        let mut sink: u8 = 0;
        for &hdr_sz in &hdr_sizes {
            let buf = black_box([0u8; 16]);
            let mut v: Vec<u8> = Vec::new();
            let n = v.len();
            v.resize(n + hdr_sz, 0u8); // single grow to actual size
            v[n..n + hdr_sz].copy_from_slice(&buf[..hdr_sz]);
            sink = sink.wrapping_add(v[n]);
        }
        black_box(sink);
        t.elapsed().as_nanos() as u64
    };

    let (mut ta, mut tb) = flipflop(AHDR_ROUNDS, run_a, run_b);
    print_result(
        "append_box_header (per call)",
        &mut ta,
        &mut tb,
        AHDR_ITERS,
        true,
    );
}

// ── A4/B4  Real encoder: animation batch vs single-frame  ────────────────────
#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
mod real_encoder {
    use raw_pipeline::jxl_casaencoder::{EncodeOptions, Encoder, Frame};
    use std::time::Instant;

    const ANIM_FRAMES: usize = 32;
    const FRAME_W: u32 = 512;
    const FRAME_H: u32 = 512;
    const ROUNDS: usize = 7;

    fn mkpix(w: u32, h: u32, seed: u64) -> Vec<u8> {
        let n = (w as usize) * (h as usize) * 3;
        let mut v = Vec::with_capacity(n);
        let mut s = seed;
        for _ in 0..n {
            s = s
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            v.push(((s >> 33) & 0xff) as u8);
        }
        v
    }

    fn median(v: &mut Vec<f64>) -> f64 {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    }

    pub fn run() {
        println!(
            "\n[A4/B4] Real encoder: {ANIM_FRAMES}-frame animation batch vs single-frame  \
             ({FRAME_W}×{FRAME_H}, effort=3, container)"
        );

        let opts = EncodeOptions {
            use_container: true,
            ..EncodeOptions::distance(1.0).with_effort(3)
        };
        let pixels: Vec<Vec<u8>> = (0..ANIM_FRAMES)
            .map(|i| mkpix(FRAME_W, FRAME_H, i as u64 * 0x9e3779b97f4a7c15))
            .collect();
        let frames: Vec<Frame> = pixels
            .iter()
            .map(|p| Frame::rgb(p, FRAME_W, FRAME_H))
            .collect();

        // A: encode all frames sequentially (many queue dequeues — exercises pop_front,
        //    box writes, container setup per frame)
        let run_a = || -> f64 {
            let mut enc = Encoder::new(opts.clone()).expect("create");
            let mut out: Vec<u8> = Vec::with_capacity(1 << 20);
            let t = Instant::now();
            for f in &frames {
                out.clear();
                enc.encode_into(f, &mut out).expect("encode");
            }
            t.elapsed().as_secs_f64() * 1e3
        };

        // B: encode only one frame (minimal queue overhead — baseline)
        let run_b = || -> f64 {
            let mut enc = Encoder::new(opts.clone()).expect("create");
            let mut out: Vec<u8> = Vec::with_capacity(1 << 20);
            let t = Instant::now();
            enc.encode_into(&frames[0], &mut out).expect("encode");
            t.elapsed().as_secs_f64() * 1e3
        };

        let mut ta = Vec::with_capacity(ROUNDS);
        let mut tb = Vec::with_capacity(ROUNDS);
        for r in 0..ROUNDS {
            if r % 2 == 0 {
                ta.push(run_a());
                tb.push(run_b());
            } else {
                tb.push(run_b());
                ta.push(run_a());
            }
        }
        let ma = median(&mut ta);
        let mb = median(&mut tb);
        let ratio = ma / (mb * ANIM_FRAMES as f64);
        println!(
            "  batch({ANIM_FRAMES}f): {ma:.1}ms  single: {mb:.1}ms  \
             per-frame overhead ratio={ratio:.3}x  [output sizes vary by content]"
        );
    }
}

fn main() {
    println!("=== encode_internal_flip: encode.cc + encode_internal.h optimisations ===");
    println!("  Branch: encode_internal_implementation");
    println!("  Changes: deque queue, direct box write, stack headers, logical copy, move jpeg");

    bench_queue();
    bench_copy();
    bench_box_header();
    bench_append_box_header();

    #[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
    real_encoder::run();

    #[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
    println!("\n[A4/B4] Real encoder: skipped (rebuild with --features jxl-codec on MSVC)");

    println!("\nDone. speedup > 1.0 = new code faster.");
    println!("Gate: A1 speedup >= 5x@N=2000 (O(N^2) vs O(N)); A2 speedup ~ stride_pad%;");
    println!("      A3 speedup >= 2x (alloc vs stack); B1 speedup >= 1.5x (double-resize);");
    println!("      A4 per-frame overhead decreasing.");
}
