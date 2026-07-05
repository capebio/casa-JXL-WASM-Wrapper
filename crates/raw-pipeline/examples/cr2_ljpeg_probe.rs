//! cr2_ljpeg_probe — print the LJPEG cps/precision of a CR2 so we can confirm
//! which monomorphized kernel (decode_c1 / decode_c2 / generic) the dispatcher
//! selects for real Canon files.
use raw_pipeline::cr2;

fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| r"C:\Foo\raw-converter\tests\ADH 1234.CR2".into());
    let data = std::fs::read(&path).expect("read CR2");
    let (_img, stats) = cr2::decode_bytes_with_ljpeg_stats(&data).expect("decode CR2");
    let kernel = match (stats.cps as usize, stats.precision) {
        (1, 12 | 14 | 16) => "decode_c1",
        (2, 12 | 14 | 16) => "decode_c2",
        _ => "decode_generic",
    };
    println!(
        "{}: cps={} precision={} -> {}  ({} symbols)",
        path.rsplit(['\\', '/']).next().unwrap_or(&path),
        stats.cps,
        stats.precision,
        kernel,
        stats.total_symbols,
    );
}
