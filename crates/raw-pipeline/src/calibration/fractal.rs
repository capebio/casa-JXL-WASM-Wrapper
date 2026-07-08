//! Deterministic fractal test-image generator.
//!
//! Procedural, RNG-free image source for the calibration bench + parity gate. A few
//! lines of escape-time math, colourful, known output, tailorable to any size — so
//! the same buffer is reproducible on every machine and doubles as a correctness
//! oracle (all SIMD backends must agree on it). See design §4.3.

use std::f64::consts::PI;

/// A fully-specified fractal render request. Deterministic: `render_rgba8` is a pure
/// function of these fields. No RNG anywhere (dither uses a positional integer hash).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FractalSpec {
    pub kind: Kind,
    pub width: usize,
    pub height: usize,
    /// Complex-plane centre (Mandelbrot/BurningShip); viewport origin for Julia.
    pub center_re: f64,
    pub center_im: f64,
    /// Half-height of the viewport in complex-plane units (smaller = deeper zoom).
    pub scale: f64,
    pub max_iter: u32,
    /// Palette phase offset (radians) — lets presets differ in colour.
    pub palette_phase: f64,
    /// Seeded-hash entropy overlay for photo-like statistics in the encode bench.
    pub dither: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Mandelbrot,
    /// Julia set with constant `c = (c_re_milli/1000, c_im_milli/1000)`. Integer
    /// milli-units keep `Kind` `Eq`/`Hash`-able and the constant exactly reproducible.
    Julia { c_re_milli: i64, c_im_milli: i64 },
    BurningShip,
}

/// Named, fixed-parameter datasets. Sizes are chosen by the caller; the mathematical
/// viewport (centre/scale/iter) is pinned here so results are comparable everywhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dataset {
    /// Deep-zoom seahorse valley: dense high-frequency swirl. The headline visual.
    MandelbrotSeahorse,
    /// The whole set: mixed flat + detail.
    MandelbrotFull,
    /// Julia c = -0.8 + 0.156i.
    JuliaA,
    /// Julia c = 0.285 + 0.01i.
    JuliaB,
    /// Burning ship: sharp anisotropic edges.
    BurningShip,
}

/// Enumerates every dataset (for the registry, the routes report, and bench sweeps).
pub const DATASETS: &[Dataset] = &[
    Dataset::MandelbrotSeahorse,
    Dataset::MandelbrotFull,
    Dataset::JuliaA,
    Dataset::JuliaB,
    Dataset::BurningShip,
];

impl Dataset {
    pub fn label(self) -> &'static str {
        match self {
            Dataset::MandelbrotSeahorse => "mandelbrot-seahorse",
            Dataset::MandelbrotFull => "mandelbrot-full",
            Dataset::JuliaA => "julia-a",
            Dataset::JuliaB => "julia-b",
            Dataset::BurningShip => "burning-ship",
        }
    }
}

impl FractalSpec {
    /// Build the fixed-viewport spec for a named dataset at the requested pixel size.
    pub fn preset(id: Dataset, width: usize, height: usize) -> Self {
        let base =
            |kind, center_re, center_im, scale, max_iter, palette_phase| FractalSpec {
                kind,
                width,
                height,
                center_re,
                center_im,
                scale,
                max_iter,
                palette_phase,
                dither: false,
            };
        match id {
            // Seahorse valley on the Mandelbrot boundary, zoomed in tight.
            Dataset::MandelbrotSeahorse => base(
                Kind::Mandelbrot,
                -0.743_643_887_037,
                0.131_825_904_205,
                0.005,
                512,
                0.0,
            ),
            Dataset::MandelbrotFull => base(Kind::Mandelbrot, -0.5, 0.0, 1.25, 256, 1.0),
            Dataset::JuliaA => base(
                Kind::Julia {
                    c_re_milli: -800,
                    c_im_milli: 156,
                },
                0.0,
                0.0,
                1.5,
                256,
                2.0,
            ),
            Dataset::JuliaB => base(
                Kind::Julia {
                    c_re_milli: 285,
                    c_im_milli: 10,
                },
                0.0,
                0.0,
                1.5,
                256,
                3.0,
            ),
            Dataset::BurningShip => base(Kind::BurningShip, -0.5, -0.5, 0.6, 256, 4.0),
        }
    }

    /// Convenience: this spec with dither enabled (photo-like entropy for the encode bench).
    pub fn dithered(mut self) -> Self {
        self.dither = true;
        self
    }

    /// Render to a packed RGBA8 buffer, row-major, `width*height*4` bytes. Pure and
    /// deterministic. Points that never escape within `max_iter` are painted black
    /// ("inside the set"); escaping points get a smooth continuous-iteration colour.
    pub fn render_rgba8(&self) -> Vec<u8> {
        let mut out = vec![0u8; self.width * self.height * 4];
        let aspect = self.width as f64 / self.height as f64;
        let half_h = self.scale;
        let half_w = self.scale * aspect;
        for py in 0..self.height {
            // Map pixel row → imaginary axis (top row = +im).
            let t = (py as f64 + 0.5) / self.height as f64; // 0..1
            let im = self.center_im + (1.0 - 2.0 * t) * half_h;
            for px in 0..self.width {
                let s = (px as f64 + 0.5) / self.width as f64;
                let re = self.center_re + (2.0 * s - 1.0) * half_w;
                let idx = (py * self.width + px) * 4;
                let (r, g, b) = match self.escape(re, im) {
                    None => (0u8, 0u8, 0u8), // inside the set
                    Some(mu) => palette(mu, self.palette_phase),
                };
                let (r, g, b) = if self.dither {
                    dither_pixel(r, g, b, px, py)
                } else {
                    (r, g, b)
                };
                out[idx] = r;
                out[idx + 1] = g;
                out[idx + 2] = b;
                out[idx + 3] = 255;
            }
        }
        out
    }

    /// Returns `None` if the orbit never escapes (inside the set), else `Some(mu)`
    /// where `mu` is the smooth (fractional) iteration count.
    fn escape(&self, cx: f64, cy: f64) -> Option<f64> {
        // Starting point + per-iteration constant vary by kind.
        let (mut zx, mut zy, kx, ky) = match self.kind {
            Kind::Mandelbrot | Kind::BurningShip => (0.0, 0.0, cx, cy),
            Kind::Julia {
                c_re_milli,
                c_im_milli,
            } => (cx, cy, c_re_milli as f64 / 1000.0, c_im_milli as f64 / 1000.0),
        };
        let bailout = 4.0_f64; // |z|^2 > 4 → escaped
        for i in 0..self.max_iter {
            let x2 = zx * zx;
            let y2 = zy * zy;
            if x2 + y2 > bailout {
                // Smooth iteration count: i + 1 - log2(log|z|).
                let log_zn = (x2 + y2).ln() * 0.5;
                let nu = (log_zn / std::f64::consts::LN_2).ln() / std::f64::consts::LN_2;
                return Some(i as f64 + 1.0 - nu);
            }
            if matches!(self.kind, Kind::BurningShip) {
                zx = zx.abs();
                zy = zy.abs();
            }
            let nzx = x2 - y2 + kx;
            zy = 2.0 * zx * zy + ky;
            zx = nzx;
        }
        None
    }
}

/// Smooth-iteration → RGB via a phase-shifted sinusoid palette. Deterministic,
/// colourful, and continuous (no banding that would trivialise the codec).
fn palette(mu: f64, phase: f64) -> (u8, u8, u8) {
    let t = mu * 0.15 + phase;
    let r = (0.5 + 0.5 * t.sin()) * 255.0;
    let g = (0.5 + 0.5 * (t + 2.0 * PI / 3.0).sin()) * 255.0;
    let b = (0.5 + 0.5 * (t + 4.0 * PI / 3.0).sin()) * 255.0;
    (r as u8, g as u8, b as u8)
}

/// Deterministic per-pixel dither: a positional integer hash mapped to a small delta.
/// Raises entropy toward photographic statistics without any RNG.
fn dither_pixel(r: u8, g: u8, b: u8, px: usize, py: usize) -> (u8, u8, u8) {
    #[inline]
    fn h(x: u64) -> u64 {
        // splitmix64 finaliser — deterministic hash, no state.
        let mut z = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    let base = ((px as u64) << 32) | py as u64;
    let d = |chan: u64| -> i32 { (h(base ^ (chan << 3)) & 0x7) as i32 - 3 }; // -3..+4
    let clamp = |v: i32| v.clamp(0, 255) as u8;
    (
        clamp(r as i32 + d(1)),
        clamp(g as i32 + d(2)),
        clamp(b as i32 + d(3)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn small_mandel() -> FractalSpec {
        FractalSpec {
            kind: Kind::Mandelbrot,
            width: 32,
            height: 24,
            center_re: -0.5,
            center_im: 0.0,
            scale: 1.25,
            max_iter: 128,
            palette_phase: 0.0,
            dither: false,
        }
    }

    #[test]
    fn output_length_is_rgba8() {
        let s = small_mandel();
        let px = s.render_rgba8();
        assert_eq!(px.len(), s.width * s.height * 4);
    }

    #[test]
    fn alpha_is_opaque_everywhere() {
        let px = small_mandel().render_rgba8();
        assert!(px.chunks_exact(4).all(|p| p[3] == 255));
    }

    #[test]
    fn deterministic_same_twice() {
        let s = small_mandel();
        assert_eq!(s.render_rgba8(), s.render_rgba8());
    }

    #[test]
    fn not_a_flat_image() {
        let px = small_mandel().render_rgba8();
        let first = &px[0..3];
        assert!(
            px.chunks_exact(4).any(|p| &p[0..3] != first),
            "render is a flat fill — colouring is broken"
        );
    }

    #[test]
    fn in_set_point_is_dark() {
        // c = 0 (image centre for this spec) never escapes → black "inside" colour.
        let s = small_mandel();
        let px = s.render_rgba8();
        let idx = ((s.height / 2) * s.width + s.width / 2) * 4;
        assert_eq!(&px[idx..idx + 3], &[0, 0, 0], "inside-set point should be black");
    }

    #[test]
    fn all_presets_render_at_requested_size() {
        for id in DATASETS {
            let s = FractalSpec::preset(*id, 40, 30);
            let px = s.render_rgba8();
            assert_eq!(px.len(), 40 * 30 * 4, "{id:?} wrong size");
            let first = &px[0..3];
            assert!(
                px.chunks_exact(4).any(|p| &p[0..3] != first),
                "{id:?} rendered flat"
            );
        }
    }

    #[test]
    fn seahorse_is_high_detail() {
        let px = FractalSpec::preset(Dataset::MandelbrotSeahorse, 64, 64).render_rgba8();
        let mut seen = std::collections::HashSet::new();
        for p in px.chunks_exact(4) {
            seen.insert([p[0], p[1], p[2]]);
        }
        assert!(seen.len() > 200, "seahorse too flat: {} colours", seen.len());
    }

    #[test]
    fn dither_changes_pixels_but_keeps_size() {
        let s = FractalSpec::preset(Dataset::MandelbrotFull, 48, 48);
        let plain = s.render_rgba8();
        let dith = s.dithered().render_rgba8();
        assert_eq!(plain.len(), dith.len());
        assert!(plain != dith, "dither had no effect");
        assert!(dith.chunks_exact(4).all(|p| p[3] == 255));
    }
}
