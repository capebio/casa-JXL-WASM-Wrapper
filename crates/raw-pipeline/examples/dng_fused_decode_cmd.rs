use raw_pipeline::{demosaic, dng};
use std::{env, fs, process};

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("{msg}");
    process::exit(2);
}

fn push_u32(out: &mut Vec<u8>, v: usize) {
    out.extend_from_slice(&(v as u32).to_le_bytes());
}

fn push_u16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn push_u64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_le_bytes());
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

fn main() {
    let mut args = env::args().skip(1);
    let variant = args.next().unwrap_or_else(|| {
        fail("usage: dng_fused_decode_cmd <old|fused> <input.dng> <output.bin> [reps]")
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
        last = Some(match variant.as_str() {
            "old" => {
                let img =
                    dng::decode_bytes(&data).unwrap_or_else(|e| fail(format!("old decode: {e}")));
                let phase = dng::cfa_phase(img.cfa);
                let rgb = demosaic::demosaic_bayer_mhc(&img.raw, img.width, img.height, phase)
                    .unwrap_or_else(|e| fail(format!("old demosaic: {e}")));
                (img.width, img.height, img.black, img.white, rgb)
            }
            "fused" => {
                let img = dng::decode_bytes_demosaiced_preserve_black(&data)
                    .unwrap_or_else(|e| fail(format!("fused decode: {e}")));
                (img.width, img.height, img.black, img.white, img.rgb)
            }
            _ => fail("variant must be old or fused"),
        });
    }
    let (w, h, black, white, rgb) = last.unwrap();
    let (hash_a, hash_b) = hash_rgb16(&rgb);

    let mut out = Vec::with_capacity(40);
    push_u32(&mut out, w);
    push_u32(&mut out, h);
    push_u64(&mut out, rgb.len() as u64);
    push_u16(&mut out, black);
    push_u16(&mut out, white);
    push_u64(&mut out, hash_a);
    push_u64(&mut out, hash_b);
    fs::write(&output, out).unwrap_or_else(|e| fail(format!("write {output}: {e}")));
}
