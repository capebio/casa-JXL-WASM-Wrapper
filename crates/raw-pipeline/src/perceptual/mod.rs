//! Perceptual image-quality metrics (Butteraugli-approx, SSIM, PSNR).
//! Scalar Rust is the parity oracle; SIMD backends are selected at runtime.
//! See docs/superpowers/specs/2026-06-13-perceptual-metrics-simd-kernel-design.md

mod blur;
pub(crate) mod butteraugli;
mod psnr;
pub(crate) mod ssim;
pub mod telemetry;
pub(crate) mod xyb;
mod simd;
pub use simd::{detect_native, Backend};
// wasm-only: surface the v128 kernels so the bench-wasm harness can A/B them in a
// real wasm runtime (the kernels are arch-gated internally, so this is invisible to
// native builds and adds no native API surface).
#[cfg(target_arch = "wasm32")]
pub use simd::wasm as wasm_kernels;
// x86 kernels, surfaced for the native flip-flop examples (examples/*_flip.rs). The
// fns are arch-gated + unsafe; this just lets an out-of-crate example A/B them.
#[cfg(target_arch = "x86_64")]
pub use simd::avx2 as avx2_kernels;
pub use telemetry::{TelemetryMetrics, RgbHistogram, analyze_fused};

pub use butteraugli::Kweights;

/// Which compute backend to use. `Auto` picks the fastest available at runtime.
/// `ForceScalar` and `Force(id)` exist for the flip-flop bench.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BackendChoice {
    Auto,
    ForceScalar,
    /// Force a specific SIMD path id (see simd::Backend). Ignored if unavailable.
    Force(u8),
}
impl Default for BackendChoice {
    fn default() -> Self {
        BackendChoice::Auto
    }
}

#[derive(Clone)]
pub struct Opts {
    pub weights: [f32; 3],
    pub k: Kweights,
    pub backend: BackendChoice,
}
impl Default for Opts {
    fn default() -> Self {
        Opts { weights: [4.0, 2.0, 1.0], k: Kweights::default(), backend: BackendChoice::Auto }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ChannelMoments {
    pub mus: [f32; 3],
    pub vars: [f32; 3],
    pub ch: usize,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Metrics {
    pub butteraugli: f32,
    pub ssim: f32,
    pub psnr: f32,
    pub moments: ChannelMoments,
}

struct Level {
    x: Vec<f32>,
    y: Vec<f32>,
    b: Vec<f32>,
    mask: Vec<f32>,
    w: usize,
    h: usize,
}

/// Precomputes all reference-side work once; evaluates many test images against it.
pub struct Comparer {
    width: usize,
    height: usize,
    n: usize,
    opts: Opts,
    backend: Backend,
    levels: Vec<Level>,
    ref_rgba: Vec<u8>,
    // SSIM reference autos (per channel, RGBA stride 4)
    ssim_sb: [u64; 3],
    ssim_sbb: [u64; 3],
    // reusable test-side scratch
    tx: Vec<f32>,
    ty: Vec<f32>,
    tb: Vec<f32>,
    dx: Vec<f32>,
    dy: Vec<f32>,
    db: Vec<f32>,
}

impl Comparer {
    /// CRAWL C-7: takes the reference RGBA **by value** so it can be MOVED into the Comparer
    /// (which must own a stable copy for every later ssim()/psnr() eval) instead of copied via
    /// `to_vec`. Same move-not-copy logic as A-5b. The construction reads borrow it; the field
    /// takes it at the end. Callers that must keep their buffer pass a clone (their choice);
    /// the wasm binding hands over the buffer wasm-bindgen already owns at the FFI boundary.
    pub fn new(ref_rgba: Vec<u8>, width: usize, height: usize, opts: Opts) -> Self {
        // Reject overflowing dimensions before they wrap `n` (the master bound the
        // unsafe SIMD kernels trust). On wasm32 usize is 32-bit, so this is reachable.
        let n = width
            .checked_mul(height)
            .and_then(|n| n.checked_mul(4).map(|_| n))
            .expect("width*height*4 overflows usize");
        assert_eq!(ref_rgba.len(), n * 4, "ref must be RGBA");
        // Resolve the backend up front so the reference pyramid is built with the
        // SAME dispatched kernels as the per-compare test pyramid (convert_xyb /
        // downsample_one). The backend depends only on opts + CPU detect, not on
        // any XYB result, so it is safe to compute before the conversion. This
        // makes the reference side use AVX2/AVX-512/wasm-SIMD instead of the scalar
        // fallback, and — by using the same fmadd kernel as the test side — makes
        // ref/test conversion bit-consistent (the difference `rx - tx` no longer
        // carries a scalar-vs-fmadd rounding asymmetry).
        let backend = resolve_backend(&opts);
        // Build reference XYB pyramid + masks (3 scales, blur radius ~w/64 clamped 1..8).
        let (mut rx, mut ry, mut rb) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
        convert_xyb(backend, &ref_rgba, n, &mut rx, &mut ry, &mut rb);
        let mut levels = Vec::with_capacity(3);
        let (mut w, mut h) = (width, height);
        let (mut cx, mut cy, mut cb) = (rx, ry, rb);
        for s in 0..3 {
            let blur_r = ((w >> 6).max(1)).min(8);
            let mask = blur::box_blur(&cy, w, h, blur_r);
            if s < 2 && w > 1 && h > 1 {
                let dw = (w >> 1).max(1);
                let dh = (h >> 1).max(1);
                let dn = dw * dh;
                // Pre-allocate the downsample targets (PERC-09: explicit alloc at call site).
                let mut nx = vec![0f32; dn];
                let mut ny = vec![0f32; dn];
                let mut nb = vec![0f32; dn];
                // PERC-12: move cx/cy/cb into the Level, then borrow them back to feed the
                // downsample. downsample_one only READS its source and writes the separate
                // nx/ny/nb, so the planes need not be cloned to stay alive for the next level.
                // Eliminates 3× full-res clones at s=0 (~288 MB transient @24MP) + 3× half-res
                // at s=1. Dispatched (not scalar dn2_into) so the reference pyramid uses the
                // same SIMD downsample as the test side; the scalar fallback
                // (downsample_inplace) is byte-identical to the old dn2_into path.
                levels.push(Level { x: cx, y: cy, b: cb, mask, w, h });
                let lvl = levels.last().expect("level just pushed");
                downsample_one(backend, &lvl.x, &mut nx, w, h, dw, dh);
                downsample_one(backend, &lvl.y, &mut ny, w, h, dw, dh);
                downsample_one(backend, &lvl.b, &mut nb, w, h, dw, dh);
                cx = nx; cy = ny; cb = nb; w = dw; h = dh;
            } else {
                // Last level (s==2, or image too small to downsample): move cx/cy/cb
                // directly into the Level — saves 3 × n f32 allocations (up to 288 MB at 24MP).
                levels.push(Level { x: cx, y: cy, b: cb, mask, w, h });
                break;
            }
        }
        let (ssim_sb, ssim_sbb) = ssim::ref_moments(&ref_rgba, n, 4);
        // `backend` was resolved above (before the reference XYB build) via
        // resolve_backend(&opts).
        Comparer {
            width, height, n, opts, backend, levels,
            ref_rgba, // CRAWL C-7: moved in (was ref_rgba.to_vec() — a full n*4 copy)
            ssim_sb, ssim_sbb,
            tx: vec![0f32; n], ty: vec![0f32; n], tb: vec![0f32; n],
            dx: vec![0f32; n], dy: vec![0f32; n], db: vec![0f32; n],
        }
    }

    fn fill_test_xyb(&mut self, test: &[u8]) {
        // Same conversion the reference pyramid used in Comparer::new (convert_xyb).
        // On AVX2 this is the scalar-LUT kernel — flip-measured ~2.6× over the
        // i32-gather kernel at 1/6/24 MP (examples/xyb_gather_flip.rs).
        convert_xyb(self.backend, test, self.n, &mut self.tx, &mut self.ty, &mut self.tb);
    }

    fn downsample_dispatch(&mut self, w: usize, h: usize, dw: usize, dh: usize) {
        // CRAWL C-3: the three X/Y/B planes are disjoint (separate src/dst Vecs, no
        // cross-dependency), so split the borrows and run them concurrently under the
        // `parallel` feature. The SoA layout (PERC-04) means no per-thread allocation —
        // each task writes its own output plane. Measured native AVX2: −12.6% @2048² /
        // −6.6% @4096² butteraugli end-to-end (shrinks with size as the bandwidth-bound
        // downsample saturates). WASM (serial, no `parallel`) is unaffected. rayon::join
        // is nesting-safe (degrades to inline under a saturated outer pool).
        let backend = self.backend;
        let (tx, ty, tb) = (&self.tx, &self.ty, &self.tb);
        let (dx, dy, db) = (&mut self.dx, &mut self.dy, &mut self.db);
        #[cfg(feature = "parallel")]
        {
            rayon::join(
                || downsample_one(backend, tx, dx, w, h, dw, dh),
                || {
                    rayon::join(
                        || downsample_one(backend, ty, dy, w, h, dw, dh),
                        || downsample_one(backend, tb, db, w, h, dw, dh),
                    );
                },
            );
        }
        #[cfg(not(feature = "parallel"))]
        {
            downsample_one(backend, tx, dx, w, h, dw, dh);
            downsample_one(backend, ty, dy, w, h, dw, dh);
            downsample_one(backend, tb, db, w, h, dw, dh);
        }
        // Swap tx↔dx (and ty↔dy, tb↔db) so the downsampled output is now in
        // tx/ty/tb — ready for the next scale's scale_err_dispatch — while dx/dy/db
        // are recycled as the scratch for the following downsample. This replaces
        // 3×dw*dh×4 bytes of memcpy (up to 288 MB at scale 0 for a 24 MP image)
        // with 3 pointer swaps (zero-copy, PERC-04). Both Vecs remain large enough
        // for all scales since tx/dx are sized to n (full resolution) at construction.
        // Only tx[..dw*dh]/ty[..dw*dh]/tb[..dw*dh] are valid after this swap; the
        // stale tail in the now-dx buffer is never read by scale_err_dispatch (which
        // uses lvl.w*lvl.h as its bound) and is overwritten on the next downsample.
        std::mem::swap(&mut self.tx, &mut self.dx);
        std::mem::swap(&mut self.ty, &mut self.dy);
        std::mem::swap(&mut self.tb, &mut self.db);
    }

    /// Multi-scale butteraugli (up to 3 scales). Mutates test scratch (tx/ty/tb get
    /// downsampled in place). Iterates over `self.levels.len()` actual levels — which
    /// may be fewer than 3 for tiny images (see `Comparer::new` break condition) —
    /// so a 1×N or N×1 image never indexes a non-existent level.
    pub fn butteraugli(&mut self, test: &[u8]) -> f32 {
        if test.len() != self.n * 4 {
            return f32::NAN;
        }
        self.fill_test_xyb(test);
        let (mut w, mut h) = (self.width, self.height);
        let mut total = 0f32;
        let num_levels = self.levels.len();
        for s in 0..num_levels {
            let e = self.scale_err_dispatch(s) * self.opts.weights[s];
            total += e;
            // Mirror the Comparer::new break condition: only downsample when there is
            // a next level AND the current resolution is still 2-D (both dims > 1).
            // For a full 3-level image: num_levels==3, so `s < 2` — identical to before.
            if s < num_levels - 1 && w > 1 && h > 1 {
                let (dw, dh) = ((w >> 1).max(1), (h >> 1).max(1));
                self.downsample_dispatch(w, h, dw, dh);
                w = dw; h = dh;
            }
        }
        // Divide by the sum of weights for the EVALUATED levels only.
        // For a 3-level image this equals opts.weights.iter().sum() — identical to before.
        // For a 1- or 2-level image this avoids under-normalizing by un-evaluated weights.
        let weight_sum: f32 = self.opts.weights[..num_levels].iter().sum();
        // Use assert! (not debug_assert!) so callers passing Opts { weights: [0.0, ..] }
        // or NaN weights get a clear panic in release builds rather than silent NaN propagation
        // through Metrics and downstream comparisons.
        assert!(
            weight_sum.is_finite() && weight_sum > 0.0,
            "Opts.weights must sum to a finite positive value, got {weight_sum}"
        );
        total / weight_sum
    }

    pub fn ssim(&self, test: &[u8]) -> f32 {
        if test.len() != self.n * 4 {
            return f32::NAN;
        }
        self.ssim_test_sums(test).0
    }

    /// SSIM score plus the per-channel test sums `sa=Σx`, `saa=Σx²` that every backend
    /// already accumulates en route to `finalize_ssim`. `all()` reuses `sa`/`saa` to
    /// derive `channel_moments` without a second pass over the test buffer.
    /// Caller must ensure `test.len() == self.n * 4` (the public `ssim`/`all` guard it).
    fn ssim_test_sums(&self, test: &[u8]) -> (f32, [u64; 3], [u64; 3]) {
        match self.backend {
            #[cfg(target_arch = "x86_64")]
            // Channel-as-lane SIMD moments (8-wide, 2 px/iter). flip-measured 1.33–1.51×
            // over the old scalar kernel (examples/ssim_moments_avx2_flip.rs, 24MP, parity
            // exact). The AVX2 *deinterleave* attempt that lost was a different layout — the
            // scalar `ssim_moments_avx2` is retained as the parity oracle for tests + flip.
            Backend::Avx2Strict | Backend::Avx2Rsqrt => {
                let (sa, saa, sab) = unsafe { simd::avx2::ssim_moments_avx2_cal(test, &self.ref_rgba, self.n) };
                (ssim::finalize_ssim(&sa, &self.ssim_sb, &saa, &self.ssim_sbb, &sab, self.n, 3), sa, saa)
            }
            #[cfg(target_arch = "x86_64")]
            // Server option: channel-as-lane SIMD moments (16-wide, 4 px/iter). The
            // wasm v128 form of this layout is runtime-measured at 3.73× over scalar,
            // overturning the AVX2 deinterleave "no win"; this is its AVX-512 width,
            // active whenever an AVX-512 backend is selected (auto on server hardware).
            Backend::Avx512Strict | Backend::Avx512Rsqrt => {
                let (sa, saa, sab) = unsafe { simd::avx512::ssim_moments_avx512(test, &self.ref_rgba, self.n) };
                (ssim::finalize_ssim(&sa, &self.ssim_sb, &saa, &self.ssim_sbb, &sab, self.n, 3), sa, saa)
            }
            #[cfg(target_arch = "wasm32")]
            // wasm v128 channel-as-lane moments — bench-measured 3.73× over scalar.
            Backend::WasmSimd => {
                let (sa, saa, sab) = simd::wasm::ssim_moments_wasm(test, &self.ref_rgba, self.n);
                (ssim::finalize_ssim(&sa, &self.ssim_sb, &saa, &self.ssim_sbb, &sab, self.n, 3), sa, saa)
            }
            _ => {
                let (sa, saa, sab) = ssim::ssim_sums(test, &self.ref_rgba, self.n, 4);
                (ssim::finalize_ssim(&sa, &self.ssim_sb, &saa, &self.ssim_sbb, &sab, self.n, 3), sa, saa)
            }
        }
    }

    pub fn psnr(&self, test: &[u8]) -> f32 {
        if test.len() != self.n * 4 {
            return f32::NAN;
        }
        match self.backend {
            #[cfg(target_arch = "x86_64")]
            // AVX-512 arms intentionally call the avx2 psnr (ssd) kernel: no AVX-512
            // PSNR implementation exists yet; avx2+fma is implied by AVX-512 hardware.
            Backend::Avx2Strict | Backend::Avx2Rsqrt | Backend::Avx512Strict | Backend::Avx512Rsqrt => {
                let sum_sq = unsafe { simd::avx2::ssd_avx2(test, &self.ref_rgba) };
                if sum_sq == 0 {
                    return f32::INFINITY;
                }
                let mse = sum_sq as f64 / test.len() as f64;
                (10.0 * (255.0f64 * 255.0 / mse).log10()) as f32
            }
            #[cfg(target_arch = "wasm32")]
            Backend::WasmSimd => {
                let sum_sq = simd::wasm::ssd_wasm(test, &self.ref_rgba);
                if sum_sq == 0 {
                    return f32::INFINITY;
                }
                let mse = sum_sq as f64 / test.len() as f64;
                (10.0 * (255.0f64 * 255.0 / mse).log10()) as f32
            }
            _ => psnr::psnr(test, &self.ref_rgba),
        }
    }

    fn scale_err_dispatch(&self, s: usize) -> f32 {
        let lvl = &self.levels[s];
        let cur_n = lvl.w * lvl.h; // reference-side dims are the source of truth
        let (tx, ty, tb) = (&self.tx[..cur_n], &self.ty[..cur_n], &self.tb[..cur_n]);
        let k = &self.opts.k;
        match self.backend {
            #[cfg(target_arch = "x86_64")]
            Backend::Avx2Strict => unsafe {
                simd::avx2::scale_err_avx2(&lvl.mask, &lvl.x, &lvl.y, &lvl.b, tx, ty, tb, cur_n, k.kx, k.ky, k.kb, false)
            },
            #[cfg(target_arch = "x86_64")]
            Backend::Avx2Rsqrt => unsafe {
                simd::avx2::scale_err_avx2(&lvl.mask, &lvl.x, &lvl.y, &lvl.b, tx, ty, tb, cur_n, k.kx, k.ky, k.kb, true)
            },
            #[cfg(target_arch = "x86_64")]
            Backend::Avx512Strict => unsafe {
                simd::avx512::scale_err_avx512(&lvl.mask, &lvl.x, &lvl.y, &lvl.b, tx, ty, tb, cur_n, k.kx, k.ky, k.kb, false)
            },
            #[cfg(target_arch = "x86_64")]
            Backend::Avx512Rsqrt => unsafe {
                simd::avx512::scale_err_avx512(&lvl.mask, &lvl.x, &lvl.y, &lvl.b, tx, ty, tb, cur_n, k.kx, k.ky, k.kb, true)
            },
            #[cfg(target_arch = "wasm32")]
            Backend::WasmSimd => simd::wasm::scale_err_wasm(&lvl.mask, &lvl.x, &lvl.y, &lvl.b, tx, ty, tb, cur_n, k.kx, k.ky, k.kb),
            _ => butteraugli::scale_err(&lvl.mask, &lvl.x, &lvl.y, &lvl.b, tx, ty, tb, cur_n, k),
        }
    }

    /// All three metrics. Scalar version calls each path; the SIMD override in a
    /// later task fuses the deinterleave.
    pub fn all(&mut self, test: &[u8]) -> Metrics {
        let butteraugli = self.butteraugli(test);
        let psnr = self.psnr(test);
        // Fuse SSIM and channel_moments: the SSIM pass already accumulates the test
        // sums sa=Σx, saa=Σx² per channel, and mus/vars are exactly sa/n and
        // saa/n-mu². Deriving them here (bit-identical to channel_moments) removes a
        // full strided pass over the test buffer — flip-measured 38% off the
        // SSIM+moments work @24MP (examples/ssim_all_reuse_flip.rs, parity exact).
        // A short buffer makes the metric calls return NaN; guard moments the same way.
        let (ssim, moments) = if test.len() == self.n * 4 {
            let (s, sa, saa) = self.ssim_test_sums(test);
            let (mus, vars, ch) = ssim::moments_from_sums(&sa, &saa, self.n, 3);
            (s, ChannelMoments { mus, vars, ch })
        } else {
            (f32::NAN, ChannelMoments::default())
        };
        Metrics { butteraugli, ssim, psnr, moments }
    }
}

/// Resolve a forced backend id to a backend this CPU can actually execute.
///
/// The SIMD kernels are `#[target_feature(...)]` `unsafe` fns: invoking one on a
/// CPU that lacks the feature is undefined behaviour (typically SIGILL). Only the
/// `Auto` arm runs through `detect_native`, so `Force(id)` must do its own runtime
/// check here and degrade to the next-best supported backend
/// (avx512 -> avx2 -> scalar). Unknown ids fall through to `Scalar`.
///
/// Note: the AVX-512 SSIM/PSNR paths reuse the `#[target_feature(enable="avx2,fma")]`
/// kernels, so an AVX-512 id additionally requires avx2+fma (true on all shipping
/// AVX-512 hardware, but verified here rather than assumed).
fn resolve_forced_backend(id: u8) -> Backend {
    #[cfg(target_arch = "x86_64")]
    {
        let has_avx2 = std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma");
        let has_avx512 = has_avx2
            && std::is_x86_feature_detected!("avx512f")
            && std::is_x86_feature_detected!("avx512bw");
        return match id {
            1 if has_avx2 => Backend::Avx2Strict,
            2 if has_avx2 => Backend::Avx2Rsqrt,
            3 if has_avx512 => Backend::Avx512Strict,
            5 if has_avx512 => Backend::Avx512Rsqrt,
            // Forced AVX-512 on a CPU without it: fall back to AVX2 if available.
            3 if has_avx2 => Backend::Avx2Strict,
            5 if has_avx2 => Backend::Avx2Rsqrt,
            // id=4 is Backend::WasmSimd (discriminant 4). WasmSimd is not a valid x86_64
            // backend — map explicitly to Scalar rather than falling through silently,
            // so a bench user passing Force(4) on x86_64 gets a clear fallback.
            4 => Backend::Scalar,
            _ => Backend::Scalar,
        };
    }
    #[cfg(target_arch = "wasm32")]
    {
        // id=4 is Backend::WasmSimd (discriminant 4); all other ids fall back to Scalar.
        // Without this branch, Force(4) on wasm32 silently returns Scalar, making
        // the flip-flop bench override useless on the primary production target.
        return if id == 4 { Backend::WasmSimd } else { Backend::Scalar };
    }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "wasm32")))]
    {
        let _ = id;
        Backend::Scalar
    }
}

/// CRAWL C-3: single-plane backend dispatch for the downsample, factored out so the
/// three X/Y/B planes can run concurrently (see `downsample_dispatch`).
#[inline]
/// Resolve the active SIMD backend for `opts` on this CPU. Shared by
/// `Comparer::new` (reference pyramid) and the test path so both build with the
/// same kernels. A forced SIMD id is honoured only if the CPU actually supports
/// the required target features (else dispatching a `#[target_feature]` kernel is
/// UB/SIGILL); `resolve_forced_backend` degrades avx512→avx2→scalar. The rsqrt
/// variant stays opt-in (Force(2)); Auto picks strict sqrt.
fn resolve_backend(opts: &Opts) -> Backend {
    match opts.backend {
        BackendChoice::ForceScalar => Backend::Scalar,
        BackendChoice::Force(id) => resolve_forced_backend(id),
        BackendChoice::Auto => {
            #[cfg(target_arch = "x86_64")]
            {
                detect_native(false)
            }
            #[cfg(target_arch = "wasm32")]
            {
                simd::detect_wasm()
            }
            #[cfg(not(any(target_arch = "x86_64", target_arch = "wasm32")))]
            {
                Backend::Scalar
            }
        }
    }
}

/// RGBA(u8) → planar X/Y/B through the dispatched backend kernel. Shared by the
/// reference build (`Comparer::new`) and the per-compare test build
/// (`fill_test_xyb`) so both sides run the identical conversion — on AVX2 the
/// scalar-LUT kernel, on AVX-512/wasm their SIMD kernels, else the scalar tail.
fn convert_xyb(backend: Backend, px: &[u8], n: usize, x: &mut [f32], y: &mut [f32], b: &mut [f32]) {
    match backend {
        #[cfg(target_arch = "x86_64")]
        Backend::Avx2Strict | Backend::Avx2Rsqrt => unsafe {
            simd::avx2::pixels_to_xyb_avx2_scalar_lut(px, n, xyb::sqrt_lin_lut_ptr(), x, y, b);
        },
        #[cfg(target_arch = "x86_64")]
        Backend::Avx512Strict | Backend::Avx512Rsqrt => unsafe {
            simd::avx512::pixels_to_xyb_avx512(px, n, xyb::sqrt_lin_lut_ptr(), x, y, b);
        },
        #[cfg(target_arch = "wasm32")]
        Backend::WasmSimd => simd::wasm::pixels_to_xyb_wasm(px, n, xyb::sqrt_lin_lut(), x, y, b),
        _ => xyb::pixels_to_xyb(px, n, x, y, b),
    }
}

fn downsample_one(backend: Backend, src: &[f32], dst: &mut [f32], w: usize, h: usize, dw: usize, dh: usize) {
    match backend {
        #[cfg(target_arch = "x86_64")]
        Backend::Avx2Strict | Backend::Avx2Rsqrt => unsafe {
            simd::avx2::downsample_avx2(src, dst, w, h, dw, dh);
        },
        #[cfg(target_arch = "x86_64")]
        Backend::Avx512Strict | Backend::Avx512Rsqrt => unsafe {
            simd::avx512::downsample_avx512(src, dst, w, h, dw, dh);
        },
        #[cfg(target_arch = "wasm32")]
        Backend::WasmSimd => simd::wasm::downsample_wasm(src, dst, w, h, dw, dh),
        _ => downsample_inplace(src, dst, w, h, dw, dh),
    }
}

/// Box 2× downsample of a plane held in the first `w*h` of `src` into `dst`.
fn downsample_inplace(src: &[f32], dst: &mut [f32], w: usize, h: usize, dw: usize, dh: usize) {
    for y in 0..dh {
        let sy0 = y << 1;
        let sy1 = (sy0 + 1).min(h - 1);
        for x in 0..dw {
            let sx0 = x << 1;
            let sx1 = (sx0 + 1).min(w - 1);
            dst[y * dw + x] = (src[sy0 * w + sx0]
                + src[sy0 * w + sx1]
                + src[sy1 * w + sx0]
                + src[sy1 * w + sx1])
                * 0.25;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checker(w: usize, h: usize) -> Vec<u8> {
        let mut v = vec![0u8; w * h * 4];
        for i in 0..w * h {
            let on = ((i % w) ^ (i / w)) & 1 == 1;
            let c = if on { 200 } else { 40 };
            v[i * 4] = c; v[i * 4 + 1] = c / 2; v[i * 4 + 2] = c / 3; v[i * 4 + 3] = 255;
        }
        v
    }

    #[test]
    fn identical_image_scores_perfect() {
        let (w, h) = (16, 16);
        let img = checker(w, h);
        let mut cmp = Comparer::new(img.clone(), w, h, Opts::default());
        assert!(cmp.butteraugli(&img).abs() < 1e-4);
        assert!((cmp.ssim(&img) - 1.0).abs() < 1e-4);
        assert_eq!(cmp.psnr(&img), f32::INFINITY);
    }

    #[test]
    fn all_is_idempotent() {
        // Calling all() twice on the same Comparer must produce identical Metrics.
        // This verifies that tx/ty/tb mutation from the butteraugli pass is reset
        // correctly and does not corrupt subsequent calls.
        let (w, h) = (16, 16);
        let img = checker(w, h);
        let mut noisy = img.clone();
        for (i, p) in noisy.iter_mut().enumerate() {
            if i % 4 != 3 { *p = p.saturating_add(((i * 7) % 11) as u8); }
        }
        let mut cmp = Comparer::new(img.clone(), w, h, Opts::default());
        let m1 = cmp.all(&noisy);
        let m2 = cmp.all(&noisy);
        assert!((m1.butteraugli - m2.butteraugli).abs() < 1e-6, "butteraugli not idempotent");
        assert!((m1.ssim - m2.ssim).abs() < 1e-6, "ssim not idempotent");
        assert!((m1.psnr - m2.psnr).abs() < 1e-3, "psnr not idempotent");
    }

    #[test]
    fn all_matches_individual_calls() {
        let (w, h) = (16, 16);
        let img = checker(w, h);
        let mut noisy = img.clone();
        for (i, p) in noisy.iter_mut().enumerate() {
            if i % 4 != 3 { *p = p.saturating_add(((i * 7) % 11) as u8); }
        }
        let mut cmp = Comparer::new(img.clone(), w, h, Opts::default());
        let m = cmp.all(&noisy);
        let mut cmp2 = Comparer::new(img.clone(), w, h, Opts::default());
        assert!((m.butteraugli - cmp2.butteraugli(&noisy)).abs() < 1e-5);
        assert!((m.ssim - cmp2.ssim(&noisy)).abs() < 1e-6);
        assert!((m.psnr - cmp2.psnr(&noisy)).abs() < 1e-3);
        // Moments oracle: all() now derives mus/vars from the SSIM test sums; they must be
        // BIT-IDENTICAL to a standalone channel_moments pass over the same buffer.
        let (mus, vars, ch) = ssim::channel_moments(&noisy, w * h, 4, 3);
        assert_eq!(m.moments.ch, ch, "moments channel count");
        assert_eq!(m.moments.mus, mus, "fused mus must equal channel_moments");
        assert_eq!(m.moments.vars, vars, "fused vars must equal channel_moments");
    }

    /// Regression: tiny images (1×N, N×1, 1×1) must not panic with index-out-of-bounds.
    /// `Comparer::new` pushes fewer than 3 levels when width or height reaches 1 during
    /// downscale; the old hard-coded `for s in 0..3` loop would index `self.levels[1]`
    /// or `self.levels[2]` which don't exist for those images.
    #[test]
    fn tiny_image_no_panic() {
        // 1×8: at s=0, h=8 w=1 → `w > 1 && h > 1` is FALSE → only 1 level pushed.
        {
            let (w, h) = (1, 8);
            let img: Vec<u8> = (0..w * h * 4).map(|i| (i % 251) as u8).collect();
            let test: Vec<u8> = (0..w * h * 4).map(|i| ((i + 7) % 251) as u8).collect();
            let mut cmp = Comparer::new(img, w, h, Opts::default());
            let score = cmp.butteraugli(&test);
            assert!(score.is_finite(), "1×8 butteraugli must be finite, got {score}");
            let m = cmp.all(&test);
            assert!(m.butteraugli.is_finite(), "1×8 all().butteraugli must be finite");
        }
        // 8×1: same condition, h=1 at s=0.
        {
            let (w, h) = (8, 1);
            let img: Vec<u8> = (0..w * h * 4).map(|i| (i % 251) as u8).collect();
            let test: Vec<u8> = (0..w * h * 4).map(|i| ((i + 7) % 251) as u8).collect();
            let mut cmp = Comparer::new(img, w, h, Opts::default());
            let score = cmp.butteraugli(&test);
            assert!(score.is_finite(), "8×1 butteraugli must be finite, got {score}");
            let m = cmp.all(&test);
            assert!(m.butteraugli.is_finite(), "8×1 all().butteraugli must be finite");
        }
        // 1×1: extreme degenerate — single pixel, 1 level.
        {
            let (w, h) = (1, 1);
            let img = vec![100u8, 150, 200, 255];
            let test = vec![110u8, 140, 190, 255];
            let mut cmp = Comparer::new(img, w, h, Opts::default());
            let score = cmp.butteraugli(&test);
            assert!(score.is_finite(), "1×1 butteraugli must be finite, got {score}");
            let m = cmp.all(&test);
            assert!(m.butteraugli.is_finite(), "1×1 all().butteraugli must be finite");
        }
        // 2×4: both dims > 1 at s=0, but after one downsample → 1×2, which is ≤ 1 in w
        // → only 2 levels pushed (verifies 2-level path).
        {
            let (w, h) = (2, 4);
            let img: Vec<u8> = (0..w * h * 4).map(|i| (i % 251) as u8).collect();
            let test: Vec<u8> = (0..w * h * 4).map(|i| ((i + 5) % 251) as u8).collect();
            let mut cmp = Comparer::new(img, w, h, Opts::default());
            let score = cmp.butteraugli(&test);
            assert!(score.is_finite(), "2×4 butteraugli must be finite, got {score}");
        }
    }

    /// Parity guard: all() must produce the same values as the three individual calls
    /// on the same Comparer instance. This guards any future fused test-side pass
    /// (e.g., PERC-02) against introducing divergent rounding or state mutation.
    /// Uses the same Comparer for both paths to catch internal state bugs.
    #[test]
    fn all_fused_parity_vs_individual_same_comparer() {
        let (w, h) = (32, 32);
        let img = checker(w, h);
        let mut noisy = img.clone();
        for (i, p) in noisy.iter_mut().enumerate() {
            if i % 4 != 3 { *p = p.saturating_add(((i * 13) % 17) as u8); }
        }
        let mut cmp = Comparer::new(img.clone(), w, h, Opts::default());
        // Call all() first — this mutates tx/ty/tb via butteraugli.
        let m = cmp.all(&noisy);
        // Call individual metrics on the same Comparer after all() resets state.
        let ba = cmp.butteraugli(&noisy);
        let ss = cmp.ssim(&noisy);
        let ps = cmp.psnr(&noisy);
        assert!(
            (m.butteraugli - ba).abs() < 1e-5,
            "butteraugli: all()={} vs individual={}", m.butteraugli, ba
        );
        assert!(
            (m.ssim - ss).abs() < 1e-6,
            "ssim: all()={} vs individual={}", m.ssim, ss
        );
        assert!(
            (m.psnr - ps).abs() < 1e-3,
            "psnr: all()={} vs individual={}", m.psnr, ps
        );
    }
}
