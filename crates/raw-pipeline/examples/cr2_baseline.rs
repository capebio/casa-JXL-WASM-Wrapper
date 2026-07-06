//! Baseline CR2 timing using only decode_bytes() (old API).
//! Flip-flop 10 runs. Outputs totals to stdout.
use raw_pipeline::cr2;
use std::fs;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let file1 = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| r"C:/Foo/raw-converter/tests/_MG_1744.CR2".into());
    let file2 = args
        .get(2)
        .cloned()
        .unwrap_or_else(|| r"C:/Foo/raw-converter/tests/ADH 1248.CR2".into());

    let data1 = fs::read(&file1).unwrap_or_else(|e| panic!("read {file1}: {e}"));
    let data2 = fs::read(&file2).unwrap_or_else(|e| panic!("read {file2}: {e}"));

    // Warmup
    let _ = cr2::decode_bytes(&data1);
    let _ = cr2::decode_bytes(&data2);

    let files = [(file1.clone(), &data1), (file2.clone(), &data2)];
    let mut totals = Vec::new();

    println!("BASELINE — old cr2.rs (no phase breakdown)");
    for i in 0..10 {
        let (_, data) = &files[i % 2];
        let label = if i % 2 == 0 { "A" } else { "B" };
        let t0 = Instant::now();
        let img = cr2::decode_bytes(data).expect("decode failed");
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        println!(
            "Run {:2} [{label}] total={:.1}ms  {}×{}",
            i + 1,
            ms,
            img.width,
            img.height
        );
        totals.push(ms);
    }
    let avg = totals.iter().sum::<f64>() / totals.len() as f64;
    let min = totals.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = totals.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let mut v = totals.clone();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let med = v[v.len() / 2];
    println!("\nAvg={avg:.1}ms  Med={med:.1}ms  Min={min:.1}ms  Max={max:.1}ms");
}
