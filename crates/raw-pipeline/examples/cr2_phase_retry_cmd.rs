use raw_pipeline::{cr2, demosaic};
use std::{env, fs, process};

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("{msg}");
    process::exit(2);
}

fn hash_rgb16(rgb: &[u16]) -> (u64, u64) {
    let mut a = 0xcbf2_9ce4_8422_2325u64;
    let mut b = 0x9e37_79b9_7f4a_7c15u64 ^ (rgb.len() as u64);
    for &v in rgb {
        let x = v as u64;
        a ^= x & 0xff;
        a = a.wrapping_mul(0x100_0000_01b3);
        a ^= x >> 8;
        a = a.wrapping_mul(0x100_0000_01b3);
        b ^= x
            .wrapping_add(0x9e37_79b9_7f4a_7c15)
            .wrapping_add(b << 6)
            .wrapping_add(b >> 2);
    }
    (a, b)
}

fn apply_post_retry(raw: &[u16], w: usize, h: usize, phase: (u8, u8)) -> Vec<u16> {
    let mut rgb16 = demosaic::demosaic_bayer_mhc(raw, w, h, phase).expect("demosaic");
    let n = rgb16.len() / 3;
    if n == 0 {
        return rgb16;
    }
    let (mut sum_r, mut sum_g, mut sum_b) = (0u64, 0u64, 0u64);
    let step = (n / 4096).max(1);
    let mut count = 0u64;
    let mut i = 0;
    while i < n {
        sum_r += rgb16[i * 3] as u64;
        sum_g += rgb16[i * 3 + 1] as u64;
        sum_b += rgb16[i * 3 + 2] as u64;
        count += 1;
        i += step;
    }
    let mean_r = (sum_r / count) as u32;
    let mean_g = (sum_g / count) as u32;
    let mean_b = (sum_b / count) as u32;
    let max_rb = mean_r.max(mean_b);
    if max_rb == 0 || mean_g >= max_rb / 8 {
        return rgb16;
    }

    const ALT_PHASES: [(u8, u8); 4] = [(0, 0), (0, 1), (1, 0), (1, 1)];
    for &alt in &ALT_PHASES {
        if alt == phase {
            continue;
        }
        if let Ok(candidate) = demosaic::demosaic_bayer_mhc(raw, w, h, alt) {
            let (mut sr, mut sg, mut sb) = (0u64, 0u64, 0u64);
            let mut ci = 0;
            let mut k = 0u64;
            while ci < n {
                sr += candidate[ci * 3] as u64;
                sg += candidate[ci * 3 + 1] as u64;
                sb += candidate[ci * 3 + 2] as u64;
                k += 1;
                ci += step;
            }
            let cg = (sg / k) as u32;
            let crb = ((sr / k) as u32).max((sb / k) as u32);
            if crb > 0 && cg >= crb / 4 && cg <= crb * 4 {
                rgb16 = candidate;
                break;
            }
        }
    }
    rgb16
}

fn push_u32(out: &mut Vec<u8>, v: usize) {
    out.extend_from_slice(&(v as u32).to_le_bytes());
}

fn push_u64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn main() {
    let mut args = env::args().skip(1);
    let variant = args.next().unwrap_or_else(|| {
        fail("usage: cr2_phase_retry_cmd <old|new> <input.cr2> <output.bin> [reps]")
    });
    let input = args.next().unwrap_or_else(|| fail("missing input"));
    let output = args.next().unwrap_or_else(|| fail("missing output"));
    let reps = args
        .next()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(1);
    let data = fs::read(&input).unwrap_or_else(|e| fail(format!("read {input}: {e}")));

    let mut last = None;
    for _ in 0..reps {
        let img = cr2::decode_bytes(&data).unwrap_or_else(|e| fail(format!("decode: {e}")));
        let rgb = match variant.as_str() {
            "old" => apply_post_retry(&img.raw, img.width, img.height, img.cfa_phase),
            "new" => demosaic::demosaic_bayer_mhc(&img.raw, img.width, img.height, img.cfa_phase)
                .unwrap_or_else(|e| fail(format!("demosaic: {e}"))),
            _ => fail("variant must be old or new"),
        };
        last = Some((img.width, img.height, img.cfa_phase, rgb));
    }

    let (w, h, phase, rgb) = last.unwrap();
    let (hash_a, hash_b) = hash_rgb16(&rgb);
    let mut out = Vec::with_capacity(32);
    push_u32(&mut out, w);
    push_u32(&mut out, h);
    out.push(phase.0);
    out.push(phase.1);
    push_u64(&mut out, rgb.len() as u64);
    push_u64(&mut out, hash_a);
    push_u64(&mut out, hash_b);
    fs::write(&output, out).unwrap_or_else(|e| fail(format!("write {output}: {e}")));
}
