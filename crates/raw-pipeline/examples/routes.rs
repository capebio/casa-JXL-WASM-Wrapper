//! Prints the explicit hardware-dependent pathway map for THIS machine + build:
//! every route, its variants, whether it is accessible here, plus a fractal parity
//! summary. This is the "make the routes obvious" deliverable (design success #1).
//!
//! Run: `cargo run -p raw-pipeline --example routes --no-default-features --features parallel`

use raw_pipeline::calibration::fractal::{Dataset, FractalSpec, DATASETS};
use raw_pipeline::calibration::parity::parity_check;
use raw_pipeline::calibration::prober::{active_perceptual_variant, effective_core_budget, probe};
use raw_pipeline::calibration::registry::native_registry;

fn main() {
    println!("== raw-pipeline hardware pathways ==");
    println!("effective core budget : {}", effective_core_budget());
    println!("active perceptual simd: {}", active_perceptual_variant());
    println!();

    let reg = native_registry();
    let acc = probe(&reg);
    println!("{:<28} {:<11} {}", "pathway", "accessible", "detail");
    println!("{}", "-".repeat(78));
    for (p, a) in reg.iter().zip(acc.iter()) {
        println!(
            "{:<28} {:<11} {}",
            p.id,
            if a.accessible { "yes" } else { "no" },
            a.reason
        );
        println!("    {}", p.description);
        println!("    variants: {}", p.variants.join(", "));
        println!("    selector: {}", p.selector_site);
    }

    println!();
    println!("== fractal corpus ==");
    for d in DATASETS {
        let s = FractalSpec::preset(*d, 8, 8);
        let _ = s.render_rgba8(); // smoke: renders without panic
        println!("  {:<20} {:?}", d.label(), s.kind);
    }

    println!();
    println!("== parity gate (mandelbrot-seahorse 96x96) ==");
    for r in parity_check(&FractalSpec::preset(Dataset::MandelbrotSeahorse, 96, 96)) {
        println!(
            "  {:<14} score={:.6} scalar={:.6} match={}",
            r.variant, r.score, r.scalar_score, r.matches_scalar
        );
    }
}
