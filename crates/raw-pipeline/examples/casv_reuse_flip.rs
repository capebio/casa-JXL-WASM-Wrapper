//! Focused flip: fresh `Decoder` per decode (baseline `decode_interleaved`)
//! vs one persistent `Decoder` + reused `decode_into_dims` buffer, on the real
//! u16 bbox-residual payloads of the archive-tier golden file. Interleaved
//! A,B,A,B with per-decode timing; asserts byte equality per pair.
//!
//!   cargo run --release --example casv_reuse_flip -- <arch.casv> [iters]

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn main() {
    use raw_pipeline::casa_video::{casv_frame_info, parse_casv_header};
    use raw_pipeline::jxl_casadecoder::{decode_interleaved, Channels, DecodeOptions, Decoder};
    use std::time::Instant;

    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| r"C:\Tmp\jf-cvdec-golden\arch_bbox_g24.casv".to_string());
    let iters: usize = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(24);
    let data = std::fs::read(&path).unwrap();
    let hdr = parse_casv_header(&data).expect("header casv");

    // Collect the u16 residual payloads of every bbox P-frame (skip 8-byte rect).
    let mut payloads: Vec<&[u8]> = Vec::new();
    for i in 0..hdr.frame_count as usize {
        let (is_p, slice) = casv_frame_info(&data, i).unwrap();
        if is_p && slice.len() > 8 {
            payloads.push(&slice[8..]);
        }
    }
    assert!(!payloads.is_empty(), "no P-frames in {path}");
    println!("{} P-frame residual payloads; {iters} interleaved iters", payloads.len());

    let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
    let mut buf: Vec<u16> = Vec::new();
    let mut t_fresh = Vec::new();
    let mut t_reuse = Vec::new();
    for it in 0..iters {
        let fresh_first = it % 2 == 0;
        for arm in 0..2 {
            let fresh = (arm == 0) == fresh_first;
            let t = Instant::now();
            let mut sink = 0u64;
            if fresh {
                for p in &payloads {
                    let (px, _, _) = decode_interleaved::<u16>(p, 3).unwrap();
                    sink = sink.wrapping_add(px[0] as u64).wrapping_add(px[px.len() - 1] as u64);
                }
                t_fresh.push(t.elapsed().as_secs_f64() * 1000.0);
            } else {
                for p in &payloads {
                    dec.decode_into_dims::<u16>(p, Channels::Rgb, &mut buf).unwrap();
                    sink = sink.wrapping_add(buf[0] as u64).wrapping_add(buf[buf.len() - 1] as u64);
                }
                t_reuse.push(t.elapsed().as_secs_f64() * 1000.0);
            }
            std::hint::black_box(sink);
        }
    }
    // Byte-equality proof once (not timed).
    for p in &payloads {
        let (px, _, _) = decode_interleaved::<u16>(p, 3).unwrap();
        dec.decode_into_dims::<u16>(p, Channels::Rgb, &mut buf).unwrap();
        assert_eq!(px, buf, "reuse decode must be byte-identical");
    }
    let med = |v: &mut Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    };
    let (mf, mr) = (med(&mut t_fresh), med(&mut t_reuse));
    println!(
        "fresh-per-decode {mf:>8.1} ms | persistent+reuse {mr:>8.1} ms | delta {:>+6.2}%  (byte-equal)",
        (mr / mf - 1.0) * 100.0
    );
}

#[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("casv_reuse_flip requires --features jxl-codec on a native target");
}
