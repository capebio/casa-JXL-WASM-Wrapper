//! cr2_sensorinfo_probe — ground-truth Canon SensorInfo (MakerNote 0x00E0) against the
//! shipped center-crop heuristic on real CR2s. For each file prints:
//!   decoded grid (stride×rows), IFD0 crop dims, SensorInfo sensor dims + borders,
//!   center-crop origin (even-snapped) vs SensorInfo origin, phase parity, verdict.
//! Verdict BYTE-EXACT = same origin + same crop dims → switching to SensorInfo would
//! change nothing on this body. SHIFT = different origin (content moves; not byte-exact).
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example cr2_sensorinfo_probe -- <file.cr2>...
use raw_pipeline::cr2;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: cr2_sensorinfo_probe <file.cr2>...");
        std::process::exit(2);
    }
    println!("{:<26} {:>11} {:>11} {:>13} {:>12} {:>12} {:>7} {:>10}",
        "file", "decoded", "ifd0 crop", "sensor(borders)", "center l,t", "sensor l,t", "phase", "verdict");
    for path in &args {
        let data = match std::fs::read(path) {
            Ok(d) => d,
            Err(e) => { println!("{:<26} read error: {e}", short(path)); continue; }
        };
        let (_, _, stride, rows) = match cr2::ljpeg_strip_geometry(&data) {
            Ok(v) => v,
            Err(e) => { println!("{:<26} geom error: {e}", short(path)); continue; }
        };
        let img = match cr2::decode_bytes(&data) {
            Ok(v) => v,
            Err(e) => { println!("{:<26} decode error: {e}", short(path)); continue; }
        };
        let (cw, ch) = (img.width, img.height);
        // Shipped heuristic: center, snapped down to even.
        let mut lc = (stride - cw) / 2;
        let mut tc = (rows - ch) / 2;
        if lc & 1 != 0 { lc -= 1; }
        if tc & 1 != 0 { tc -= 1; }
        match cr2::parse_sensor_info(&data) {
            Some(si) => {
                let (ls, ts) = (si.left as usize, si.top as usize);
                let (aw, ah) = (si.active_width(), si.active_height());
                let dims_match = aw == cw && ah == ch;
                let origin_match = ls == lc && ts == tc;
                let verdict = match (dims_match, origin_match) {
                    (true, true) => "BYTE-EXACT",
                    (true, false) => "SHIFT",
                    (false, _) => "DIM-DIFF",
                };
                println!("{:<26} {:>5}x{:<5} {:>5}x{:<5} {:>4}x{:<4}@{:<3} {:>5},{:<5} {:>5},{:<5} {:>3},{:<3} {:>10}",
                    short(path), stride, rows, cw, ch,
                    si.sensor_width, si.sensor_height, si.left,
                    lc, tc, ls, ts, ls & 1, ts & 1, verdict);
                if !dims_match {
                    println!("{:<26}   sensor active {}x{} vs ifd0 {}x{}", "", aw, ah, cw, ch);
                }
            }
            None => println!("{:<26} no SensorInfo tag", short(path)),
        }
    }
}

fn short(p: &str) -> String {
    p.rsplit(['\\', '/']).next().unwrap_or(p).to_string()
}
