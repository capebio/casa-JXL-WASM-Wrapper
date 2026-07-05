//! cr2_activearea_evidence — prove the center-crop heuristic includes optical-black
//! masked pixels. Decodes the raw LJPEG grid of a SINGLE-SLICE CR2 (grid == raster)
//! and prints mean sample values of 8-column bands at:
//!   A) the shipped center-crop left edge (should be ~black level if masked),
//!   B) the SensorInfo active-area left edge (should be scene content),
//!   C) the band the center crop DROPS on the right (active content lost).
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example cr2_activearea_evidence -- <single-slice.cr2>
use raw_pipeline::{cr2, ljpeg};

fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| r"C:\Foo\raw-converter\tests\ADH 1234.CR2".into());
    let data = std::fs::read(&path).expect("read CR2");
    let (off, len, stride, rows) = cr2::ljpeg_strip_geometry(&data).expect("geometry");
    let si = cr2::parse_sensor_info(&data).expect("SensorInfo");
    let img = cr2::decode_bytes(&data).expect("decode");
    let (cw, ch) = (img.width, img.height);
    let mut lc = (stride - cw) / 2;
    if lc & 1 != 0 {
        lc -= 1;
    }
    let mut tc = (rows - ch) / 2;
    if tc & 1 != 0 {
        tc -= 1;
    }

    let mut grid = vec![0u16; stride * rows];
    ljpeg::decode_tile(&data[off..off + len], &mut grid, 0, stride, stride, rows)
        .expect("strip decode");

    let band_mean = |x0: usize, w: usize| -> f64 {
        let mut sum = 0u64;
        let mut n = 0u64;
        for y in (si.top as usize)..=(si.bottom as usize) {
            for x in x0..(x0 + w).min(stride) {
                sum += grid[y * stride + x] as u64;
                n += 1;
            }
        }
        sum as f64 / n as f64
    };

    let ls = si.left as usize;
    println!(
        "file: {}  grid {stride}x{rows}  black={} white={}",
        path.rsplit(['\\', '/']).next().unwrap_or(&path),
        img.black,
        img.white
    );
    println!(
        "center-crop left edge   cols {:>4}..{:<4} mean = {:>8.1}",
        lc,
        lc + 8,
        band_mean(lc, 8)
    );
    println!(
        "active-area left edge   cols {:>4}..{:<4} mean = {:>8.1}",
        ls,
        ls + 8,
        band_mean(ls, 8)
    );
    println!(
        "dropped-right (active)  cols {:>4}..{:<4} mean = {:>8.1}",
        lc + cw,
        lc + cw + 8,
        band_mean(lc + cw, 8)
    );
    println!(
        "far-left optical black  cols    0..8    mean = {:>8.1}",
        band_mean(0, 8)
    );
}
