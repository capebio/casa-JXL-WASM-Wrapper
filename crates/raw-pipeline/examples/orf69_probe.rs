//! ORF decode probe for the WPR broker (blizz-69's ORF lane): one ORF's
//! sensor strip through `decompress::decompress` (or `decompress_pipelined`
//! with `ORF_PIPE=1`), `ORF_REPS` times in process (default 1), then one line
//! with the plane's FNV-1a 64 over its little-endian bytes (`fnv=`, the
//! broker's output-identity check). Lever switches are the decoder's own
//! `BLIZZ_ORF_*` env vars.
//!
//!   cargo build --release --no-default-features --example orf69_probe
//!   orf69_probe <file.orf>
use raw_pipeline::decompress;

fn main() {
    let path = std::env::args().nth(1).expect("usage: orf69_probe <file.orf>");
    let d = std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let info = raw_pipeline::tiff::parse(&d).expect("TIFF parse");
    let (w, h) = (info.width as usize, info.height as usize);
    let start = info.strip_offset as usize;
    let strip = &d[start..start + info.strip_byte_count as usize];
    let reps: usize = std::env::var("ORF_REPS").ok().and_then(|s| s.parse().ok()).unwrap_or(1);
    let pipe = std::env::var_os("ORF_PIPE").is_some();
    let mut fnv = 0u64;
    for _ in 0..reps {
        #[cfg(not(target_arch = "wasm32"))]
        let plane = if pipe { decompress::decompress_pipelined(strip, w, h) } else { decompress::decompress(strip, w, h) };
        #[cfg(target_arch = "wasm32")]
        let plane = decompress::decompress(strip, w, h);
        let plane = plane.expect("decode");
        fnv = plane.iter().flat_map(|v| v.to_le_bytes()).fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100_0000_01b3));
    }
    println!("{path} {w}x{h} reps={reps} pipe={pipe} fnv={fnv:016x}");
}
