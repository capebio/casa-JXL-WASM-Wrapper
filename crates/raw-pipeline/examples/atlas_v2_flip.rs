//! atlas_v2_flip — interleaved A/B for the JE-8 square-atlas (v2) tile P-frame
//! layout vs the old t-wide sliver (v1):
//!
//!   A = v1 sliver atlas   (local verbatim copy of the pre-JE-8 batch encoder)
//!   B = v2 square atlas   (production encode_casv_delta_lossy_tiled_rgb8)
//!
//! Both arms use the identical change detection (verbatim copy) so the changed
//! tile sets match; only the atlas geometry differs. Reported per tile size:
//! encoded bytes, enc/dec ms per frame (interleaved rounds, round 0 dropped,
//! median), and mean reconstruction error vs source (lossy tier — v1 and v2
//! quantize different neighbourhoods, so outputs differ slightly by design).
//!
//! Run (MSVC, release), from crates/raw-pipeline:
//!   ..\..\build-msvc.ps1 run --release --example atlas_v2_flip --features jxl-codec -- <frames_dir>
#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn main() {
    use raw_pipeline::casa_video::{
        decode_casv_all_rgb8, encode_casv_delta_lossy_tiled_rgb8, CASV_BBOX_FLAG, CASV_PFRAME_FLAG,
        CASV_REPLACE_FLAG, CASV_TILE_FLAG,
    };
    use raw_pipeline::jxl_casaencoder::{encode_rgb8, EncodeOptions};
    use std::time::Instant;

    // ── verbatim copies of the private helpers (must match casa_video.rs) ──
    fn tile_grid(width: u32, height: u32, tile: u32) -> (u32, u32) {
        (width.div_ceil(tile), height.div_ceil(tile))
    }
    fn changed_tile_map_thresh(
        cur: &[u8], prev: &[u8], width: u32, height: u32, tile: u32, thresh: u8,
    ) -> Vec<bool> {
        let (txn, tyn) = tile_grid(width, height, tile);
        let (w, t) = (width as usize, tile as usize);
        let th = thresh as i32;
        let mut map = vec![false; (txn * tyn) as usize];
        for ty in 0..tyn as usize {
            for tx in 0..txn as usize {
                let x0 = tx * t;
                let y0 = ty * t;
                let bw = t.min(w - x0);
                let bh = t.min(height as usize - y0);
                let mut changed = false;
                'tile: for row in 0..bh {
                    let base = ((y0 + row) * w + x0) * 3;
                    for c in 0..bw * 3 {
                        if (cur[base + c] as i32 - prev[base + c] as i32).abs() > th {
                            changed = true;
                            break 'tile;
                        }
                    }
                }
                map[ty * txn as usize + tx] = changed;
            }
        }
        map
    }

    /// Verbatim pre-JE-8 batch lossy tiled encoder (v1 sliver atlas) —
    /// frame-parallel like production, so enc timings are apples-to-apples.
    fn encode_v1_sliver(
        frames: &[&[u8]], width: u32, height: u32, gop_len: u32, tile: u32,
        opts: &EncodeOptions, thresh: u8,
    ) -> Vec<u8> {
        use rayon::prelude::*;
        const HEADER: usize = 32;
        const ENTRY: usize = 8;
        let gop = gop_len.max(1) as usize;
        let t = tile.max(1);
        let (txn, _tyn) = tile_grid(width, height, t);
        let (w, ts) = (width as usize, t as usize);
        let streams: Vec<(u32, Vec<u8>)> = (0..frames.len())
            .into_par_iter()
            .map(|idx| {
                let px = frames[idx];
                if idx % gop == 0 {
                    return (0, encode_rgb8(px, width, height, opts.clone()).unwrap());
                }
                let map = changed_tile_map_thresh(px, frames[idx - 1], width, height, t, thresh);
                let changed: Vec<usize> =
                    map.iter().enumerate().filter(|(_, &c)| c).map(|(i, _)| i).collect();
                let mut payload = Vec::new();
                payload.extend_from_slice(&(t as u16).to_le_bytes()); // v1: bit clear
                let mut bitmap = vec![0u8; map.len().div_ceil(8)];
                for &i in &changed {
                    bitmap[i / 8] |= 1 << (i % 8);
                }
                payload.extend_from_slice(&bitmap);
                if !changed.is_empty() {
                    let mut atlas = vec![0u8; ts * ts * 3 * changed.len()];
                    for (slot, &i) in changed.iter().enumerate() {
                        let tx = (i as u32 % txn) as usize;
                        let ty = (i as u32 / txn) as usize;
                        let bw = ts.min(w - tx * ts);
                        let bh = ts.min(height as usize - ty * ts);
                        for row in 0..bh {
                            let src = ((ty * ts + row) * w + tx * ts) * 3;
                            let dst = ((slot * ts + row) * ts) * 3;
                            atlas[dst..dst + bw * 3].copy_from_slice(&px[src..src + bw * 3]);
                        }
                    }
                    let jxl =
                        encode_rgb8(&atlas, t, t * changed.len() as u32, opts.clone()).unwrap();
                    payload.extend_from_slice(&jxl);
                }
                (CASV_PFRAME_FLAG | CASV_TILE_FLAG | CASV_REPLACE_FLAG, payload)
            })
            .collect();
        let _ = CASV_BBOX_FLAG;
        let data_start = HEADER + frames.len() * ENTRY;
        let mut out = Vec::new();
        out.extend_from_slice(&0x5641_5343u32.to_le_bytes());
        out.extend_from_slice(&1u32.to_le_bytes());
        out.extend_from_slice(&width.to_le_bytes());
        out.extend_from_slice(&height.to_le_bytes());
        out.extend_from_slice(&(frames.len() as u32).to_le_bytes());
        out.extend_from_slice(&24u32.to_le_bytes());
        out.extend_from_slice(&1u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        let mut offset = data_start;
        for (flags, s) in &streams {
            out.extend_from_slice(&(offset as u32).to_le_bytes());
            out.extend_from_slice(&((s.len() as u32) | flags).to_le_bytes());
            offset += s.len();
        }
        for (_, s) in &streams {
            out.extend_from_slice(s);
        }
        out
    }

    let dir = std::env::args()
        .nth(1)
        .unwrap_or_else(|| r"C:\Foo\raw-converter\tests\real_video_ghana".to_string());
    let mut paths: Vec<_> = std::fs::read_dir(&dir)
        .expect("read frames dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "png"))
        .collect();
    paths.sort();
    let mut frames: Vec<Vec<u8>> = Vec::new();
    let (mut w, mut h) = (0u32, 0u32);
    for p in &paths {
        let img = image::open(p).expect("png").to_rgb8();
        w = img.width();
        h = img.height();
        frames.push(img.into_raw());
    }
    let refs: Vec<&[u8]> = frames.iter().map(|v| v.as_slice()).collect();
    let n = refs.len();
    println!("atlas_v2_flip: {n} frames @ {w}x{h}   A=v1 sliver  B=v2 square   (d1.0/e3, thresh 4, GOP 24)");

    let opts = EncodeOptions::distance(1.0).with_effort(3);
    let mean_err = |decoded: &[(Vec<u8>, u32, u32)]| {
        let mut s = 0f64;
        let mut c = 0usize;
        for (i, (px, _, _)) in decoded.iter().enumerate() {
            s += px.iter().zip(&frames[i]).map(|(&a, &b)| (a as i32 - b as i32).unsigned_abs() as f64).sum::<f64>();
            c += px.len();
        }
        s / c as f64
    };
    let med = |v: &[f64]| {
        let mut s: Vec<f64> = v[1..].to_vec();
        s.sort_by(|a, b| a.partial_cmp(b).unwrap());
        s[s.len() / 2]
    };

    for t in [16u32, 32] {
        let rounds = 7usize;
        let mut enc_ms: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
        let mut dec_ms: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
        let mut sizes = [0usize; 2];
        let mut errs = [0f64; 2];
        for round in 0..rounds {
            for k in 0..2 {
                let which = (round + k) % 2;
                let t0 = Instant::now();
                let bytes = if which == 0 {
                    encode_v1_sliver(&refs, w, h, 24, t, &opts, 4)
                } else {
                    encode_casv_delta_lossy_tiled_rgb8(&refs, w, h, 24, 1, 24, t, opts.clone(), 4)
                        .unwrap()
                };
                enc_ms[which].push(t0.elapsed().as_secs_f64() * 1e3 / n as f64);
                let t1 = Instant::now();
                let decoded = decode_casv_all_rgb8(&bytes).unwrap();
                dec_ms[which].push(t1.elapsed().as_secs_f64() * 1e3 / n as f64);
                sizes[which] = bytes.len();
                errs[which] = mean_err(&decoded);
            }
        }
        println!("  t={t}:");
        for (k, name) in ["A v1 sliver", "B v2 square"].iter().enumerate() {
            println!(
                "    {name}: {:>9} bytes   enc {:>6.1} ms/f   dec {:>6.2} ms/f   mean-err {:.3}",
                sizes[k], med(&enc_ms[k]), med(&dec_ms[k]), errs[k]
            );
        }
        println!(
            "    size {:+.1}%   enc {:+.1}%   dec {:+.1}%",
            (sizes[1] as f64 - sizes[0] as f64) / sizes[0] as f64 * 100.0,
            (med(&enc_ms[1]) - med(&enc_ms[0])) / med(&enc_ms[0]) * 100.0,
            (med(&dec_ms[1]) - med(&dec_ms[0])) / med(&dec_ms[0]) * 100.0,
        );
    }
}

#[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("atlas_v2_flip requires --features jxl-codec on a native target");
}
