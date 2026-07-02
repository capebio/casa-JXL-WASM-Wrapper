//! BSD-clean JPEG XL **encoder** built on our own `jxl-ffi` bindings to libjxl.
//!
//! Replaces the GPL-3.0 `jpegxl-rs` encoder. The strategic shape (per the design
//! spec): **one owned [`Encoder`] holds the `*JxlEncoder` handle; feed it
//! [`Frame`]s, get JXL bytes back.** No hidden state, explicit lifetime (RAII),
//! reuse is visible (`JxlEncoderReset` between encodes).
//!
//! Native only (the WASM JXL path stays on `web/pkg` + `bridge.cpp`).
//!
//! Correctness baked in:
//! - **Reset on every error path**, not just success — a reused [`Encoder`] can
//!   never be poisoned by a prior failure.
//! - **Lossless can't be un-set**: [`Rate::Lossless`] is a distinct variant and
//!   never calls `SetFrameDistance`.
//! - **Extra-channel init is mandatory**: every planar extra channel is declared
//!   with `JxlEncoderSetExtraChannelInfo` before the first frame.
//! - **Alpha is supplied exactly one way** — interleaved (`Frame.alpha`) *or* a
//!   planar `ExtraKind::Alpha`, never both (validated → [`EncodeError::Channels`]).
//! - `Send` but not `Sync`.

#![cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]

use std::cell::Cell;
use std::os::raw::{c_int, c_void};
use std::ptr;

use jxl_ffi as ffi;

const JXL_TRUE: c_int = 1;
const JXL_FALSE: c_int = 0;

#[derive(thiserror::Error, Debug)]
pub enum EncodeError {
    #[error("libjxl encoder error: {0}")]
    Jxl(String),
    #[error("invalid channels: {0}")]
    Channels(String),
    #[error("buffer size mismatch: expected {expected} samples, got {got}")]
    Size { expected: usize, got: usize },
    #[error("JxlEncoderCreate returned null")]
    Create,
}

// ─── Sample types ────────────────────────────────────────────────────────────

/// A pixel sample type libjxl can ingest. Clean-room trait (BSD).
pub trait Sample: Copy {
    /// libjxl pixel data type for this sample.
    fn data_type() -> ffi::JxlDataType;
    /// `(bits_per_sample, exponent_bits_per_sample)` — exponent > 0 means float.
    fn bits_per_sample() -> (u32, u32);
    /// True for floating-point sample types (f16/f32).
    fn is_float() -> bool {
        Self::bits_per_sample().1 > 0
    }
}

impl Sample for u8 {
    fn data_type() -> ffi::JxlDataType {
        ffi::JxlDataType::JXL_TYPE_UINT8
    }
    fn bits_per_sample() -> (u32, u32) {
        (8, 0)
    }
}
impl Sample for u16 {
    fn data_type() -> ffi::JxlDataType {
        ffi::JxlDataType::JXL_TYPE_UINT16
    }
    fn bits_per_sample() -> (u32, u32) {
        (16, 0)
    }
}
impl Sample for half::f16 {
    fn data_type() -> ffi::JxlDataType {
        ffi::JxlDataType::JXL_TYPE_FLOAT16
    }
    fn bits_per_sample() -> (u32, u32) {
        (16, 5)
    }
}
impl Sample for f32 {
    fn data_type() -> ffi::JxlDataType {
        ffi::JxlDataType::JXL_TYPE_FLOAT
    }
    fn bits_per_sample() -> (u32, u32) {
        (32, 8)
    }
}

// ─── Channels ────────────────────────────────────────────────────────────────

/// Kind of a planar extra channel → libjxl `JxlExtraChannelType`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExtraKind {
    Alpha,
    Depth,
    Thermal,
    /// Hyperspectral band. libjxl has no dedicated HSI type → maps to `Optional`.
    Spectral,
    Optional,
}

impl ExtraKind {
    fn to_ffi(self) -> ffi::JxlExtraChannelType {
        match self {
            ExtraKind::Alpha => ffi::JxlExtraChannelType::JXL_CHANNEL_ALPHA,
            ExtraKind::Depth => ffi::JxlExtraChannelType::JXL_CHANNEL_DEPTH,
            ExtraKind::Thermal => ffi::JxlExtraChannelType::JXL_CHANNEL_THERMAL,
            ExtraKind::Spectral | ExtraKind::Optional => {
                ffi::JxlExtraChannelType::JXL_CHANNEL_OPTIONAL
            }
        }
    }
}

/// A planar extra channel (hyperspectral band, depth, thermal, …). `data` is
/// `width * height` samples, borrowed until `encode` returns. libjxl copies the
/// buffer during submission; the wrapper adds no Rust-side staging copy.
pub struct ExtraChannel<'a, S: Sample> {
    pub kind: ExtraKind,
    pub data: &'a [S],
}

/// One image to encode. `color` is interleaved and borrowed until `encode`
/// returns; the wrapper hands it straight to libjxl without Rust-side staging
/// (libjxl copies it internally during submission).
pub struct Frame<'a, S: Sample> {
    /// Interleaved color (+ interleaved alpha when `alpha`); borrowed.
    pub color: &'a [S],
    pub width: u32,
    pub height: u32,
    /// 1 (gray) or 3 (RGB).
    pub color_channels: u32,
    /// Interleaved alpha → color stride is `color_channels + 1`.
    pub alpha: bool,
    pub endianness: ffi::JxlEndianness,
    /// Planar extra channels (hyperspectral / depth / thermal).
    pub extra: &'a [ExtraChannel<'a, S>],
}

impl<'a, S: Sample> Frame<'a, S> {
    fn base(color: &'a [S], width: u32, height: u32, color_channels: u32, alpha: bool) -> Self {
        Frame {
            color,
            width,
            height,
            color_channels,
            alpha,
            endianness: ffi::JxlEndianness::JXL_NATIVE_ENDIAN,
            extra: &[],
        }
    }
    /// Interleaved RGB (3ch).
    pub fn rgb(color: &'a [S], width: u32, height: u32) -> Self {
        Self::base(color, width, height, 3, false)
    }
    /// Interleaved RGBA (3ch + interleaved alpha).
    pub fn rgba(color: &'a [S], width: u32, height: u32) -> Self {
        Self::base(color, width, height, 3, true)
    }
    /// Single-channel grayscale.
    pub fn gray(color: &'a [S], width: u32, height: u32) -> Self {
        Self::base(color, width, height, 1, false)
    }
    /// Stride of the interleaved color buffer (color channels + interleaved alpha).
    fn interleaved_channels(&self) -> u32 {
        self.color_channels + if self.alpha { 1 } else { 0 }
    }
}

impl<'a> Frame<'a, u8> {
    /// Thin sugar for the dominant photo path: interleaved RGBA8.
    pub fn rgba8(px: &'a [u8], width: u32, height: u32) -> Self {
        Self::rgba(px, width, height)
    }
}

// ─── Options ─────────────────────────────────────────────────────────────────

/// Mutually-exclusive rate control. Makes the upstream "set distance after
/// lossless un-lossless's it" bug structurally impossible.
#[derive(Clone, Copy, Debug)]
pub enum Rate {
    /// JPEG-style quality 0..100 → `JxlEncoderDistanceFromQuality`.
    Quality(f32),
    /// Butteraugli distance, 0..25 (0 = mathematically lossless).
    Distance(f32),
    /// True (modular) lossless via `JxlEncoderSetFrameLossless(true)`.
    Lossless,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct GroupOrder {
    pub center: Option<(i64, i64)>,
}

#[derive(Clone, Copy, Debug)]
pub enum ColorEncoding {
    Srgb,
    LinearSrgb,
}

/// Typed mirror of `JxlEncoderFrameSettingId` — deletes the `transmute(14i32)`
/// hack. `Raw(i32)` is the escape hatch for any id not enumerated here.
#[derive(Clone, Copy, Debug)]
pub enum FrameSettingId {
    Effort,
    DecodingSpeed,
    GroupOrder,
    GroupOrderCenterX,
    GroupOrderCenterY,
    ProgressiveDc,
    ProgressiveAc,
    QprogressiveAc,
    Responsive,
    Modular,
    Gaborish,
    Epf,
    Raw(i32),
}

impl FrameSettingId {
    fn to_ffi(self) -> ffi::JxlEncoderFrameSettingId {
        use ffi::JxlEncoderFrameSettingId as F;
        match self {
            FrameSettingId::Effort => F::JXL_ENC_FRAME_SETTING_EFFORT,
            FrameSettingId::DecodingSpeed => F::JXL_ENC_FRAME_SETTING_DECODING_SPEED,
            FrameSettingId::GroupOrder => F::JXL_ENC_FRAME_SETTING_GROUP_ORDER,
            FrameSettingId::GroupOrderCenterX => F::JXL_ENC_FRAME_SETTING_GROUP_ORDER_CENTER_X,
            FrameSettingId::GroupOrderCenterY => F::JXL_ENC_FRAME_SETTING_GROUP_ORDER_CENTER_Y,
            FrameSettingId::ProgressiveDc => F::JXL_ENC_FRAME_SETTING_PROGRESSIVE_DC,
            FrameSettingId::ProgressiveAc => F::JXL_ENC_FRAME_SETTING_PROGRESSIVE_AC,
            FrameSettingId::QprogressiveAc => F::JXL_ENC_FRAME_SETTING_QPROGRESSIVE_AC,
            FrameSettingId::Responsive => F::JXL_ENC_FRAME_SETTING_RESPONSIVE,
            FrameSettingId::Modular => F::JXL_ENC_FRAME_SETTING_MODULAR,
            FrameSettingId::Gaborish => F::JXL_ENC_FRAME_SETTING_GABORISH,
            FrameSettingId::Epf => F::JXL_ENC_FRAME_SETTING_EPF,
            FrameSettingId::Raw(v) => ffi::JxlEncoderFrameSettingId(v),
        }
    }
}

#[derive(Clone, Debug)]
pub struct EncodeOptions {
    pub rate: Rate,
    /// libjxl Effort, 1..=10.
    pub effort: u8,
    pub progressive_dc: Option<i64>,
    pub group_order: Option<GroupOrder>,
    /// `None` = auto: sRGB for integer samples, linear sRGB for float.
    pub color: Option<ColorEncoding>,
    pub use_container: bool,
    pub uses_original_profile: bool,
    /// Escape hatch: any present/future libjxl frame-setting knob.
    pub extra: Vec<(FrameSettingId, i64)>,
}

impl Default for EncodeOptions {
    fn default() -> Self {
        EncodeOptions {
            rate: Rate::Quality(90.0),
            effort: 3,
            progressive_dc: None,
            group_order: None,
            color: None,
            use_container: false,
            uses_original_profile: false,
            extra: Vec::new(),
        }
    }
}

impl EncodeOptions {
    pub fn quality(q: f32) -> Self {
        EncodeOptions {
            rate: Rate::Quality(q),
            ..Default::default()
        }
    }
    pub fn distance(d: f32) -> Self {
        EncodeOptions {
            rate: Rate::Distance(d),
            ..Default::default()
        }
    }
    pub fn lossless() -> Self {
        EncodeOptions {
            rate: Rate::Lossless,
            ..Default::default()
        }
    }
    pub fn with_effort(mut self, effort: u8) -> Self {
        self.effort = effort;
        self
    }

    /// Validate option ranges before calling libjxl. Called automatically by
    /// [`Encoder::encode`]. Exposed so callers can catch bad options early.
    pub fn validate(&self) -> Result<(), EncodeError> {
        match self.rate {
            Rate::Quality(q) if !(0.0..=100.0).contains(&q) => {
                return Err(EncodeError::Channels(format!(
                    "Rate::Quality must be 0.0..=100.0, got {q}"
                )));
            }
            Rate::Distance(d) if !(0.0..=25.0).contains(&d) => {
                return Err(EncodeError::Channels(format!(
                    "Rate::Distance must be 0.0..=25.0, got {d}"
                )));
            }
            _ => {}
        }
        if !(1..=10).contains(&self.effort) {
            return Err(EncodeError::Channels(format!(
                "effort must be 1..=10, got {}",
                self.effort
            )));
        }
        Ok(())
    }
}

// ─── Encoder ─────────────────────────────────────────────────────────────────

/// Owns the `*JxlEncoder` handle (RAII; `Drop` → `JxlEncoderDestroy`). Reused
/// across encodes via `JxlEncoderReset`. `Send`, not `Sync`.
pub struct Encoder {
    enc: *mut ffi::JxlEncoder,
    /// Optional thread-parallel runner, owned; null when single-threaded.
    runner: *mut c_void,
    opts: EncodeOptions,
    /// EMA of compressed-output bytes per *input* byte for the lossy paths.
    /// Normalizing by the full submitted footprint (not pixel count) makes the
    /// next-encode reserve hint stable when one held encoder is reused across
    /// RGB/RGBA, 8/16-bit, float, or planar-extra frames — so it never needs a
    /// reset on a format/quality change. Interior-mutable (`Cell`) so the hot
    /// `&self` encode path can update it; sound because `Encoder` is `!Sync`.
    /// Lossless ignores this (its hint is the exact uncompressed footprint).
    output_ratio_ema: Cell<f32>,
}

/// Initial lossy output/input ratio before the EMA warms. Equals the prior
/// 0.5 bytes/pixel seed for RGB8 (0.5 / 3 source bytes), so the warmed behaviour
/// on the dominant 8-bit path is unchanged.
const OUTPUT_TO_INPUT_SEED: f32 = 1.0 / 6.0;
/// Reserve-hint clamp. Floor avoids many tiny grows on small frames; ceiling
/// caps the speculative reservation for very large inputs.
const OUTPUT_HINT_MIN: usize = 1 << 16;
const OUTPUT_HINT_MAX: usize = 256 << 20;
/// Lossless output ≈ uncompressed input; this slack covers codestream headers
/// so the final grow almost never fires.
const LOSSLESS_OUTPUT_OVERHEAD: usize = 1 << 14;

// libjxl looks up its LCMS context per-use (not stored), same justification as
// upstream: safe to move across threads, not to share.
unsafe impl Send for Encoder {}

impl Encoder {
    /// Construct an encoder. Cheap (`JxlEncoderCreate` = malloc + struct init).
    pub fn new(opts: EncodeOptions) -> Result<Self, EncodeError> {
        let enc = unsafe { ffi::JxlEncoderCreate(ptr::null()) };
        if enc.is_null() {
            return Err(EncodeError::Create);
        }
        Ok(Encoder {
            enc,
            runner: ptr::null_mut(),
            opts,
            output_ratio_ema: Cell::new(OUTPUT_TO_INPUT_SEED),
        })
    }

    /// Construct an encoder with a multi-threaded parallel runner
    /// (`num_threads` worker threads). The runner is held for the encoder's
    /// lifetime and re-applied on every `encode()` (after each `Reset`).
    ///
    /// `num_threads` ≤ 1 → single-threaded (no runner allocated). Pass 0 or 1
    /// to opt out of parallelism without changing the call site.
    pub fn with_threads(opts: EncodeOptions, num_threads: usize) -> Result<Self, EncodeError> {
        let mut e = Self::new(opts)?;
        if num_threads > 1 {
            let runner =
                unsafe { ffi::JxlThreadParallelRunnerCreate(ptr::null(), num_threads) };
            if runner.is_null() {
                return Err(EncodeError::Jxl("JxlThreadParallelRunnerCreate failed".into()));
            }
            e.runner = runner;
        }
        Ok(e)
    }

    /// Add an ad-hoc frame-setting for subsequent encodes. Persists (visible reuse).
    pub fn set_raw(&mut self, id: FrameSettingId, val: i64) {
        self.opts.extra.push((id, val));
    }

    /// Replace the options used by subsequent encodes. Lets one held handle be
    /// reused across a variant set / ingest loop whose levels differ in
    /// quality/effort/progressive — the handle is reused, only options change.
    ///
    /// **Note**: this replaces `opts.extra` in full, discarding any settings
    /// previously added via [`set_raw`]. If you need to preserve ad-hoc settings
    /// use [`options_mut`] instead.
    pub fn set_options(&mut self, opts: EncodeOptions) {
        self.opts = opts;
    }

    /// Borrow the current options (e.g. to tweak before the next encode).
    pub fn options_mut(&mut self) -> &mut EncodeOptions {
        &mut self.opts
    }

    /// Encode one frame to JXL bytes. Resets the handle afterward (on success
    /// *and* on every error path) so the encoder is clean for the next call.
    pub fn encode<S: Sample>(&mut self, frame: &Frame<S>) -> Result<Vec<u8>, EncodeError> {
        let r = unsafe { self.encode_inner(frame) };
        // Reset on every path: a reused Encoder is never poisoned by a failure.
        unsafe { ffi::JxlEncoderReset(self.enc) };
        r
    }

    /// Like [`encode`] but appends output to a caller-supplied buffer. The
    /// caller can `clear()` the buffer between calls to reuse its capacity,
    /// avoiding the per-encode allocation on ingest loops.
    ///
    /// ```rust,ignore
    /// let mut buf = Vec::with_capacity(1 << 20);
    /// for frame in frames {
    ///     buf.clear();
    ///     encoder.encode_into(&frame, &mut buf)?;
    ///     store(&buf);
    /// }
    /// ```
    pub fn encode_into<S: Sample>(
        &mut self,
        frame: &Frame<S>,
        out: &mut Vec<u8>,
    ) -> Result<(), EncodeError> {
        let r = unsafe { self.encode_inner_into(frame, out) };
        unsafe { ffi::JxlEncoderReset(self.enc) };
        r
    }

    unsafe fn encode_inner<S: Sample>(&self, frame: &Frame<S>) -> Result<Vec<u8>, EncodeError> {
        let mut out = Vec::new();
        self.encode_inner_into(frame, &mut out)?;
        Ok(out)
    }

    unsafe fn encode_inner_into<S: Sample>(
        &self,
        frame: &Frame<S>,
        out: &mut Vec<u8>,
    ) -> Result<(), EncodeError> {
        // ── validate ──────────────────────────────────────────────────────
        self.opts.validate()?;
        if frame.color_channels != 1 && frame.color_channels != 3 {
            return Err(EncodeError::Channels(format!(
                "color_channels must be 1 or 3, got {}",
                frame.color_channels
            )));
        }
        let planar_alpha = frame.extra.iter().any(|e| e.kind == ExtraKind::Alpha);
        if frame.alpha && planar_alpha {
            return Err(EncodeError::Channels(
                "alpha supplied both interleaved and as a planar channel".into(),
            ));
        }
        // Checked multiply: on 32-bit/WASM targets width*height*channels can overflow
        // usize and wrap to a small value that spuriously matches frame.color.len(),
        // allowing a wrong-sized buffer to slip past this guard into libjxl.
        let px = (frame.width as usize).checked_mul(frame.height as usize);
        let expected_color = px.and_then(|p| p.checked_mul(frame.interleaved_channels() as usize));
        match expected_color {
            Some(expected) if frame.color.len() == expected => {}
            Some(expected) => {
                return Err(EncodeError::Size {
                    expected,
                    got: frame.color.len(),
                });
            }
            None => {
                return Err(EncodeError::Size {
                    expected: usize::MAX,
                    got: frame.color.len(),
                });
            }
        }
        let px = px.unwrap(); // safe: checked above
        for e in frame.extra {
            if e.data.len() != px {
                return Err(EncodeError::Size {
                    expected: px,
                    got: e.data.len(),
                });
            }
        }

        // Exact source footprint submitted to libjxl: interleaved color samples
        // plus every planar extra channel. Drives the output-reserve hint below;
        // including the extras keeps the lossless reserve from under-budgeting
        // wide spectral/depth stacks. Saturating: the per-channel sizes were
        // already validated against `frame.color.len()`, so this cannot wrap on
        // any input libjxl would accept.
        let total_samples = px
            .saturating_mul(frame.interleaved_channels() as usize)
            .saturating_add(px.saturating_mul(frame.extra.len()));
        let input_bytes = total_samples.saturating_mul(std::mem::size_of::<S>());

        let enc = self.enc;

        // ── parallel runner (must precede basic info / first frame) ────────
        if !self.runner.is_null() {
            let st = ffi::JxlEncoderSetParallelRunner(
                enc,
                Some(ffi::JxlThreadParallelRunner),
                self.runner,
            );
            check_enc(st, "JxlEncoderSetParallelRunner", enc)?;
        }

        if self.opts.use_container {
            let st = ffi::JxlEncoderUseContainer(enc, JXL_TRUE);
            check_enc(st, "JxlEncoderUseContainer", enc)?;
        }

        // ── basic info ─────────────────────────────────────────────────────
        let (bits, exp_bits) = S::bits_per_sample();
        let lossless = matches!(self.opts.rate, Rate::Lossless);
        // interleaved alpha occupies one extra channel slot (index 0).
        let alpha_extra = if frame.alpha { 1 } else { 0 };
        let num_extra = alpha_extra + frame.extra.len() as u32;

        let mut info = std::mem::MaybeUninit::<ffi::JxlBasicInfo>::uninit();
        ffi::JxlEncoderInitBasicInfo(info.as_mut_ptr());
        let mut info = info.assume_init();
        info.xsize = frame.width;
        info.ysize = frame.height;
        info.bits_per_sample = bits;
        info.exponent_bits_per_sample = exp_bits;
        info.num_color_channels = frame.color_channels;
        info.num_extra_channels = num_extra;
        if frame.alpha || planar_alpha {
            info.alpha_bits = bits;
            info.alpha_exponent_bits = exp_bits;
            info.alpha_premultiplied = JXL_FALSE;
        }
        // Lossless requires the original profile to be preserved bit-exact.
        info.uses_original_profile =
            if lossless || self.opts.uses_original_profile { JXL_TRUE } else { JXL_FALSE };
        check_enc(ffi::JxlEncoderSetBasicInfo(enc, &info), "JxlEncoderSetBasicInfo", enc)?;

        // ── declare planar extra channels (mandatory init) ─────────────────
        // Interleaved alpha is handled by libjxl from alpha_bits + the 4th
        // interleaved sample, so it is not declared here. Planar extras start
        // after the interleaved-alpha slot.
        for (i, e) in frame.extra.iter().enumerate() {
            let idx = alpha_extra as usize + i;
            let mut ci = std::mem::MaybeUninit::<ffi::JxlExtraChannelInfo>::uninit();
            ffi::JxlEncoderInitExtraChannelInfo(e.kind.to_ffi(), ci.as_mut_ptr());
            let mut ci = ci.assume_init();
            ci.bits_per_sample = bits;
            ci.exponent_bits_per_sample = exp_bits;
            check_enc(
                ffi::JxlEncoderSetExtraChannelInfo(enc, idx, &ci),
                "JxlEncoderSetExtraChannelInfo",
                enc,
            )?;
        }

        // ── color encoding ─────────────────────────────────────────────────
        let is_gray = frame.color_channels == 1;
        let want = self.opts.color.unwrap_or(if S::is_float() {
            ColorEncoding::LinearSrgb
        } else {
            ColorEncoding::Srgb
        });
        let mut ce = std::mem::MaybeUninit::<ffi::JxlColorEncoding>::uninit();
        match want {
            ColorEncoding::Srgb => {
                ffi::JxlColorEncodingSetToSRGB(ce.as_mut_ptr(), is_gray as c_int)
            }
            ColorEncoding::LinearSrgb => {
                ffi::JxlColorEncodingSetToLinearSRGB(ce.as_mut_ptr(), is_gray as c_int)
            }
        }
        let ce = ce.assume_init();
        check_enc(ffi::JxlEncoderSetColorEncoding(enc, &ce), "JxlEncoderSetColorEncoding", enc)?;

        // ── frame settings ─────────────────────────────────────────────────
        let fs = ffi::JxlEncoderFrameSettingsCreate(enc, ptr::null());
        if fs.is_null() {
            return Err(EncodeError::Jxl("JxlEncoderFrameSettingsCreate failed".into()));
        }
        set_opt(fs, enc, FrameSettingId::Effort, self.opts.effort as i64)?;
        match self.opts.rate {
            Rate::Lossless => {
                check_enc(
                    ffi::JxlEncoderSetFrameLossless(fs, JXL_TRUE),
                    "JxlEncoderSetFrameLossless",
                    enc,
                )?;
            }
            Rate::Distance(d) => {
                check_enc(ffi::JxlEncoderSetFrameDistance(fs, d), "JxlEncoderSetFrameDistance", enc)?;
            }
            Rate::Quality(q) => {
                let d = ffi::JxlEncoderDistanceFromQuality(q);
                check_enc(ffi::JxlEncoderSetFrameDistance(fs, d), "JxlEncoderSetFrameDistance", enc)?;
            }
        }
        if let Some(dc) = self.opts.progressive_dc {
            set_opt(fs, enc, FrameSettingId::ProgressiveDc, dc)?;
        }
        if let Some(go) = self.opts.group_order {
            set_opt(fs, enc, FrameSettingId::GroupOrder, 1)?;
            if let Some((cx, cy)) = go.center {
                set_opt(fs, enc, FrameSettingId::GroupOrderCenterX, cx)?;
                set_opt(fs, enc, FrameSettingId::GroupOrderCenterY, cy)?;
            }
        }
        for &(id, val) in &self.opts.extra {
            set_opt(fs, enc, id, val)?;
        }

        // ── add interleaved color frame (no Rust-side staging; libjxl copies) ─
        let pf = ffi::JxlPixelFormat {
            num_channels: frame.interleaved_channels(),
            data_type: S::data_type(),
            endianness: frame.endianness,
            align: 0,
        };
        let color_bytes = std::mem::size_of_val(frame.color);
        check_enc(
            ffi::JxlEncoderAddImageFrame(
                fs,
                &pf,
                frame.color.as_ptr() as *const c_void,
                color_bytes,
            ),
            "JxlEncoderAddImageFrame",
            enc,
        )?;

        // ── supply planar extra-channel buffers (no Rust-side staging) ─────
        let pf1 = ffi::JxlPixelFormat {
            num_channels: 1,
            data_type: S::data_type(),
            endianness: frame.endianness,
            align: 0,
        };
        for (i, e) in frame.extra.iter().enumerate() {
            let idx = (alpha_extra as usize + i) as u32;
            check_enc(
                ffi::JxlEncoderSetExtraChannelBuffer(
                    fs,
                    &pf1,
                    e.data.as_ptr() as *const c_void,
                    std::mem::size_of_val(e.data),
                    idx,
                ),
                "JxlEncoderSetExtraChannelBuffer",
                enc,
            )?;
        }

        ffi::JxlEncoderCloseInput(enc);

        // ── drain output (write into uninitialized spare capacity) ─────────
        // No zero-fill: we `reserve` raw capacity and hand libjxl a pointer into
        // the uninitialized tail, then `set_len` only over the bytes it actually
        // wrote. `out`'s len stays at `base` for the whole loop, so the existing
        // append-and-truncate semantics of `encode_into` are preserved exactly.
        //
        // Rate-aware hint (see `output_hint_bytes`): lossless budgets the exact
        // uncompressed footprint (color + extras); lossy scales the same
        // footprint by the warmed output/input EMA, so the grow branch below
        // almost never fires after the first frame. Clamped to [64 KiB, 256 MiB].
        let lossy = !matches!(self.opts.rate, Rate::Lossless);
        let hint_bytes = output_hint_bytes(input_bytes, lossy, self.output_ratio_ema.get());

        let base = out.len();
        out.reserve(hint_bytes); // raw capacity; not zeroed
        let mut pos = base;
        loop {
            // `len` is pinned at `base`; the writable window is the spare capacity.
            let cap = out.capacity();
            let mut next = out.as_mut_ptr().add(pos);
            let mut avail = cap - pos;
            let st = ffi::JxlEncoderProcessOutput(enc, &mut next, &mut avail);
            let written = (cap - pos) - avail;
            pos += written;
            if st == ffi::JxlEncoderStatus::JXL_ENC_SUCCESS {
                out.set_len(pos); // commit only the bytes libjxl wrote
                if lossy && input_bytes != 0 {
                    let ratio = (pos - base) as f64 / input_bytes as f64;
                    // 50/50 EMA: tracks content drift without overreacting.
                    self.output_ratio_ema
                        .set(0.5 * self.output_ratio_ema.get() + 0.5 * ratio as f32);
                }
                break;
            } else if st == ffi::JxlEncoderStatus::JXL_ENC_NEED_MORE_OUTPUT {
                // Amortized doubling of the spare region (min 64 KiB step).
                let grow = (pos - base).max(1 << 16);
                out.reserve((pos - base) + grow);
            } else {
                return Err(EncodeError::Jxl(format!(
                    "JxlEncoderProcessOutput error (code {})",
                    encoder_error_code(enc)
                )));
            }
        }
        Ok(())
    }
}

/// A pull source of interleaved u8 color pixels for the chunked encoder. libjxl calls
/// `rect` synchronously during encode, in monotonic-ypos order; `rect` may drive lazy
/// decode as a side effect. `num_channels` is 3 (RGB) here.
pub trait ChunkedColorSource {
    fn num_channels(&self) -> u32;
    /// Pointer to pixel data for rect [xpos,ypos, xsize×ysize] + byte stride between rows.
    fn rect(&mut self, xpos: usize, ypos: usize, xsize: usize, ysize: usize) -> (*const u8, usize);
}

/// Whole-image-in-RAM source (the classic behavior behind `encode_chunked_rgb8`).
pub struct WholeImageSource<'a> {
    pub data: &'a [u8],
    pub width: usize,
}
impl ChunkedColorSource for WholeImageSource<'_> {
    fn num_channels(&self) -> u32 { 3 }
    fn rect(&mut self, xpos: usize, ypos: usize, _xs: usize, _ys: usize) -> (*const u8, usize) {
        let stride = self.width * 3;
        (unsafe { self.data.as_ptr().add(ypos * stride + xpos * 3) }, stride)
    }
}

/// Map a 0..=100 quality to a butteraugli distance exactly as [`Encoder::encode`]'s
/// `Rate::Quality` path does (`JxlEncoderDistanceFromQuality`). Lets chunked-encode call
/// sites express the production quality tiers with byte-identical rate settings.
pub fn distance_from_quality(q: f32) -> f32 {
    unsafe { ffi::JxlEncoderDistanceFromQuality(q) }
}

/// Streaming (chunked-frame) RGB8 encode driven by any [`ChunkedColorSource`]. libjxl pulls
/// ≤2048² super-tiles (+border) top-to-bottom via a pull input source and writes compressed
/// output through an output processor, so peak encoder memory is O(super-tile), not O(frame).
/// sRGB / lossy VarDCT; streaming knobs mirror libjxl's own encode_test.cc path. APPENDS the
/// codestream into `out` (positions are mapped past `out.len()` so append is safe). Proven
/// byte-identical to whole-frame `encode` for the production lossy distances AND lossless
/// (examples/chunked_vs_whole_ab.rs; lossless also test-locked in stream_export.rs).
pub fn encode_chunked(
    w: u32,
    h: u32,
    distance: f32,
    effort: i64,
    src: &mut dyn ChunkedColorSource,
    out: &mut Vec<u8>,
) -> Result<(), EncodeError> {
    encode_chunked_threaded(w, h, distance, effort, 1, src, out)
}

/// [`encode_chunked`] with a multi-threaded parallel runner (`num_threads` ≤ 1 = no runner,
/// identical to `encode_chunked`). Output is byte-identical across thread counts — gated by
/// examples/chunked_vs_whole_ab.rs before any caller was wired. Use ONLY for encodes that
/// run serially (e.g. the post-barrier full-res tier), never inside a rayon fan-out.
pub fn encode_chunked_threaded(
    w: u32,
    h: u32,
    distance: f32,
    effort: i64,
    num_threads: usize,
    src: &mut dyn ChunkedColorSource,
    out: &mut Vec<u8>,
) -> Result<(), EncodeError> {
    struct Out<'a> { buf: &'a mut Vec<u8>, base: usize, pos: usize, high: usize, final_pos: Option<usize> }

    unsafe extern "C" fn color_pf(op: *mut c_void, pf: *mut ffi::JxlPixelFormat) {
        let s = &mut *(op as *mut &mut dyn ChunkedColorSource);
        (*pf).num_channels = s.num_channels();
        (*pf).data_type = ffi::JxlDataType::JXL_TYPE_UINT8;
        (*pf).endianness = ffi::JxlEndianness::JXL_NATIVE_ENDIAN;
        (*pf).align = 0;
    }
    unsafe extern "C" fn color_at(
        op: *mut c_void, xpos: usize, ypos: usize, xs: usize, ys: usize, row_offset: *mut usize,
    ) -> *const c_void {
        let s = &mut *(op as *mut &mut dyn ChunkedColorSource);
        let (p, stride) = s.rect(xpos, ypos, xs, ys);
        *row_offset = stride;
        p as *const c_void
    }
    unsafe extern "C" fn src_release(_op: *mut c_void, _buf: *const c_void) {}
    unsafe extern "C" fn out_get(op: *mut c_void, size: *mut usize) -> *mut c_void {
        let o = &mut *(op as *mut Out);
        let want = (*size).max(1 << 16);
        let need = o.base + o.pos + want;
        if o.buf.len() < need { o.buf.resize(need, 0); }
        *size = o.buf.len() - (o.base + o.pos);
        o.buf.as_mut_ptr().add(o.base + o.pos) as *mut c_void
    }
    unsafe extern "C" fn out_release(op: *mut c_void, written: usize) {
        let o = &mut *(op as *mut Out);
        o.pos += written;
        if o.pos > o.high { o.high = o.pos; }
    }
    unsafe extern "C" fn out_seek(op: *mut c_void, position: u64) {
        (*(op as *mut Out)).pos = position as usize;
    }
    unsafe extern "C" fn out_final(op: *mut c_void, position: u64) {
        (*(op as *mut Out)).final_pos = Some(position as usize);
    }

    // RAII for the optional runner: dropped on every exit path, after the encoder
    // (JxlEncoderDestroy runs before each return; the guard drops at scope end).
    struct RunnerGuard(*mut c_void);
    impl Drop for RunnerGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { ffi::JxlThreadParallelRunnerDestroy(self.0) }
            }
        }
    }

    unsafe {
        let enc = ffi::JxlEncoderCreate(ptr::null());
        if enc.is_null() { return Err(EncodeError::Create); }
        // Optional MT runner (must be set before basic info / frame settings).
        let _runner_guard = if num_threads > 1 {
            let r = ffi::JxlThreadParallelRunnerCreate(ptr::null(), num_threads);
            if r.is_null() {
                ffi::JxlEncoderDestroy(enc);
                return Err(EncodeError::Jxl("JxlThreadParallelRunnerCreate failed".into()));
            }
            let g = RunnerGuard(r);
            if ffi::JxlEncoderSetParallelRunner(enc, Some(ffi::JxlThreadParallelRunner), r)
                != ffi::JxlEncoderStatus::JXL_ENC_SUCCESS
            {
                ffi::JxlEncoderDestroy(enc);
                return Err(EncodeError::Jxl("SetParallelRunner (chunked)".into()));
            }
            g
        } else {
            RunnerGuard(ptr::null_mut())
        };
        let mut info = std::mem::MaybeUninit::<ffi::JxlBasicInfo>::uninit();
        ffi::JxlEncoderInitBasicInfo(info.as_mut_ptr());
        let mut info = info.assume_init();
        info.xsize = w;
        info.ysize = h;
        info.bits_per_sample = 8;
        info.exponent_bits_per_sample = 0;
        info.num_color_channels = 3;
        info.num_extra_channels = 0;
        // distance <= 0 selects (modular) lossless, which requires the original profile.
        let lossless = distance <= 0.0;
        info.uses_original_profile = if lossless { JXL_TRUE } else { JXL_FALSE };
        if ffi::JxlEncoderSetBasicInfo(enc, &info) != ffi::JxlEncoderStatus::JXL_ENC_SUCCESS {
            ffi::JxlEncoderDestroy(enc);
            return Err(EncodeError::Jxl("SetBasicInfo".into()));
        }
        let mut ce = std::mem::MaybeUninit::<ffi::JxlColorEncoding>::uninit();
        ffi::JxlColorEncodingSetToSRGB(ce.as_mut_ptr(), JXL_FALSE);
        let ce = ce.assume_init();
        ffi::JxlEncoderSetColorEncoding(enc, &ce);

        let fs = ffi::JxlEncoderFrameSettingsCreate(enc, ptr::null());
        if fs.is_null() {
            ffi::JxlEncoderDestroy(enc);
            return Err(EncodeError::Jxl("FrameSettingsCreate".into()));
        }
        use ffi::JxlEncoderFrameSettingId as FS;
        ffi::JxlEncoderFrameSettingsSetOption(fs, FS::JXL_ENC_FRAME_SETTING_EFFORT, effort);
        // Streaming knobs, mirroring libjxl's own encode_test.cc streaming path.
        ffi::JxlEncoderFrameSettingsSetOption(fs, FS::JXL_ENC_FRAME_SETTING_BUFFERING, 2);
        ffi::JxlEncoderFrameSettingsSetOption(fs, FS::JXL_ENC_FRAME_SETTING_OUTPUT_MODE, 0);
        ffi::JxlEncoderFrameSettingsSetOption(fs, FS::JXL_ENC_FRAME_SETTING_USE_FULL_IMAGE_HEURISTICS, 0);
        if lossless {
            ffi::JxlEncoderSetFrameLossless(fs, JXL_TRUE);
        } else {
            ffi::JxlEncoderSetFrameDistance(fs, distance);
        }

        let base = out.len();
        let mut ostate = Out { buf: out, base, pos: 0, high: 0, final_pos: None };
        let op = ffi::JxlEncoderOutputProcessor {
            opaque: &mut ostate as *mut _ as *mut c_void,
            get_buffer: Some(out_get),
            release_buffer: Some(out_release),
            seek: Some(out_seek),
            set_finalized_position: Some(out_final),
        };
        if ffi::JxlEncoderSetOutputProcessor(enc, op) != ffi::JxlEncoderStatus::JXL_ENC_SUCCESS {
            ffi::JxlEncoderDestroy(enc);
            return Err(EncodeError::Jxl("SetOutputProcessor".into()));
        }

        // Thin pointer to the fat `&mut dyn` (extern fns can't be generic).
        let mut dynsrc: &mut dyn ChunkedColorSource = src;
        let source = ffi::JxlChunkedFrameInputSource {
            opaque: &mut dynsrc as *mut _ as *mut c_void,
            get_color_channels_pixel_format: Some(color_pf),
            get_color_channel_data_at: Some(color_at),
            get_extra_channel_pixel_format: None,
            get_extra_channel_data_at: None,
            release_buffer: Some(src_release),
        };
        // Output processor + is_last=TRUE: AddChunkedFrame drives the whole encode and emits
        // via the processor (no CloseInput/ProcessOutput — matches encode_test.cc). `ostate`
        // and `*src` stay alive across this call (callbacks fire during it).
        let st = ffi::JxlEncoderAddChunkedFrame(fs, JXL_TRUE, source);
        let code = encoder_error_code(enc);
        ffi::JxlEncoderDestroy(enc);
        if st != ffi::JxlEncoderStatus::JXL_ENC_SUCCESS {
            return Err(EncodeError::Jxl(format!("AddChunkedFrame (code {code})")));
        }
        let end = ostate.final_pos.unwrap_or(ostate.high.max(ostate.pos));
        ostate.buf.truncate(base + end);
        Ok(())
    }
}

/// Whole-image RGB8 streaming encode (thin wrapper over [`encode_chunked`]).
pub fn encode_chunked_rgb8(
    rgb: &[u8],
    w: u32,
    h: u32,
    distance: f32,
    effort: i64,
) -> Result<Vec<u8>, EncodeError> {
    assert_eq!(rgb.len(), w as usize * h as usize * 3, "rgb must be w*h*3");
    let mut src = WholeImageSource { data: rgb, width: w as usize };
    let mut out = Vec::new();
    encode_chunked(w, h, distance, effort, &mut src, &mut out)?;
    Ok(out)
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            ffi::JxlEncoderDestroy(self.enc);
            if !self.runner.is_null() {
                ffi::JxlThreadParallelRunnerDestroy(self.runner);
            }
        }
    }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/// Reserve hint for the output drain, computed without initializing the bytes.
/// `input_bytes` is the exact source footprint submitted to libjxl (interleaved
/// color samples plus every planar extra). Lossy scales it by the warmed
/// output/input EMA; lossless reserves the footprint plus header slack. Both are
/// clamped to `[OUTPUT_HINT_MIN, OUTPUT_HINT_MAX]`.
fn output_hint_bytes(input_bytes: usize, lossy: bool, output_ratio: f32) -> usize {
    let estimate = if lossy {
        (input_bytes as f64 * output_ratio as f64) as usize
    } else {
        input_bytes.saturating_add(LOSSLESS_OUTPUT_OVERHEAD)
    };
    estimate.clamp(OUTPUT_HINT_MIN, OUTPUT_HINT_MAX)
}

/// Like `check_status` but also surfaces the libjxl error code for diagnostics.
unsafe fn check_enc(
    status: ffi::JxlEncoderStatus,
    what: &str,
    enc: *mut ffi::JxlEncoder,
) -> Result<(), EncodeError> {
    if status == ffi::JxlEncoderStatus::JXL_ENC_SUCCESS {
        Ok(())
    } else {
        Err(EncodeError::Jxl(format!(
            "{what} failed (code {})",
            encoder_error_code(enc)
        )))
    }
}

unsafe fn set_opt(
    fs: *mut ffi::JxlEncoderFrameSettings,
    enc: *mut ffi::JxlEncoder,
    id: FrameSettingId,
    val: i64,
) -> Result<(), EncodeError> {
    check_enc(
        ffi::JxlEncoderFrameSettingsSetOption(fs, id.to_ffi(), val),
        "JxlEncoderFrameSettingsSetOption",
        enc,
    )
}

unsafe fn encoder_error_code(enc: *mut ffi::JxlEncoder) -> i32 {
    ffi::JxlEncoderGetError(enc).0
}

// ─── free-fn sugar ───────────────────────────────────────────────────────────

/// Thin sugar for the dominant photo path: encode interleaved RGBA8.
pub fn encode_rgba8(
    px: &[u8],
    w: u32,
    h: u32,
    opts: EncodeOptions,
) -> Result<Vec<u8>, EncodeError> {
    Encoder::new(opts)?.encode(&Frame::rgba8(px, w, h))
}

/// Encode interleaved RGB8 (no alpha).
pub fn encode_rgb8(
    px: &[u8],
    w: u32,
    h: u32,
    opts: EncodeOptions,
) -> Result<Vec<u8>, EncodeError> {
    Encoder::new(opts)?.encode(&Frame::rgb(px, w, h))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jxl_decode::decode_interleaved;

    const W: u32 = 32;
    const H: u32 = 24;

    fn has_jxl_magic(b: &[u8]) -> bool {
        (b.len() >= 2 && b[0] == 0xFF && b[1] == 0x0A)
            || (b.len() >= 8 && b[0] == 0 && b[3] == 0x0C && &b[4..8] == b"JXL ")
    }

    fn ramp_u8(channels: u32) -> Vec<u8> {
        let n = (W * H * channels) as usize;
        (0..n).map(|i| (i % 251) as u8).collect()
    }

    /// Deterministic pseudo-random bytes. Incompressible enough that the lossy
    /// encoded size stays large, so a cold reserve hint is guaranteed to
    /// underflow the real output and force the drain grow path.
    fn xorshift_u8(len: usize) -> Vec<u8> {
        let mut state = 0xA511_E9B3u32;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state as u8
            })
            .collect()
    }

    #[test]
    fn output_hint_scales_with_total_input_footprint() {
        // Lossy hint scales with submitted bytes, not pixel count: doubling the
        // footprint (alpha / a planar plane / 8→16 bit) doubles the reservation.
        assert_eq!(output_hint_bytes(1 << 20, true, 0.5), 512 << 10);
        assert_eq!(output_hint_bytes(2 << 20, true, 0.5), 1 << 20);
        // Lossless reserves the exact footprint plus header slack.
        assert_eq!(
            output_hint_bytes(1 << 20, false, OUTPUT_TO_INPUT_SEED),
            (1 << 20) + LOSSLESS_OUTPUT_OVERHEAD,
        );
        // Clamp floor holds for tiny / zero inputs.
        assert_eq!(output_hint_bytes(0, true, 0.5), OUTPUT_HINT_MIN);
        // RGB8 seed reproduces the old 0.5 bytes/pixel reservation exactly
        // (px chosen above the 64 KiB clamp floor so the equality is real).
        let px = 1usize << 18;
        assert_eq!(
            output_hint_bytes(px * 3, true, OUTPUT_TO_INPUT_SEED),
            (px as f64 * 0.5) as usize,
        );
    }

    // ── per-sample-type lossless round-trips (bit-exact for int) ────────────

    #[test]
    fn u8_rgb_lossless_roundtrip_exact() {
        let src = ramp_u8(3);
        let jxl = encode_rgb8(&src, W, H, EncodeOptions::lossless()).unwrap();
        assert!(has_jxl_magic(&jxl));
        let (px, w, h) = decode_interleaved::<u8>(&jxl, 3).unwrap();
        assert_eq!((w, h), (W, H));
        assert_eq!(px, src, "u8 RGB lossless not bit-exact");
    }

    #[test]
    fn u8_rgba_lossless_preserves_alpha() {
        // Distinct alpha pattern so a dropped/flattened alpha is detectable.
        let mut src = vec![0u8; (W * H * 4) as usize];
        for (i, px) in src.chunks_exact_mut(4).enumerate() {
            px[0] = (i % 200) as u8;
            px[1] = 90;
            px[2] = 40;
            px[3] = if i % 3 == 0 { 100 } else { 255 };
        }
        let jxl = encode_rgba8(&src, W, H, EncodeOptions::lossless()).unwrap();
        let (px, _, _) = decode_interleaved::<u8>(&jxl, 4).unwrap();
        assert_eq!(px, src, "u8 RGBA lossless not bit-exact (alpha?)");
    }

    #[test]
    fn u16_gray_lossless_roundtrip_exact() {
        let src: Vec<u16> = (0..(W * H) as usize).map(|i| (i as u16).wrapping_mul(257)).collect();
        let mut enc = Encoder::new(EncodeOptions::lossless()).unwrap();
        let jxl = enc.encode(&Frame::gray(&src, W, H)).unwrap();
        let (px, w, h) = decode_interleaved::<u16>(&jxl, 1).unwrap();
        assert_eq!((w, h), (W, H));
        assert_eq!(px, src, "u16 gray lossless not bit-exact");
    }

    #[test]
    fn f16_rgb_lossless_roundtrip() {
        let src: Vec<half::f16> = (0..(W * H * 3) as usize)
            .map(|i| half::f16::from_f32((i % 97) as f32 / 97.0))
            .collect();
        let mut enc = Encoder::new(EncodeOptions::lossless()).unwrap();
        let jxl = enc.encode(&Frame::rgb(&src, W, H)).unwrap();
        let (px, _, _) = decode_interleaved::<half::f16>(&jxl, 3).unwrap();
        assert_eq!(px.len(), src.len());
        for (a, b) in px.iter().zip(&src) {
            assert!(
                (a.to_f32() - b.to_f32()).abs() <= 1e-3,
                "f16 lossless drift: {} vs {}",
                a.to_f32(),
                b.to_f32()
            );
        }
    }

    #[test]
    fn f32_rgb_lossless_roundtrip() {
        let src: Vec<f32> = (0..(W * H * 3) as usize).map(|i| (i % 131) as f32 / 131.0).collect();
        let mut enc = Encoder::new(EncodeOptions::lossless()).unwrap();
        let jxl = enc.encode(&Frame::rgb(&src, W, H)).unwrap();
        let (px, _, _) = decode_interleaved::<f32>(&jxl, 3).unwrap();
        assert_eq!(px.len(), src.len());
        for (a, b) in px.iter().zip(&src) {
            assert!((a - b).abs() <= 1e-4, "f32 lossless drift: {a} vs {b}");
        }
    }

    // ── planar extra channel ────────────────────────────────────────────────

    #[test]
    fn planar_extra_channel_encodes() {
        let color = ramp_u8(3);
        let depth: Vec<u8> = (0..(W * H) as usize).map(|i| (i % 255) as u8).collect();
        let extra = [ExtraChannel { kind: ExtraKind::Depth, data: &depth }];
        let frame = Frame {
            extra: &extra,
            ..Frame::rgb(&color, W, H)
        };
        let mut enc = Encoder::new(EncodeOptions::lossless()).unwrap();
        let jxl = enc.encode(&frame).unwrap();
        assert!(has_jxl_magic(&jxl));
        // Color still round-trips bit-exact alongside the extra channel.
        let (px, _, _) = decode_interleaved::<u8>(&jxl, 3).unwrap();
        assert_eq!(px, color);
    }

    // ── correctness contracts ───────────────────────────────────────────────

    #[test]
    fn error_path_leaves_encoder_reusable() {
        let mut enc = Encoder::new(EncodeOptions::quality(90.0)).unwrap();
        // Wrong-sized buffer → Size error.
        let bad = vec![0u8; 10];
        let err = enc.encode(&Frame::rgb(&bad, W, H));
        assert!(matches!(err, Err(EncodeError::Size { .. })));
        // The same handle must still encode a valid frame (reset-on-error).
        let good = ramp_u8(3);
        let ok = enc.encode(&Frame::rgb(&good, W, H));
        assert!(ok.is_ok(), "encoder poisoned after error: {:?}", ok.err());
    }

    #[test]
    fn alpha_supplied_twice_is_rejected() {
        let color = vec![0u8; (W * H * 4) as usize];
        let a = vec![0u8; (W * H) as usize];
        let extra = [ExtraChannel { kind: ExtraKind::Alpha, data: &a }];
        let frame = Frame {
            extra: &extra,
            ..Frame::rgba(&color, W, H)
        };
        let mut enc = Encoder::new(EncodeOptions::lossless()).unwrap();
        assert!(matches!(enc.encode(&frame), Err(EncodeError::Channels(_))));
    }

    #[test]
    fn drain_grow_preserves_prefix_and_all_emitted_bytes() {
        // Coverage for the multi-drain grow path (JXL_ENC_NEED_MORE_OUTPUT). The
        // tuned reserve hint means production almost never grows, so this is the
        // only exercise of that branch. Force several grows with a cold, floored
        // hint on incompressible input and assert the grow path stays correct:
        // the caller's prefix survives and every emitted byte matches a clean
        // single-pass reference exactly. Guards the drain loop's pos/base
        // accounting and buffer growth against future regressions (e.g. a change
        // that reuses/reallocates the output such that emitted bytes are lost).
        //
        // NB: the current loop is already correct — `Vec` reallocates by capacity
        // and `realloc` preserves `min(old_cap, new)` bytes, so the emitted tail
        // above `len` survives a relocation. This test locks that in.
        const BIG_W: u32 = 512;
        const BIG_H: u32 = 512;

        let src = xorshift_u8((BIG_W * BIG_H * 3) as usize);
        let frame = Frame::rgb(&src, BIG_W, BIG_H);
        // distance > 0 keeps the encode lossy (so the ratio-scaled hint/grow path
        // runs) and stays large on incompressible noise. distance 0.0 would
        // demand uses_original_profile and libjxl rejects it.
        let opts = EncodeOptions::distance(0.3);

        // Reference: an oversized ratio makes the hint far exceed the real output,
        // so the reference never grows and is produced by a single clean drain.
        let mut reference = Encoder::new(opts.clone()).unwrap();
        reference.output_ratio_ema.set(8.0);
        let expected = reference.encode(&frame).unwrap();

        // encode_into appends: a non-empty caller prefix must survive byte-exact.
        let prefix = [0xA5u8; 17];
        let mut out = prefix.to_vec();
        out.reserve(OUTPUT_HINT_MIN);
        let initial_capacity = out.capacity();

        // Fragment the heap so the grow reallocation actually relocates the
        // buffer — the exact condition under which the pre-fix bug loses bytes.
        let _blocker = vec![0u8; OUTPUT_HINT_MIN];

        assert!(
            prefix.len() + expected.len() > initial_capacity,
            "corpus must exceed the initial reservation to force a grow \
             (expected {} + prefix {} vs cap {})",
            expected.len(),
            prefix.len(),
            initial_capacity,
        );

        let mut enc = Encoder::new(opts).unwrap();
        // Near-zero ratio → hint clamps to the floor → many NEED_MORE_OUTPUT grows.
        enc.output_ratio_ema.set(0.0);
        enc.encode_into(&frame, &mut out).unwrap();

        assert_eq!(&out[..prefix.len()], &prefix[..], "caller prefix clobbered");
        assert_eq!(
            &out[prefix.len()..],
            expected.as_slice(),
            "drain grow path dropped or corrupted emitted output bytes",
        );
    }

    #[test]
    fn one_encoder_reused_across_many_encodes() {
        // Mirrors the variant-set / ingest-loop reuse pattern: one handle, many encodes.
        let src = ramp_u8(3);
        let mut enc = Encoder::new(EncodeOptions::quality(85.0)).unwrap();
        for _ in 0..3 {
            let jxl = enc.encode(&Frame::rgb(&src, W, H)).unwrap();
            assert!(has_jxl_magic(&jxl));
        }
    }

    #[test]
    fn quality_and_distance_produce_valid_jxl() {
        let src = ramp_u8(3);
        for opts in [
            EncodeOptions::quality(90.0),
            EncodeOptions::distance(1.0),
            EncodeOptions::lossless(),
        ] {
            let jxl = encode_rgb8(&src, W, H, opts).unwrap();
            assert!(has_jxl_magic(&jxl));
            assert!(decode_interleaved::<u8>(&jxl, 3).is_some());
        }
    }
}
