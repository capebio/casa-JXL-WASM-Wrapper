//! Cross-check a JXL DNG's first tile against jxl-oxide (independent pure-Rust
//! JXL decoder), sample-exact, so our libjxl-based DNG path is not validated
//! only against itself. Usage: dng_jxl_crosscheck <file.dng>
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let data = std::fs::read(&a[1]).expect("read");
    let img = raw_pipeline::dng::decode_bytes(&data).expect("our decode");
    let ranges = raw_pipeline::dng::payload_ranges(&data).expect("ranges");
    let (s, e) = ranges[0];
    let oxide = jxl_oxide::JxlImage::builder()
        .read(std::io::Cursor::new(&data[s..e]))
        .expect("jxl-oxide parse");
    let render = oxide.render_frame(0).expect("render");
    let fb = render.image_all_channels();
    let (tw, th, ch) = (fb.width(), fb.height(), fb.channels());
    assert_eq!(ch, img.samples_per_pixel, "channel count");
    let buf = fb.buf(); // f32 0..1
    let cps = img.samples_per_pixel;
    let mut diff_max = 0i64;
    let mut exact = 0usize;
    let mut total = 0usize;
    for y in 0..th {
        for x in 0..tw {
            for c in 0..ch {
                let o = img.raw[((y * img.width) + x) * cps + c] as i64;
                let f = buf[(y * tw + x) * ch + c];
                let t = (f * 65535.0 + 0.5) as i64;
                let d = (o - t).abs();
                diff_max = diff_max.max(d);
                if d == 0 {
                    exact += 1;
                }
                total += 1;
            }
        }
    }
    println!(
        "tile0 {tw}x{th}x{ch}: {}/{} exact ({:.4}%), max|d|={diff_max}",
        exact,
        total,
        exact as f64 / total as f64 * 100.0
    );
    // Where and how big are the disagreements?
    let meta = oxide.image_header();
    println!(
        "oxide meta: xyb_encoded={} bit_depth={:?} modular_16bit={:?}",
        meta.metadata.xyb_encoded, meta.metadata.bit_depth, meta.metadata.modular_16bit_buffers
    );
    let mut hist = [0usize; 8]; // |d| buckets: 1,2,3-4,5-8,...
    let mut first = 0;
    for y in 0..th {
        for x in 0..tw {
            for c in 0..ch {
                let o = img.raw[((y * img.width) + x) * cps + c] as i64;
                let t = (buf[(y * tw + x) * ch + c] * 65535.0 + 0.5) as i64;
                let d = (o - t).unsigned_abs();
                if d > 0 {
                    let b = (64 - d.leading_zeros()).min(8).max(1) as usize - 1;
                    hist[b] += 1;
                    if first < 5 && d > 64 {
                        println!("  big diff at ({x},{y},c{c}): ours={o} oxide={t}");
                        first += 1;
                    }
                }
            }
        }
    }
    println!("  |d| histogram (log2 buckets 1,2,4,8,...): {hist:?}");
}
