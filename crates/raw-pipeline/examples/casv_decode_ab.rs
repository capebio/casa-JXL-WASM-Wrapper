//! CASV decode interleaved A/B harness (cv-dec agent, 2026-07-02).
//!
//! OLD = verbatim replica of the baseline (main @a3bc6e7a) decode algorithm:
//! per-frame fresh `Decoder` via `decode_interleaved`, fresh output Vecs, serial
//! frame loop, per-frame `recon.clone()`, footer path re-frames the whole file.
//! NEW = the current library entry points.
//!
//! Arms run interleaved with start-rotation (flipflop) so thermal drift cancels;
//! every rep asserts NEW output == OLD output byte-for-byte.
//!
//! Usage, from `crates/raw-pipeline` (MSVC release):
//!   cargo run --release --example casv_decode_ab -- <corpus_dir> [reps]

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
mod old {
    //! Byte-for-byte replica of the BASELINE decode path (public API only).
    use raw_pipeline::casa_video::{
        casv_frame_info, casv_frame_is_bbox, casv_frame_is_replace, casv_frame_is_tile,
        parse_casv_footer, parse_casv_header, CasvHeader, CASV_HEADER_BYTES,
        CASV_INDEX_ENTRY_BYTES,
    };
    use raw_pipeline::jxl_casadecoder::decode_interleaved;

    fn tile_grid(width: u32, height: u32, tile: u32) -> (u32, u32) {
        (width.div_ceil(tile), height.div_ceil(tile))
    }

    fn blit_into(dst: &mut [u8], width: u32, x: u32, y: u32, bw: u32, bh: u32, crop: &[u8]) {
        let (w, x, y, bw, bh) = (
            width as usize,
            x as usize,
            y as usize,
            bw as usize,
            bh as usize,
        );
        for row in 0..bh {
            let d = ((y + row) * w + x) * 3;
            let s = row * bw * 3;
            dst[d..d + bw * 3].copy_from_slice(&crop[s..s + bw * 3]);
        }
    }

    fn add_residual16_into(base: &mut [u8], resid: &[u16]) {
        for (b, &r) in base.iter_mut().zip(resid) {
            *b = (*b as i32 + r as i32 - 32768).clamp(0, 255) as u8;
        }
    }

    fn apply_pframe(
        prev: &mut [u8],
        is_bbox: bool,
        is_tile: bool,
        is_replace: bool,
        slice: &[u8],
        width: u32,
        height: u32,
    ) -> Option<()> {
        if is_tile {
            if slice.len() < 2 {
                return None;
            }
            let t = u16::from_le_bytes(slice[0..2].try_into().unwrap()) as u32;
            if t == 0 {
                return None;
            }
            let (txn, tyn) = tile_grid(width, height, t);
            let n = (txn * tyn) as usize;
            let bitmap_len = n.div_ceil(8);
            if slice.len() < 2 + bitmap_len {
                return None;
            }
            let bitmap = &slice[2..2 + bitmap_len];
            let changed: Vec<usize> = (0..n)
                .filter(|&i| bitmap[i / 8] & (1 << (i % 8)) != 0)
                .collect();
            if changed.is_empty() {
                return Some(());
            }
            let (w, ts) = (width as usize, t as usize);
            if is_replace {
                let (atlas, aw, ah) = decode_interleaved::<u8>(&slice[2 + bitmap_len..], 3)?;
                if aw != t || ah != t * changed.len() as u32 {
                    return None;
                }
                for (slot, &i) in changed.iter().enumerate() {
                    let tx = (i as u32 % txn) as usize;
                    let ty = (i as u32 / txn) as usize;
                    let bw = ts.min(w - tx * ts);
                    let bh = ts.min(height as usize - ty * ts);
                    for row in 0..bh {
                        let d = ((ty * ts + row) * w + tx * ts) * 3;
                        let s = ((slot * ts + row) * ts) * 3;
                        prev[d..d + bw * 3].copy_from_slice(&atlas[s..s + bw * 3]);
                    }
                }
                return Some(());
            }
            let (atlas, aw, ah) = decode_interleaved::<u16>(&slice[2 + bitmap_len..], 3)?;
            if aw != t || ah != t * changed.len() as u32 {
                return None;
            }
            for (slot, &i) in changed.iter().enumerate() {
                let tx = (i as u32 % txn) as usize;
                let ty = (i as u32 / txn) as usize;
                let bw = ts.min(w - tx * ts);
                let bh = ts.min(height as usize - ty * ts);
                for row in 0..bh {
                    for col in 0..bw {
                        let asrc = ((slot * ts + row) * ts + col) * 3;
                        let fdst = ((ty * ts + row) * w + tx * ts + col) * 3;
                        for c in 0..3 {
                            prev[fdst + c] = (prev[fdst + c] as i32 + atlas[asrc + c] as i32
                                - 32768)
                                .clamp(0, 255) as u8;
                        }
                    }
                }
            }
            return Some(());
        }
        if !is_bbox {
            let (resid, _, _) = decode_interleaved::<u16>(slice, 3)?;
            if resid.len() != prev.len() {
                return None;
            }
            add_residual16_into(prev, &resid);
            return Some(());
        }
        if slice.len() < 8 {
            return None;
        }
        let rd = |o: usize| u16::from_le_bytes(slice[o..o + 2].try_into().unwrap()) as u32;
        let (x, y, bw, bh) = (rd(0), rd(2), rd(4), rd(6));
        if bw == 0 || bh == 0 {
            return Some(());
        }
        if is_replace {
            let (pixels, dw, dh) = decode_interleaved::<u8>(&slice[8..], 3)?;
            if dw != bw || dh != bh || pixels.len() != (bw * bh * 3) as usize {
                return None;
            }
            blit_into(prev, width, x, y, bw, bh, &pixels);
            return Some(());
        }
        let (resid, dw, dh) = decode_interleaved::<u16>(&slice[8..], 3)?;
        if dw != bw || dh != bh || resid.len() != (bw * bh * 3) as usize {
            return None;
        }
        let w = width as usize;
        for row in 0..bh as usize {
            let dst = ((y as usize + row) * w + x as usize) * 3;
            let srow = row * bw as usize * 3;
            for c in 0..(bw as usize * 3) {
                prev[dst + c] =
                    (prev[dst + c] as i32 + resid[srow + c] as i32 - 32768).clamp(0, 255) as u8;
            }
        }
        Some(())
    }

    pub fn decode_casv_all_rgb8(data: &[u8]) -> Option<Vec<(Vec<u8>, u32, u32)>> {
        let hdr = parse_casv_header(data)?;
        let (w, h) = (hdr.width, hdr.height);
        let mut out = Vec::with_capacity(hdr.frame_count as usize);
        let mut prev: Option<Vec<u8>> = None;
        for i in 0..hdr.frame_count as usize {
            let (is_p, slice) = casv_frame_info(data, i)?;
            let recon = if is_p {
                let mut base = prev.take()?;
                apply_pframe(
                    &mut base,
                    casv_frame_is_bbox(data, i)?,
                    casv_frame_is_tile(data, i)?,
                    casv_frame_is_replace(data, i)?,
                    slice,
                    w,
                    h,
                )?;
                base
            } else {
                let (px, dw, dh) = decode_interleaved::<u8>(slice, 3)?;
                if (dw, dh) != (w, h) {
                    return None;
                }
                px
            };
            prev = Some(recon.clone());
            out.push((recon, w, h));
        }
        Some(out)
    }

    pub fn decode_casv_footer_all_rgb8(data: &[u8]) -> Option<Vec<(Vec<u8>, u32, u32)>> {
        let f = parse_casv_footer(data)?;
        let n = f.frame_count as usize;
        let idx_start = f.index_offset as usize;
        let new_data_start = CASV_HEADER_BYTES + n * CASV_INDEX_ENTRY_BYTES;
        let delta = new_data_start as u32;

        let hdr = CasvHeader {
            width: f.width,
            height: f.height,
            frame_count: f.frame_count,
            fps_num: f.fps_num,
            fps_den: f.fps_den,
            flags: 0,
        };
        let mut out = Vec::with_capacity(new_data_start + idx_start);
        out.extend_from_slice(&raw_pipeline::casa_video::build_casv_header(&hdr));
        for i in 0..n {
            let e = idx_start + i * CASV_INDEX_ENTRY_BYTES;
            let off = u32::from_le_bytes(data[e..e + 4].try_into().ok()?);
            let lenf = u32::from_le_bytes(data[e + 4..e + 8].try_into().ok()?);
            out.extend_from_slice(&off.checked_add(delta)?.to_le_bytes());
            out.extend_from_slice(&lenf.to_le_bytes());
        }
        out.extend_from_slice(&data[0..idx_start]);
        decode_casv_all_rgb8(&out)
    }
}

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn main() {
    use raw_pipeline::casa_video::{
        decode_casv_all_rgb8, decode_casv_footer_all_rgb8, parse_casv_header,
    };
    use std::time::Instant;

    let dir = std::env::args()
        .nth(1)
        .unwrap_or_else(|| r"C:\Tmp\jf-cvdec-golden".to_string());
    let reps: usize = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);

    let mut names: Vec<_> = std::fs::read_dir(&dir)
        .expect("read corpus dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "casv"))
        .collect();
    names.sort();

    println!(
        "CASV decode A/B (interleaved, {reps} reps, rotation): OLD=baseline replica NEW=library"
    );
    for p in &names {
        let data = std::fs::read(p).unwrap();
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        let is_footer = parse_casv_header(&data).is_none();

        let run_old = || {
            if is_footer {
                old::decode_casv_footer_all_rgb8(&data).expect("old decode")
            } else {
                old::decode_casv_all_rgb8(&data).expect("old decode")
            }
        };
        let run_new = || {
            if is_footer {
                decode_casv_footer_all_rgb8(&data).expect("new decode")
            } else {
                decode_casv_all_rgb8(&data).expect("new decode")
            }
        };

        let mut t_old = Vec::with_capacity(reps);
        let mut t_new = Vec::with_capacity(reps);
        for rep in 0..reps {
            // start-rotation: alternate which arm goes first each rep.
            let (mut o, mut n) = (None, None);
            let order_old_first = rep % 2 == 0;
            for arm in 0..2 {
                let old_turn = (arm == 0) == order_old_first;
                if old_turn {
                    let t = Instant::now();
                    o = Some(run_old());
                    t_old.push(t.elapsed().as_secs_f64() * 1000.0);
                } else {
                    let t = Instant::now();
                    n = Some(run_new());
                    t_new.push(t.elapsed().as_secs_f64() * 1000.0);
                }
            }
            let (o, n) = (o.unwrap(), n.unwrap());
            assert_eq!(o.len(), n.len(), "{name}: frame count");
            for (i, (a, b)) in o.iter().zip(n.iter()).enumerate() {
                assert_eq!(a.0, b.0, "{name}: frame {i} bytes differ OLD vs NEW");
                assert_eq!((a.1, a.2), (b.1, b.2), "{name}: frame {i} dims");
            }
        }
        let med = |v: &mut Vec<f64>| {
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            v[v.len() / 2]
        };
        let (mo, mn) = (med(&mut t_old), med(&mut t_new));
        println!(
            "{name:<24} OLD {mo:>8.1} ms  NEW {mn:>8.1} ms  delta {:>+6.1}%  (byte-equal all {reps} reps)",
            (mn / mo - 1.0) * 100.0
        );
    }
}

#[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("casv_decode_ab requires --features jxl-codec on a native target");
}
