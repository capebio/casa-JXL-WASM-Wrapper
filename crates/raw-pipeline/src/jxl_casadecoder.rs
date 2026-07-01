//! **JXL CasaDecoder** — BSD-clean native JPEG XL decoder on our own `jxl-ffi`
//! bindings to libjxl. Sister to `jxl_casaencoder.rs`; replaces the GPL
//! `jxl_lowlevel.rs` (which sat on `jpegxl-sys`).
//!
//! Strategic shape (design spec §2): **one owned [`Decoder`] holds the
//! `*JxlDecoder` handle. Feed it JXL bytes, get pixels back.** No hidden state,
//! explicit lifetime (RAII), reuse is visible (`JxlDecoderReset` between
//! decodes). Input is borrowed (zero-copy in); final pixels are written straight
//! into a typed `Vec<S>` (zero-copy out, no reinterpret pass). Generic over
//! [`Sample`] (`u8`/`u16`/`f16`/`f32`) and channel layout (interleaved + planar
//! extra).
//!
//! Correctness baked in (mirrors the encoder's review findings):
//! - **Reset on every exit path**, success *and* error — a reused [`Decoder`]
//!   can never be poisoned by a prior failure.
//! - **Typed events, no `transmute`** — status is the bindgen NewType
//!   `JxlDecoderStatus`; the loop `==`-compares typed associated consts.
//! - **Extra-channel readback is sized, never assumed** —
//!   `ExtraChannelBufferSize` before `SetExtraChannelBuffer`.
//! - **Decompression-bomb guard** — the pixel/byte budget is checked at
//!   `BASIC_INFO`, *before* any large output allocation.
//! - **Cooperative cancellation** — `opts.cancel` is polled between
//!   `JxlDecoderProcessInput` steps (honest between-steps granularity).
//! - `Send`, not `Sync` (libjxl context looked up per-use, not stored).
//!
//! `DecodeOptions::default()` reproduces the legacy `jxl_lowlevel.rs` behaviour
//! exactly — the parity contract. The `limits`/`cancel`/`keep_orientation`
//! knobs only *refuse* or *observe*; they never alter the pixels of a decode
//! that succeeds within budget.
//!
//! Native only (the WASM JXL path stays on `web/pkg` + `bridge.cpp`).

#![cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
// SpeedCodeReview ✓ 2026-06-20 · opus-4.8[1m] · sweeps=2 +peer-review · Arch 1/0/1 Alg 2/0/1 Code 7/7/0 (x/y/z=found/green/red; all deferrals resolved: JXTC-16 copy→green, ROI-crop/parallel-composite→red w/ evidence)

use std::os::raw::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rayon::prelude::*;

use jxl_ffi as ffi;

// The `Sample` trait + sample/pixel-format mapping are shared with the encoder
// (defined once in `jxl_casaencoder.rs`, per spec §6 — do not duplicate).
pub use crate::jxl_casaencoder::Sample;

// ── Typed status aliases (bindgen NewType assoc consts; no `transmute`) ───────
type St = ffi::JxlDecoderStatus;
const S_SUCCESS: St = ffi::JxlDecoderStatus::JXL_DEC_SUCCESS;
const S_BASIC: St = ffi::JxlDecoderStatus::JXL_DEC_BASIC_INFO;
const S_NEEDOUT: St = ffi::JxlDecoderStatus::JXL_DEC_NEED_IMAGE_OUT_BUFFER;
const S_FULL: St = ffi::JxlDecoderStatus::JXL_DEC_FULL_IMAGE;
const S_PROG: St = ffi::JxlDecoderStatus::JXL_DEC_FRAME_PROGRESSION;
const S_NEEDIN: St = ffi::JxlDecoderStatus::JXL_DEC_NEED_MORE_INPUT;

#[inline]
fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// Native-endian interleaved pixel format for `channels` channels of `S`.
#[inline]
fn pixel_format<S: Sample>(channels: u32) -> ffi::JxlPixelFormat {
    ffi::JxlPixelFormat {
        num_channels: channels,
        data_type: S::data_type(),
        endianness: ffi::JxlEndianness::JXL_NATIVE_ENDIAN,
        align: 0,
    }
}

// ── Public types ─────────────────────────────────────────────────────────────

/// Interleaved colour layout requested from the decoder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channels {
    Gray,
    GrayAlpha,
    Rgb,
    Rgba,
}

impl Channels {
    /// Interleaved channel count (1/2/3/4).
    pub fn count(self) -> u32 {
        match self {
            Channels::Gray => 1,
            Channels::GrayAlpha => 2,
            Channels::Rgb => 3,
            Channels::Rgba => 4,
        }
    }
}

/// Geometry/precision discovered from the bitstream (`JxlBasicInfo`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DecodedMeta {
    pub num_color_channels: u32,
    pub has_alpha: bool,
    /// Stream's stored precision (informational; output precision is `S`).
    pub bits_per_sample: u32,
    pub num_extra_channels: u32,
}

/// A planar extra channel read back from the stream (depth/thermal/spectral/
/// planar-alpha). `data` is `width * height` samples.
#[derive(Clone, Debug)]
pub struct ExtraPlane<S: Sample> {
    pub index: u32,
    pub data: Vec<S>,
}

/// Owned decoded image: interleaved colour `data` (+ optional planar `extra`).
#[derive(Clone, Debug)]
pub struct Image<S: Sample> {
    pub width: u32,
    pub height: u32,
    /// Interleaved channel count actually produced (1/2/3/4).
    pub channels: u32,
    /// Interleaved, `len == width * height * channels`.
    pub data: Vec<S>,
    pub extra: Vec<ExtraPlane<S>>,
    pub meta: DecodedMeta,
}

/// Borrowed analysis view (the measure-then-discard path). Lives only for the
/// `decode_view` closure scope — no owned `Vec` escapes, no copy across a
/// boundary. Ideal for SSIM/Butteraugli/stats (feed the `perceptual/*` kernels).
pub struct ImageView<'a, S: Sample> {
    pub width: u32,
    pub height: u32,
    pub channels: u32,
    pub data: &'a [S],
    pub extra: &'a [ExtraPlane<S>],
    pub meta: &'a DecodedMeta,
}

/// A rectangular viewport to decode (AR / digital-twin / tile seam).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecodeRegion {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Measurement counters emitted by the timing paths (`time_full_decode`,
/// `time_native_decode`). Intended for coarse allocation-movement audits.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DecodeMetrics {
    pub input_bytes: u64,
    pub output_bytes: u64,
    /// Coarse count of major heap allocations in the decode path. Both timing
    /// paths (`time_full_decode`, `time_native_decode`) call `run_full_into`
    /// with `want_extra = false`, which performs exactly one `Vec` allocation
    /// for the output pixel buffer — so the value is `1` in both cases. This
    /// field is NOT a precise per-byte or per-call allocator count; it is a
    /// structural indicator. If the call site ever gains extra-channel readback
    /// (`want_extra = true`) the count would need to be updated (1 + extras).
    pub allocations: u32,
    pub decode_ms: f64,
}

/// Resource budget — refuse decompression bombs *before* allocating output.
#[derive(Clone, Copy, Debug)]
pub struct DecodeLimits {
    pub max_pixels: u64,
    pub max_output_bytes: u64,
}

impl Default for DecodeLimits {
    /// Generous ceilings real images never hit (1 Gpx / 16 GiB) → default
    /// decode is never *altered*, only pathological headers are refused.
    fn default() -> Self {
        DecodeLimits {
            max_pixels: 1_000_000_000,
            max_output_bytes: 16 * 1024 * 1024 * 1024,
        }
    }
}

/// Decode-time knobs. `default()` reproduces the legacy `jxl_lowlevel.rs`
/// behaviour exactly (the parity contract).
#[derive(Clone, Debug, Default)]
pub struct DecodeOptions {
    /// Attach a scope-bound `JxlThreadParallelRunner` (default false = today's
    /// single-threaded behaviour). libjxl MT decode is bit-identical to ST.
    pub parallel: bool,
    /// Accept truncated input: return the best flushed image instead of failing.
    pub allow_partial: bool,
    /// `JxlDecoderSetKeepOrientation` (default false = libjxl applies EXIF
    /// orientation, today's behaviour).
    pub keep_orientation: bool,
    /// Resource budget (see [`DecodeLimits`]).
    pub limits: DecodeLimits,
    /// Cooperative cancellation, polled between libjxl steps.
    pub cancel: Option<Arc<AtomicBool>>,
}

/// Progressive flow control returned by the `decode_progressive` callback.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProgressControl {
    Continue,
    Stop,
}

/// Borrowed (zero-copy) progressive event for the generic object API. `Progress`
/// lends the live output buffer; quality is front-loaded so `pass` matters.
pub enum DecodeEvent<'a, S: Sample> {
    Progress {
        pass: u32,
        width: u32,
        height: u32,
        pixels: &'a [S],
    },
    Final {
        width: u32,
        height: u32,
        pixels: Vec<S>,
    },
}

/// Typed, stage-located decode failure (mirrors the encoder's `EncodeError`).
#[derive(thiserror::Error, Debug)]
pub enum DecodeError {
    #[error("JxlDecoderCreate returned null")]
    Create,
    #[error("JxlDecoderGetBasicInfo failed")]
    BasicInfo,
    #[error("output buffer allocation/binding failed")]
    OutputAlloc,
    #[error("libjxl decode process error")]
    Process,
    #[error("decode exceeds limits: {pixels} px / {bytes} bytes")]
    LimitExceeded { pixels: u64, bytes: u64 },
    #[error("decode cancelled")]
    Cancelled,
    #[error("tile {tile} decode failed: {source}")]
    Tile {
        tile: u32,
        source: Box<DecodeError>,
    },
}

// ── The Decoder object ───────────────────────────────────────────────────────

/// THE object. Owns the libjxl decoder handle (RAII; `Drop` destroys) and, only
/// when `opts.parallel`, a scope-bound `JxlThreadParallelRunner`. Reuse is
/// explicit: hold one `Decoder`, call `decode*` repeatedly — `JxlDecoderReset`
/// cleans state between decodes; no per-call create/destroy on the hot path.
pub struct Decoder {
    handle: *mut ffi::JxlDecoder,
    /// null unless `opts.parallel`.
    runner: *mut c_void,
    opts: DecodeOptions,
}

// libjxl context is looked up per-use, not stored → Send, not Sync.
unsafe impl Send for Decoder {}

/// Resets the libjxl handle on drop, so a reusable [`Decoder`] returns to a clean
/// state on **every** exit from a decode that runs a user callback — success,
/// error, *and* a panic-unwind through the callback (`decode_view`'s `f`,
/// `decode_progressive`'s `on_event`). The non-callback decodes reset inline
/// (no Rust code between the C decode and the reset can unwind), so they don't
/// need this; the callback paths do, or a panicking callback would skip the reset
/// and poison the next decode on the same handle.
struct ResetGuard {
    handle: *mut ffi::JxlDecoder,
}

impl Drop for ResetGuard {
    fn drop(&mut self) {
        unsafe { ffi::JxlDecoderReset(self.handle) };
    }
}

impl Decoder {
    /// Construct a decoder. `JxlDecoderCreate` is a cheap malloc; the (costly)
    /// thread runner is created once here and held across decodes when
    /// `opts.parallel`.
    pub fn new(opts: DecodeOptions) -> Option<Self> {
        unsafe {
            let handle = ffi::JxlDecoderCreate(std::ptr::null());
            if handle.is_null() {
                return None;
            }
            let runner = if opts.parallel {
                let threads = std::thread::available_parallelism()
                    .map(|n| n.get())
                    .unwrap_or(4);
                ffi::JxlThreadParallelRunnerCreate(std::ptr::null(), threads)
            } else {
                std::ptr::null_mut()
            };
            // Reconcile opts.parallel with the actual runner state: if runner
            // creation failed (null), opts.parallel must reflect single-threaded
            // reality so attach_runner and callers are not misled.
            let mut opts = opts;
            opts.parallel = !runner.is_null();
            Some(Decoder {
                handle,
                runner,
                opts,
            })
        }
    }

    /// Like [`Decoder::new`] but pins the thread runner to an **explicit**
    /// `num_threads` instead of `available_parallelism()`. `num_threads <= 1`
    /// means single-threaded (no runner). This is the honest path for benchmark
    /// callers that request a specific thread width (`decode_full_threaded`);
    /// `new()` deliberately keeps its auto-width behaviour. `opts.parallel` is
    /// reconciled to the actual runner state, exactly as in `new()`.
    pub fn with_threads(opts: DecodeOptions, num_threads: usize) -> Option<Self> {
        unsafe {
            let handle = ffi::JxlDecoderCreate(std::ptr::null());
            if handle.is_null() {
                return None;
            }
            let runner = if num_threads > 1 {
                ffi::JxlThreadParallelRunnerCreate(std::ptr::null(), num_threads)
            } else {
                std::ptr::null_mut()
            };
            let mut opts = opts;
            opts.parallel = !runner.is_null();
            Some(Decoder {
                handle,
                runner,
                opts,
            })
        }
    }

    /// Replace the options used by subsequent decodes (the held handle is reused).
    ///
    /// **Note:** `opts.parallel` is reconciled with the live thread-runner state.
    /// The runner is created once in `Decoder::new`; `set_options` cannot start or
    /// stop it. If you pass `opts.parallel = true` but the runner was not created
    /// (because `parallel` was false at construction time), the flag is corrected
    /// to `false` so it accurately reflects actual behaviour.  Conversely, a
    /// runner created at construction is never torn down here — `opts.parallel`
    /// is forced to `true` when a runner is held.
    pub fn set_options(&mut self, mut opts: DecodeOptions) {
        // Force `parallel` to match the actual runner state so callers cannot
        // be misled by opts.parallel diverging from what attach_runner will do.
        opts.parallel = !self.runner.is_null();
        self.opts = opts;
    }

    #[inline]
    fn is_cancelled(&self) -> bool {
        self.opts
            .cancel
            .as_ref()
            // Acquire ensures the cancelling thread's stores are visible before we
            // observe the flag as set; Relaxed is insufficient for cross-thread visibility.
            .is_some_and(|c| c.load(Ordering::Acquire))
    }

    unsafe fn attach_runner(&self) -> Result<(), DecodeError> {
        if self.runner.is_null() {
            return Ok(());
        }
        if ffi::JxlDecoderSetParallelRunner(
            self.handle,
            Some(ffi::JxlThreadParallelRunner),
            self.runner,
        ) != S_SUCCESS
        {
            return Err(DecodeError::Process);
        }
        Ok(())
    }

    /// Decode the full image to interleaved `S` pixels (+ planar extra channels).
    /// Resets the handle on every exit path so the `Decoder` stays reusable.
    pub fn decode<S: Sample>(&mut self, jxl: &[u8], ch: Channels) -> Result<Image<S>, DecodeError> {
        let mut data: Vec<S> = Vec::new();
        let r = unsafe { self.run_full_into::<S>(jxl, ch.count(), &mut data, true) };
        unsafe { ffi::JxlDecoderReset(self.handle) };
        let (w, h, meta, extra) = r?;
        Ok(Image {
            width: w,
            height: h,
            channels: ch.count(),
            data,
            extra,
            meta,
        })
    }

    /// Decode into a caller-owned buffer reused across calls — **zero
    /// per-decode allocation** on the hot path (the "allocate once, reuse
    /// forever" win). Interleaved colour only; planar extra channels are not
    /// read back (use [`Decoder::decode`] for those). Returns discovered meta;
    /// `buf` ends at length `width * height * channels`.
    pub fn decode_into<S: Sample>(
        &mut self,
        jxl: &[u8],
        ch: Channels,
        buf: &mut Vec<S>,
    ) -> Result<DecodedMeta, DecodeError> {
        let r = unsafe { self.run_full_into::<S>(jxl, ch.count(), buf, false) };
        unsafe { ffi::JxlDecoderReset(self.handle) };
        let (_, _, meta, _) = r?;
        Ok(meta)
    }

    /// Decode, lend the buffer to `f`, then reset. No owned `Vec` escapes; no
    /// copy across a boundary — the correct home for measure-then-discard
    /// analysis (SSIM/Butteraugli/stats over the borrow).
    pub fn decode_view<S: Sample, R>(
        &mut self,
        jxl: &[u8],
        ch: Channels,
        f: impl FnOnce(ImageView<S>) -> R,
    ) -> Result<R, DecodeError> {
        // RAII reset: fires on the normal return *and* if `f` panics — without it
        // a panicking analysis closure would leave the handle un-reset and poison
        // the next decode (the Decoder is built to be reused).
        let _reset = ResetGuard { handle: self.handle };
        let mut data: Vec<S> = Vec::new();
        let r = unsafe { self.run_full_into::<S>(jxl, ch.count(), &mut data, true) };
        match r {
            Ok((w, h, meta, extra)) => {
                let view = ImageView {
                    width: w,
                    height: h,
                    channels: ch.count(),
                    data: &data,
                    extra: &extra,
                    meta: &meta,
                };
                Ok(f(view))
            }
            Err(e) => Err(e),
        }
    }

    /// Region decode (AR / digital-twin / tile seam) of a **monolithic** codestream.
    /// Decodes the full image then crops to the clamped rect.
    ///
    /// This is not a partial-work decode and cannot become one: libjxl 0.11's stable
    /// `JxlDecoder` API exposes **no** spatial ROI/crop setter (only
    /// `SetImageOutBuffer` for the whole frame, `SetPreviewOutBuffer` for an embedded
    /// thumbnail, and `SkipFrames`/`SkipCurrentFrame` for *temporal* selection). A
    /// monolithic JXL frame is group-coded with no public per-rectangle entry point,
    /// so "decode only the viewport" is impossible here. Callers needing true
    /// decode-only-the-region work must encode as a JXTC tile container and use
    /// [`decode_jxtc_region`], which decodes only the overlapping tiles. The durable
    /// shape lives here so call sites are stable; the efficiency lives in JXTC.
    pub fn decode_region<S: Sample>(
        &mut self,
        jxl: &[u8],
        ch: Channels,
        r: DecodeRegion,
    ) -> Result<Image<S>, DecodeError> {
        let full = self.decode::<S>(jxl, ch)?;
        let cc = ch.count() as usize;
        let x = r.x.min(full.width);
        let y = r.y.min(full.height);
        let w = r.width.min(full.width - x);
        let h = r.height.min(full.height - y);
        if w == 0 || h == 0 {
            return Ok(Image {
                width: 0,
                height: 0,
                channels: ch.count(),
                data: Vec::new(),
                extra: Vec::new(),
                meta: full.meta,
            });
        }
        // Whole-image fast path: a viewport that (after clamping) equals the full
        // frame needs no crop — hand back the decoded image directly instead of
        // re-allocating and row-copying colour + every extra plane into an
        // identical-size buffer. Byte-identical result; saves one full-frame copy.
        if x == 0 && y == 0 && w == full.width && h == full.height {
            return Ok(full);
        }
        let row = w as usize * cc;
        let mut data: Vec<S> = Vec::with_capacity(h as usize * row);
        for ry in 0..h {
            let src_off = ((y + ry) as usize * full.width as usize + x as usize) * cc;
            data.extend_from_slice(&full.data[src_off..src_off + row]);
        }
        // Crop extra planes (depth, spectral, thermal, etc.) to the same region.
        // Each extra plane is planar: width * height samples, one sample per pixel.
        let extra: Vec<ExtraPlane<S>> = full
            .extra
            .into_iter()
            .map(|plane| {
                let mut plane_data: Vec<S> = Vec::with_capacity(h as usize * w as usize);
                for ry in 0..h {
                    let src_off = (y + ry) as usize * full.width as usize + x as usize;
                    plane_data.extend_from_slice(&plane.data[src_off..src_off + w as usize]);
                }
                ExtraPlane { index: plane.index, data: plane_data }
            })
            .collect();
        Ok(Image {
            width: w,
            height: h,
            channels: ch.count(),
            data,
            extra,
            meta: full.meta,
        })
    }

    /// Progressive decode (`FRAME_PROGRESSION` + `FlushImage`). `on_event`
    /// receives borrowed `Progress` passes and may return [`ProgressControl::Stop`]
    /// to early-out (returns best-so-far). The final full image is the return
    /// value. Cooperative cancellation + limits apply.
    pub fn decode_progressive<S: Sample>(
        &mut self,
        jxl: &[u8],
        ch: Channels,
        mut on_event: impl FnMut(DecodeEvent<S>) -> ProgressControl,
    ) -> Result<Image<S>, DecodeError> {
        // RAII reset: fires on success/error *and* on a panic-unwind through
        // `on_event`, keeping the reused handle clean. (See `ResetGuard`.)
        let _reset = ResetGuard { handle: self.handle };
        unsafe { self.run_progressive_into::<S>(jxl, ch.count(), &mut on_event) }
    }

    /// Timing-only full decode at a fixed **RGBA8** output (measurement path;
    /// pixels written to scratch and dropped). Returns movement counters.
    ///
    /// Always requests 4-channel output regardless of the stream's native channel
    /// count. For gray/RGB inputs this inflates `output_bytes` and folds in
    /// channel-upsample work not present in a native decode — a valid upper bound
    /// for photo (RGBA) decodes, but a *poisoned* number for decoder-throughput
    /// experiments. Use [`Decoder::time_native_decode`] for the honest figure.
    pub fn time_full_decode(&mut self, jxl: &[u8]) -> Result<DecodeMetrics, DecodeError> {
        let mut scratch: Vec<u8> = Vec::new();
        let t0 = Instant::now();
        let r = unsafe { self.run_full_into::<u8>(jxl, 4, &mut scratch, false) };
        let elapsed = t0.elapsed();
        unsafe { ffi::JxlDecoderReset(self.handle) };
        r?;
        Ok(DecodeMetrics {
            input_bytes: jxl.len() as u64,
            output_bytes: scratch.len() as u64, // u8 elems == bytes
            allocations: 1,
            decode_ms: ms(elapsed),
        })
    }

    /// Header-only peek: process just far enough to read `JxlBasicInfo`, returning
    /// the discovered geometry/precision. Subscribes `BASIC_INFO` only — no output
    /// buffer is bound and no pixels are produced. Caller resets the handle after.
    unsafe fn peek_meta(&self, jxl: &[u8]) -> Result<DecodedMeta, DecodeError> {
        let dec = self.handle;
        if ffi::JxlDecoderSubscribeEvents(dec, S_BASIC.0) != S_SUCCESS {
            return Err(DecodeError::Process);
        }
        if ffi::JxlDecoderSetInput(dec, jxl.as_ptr(), jxl.len()) != S_SUCCESS {
            return Err(DecodeError::Process);
        }
        ffi::JxlDecoderCloseInput(dec);
        let mut info = std::mem::MaybeUninit::<ffi::JxlBasicInfo>::uninit();
        loop {
            let status = ffi::JxlDecoderProcessInput(dec);
            if status == S_BASIC {
                if ffi::JxlDecoderGetBasicInfo(dec, info.as_mut_ptr()) != S_SUCCESS {
                    return Err(DecodeError::BasicInfo);
                }
                let bi = info.assume_init_ref();
                return Ok(DecodedMeta {
                    num_color_channels: bi.num_color_channels,
                    has_alpha: bi.alpha_bits > 0,
                    bits_per_sample: bi.bits_per_sample,
                    num_extra_channels: bi.num_extra_channels,
                });
            } else if status == S_SUCCESS {
                // Stream ended before basic info surfaced — malformed header.
                return Err(DecodeError::BasicInfo);
            } else {
                // S_NEEDIN (truncated before header) | ERROR | unexpected.
                return Err(DecodeError::Process);
            }
        }
    }

    /// Timing-only full decode at the stream's **native** channel count (no RGBA
    /// expansion). Peeks `JxlBasicInfo` to learn the channel count, then times only
    /// the full decode. Unlike [`Decoder::time_full_decode`] this neither inflates
    /// `output_bytes` nor folds channel-upsample work into the measurement for
    /// gray/RGB inputs — the honest figure for decoder-throughput experiments.
    pub fn time_native_decode(&mut self, jxl: &[u8]) -> Result<DecodeMetrics, DecodeError> {
        let meta = unsafe { self.peek_meta(jxl) };
        unsafe { ffi::JxlDecoderReset(self.handle) };
        let meta = meta?;
        let nch = meta.num_color_channels + if meta.has_alpha { 1 } else { 0 };
        // num_color_channels is 1 or 3 for valid streams; alpha adds at most 1.
        // Refuse a degenerate/over-wide count rather than mis-size the decode.
        if nch == 0 || nch > 4 {
            return Err(DecodeError::BasicInfo);
        }
        let mut scratch: Vec<u8> = Vec::new();
        let t0 = Instant::now();
        let r = unsafe { self.run_full_into::<u8>(jxl, nch, &mut scratch, false) };
        let elapsed = t0.elapsed();
        unsafe { ffi::JxlDecoderReset(self.handle) };
        r?;
        Ok(DecodeMetrics {
            input_bytes: jxl.len() as u64,
            output_bytes: scratch.len() as u64, // u8 elems == bytes
            allocations: 1,
            decode_ms: ms(elapsed),
        })
    }

    /// Raw interleaved decode (no extra readback). Backs the compat free-fns.
    fn run_raw<S: Sample>(
        &mut self,
        jxl: &[u8],
        channels: u32,
    ) -> Result<(u32, u32, DecodedMeta, Vec<S>), DecodeError> {
        let mut data: Vec<S> = Vec::new();
        let r = unsafe { self.run_full_into::<S>(jxl, channels, &mut data, false) };
        unsafe { ffi::JxlDecoderReset(self.handle) };
        let (w, h, meta, _) = r?;
        Ok((w, h, meta, data))
    }

    /// Common one-shot decode driver. Writes final interleaved pixels straight
    /// into `buf` (zero-copy out). Caller resets the handle afterward.
    unsafe fn run_full_into<S: Sample>(
        &self,
        jxl: &[u8],
        channels: u32,
        buf: &mut Vec<S>,
        want_extra: bool,
    ) -> Result<(u32, u32, DecodedMeta, Vec<ExtraPlane<S>>), DecodeError> {
        let dec = self.handle;
        self.attach_runner()?;
        if self.opts.keep_orientation {
            ffi::JxlDecoderSetKeepOrientation(dec, 1);
        }
        // libjxl 0.11: JXL_DEC_NEED_IMAGE_OUT_BUFFER=5 is a sequential return
        // code (not a bit flag); JxlDecoderSubscribeEvents rejects values with
        // bits 0-5 set. NEEDOUT is returned automatically without subscription.
        let events = S_BASIC.0 | S_FULL.0;
        if ffi::JxlDecoderSubscribeEvents(dec, events) != S_SUCCESS {
            return Err(DecodeError::Process);
        }
        if ffi::JxlDecoderSetInput(dec, jxl.as_ptr(), jxl.len()) != S_SUCCESS {
            return Err(DecodeError::Process);
        }
        ffi::JxlDecoderCloseInput(dec);

        let pf = pixel_format::<S>(channels);
        let epf = pixel_format::<S>(1);
        let esz = std::mem::size_of::<S>();
        let mut info = std::mem::MaybeUninit::<ffi::JxlBasicInfo>::uninit();
        let mut meta = DecodedMeta::default();
        let (mut w, mut h) = (0u32, 0u32);
        let mut extra: Vec<ExtraPlane<S>> = Vec::new();

        loop {
            if self.is_cancelled() {
                return Err(DecodeError::Cancelled);
            }
            let status = ffi::JxlDecoderProcessInput(dec);
            if status == S_BASIC {
                if ffi::JxlDecoderGetBasicInfo(dec, info.as_mut_ptr()) != S_SUCCESS {
                    return Err(DecodeError::BasicInfo);
                }
                let bi = info.assume_init_ref();
                w = bi.xsize;
                h = bi.ysize;
                meta = DecodedMeta {
                    num_color_channels: bi.num_color_channels,
                    has_alpha: bi.alpha_bits > 0,
                    bits_per_sample: bi.bits_per_sample,
                    num_extra_channels: bi.num_extra_channels,
                };
                // Decompression-bomb guard: refuse BEFORE any large allocation.
                let pixels = w as u64 * h as u64;
                let out_bytes = pixels
                    .checked_mul(channels as u64)
                    .and_then(|n| n.checked_mul(esz as u64))
                    .ok_or(DecodeError::LimitExceeded {
                        pixels,
                        bytes: u64::MAX,
                    })?;
                if pixels > self.opts.limits.max_pixels
                    || out_bytes > self.opts.limits.max_output_bytes
                {
                    return Err(DecodeError::LimitExceeded {
                        pixels,
                        bytes: out_bytes,
                    });
                }
            } else if status == S_NEEDOUT {
                let mut size_bytes = 0usize;
                if ffi::JxlDecoderImageOutBufferSize(dec, &pf, &mut size_bytes) != S_SUCCESS {
                    return Err(DecodeError::OutputAlloc);
                }
                if size_bytes == 0 || size_bytes % esz != 0 {
                    return Err(DecodeError::OutputAlloc);
                }
                let elems = size_bytes / esz;
                // Zero-copy out: typed Vec<S>, libjxl writes straight into it.
                buf.clear();
                buf.reserve(elems);
                buf.set_len(elems);
                // Zero only for allow_partial: partial flushes expose uninitialised bytes
                // to the caller. On the normal (non-partial) path libjxl fills every byte
                // before returning S_FULL, so zeroing is unnecessary and wastes one full
                // memory sweep (~10-20 ms for 80 MB RGBA8 at 20 MP).
                if self.opts.allow_partial {
                    std::ptr::write_bytes(buf.as_mut_ptr(), 0, elems);
                }
                if ffi::JxlDecoderSetImageOutBuffer(
                    dec,
                    &pf,
                    buf.as_mut_ptr() as *mut c_void,
                    size_bytes,
                ) != S_SUCCESS
                {
                    return Err(DecodeError::OutputAlloc);
                }
                if want_extra {
                    for idx in 0..meta.num_extra_channels {
                        let mut ebytes = 0usize;
                        if ffi::JxlDecoderExtraChannelBufferSize(dec, &epf, &mut ebytes, idx)
                            != S_SUCCESS
                        {
                            continue;
                        }
                        if ebytes == 0 || ebytes % esz != 0 {
                            continue;
                        }
                        let n = ebytes / esz;
                        let mut plane: Vec<S> = Vec::with_capacity(n);
                        plane.set_len(n);
                        // Mirror the main-buffer policy above: only zero when a
                        // partial flush could expose uninitialised samples. On the
                        // normal path libjxl fills every extra-channel sample before
                        // returning S_FULL, so the memset is pure waste otherwise.
                        if self.opts.allow_partial {
                            std::ptr::write_bytes(plane.as_mut_ptr(), 0, n);
                        }
                        if ffi::JxlDecoderSetExtraChannelBuffer(
                            dec,
                            &epf,
                            plane.as_mut_ptr() as *mut c_void,
                            ebytes,
                            idx,
                        ) == S_SUCCESS
                        {
                            extra.push(ExtraPlane { index: idx, data: plane });
                        }
                    }
                }
            } else if status == S_FULL || status == S_SUCCESS {
                break;
            } else if status == S_NEEDIN {
                // Truncated input. With allow_partial + a bound buffer, hand back
                // the best flush; otherwise it's a hard error.
                if self.opts.allow_partial && !buf.is_empty() && w > 0 && h > 0 {
                    let _ = ffi::JxlDecoderFlushImage(dec);
                    break;
                }
                return Err(DecodeError::Process);
            } else {
                // ERROR | unexpected.
                return Err(DecodeError::Process);
            }
        }
        if w == 0 || h == 0 || buf.is_empty() {
            return Err(DecodeError::Process);
        }
        Ok((w, h, meta, extra))
    }

    /// Progressive driver. Emits borrowed `Progress` passes via `on_event`;
    /// returns the final (or best-so-far on `Stop`/partial) image.
    unsafe fn run_progressive_into<S: Sample>(
        &self,
        jxl: &[u8],
        channels: u32,
        on_event: &mut impl FnMut(DecodeEvent<S>) -> ProgressControl,
    ) -> Result<Image<S>, DecodeError> {
        let dec = self.handle;
        self.attach_runner()?;
        if self.opts.keep_orientation {
            ffi::JxlDecoderSetKeepOrientation(dec, 1);
        }
        let events = S_BASIC.0 | S_PROG.0 | S_FULL.0;
        if ffi::JxlDecoderSubscribeEvents(dec, events) != S_SUCCESS {
            return Err(DecodeError::Process);
        }
        let _ = ffi::JxlDecoderSetProgressiveDetail(dec, ffi::JxlProgressiveDetail::kPasses);
        if ffi::JxlDecoderSetInput(dec, jxl.as_ptr(), jxl.len()) != S_SUCCESS {
            return Err(DecodeError::Process);
        }
        ffi::JxlDecoderCloseInput(dec);

        let pf = pixel_format::<S>(channels);
        let esz = std::mem::size_of::<S>();
        let mut info = std::mem::MaybeUninit::<ffi::JxlBasicInfo>::uninit();
        let mut meta = DecodedMeta::default();
        let (mut w, mut h) = (0u32, 0u32);
        let mut buf: Vec<S> = Vec::new();
        let mut pass = 0u32;

        loop {
            if self.is_cancelled() {
                return Err(DecodeError::Cancelled);
            }
            let status = ffi::JxlDecoderProcessInput(dec);
            if status == S_BASIC {
                if ffi::JxlDecoderGetBasicInfo(dec, info.as_mut_ptr()) != S_SUCCESS {
                    return Err(DecodeError::BasicInfo);
                }
                let bi = info.assume_init_ref();
                w = bi.xsize;
                h = bi.ysize;
                meta = DecodedMeta {
                    num_color_channels: bi.num_color_channels,
                    has_alpha: bi.alpha_bits > 0,
                    bits_per_sample: bi.bits_per_sample,
                    num_extra_channels: bi.num_extra_channels,
                };
                let pixels = w as u64 * h as u64;
                let out_bytes = pixels
                    .checked_mul(channels as u64)
                    .and_then(|n| n.checked_mul(esz as u64))
                    .ok_or(DecodeError::LimitExceeded {
                        pixels,
                        bytes: u64::MAX,
                    })?;
                if pixels > self.opts.limits.max_pixels
                    || out_bytes > self.opts.limits.max_output_bytes
                {
                    return Err(DecodeError::LimitExceeded {
                        pixels,
                        bytes: out_bytes,
                    });
                }
            } else if status == S_NEEDOUT {
                let mut size_bytes = 0usize;
                if ffi::JxlDecoderImageOutBufferSize(dec, &pf, &mut size_bytes) != S_SUCCESS {
                    return Err(DecodeError::OutputAlloc);
                }
                if size_bytes == 0 || size_bytes % esz != 0 {
                    return Err(DecodeError::OutputAlloc);
                }
                let elems = size_bytes / esz;
                buf.clear();
                buf.reserve(elems);
                buf.set_len(elems);
                // Progressive flushes expose partial buffers → always zero first.
                std::ptr::write_bytes(buf.as_mut_ptr(), 0, elems);
                if ffi::JxlDecoderSetImageOutBuffer(
                    dec,
                    &pf,
                    buf.as_mut_ptr() as *mut c_void,
                    size_bytes,
                ) != S_SUCCESS
                {
                    return Err(DecodeError::OutputAlloc);
                }
            } else if status == S_PROG {
                // Increment pass unconditionally so the counter stays in sync with
                // decoder-signalled progression events even when FlushImage fails.
                // The event carries the pre-increment value (pass before this flush).
                let this_pass = pass;
                pass += 1;
                if ffi::JxlDecoderFlushImage(dec) == S_SUCCESS && w > 0 && h > 0 {
                    let ctl = on_event(DecodeEvent::Progress {
                        pass: this_pass,
                        width: w,
                        height: h,
                        pixels: &buf,
                    });
                    if ctl == ProgressControl::Stop {
                        break;
                    }
                }
            } else if status == S_FULL || status == S_SUCCESS {
                break;
            } else if status == S_NEEDIN {
                if self.opts.allow_partial && !buf.is_empty() && w > 0 && h > 0 {
                    break;
                }
                return Err(DecodeError::Process);
            } else {
                return Err(DecodeError::Process);
            }
        }
        if w == 0 || h == 0 || buf.is_empty() {
            return Err(DecodeError::Process);
        }
        // The return value carries the definitive final image; callers that want
        // every progressive frame already received them via Progress events.
        // Emitting Final with a clone here would double peak memory (80 MB for 20 MP
        // RGBA8), so we omit it — the return value is the canonical final image.
        Ok(Image {
            width: w,
            height: h,
            channels,
            data: buf,
            extra: Vec::new(),
            meta,
        })
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe {
            if !self.runner.is_null() {
                ffi::JxlThreadParallelRunnerDestroy(self.runner);
            }
            ffi::JxlDecoderDestroy(self.handle);
        }
    }
}

// ── Drop-in compat free fns — keep legacy call sites to path renames ──────────

/// Decode a JXL codestream to interleaved samples of type `S` with `channels`
/// interleaved channels (1 = gray, 3 = RGB, 4 = RGBA). `(pixels, width, height)`.
pub fn decode_interleaved<S: Sample>(jxl: &[u8], channels: u32) -> Option<(Vec<S>, u32, u32)> {
    let mut dec = Decoder::new(DecodeOptions::default())?;
    let (w, h, _, data) = dec.run_raw::<S>(jxl, channels).ok()?;
    Some((data, w, h))
}

/// Decode one standalone per-tile JXL codestream to RGBA8 bytes + dimensions.
/// Compat shape `(pixels, width, height)` matching the legacy
/// `jxl_lowlevel::decode_jxl_rgba8`.
pub fn decode_jxl_rgba8(jxl_bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    decode_interleaved::<u8>(jxl_bytes, 4)
}

/// 16-bit (RGBA16) equivalent for JXTC-16 containers. Returns native-endian
/// `u16` packed as bytes (8 bytes/pixel), matching the prior `jpegxl-sys` path.
pub fn decode_jxl_rgba16(jxl_bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let (px, w, h) = decode_interleaved::<u16>(jxl_bytes, 4)?;
    Some((u16_samples_to_ne_bytes(&px), w, h))
}

/// Decode a JXL (full image) for timing. Returns the decode wall time.
pub fn decode_full(jxl_bytes: &[u8]) -> Option<Duration> {
    let mut dec = Decoder::new(DecodeOptions::default())?;
    dec.time_full_decode(jxl_bytes)
        .ok()
        .map(|m| Duration::from_secs_f64(m.decode_ms / 1000.0))
}

/// Threaded full decode for representative native benchmark numbers (runner
/// setup is excluded from timing, as before). Mirrors the prior `jpegxl-sys`
/// `ThreadsRunner` decode.
pub fn decode_full_threaded(jxl_bytes: &[u8], num_threads: usize) -> Option<Duration> {
    // Honour the requested width: `with_threads` pins the runner to exactly
    // `num_threads`. The prior `parallel: num_threads > 1` only toggled a bool,
    // then `new()` sized the runner to `available_parallelism()` — so a caller
    // asking for 2 threads silently got the whole machine, poisoning constrained
    // benchmark numbers.
    let mut dec = Decoder::with_threads(DecodeOptions::default(), num_threads)?;
    dec.time_full_decode(jxl_bytes)
        .ok()
        .map(|m| Duration::from_secs_f64(m.decode_ms / 1000.0))
}

#[inline]
fn u16_samples_to_ne_bytes(px: &[u16]) -> Vec<u8> {
    // Cheap byte-for-byte copy into a fresh Vec<u8> (NOT zero-copy): the slice is
    // already native-endian in memory, so the bytes are copied verbatim. A true
    // in-place reinterpret (Vec<u16> -> Vec<u8>) is unsound — the allocator would
    // free a u8 layout that was allocated as u16 (size/align mismatch).
    // SAFETY: u16 has no padding/uninit bytes; u8 alignment is <= u16 alignment.
    let byte_len = px.len() * std::mem::size_of::<u16>();
    let mut bytes = Vec::with_capacity(byte_len);
    unsafe {
        std::ptr::copy_nonoverlapping(
            px.as_ptr() as *const u8,
            bytes.as_mut_ptr(),
            byte_len,
        );
        bytes.set_len(byte_len);
    }
    bytes
}

// ── progressive decode (legacy RGBA8 borrowed-event compat) ───────────────────

#[derive(Clone, Debug)]
pub struct ProgressiveFrame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    pub is_final: bool,
}

#[derive(Debug)]
pub enum DecodeProgressiveEvent<'a> {
    Progress { width: u32, height: u32, rgba: &'a [u8] },
    Final { width: u32, height: u32, rgba: Vec<u8> },
}

/// Progressive decode using FRAME_PROGRESSION + FlushImage. Invokes `on_frame`
/// after each successful flush (partial passes + final). Returns
/// `(time_to_first_usable_pixel_ms, total_wall_ms)`.
pub fn decode_progressive_frames_borrowed<F>(jxl_bytes: &[u8], mut on_frame: F) -> Option<(f64, f64)>
where
    F: FnMut(DecodeProgressiveEvent<'_>),
{
    unsafe {
        let dec = ffi::JxlDecoderCreate(std::ptr::null());
        if dec.is_null() {
            return None;
        }
        let events = S_BASIC.0 | S_PROG.0 | S_FULL.0;
        if ffi::JxlDecoderSubscribeEvents(dec, events) != S_SUCCESS {
            ffi::JxlDecoderDestroy(dec);
            return None;
        }
        let _ = ffi::JxlDecoderSetProgressiveDetail(dec, ffi::JxlProgressiveDetail::kPasses);
        if ffi::JxlDecoderSetInput(dec, jxl_bytes.as_ptr(), jxl_bytes.len()) != S_SUCCESS {
            ffi::JxlDecoderDestroy(dec);
            return None;
        }
        // Signal that all input bytes are available so libjxl does not stall
        // on JXL_DEC_NEED_MORE_INPUT even for a complete in-memory codestream.
        ffi::JxlDecoderCloseInput(dec);

        let pf = pixel_format::<u8>(4);
        let mut info = std::mem::MaybeUninit::<ffi::JxlBasicInfo>::uninit();
        let mut image_w = 0u32;
        let mut image_h = 0u32;
        let mut out_buf: Vec<u8> = Vec::new();
        let mut first_ms: Option<f64> = None;
        let t_start = Instant::now();
        let mut status;
        loop {
            status = ffi::JxlDecoderProcessInput(dec);
            if status == S_BASIC {
                if image_w == 0
                    && ffi::JxlDecoderGetBasicInfo(dec, info.as_mut_ptr()) == S_SUCCESS
                {
                    let bi = info.assume_init_ref();
                    // Decompression-bomb guard: reject before allocating output buffers.
                    // Use the same default limits as Decoder (1 Gpx / 16 GiB; see DecodeLimits::default).
                    let pixels = bi.xsize as u64 * bi.ysize as u64;
                    let out_bytes = pixels.saturating_mul(4);
                    if pixels > DecodeLimits::default().max_pixels
                        || out_bytes > DecodeLimits::default().max_output_bytes
                    {
                        status = ffi::JxlDecoderStatus::JXL_DEC_ERROR;
                        break;
                    }
                    image_w = bi.xsize;
                    image_h = bi.ysize;
                }
            } else if status == S_NEEDOUT {
                let mut size: usize = 0;
                if ffi::JxlDecoderImageOutBufferSize(dec, &pf, &mut size) == S_SUCCESS {
                    out_buf.resize(size, 0);
                    if ffi::JxlDecoderSetImageOutBuffer(
                        dec,
                        &pf,
                        out_buf.as_mut_ptr() as *mut _,
                        size,
                    ) != S_SUCCESS
                    {
                        status = ffi::JxlDecoderStatus::JXL_DEC_ERROR;
                        break;
                    }
                }
            } else if status == S_PROG {
                if ffi::JxlDecoderFlushImage(dec) == S_SUCCESS && image_w > 0 && image_h > 0 {
                    if first_ms.is_none() {
                        first_ms = Some(ms(t_start.elapsed()));
                    }
                    on_frame(DecodeProgressiveEvent::Progress {
                        width: image_w,
                        height: image_h,
                        rgba: &out_buf,
                    });
                }
            } else if status == S_FULL || status == S_SUCCESS {
                break;
            } else if status == ffi::JxlDecoderStatus::JXL_DEC_ERROR || status == S_NEEDIN {
                break;
            }
        }
        let total = t_start.elapsed();
        ffi::JxlDecoderDestroy(dec);
        if (status == S_FULL || status == S_SUCCESS)
            && !out_buf.is_empty()
            && image_w > 0
            && image_h > 0
        {
            on_frame(DecodeProgressiveEvent::Final {
                width: image_w,
                height: image_h,
                rgba: out_buf,
            });
            // When no progressive flush occurred (non-progressive codestream),
            // time-to-first-usable-pixel equals total decode time, not 0.
            Some((first_ms.unwrap_or_else(|| ms(total)), ms(total)))
        } else {
            None
        }
    }
}

/// Compatibility wrapper that clones progressive frames for retaining callers.
///
/// # Performance Warning
///
/// This function **clones the entire frame buffer on every progressive flush event**. For images
/// with dimensions such that RGBA8 output is 80+ MB, this incurs substantial allocation and copy
/// overhead per pass. Each intermediate flush clones the partial result.
///
/// # Better Alternative
///
/// For better performance, use [`decode_progressive_frames_borrowed`] with a callback that accepts
/// [`DecodeProgressiveEvent<'_>`]. This variant yields borrowed references (`&[u8]`) for intermediate
/// `Progress` events, eliminating the clone. Cloning is only needed if you must retain the data
/// beyond the callback scope.
///
/// Example:
/// ```ignore
/// decode_progressive_frames_borrowed(jxl_bytes, |event| match event {
///     DecodeProgressiveEvent::Progress { width, height, rgba } => {
///         // rgba is &[u8] — no clone needed if you're just reading it.
///         process_frame(width, height, rgba);
///     },
///     DecodeProgressiveEvent::Final { width, height, rgba } => {
///         // Only Final is owned (Vec<u8>) since it outlives the decoder.
///     },
/// })
/// ```
pub fn decode_progressive_frames<F>(jxl_bytes: &[u8], mut on_frame: F) -> Option<(f64, f64)>
where
    F: FnMut(ProgressiveFrame),
{
    decode_progressive_frames_borrowed(jxl_bytes, |event| match event {
        DecodeProgressiveEvent::Progress { width, height, rgba } => on_frame(ProgressiveFrame {
            width,
            height,
            rgba: rgba.to_vec(),
            is_final: false,
        }),
        DecodeProgressiveEvent::Final { width, height, rgba } => on_frame(ProgressiveFrame {
            width,
            height,
            rgba,
            is_final: true,
        }),
    })
}

/// Timing-only wrapper. Uses the **borrowed** progressive path so the measurement
/// reflects decoder work, not the legacy per-pass frame clone: the retaining
/// `decode_progressive_frames` `to_vec()`s every flush, but this helper discards
/// each frame, so cloning would only pollute the timing (and allocate
/// passes × w × h × 4 bytes for nothing).
pub fn decode_progressive_first_total(jxl_bytes: &[u8]) -> Option<(f64, f64)> {
    decode_progressive_frames_borrowed(jxl_bytes, |_| {})
}

pub use decode_full as bench_jxl_decode_lowlevel_full;
pub use decode_progressive_first_total as bench_jxl_decode_lowlevel_progressive;

// ── per-tile JXTC ROI container (pure container math + Decoder-backed decode) ──

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImageRegion {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct JxtcHeader {
    pub image_w: u32,
    pub image_h: u32,
    pub tile_size: u32,
    pub tiles_x: u32,
    pub tiles_y: u32,
    pub has_alpha: bool,
    pub bits_per_sample: u8,
}

pub const JXTC_MAGIC: u32 = 0x4354_584a; // 'JXTC' little-endian
pub const JXTC_VERSION: u32 = 1;
pub const JXTC_HEADER_BYTES: usize = 32;
pub const JXTC_INDEX_ENTRY_BYTES: usize = 8;

/// Parse the 32-byte little-endian JXTC header (flags word at offset 28:
/// bit 0 = has_alpha, bit 1 = 16-bit).
pub fn parse_jxtc_header(data: &[u8]) -> Option<JxtcHeader> {
    if data.len() < JXTC_HEADER_BYTES {
        return None;
    }
    let magic = u32::from_le_bytes(data[0..4].try_into().ok()?);
    if magic != JXTC_MAGIC {
        return None;
    }
    let ver = u32::from_le_bytes(data[4..8].try_into().ok()?);
    if ver != JXTC_VERSION {
        return None;
    }
    let image_w = u32::from_le_bytes(data[8..12].try_into().ok()?);
    let image_h = u32::from_le_bytes(data[12..16].try_into().ok()?);
    let tile_size = u32::from_le_bytes(data[16..20].try_into().ok()?);
    let tiles_x = u32::from_le_bytes(data[20..24].try_into().ok()?);
    let tiles_y = u32::from_le_bytes(data[24..28].try_into().ok()?);
    let flags = u32::from_le_bytes(data[28..32].try_into().ok()?);

    if image_w == 0 || image_h == 0 || tile_size == 0 || tiles_x == 0 || tiles_y == 0 {
        return None;
    }

    // Validate that tiles_x / tiles_y exactly cover the image dimensions.
    // tiles_x > ceil(image_w/tile_size) would allow tx*tile_size > image_w in the
    // decode path, causing u32 underflow in expected-dimension calculations.
    // tiles_x < ceil would mean the last column of pixels is unreachable.
    let expected_tiles_x = image_w.div_ceil(tile_size);
    let expected_tiles_y = image_h.div_ceil(tile_size);
    if tiles_x != expected_tiles_x || tiles_y != expected_tiles_y {
        return None;
    }

    Some(JxtcHeader {
        image_w,
        image_h,
        tile_size,
        tiles_x,
        tiles_y,
        has_alpha: (flags & 1) != 0,
        bits_per_sample: if (flags & 2) != 0 { 16 } else { 8 },
    })
}

/// Grid coords (tile_x, tile_y) whose tiles overlap the (clamped) viewport.
pub fn overlapping_tile_indices(header: &JxtcHeader, region: ImageRegion) -> Vec<(u32, u32)> {
    let rx = region.x.min(header.image_w);
    let ry = region.y.min(header.image_h);
    let rw = region.w.min(header.image_w.saturating_sub(rx));
    let rh = region.h.min(header.image_h.saturating_sub(ry));

    if rw == 0 || rh == 0 {
        return vec![];
    }

    let tx_min = rx / header.tile_size;
    let tx_max = (rx + rw - 1) / header.tile_size;
    let ty_min = ry / header.tile_size;
    let ty_max = (ry + rh - 1) / header.tile_size;

    let mut out = Vec::new();
    for ty in ty_min..=ty_max {
        for tx in tx_min..=tx_max {
            if tx < header.tiles_x && ty < header.tiles_y {
                out.push((tx, ty));
            }
        }
    }
    out
}

fn compute_tile_copy_rects(
    header: &JxtcHeader,
    tx: u32,
    ty: u32,
    rx: u32,
    ry: u32,
    rw: u32,
    rh: u32,
    tile_w: u32,
    tile_h: u32,
) -> Option<(u32, u32, u32, u32, u32, u32)> {
    let tile_x0 = tx * header.tile_size;
    let tile_y0 = ty * header.tile_size;

    let ox0 = rx.max(tile_x0);
    let oy0 = ry.max(tile_y0);
    let ox1 = (rx + rw).min(tile_x0 + tile_w);
    let oy1 = (ry + rh).min(tile_y0 + tile_h);

    if ox1 <= ox0 || oy1 <= oy0 {
        return None;
    }

    let ow = ox1 - ox0;
    let oh = oy1 - oy0;

    let src_x = ox0 - tile_x0;
    let src_y = oy0 - tile_y0;
    let dst_x = ox0 - rx;
    let dst_y = oy0 - ry;

    Some((src_x, src_y, dst_x, dst_y, ow, oh))
}

/// Owned decoded tile pixels, kept in their native sample width so the 16-bit
/// path needs no intermediate `Vec<u8>` copy: the compositor reads a byte *view*
/// at copy time. A `u16` plane is native-endian and contiguous, so viewing it as
/// `&[u8]` is sound (align 2 ≥ 1, no padding); a true `Vec<u16> → Vec<u8>`
/// ownership transmute would be UB (the allocator frees the wrong layout), which
/// is exactly why `u16_samples_to_ne_bytes` copies — here we never need to own bytes.
enum TilePixels {
    U8(Vec<u8>),
    U16(Vec<u16>),
}

impl TilePixels {
    #[inline]
    fn as_bytes(&self) -> &[u8] {
        match self {
            TilePixels::U8(v) => v,
            // SAFETY: u16 has no padding/uninit bytes and is native-endian in
            // memory; reinterpreting the live buffer as bytes (not transferring
            // ownership) is sound. Lifetime is tied to &self.
            TilePixels::U16(v) => unsafe {
                std::slice::from_raw_parts(v.as_ptr() as *const u8, std::mem::size_of_val(&v[..]))
            },
        }
    }

    /// Byte footprint (also the cache-accounting size for one tile).
    #[inline]
    fn byte_len(&self) -> usize {
        match self {
            TilePixels::U8(v) => v.len(),
            TilePixels::U16(v) => v.len() * std::mem::size_of::<u16>(),
        }
    }
}

// ── JxtcRegionDecoder: stateful viewport decoder with a tile cache ────────────
// A persistent session over ONE immutable JXTC container. Header + index are
// validated once; decoded tiles are retained (byte-bounded LRU) across decode()
// calls, so an interactive pan/zoom re-decodes only the newly-exposed tiles.
// Outer parallelism (rayon) fans out cache MISSES; inner libjxl stays
// single-threaded per tile, so there is no nested oversubscription. The serial
// row compositor and every container/trust-boundary check are the same ones the
// free fn used; the free fn now delegates here with the cache disabled, so its
// regression tests exercise this code too.

/// Whether the session emits an alpha channel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EmitAlpha {
    /// Always emit RGBA (4 bpp / 8 bpp@16-bit). On a no-alpha container libjxl
    /// fills opaque alpha. This is the legacy free-fn contract — the default.
    Always,
    /// Emit RGB (3 bpp / 6 bpp@16-bit) when the container header says no alpha,
    /// RGBA otherwise. Saves ~25% output + the alpha-synthesis work for opaque
    /// imagery.
    FromHeader,
}

impl Default for EmitAlpha {
    fn default() -> Self {
        EmitAlpha::Always
    }
}

/// What a per-tile failure does to the whole viewport result.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JxtcFailurePolicy {
    /// Any failed/forbidden overlapping tile fails the entire `decode`.
    Strict,
    /// Failed tiles become zeroed holes, reported in `missing_tiles` (this is the
    /// legacy free-fn behaviour).
    Preview,
}

impl Default for JxtcFailurePolicy {
    fn default() -> Self {
        JxtcFailurePolicy::Strict
    }
}

/// Session configuration.
#[derive(Clone, Debug)]
pub struct JxtcRegionOptions {
    /// Max decoded-tile bytes retained across `decode` calls. `0` disables the
    /// cache entirely (every call re-decodes — the stateless free-fn behaviour).
    pub cache_bytes: usize,
    pub failure_policy: JxtcFailurePolicy,
    /// Alpha emission policy (see [`EmitAlpha`]). Default `Always` keeps the
    /// historical RGBA output; `FromHeader` lets opaque containers decode as RGB.
    pub emit_alpha: EmitAlpha,
    /// Inherited by every tile decoder (`cancel` / `limits` / `keep_orientation`).
    /// `parallel` and `allow_partial` are forced off for tiles regardless (rayon
    /// owns tile parallelism; a tile is always a whole cache unit).
    pub decode: DecodeOptions,
}

impl Default for JxtcRegionOptions {
    fn default() -> Self {
        JxtcRegionOptions {
            cache_bytes: 128 * 1024 * 1024,
            failure_policy: JxtcFailurePolicy::Strict,
            emit_alpha: EmitAlpha::Always,
            decode: DecodeOptions::default(),
        }
    }
}

/// Per-call observability (for interactive-profiling: how much the cache saved).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct JxtcRegionMetrics {
    pub cache_hits: u32,
    pub decoded_tiles: u32,
    pub missing_tiles: u32,
    pub cache_tiles: u32,
    pub cache_bytes: usize,
}

/// A decoded viewport: native-endian interleaved RGBA bytes (4 bpp at 8-bit,
/// 8 bpp at 16-bit), what (if anything) was missing, and the call metrics.
#[derive(Debug)]
pub struct JxtcRegion {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub bytes_per_pixel: usize,
    pub pixels: Vec<u8>,
    /// Empty on a clean Strict decode; the zeroed-hole tiles under Preview.
    pub missing_tiles: Vec<(u32, u32)>,
    pub metrics: JxtcRegionMetrics,
}

/// Stage-located session error. Strict mode surfaces per-tile errors; Preview
/// folds them into `missing_tiles` instead.
#[derive(thiserror::Error, Debug)]
pub enum JxtcRegionError {
    #[error("invalid JXTC header or index table")]
    InvalidContainer,
    #[error("JXTC region exceeds limits: {pixels} px / {bytes} bytes")]
    LimitExceeded { pixels: u64, bytes: u64 },
    #[error("JXTC region output allocation failed")]
    OutputAlloc,
    #[error("could not create a JXTC tile decoder")]
    DecoderCreate,
    #[error("JXTC decode cancelled")]
    Cancelled,
    #[error("invalid JXTC index entry for tile ({x}, {y})")]
    InvalidIndex { x: u32, y: u32 },
    #[error("JXTC tile ({x}, {y}) has unexpected dimensions")]
    InvalidTileDimensions { x: u32, y: u32 },
    #[error("JXTC tile ({x}, {y}) decode failed")]
    Tile { x: u32, y: u32 },
}

struct CachedTile {
    pixels: TilePixels,
    width: u32,
    height: u32,
    bytes: usize,
}

/// Byte-bounded LRU. `n` (live tile count) is viewport-scale, so the O(n)
/// least-recently-used scan on eviction is a cheap cold path — an intrusive
/// linked LRU would complicate every lookup for no real-world gain.
struct TileCache {
    entries: std::collections::HashMap<(u32, u32), (CachedTile, u64)>,
    max_bytes: usize,
    bytes: usize,
    clock: u64,
}

impl TileCache {
    fn new(max_bytes: usize) -> Self {
        TileCache {
            entries: std::collections::HashMap::new(),
            max_bytes,
            bytes: 0,
            clock: 0,
        }
    }

    #[inline]
    fn tick(&mut self) -> u64 {
        self.clock = self.clock.wrapping_add(1);
        self.clock
    }

    fn get(&mut self, key: (u32, u32)) -> Option<&CachedTile> {
        let stamp = self.tick();
        let slot = self.entries.get_mut(&key)?;
        slot.1 = stamp;
        Some(&slot.0)
    }

    fn remove(&mut self, key: (u32, u32)) -> Option<CachedTile> {
        let (tile, _) = self.entries.remove(&key)?;
        self.bytes = self.bytes.saturating_sub(tile.bytes);
        Some(tile)
    }

    fn insert(&mut self, key: (u32, u32), tile: CachedTile) {
        // Caching disabled, or one tile can't even fit → don't retain it.
        if self.max_bytes == 0 || tile.bytes > self.max_bytes {
            return;
        }
        if let Some((old, _)) = self.entries.remove(&key) {
            self.bytes = self.bytes.saturating_sub(old.bytes);
        }
        let bytes = tile.bytes;
        let stamp = self.tick();
        self.entries.insert(key, (tile, stamp));
        self.bytes = self.bytes.saturating_add(bytes);
        self.evict_to_budget();
    }

    fn evict_to_budget(&mut self) {
        while self.bytes > self.max_bytes {
            let victim = self
                .entries
                .iter()
                .min_by_key(|(_, (_, stamp))| *stamp)
                .map(|(k, _)| *k);
            match victim {
                Some(k) => {
                    self.remove(k);
                }
                None => break,
            }
        }
    }

    #[inline]
    fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }

    fn set_max_bytes(&mut self, max_bytes: usize) {
        self.max_bytes = max_bytes;
        self.evict_to_budget();
    }
}

/// Persistent viewport decoder over one borrowed JXTC container. Construct once,
/// call [`JxtcRegionDecoder::decode`] per viewport; decoded tiles are reused
/// across calls. See the module note above for the parallelism/memory shape.
pub struct JxtcRegionDecoder<'a> {
    container: &'a [u8],
    header: JxtcHeader,
    index_start: usize,
    index_end: usize,
    /// Interleaved channels requested per tile (3 = RGB, 4 = RGBA), fixed by
    /// `emit_alpha` + the header's alpha flag at construction.
    channels: u32,
    bytes_per_pixel: usize,
    options: JxtcRegionOptions,
    cache: TileCache,
    /// Reused across `decode` calls for the single-miss (1-tile interactive pan)
    /// path — the genuine cross-call decoder-handle reuse. Multi-miss batches use
    /// rayon `map_init` decoders instead.
    serial_decoder: Option<Decoder>,
}

impl<'a> JxtcRegionDecoder<'a> {
    /// Validate the container header + index table once. The container is borrowed
    /// for the session; nothing is copied.
    pub fn new(container: &'a [u8], options: JxtcRegionOptions) -> Result<Self, JxtcRegionError> {
        let header = parse_jxtc_header(container).ok_or(JxtcRegionError::InvalidContainer)?;
        // Checked, mirroring the free fn (tile counts are attacker-controlled).
        let num_tiles = (header.tiles_x as usize)
            .checked_mul(header.tiles_y as usize)
            .ok_or(JxtcRegionError::InvalidContainer)?;
        let index_start = JXTC_HEADER_BYTES;
        let index_end = num_tiles
            .checked_mul(JXTC_INDEX_ENTRY_BYTES)
            .and_then(|table| index_start.checked_add(table))
            .ok_or(JxtcRegionError::InvalidContainer)?;
        if container.len() < index_end {
            return Err(JxtcRegionError::InvalidContainer);
        }
        // Channel count is fixed for the session: RGBA unless the caller opted into
        // header-driven alpha AND the container is alpha-free.
        let emit_alpha = match options.emit_alpha {
            EmitAlpha::Always => true,
            EmitAlpha::FromHeader => header.has_alpha,
        };
        let channels: u32 = if emit_alpha { 4 } else { 3 };
        let sample = if header.bits_per_sample == 16 { 2 } else { 1 };
        let bytes_per_pixel = channels as usize * sample;
        let cache_bytes = options.cache_bytes;
        Ok(JxtcRegionDecoder {
            container,
            header,
            index_start,
            index_end,
            channels,
            bytes_per_pixel,
            options,
            cache: TileCache::new(cache_bytes),
            serial_decoder: None,
        })
    }

    #[inline]
    pub fn header(&self) -> JxtcHeader {
        self.header
    }
    /// Bytes currently held in the decoded-tile cache.
    #[inline]
    pub fn cache_bytes(&self) -> usize {
        self.cache.bytes
    }
    /// Number of tiles currently held in the cache.
    #[inline]
    pub fn cache_tiles(&self) -> usize {
        self.cache.entries.len()
    }
    /// Drop all cached tiles (e.g. on a zoom level change).
    pub fn clear_cache(&mut self) {
        self.cache.clear();
    }
    /// Re-budget the cache, evicting down to the new ceiling immediately.
    pub fn set_cache_bytes(&mut self, max_bytes: usize) {
        self.options.cache_bytes = max_bytes;
        self.cache.set_max_bytes(max_bytes);
    }

    #[inline]
    fn check_cancel(&self) -> Result<(), JxtcRegionError> {
        if self
            .options
            .decode
            .cancel
            .as_ref()
            .is_some_and(|c| c.load(Ordering::Acquire))
        {
            Err(JxtcRegionError::Cancelled)
        } else {
            Ok(())
        }
    }

    fn clamp_region(&self, r: ImageRegion) -> (u32, u32, u32, u32) {
        let x = r.x.min(self.header.image_w);
        let y = r.y.min(self.header.image_h);
        let w = r.w.min(self.header.image_w.saturating_sub(x));
        let h = r.h.min(self.header.image_h.saturating_sub(y));
        (x, y, w, h)
    }

    fn checked_output_len(&self, w: u32, h: u32) -> Result<usize, JxtcRegionError> {
        let pixels = (w as u64)
            .checked_mul(h as u64)
            .ok_or(JxtcRegionError::LimitExceeded { pixels: u64::MAX, bytes: u64::MAX })?;
        let bytes = pixels
            .checked_mul(self.bytes_per_pixel as u64)
            .ok_or(JxtcRegionError::LimitExceeded { pixels, bytes: u64::MAX })?;
        if pixels > self.options.decode.limits.max_pixels
            || bytes > self.options.decode.limits.max_output_bytes
        {
            return Err(JxtcRegionError::LimitExceeded { pixels, bytes });
        }
        usize::try_from(bytes).map_err(|_| JxtcRegionError::LimitExceeded { pixels, bytes })
    }

    fn tile_decode_options(&self) -> DecodeOptions {
        let mut o = self.options.decode.clone();
        o.parallel = false; // rayon owns tile parallelism; no nested libjxl runner
        o.allow_partial = false; // a tile is a whole cache unit, never partial
        o
    }

    fn serial_decoder(&mut self) -> Result<&mut Decoder, JxtcRegionError> {
        if self.serial_decoder.is_none() {
            let opts = self.tile_decode_options();
            self.serial_decoder = Decoder::new(opts);
        }
        self.serial_decoder.as_mut().ok_or(JxtcRegionError::DecoderCreate)
    }

    /// Decode one viewport. Cache hits are composited immediately; misses are
    /// decoded (the held serial decoder for one, a rayon fan-out for many), then
    /// composited and inserted into the cache.
    pub fn decode(&mut self, request: ImageRegion) -> Result<JxtcRegion, JxtcRegionError> {
        self.check_cancel()?;
        let (rx, ry, rw, rh) = self.clamp_region(request);
        let out_len = self.checked_output_len(rw, rh)?;

        let mut pixels: Vec<u8> = Vec::new();
        pixels
            .try_reserve_exact(out_len)
            .map_err(|_| JxtcRegionError::OutputAlloc)?;
        pixels.resize(out_len, 0);

        let header = self.header;
        let bpp = self.bytes_per_pixel;
        let mut metrics = JxtcRegionMetrics::default();
        let mut missing_tiles: Vec<(u32, u32)> = Vec::new();

        if rw != 0 && rh != 0 {
            let overlapping =
                overlapping_tile_indices(&header, ImageRegion { x: rx, y: ry, w: rw, h: rh });

            // Phase 1: composite cache hits; collect the misses.
            let mut misses: Vec<(u32, u32)> = Vec::with_capacity(overlapping.len());
            for key in overlapping {
                if let Some(tile) = self.cache.get(key) {
                    blit_jxtc_tile(&header, bpp, rx, ry, rw, rh, &mut pixels, key, tile)?;
                    metrics.cache_hits += 1;
                } else {
                    misses.push(key);
                }
            }

            // Phase 2: decode the misses, composite, and cache them.
            for (key, decoded) in self.decode_misses(&misses)? {
                match decoded {
                    Ok(tile) => {
                        blit_jxtc_tile(&header, bpp, rx, ry, rw, rh, &mut pixels, key, &tile)?;
                        self.cache.insert(key, tile);
                        metrics.decoded_tiles += 1;
                    }
                    Err(JxtcRegionError::Cancelled) => return Err(JxtcRegionError::Cancelled),
                    Err(e) => match self.options.failure_policy {
                        JxtcFailurePolicy::Strict => return Err(e),
                        JxtcFailurePolicy::Preview => {
                            missing_tiles.push(key);
                            metrics.missing_tiles += 1;
                        }
                    },
                }
            }
        }

        metrics.cache_tiles = self.cache.entries.len().min(u32::MAX as usize) as u32;
        metrics.cache_bytes = self.cache.bytes;

        Ok(JxtcRegion {
            x: rx,
            y: ry,
            width: rw,
            height: rh,
            bytes_per_pixel: bpp,
            pixels,
            missing_tiles,
            metrics,
        })
    }

    #[allow(clippy::type_complexity)]
    fn decode_misses(
        &mut self,
        misses: &[(u32, u32)],
    ) -> Result<Vec<((u32, u32), Result<CachedTile, JxtcRegionError>)>, JxtcRegionError> {
        if misses.is_empty() {
            return Ok(Vec::new());
        }
        self.check_cancel()?;

        // Copy the borrow-free pieces out so the rayon closures / serial path
        // don't capture `self` (the `&'a` container ref is Copy, lifetime-independent
        // of the `&mut self` borrow `serial_decoder()` needs).
        let container = self.container;
        let header = self.header;
        let index_start = self.index_start;
        let index_end = self.index_end;
        let channels = self.channels;

        // One miss → reuse the held serial decoder (the 1-tile interactive pan).
        if misses.len() == 1 {
            let key = misses[0];
            let dec = self.serial_decoder()?;
            let res =
                decode_one_jxtc_tile(container, header, index_start, index_end, channels, dec, key);
            return Ok(vec![(key, res)]);
        }

        // Many misses → rayon fan-out, one fresh single-threaded decoder per job.
        let opts = self.tile_decode_options();
        let results: Vec<((u32, u32), Result<CachedTile, JxtcRegionError>)> = misses
            .par_iter()
            .map_init(
                move || Decoder::new(opts.clone()),
                |slot, &key| {
                    let res = match slot.as_mut() {
                        Some(dec) => decode_one_jxtc_tile(
                            container,
                            header,
                            index_start,
                            index_end,
                            channels,
                            dec,
                            key,
                        ),
                        None => Err(JxtcRegionError::DecoderCreate),
                    };
                    (key, res)
                },
            )
            .collect();
        Ok(results)
    }
}

/// Borrow one tile's codestream from the validated index table — all the
/// overflow + trust-boundary checks the free fn did inline live here.
fn jxtc_tile_stream(
    container: &[u8],
    header: JxtcHeader,
    index_start: usize,
    index_end: usize,
    key: (u32, u32),
) -> Result<&[u8], JxtcRegionError> {
    let (x, y) = key;
    if x >= header.tiles_x || y >= header.tiles_y {
        return Err(JxtcRegionError::InvalidIndex { x, y });
    }
    let idx = (y as usize)
        .checked_mul(header.tiles_x as usize)
        .and_then(|row| row.checked_add(x as usize))
        .ok_or(JxtcRegionError::InvalidIndex { x, y })?;
    let base = idx
        .checked_mul(JXTC_INDEX_ENTRY_BYTES)
        .and_then(|off| index_start.checked_add(off))
        .ok_or(JxtcRegionError::InvalidIndex { x, y })?;
    let entry_end = base
        .checked_add(JXTC_INDEX_ENTRY_BYTES)
        .ok_or(JxtcRegionError::InvalidIndex { x, y })?;
    if entry_end > index_end {
        return Err(JxtcRegionError::InvalidIndex { x, y });
    }
    let entry = container
        .get(base..entry_end)
        .ok_or(JxtcRegionError::InvalidIndex { x, y })?;
    let off = u32::from_le_bytes([entry[0], entry[1], entry[2], entry[3]]) as usize;
    let len = u32::from_le_bytes([entry[4], entry[5], entry[6], entry[7]]) as usize;
    let end = off.checked_add(len).ok_or(JxtcRegionError::InvalidIndex { x, y })?;
    // Trust boundary: a tile must live past the index table and within bounds, or
    // a crafted container could feed index bytes to the JXL decoder.
    if off < index_end || end > container.len() {
        return Err(JxtcRegionError::InvalidIndex { x, y });
    }
    container.get(off..end).ok_or(JxtcRegionError::InvalidIndex { x, y })
}

/// Expected (partial-edge-aware) pixel dims of a tile.
fn jxtc_expected_tile_dims(
    header: JxtcHeader,
    key: (u32, u32),
) -> Result<(u32, u32), JxtcRegionError> {
    let (x, y) = key;
    let x0 = x
        .checked_mul(header.tile_size)
        .ok_or(JxtcRegionError::InvalidTileDimensions { x, y })?;
    let y0 = y
        .checked_mul(header.tile_size)
        .ok_or(JxtcRegionError::InvalidTileDimensions { x, y })?;
    let w = header.tile_size.min(header.image_w.saturating_sub(x0));
    let h = header.tile_size.min(header.image_h.saturating_sub(y0));
    if w == 0 || h == 0 {
        return Err(JxtcRegionError::InvalidTileDimensions { x, y });
    }
    Ok((w, h))
}

/// Decode + validate one tile into a `CachedTile`. Uses `run_raw` (colour-only):
/// JXTC composites interleaved RGBA bytes, so extra planes are never read back.
fn decode_one_jxtc_tile(
    container: &[u8],
    header: JxtcHeader,
    index_start: usize,
    index_end: usize,
    channels: u32,
    dec: &mut Decoder,
    key: (u32, u32),
) -> Result<CachedTile, JxtcRegionError> {
    let (x, y) = key;
    let stream = jxtc_tile_stream(container, header, index_start, index_end, key)?;
    let (pixels, tw, th) = if header.bits_per_sample == 16 {
        match dec.run_raw::<u16>(stream, channels) {
            Ok((w, h, _, data)) => (TilePixels::U16(data), w, h),
            Err(DecodeError::Cancelled) => return Err(JxtcRegionError::Cancelled),
            Err(_) => return Err(JxtcRegionError::Tile { x, y }),
        }
    } else {
        match dec.run_raw::<u8>(stream, channels) {
            Ok((w, h, _, data)) => (TilePixels::U8(data), w, h),
            Err(DecodeError::Cancelled) => return Err(JxtcRegionError::Cancelled),
            Err(_) => return Err(JxtcRegionError::Tile { x, y }),
        }
    };
    let (ew, eh) = jxtc_expected_tile_dims(header, key)?;
    if tw != ew || th != eh {
        return Err(JxtcRegionError::InvalidTileDimensions { x, y });
    }
    let sample = if header.bits_per_sample == 16 { 2usize } else { 1usize };
    let bpp = channels as usize * sample;
    let expected = (tw as usize)
        .checked_mul(th as usize)
        .and_then(|px| px.checked_mul(bpp))
        .ok_or(JxtcRegionError::InvalidTileDimensions { x, y })?;
    if pixels.byte_len() != expected {
        return Err(JxtcRegionError::Tile { x, y });
    }
    Ok(CachedTile { bytes: pixels.byte_len(), pixels, width: tw, height: th })
}

/// Composite one tile's overlap into `dest` — safe strided row copies, byte-for-byte
/// identical to the free-fn loop (just fallible instead of panicking on a bad rect).
#[allow(clippy::too_many_arguments)]
fn blit_jxtc_tile(
    header: &JxtcHeader,
    bpp: usize,
    rx: u32,
    ry: u32,
    rw: u32,
    rh: u32,
    dest: &mut [u8],
    key: (u32, u32),
    tile: &CachedTile,
) -> Result<(), JxtcRegionError> {
    let (tx, ty) = key;
    let src = tile.pixels.as_bytes();
    if let Some((src_x, src_y, dst_x, dst_y, ow, oh)) =
        compute_tile_copy_rects(header, tx, ty, rx, ry, rw, rh, tile.width, tile.height)
    {
        for row in 0..oh {
            let src_off = ((src_y + row) as usize * tile.width as usize + src_x as usize) * bpp;
            let dst_off = ((dst_y + row) as usize * rw as usize + dst_x as usize) * bpp;
            let n = ow as usize * bpp;
            let s = src
                .get(src_off..src_off + n)
                .ok_or(JxtcRegionError::Tile { x: tx, y: ty })?;
            let d = dest
                .get_mut(dst_off..dst_off + n)
                .ok_or(JxtcRegionError::Tile { x: tx, y: ty })?;
            d.copy_from_slice(s);
        }
    }
    Ok(())
}

/// Decode a rectangular viewport from a JXTC tile container (legacy free-fn API).
///
/// Thin wrapper over [`JxtcRegionDecoder`] with the cache **disabled** and the
/// **Preview** failure policy, preserving the historical behaviour exactly:
/// failed/forbidden tiles become zeroed holes, and `None` is returned only for a
/// bad container (or an output that overflows / exceeds limits). New callers that
/// decode many viewports from one container (pan/zoom) should hold a
/// [`JxtcRegionDecoder`] instead, to reuse decoded tiles across calls.
pub fn decode_jxtc_region(
    container: &[u8],
    region_x: u32,
    region_y: u32,
    region_w: u32,
    region_h: u32,
) -> Option<Vec<u8>> {
    let mut session = JxtcRegionDecoder::new(
        container,
        JxtcRegionOptions {
            cache_bytes: 0,
            failure_policy: JxtcFailurePolicy::Preview,
            emit_alpha: EmitAlpha::Always, // legacy callers expect RGBA always
            decode: DecodeOptions::default(),
        },
    )
    .ok()?;
    session
        .decode(ImageRegion { x: region_x, y: region_y, w: region_w, h: region_h })
        .ok()
        .map(|region| region.pixels)
}

pub use overlapping_tile_indices as jxtc_overlapping_tile_indices;
pub use parse_jxtc_header as jxtc_parse_header;

// ── tests ─────────────────────────────────────────────────────────────────────
// Fixtures are minted with the sister BSD encoder (`jxl_casaencoder`) in **lossless**
// mode, so every round-trip assert is bit-exact. `half` is a crate dependency
// (jxl-codec), so f16 is exercised here without a dev-dependency.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::jxl_casaencoder::{EncodeOptions, Encoder, ExtraChannel, ExtraKind, Frame};

    fn enc_lossless<S: Sample>(frame: &Frame<S>) -> Vec<u8> {
        let mut enc = Encoder::new(EncodeOptions::lossless()).expect("encoder");
        enc.encode(frame).expect("encode")
    }

    fn gradient_rgba8(w: u32, h: u32) -> Vec<u8> {
        let mut v = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                v[i] = (x % 256) as u8;
                v[i + 1] = (y % 256) as u8;
                v[i + 2] = ((x + y) % 256) as u8;
                v[i + 3] = 255;
            }
        }
        v
    }

    #[test]
    fn decode_rgba8_recovers_dims_and_pixels() {
        let (w, h) = (64u32, 48u32);
        let rgba = gradient_rgba8(w, h);
        let jxl = enc_lossless(&Frame::rgba8(&rgba, w, h));

        let (px, dw, dh) = decode_jxl_rgba8(&jxl).expect("free-fn decode");
        assert_eq!((dw, dh), (w, h));
        assert_eq!(px, rgba, "lossless RGBA8 must round-trip exactly");

        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let img: Image<u8> = dec.decode(&jxl, Channels::Rgba).unwrap();
        assert_eq!((img.width, img.height, img.channels), (w, h, 4));
        assert_eq!(img.data, px);
        assert!(img.meta.num_color_channels >= 3);
    }

    #[test]
    fn decode_u16_rgb_roundtrips_exact() {
        let (w, h) = (32u32, 24u32);
        let px: Vec<u16> = (0..(w * h * 3)).map(|i| (i as u16).wrapping_mul(257)).collect();
        let jxl = enc_lossless(&Frame::rgb(&px, w, h));
        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let img = dec.decode::<u16>(&jxl, Channels::Rgb).unwrap();
        assert_eq!((img.width, img.height, img.channels), (w, h, 3));
        assert_eq!(img.data, px, "lossless u16 exact");
    }

    #[test]
    fn decode_f32_rgb_roundtrips() {
        let (w, h) = (16u32, 16u32);
        let n = (w * h * 3) as usize;
        let px: Vec<f32> = (0..n).map(|i| i as f32 / n as f32).collect();
        let jxl = enc_lossless(&Frame::rgb(&px, w, h));
        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let img = dec.decode::<f32>(&jxl, Channels::Rgb).unwrap();
        assert_eq!((img.width, img.height), (w, h));
        for (a, b) in img.data.iter().zip(px.iter()) {
            assert!((a - b).abs() < 1e-4, "{a} vs {b}");
        }
    }

    #[test]
    fn decode_f16_and_gray() {
        let (w, h) = (16u32, 16u32);
        let px16: Vec<half::f16> = (0..(w * h * 3))
            .map(|i| half::f16::from_f32((i % 97) as f32 / 97.0))
            .collect();
        let jxl = enc_lossless(&Frame::rgb(&px16, w, h));
        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let img = dec.decode::<half::f16>(&jxl, Channels::Rgb).unwrap();
        assert_eq!(img.data.len(), (w * h * 3) as usize);

        let g: Vec<u8> = (0..(w * h)).map(|i| (i % 256) as u8).collect();
        let jg = enc_lossless(&Frame::gray(&g, w, h));
        let ig = dec.decode::<u8>(&jg, Channels::Gray).unwrap();
        assert_eq!((ig.width, ig.height, ig.channels), (w, h, 1));
        assert_eq!(ig.meta.num_color_channels, 1);
        assert_eq!(ig.data, g, "lossless gray exact");
    }

    #[test]
    fn decode_into_reuses_buffer_capacity() {
        let (w, h) = (32u32, 32u32);
        let rgba = gradient_rgba8(w, h);
        let jxl = enc_lossless(&Frame::rgba8(&rgba, w, h));
        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let mut buf: Vec<u8> = Vec::new();
        let m1 = dec.decode_into::<u8>(&jxl, Channels::Rgba, &mut buf).unwrap();
        assert_eq!(buf.len(), (w * h * 4) as usize);
        assert_eq!(buf, rgba);
        let cap = buf.capacity();
        let _ = dec.decode_into::<u8>(&jxl, Channels::Rgba, &mut buf).unwrap();
        assert_eq!(buf.capacity(), cap, "equal-size redecode must not reallocate");
        assert!(m1.num_color_channels >= 3);
    }

    #[test]
    fn decode_view_matches_owned() {
        let (w, h) = (40u32, 30u32);
        let rgba = gradient_rgba8(w, h);
        let jxl = enc_lossless(&Frame::rgba8(&rgba, w, h));
        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let sum_view = dec
            .decode_view::<u8, _>(&jxl, Channels::Rgba, |v| {
                assert_eq!((v.width, v.height, v.channels), (w, h, 4));
                v.data.iter().map(|&b| b as u64).sum::<u64>()
            })
            .unwrap();
        let img = dec.decode::<u8>(&jxl, Channels::Rgba).unwrap();
        let sum_owned: u64 = img.data.iter().map(|&b| b as u64).sum();
        assert_eq!(sum_view, sum_owned);
    }

    #[test]
    fn panicking_view_callback_leaves_decoder_reusable() {
        // The ResetGuard must reset the handle even when the analysis closure
        // unwinds, or the next decode on the reused Decoder would be poisoned.
        let (w, h) = (32u32, 32u32);
        let rgba = gradient_rgba8(w, h);
        let jxl = enc_lossless(&Frame::rgba8(&rgba, w, h));
        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();

        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {})); // silence the expected panic
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = dec.decode_view::<u8, ()>(&jxl, Channels::Rgba, |_| panic!("boom"));
        }));
        std::panic::set_hook(prev);
        assert!(caught.is_err(), "callback panic must propagate");

        // Same decoder, after the panic-unwind → still decodes correctly.
        let img = dec
            .decode::<u8>(&jxl, Channels::Rgba)
            .expect("decoder reusable after a panicking view callback");
        assert_eq!((img.width, img.height), (w, h));
    }

    #[test]
    fn decode_region_equals_full_crop() {
        let (w, h) = (64u32, 64u32);
        let rgba = gradient_rgba8(w, h);
        let jxl = enc_lossless(&Frame::rgba8(&rgba, w, h));
        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let full = dec.decode::<u8>(&jxl, Channels::Rgba).unwrap();
        let r = DecodeRegion { x: 10, y: 8, width: 20, height: 16 };
        let reg = dec.decode_region::<u8>(&jxl, Channels::Rgba, r).unwrap();
        assert_eq!((reg.width, reg.height), (20, 16));
        for ry in 0..16u32 {
            for rx in 0..20u32 {
                let s = (((r.y + ry) * w + (r.x + rx)) * 4) as usize;
                let d = ((ry * 20 + rx) * 4) as usize;
                assert_eq!(&reg.data[d..d + 4], &full.data[s..s + 4]);
            }
        }
    }

    #[test]
    fn garbage_then_good_reuses_decoder() {
        let (w, h) = (32u32, 32u32);
        let rgba = gradient_rgba8(w, h);
        let good = enc_lossless(&Frame::rgba8(&rgba, w, h));
        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let bad = dec.decode::<u8>(b"not a jxl stream at all", Channels::Rgba);
        assert!(matches!(bad, Err(DecodeError::Process)), "garbage → Process");
        // reset-on-every-path ⇒ the SAME decoder still works.
        let img = dec.decode::<u8>(&good, Channels::Rgba).expect("reusable after error");
        assert_eq!((img.width, img.height), (w, h));
    }

    #[test]
    fn limits_refuse_decompression_bomb() {
        let (w, h) = (32u32, 32u32);
        let rgba = gradient_rgba8(w, h);
        let jxl = enc_lossless(&Frame::rgba8(&rgba, w, h));
        let mut dec = Decoder::new(DecodeOptions {
            limits: DecodeLimits { max_pixels: 1, max_output_bytes: u64::MAX },
            ..Default::default()
        })
        .unwrap();
        assert!(matches!(
            dec.decode::<u8>(&jxl, Channels::Rgba),
            Err(DecodeError::LimitExceeded { .. })
        ));
        // refusal leaves the decoder usable.
        dec.set_options(DecodeOptions::default());
        assert!(dec.decode::<u8>(&jxl, Channels::Rgba).is_ok());
    }

    #[test]
    fn pretripped_cancel_yields_no_image() {
        let (w, h) = (32u32, 32u32);
        let rgba = gradient_rgba8(w, h);
        let jxl = enc_lossless(&Frame::rgba8(&rgba, w, h));
        let flag = Arc::new(AtomicBool::new(true));
        let mut dec = Decoder::new(DecodeOptions {
            cancel: Some(flag.clone()),
            ..Default::default()
        })
        .unwrap();
        assert!(matches!(
            dec.decode::<u8>(&jxl, Channels::Rgba),
            Err(DecodeError::Cancelled)
        ));
        flag.store(false, Ordering::Relaxed);
        assert!(dec.decode::<u8>(&jxl, Channels::Rgba).is_ok());
    }

    #[test]
    fn reads_back_one_planar_extra_channel() {
        let (w, h) = (16u32, 16u32);
        let color: Vec<u16> = (0..(w * h * 3)).map(|i| (i as u16).wrapping_mul(7)).collect();
        let depth: Vec<u16> = (0..(w * h)).map(|i| (i as u16).wrapping_mul(11)).collect();
        let extras = [ExtraChannel { kind: ExtraKind::Depth, data: &depth }];
        let mut frame = Frame::rgb(&color, w, h);
        frame.extra = &extras;
        let jxl = enc_lossless(&frame);

        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let img = dec.decode::<u16>(&jxl, Channels::Rgb).unwrap();
        assert_eq!(img.meta.num_extra_channels, 1);
        assert_eq!(img.extra.len(), 1, "one planar extra read back");
        assert_eq!(img.extra[0].data.len(), (w * h) as usize);
        assert_eq!(img.extra[0].data, depth, "lossless extra plane exact");
    }

    #[test]
    fn parallel_decode_byte_identical_to_serial() {
        let (w, h) = (80u32, 60u32);
        let rgba = gradient_rgba8(w, h);
        let jxl = enc_lossless(&Frame::rgba8(&rgba, w, h));
        let mut st = Decoder::new(DecodeOptions::default()).unwrap();
        let mut mt = Decoder::new(DecodeOptions { parallel: true, ..Default::default() }).unwrap();
        let a = st.decode::<u8>(&jxl, Channels::Rgba).unwrap();
        let b = mt.decode::<u8>(&jxl, Channels::Rgba).unwrap();
        assert_eq!(a.data, b.data, "libjxl MT decode is deterministic ⇒ identical pixels");
    }

    #[test]
    fn time_full_decode_reports_metrics() {
        let (w, h) = (48u32, 36u32);
        let rgba = gradient_rgba8(w, h);
        let jxl = enc_lossless(&Frame::rgba8(&rgba, w, h));
        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let m = dec.time_full_decode(&jxl).unwrap();
        assert!(m.input_bytes > 0);
        assert_eq!(m.output_bytes, (w * h * 4) as u64);
        assert!(m.decode_ms >= 0.0);
    }

    #[test]
    fn time_native_decode_uses_native_channel_count() {
        // Gray stream: native decode must NOT inflate to RGBA. output_bytes should
        // equal w*h (1 channel), proving the measurement isn't poisoned by upsample.
        let (w, h) = (48u32, 36u32);
        let g: Vec<u8> = (0..(w * h)).map(|i| (i % 256) as u8).collect();
        let jxl = enc_lossless(&Frame::gray(&g, w, h));
        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let native = dec.time_native_decode(&jxl).unwrap();
        assert_eq!(native.output_bytes, (w * h) as u64, "gray native = 1 channel");
        // The fixed-RGBA variant inflates the same stream 4×.
        let full = dec.time_full_decode(&jxl).unwrap();
        assert_eq!(full.output_bytes, (w * h * 4) as u64);
    }

    /// Assemble a minimal JXTC container: 32-byte header + (off,len) index table +
    /// concatenated per-tile codestreams (row-major ty*tiles_x+tx).
    fn build_jxtc(
        tiles: &[Vec<u8>],
        tiles_x: u32,
        tiles_y: u32,
        tile_size: u32,
        image_w: u32,
        image_h: u32,
        is16: bool,
    ) -> Vec<u8> {
        let num_tiles = (tiles_x * tiles_y) as usize;
        assert_eq!(tiles.len(), num_tiles);
        let mut out = Vec::new();
        out.extend_from_slice(&JXTC_MAGIC.to_le_bytes());
        out.extend_from_slice(&JXTC_VERSION.to_le_bytes());
        out.extend_from_slice(&image_w.to_le_bytes());
        out.extend_from_slice(&image_h.to_le_bytes());
        out.extend_from_slice(&tile_size.to_le_bytes());
        out.extend_from_slice(&tiles_x.to_le_bytes());
        out.extend_from_slice(&tiles_y.to_le_bytes());
        let flags: u32 = 1 | if is16 { 2 } else { 0 }; // has_alpha + 16-bit
        out.extend_from_slice(&flags.to_le_bytes());
        // Index table — payloads start right after header + table (fixed size).
        let payload_start = JXTC_HEADER_BYTES + num_tiles * JXTC_INDEX_ENTRY_BYTES;
        let mut cur = payload_start;
        for t in tiles {
            out.extend_from_slice(&(cur as u32).to_le_bytes());
            out.extend_from_slice(&(t.len() as u32).to_le_bytes());
            cur += t.len();
        }
        for t in tiles {
            out.extend_from_slice(t);
        }
        out
    }

    #[test]
    fn decode_jxtc_region_8bit_subregion_matches_ground_truth() {
        let tile = 16u32;
        let (txn, tyn) = (2u32, 2u32);
        let (iw, ih) = (tile * txn, tile * tyn); // 32×32
        let full = gradient_rgba8(iw, ih);
        let mut tiles = Vec::new();
        for ty in 0..tyn {
            for tx in 0..txn {
                let mut t = vec![0u8; (tile * tile * 4) as usize];
                for ly in 0..tile {
                    for lx in 0..tile {
                        let (gx, gy) = (tx * tile + lx, ty * tile + ly);
                        let s = (((gy * iw + gx) * 4) as usize, 4);
                        let d = ((ly * tile + lx) * 4) as usize;
                        t[d..d + 4].copy_from_slice(&full[s.0..s.0 + s.1]);
                    }
                }
                tiles.push(enc_lossless(&Frame::rgba8(&t, tile, tile)));
            }
        }
        let container = build_jxtc(&tiles, txn, tyn, tile, iw, ih, false);
        // Crop a rect spanning all four tiles.
        let (rx, ry, rw, rh) = (8u32, 8u32, 16u32, 16u32);
        let out = decode_jxtc_region(&container, rx, ry, rw, rh).expect("jxtc decode");
        assert_eq!(out.len(), (rw * rh * 4) as usize);
        for y in 0..rh {
            for x in 0..rw {
                let s = (((ry + y) * iw + (rx + x)) * 4) as usize;
                let d = ((y * rw + x) * 4) as usize;
                assert_eq!(&out[d..d + 4], &full[s..s + 4], "px ({x},{y})");
            }
        }
    }

    #[test]
    fn decode_jxtc_region_16bit_byteview_matches_ground_truth() {
        // Exercises the TilePixels::U16 byte-view composite (no intermediate copy).
        let tile = 16u32;
        let (txn, tyn) = (2u32, 2u32);
        let (iw, ih) = (tile * txn, tile * tyn);
        let mut full: Vec<u16> = vec![0; (iw * ih * 4) as usize];
        for y in 0..ih {
            for x in 0..iw {
                let i = ((y * iw + x) * 4) as usize;
                full[i] = (x as u16).wrapping_mul(257);
                full[i + 1] = (y as u16).wrapping_mul(257);
                full[i + 2] = ((x + y) as u16).wrapping_mul(131);
                full[i + 3] = 65535;
            }
        }
        let mut tiles = Vec::new();
        for ty in 0..tyn {
            for tx in 0..txn {
                let mut t: Vec<u16> = vec![0; (tile * tile * 4) as usize];
                for ly in 0..tile {
                    for lx in 0..tile {
                        let (gx, gy) = (tx * tile + lx, ty * tile + ly);
                        let s = ((gy * iw + gx) * 4) as usize;
                        let d = ((ly * tile + lx) * 4) as usize;
                        t[d..d + 4].copy_from_slice(&full[s..s + 4]);
                    }
                }
                tiles.push(enc_lossless(&Frame::rgba(&t, tile, tile)));
            }
        }
        let container = build_jxtc(&tiles, txn, tyn, tile, iw, ih, true);
        let out = decode_jxtc_region(&container, 0, 0, iw, ih).expect("jxtc decode");
        let expected = u16_samples_to_ne_bytes(&full);
        assert_eq!(out.len(), expected.len(), "16-bit JXTC = 8 bytes/px");
        assert_eq!(out, expected, "byte-view composite must match ground truth");
    }

    #[test]
    fn decode_progressive_object_returns_full_image() {
        let (w, h) = (256u32, 192u32);
        let rgba = gradient_rgba8(w, h);
        let variants = crate::casabio_encode::encode_variants_with_progressive(
            &rgba,
            w,
            h,
            crate::casabio_encode::SourceType::Raw,
            false,
            2,
            1,
        )
        .expect("progressive encode");

        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let mut passes = 0u32;
        let img = dec
            .decode_progressive::<u8>(&variants.full, Channels::Rgba, |ev| {
                if let DecodeEvent::Progress { width, height, .. } = ev {
                    assert_eq!((width, height), (w, h));
                    passes += 1;
                }
                ProgressControl::Continue
            })
            .unwrap();
        assert_eq!((img.width, img.height), (w, h));
        assert_eq!(img.data.len(), (w * h * 4) as usize);
        let _ = passes;
    }

    #[test]
    fn decode_progressive_stop_returns_best_so_far() {
        let (w, h) = (256u32, 192u32);
        let rgba = gradient_rgba8(w, h);
        let variants = crate::casabio_encode::encode_variants_with_progressive(
            &rgba,
            w,
            h,
            crate::casabio_encode::SourceType::Raw,
            false,
            2,
            1,
        )
        .expect("progressive encode");

        let mut dec = Decoder::new(DecodeOptions::default()).unwrap();
        let img = dec
            .decode_progressive::<u8>(&variants.full, Channels::Rgba, |_| ProgressControl::Stop)
            .unwrap();
        // Stop on the first flushed pass (or run to completion if none) — either
        // way a full-shaped best-so-far image comes back.
        assert_eq!((img.width, img.height), (w, h));
        assert_eq!(img.data.len(), (w * h * 4) as usize);
    }

    // ── JXTC ROI container round-trip ────────────────────────────────────────
    // `decode_jxtc_region` is `pub` API consumed by the Tauri/WASM layer; it has
    // no in-crate caller, so these tests are its only regression guard. They pin
    // the lazy per-tile index read (P0) + the trust-boundary checks it relies on.

    /// Assemble a JXTC container (8-bit RGBA, one lossless JXL codestream per
    /// tile, row-major `idx = ty*tiles_x + tx`) from a full reference image — the
    /// inverse of [`decode_jxtc_region`], so a ROI decode can be checked against a
    /// plain crop of `ref_rgba`. Edge tiles are encoded at their true partial dims.
    fn build_jxtc_rgba8(ref_rgba: &[u8], w: u32, h: u32, tile_size: u32) -> Vec<u8> {
        let tiles_x = w.div_ceil(tile_size);
        let tiles_y = h.div_ceil(tile_size);
        let num_tiles = (tiles_x * tiles_y) as usize;

        let mut streams: Vec<Vec<u8>> = Vec::with_capacity(num_tiles);
        for ty in 0..tiles_y {
            for tx in 0..tiles_x {
                let (tx0, ty0) = (tx * tile_size, ty * tile_size);
                let tw = tile_size.min(w - tx0);
                let th = tile_size.min(h - ty0);
                let mut tile = vec![0u8; (tw * th * 4) as usize];
                for ry in 0..th {
                    for rx in 0..tw {
                        let s = (((ty0 + ry) * w + (tx0 + rx)) * 4) as usize;
                        let d = ((ry * tw + rx) * 4) as usize;
                        tile[d..d + 4].copy_from_slice(&ref_rgba[s..s + 4]);
                    }
                }
                streams.push(enc_lossless(&Frame::rgba8(&tile, tw, th)));
            }
        }

        let index_bytes = num_tiles * JXTC_INDEX_ENTRY_BYTES;
        let mut c: Vec<u8> = Vec::new();
        c.extend_from_slice(&JXTC_MAGIC.to_le_bytes());
        c.extend_from_slice(&JXTC_VERSION.to_le_bytes());
        c.extend_from_slice(&w.to_le_bytes());
        c.extend_from_slice(&h.to_le_bytes());
        c.extend_from_slice(&tile_size.to_le_bytes());
        c.extend_from_slice(&tiles_x.to_le_bytes());
        c.extend_from_slice(&tiles_y.to_le_bytes());
        c.extend_from_slice(&1u32.to_le_bytes()); // flags: has_alpha=1, 8-bit
        assert_eq!(c.len(), JXTC_HEADER_BYTES);

        // Index entries carry absolute offsets into the bytes past header+index.
        let mut cursor = JXTC_HEADER_BYTES + index_bytes;
        for s in &streams {
            c.extend_from_slice(&(cursor as u32).to_le_bytes());
            c.extend_from_slice(&(s.len() as u32).to_le_bytes());
            cursor += s.len();
        }
        assert_eq!(c.len(), JXTC_HEADER_BYTES + index_bytes);
        for s in &streams {
            c.extend_from_slice(s);
        }
        c
    }

    #[test]
    fn decode_jxtc_region_roi_matches_full_crop() {
        // 100x70 @ tile 32 → 4x3 grid; the right column is 4 px wide and the
        // bottom row 6 px tall, so this exercises *partial edge tiles*. The ROI
        // (x:40..98, y:30..68) straddles interior, right-edge, and bottom-edge
        // tiles in one shot (tx 1..3, ty 0..2).
        let (w, h, ts) = (100u32, 70u32, 32u32);
        let reference = gradient_rgba8(w, h);
        let container = build_jxtc_rgba8(&reference, w, h, ts);

        let (rx, ry, rw, rh) = (40u32, 30u32, 58u32, 38u32);
        let out = decode_jxtc_region(&container, rx, ry, rw, rh).expect("jxtc roi decode");
        assert_eq!(out.len(), (rw * rh * 4) as usize);
        for dy in 0..rh {
            for dx in 0..rw {
                let s = (((ry + dy) * w + (rx + dx)) * 4) as usize;
                let d = ((dy * rw + dx) * 4) as usize;
                assert_eq!(
                    &out[d..d + 4],
                    &reference[s..s + 4],
                    "roi pixel ({dx},{dy}) must equal source ({},{})",
                    rx + dx,
                    ry + dy
                );
            }
        }
    }

    #[test]
    fn decode_jxtc_region_single_interior_tile_reads_one_entry() {
        // ROI fully inside one interior tile → the lazy index path reads exactly
        // ONE 8-byte entry (the O(overlapping)-not-O(all-tiles) win P0 protects).
        let (w, h, ts) = (128u32, 128u32, 64u32);
        let reference = gradient_rgba8(w, h);
        let container = build_jxtc_rgba8(&reference, w, h, ts);

        let (rx, ry, rw, rh) = (72u32, 72u32, 20u32, 20u32); // inside tile (1,1)
        assert_eq!(
            overlapping_tile_indices(
                &parse_jxtc_header(&container).unwrap(),
                ImageRegion { x: rx, y: ry, w: rw, h: rh },
            ),
            vec![(1, 1)],
            "interior ROI must touch exactly one tile"
        );
        let out = decode_jxtc_region(&container, rx, ry, rw, rh).unwrap();
        for dy in 0..rh {
            for dx in 0..rw {
                let s = (((ry + dy) * w + (rx + dx)) * 4) as usize;
                let d = ((dy * rw + dx) * 4) as usize;
                assert_eq!(&out[d..d + 4], &reference[s..s + 4]);
            }
        }
    }

    #[test]
    fn parse_jxtc_header_rejects_malformed() {
        let (w, h, ts) = (64u32, 64u32, 32u32);
        let good = build_jxtc_rgba8(&gradient_rgba8(w, h), w, h, ts);
        assert!(parse_jxtc_header(&good).is_some(), "valid header parses");

        let mut bad_magic = good.clone();
        bad_magic[0] ^= 0xFF;
        assert!(parse_jxtc_header(&bad_magic).is_none(), "bad magic rejected");

        // tiles_x (bytes 20..24) must equal ceil(w/tile_size); a mismatch could let
        // tx*tile_size exceed image_w and underflow the dimension math downstream.
        let mut bad_grid = good.clone();
        bad_grid[20..24].copy_from_slice(&99u32.to_le_bytes());
        assert!(parse_jxtc_header(&bad_grid).is_none(), "tiles_x != ceil rejected");

        assert!(
            parse_jxtc_header(&good[..JXTC_HEADER_BYTES - 1]).is_none(),
            "short header rejected"
        );
    }

    #[test]
    fn decode_jxtc_region_skips_tile_entry_overlapping_index() {
        // Trust boundary: an index entry whose offset points back into the
        // header/index region (off < index_end) must be refused, never handed to
        // the JXL decoder. The overlapping tile is dropped (zeroed hole) and the
        // call still returns gracefully — no panic, no index bytes decoded.
        let (w, h, ts) = (64u32, 32u32, 32u32); // 2x1 tiles
        let mut c = build_jxtc_rgba8(&gradient_rgba8(w, h), w, h, ts);
        // Rewrite tile (0,0)'s offset (first index entry, bytes 32..36) to 0.
        c[JXTC_HEADER_BYTES..JXTC_HEADER_BYTES + 4].copy_from_slice(&0u32.to_le_bytes());
        let out = decode_jxtc_region(&c, 0, 0, ts, ts).expect("graceful skip, not None/panic");
        assert_eq!(out.len(), (ts * ts * 4) as usize);
        assert!(out.iter().all(|&b| b == 0), "rejected tile yields a zeroed hole");
    }

    // ── JxtcRegionDecoder session (stateful, byte-bounded tile cache) ─────────
    // The session parses header+index once and caches decoded tiles across
    // decode() calls, so an interactive pan re-decodes only newly-exposed tiles.
    // These tests pin: parity with the proven free fn, cross-call reuse (vs a
    // cache-disabled control), bounded eviction, strict/preview failure, cancel.

    fn assert_rgba_region(out: &[u8], reference: &[u8], img_w: u32, rx: u32, ry: u32, rw: u32, rh: u32) {
        for dy in 0..rh {
            for dx in 0..rw {
                let s = (((ry + dy) * img_w + (rx + dx)) * 4) as usize;
                let d = ((dy * rw + dx) * 4) as usize;
                assert_eq!(&out[d..d + 4], &reference[s..s + 4], "roi px ({dx},{dy})");
            }
        }
    }

    #[test]
    fn jxtc_session_roi_matches_free_fn() {
        let (w, h, ts) = (100u32, 70u32, 32u32);
        let reference = gradient_rgba8(w, h);
        let container = build_jxtc_rgba8(&reference, w, h, ts);
        let (rx, ry, rw, rh) = (40u32, 30u32, 58u32, 38u32);

        let mut s = JxtcRegionDecoder::new(&container, JxtcRegionOptions::default()).unwrap();
        let region = s.decode(ImageRegion { x: rx, y: ry, w: rw, h: rh }).unwrap();
        let free = decode_jxtc_region(&container, rx, ry, rw, rh).unwrap();
        assert_eq!(region.pixels, free, "session must match the proven free fn byte-for-byte");
        assert_rgba_region(&region.pixels, &reference, w, rx, ry, rw, rh);
    }

    #[test]
    fn jxtc_session_reuses_overlap_between_adjacent_viewports() {
        // 96x64 @ tile 32 → 3x2 grid. A horizontal pan shares the middle column.
        let (w, h, ts) = (96u32, 64u32, 32u32);
        let reference = gradient_rgba8(w, h);
        let container = build_jxtc_rgba8(&reference, w, h, ts);

        let mut s = JxtcRegionDecoder::new(
            &container,
            JxtcRegionOptions { cache_bytes: 16 * 1024 * 1024, ..Default::default() },
        )
        .unwrap();

        let f1 = s.decode(ImageRegion { x: 0, y: 0, w: 64, h: 64 }).unwrap();
        assert_eq!(
            (f1.metrics.cache_hits, f1.metrics.decoded_tiles),
            (0, 4),
            "cold frame decodes all 4 overlapping tiles"
        );
        assert_rgba_region(&f1.pixels, &reference, w, 0, 0, 64, 64);

        let f2 = s.decode(ImageRegion { x: 32, y: 0, w: 64, h: 64 }).unwrap();
        eprintln!(
            "JXTC pan reuse: hits={} decoded={} (stateless re-decode would be {})",
            f2.metrics.cache_hits,
            f2.metrics.decoded_tiles,
            f2.metrics.cache_hits + f2.metrics.decoded_tiles
        );
        assert_eq!(
            (f2.metrics.cache_hits, f2.metrics.decoded_tiles),
            (2, 2),
            "pan reuses the 2 shared tiles, decodes only the 2 newly-exposed"
        );
        assert_eq!(f2.metrics.missing_tiles, 0);
        assert_rgba_region(&f2.pixels, &reference, w, 32, 0, 64, 64);
    }

    #[test]
    fn jxtc_session_disabled_cache_decodes_every_frame() {
        // Control for the reuse test: cache_bytes = 0 ⇒ no reuse, full re-decode.
        // If the reuse counts above came from anything but the cache, this fails.
        let (w, h, ts) = (96u32, 64u32, 32u32);
        let reference = gradient_rgba8(w, h);
        let container = build_jxtc_rgba8(&reference, w, h, ts);

        let mut s = JxtcRegionDecoder::new(
            &container,
            JxtcRegionOptions { cache_bytes: 0, ..Default::default() },
        )
        .unwrap();
        let _ = s.decode(ImageRegion { x: 0, y: 0, w: 64, h: 64 }).unwrap();
        let f2 = s.decode(ImageRegion { x: 32, y: 0, w: 64, h: 64 }).unwrap();
        assert_eq!(
            (f2.metrics.cache_hits, f2.metrics.decoded_tiles),
            (0, 4),
            "no cache ⇒ no reuse ⇒ every overlapping tile re-decoded"
        );
        assert_rgba_region(&f2.pixels, &reference, w, 32, 0, 64, 64);
    }

    #[test]
    fn jxtc_session_eviction_keeps_correctness_and_budget() {
        let (w, h, ts) = (64u32, 64u32, 32u32); // 2x2 grid; each tile = 32*32*4 = 4096 B
        let reference = gradient_rgba8(w, h);
        let container = build_jxtc_rgba8(&reference, w, h, ts);

        let budget = 5000usize; // holds exactly one 4096-byte tile
        let mut s = JxtcRegionDecoder::new(
            &container,
            JxtcRegionOptions { cache_bytes: budget, ..Default::default() },
        )
        .unwrap();

        for _ in 0..2 {
            let f = s.decode(ImageRegion { x: 0, y: 0, w: 64, h: 64 }).unwrap();
            assert_rgba_region(&f.pixels, &reference, w, 0, 0, 64, 64);
            assert!(s.cache_bytes() <= budget, "cache stays within byte budget");
        }
        assert!(s.cache_tiles() <= 1, "tiny budget retains at most one tile");
    }

    #[test]
    fn jxtc_session_strict_errors_on_corrupt_tile() {
        let (w, h, ts) = (64u32, 32u32, 32u32);
        let mut c = build_jxtc_rgba8(&gradient_rgba8(w, h), w, h, ts);
        // Rewrite tile (0,0)'s offset to point back into the index region.
        c[JXTC_HEADER_BYTES..JXTC_HEADER_BYTES + 4].copy_from_slice(&0u32.to_le_bytes());

        let mut s = JxtcRegionDecoder::new(
            &c,
            JxtcRegionOptions { failure_policy: JxtcFailurePolicy::Strict, ..Default::default() },
        )
        .unwrap();
        assert!(
            s.decode(ImageRegion { x: 0, y: 0, w: ts, h: ts }).is_err(),
            "strict mode rejects the viewport when an overlapping tile is corrupt"
        );
    }

    #[test]
    fn jxtc_session_preview_reports_missing_and_zeros_hole() {
        let (w, h, ts) = (64u32, 32u32, 32u32); // 2x1 grid
        let mut c = build_jxtc_rgba8(&gradient_rgba8(w, h), w, h, ts);
        c[JXTC_HEADER_BYTES..JXTC_HEADER_BYTES + 4].copy_from_slice(&0u32.to_le_bytes());

        let mut s = JxtcRegionDecoder::new(
            &c,
            JxtcRegionOptions { failure_policy: JxtcFailurePolicy::Preview, ..Default::default() },
        )
        .unwrap();
        let f = s.decode(ImageRegion { x: 0, y: 0, w: ts, h: ts }).unwrap(); // only tile (0,0)
        assert_eq!(f.missing_tiles, vec![(0, 0)]);
        assert_eq!(f.metrics.missing_tiles, 1);
        assert!(f.pixels.iter().all(|&b| b == 0), "missing tile leaves a zeroed hole");
    }

    #[test]
    fn jxtc_session_cancel_propagates() {
        let (w, h, ts) = (64u32, 64u32, 32u32);
        let container = build_jxtc_rgba8(&gradient_rgba8(w, h), w, h, ts);
        let flag = Arc::new(AtomicBool::new(true));
        let mut s = JxtcRegionDecoder::new(
            &container,
            JxtcRegionOptions {
                decode: DecodeOptions { cancel: Some(flag.clone()), ..Default::default() },
                ..Default::default()
            },
        )
        .unwrap();
        assert!(matches!(
            s.decode(ImageRegion { x: 0, y: 0, w: 64, h: 64 }),
            Err(JxtcRegionError::Cancelled)
        ));
    }

    #[test]
    fn jxtc_session_16bit_matches_free_fn() {
        let tile = 16u32;
        let (txn, tyn) = (2u32, 2u32);
        let (iw, ih) = (tile * txn, tile * tyn);
        let mut full: Vec<u16> = vec![0; (iw * ih * 4) as usize];
        for y in 0..ih {
            for x in 0..iw {
                let i = ((y * iw + x) * 4) as usize;
                full[i] = (x as u16).wrapping_mul(257);
                full[i + 1] = (y as u16).wrapping_mul(257);
                full[i + 2] = ((x + y) as u16).wrapping_mul(131);
                full[i + 3] = 65535;
            }
        }
        let mut tiles = Vec::new();
        for ty in 0..tyn {
            for tx in 0..txn {
                let mut t: Vec<u16> = vec![0; (tile * tile * 4) as usize];
                for ly in 0..tile {
                    for lx in 0..tile {
                        let (gx, gy) = (tx * tile + lx, ty * tile + ly);
                        let s = ((gy * iw + gx) * 4) as usize;
                        let d = ((ly * tile + lx) * 4) as usize;
                        t[d..d + 4].copy_from_slice(&full[s..s + 4]);
                    }
                }
                tiles.push(enc_lossless(&Frame::rgba(&t, tile, tile)));
            }
        }
        let container = build_jxtc(&tiles, txn, tyn, tile, iw, ih, true);

        let mut s = JxtcRegionDecoder::new(&container, JxtcRegionOptions::default()).unwrap();
        let region = s.decode(ImageRegion { x: 0, y: 0, w: iw, h: ih }).unwrap();
        assert_eq!(region.bytes_per_pixel, 8);
        let free = decode_jxtc_region(&container, 0, 0, iw, ih).unwrap();
        assert_eq!(region.pixels, free, "16-bit session matches the free fn");
        assert_eq!(region.pixels, u16_samples_to_ne_bytes(&full));
    }

    fn gradient_rgb8(w: u32, h: u32) -> Vec<u8> {
        let mut v = vec![0u8; (w * h * 3) as usize];
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 3) as usize;
                v[i] = (x % 256) as u8;
                v[i + 1] = (y % 256) as u8;
                v[i + 2] = ((x + y) % 256) as u8;
            }
        }
        v
    }

    /// Build an **alpha-free** 8-bit JXTC container: RGB (3-channel) tiles, header
    /// flags = 0 (no alpha, 8-bit).
    fn build_jxtc_rgb8(ref_rgb: &[u8], w: u32, h: u32, tile_size: u32) -> Vec<u8> {
        let tiles_x = w.div_ceil(tile_size);
        let tiles_y = h.div_ceil(tile_size);
        let num_tiles = (tiles_x * tiles_y) as usize;
        let mut streams: Vec<Vec<u8>> = Vec::with_capacity(num_tiles);
        for ty in 0..tiles_y {
            for tx in 0..tiles_x {
                let (tx0, ty0) = (tx * tile_size, ty * tile_size);
                let tw = tile_size.min(w - tx0);
                let th = tile_size.min(h - ty0);
                let mut tile = vec![0u8; (tw * th * 3) as usize];
                for ry in 0..th {
                    for rx in 0..tw {
                        let s = (((ty0 + ry) * w + (tx0 + rx)) * 3) as usize;
                        let d = ((ry * tw + rx) * 3) as usize;
                        tile[d..d + 3].copy_from_slice(&ref_rgb[s..s + 3]);
                    }
                }
                streams.push(enc_lossless(&Frame::rgb(&tile, tw, th)));
            }
        }
        let index_bytes = num_tiles * JXTC_INDEX_ENTRY_BYTES;
        let mut c: Vec<u8> = Vec::new();
        c.extend_from_slice(&JXTC_MAGIC.to_le_bytes());
        c.extend_from_slice(&JXTC_VERSION.to_le_bytes());
        c.extend_from_slice(&w.to_le_bytes());
        c.extend_from_slice(&h.to_le_bytes());
        c.extend_from_slice(&tile_size.to_le_bytes());
        c.extend_from_slice(&tiles_x.to_le_bytes());
        c.extend_from_slice(&tiles_y.to_le_bytes());
        c.extend_from_slice(&0u32.to_le_bytes()); // flags: no alpha, 8-bit
        let mut cursor = JXTC_HEADER_BYTES + index_bytes;
        for s in &streams {
            c.extend_from_slice(&(cursor as u32).to_le_bytes());
            c.extend_from_slice(&(s.len() as u32).to_le_bytes());
            cursor += s.len();
        }
        for s in &streams {
            c.extend_from_slice(s);
        }
        c
    }

    fn assert_region_ch(out: &[u8], reference: &[u8], img_w: u32, rx: u32, ry: u32, rw: u32, rh: u32, ch: usize) {
        for dy in 0..rh {
            for dx in 0..rw {
                let s = (((ry + dy) * img_w + (rx + dx)) as usize) * ch;
                let d = ((dy * rw + dx) as usize) * ch;
                assert_eq!(&out[d..d + ch], &reference[s..s + ch], "px ({dx},{dy})");
            }
        }
    }

    #[test]
    fn jxtc_session_alpha_free_emits_rgb_in_fromheader_mode() {
        let (w, h, ts) = (64u32, 48u32, 32u32);
        let rgb = gradient_rgb8(w, h);
        let container = build_jxtc_rgb8(&rgb, w, h, ts);

        // FromHeader on a no-alpha container → RGB (3 bpp): 25% smaller output and
        // no alpha-synthesis work.
        let mut s = JxtcRegionDecoder::new(
            &container,
            JxtcRegionOptions { emit_alpha: EmitAlpha::FromHeader, ..Default::default() },
        )
        .unwrap();
        let r = s.decode(ImageRegion { x: 0, y: 0, w, h }).unwrap();
        assert_eq!(r.bytes_per_pixel, 3, "alpha-free FromHeader emits RGB");
        assert_eq!(r.pixels.len(), (w * h * 3) as usize);
        assert_region_ch(&r.pixels, &rgb, w, 0, 0, w, h, 3);

        // Always (default) → RGBA (4 bpp), libjxl fills opaque alpha. Preserves the
        // legacy contract even on a no-alpha container.
        let mut s2 = JxtcRegionDecoder::new(&container, JxtcRegionOptions::default()).unwrap();
        let r2 = s2.decode(ImageRegion { x: 0, y: 0, w, h }).unwrap();
        assert_eq!(r2.bytes_per_pixel, 4);
        for i in 0..(w * h) as usize {
            assert_eq!(&r2.pixels[i * 4..i * 4 + 3], &rgb[i * 3..i * 3 + 3], "rgb px {i}");
            assert_eq!(r2.pixels[i * 4 + 3], 255, "opaque alpha px {i}");
        }

        // Free fn is unchanged: always RGBA.
        let free = decode_jxtc_region(&container, 0, 0, w, h).unwrap();
        assert_eq!(free.len(), (w * h * 4) as usize, "free fn keeps the RGBA contract");
    }
}
