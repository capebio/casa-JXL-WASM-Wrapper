// Synthetic calibration target — known-value scenes through the REAL pipeline.
// Isolates colour-math bugs (black pedestal, WB neutralisation, matrix neutrality)
// without real-file ambiguity. The sensor model is explicit: a neutral grey on a
// Bayer sensor reads green ~G_GAIN× higher than R,B, plus a black pedestal.
//
// Run: cargo run --example synthetic_calib --no-default-features
use raw_pipeline::pipeline::{self, PipelineParams};

/// Feed a uniform demosaiced patch (r,g,b in 12-bit sensor counts) through the
/// real tone+WB+matrix pipeline; return the mean output sRGB (0..255).
fn run_patch(r12: u16, g12: u16, b12: u16, params: &PipelineParams) -> (f32, f32, f32) {
    let (w, h) = (8usize, 8usize);
    let mut rgb16 = vec![0u16; w * h * 3];
    for px in rgb16.chunks_exact_mut(3) {
        px[0] = r12;
        px[1] = g12;
        px[2] = b12;
    }
    let mut out = vec![0u8; w * h * 3];
    pipeline::process_into(&rgb16, params, &mut out);
    let n = (w * h) as f32;
    let (mut sr, mut sg, mut sb) = (0f32, 0f32, 0f32);
    for px in out.chunks_exact(3) {
        sr += px[0] as f32;
        sg += px[1] as f32;
        sb += px[2] as f32;
    }
    (sr / n, sg / n, sb / n)
}

/// Magenta index: how much R,B exceed G (a neutral grey → ~0; magenta → positive).
fn magenta(r: f32, g: f32, b: f32) -> f32 {
    (r + b) * 0.5 - g
}

fn olympus(black: u16, wb_r: f32, wb_b: f32) -> PipelineParams {
    let mut p = PipelineParams::default_olympus();
    p.black = black;
    p.wb_r = wb_r;
    p.wb_g = 1.0;
    p.wb_b = wb_b;
    // strip the confounded baselines so we read raw colour neutrality, not tone:
    p
}

const G_GAIN: f32 = 1.797; // sensor green sensitivity over R,B (matches 0x0100 WB)
const PEDESTAL: u16 = 256; // typical Olympus 12-bit black level

fn main() {
    println!("=== Synthetic neutrality: NEUTRAL grey, sensor green {G_GAIN}× R,B, pedestal {PEDESTAL} ===");
    println!("A correct pipeline returns R=G=B (magenta≈0) at every signal level.\n");
    println!("signal | black=0 (current)            | black={PEDESTAL} (fix)              ");
    println!("  (12b)| R     G     B    magenta     | R     G     B    magenta   ");
    println!("-------+------------------------------+----------------------------");
    for s in [40u16, 80, 150, 300, 600, 1200, 2400] {
        // Neutral sensor counts: R=B=s, G=s*gain, plus the black pedestal.
        let r_raw = s + PEDESTAL;
        let g_raw = (s as f32 * G_GAIN) as u16 + PEDESTAL;
        let b_raw = s + PEDESTAL;
        let (r0, g0, b0) = run_patch(r_raw, g_raw, b_raw, &olympus(0, G_GAIN, G_GAIN));
        let (rf, gf, bf) = run_patch(r_raw, g_raw, b_raw, &olympus(PEDESTAL, G_GAIN, G_GAIN));
        println!(
            "{s:6} | {r0:5.0} {g0:5.0} {b0:5.0}  {:+6.1}     | {rf:5.0} {gf:5.0} {bf:5.0}  {:+6.1}",
            magenta(r0, g0, b0),
            magenta(rf, gf, bf)
        );
    }
    println!(
        "\nmagenta = (R+B)/2 - G. Positive = red+blue excess over green = magenta/purple cast."
    );
}
