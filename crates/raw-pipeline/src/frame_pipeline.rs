//! K3: Pooled buffer owner + compiled look for sequential batch/video pipelines.
//!
//! `FramePipeline` owns every reusable allocation so a sequential batch loop or
//! a per-frame video encode does not re-allocate on every item.
//!
//! **Scope guard (measured):** reuse wins only on SEQUENTIAL paths. Do NOT pass
//! `FramePipeline` into rayon-parallel batch tile encoders — measured 0.88–0.95×
//! regression (see "CASV video: reuse REJECTED" in the rejection log).

use crate::pipeline::PipelineParams;

// ---------------------------------------------------------------------------
// CompiledLook
// ---------------------------------------------------------------------------

/// Owns `PipelineParams` and documents the split LUT-cache key so callers are
/// explicit about which half changed.
///
/// The LUT-cache key is split into two independent halves:
/// - **Pre-LUT** (linearisation): `black`, `white`, `wb_r/g/b`, `exposure_ev`,
///   `compact_lut`. A contrast-only drag does NOT rebuild these three tables.
/// - **Post-LUT** (tone curve): `contrast`, `shadows`, `highlights`, `whites`,
///   `blacks`. A WB/exposure drag does NOT rebuild the powf-heavy post-LUT.
///
/// For sequential consumers the actual compiled LUTs live in the `pipeline.rs`
/// thread-local (`LUT_CACHE`), which already implements the split-key logic.
/// `CompiledLook` owns the params that drive them and exposes `pre_changed` /
/// `post_changed` so K4's `RawVideoSource` (fixed look) can detect no-op updates
/// without calling into pipeline internals.
pub struct CompiledLook {
    pub params: PipelineParams,
}

impl CompiledLook {
    pub fn new(params: PipelineParams) -> Self {
        Self { params }
    }

    /// Replace look params. The thread-local LUT cache lazily rebuilds only the
    /// changed half (pre vs post) on the next `process_into_auto` call.
    pub fn update(&mut self, params: PipelineParams) {
        self.params = params;
    }

    /// Pre-LUT half changed vs `other` (black/white/WB/exposure/compact_lut).
    /// A contrast-only drag returns `false`.
    pub fn pre_changed(&self, other: &PipelineParams) -> bool {
        let p = &self.params;
        p.black != other.black
            || p.white != other.white
            || p.wb_r.to_bits() != other.wb_r.to_bits()
            || p.wb_g.to_bits() != other.wb_g.to_bits()
            || p.wb_b.to_bits() != other.wb_b.to_bits()
            || p.exposure_ev.to_bits() != other.exposure_ev.to_bits()
            || p.compact_lut != other.compact_lut
    }

    /// Post-LUT half changed vs `other` (contrast/shadows/highlights/whites/blacks).
    /// A WB-only drag returns `false`.
    pub fn post_changed(&self, other: &PipelineParams) -> bool {
        let p = &self.params;
        p.contrast.to_bits() != other.contrast.to_bits()
            || p.shadows.to_bits() != other.shadows.to_bits()
            || p.highlights.to_bits() != other.highlights.to_bits()
            || p.whites.to_bits() != other.whites.to_bits()
            || p.blacks.to_bits() != other.blacks.to_bits()
    }
}

// ---------------------------------------------------------------------------
// FramePipeline
// ---------------------------------------------------------------------------

/// Pooled buffer owner for sequential RAW → image/video pipelines.
///
/// Allocations are grown lazily via `reserve_for(w, h)` and never shrunk, so a
/// batch loop or video encode holds at most the largest-frame working set. Callers
/// write into `raw`, then hand `&raw[..]` to demosaic, tone, and encode helpers
/// that already accept caller-owned slices (`demosaic_bayer_mhc`, `process_into_auto`,
/// `encode_chunked_rgb8`, …).
///
/// The `look` field owns the current `PipelineParams` and exposes `pre_changed` /
/// `post_changed` so callers can communicate which LUT half is dirty without
/// reaching into `pipeline` internals.
pub struct FramePipeline {
    /// Pooled mosaic buffer. Sized to `w * h` u16 samples for the current frame.
    /// Reuse eliminates the per-image ~48 MB alloc at 24 MP.
    pub raw: Vec<u16>,
    /// Demosaic band scratch (rgb16, 3 channels). Used by band-based demosaic paths.
    pub band16: Vec<u16>,
    /// Toned output band (rgb8, 3 channels).
    pub band8: Vec<u8>,
    /// Encode payload scratch passed to `encode_chunked_rgb8` / `VariantSet` encoders.
    pub payload: Vec<u8>,
    /// Compiled look — owns the pipeline params and documents the split LUT key.
    pub look: CompiledLook,
}

impl FramePipeline {
    /// Construct with zero-capacity buffers and the given initial look.
    pub fn new(params: PipelineParams) -> Self {
        Self {
            raw: Vec::new(),
            band16: Vec::new(),
            band8: Vec::new(),
            payload: Vec::new(),
            look: CompiledLook::new(params),
        }
    }

    /// Ensure all pooled buffers have at least `w * h` (mosaic) and `w * h * 3`
    /// (rgb) capacity without shrinking. Call once per frame before decode.
    ///
    /// Does NOT resize `len` — callers use `raw.resize(w*h, 0)` etc. to set
    /// the active region, or pass `w*h` directly to the decode helper.
    pub fn reserve_for(&mut self, w: usize, h: usize) {
        let n = w.saturating_mul(h);
        let rgb = n.saturating_mul(3);
        reserve_at_least(&mut self.raw, n);
        reserve_at_least(&mut self.band16, rgb);
        reserve_at_least(&mut self.band8, rgb);
    }
}

#[inline]
fn reserve_at_least<T>(v: &mut Vec<T>, need: usize) {
    if v.capacity() < need {
        v.reserve(need - v.capacity());
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::PipelineParams;

    #[test]
    fn reserve_grows_on_first_call() {
        let params = PipelineParams::default_olympus();
        let mut fp = FramePipeline::new(params);
        fp.reserve_for(100, 80);
        assert!(fp.raw.capacity() >= 8000);
        assert!(fp.band16.capacity() >= 24000);
        assert!(fp.band8.capacity() >= 24000);
    }

    #[test]
    fn reserve_does_not_shrink() {
        let params = PipelineParams::default_olympus();
        let mut fp = FramePipeline::new(params);
        fp.reserve_for(200, 100);
        let cap_before = fp.raw.capacity();
        fp.reserve_for(10, 10);
        assert_eq!(fp.raw.capacity(), cap_before, "capacity must not shrink");
    }

    #[test]
    fn compiled_look_pre_changed_detects_wb_change() {
        let mut p = PipelineParams::default_olympus();
        let look = CompiledLook::new(p.clone());
        p.wb_r = look.params.wb_r * 1.1;
        assert!(look.pre_changed(&p));
        assert!(!look.post_changed(&p));
    }

    #[test]
    fn compiled_look_post_changed_detects_contrast_change() {
        let mut p = PipelineParams::default_olympus();
        let look = CompiledLook::new(p.clone());
        p.contrast = 0.3;
        assert!(!look.pre_changed(&p));
        assert!(look.post_changed(&p));
    }

    #[test]
    fn compiled_look_no_change() {
        let p = PipelineParams::default_olympus();
        let look = CompiledLook::new(p.clone());
        assert!(!look.pre_changed(&p));
        assert!(!look.post_changed(&p));
    }
}
