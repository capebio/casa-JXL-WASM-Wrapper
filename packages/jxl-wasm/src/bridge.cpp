#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <algorithm>
#include <vector>

#include <jxl/color_encoding.h>
#include <jxl/decode.h>
#include <jxl/encode.h>
#include <jxl/thread_parallel_runner.h>
#include <jxl/types.h>
#include "lib/jxl/butteraugli/butteraugli.h"
#include "lib/jxl/image.h"
#include "lib/jxl/memory_manager_internal.h"

#include <emscripten.h>  // for emscripten_get_now() in profiling hooks
#if __has_include(<jxl/gain_map.h>)
#include <jxl/gain_map.h>
#define JXL_GAIN_MAP_SUPPORTED 1
#else
#define JXL_GAIN_MAP_SUPPORTED 0
#endif
// JxlBool was added to jxl/types.h after the WASM build commit — provide fallback.
#ifndef JxlBool
typedef int JxlBool;
#endif

// IMPROVEMENT-1: `next` pointer enables sidecar linked-list without extra allocation.
struct JxlWasmBuffer {
  uint8_t* data;
  uint32_t size;         // explicit uint32 (A6): byte count independent of size_t/MEMORY64.
                         // High word not required for realistic image buffers.
  uint32_t width;
  uint32_t height;
  uint32_t bits_per_sample;
  uint32_t has_alpha;
  int error;
  JxlWasmBuffer* next;  // sidecar chain (null = last); caller walks and frees individually
  uint32_t owned_data;   // 1 = free external data on buffer_free; 0 = inline or borrowed
};
// WASM32 layout: data* + size (u32) + 5x u32 + int + next* + u32. First 7 u32-equivalent
// fields are 4-byte aligned for HEAPU32 direct reads in facade. Pointer width still
// follows target (guard below + TS load assert protect against WASM64 drift).

// A6: compile-time guard. size_t (used for other internal sizes) must be 32-bit or the
// overall FFI assumptions (and any remaining size_t in other structs) drift on MEMORY64.
static_assert(sizeof(size_t) == 4, "JxlWasmBuffer / bridge FFI requires 32-bit size_t; do not build with -sMEMORY64=1");

// #11: Streaming encoder state — encode once, yield output in 64 KB chunks.
// #16: Extended with streaming input fields: pre-allocate pixel buffer in WASM,
// push chunks directly, encode on finish — eliminates JS-side pixel accumulation.
struct JxlWasmEncState {
  // Output side (streaming output — shared by both paths)
  uint8_t* outbuf;
  size_t   outbuf_size;
  size_t   taken;         // bytes already returned via enc_take_chunk
  int      error_code;
  // Input side (#16: streaming input — only used when created via enc_create_image)
  uint8_t* pixels_buf;    // pre-allocated full pixel buffer; freed after enc_finish
  size_t   pixels_size;   // total expected bytes: width × height × 4 × bpc
  size_t   pixels_written;
  uint32_t enc_width;
  uint32_t enc_height;
  float    enc_distance;
  uint32_t enc_effort;
  uint32_t enc_fmt;
  uint32_t enc_has_alpha;
  uint32_t enc_progressive_dc;
  uint32_t enc_progressive_ac;
  uint32_t enc_qprogressive_ac;
  uint32_t enc_buffering;
  uint32_t enc_group_order;  // 0=scanline, 1=center-out (predator groupOrder for early recognizable passes)
  int32_t  enc_modular;
  int32_t  enc_brotli_effort;
  int32_t  enc_decoding_speed;
  int32_t  enc_photon_noise_iso;
  uint32_t enc_resampling;
  int32_t  enc_ec_resampling;
  int32_t  enc_epf;            // -1=auto, 0=off, 1-3=strength
  int32_t  enc_gaborish;       // -1=auto, 0=off, 1=on
  int32_t  enc_dots;           // -1=auto, 0=off, 1=on (VarDCT only)
  int32_t  enc_color_transform;// -1=auto, 0=XYB, 1=none, 2=YCbCr
  // CasaSneyers_Parity: intrinsic_size (Ch3) — display dims differ from encoded dims (Retina @2×)
  uint32_t enc_intrinsic_width;  // 0 = not set
  uint32_t enc_intrinsic_height; // 0 = not set
  // CasaSneyers_Parity: disable perceptual heuristics (ID 39) — for fair codec benchmarking
  int32_t  enc_disable_perceptual; // -1=auto, 1=disable butteraugli/XYB psychovisual
  // -1=libjxl automatic, 5/10=forced codestream level.
  int32_t  enc_codestream_level;
  // -1=default, 0=straight/unassociated alpha, 1=premultiplied/associated alpha.
  int32_t  enc_premultiply_alpha;
  // B3: optional metadata stored for enc_finish to pass to EncodeRgbaWithMetadata
  uint8_t* enc_icc;
  size_t   enc_icc_size;
  uint8_t* enc_exif;
  size_t   enc_exif_size;
  uint8_t* enc_xmp;
  size_t   enc_xmp_size;
  // EXIF orientation tag (1..8). 1 = identity, 3 = 180°, 6 = 90° CW, 8 = 90° CCW.
  // Stored in JXL basic info so pixels stay sensor-native — no CPU rotation.
  uint32_t enc_orientation;
};

// IMPROVEMENT-3: raw malloc for progressive decoder avoids std::vector<uint8_t> zero-init.
struct JxlWasmDecState {
  JxlDecoder* dec;
  JxlBasicInfo info;
  bool info_known;
  JxlPixelFormat pixel_format;
  uint8_t* pixels;       // working pixel buffer (raw malloc; null until first NEED_IMAGE_OUT_BUFFER)
  size_t   pixels_size;
  uint8_t* flushed;      // legacy owned progress buffer; progress now borrows pixels
  size_t   flushed_size;
  size_t   flushed_capacity;
  bool flushed_ready;
  uint32_t flush_count;     // number of successful TryFlushProgressiveImage calls
  uint32_t flush_attempts;   // number of JxlDecoderFlushImage calls
  uint32_t flush_successes;  // number of emitted progressive snapshots
  uint32_t flush_zero_skips;
  uint32_t flush_duplicate_skips;
  double flush_image_ms;
  bool suppress_duplicate_progress;
  bool last_progress_hash_valid;
  uint64_t last_progress_hash;
  size_t last_progress_size;
  bool final_ready;
  bool input_closed;
  bool input_set;
  uint8_t* input_buf;    // owned decoder input: unprocessed tail + newly appended bytes
  size_t   input_size;
  size_t   input_capacity;
  size_t   input_generation;
  size_t   opportunistic_flush_generation;
  // Gate for opportunistic flush. libjxl JxlDecoderFlushImage requires JXL_DEC_FRAME to have
  // fired and JXL_DEC_FULL_IMAGE to not yet have fired (per decode.h). Without this gate,
  // pre-frame flush returns useless state.
  bool frame_started;
  int error_code;
  // Gain map (jhgm box accumulation + parsed JXL codestream)
  uint8_t* gm_buf;           // raw jhgm box bytes being accumulated
  size_t   gm_capacity;
  size_t   gm_size;          // bytes written so far
  bool     gm_reading;       // currently accumulating a jhgm box
  uint8_t* gain_map_jxl;     // extracted gain map JXL codestream
  size_t   gain_map_jxl_size;
  bool     gain_map_ready;
  // Per-frame animation metadata (populated on JXL_DEC_FRAME event)
  uint32_t frame_index;          // zero-based frame counter
  uint32_t frame_duration;       // duration in ticks
  char     frame_name[256];      // null-terminated UTF-8 frame name (empty string if absent)
  uint32_t is_last_frame;        // 1 if this is the last animation frame
  // Animation header info (populated after JXL_DEC_BASIC_INFO when have_animation)
  double   anim_ticks_per_second;
  uint32_t anim_loop_count;
  // Progressive ROI crop (set via jxl_wasm_dec_set_region). When roi_active, take_flushed/
  // take_final return a nearest-downsampled crop of s->pixels (byte-exact with the JS
  // applyRegionAndDownsample fallback) instead of the full frame, so the JS layer skips its
  // crop loop. roi_x/y/w/h are ORIGINAL full-res coords (pre-downsample, already lower-clamped
  // to >=0 / >=1 by the caller); upper-clamp happens here against info.xsize/ysize.
  bool     roi_active;
  uint32_t roi_x, roi_y, roi_w, roi_h;
  uint32_t roi_downsample;   // 1/2/4/8
  uint8_t* roi_buf;          // grow-only owned crop output (borrowed out; freed in dec_free)
  size_t   roi_cap;
};

#define JXL_DEC_RESULT_NEED_MORE  0
#define JXL_DEC_RESULT_PROGRESS   1
#define JXL_DEC_RESULT_DONE       2
#define JXL_DEC_RESULT_ERROR     -1

static JxlWasmBuffer* MakeError(int error) {
  JxlWasmBuffer* out = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
  if (out != nullptr) {
    out->error = error;
  }
  return out;
}

static JxlWasmBuffer* MakeBuffer(const uint8_t* data, size_t size, uint32_t width, uint32_t height, uint32_t bits, uint32_t alpha) {
  JxlWasmBuffer* out = static_cast<JxlWasmBuffer*>(malloc(sizeof(JxlWasmBuffer) + size));
  if (out == nullptr) return nullptr;
  out->data = reinterpret_cast<uint8_t*>(out + 1);
  memcpy(out->data, data, size);
  out->size = size;
  out->width = width;
  out->height = height;
  out->bits_per_sample = bits;
  out->has_alpha = alpha;
  out->error = 0;
  out->next = nullptr;
  out->owned_data = 0;
  return out;
}

// IMPROVEMENT-1: Zero-copy buffer — caller transfers ownership of `data`.
// On malloc failure, frees `data` and returns nullptr so caller need not check.
static JxlWasmBuffer* MakeBufferFromOwned(uint8_t* data, size_t size, uint32_t width, uint32_t height, uint32_t bits, uint32_t alpha) {
  JxlWasmBuffer* out = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
  if (out == nullptr) { free(data); return nullptr; }
  out->data = data;
  out->size = size;
  out->width = width;
  out->height = height;
  out->bits_per_sample = bits;
  out->has_alpha = alpha;
  out->owned_data = 1;
  return out;
}

// Borrowed buffer — metadata handle only. Caller must synchronously copy the bytes
// before the producer mutates/frees `data`; buffer_free must not free `data`.
static JxlWasmBuffer* MakeBufferBorrowed(uint8_t* data, size_t size, uint32_t width, uint32_t height, uint32_t bits, uint32_t alpha) {
  JxlWasmBuffer* out = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
  if (out == nullptr) return nullptr;
  out->data = data;
  out->size = size;
  out->width = width;
  out->height = height;
  out->bits_per_sample = bits;
  out->has_alpha = alpha;
  out->owned_data = 0;
  return out;
}

static void FreeBufferNoChain(JxlWasmBuffer* buf) {
  if (buf == nullptr) return;
  if (buf->owned_data && buf->data != nullptr && buf->data != reinterpret_cast<uint8_t*>(buf + 1)) {
    free(buf->data);
  }
  free(buf);
}

// A1: Parallel runner — wires libjxl to the Emscripten pthread pool.
// Only active on threaded builds (-pthread / __EMSCRIPTEN_PTHREADS__).
// Cached as a module-level singleton: creating a runner is expensive (~50 ms).
#ifdef __EMSCRIPTEN_PTHREADS__
static void* g_parallel_runner = nullptr;
static void* GetSharedRunner() {
  if (g_parallel_runner == nullptr) {
    // Pre-warmed Emscripten pool is sized to navigator.hardwareConcurrency
    // (-sPTHREAD_POOL_SIZE in build.mjs); request the matching default worker
    // count so libjxl uses those warm threads instead of running serially.
    // Creating threads beyond the pool would deadlock: the worker thread is
    // blocked synchronously in decode and cannot service new pthread spawns.
    size_t workers = JxlThreadParallelRunnerDefaultNumWorkerThreads();
    g_parallel_runner = JxlThreadParallelRunnerCreate(nullptr, workers);
  }
  return g_parallel_runner;
}
// Inline helpers so the call-site error path can return any type.
static bool ApplyRunnerEnc(JxlEncoder* enc) {
  return JxlEncoderSetParallelRunner(enc, JxlThreadParallelRunner,
                                     GetSharedRunner()) == JXL_ENC_SUCCESS;
}
static bool ApplyRunnerDec(JxlDecoder* dec) {
  return JxlDecoderSetParallelRunner(dec, JxlThreadParallelRunner,
                                     GetSharedRunner()) == JXL_DEC_SUCCESS;
}
#define JXL_SETUP_ENC_RUNNER(enc, err_ret)                       \
  do { if (!ApplyRunnerEnc(enc)) {                               \
    JxlEncoderDestroy(enc); return err_ret; } } while (0)
#define JXL_SETUP_DEC_RUNNER(dec, err_ret)                       \
  do { if (!ApplyRunnerDec(dec)) {                               \
    JxlDecoderDestroy(dec); return err_ret; } } while (0)
#else
#define JXL_SETUP_ENC_RUNNER(enc, err_ret) ((void)0)
#define JXL_SETUP_DEC_RUNNER(dec, err_ret) ((void)0)
#endif

static JxlDataType FormatToDataType(uint32_t fmt) {
  if (fmt == 1) return JXL_TYPE_UINT16;
  if (fmt == 2) return JXL_TYPE_FLOAT;
  return JXL_TYPE_UINT8;
}
static uint32_t FormatToBits(uint32_t fmt) {
  if (fmt == 1) return 16;
  if (fmt == 2) return 32;
  return 8;
}
static uint32_t FormatToExponentBits(uint32_t fmt) {
  return (fmt == 2) ? 8u : 0u;
}

static uint32_t NormalizeResampling(uint32_t value) {
  return (value == 2u || value == 4u || value == 8u) ? value : 1u;
}

static int32_t NormalizeOptionalResampling(int32_t value) {
  return (value == 1 || value == 2 || value == 4 || value == 8) ? value : -1;
}

static void ApplyResamplingFrameSettings(JxlEncoderFrameSettings* frame, uint32_t resampling, int32_t ec_resampling) {
  const uint32_t normalized_resampling = NormalizeResampling(resampling);
  if (normalized_resampling > 1u) {
    JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_RESAMPLING, static_cast<int64_t>(normalized_resampling));
  }
  const int32_t normalized_ec_resampling = NormalizeOptionalResampling(ec_resampling);
  if (normalized_ec_resampling >= 1) {
    JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EXTRA_CHANNEL_RESAMPLING, static_cast<int64_t>(normalized_ec_resampling));
  }
}

static JxlDataType BitsToDataType(uint32_t bits) {
  if (bits == 16u) return JXL_TYPE_UINT16;
  if (bits == 32u) return JXL_TYPE_FLOAT;
  return JXL_TYPE_UINT8;
}

// Packed extra-channel descriptor written by the TypeScript facade.
// 20 bytes per entry, all fields 4-byte aligned. DataView layout must match exactly.
struct WasmExtraChannel {
  uint32_t type;       // JxlExtraChannelType value
  uint32_t bits;       // bits_per_sample (8, 16, or 32)
  float    distance;   // per-channel encode distance; < 0.0 = inherit main distance
  uint32_t plane_ptr;  // WASM heap address of single-channel pixel data (0 = not provided)
  uint32_t plane_size; // byte length of plane_ptr buffer
};

// Box-level options: container format control + Brotli metadata compression.
// 20 bytes. All fields uint32, 4-byte aligned. Layout must match TypeScript DataView writes.
struct WasmBoxOpts {
  uint32_t compress_boxes;    // offset  0: Brotli-compress metadata boxes via JxlEncoderAddBox
  uint32_t force_container;   // offset  4: JxlEncoderUseContainer(enc, JXL_TRUE)
  uint32_t raw_codestream;    // offset  8: JxlEncoderUseContainer(enc, JXL_FALSE)
  uint32_t custom_boxes_ptr;  // offset 12: WASM heap ptr to WasmCustomBox[] (0 = none)
  uint32_t num_custom_boxes;  // offset 16
};

// Per-custom-box descriptor — 16 bytes. Layout must match TypeScript DataView writes.
struct WasmCustomBox {
  char     box_type[4]; // offset  0: 4-char JXL box-type identifier
  uint32_t data_ptr;    // offset  4: WASM heap ptr to box data
  uint32_t data_size;   // offset  8: byte length
  uint32_t compress;    // offset 12: 0 or 1
};

// Animation frame descriptor — 32 bytes, 4-byte aligned.
// Layout matches TypeScript DataView writes in marshalAnimationFrames().
// CasaSneyers_Parity (Ch3/Ch9.3.2): blend_mode added at offset 28 for per-frame composition.
struct WasmAnimationFrame {
  uint32_t pixels_ptr;  // offset  0: WASM heap ptr to RGBA pixel data
  uint32_t pixels_size; // offset  4: byte length
  uint32_t width;       // offset  8
  uint32_t height;      // offset 12
  uint32_t duration;    // offset 16: in ticks
  uint32_t name_ptr;    // offset 20: WASM heap ptr to UTF-8 name (0 = none)
  uint32_t name_size;   // offset 24: byte length of name
  uint32_t blend_mode;  // offset 28: JxlBlendMode (0=replace, 1=add, 2=blend, 3=muladd, 4=mul)
};

// Animation header options — 8 bytes.
struct WasmAnimationOpts {
  uint32_t ticks_per_second; // offset 0: default 1000 (ms units)
  uint32_t loop_count;       // offset 4: 0 = infinite
};

// Apply container mode (raw/forced) from WasmBoxOpts. Call right after JxlEncoderCreate.
static JxlEncoderStatus ApplyContainerMode(JxlEncoder* enc, const WasmBoxOpts* opts) {
  if (opts == nullptr) return JXL_ENC_SUCCESS;
  if (opts->raw_codestream) {
    JxlEncoderUseContainer(enc, JXL_FALSE);
  } else if (opts->force_container) {
    JxlEncoderUseContainer(enc, JXL_TRUE);
  }
  return JXL_ENC_SUCCESS;
}

// Add caller-supplied custom boxes to the encoder. Call after all standard boxes.
static JxlEncoderStatus AddCustomBoxes(JxlEncoder* enc, const WasmBoxOpts* opts) {
  if (opts == nullptr || opts->custom_boxes_ptr == 0 || opts->num_custom_boxes == 0)
    return JXL_ENC_SUCCESS;
  const WasmCustomBox* boxes = reinterpret_cast<const WasmCustomBox*>(
      static_cast<uintptr_t>(opts->custom_boxes_ptr));
  for (uint32_t i = 0; i < opts->num_custom_boxes; ++i) {
    const WasmCustomBox& b = boxes[i];
    if (b.data_ptr == 0 || b.data_size == 0) continue;
    const uint8_t* data = reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(b.data_ptr));
    if (JxlEncoderAddBox(enc, b.box_type, data, b.data_size,
                         b.compress ? JXL_TRUE : JXL_FALSE) != JXL_ENC_SUCCESS) {
      return JXL_ENC_ERROR;
    }
  }
  return JXL_ENC_SUCCESS;
}

// Forward declarations — defined later in file, used here first.
static inline void CopyPixel(const uint8_t* src, uint8_t* dst, uint32_t bpp);
static void StripAlphaToRgb(const uint8_t* src, uint8_t* dst, size_t n_pixels, size_t bytes_per_channel);

// Nearest-neighbour downsampler. Power-of-two factors special-cased to avoid per-pixel std::min.
// src/dst are RGBA with bpp bytes per pixel (4, 8, or 16).
static void DownsampleRgba(const uint8_t* src, uint32_t sw, uint32_t sh,
                           uint8_t* dst, uint32_t dw, uint32_t dh,
                           uint32_t bpp, uint32_t downsample) {
  if (downsample == 2u) {
    for (uint32_t y = 0; y < dh; ++y) {
      const uint8_t* src_row = src + static_cast<size_t>(y * 2u) * sw * bpp;
      uint8_t*       dst_row = dst + static_cast<size_t>(y)       * dw * bpp;
      for (uint32_t x = 0; x < dw; ++x)
        CopyPixel(src_row + x * 2u * bpp, dst_row + x * bpp, bpp);
    }
  } else if (downsample == 4u) {
    for (uint32_t y = 0; y < dh; ++y) {
      const uint8_t* src_row = src + static_cast<size_t>(y * 4u) * sw * bpp;
      uint8_t*       dst_row = dst + static_cast<size_t>(y)       * dw * bpp;
      for (uint32_t x = 0; x < dw; ++x)
        CopyPixel(src_row + x * 4u * bpp, dst_row + x * bpp, bpp);
    }
  } else if (downsample == 8u) {
    for (uint32_t y = 0; y < dh; ++y) {
      const uint8_t* src_row = src + static_cast<size_t>(y * 8u) * sw * bpp;
      uint8_t*       dst_row = dst + static_cast<size_t>(y)       * dw * bpp;
      for (uint32_t x = 0; x < dw; ++x)
        CopyPixel(src_row + x * 8u * bpp, dst_row + x * bpp, bpp);
    }
  } else {
    for (uint32_t y = 0; y < dh; ++y) {
      const uint32_t sy      = std::min(y * downsample, sh - 1u);
      const uint8_t* src_row = src + static_cast<size_t>(sy) * sw * bpp;
      uint8_t*       dst_row = dst + static_cast<size_t>(y)  * dw * bpp;
      for (uint32_t x = 0; x < dw; ++x) {
        const uint32_t sx = std::min(x * downsample, sw - 1u);
        CopyPixel(src_row + sx * bpp, dst_row + x * bpp, bpp);
      }
    }
  }
}

// IMPROVEMENT-2: Raw malloc replaces std::vector zero-init + MakeBuffer memcpy for decode.
static JxlWasmBuffer* DecodeRgba(const uint8_t* input, size_t input_size, uint32_t downsample, uint32_t fmt) {
  if (input == nullptr || input_size == 0) return MakeError(1);

  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (dec == nullptr) return MakeError(2);
  JXL_SETUP_DEC_RUNNER(dec, MakeError(58));

  if (JxlDecoderSubscribeEvents(dec, JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE) != JXL_DEC_SUCCESS) {
    JxlDecoderDestroy(dec); return MakeError(3);
  }
  // JxlDecoderSetDownsamplingFactor was removed in libjxl 0.11.x; decode full-res and
  // downsample manually via DownsampleRgba below.

  JxlDecoderSetInput(dec, input, input_size);
  JxlDecoderCloseInput(dec);

  JxlBasicInfo info{};
  uint8_t* pixels_raw = nullptr;
  size_t pixels_size = 0;
  JxlPixelFormat pf = {4, FormatToDataType(fmt), JXL_NATIVE_ENDIAN, 0};

  JxlDecoderStatus status;
  while ((status = JxlDecoderProcessInput(dec)) != JXL_DEC_SUCCESS) {
    if (status == JXL_DEC_ERROR || status == JXL_DEC_NEED_MORE_INPUT) {
      free(pixels_raw); JxlDecoderDestroy(dec); return MakeError(static_cast<int>(status));
    }
    if (status == JXL_DEC_BASIC_INFO) {
      if (JxlDecoderGetBasicInfo(dec, &info) != JXL_DEC_SUCCESS) { free(pixels_raw); JxlDecoderDestroy(dec); return MakeError(10); }
      continue;
    }
    if (status == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      size_t buf_size = 0;
      if (JxlDecoderImageOutBufferSize(dec, &pf, &buf_size) != JXL_DEC_SUCCESS) { free(pixels_raw); JxlDecoderDestroy(dec); return MakeError(11); }
      if (buf_size > pixels_size) {
        free(pixels_raw);
        pixels_raw = static_cast<uint8_t*>(malloc(buf_size));
        if (pixels_raw == nullptr) { JxlDecoderDestroy(dec); return MakeError(14); }
        pixels_size = buf_size;
      }
      // Direct-buffer decode: libjxl writes pixels straight into pixels_raw — no intermediate
      // copy. Result is returned via MakeBufferFromOwned (ownership transfer, no memcpy).
      if (JxlDecoderSetImageOutBuffer(dec, &pf, pixels_raw, pixels_size) != JXL_DEC_SUCCESS) { free(pixels_raw); JxlDecoderDestroy(dec); return MakeError(12); }
      continue;
    }
  }

  JxlDecoderDestroy(dec);
  if (pixels_raw == nullptr || pixels_size == 0 || info.xsize == 0 || info.ysize == 0) {
    free(pixels_raw); return MakeError(13);
  }

  if (downsample <= 1u) {
    return MakeBufferFromOwned(pixels_raw, pixels_size, info.xsize, info.ysize, FormatToBits(fmt), 1);
  }

  const uint32_t out_w    = (info.xsize + downsample - 1u) / downsample;
  const uint32_t out_h    = (info.ysize + downsample - 1u) / downsample;
  const uint32_t bpp      = 4u * (FormatToBits(fmt) >> 3u);
  const size_t   out_size = static_cast<size_t>(out_w) * out_h * bpp;
  uint8_t* out_pixels = static_cast<uint8_t*>(malloc(out_size));
  if (out_pixels == nullptr) { free(pixels_raw); return MakeError(15); }
  DownsampleRgba(pixels_raw, info.xsize, info.ysize, out_pixels, out_w, out_h, bpp, downsample);
  free(pixels_raw);
  return MakeBufferFromOwned(out_pixels, out_size, out_w, out_h, FormatToBits(fmt), 1);
}

// #10: C++ region crop — decode full image with downsampling, then crop in C++.
// crop_* are in original (pre-downsample) image coords.
static JxlWasmBuffer* DecodeRgbaRegion(const uint8_t* input, size_t input_size,
    uint32_t crop_x, uint32_t crop_y, uint32_t crop_w, uint32_t crop_h,
    uint32_t downsample, uint32_t fmt) {
  JxlWasmBuffer* full = DecodeRgba(input, input_size, downsample, fmt);
  if (full == nullptr || full->error != 0) return full;

  const uint32_t ds   = (downsample > 1u) ? downsample : 1u;
  const uint32_t sx   = crop_x / ds;
  const uint32_t sy_  = crop_y / ds;
  const uint32_t sw   = (crop_w + ds - 1u) / ds;
  const uint32_t sh_  = (crop_h + ds - 1u) / ds;
  const uint32_t iw   = full->width;
  const uint32_t ih   = full->height;
  const uint32_t ax   = std::min(sx,  iw);
  const uint32_t ay   = std::min(sy_, ih);
  const uint32_t aw   = std::min(sw,  iw - ax);
  const uint32_t ah   = std::min(sh_, ih - ay);

  if (aw == 0 || ah == 0) {
    FreeBufferNoChain(full); return MakeError(32);  // crop outside image bounds
  }
  if (ax == 0 && ay == 0 && aw == iw && ah == ih) {
    return full;  // no-op crop
  }

  const uint32_t bits         = full->bits_per_sample;
  const uint32_t bps          = (bits == 32u) ? 4u : (bits == 16u) ? 2u : 1u;
  const uint32_t bytes_per_px = 4u * bps;
  const size_t   row_bytes    = static_cast<size_t>(aw) * bytes_per_px;
  const size_t   out_size     = row_bytes * static_cast<size_t>(ah);

  uint8_t* cropped = static_cast<uint8_t*>(malloc(out_size));
  if (cropped == nullptr) { FreeBufferNoChain(full); return MakeError(30); }

  for (uint32_t row = 0; row < ah; ++row) {
    const uint8_t* src = full->data + (static_cast<size_t>(ay + row) * iw + ax) * bytes_per_px;
    memcpy(cropped + row * row_bytes, src, row_bytes);
  }
  FreeBufferNoChain(full);

  JxlWasmBuffer* result = MakeBufferFromOwned(cropped, out_size, aw, ah, bits, 1u);
  return result != nullptr ? result : MakeError(31);
}

// Clamp arbitrary uint to a valid JxlOrientation (1..8). Out-of-range → identity.
static inline JxlOrientation ToJxlOrientation(uint32_t o) {
  return (o >= 1u && o <= 8u) ? static_cast<JxlOrientation>(o) : JXL_ORIENT_IDENTITY;
}

static inline void ApplyProgressiveFrameSettings(
    JxlEncoderFrameSettings* frame,
    uint32_t progressive_dc,
    uint32_t progressive_ac,
    uint32_t qprogressive_ac,
    uint32_t buffering,
    uint32_t group_order) {
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PROGRESSIVE_DC, static_cast<int64_t>(progressive_dc));
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PROGRESSIVE_AC, static_cast<int64_t>(progressive_ac));
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_QPROGRESSIVE_AC, static_cast<int64_t>(qprogressive_ac));
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_BUFFERING, static_cast<int64_t>(buffering));
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_GROUP_ORDER, static_cast<int64_t>(group_order));
  if (progressive_dc > 0 || progressive_ac > 0 || qprogressive_ac > 0) {
    JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_RESPONSIVE, 1);
  }
}

static JxlWasmBuffer* EncodeRgbaWithMetadata(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering,
    uint32_t group_order,  // predator: 0=scanline, 1=center-out for early passes
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    const WasmBoxOpts* box_opts = nullptr,
    int32_t epf = -1, int32_t gaborish = -1,
    int32_t dots = -1, int32_t color_transform = -1,
    uint32_t orientation = 1u,
    // CasaSneyers_Parity (Ch3): display dims separate from encoded pixel dims (Retina @2×)
    uint32_t intrinsic_width = 0u, uint32_t intrinsic_height = 0u,
    // CasaSneyers_Parity: disable psychovisual butteraugli/XYB model (ID 39) for fair benchmarking
    int32_t disable_perceptual = -1,
    int32_t codestream_level = -1,
    int32_t premultiply_alpha = -1,
    int32_t ec_resampling = -1) {
  if (pixels == nullptr || width == 0 || height == 0) return MakeError(20);

  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return MakeError(21);
  JXL_SETUP_ENC_RUNNER(enc, MakeError(57));
  if (ApplyContainerMode(enc, box_opts) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(54);
  }
  // libjxl 0.11+: JxlEncoderAddBox requires JxlEncoderUseBoxes (distinct from
  // JxlEncoderUseContainer). Must be called before any bytes are written.
  if ((exif != nullptr && exif_size > 0) || (xmp != nullptr && xmp_size > 0)) {
    JxlEncoderUseBoxes(enc);
  }

  const uint32_t bits     = FormatToBits(fmt);
  const uint32_t exp_bits = FormatToExponentBits(fmt);

  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize                  = width;
  info.ysize                  = height;
  info.bits_per_sample        = bits;
  info.exponent_bits_per_sample = exp_bits;
  info.num_color_channels     = 3;
  info.num_extra_channels     = has_alpha ? 1u : 0u;
  info.alpha_bits             = has_alpha ? bits : 0u;
  info.alpha_exponent_bits    = has_alpha ? exp_bits : 0u;
  if (has_alpha && premultiply_alpha >= 0) {
    info.alpha_premultiplied = premultiply_alpha > 0 ? JXL_TRUE : JXL_FALSE;
  }
  // JXL's free rotation: store EXIF orientation in the basic info. Decoders apply
  // the transform via metadata (canvas/CSS), no pixel rotation needed on encode.
  info.orientation            = ToJxlOrientation(orientation);
  // libjxl 0.11+: must declare uses_original_profile before SetBasicInfo when
  // an ICC profile will follow; encoder rejects SetICCProfile if XYB mode is locked in.
  info.uses_original_profile = (icc_profile != nullptr && icc_size > 0) ? JXL_TRUE : JXL_FALSE;
  // CasaSneyers_Parity (Ch3): non-zero signals display dims separate from encoded pixel dims
  // (e.g. Retina @2×). JxlBasicInfo.intrinsic_xsize/ysize; 0 = not set (default).
  if (intrinsic_width > 0u && intrinsic_height > 0u) {
    info.intrinsic_xsize = intrinsic_width;
    info.intrinsic_ysize = intrinsic_height;
  }

  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(22); }
  if (codestream_level == 5 || codestream_level == 10) {
    if (JxlEncoderSetCodestreamLevel(enc, codestream_level) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc);
      return MakeError(64);
    }
  }

  if (icc_profile != nullptr && icc_size > 0) {
    if (JxlEncoderSetICCProfile(enc, icc_profile, icc_size) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc);
      return MakeError(51);
    }
    // ICC profile already fully describes the colour space. Setting sRGB color
    // encoding afterwards is redundant and may produce undefined behaviour in
    // some libjxl versions when both are set. Skip when ICC is present.
  } else {
    JxlColorEncoding color;
    JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
    if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(23); }
  }

  JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
  JxlEncoderSetFrameDistance(frame, distance);
  if (distance == 0.0f) JxlEncoderSetFrameLossless(frame, JXL_TRUE);
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(effort));
  ApplyProgressiveFrameSettings(frame, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order);
  if (modular >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_MODULAR, static_cast<int64_t>(modular));
  if (brotli_effort >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_BROTLI_EFFORT, static_cast<int64_t>(brotli_effort));
  if (decoding_speed >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_DECODING_SPEED, static_cast<int64_t>(std::clamp(decoding_speed, 0, 4)));
  if (photon_noise_iso > 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PHOTON_NOISE, static_cast<int64_t>(photon_noise_iso));
  ApplyResamplingFrameSettings(frame, resampling, ec_resampling);
  if (epf >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EPF, static_cast<int64_t>(std::clamp(epf, 0, 3)));
  if (gaborish >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_GABORISH, static_cast<int64_t>(gaborish & 1));
  if (dots >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_DOTS, static_cast<int64_t>(dots & 1));
  if (color_transform >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_COLOR_TRANSFORM, static_cast<int64_t>(std::clamp(color_transform, 0, 2)));
  // CasaSneyers_Parity: disable psychovisual heuristics (ID 39) — bypass butteraugli/XYB model.
  if (disable_perceptual > 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_DISABLE_PERCEPTUAL_HEURISTICS, 1LL);

  const size_t bytes_per_channel = (fmt == 2) ? 4u : (fmt == 1) ? 2u : 1u;
  // A3: fmt==3 means caller already provides 3-channel RGB (no alpha in buffer).
  const bool input_is_rgb = (fmt == 3u);
  const uint32_t num_channels = (input_is_rgb || !has_alpha) ? 3u : 4u;
  JxlPixelFormat pf = {num_channels, FormatToDataType(fmt), JXL_NATIVE_ENDIAN, 0};

  uint8_t* rgb_pixels = nullptr;
  const uint8_t* encode_src = pixels;
  size_t pixel_size;
  if (input_is_rgb) {
    // Input is already 3-channel RGB — pass through directly, no strip needed.
    pixel_size = static_cast<size_t>(width) * height * 3u * bytes_per_channel;
  } else if (!has_alpha) {
    // 4-channel RGBA with has_alpha=false — strip alpha to 3-channel RGB.
    const size_t n_pixels   = static_cast<size_t>(width) * height;
    const size_t dst_stride = 3u * bytes_per_channel;
    pixel_size = n_pixels * dst_stride;
    rgb_pixels = static_cast<uint8_t*>(malloc(pixel_size));
    if (rgb_pixels == nullptr) { JxlEncoderDestroy(enc); return MakeError(29); }
    StripAlphaToRgb(pixels, rgb_pixels, n_pixels, bytes_per_channel);
    encode_src = rgb_pixels;
  } else {
    pixel_size = static_cast<size_t>(width) * height * 4u * bytes_per_channel;
  }

  const JxlEncoderStatus add_status = JxlEncoderAddImageFrame(frame, &pf, encode_src, pixel_size);
  free(rgb_pixels);
  if (add_status != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(24); }

  const JxlBool compress_flag = (box_opts && box_opts->compress_boxes) ? JXL_TRUE : JXL_FALSE;
  if (exif != nullptr && exif_size > 0) {
    if (JxlEncoderAddBox(enc, "Exif", exif, exif_size, compress_flag) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc);
      return MakeError(52);
    }
  }

  if (xmp != nullptr && xmp_size > 0) {
    if (JxlEncoderAddBox(enc, "xml ", xmp, xmp_size, compress_flag) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc);
      return MakeError(53);
    }
  }

  if (AddCustomBoxes(enc, box_opts) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(55);
  }

  JxlEncoderCloseInput(enc);

  const size_t initial_size = std::max(size_t(65536),
      distance == 0.0f ? (static_cast<size_t>(width) * height * 4u * ((fmt == 2) ? 4u : (fmt == 1) ? 2u : 1u)) / 2
                       : effort <= 3 ? (static_cast<size_t>(width) * height * 4u * ((fmt == 2) ? 4u : (fmt == 1) ? 2u : 1u)) / 12
                       : (static_cast<size_t>(width) * height * 4u * ((fmt == 2) ? 4u : (fmt == 1) ? 2u : 1u)) / 10);
  uint8_t* outbuf = static_cast<uint8_t*>(malloc(initial_size));
  if (outbuf == nullptr) { JxlEncoderDestroy(enc); return MakeError(25); }
  size_t outbuf_cap = initial_size;
  uint8_t* next_out = outbuf;
  size_t avail_out = outbuf_cap;
  for (;;) {
    JxlEncoderStatus status = JxlEncoderProcessOutput(enc, &next_out, &avail_out);
    if (status == JXL_ENC_SUCCESS) {
      const size_t final_size = static_cast<size_t>(next_out - outbuf);
      JxlEncoderDestroy(enc);
      JxlWasmBuffer* result = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
      if (result == nullptr) { free(outbuf); return MakeError(26); }
      result->data = outbuf;
      result->size = final_size;
      result->width = width;
      result->height = height;
      result->bits_per_sample = bits;
      result->has_alpha = has_alpha;
      return result;
    }
    if (status == JXL_ENC_NEED_MORE_OUTPUT) {
      const size_t offset = static_cast<size_t>(next_out - outbuf);
      outbuf_cap *= 2u;
      uint8_t* grown = static_cast<uint8_t*>(realloc(outbuf, outbuf_cap));
      if (grown == nullptr) { free(outbuf); JxlEncoderDestroy(enc); return MakeError(27); }
      outbuf = grown;
      next_out = outbuf + offset;
      avail_out = outbuf_cap - offset;
      continue;
    }
    free(outbuf);
    JxlEncoderDestroy(enc); return MakeError(static_cast<int>(status));
  }
}

static JxlWasmBuffer* EncodeRgba(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular = -1, int32_t brotli_effort = -1, int32_t decoding_speed = -1, int32_t photon_noise_iso = 0, uint32_t resampling = 1u,
    int32_t epf = -1, int32_t gaborish = -1, int32_t dots = -1, int32_t color_transform = -1,
    uint32_t orientation = 1u) {
  return EncodeRgbaWithMetadata(pixels, width, height, distance, effort, fmt, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, modular, brotli_effort, decoding_speed, photon_noise_iso, resampling, nullptr, 0, nullptr, 0, nullptr, 0, nullptr, epf, gaborish, dots, color_transform, orientation);
}

// === P2a: streaming (chunked-frame) RGB8 encode ==============================================
// Mirror of the proven native encode_chunked (crates/raw-pipeline/src/jxl_casaencoder.rs):
// JxlEncoderSetOutputProcessor + JxlChunkedFrameInputSource pull + buffering=2, driven by
// JxlEncoderAddChunkedFrame(is_last=TRUE) — no CloseInput/ProcessOutput. Input is a whole
// 3-channel RGB8 buffer for now (P2a isolates the streaming-encode wiring from row production);
// libjxl still pulls it in <=2048-row super-tiles, so this is byte-identical to the whole-frame
// encoder while exercising the streaming path that P2b/P2c will feed band-by-band. distance <= 0
// selects (modular) lossless.
namespace {

struct ChunkedRgbSrc {
  const uint8_t* data;
  uint32_t width;
  uint32_t num_channels;  // 3 (RGB8)
};

struct ChunkedOut {
  uint8_t* buf;
  size_t cap;
  size_t pos;         // current write cursor
  size_t high;        // high-water mark of bytes written
  size_t final_pos;   // set by set_finalized_position
  bool has_final;
  bool oom;
};

void ChunkedColorPf(void* op, JxlPixelFormat* pf) {
  auto* s = static_cast<ChunkedRgbSrc*>(op);
  pf->num_channels = s->num_channels;
  pf->data_type = JXL_TYPE_UINT8;
  pf->endianness = JXL_NATIVE_ENDIAN;
  pf->align = 0;
}

const void* ChunkedColorAt(void* op, size_t xpos, size_t ypos,
                           size_t /*xsize*/, size_t /*ysize*/, size_t* row_offset) {
  auto* s = static_cast<ChunkedRgbSrc*>(op);
  const size_t stride = static_cast<size_t>(s->width) * s->num_channels;
  *row_offset = stride;
  return s->data + ypos * stride + xpos * s->num_channels;
}

void ChunkedSrcRelease(void* /*op*/, const void* /*buf*/) {}

void* ChunkedOutGet(void* op, size_t* size) {
  auto* o = static_cast<ChunkedOut*>(op);
  const size_t want = std::max<size_t>(*size, static_cast<size_t>(1) << 16);
  const size_t need = o->pos + want;
  if (o->cap < need) {
    size_t newcap = o->cap ? o->cap : (static_cast<size_t>(1) << 16);
    while (newcap < need) newcap *= 2u;
    uint8_t* grown = static_cast<uint8_t*>(realloc(o->buf, newcap));
    if (grown == nullptr) { o->oom = true; *size = 0; return nullptr; }
    o->buf = grown;
    o->cap = newcap;
  }
  *size = o->cap - o->pos;
  return o->buf + o->pos;
}

void ChunkedOutRelease(void* op, size_t written_bytes) {
  auto* o = static_cast<ChunkedOut*>(op);
  o->pos += written_bytes;
  if (o->pos > o->high) o->high = o->pos;
}

void ChunkedOutSeek(void* op, uint64_t position) {
  static_cast<ChunkedOut*>(op)->pos = static_cast<size_t>(position);
}

void ChunkedOutFinal(void* op, uint64_t finalized_position) {
  auto* o = static_cast<ChunkedOut*>(op);
  o->final_pos = static_cast<size_t>(finalized_position);
  o->has_final = true;
}

}  // namespace

// Shared chunked-encode core: basic info (3ch 8-bit sRGB), frame settings (effort + buffering=2,
// lossless when distance<=0), the growable output processor, and drive the whole encode via
// AddChunkedFrame(is_last=TRUE) over the given input `source`. Used by BOTH the whole-buffer
// chunked encode (EncodeRgbChunked) and the JS-pull streaming encode (EncodeRgbStream), so all of
// {whole-frame, chunked, streamed} stay byte-identical. `source` (and whatever its opaque points
// to) must stay alive across this call — AddChunkedFrame invokes the callbacks synchronously.
static JxlWasmBuffer* EncodeViaChunkedSource(
    uint32_t width, uint32_t height, float distance, uint32_t effort,
    JxlChunkedFrameInputSource source) {
  if (width == 0 || height == 0) return MakeError(20);

  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return MakeError(21);
  JXL_SETUP_ENC_RUNNER(enc, MakeError(57));

  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize = width;
  info.ysize = height;
  info.bits_per_sample = 8;
  info.exponent_bits_per_sample = 0;
  info.num_color_channels = 3;
  info.num_extra_channels = 0;
  const bool lossless = (distance <= 0.0f);
  info.uses_original_profile = lossless ? JXL_TRUE : JXL_FALSE;
  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(22); }

  JxlColorEncoding color;
  JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
  if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(23); }

  JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(effort));
  // buffering=2 is present since libjxl 0.10. OUTPUT_MODE / USE_FULL_IMAGE_HEURISTICS (0.12-only,
  // and byte-neutral per the native proof) are deliberately NOT set, so this compiles against both
  // the 0.11.2 comparison clone and the 012 production fork. When the bridge is 012-only they can
  // be added (USE_FULL_IMAGE_HEURISTICS=0 tightens the encoder's own peak for true streaming).
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_BUFFERING, 2);
  if (lossless) JxlEncoderSetFrameLossless(frame, JXL_TRUE);
  else JxlEncoderSetFrameDistance(frame, distance);

  ChunkedOut ostate;
  ostate.buf = nullptr; ostate.cap = 0; ostate.pos = 0; ostate.high = 0;
  ostate.final_pos = 0; ostate.has_final = false; ostate.oom = false;
  JxlEncoderOutputProcessor out_proc;
  out_proc.opaque = &ostate;
  out_proc.get_buffer = ChunkedOutGet;
  out_proc.release_buffer = ChunkedOutRelease;
  out_proc.seek = ChunkedOutSeek;
  out_proc.set_finalized_position = ChunkedOutFinal;
  if (JxlEncoderSetOutputProcessor(enc, out_proc) != JXL_ENC_SUCCESS) {
    free(ostate.buf); JxlEncoderDestroy(enc); return MakeError(240);
  }

  // Output processor + is_last=TRUE: AddChunkedFrame drives the whole encode and emits via the
  // processor (no CloseInput/ProcessOutput). ostate stays alive across this call.
  const JxlEncoderStatus st = JxlEncoderAddChunkedFrame(frame, JXL_TRUE, source);
  JxlEncoderDestroy(enc);
  if (ostate.oom) { free(ostate.buf); return MakeError(241); }
  if (st != JXL_ENC_SUCCESS) { free(ostate.buf); return MakeError(static_cast<int>(st)); }

  const size_t final_size = ostate.has_final ? ostate.final_pos : std::max(ostate.high, ostate.pos);
  JxlWasmBuffer* result = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
  if (result == nullptr) { free(ostate.buf); return MakeError(26); }
  result->data = ostate.buf;
  result->size = final_size;
  result->width = width;
  result->height = height;
  result->bits_per_sample = 8;
  result->has_alpha = 0;
  return result;
}

static JxlWasmBuffer* EncodeRgbChunked(
    const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort) {
  if (pixels == nullptr) return MakeError(20);
  ChunkedRgbSrc srcstate;
  srcstate.data = pixels; srcstate.width = width; srcstate.num_channels = 3;
  JxlChunkedFrameInputSource source;
  source.opaque = &srcstate;
  source.get_color_channels_pixel_format = ChunkedColorPf;
  source.get_color_channel_data_at = ChunkedColorAt;
  source.get_extra_channel_pixel_format = nullptr;
  source.get_extra_channel_data_at = nullptr;
  source.release_buffer = ChunkedSrcRelease;
  return EncodeViaChunkedSource(width, height, distance, effort, source);  // srcstate lives across the call
}

// --- P2c (Approach A): streaming encode that pulls each band from the RAW-pipeline wasm module ---
// libjxl's chunked input source reenters JS synchronously (EM_JS) to fetch each requested band.
// The JS orchestration registers globalThis.__jxlP2cPull / __jxlP2cRelease, which pull one RGB8
// band out of the RAW module and copy it into THIS module's heap (returning ptr + row stride).
// Only one band is materialized at a time on each side ⇒ full-res / gigapixel export at
// O(super-tile band) memory. Byte-identical to the whole-buffer path (same EncodeViaChunkedSource).
// Bracket-notation global lookups so `--closure 1` does not rename the registered callbacks.
EM_JS(uint8_t*, jxl_p2c_pull_band,
      (uint32_t xpos, uint32_t ypos, uint32_t xsize, uint32_t ysize, uint32_t* stride_out), {
  const f = globalThis['__jxlP2cPull'];
  if (!f) return 0;
  const r = f(xpos >>> 0, ypos >>> 0, xsize >>> 0, ysize >>> 0);  // { ptr, stride } in this heap
  if (!r || !r['ptr']) return 0;
  HEAPU32[stride_out >>> 2] = r['stride'] >>> 0;
  return r['ptr'] >>> 0;
});
EM_JS(void, jxl_p2c_release_band, (uint8_t* buf), {
  const f = globalThis['__jxlP2cRelease'];
  if (f) f(buf >>> 0);
});

namespace {
void StreamColorPf(void* /*op*/, JxlPixelFormat* pf) {
  pf->num_channels = 3;
  pf->data_type = JXL_TYPE_UINT8;
  pf->endianness = JXL_NATIVE_ENDIAN;
  pf->align = 0;
}
const void* StreamColorAt(void* /*op*/, size_t xpos, size_t ypos, size_t xsize, size_t ysize, size_t* row_offset) {
  uint32_t stride = 0;
  uint8_t* p = jxl_p2c_pull_band(static_cast<uint32_t>(xpos), static_cast<uint32_t>(ypos),
                                 static_cast<uint32_t>(xsize), static_cast<uint32_t>(ysize), &stride);
  *row_offset = stride;
  return p;
}
void StreamRelease(void* /*op*/, const void* buf) {
  jxl_p2c_release_band(static_cast<uint8_t*>(const_cast<void*>(buf)));
}
}  // namespace

static JxlWasmBuffer* EncodeRgbStream(uint32_t width, uint32_t height, float distance, uint32_t effort) {
  JxlChunkedFrameInputSource source;
  source.opaque = nullptr;  // state lives in JS (globalThis.__jxlP2cPull)
  source.get_color_channels_pixel_format = StreamColorPf;
  source.get_color_channel_data_at = StreamColorAt;
  source.get_extra_channel_pixel_format = nullptr;
  source.get_extra_channel_data_at = nullptr;
  source.release_buffer = StreamRelease;
  return EncodeViaChunkedSource(width, height, distance, effort, source);
}

static JxlWasmBuffer* EncodeRgbaWithGainMap(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    const uint8_t* gain_map_jxl, size_t gain_map_jxl_size) {
  if (pixels == nullptr || width == 0 || height == 0) return MakeError(20);

  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return MakeError(21);
  JXL_SETUP_ENC_RUNNER(enc, MakeError(57));
  if ((exif != nullptr && exif_size > 0) || (xmp != nullptr && xmp_size > 0) || gain_map_jxl_size > 0) {
    JxlEncoderUseBoxes(enc);
  }

  const uint32_t bits     = FormatToBits(fmt);
  const uint32_t exp_bits = FormatToExponentBits(fmt);

  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize                    = width;
  info.ysize                    = height;
  info.bits_per_sample          = bits;
  info.exponent_bits_per_sample = exp_bits;
  info.num_color_channels       = 3;
  info.num_extra_channels       = has_alpha ? 1u : 0u;
  info.alpha_bits               = has_alpha ? bits : 0u;
  info.alpha_exponent_bits      = has_alpha ? exp_bits : 0u;
  info.uses_original_profile    = (icc_profile != nullptr && icc_size > 0) ? JXL_TRUE : JXL_FALSE;

  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(22); }

  if (icc_profile != nullptr && icc_size > 0) {
    if (JxlEncoderSetICCProfile(enc, icc_profile, icc_size) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(51);
    }
  } else {
    JxlColorEncoding color;
    JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
    if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(23); }
  }

  JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
  JxlEncoderSetFrameDistance(frame, distance);
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(effort));
  ApplyProgressiveFrameSettings(frame, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order);
  if (modular >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_MODULAR, static_cast<int64_t>(modular));
  if (brotli_effort >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_BROTLI_EFFORT, static_cast<int64_t>(brotli_effort));
  if (decoding_speed >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_DECODING_SPEED, static_cast<int64_t>(std::clamp(decoding_speed, 0, 4)));
  if (photon_noise_iso > 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PHOTON_NOISE, static_cast<int64_t>(photon_noise_iso));
  const uint32_t normalized_resampling = NormalizeResampling(resampling);
  if (normalized_resampling > 1u) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_RESAMPLING, static_cast<int64_t>(normalized_resampling));

  const size_t bytes_per_channel = (fmt == 2) ? 4u : (fmt == 1) ? 2u : 1u;
  const bool input_is_rgb = (fmt == 3u);
  const uint32_t num_channels = (input_is_rgb || !has_alpha) ? 3u : 4u;
  JxlPixelFormat pf = {num_channels, FormatToDataType(fmt), JXL_NATIVE_ENDIAN, 0};

  uint8_t* rgb_pixels = nullptr;
  const uint8_t* encode_src = pixels;
  size_t pixel_size;
  if (input_is_rgb) {
    pixel_size = static_cast<size_t>(width) * height * 3u * bytes_per_channel;
  } else if (!has_alpha) {
    const size_t n_pixels   = static_cast<size_t>(width) * height;
    const size_t dst_stride = 3u * bytes_per_channel;
    pixel_size = n_pixels * dst_stride;
    rgb_pixels = static_cast<uint8_t*>(malloc(pixel_size));
    if (rgb_pixels == nullptr) { JxlEncoderDestroy(enc); return MakeError(29); }
    StripAlphaToRgb(pixels, rgb_pixels, n_pixels, bytes_per_channel);
    encode_src = rgb_pixels;
  } else {
    pixel_size = static_cast<size_t>(width) * height * 4u * bytes_per_channel;
  }

  const JxlEncoderStatus add_status = JxlEncoderAddImageFrame(frame, &pf, encode_src, pixel_size);
  free(rgb_pixels);
  if (add_status != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(24); }

  if (exif != nullptr && exif_size > 0) {
    if (JxlEncoderAddBox(enc, "Exif", exif, exif_size, JXL_FALSE) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(52);
    }
  }
  if (xmp != nullptr && xmp_size > 0) {
    if (JxlEncoderAddBox(enc, "xml ", xmp, xmp_size, JXL_FALSE) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(53);
    }
  }

#if JXL_GAIN_MAP_SUPPORTED
  if (gain_map_jxl != nullptr && gain_map_jxl_size > 0) {
    JxlGainMapBundle bundle = {};
    bundle.gain_map      = gain_map_jxl;
    bundle.gain_map_size = static_cast<uint32_t>(gain_map_jxl_size);
    size_t bundle_size = 0;
    if (JxlGainMapGetBundleSize(&bundle, &bundle_size) != JXL_TRUE) {
      JxlEncoderDestroy(enc); return MakeError(60);
    }
    uint8_t* bundle_bytes = static_cast<uint8_t*>(malloc(bundle_size));
    if (bundle_bytes == nullptr) { JxlEncoderDestroy(enc); return MakeError(61); }
    size_t bytes_written = 0;
    if (JxlGainMapWriteBundle(&bundle, bundle_bytes, bundle_size, &bytes_written) != JXL_TRUE) {
      free(bundle_bytes); JxlEncoderDestroy(enc); return MakeError(62);
    }
    const JxlEncoderStatus gm_st = JxlEncoderAddBox(enc, "jhgm", bundle_bytes, bytes_written, JXL_FALSE);
    free(bundle_bytes);
    if (gm_st != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(63); }
  }
#endif

  JxlEncoderCloseInput(enc);

  const size_t initial_size = std::max(size_t(65536),
      distance == 0.0f ? (static_cast<size_t>(width) * height * 4u * ((fmt == 2) ? 4u : (fmt == 1) ? 2u : 1u)) / 2
                       : effort <= 3 ? (static_cast<size_t>(width) * height * 4u * ((fmt == 2) ? 4u : (fmt == 1) ? 2u : 1u)) / 12
                       : (static_cast<size_t>(width) * height * 4u * ((fmt == 2) ? 4u : (fmt == 1) ? 2u : 1u)) / 10);
  uint8_t* outbuf = static_cast<uint8_t*>(malloc(initial_size));
  if (outbuf == nullptr) { JxlEncoderDestroy(enc); return MakeError(25); }
  size_t outbuf_cap = initial_size;
  uint8_t* next_out = outbuf;
  size_t avail_out = outbuf_cap;
  for (;;) {
    JxlEncoderStatus status = JxlEncoderProcessOutput(enc, &next_out, &avail_out);
    if (status == JXL_ENC_SUCCESS) {
      const size_t final_size = static_cast<size_t>(next_out - outbuf);
      JxlEncoderDestroy(enc);
      JxlWasmBuffer* result = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
      if (result == nullptr) { free(outbuf); return MakeError(26); }
      result->data           = outbuf;
      result->size           = final_size;
      result->width          = width;
      result->height         = height;
      result->bits_per_sample = bits;
      result->has_alpha      = has_alpha;
      return result;
    }
    if (status == JXL_ENC_NEED_MORE_OUTPUT) {
      const size_t offset = static_cast<size_t>(next_out - outbuf);
      outbuf_cap *= 2u;
      uint8_t* grown = static_cast<uint8_t*>(realloc(outbuf, outbuf_cap));
      if (grown == nullptr) { free(outbuf); JxlEncoderDestroy(enc); return MakeError(27); }
      outbuf    = grown;
      next_out  = outbuf + offset;
      avail_out = outbuf_cap - offset;
      continue;
    }
    free(outbuf);
    JxlEncoderDestroy(enc); return MakeError(static_cast<int>(status));
  }
}

// Encode with per-extra-channel distance and optional separate channel planes.
// alpha_distance < 0 -> libjxl default for alpha.
// extra_channels/num_extra_channels describe channels beyond the implicit alpha.
static JxlWasmBuffer* EncodeRgbaWithExtraChannels(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed,
    int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    float alpha_distance,
    const WasmExtraChannel* extra_channels, uint32_t num_extra_channels,
    const WasmBoxOpts* box_opts = nullptr,
    uint32_t orientation = 1u,
    int32_t ec_resampling = -1) {
  if (pixels == nullptr || width == 0 || height == 0) return MakeError(120);

  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return MakeError(121);
  JXL_SETUP_ENC_RUNNER(enc, MakeError(57));
  if (ApplyContainerMode(enc, box_opts) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(134);
  }

  const uint32_t bits     = FormatToBits(fmt);
  const uint32_t exp_bits = FormatToExponentBits(fmt);

  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize                    = width;
  info.ysize                    = height;
  info.bits_per_sample          = bits;
  info.exponent_bits_per_sample = exp_bits;
  info.num_color_channels       = 3;
  info.num_extra_channels       = (has_alpha ? 1u : 0u) + num_extra_channels;
  info.alpha_bits               = has_alpha ? bits : 0u;
  info.alpha_exponent_bits      = has_alpha ? exp_bits : 0u;
  info.orientation              = ToJxlOrientation(orientation);

  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(122);
  }

  // Declare extra channels beyond alpha (alpha is declared via BasicInfo above).
  for (uint32_t i = 0; i < num_extra_channels; ++i) {
    const WasmExtraChannel& ec = extra_channels[i];
    const uint32_t ec_index = (has_alpha ? 1u : 0u) + i;
    JxlExtraChannelInfo ec_info;
    memset(&ec_info, 0, sizeof(ec_info));
    ec_info.type = static_cast<JxlExtraChannelType>(ec.type);
    ec_info.bits_per_sample = ec.bits > 0u ? ec.bits : 8u;
    ec_info.exponent_bits_per_sample = (ec.bits == 32u) ? 8u : 0u;
    if (JxlEncoderSetExtraChannelInfo(enc, ec_index, &ec_info) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(130);
    }
  }

  if (icc_profile != nullptr && icc_size > 0) {
    if (JxlEncoderSetICCProfile(enc, icc_profile, icc_size) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(129);
    }
  } else {
    JxlColorEncoding color;
    JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
    if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(123);
    }
  }

  JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
  JxlEncoderSetFrameDistance(frame, distance);
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(effort));
  ApplyProgressiveFrameSettings(frame, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order);
  if (modular >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_MODULAR, static_cast<int64_t>(modular));
  if (brotli_effort >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_BROTLI_EFFORT, static_cast<int64_t>(brotli_effort));
  if (decoding_speed >= 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_DECODING_SPEED, static_cast<int64_t>(std::clamp(decoding_speed, 0, 4)));
  if (photon_noise_iso > 0) JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PHOTON_NOISE, static_cast<int64_t>(photon_noise_iso));
  ApplyResamplingFrameSettings(frame, resampling, ec_resampling);

  // Per-extra-channel distances.
  if (has_alpha && alpha_distance >= 0.0f) {
    JxlEncoderSetExtraChannelDistance(frame, 0, alpha_distance);
  }
  for (uint32_t i = 0; i < num_extra_channels; ++i) {
    const WasmExtraChannel& ec = extra_channels[i];
    if (ec.distance >= 0.0f) {
      JxlEncoderSetExtraChannelDistance(frame, (has_alpha ? 1u : 0u) + i, ec.distance);
    }
  }

  // Main image frame (interleaved RGBA or RGB; libjxl splits alpha from interleaved data).
  const size_t bytes_per_channel = (fmt == 2) ? 4u : (fmt == 1) ? 2u : 1u;
  const uint32_t num_channels = has_alpha ? 4u : 3u;
  JxlPixelFormat pf = {num_channels, FormatToDataType(fmt), JXL_NATIVE_ENDIAN, 0};

  uint8_t* rgb_pixels = nullptr;
  const uint8_t* encode_src = pixels;
  size_t pixel_size;
  if (!has_alpha) {
    const size_t n_pixels   = static_cast<size_t>(width) * height;
    const size_t src_stride = 4u * bytes_per_channel;
    const size_t dst_stride = 3u * bytes_per_channel;
    pixel_size = n_pixels * dst_stride;
    rgb_pixels = static_cast<uint8_t*>(malloc(pixel_size));
    if (rgb_pixels == nullptr) { JxlEncoderDestroy(enc); return MakeError(128); }
    StripAlphaToRgb(pixels, rgb_pixels, n_pixels, bytes_per_channel);
    encode_src = rgb_pixels;
  } else {
    pixel_size = static_cast<size_t>(width) * height * 4u * bytes_per_channel;
  }

  const JxlEncoderStatus add_status = JxlEncoderAddImageFrame(frame, &pf, encode_src, pixel_size);
  free(rgb_pixels);
  if (add_status != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(124); }

  // Extra channel plane buffers (must follow JxlEncoderAddImageFrame).
  for (uint32_t i = 0; i < num_extra_channels; ++i) {
    const WasmExtraChannel& ec = extra_channels[i];
    if (ec.plane_ptr == 0u || ec.plane_size == 0u) continue;
    const uint32_t ec_index = (has_alpha ? 1u : 0u) + i;
    JxlPixelFormat ec_pf = {1u, BitsToDataType(ec.bits > 0u ? ec.bits : 8u), JXL_NATIVE_ENDIAN, 0};
    const void* plane_data = reinterpret_cast<const void*>(static_cast<uintptr_t>(ec.plane_ptr));
    if (JxlEncoderSetExtraChannelBuffer(frame, &ec_pf, plane_data, ec.plane_size, ec_index) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(131);
    }
  }

  const JxlBool compress_flag_ec = (box_opts && box_opts->compress_boxes) ? JXL_TRUE : JXL_FALSE;
  if (exif != nullptr && exif_size > 0) {
    if (JxlEncoderAddBox(enc, "Exif", exif, exif_size, compress_flag_ec) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(132);
    }
  }
  if (xmp != nullptr && xmp_size > 0) {
    if (JxlEncoderAddBox(enc, "xml ", xmp, xmp_size, compress_flag_ec) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(133);
    }
  }
  if (AddCustomBoxes(enc, box_opts) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(135);
  }

  JxlEncoderCloseInput(enc);

  const size_t initial_size = std::max(size_t(65536),
      distance == 0.0f ? (static_cast<size_t>(width) * height * 4u * ((fmt == 2) ? 4u : (fmt == 1) ? 2u : 1u)) / 2
                       : effort <= 3 ? (static_cast<size_t>(width) * height * 4u * ((fmt == 2) ? 4u : (fmt == 1) ? 2u : 1u)) / 12
                       : (static_cast<size_t>(width) * height * 4u * ((fmt == 2) ? 4u : (fmt == 1) ? 2u : 1u)) / 10);
  uint8_t* outbuf = static_cast<uint8_t*>(malloc(initial_size));
  if (outbuf == nullptr) { JxlEncoderDestroy(enc); return MakeError(125); }
  size_t outbuf_cap = initial_size;
  uint8_t* next_out = outbuf;
  size_t avail_out = outbuf_cap;
  for (;;) {
    JxlEncoderStatus status = JxlEncoderProcessOutput(enc, &next_out, &avail_out);
    if (status == JXL_ENC_SUCCESS) {
      const size_t final_size = static_cast<size_t>(next_out - outbuf);
      JxlEncoderDestroy(enc);
      JxlWasmBuffer* result = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
      if (result == nullptr) { free(outbuf); return MakeError(126); }
      result->data = outbuf;
      result->size = final_size;
      result->width = width;
      result->height = height;
      result->bits_per_sample = bits;
      result->has_alpha = has_alpha;
      return result;
    }
    if (status == JXL_ENC_NEED_MORE_OUTPUT) {
      const size_t offset = static_cast<size_t>(next_out - outbuf);
      outbuf_cap *= 2u;
      uint8_t* grown = static_cast<uint8_t*>(realloc(outbuf, outbuf_cap));
      if (grown == nullptr) { free(outbuf); JxlEncoderDestroy(enc); return MakeError(127); }
      outbuf = grown;
      next_out = outbuf + offset;
      avail_out = outbuf_cap - offset;
      continue;
    }
    free(outbuf);
    JxlEncoderDestroy(enc); return MakeError(static_cast<int>(status));
  }
}


// IMPROVEMENT-5: Integer box-filter downscale for RGBA8 thumbnail generation.
// Pixel-perfect averaging avoids aliasing artifacts visible at small sizes.
static void BoxDownscaleRgba8(const uint8_t* src, uint32_t sw, uint32_t sh,
                               uint8_t* dst, uint32_t dw, uint32_t dh) {
  if (dw == 0 || dh == 0) return;

  // Aggressive integer fast path for exact factors (common in thumbnail cascades).
  // Avoids the general ceiling division per output pixel when sw/dw and sh/dh are exact.
  if ((sw % dw == 0) && (sh % dh == 0)) {
    const uint32_t xstep = sw / dw;
    const uint32_t ystep = sh / dh;
    for (uint32_t dy = 0; dy < dh; ++dy) {
      for (uint32_t dx = 0; dx < dw; ++dx) {
        uint32_t r = 0, g = 0, b = 0, a = 0, count = 0;
        for (uint32_t yy = 0; yy < ystep; ++yy) {
          const uint32_t y = dy * ystep + yy;
          const uint8_t* row = src + y * sw * 4;
          for (uint32_t xx = 0; xx < xstep; ++xx) {
            const uint32_t x = dx * xstep + xx;
            const uint8_t* px = row + x * 4;
            r += px[0]; g += px[1]; b += px[2]; a += px[3];
            ++count;
          }
        }
        uint8_t* out = dst + (dy * dw + dx) * 4;
        out[0] = static_cast<uint8_t>(r / count);
        out[1] = static_cast<uint8_t>(g / count);
        out[2] = static_cast<uint8_t>(b / count);
        out[3] = static_cast<uint8_t>(a / count);
      }
    }
    return;
  }

  for (uint32_t dy = 0; dy < dh; ++dy) {
    const uint32_t y0 = (dy * sh) / dh;
    const uint32_t y1 = ((dy + 1u) * sh + dh - 1u) / dh;  // ceiling division
    for (uint32_t dx = 0; dx < dw; ++dx) {
      const uint32_t x0 = (dx * sw) / dw;
      const uint32_t x1 = ((dx + 1u) * sw + dw - 1u) / dw;
      uint32_t r = 0, g = 0, b = 0, a = 0, count = 0;
      for (uint32_t sy = y0; sy < y1; ++sy) {
        const uint8_t* row = src + sy * sw * 4;
        for (uint32_t sx = x0; sx < x1; ++sx) {
          const uint8_t* px = row + sx * 4;
          r += px[0]; g += px[1]; b += px[2]; a += px[3];
          ++count;
        }
      }
      uint8_t* out = dst + (dy * dw + dx) * 4;
      out[0] = static_cast<uint8_t>(r / count);
      out[1] = static_cast<uint8_t>(g / count);
      out[2] = static_cast<uint8_t>(b / count);
      out[3] = static_cast<uint8_t>(a / count);
    }
  }
}

static bool LooksLikeJpeg(const uint8_t* p, size_t n) {
  return n >= 4 && p[0] == 0xFF && p[1] == 0xD8 && p[n - 2] == 0xFF && p[n - 1] == 0xD9;
}

// Fast per-pixel copy for decoder downsample paths (power-of-2 and general).
// Specializes the dominant bpp==4 (rgba8) and bpp==3 cases with direct bytes.
static inline void CopyPixel(const uint8_t* src, uint8_t* dst, uint32_t bpp) {
  if (bpp == 4) {
    dst[0] = src[0]; dst[1] = src[1]; dst[2] = src[2]; dst[3] = src[3];
  } else if (bpp == 3) {
    dst[0] = src[0]; dst[1] = src[1]; dst[2] = src[2];
  } else {
    memcpy(dst, src, bpp);
  }
}

// Fast alpha strip (RGBA -> RGB) for encode paths. Specializes the common 8-bit case
// with direct byte copies to avoid per-pixel memcpy call overhead on millions of pixels.
static void StripAlphaToRgb(const uint8_t* src, uint8_t* dst, size_t n_pixels, size_t bytes_per_channel) {
  const size_t src_stride = 4 * bytes_per_channel;
  const size_t dst_stride = 3 * bytes_per_channel;
  if (bytes_per_channel == 1) {
    for (size_t i = 0; i < n_pixels; ++i) {
      const uint8_t* s = src + i * 4;
      uint8_t* d = dst + i * 3;
      d[0] = s[0]; d[1] = s[1]; d[2] = s[2];
    }
  } else {
    for (size_t i = 0; i < n_pixels; ++i) {
      memcpy(dst + i * dst_stride, src + i * src_stride, dst_stride);
    }
  }
}

// --- Tiled multi-frame encode (ROI support) ---
//
// Encodes a full RGBA8 image as a JXL container with one frame per tile,
// each frame carrying layer_info.have_crop = JXL_TRUE plus crop offsets.
// The resulting file can be decoded with JxlDecoderSetCoalescing(JXL_FALSE)
// + JxlDecoderSkipFrames to retrieve individual tiles without decoding the
// whole image — the core mechanism for true region-of-interest decode in
// libjxl 0.11.x (which has no JxlDecoderSetCropWindow).
static JxlWasmBuffer* EncodeRgba8Tiled(const uint8_t* pixels,
    uint32_t width, uint32_t height, uint32_t tile_size,
    float distance, uint32_t effort, uint32_t has_alpha) {
  if (pixels == nullptr || width == 0 || height == 0 || tile_size == 0) return MakeError(60);

  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return MakeError(61);
  JXL_SETUP_ENC_RUNNER(enc, MakeError(57));

  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize                    = width;
  info.ysize                    = height;
  info.bits_per_sample          = 8;
  info.exponent_bits_per_sample = 0;
  info.num_color_channels       = 3;
  info.num_extra_channels       = has_alpha ? 1u : 0u;
  info.alpha_bits               = has_alpha ? 8u : 0u;
  info.alpha_exponent_bits      = 0;
  info.have_animation           = JXL_FALSE;

  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(62); }

  JxlColorEncoding color;
  JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
  if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(63); }

  const uint32_t tiles_x         = (width  + tile_size - 1u) / tile_size;
  const uint32_t tiles_y         = (height + tile_size - 1u) / tile_size;
  const uint32_t bytes_per_pixel = has_alpha ? 4u : 3u;

  // Per-tile staging buffer (RGBA8 or RGB8 after stripping alpha).
  uint8_t* tile_buf = static_cast<uint8_t*>(malloc(static_cast<size_t>(tile_size) * tile_size * 4u));
  if (tile_buf == nullptr) { JxlEncoderDestroy(enc); return MakeError(64); }

  JxlPixelFormat pf = {has_alpha ? 4u : 3u, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};

  for (uint32_t ty = 0; ty < tiles_y; ++ty) {
    for (uint32_t tx = 0; tx < tiles_x; ++tx) {
      const uint32_t x0 = tx * tile_size;
      const uint32_t y0 = ty * tile_size;
      const uint32_t tw = std::min(tile_size, width  - x0);
      const uint32_t th = std::min(tile_size, height - y0);

      // Pull tile pixels out of full image, stripping alpha if needed.
      if (has_alpha) {
        for (uint32_t row = 0; row < th; ++row) {
          memcpy(tile_buf + row * tw * 4u,
                 pixels + (static_cast<size_t>(y0 + row) * width + x0) * 4u,
                 tw * 4u);
        }
      } else {
        for (uint32_t row = 0; row < th; ++row) {
          const uint8_t* src = pixels   + (static_cast<size_t>(y0 + row) * width + x0) * 4u;
          uint8_t*       dst = tile_buf + row * tw * 3u;
          for (uint32_t col = 0; col < tw; ++col) {
            dst[col * 3u + 0] = src[col * 4u + 0];
            dst[col * 3u + 1] = src[col * 4u + 1];
            dst[col * 3u + 2] = src[col * 4u + 2];
          }
        }
      }

      JxlFrameHeader fh;
      JxlEncoderInitFrameHeader(&fh);
      fh.duration                      = 0;
      fh.layer_info.have_crop          = JXL_TRUE;
      fh.layer_info.crop_x0            = static_cast<int32_t>(x0);
      fh.layer_info.crop_y0            = static_cast<int32_t>(y0);
      fh.layer_info.xsize              = tw;
      fh.layer_info.ysize              = th;
      fh.layer_info.blend_info.blendmode = JXL_BLEND_REPLACE;
      fh.layer_info.blend_info.source    = 0;
      fh.layer_info.blend_info.alpha     = 0;
      fh.layer_info.blend_info.clamp     = JXL_FALSE;
      fh.layer_info.save_as_reference    = 0;

      JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
      if (frame == nullptr) { free(tile_buf); JxlEncoderDestroy(enc); return MakeError(65); }
      JxlEncoderSetFrameDistance(frame, distance);
      JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(effort));

      if (JxlEncoderSetFrameHeader(frame, &fh) != JXL_ENC_SUCCESS) {
        free(tile_buf); JxlEncoderDestroy(enc); return MakeError(66);
      }

      const size_t tile_pixel_size = static_cast<size_t>(tw) * th * bytes_per_pixel;
      if (JxlEncoderAddImageFrame(frame, &pf, tile_buf, tile_pixel_size) != JXL_ENC_SUCCESS) {
        free(tile_buf); JxlEncoderDestroy(enc); return MakeError(67);
      }
    }
  }
  free(tile_buf);

  JxlEncoderCloseInput(enc);

  // Output capacity heuristic: a quarter of raw RGBA size (lossy compresses well).
  size_t outbuf_cap = std::max(static_cast<size_t>(65536),
      static_cast<size_t>(width) * height);
  uint8_t* outbuf = static_cast<uint8_t*>(malloc(outbuf_cap));
  if (outbuf == nullptr) { JxlEncoderDestroy(enc); return MakeError(68); }
  uint8_t* next_out = outbuf;
  size_t   avail_out = outbuf_cap;
  for (;;) {
    JxlEncoderStatus status = JxlEncoderProcessOutput(enc, &next_out, &avail_out);
    if (status == JXL_ENC_SUCCESS) {
      const size_t final_size = static_cast<size_t>(next_out - outbuf);
      JxlEncoderDestroy(enc);
      return MakeBufferFromOwned(outbuf, final_size, width, height, 8, has_alpha);
    }
    if (status == JXL_ENC_NEED_MORE_OUTPUT) {
      const size_t offset = static_cast<size_t>(next_out - outbuf);
      outbuf_cap *= 2u;
      uint8_t* grown = static_cast<uint8_t*>(realloc(outbuf, outbuf_cap));
      if (grown == nullptr) { free(outbuf); JxlEncoderDestroy(enc); return MakeError(69); }
      outbuf    = grown;
      next_out  = outbuf + offset;
      avail_out = outbuf_cap - offset;
      continue;
    }
    free(outbuf);
    JxlEncoderDestroy(enc);
    return MakeError(static_cast<int>(status));
  }
}

// --- Tiled region decode (ROI support) ---
//
// Decodes only the tiles overlapping `[region_x, region_x+region_w) ×
// [region_y, region_y+region_h)` from a JXL produced by EncodeRgba8Tiled.
// Uses JxlDecoderSetCoalescing(JXL_FALSE) + JxlDecoderSkipFrames to skip
// past frames whose pixel data we don't need. Known limitation in libjxl ≤0.11.x:
// SkipFrames still walks frame headers and may decompress internally — see JXTC
// tile container below for a true ROI alternative.
static JxlWasmBuffer* DecodeRgba8RegionTiled(const uint8_t* input, size_t input_size,
    uint32_t tile_size, uint32_t region_x, uint32_t region_y,
    uint32_t region_w, uint32_t region_h) {
  if (input == nullptr || input_size == 0 || tile_size == 0) return MakeError(70);

  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (dec == nullptr) return MakeError(71);
  JXL_SETUP_DEC_RUNNER(dec, MakeError(58));

  if (JxlDecoderSubscribeEvents(dec,
        JXL_DEC_BASIC_INFO | JXL_DEC_FRAME | JXL_DEC_FULL_IMAGE) != JXL_DEC_SUCCESS) {
    JxlDecoderDestroy(dec); return MakeError(72);
  }
  // SetCoalescing check — result will be visible only if it fails (error 73)
  if (JxlDecoderSetCoalescing(dec, JXL_FALSE) != JXL_DEC_SUCCESS) {
    JxlDecoderDestroy(dec); return MakeError(73);
  }
  JxlDecoderSetInput(dec, input, input_size);
  JxlDecoderCloseInput(dec);

  // Run decoder until basic info known.
  JxlBasicInfo info{};
  bool info_known = false;
  while (!info_known) {
    JxlDecoderStatus st = JxlDecoderProcessInput(dec);
    if (st == JXL_DEC_BASIC_INFO) {
      if (JxlDecoderGetBasicInfo(dec, &info) != JXL_DEC_SUCCESS) {
        JxlDecoderDestroy(dec); return MakeError(74);
      }
      info_known = true;
      break;
    }
    if (st == JXL_DEC_ERROR || st == JXL_DEC_NEED_MORE_INPUT || st == JXL_DEC_SUCCESS) {
      JxlDecoderDestroy(dec); return MakeError(75);
    }
  }

  // Clamp region to image bounds.
  const uint32_t rx = std::min(region_x, info.xsize);
  const uint32_t ry = std::min(region_y, info.ysize);
  const uint32_t rw = std::min(region_w, info.xsize - rx);
  const uint32_t rh = std::min(region_h, info.ysize - ry);
  if (rw == 0 || rh == 0) { JxlDecoderDestroy(dec); return MakeError(76); }

  const uint32_t tiles_x = (info.xsize + tile_size - 1u) / tile_size;
  const uint32_t tx_min  = rx / tile_size;
  const uint32_t tx_max  = (rx + rw - 1u) / tile_size;
  const uint32_t ty_min  = ry / tile_size;
  const uint32_t ty_max  = (ry + rh - 1u) / tile_size;

  const size_t out_size  = static_cast<size_t>(rw) * rh * 4u;
  uint8_t* out_pixels = static_cast<uint8_t*>(malloc(out_size));
  if (out_pixels == nullptr) { JxlDecoderDestroy(dec); return MakeError(77); }

  size_t tile_buf_cap = static_cast<size_t>(tile_size) * tile_size * 4u;
  uint8_t* tile_buf   = static_cast<uint8_t*>(malloc(tile_buf_cap));
  if (tile_buf == nullptr) { free(out_pixels); JxlDecoderDestroy(dec); return MakeError(78); }

  JxlPixelFormat pf = {4, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};

  // Walk overlapping tiles in row-major order; SkipFrames between non-adjacent ones.
  uint32_t cursor_idx = 0;
  for (uint32_t ty = ty_min; ty <= ty_max; ++ty) {
    for (uint32_t tx = tx_min; tx <= tx_max; ++tx) {
      const uint32_t target_idx = ty * tiles_x + tx;
      if (target_idx > cursor_idx) {
        JxlDecoderSkipFrames(dec, target_idx - cursor_idx);
      }

      uint32_t tile_x0 = 0, tile_y0 = 0, tile_w = 0, tile_h = 0;
      bool got_image = false;
      int process_input_calls = 0;
      while (!got_image) {
        process_input_calls++;
        JxlDecoderStatus st = JxlDecoderProcessInput(dec);
        if (st == JXL_DEC_FRAME) {
          JxlFrameHeader fh{};
          if (JxlDecoderGetFrameHeader(dec, &fh) == JXL_DEC_SUCCESS) {
            tile_x0 = static_cast<uint32_t>(fh.layer_info.crop_x0);
            tile_y0 = static_cast<uint32_t>(fh.layer_info.crop_y0);
            tile_w  = fh.layer_info.xsize;
            tile_h  = fh.layer_info.ysize;
          }
          continue;
        }
        if (st == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
          size_t buf_size = 0;
          if (JxlDecoderImageOutBufferSize(dec, &pf, &buf_size) != JXL_DEC_SUCCESS) {
            free(tile_buf); free(out_pixels); JxlDecoderDestroy(dec); return MakeError(79);
          }
          if (buf_size > tile_buf_cap) {
            uint8_t* grown = static_cast<uint8_t*>(realloc(tile_buf, buf_size));
            if (grown == nullptr) {
              free(tile_buf); free(out_pixels); JxlDecoderDestroy(dec); return MakeError(80);
            }
            tile_buf     = grown;
            tile_buf_cap = buf_size;
          }
          if (JxlDecoderSetImageOutBuffer(dec, &pf, tile_buf, tile_buf_cap) != JXL_DEC_SUCCESS) {
            free(tile_buf); free(out_pixels); JxlDecoderDestroy(dec); return MakeError(81);
          }
          continue;
        }
        if (st == JXL_DEC_FULL_IMAGE) { got_image = true; break; }
        if (st == JXL_DEC_ERROR || st == JXL_DEC_NEED_MORE_INPUT || st == JXL_DEC_SUCCESS) {
          free(tile_buf); free(out_pixels); JxlDecoderDestroy(dec); return MakeError(82);
        }
      }
      cursor_idx = target_idx + 1;

      // Composite tile pixels into the output region. Overlap is in image coords.
      const uint32_t ox0 = std::max(tile_x0, rx);
      const uint32_t oy0 = std::max(tile_y0, ry);
      const uint32_t ox1 = std::min(tile_x0 + tile_w, rx + rw);
      const uint32_t oy1 = std::min(tile_y0 + tile_h, ry + rh);
      if (ox1 <= ox0 || oy1 <= oy0) continue;
      const uint32_t ow = ox1 - ox0;
      const uint32_t oh = oy1 - oy0;

      for (uint32_t row = 0; row < oh; ++row) {
        const uint8_t* src = tile_buf   + ((oy0 - tile_y0 + row) * tile_w + (ox0 - tile_x0)) * 4u;
        uint8_t*       dst = out_pixels + ((oy0 - ry      + row) * rw     + (ox0 - rx))      * 4u;
        memcpy(dst, src, ow * 4u);
      }
    }
  }

  free(tile_buf);
  JxlDecoderDestroy(dec);
  return MakeBufferFromOwned(out_pixels, out_size, rw, rh, 8, 1);
}

// --- Tile container (JXTC) format ---
//
// Stores N independent standalone JXL bitstreams + a byte-offset index.
// Decode seeks directly to needed tiles — zero frame-walk overhead.
// Works on any libjxl version.
//
// Layout:
//   [Header 32B] magic 'JXTC' | version=1 | image_w | image_h |
//                tile_size | tiles_x | tiles_y | flags (bit0=has_alpha)
//   [Index 8B × N] per tile: offset (4B), length (4B)
//   [N standalone JXL bitstreams]
#define JXTC_MAGIC          0x4354584Au  // 'JXTC' little-endian
#define JXTC_VERSION        1u
#define JXTC_HEADER_BYTES   32u
#define JXTC_INDEX_BYTES    8u
// Upper bound on tiles_x*tiles_y. Far beyond any real encode (a 4096x4096 image
// at tile_size=1 is 2^24 tiles), yet small enough that tile_count and every
// derived byte-size (tile_count*JXTC_INDEX_BYTES, the calloc'd pointer/length
// arrays) stay well inside uint32 / wasm32 size_t. Prevents the 32-bit overflow
// of tiles_x*tiles_y from under-sizing the per-tile arrays.
#define JXTC_MAX_TILES      (1u << 24)

// Encode a single RGBA8 tile as a standalone JXL bitstream.
// Strips alpha channel inline if !has_alpha. Returns malloc'd buffer; caller frees.
// On failure returns nullptr and leaves *out_size unchanged.
static uint8_t* EncodeStandaloneJxlTileRgba8(const uint8_t* rgba_pixels,
    uint32_t width, uint32_t height, float distance, uint32_t effort,
    uint32_t has_alpha, size_t* out_size) {
  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return nullptr;
  JXL_SETUP_ENC_RUNNER(enc, nullptr);

  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize                    = width;
  info.ysize                    = height;
  info.bits_per_sample          = 8;
  info.exponent_bits_per_sample = 0;
  info.num_color_channels       = 3;
  info.num_extra_channels       = has_alpha ? 1u : 0u;
  info.alpha_bits               = has_alpha ? 8u : 0u;
  info.alpha_exponent_bits      = 0;
  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return nullptr; }

  JxlColorEncoding color;
  JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
  if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return nullptr; }

  JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
  JxlEncoderSetFrameDistance(frame, distance);
  JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(effort));

  JxlPixelFormat pf = {has_alpha ? 4u : 3u, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};
  uint8_t* stripped = nullptr;
  const uint8_t* src = rgba_pixels;
  size_t pixel_size;
  if (has_alpha) {
    pixel_size = static_cast<size_t>(width) * height * 4u;
  } else {
    const size_t n = static_cast<size_t>(width) * height;
    pixel_size = n * 3u;
    stripped = static_cast<uint8_t*>(malloc(pixel_size));
    if (stripped == nullptr) { JxlEncoderDestroy(enc); return nullptr; }
    for (size_t i = 0; i < n; ++i) {
      stripped[i * 3 + 0] = rgba_pixels[i * 4 + 0];
      stripped[i * 3 + 1] = rgba_pixels[i * 4 + 1];
      stripped[i * 3 + 2] = rgba_pixels[i * 4 + 2];
    }
    src = stripped;
  }

  const JxlEncoderStatus add_status = JxlEncoderAddImageFrame(frame, &pf, src, pixel_size);
  free(stripped);
  if (add_status != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return nullptr; }

  JxlEncoderCloseInput(enc);

  size_t cap = std::max(static_cast<size_t>(4096), pixel_size / 4u);
  uint8_t* outbuf = static_cast<uint8_t*>(malloc(cap));
  if (outbuf == nullptr) { JxlEncoderDestroy(enc); return nullptr; }
  uint8_t* next_out  = outbuf;
  size_t   avail_out = cap;
  for (;;) {
    JxlEncoderStatus s = JxlEncoderProcessOutput(enc, &next_out, &avail_out);
    if (s == JXL_ENC_SUCCESS) {
      *out_size = static_cast<size_t>(next_out - outbuf);
      JxlEncoderDestroy(enc);
      return outbuf;
    }
    if (s == JXL_ENC_NEED_MORE_OUTPUT) {
      const size_t off = static_cast<size_t>(next_out - outbuf);
      cap *= 2u;
      uint8_t* grown = static_cast<uint8_t*>(realloc(outbuf, cap));
      if (grown == nullptr) { free(outbuf); JxlEncoderDestroy(enc); return nullptr; }
      outbuf    = grown;
      next_out  = outbuf + off;
      avail_out = cap - off;
      continue;
    }
    free(outbuf);
    JxlEncoderDestroy(enc);
    return nullptr;
  }
}

// Decode a standalone JXL bitstream to RGBA8. Returns malloc'd pixel buffer; caller frees.
// Writes decoded dimensions to *out_w, *out_h. On failure returns nullptr.
static uint8_t* DecodeStandaloneJxlTileRgba8(const uint8_t* input, size_t input_size,
    uint32_t* out_w, uint32_t* out_h) {
  *out_w = 0; *out_h = 0;
  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (dec == nullptr) return nullptr;
  JXL_SETUP_DEC_RUNNER(dec, nullptr);

  if (JxlDecoderSubscribeEvents(dec, JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE) != JXL_DEC_SUCCESS) {
    JxlDecoderDestroy(dec); return nullptr;
  }
  JxlDecoderSetInput(dec, input, input_size);
  JxlDecoderCloseInput(dec);

  JxlBasicInfo info{};
  uint8_t* pixels = nullptr;
  size_t   pixels_size = 0;
  JxlPixelFormat pf = {4, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};

  for (;;) {
    JxlDecoderStatus st = JxlDecoderProcessInput(dec);
    if (st == JXL_DEC_SUCCESS) break;
    if (st == JXL_DEC_ERROR || st == JXL_DEC_NEED_MORE_INPUT) {
      free(pixels); JxlDecoderDestroy(dec); return nullptr;
    }
    if (st == JXL_DEC_BASIC_INFO) {
      if (JxlDecoderGetBasicInfo(dec, &info) != JXL_DEC_SUCCESS) { JxlDecoderDestroy(dec); return nullptr; }
      continue;
    }
    if (st == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      size_t buf_size = 0;
      if (JxlDecoderImageOutBufferSize(dec, &pf, &buf_size) != JXL_DEC_SUCCESS) {
        free(pixels); JxlDecoderDestroy(dec); return nullptr;
      }
      if (buf_size > pixels_size) {
        free(pixels);
        pixels = static_cast<uint8_t*>(malloc(buf_size));
        if (pixels == nullptr) { JxlDecoderDestroy(dec); return nullptr; }
        pixels_size = buf_size;
      }
      if (JxlDecoderSetImageOutBuffer(dec, &pf, pixels, pixels_size) != JXL_DEC_SUCCESS) {
        free(pixels); JxlDecoderDestroy(dec); return nullptr;
      }
      continue;
    }
  }

  JxlDecoderDestroy(dec);
  *out_w = info.xsize;
  *out_h = info.ysize;
  return pixels;
}

// Encode RGBA8 image into JXTC tile container.
static JxlWasmBuffer* EncodeRgba8TileContainer(const uint8_t* pixels,
    uint32_t width, uint32_t height, uint32_t tile_size,
    float distance, uint32_t effort, uint32_t has_alpha) {
  if (pixels == nullptr || width == 0 || height == 0 || tile_size == 0) return MakeError(90);

  const uint32_t tiles_x    = (width  + tile_size - 1u) / tile_size;
  const uint32_t tiles_y    = (height + tile_size - 1u) / tile_size;
  // Compute tiles_x*tiles_y in 64-bit: a 32-bit product can wrap, which would
  // under-size the calloc'd tile_bytes/tile_lengths arrays below while the encode
  // loop still writes tiles_y*tiles_x entries (idx = ty*tiles_x+tx) -> heap overflow.
  // Reject the (pathological) overflow case up-front; narrow to uint32 only once safe.
  const uint64_t tile_count64 = static_cast<uint64_t>(tiles_x) * tiles_y;
  if (tile_count64 == 0 || tile_count64 > JXTC_MAX_TILES) return MakeError(91);
  const uint32_t tile_count = static_cast<uint32_t>(tile_count64);

  uint8_t** tile_bytes   = static_cast<uint8_t**>(calloc(tile_count, sizeof(uint8_t*)));
  size_t*   tile_lengths = static_cast<size_t*>(  calloc(tile_count, sizeof(size_t)));
  if (tile_bytes == nullptr || tile_lengths == nullptr) {
    free(tile_bytes); free(tile_lengths); return MakeError(92);
  }

  const size_t tile_stage_bytes = static_cast<size_t>(tile_size) * tile_size * 4u;
  uint8_t* tile_stage = static_cast<uint8_t*>(malloc(tile_stage_bytes));
  if (tile_stage == nullptr) {
    free(tile_bytes); free(tile_lengths); return MakeError(93);
  }

  size_t total_tile_bytes = 0;
  for (uint32_t ty = 0; ty < tiles_y; ++ty) {
    for (uint32_t tx = 0; tx < tiles_x; ++tx) {
      const uint32_t x0 = tx * tile_size;
      const uint32_t y0 = ty * tile_size;
      const uint32_t tw = std::min(tile_size, width  - x0);
      const uint32_t th = std::min(tile_size, height - y0);

      for (uint32_t row = 0; row < th; ++row) {
        memcpy(tile_stage + row * tw * 4u,
               pixels + (static_cast<size_t>(y0 + row) * width + x0) * 4u,
               tw * 4u);
      }

      size_t out_size = 0;
      uint8_t* enc_bytes = EncodeStandaloneJxlTileRgba8(tile_stage, tw, th, distance, effort, has_alpha, &out_size);
      if (enc_bytes == nullptr) {
        for (uint32_t i = 0; i < tile_count; ++i) free(tile_bytes[i]);
        free(tile_bytes); free(tile_lengths); free(tile_stage);
        return MakeError(94);
      }
      const uint32_t idx = ty * tiles_x + tx;
      tile_bytes[idx]   = enc_bytes;
      tile_lengths[idx] = out_size;
      total_tile_bytes += out_size;
    }
  }
  free(tile_stage);

  const size_t header_bytes = JXTC_HEADER_BYTES;
  const size_t index_bytes  = static_cast<size_t>(tile_count) * JXTC_INDEX_BYTES;
  const size_t total_size   = header_bytes + index_bytes + total_tile_bytes;
  uint8_t* output = static_cast<uint8_t*>(malloc(total_size));
  if (output == nullptr) {
    for (uint32_t i = 0; i < tile_count; ++i) free(tile_bytes[i]);
    free(tile_bytes); free(tile_lengths);
    return MakeError(95);
  }

  uint32_t* h32 = reinterpret_cast<uint32_t*>(output);
  h32[0] = JXTC_MAGIC;
  h32[1] = JXTC_VERSION;
  h32[2] = width;
  h32[3] = height;
  h32[4] = tile_size;
  h32[5] = tiles_x;
  h32[6] = tiles_y;
  h32[7] = has_alpha ? 1u : 0u;

  uint32_t cursor = static_cast<uint32_t>(header_bytes + index_bytes);
  uint32_t* index = reinterpret_cast<uint32_t*>(output + header_bytes);
  for (uint32_t i = 0; i < tile_count; ++i) {
    index[i * 2 + 0] = cursor;
    index[i * 2 + 1] = static_cast<uint32_t>(tile_lengths[i]);
    memcpy(output + cursor, tile_bytes[i], tile_lengths[i]);
    cursor += static_cast<uint32_t>(tile_lengths[i]);
    free(tile_bytes[i]);
  }
  free(tile_bytes);
  free(tile_lengths);

  return MakeBufferFromOwned(output, total_size, width, height, 8, has_alpha);
}

// Decode region from a JXTC tile container. Only tiles overlapping the region
// are decoded. Each tile is a standalone JXL — zero frame-walk overhead.
static JxlWasmBuffer* DecodeRgba8TileContainerRegion(const uint8_t* input, size_t input_size,
    uint32_t region_x, uint32_t region_y, uint32_t region_w, uint32_t region_h) {
  if (input == nullptr || input_size < JXTC_HEADER_BYTES) return MakeError(100);

  const uint32_t* h32 = reinterpret_cast<const uint32_t*>(input);
  if (h32[0] != JXTC_MAGIC)   return MakeError(101);
  if (h32[1] != JXTC_VERSION) return MakeError(102);
  const uint32_t image_w   = h32[2];
  const uint32_t image_h   = h32[3];
  const uint32_t tile_size = h32[4];
  const uint32_t tiles_x   = h32[5];
  const uint32_t tiles_y   = h32[6];
  if (image_w == 0 || image_h == 0 || tile_size == 0 || tiles_x == 0 || tiles_y == 0) return MakeError(103);

  const uint32_t tile_count = tiles_x * tiles_y;
  const size_t header_bytes = JXTC_HEADER_BYTES;
  const size_t index_bytes  = static_cast<size_t>(tile_count) * JXTC_INDEX_BYTES;
  if (input_size < header_bytes + index_bytes) return MakeError(104);
  const uint32_t* index = reinterpret_cast<const uint32_t*>(input + header_bytes);

  const uint32_t rx = std::min(region_x, image_w);
  const uint32_t ry = std::min(region_y, image_h);
  const uint32_t rw = std::min(region_w, image_w - rx);
  const uint32_t rh = std::min(region_h, image_h - ry);
  if (rw == 0 || rh == 0) return MakeError(105);

  const uint32_t tx_min = rx / tile_size;
  const uint32_t tx_max = (rx + rw - 1u) / tile_size;
  const uint32_t ty_min = ry / tile_size;
  const uint32_t ty_max = (ry + rh - 1u) / tile_size;

  const size_t out_size = static_cast<size_t>(rw) * rh * 4u;
  uint8_t* out_pixels = static_cast<uint8_t*>(calloc(out_size, 1u));
  if (out_pixels == nullptr) return MakeError(106);

  for (uint32_t ty = ty_min; ty <= ty_max; ++ty) {
    for (uint32_t tx = tx_min; tx <= tx_max; ++tx) {
      const uint32_t idx = ty * tiles_x + tx;
      if (idx >= tile_count) { free(out_pixels); return MakeError(107); }
      const uint32_t offset = index[idx * 2 + 0];
      const uint32_t length = index[idx * 2 + 1];
      if (offset < header_bytes + index_bytes || static_cast<size_t>(offset) + length > input_size) {
        free(out_pixels); return MakeError(108);
      }

      uint32_t tile_w = 0, tile_h = 0;
      uint8_t* tile_pixels = DecodeStandaloneJxlTileRgba8(input + offset, length, &tile_w, &tile_h);
      if (tile_pixels == nullptr) { free(out_pixels); return MakeError(109); }

      const uint32_t tile_x0 = tx * tile_size;
      const uint32_t tile_y0 = ty * tile_size;
      const uint32_t ox0 = std::max(tile_x0, rx);
      const uint32_t oy0 = std::max(tile_y0, ry);
      const uint32_t ox1 = std::min(tile_x0 + tile_w, rx + rw);
      const uint32_t oy1 = std::min(tile_y0 + tile_h, ry + rh);

      if (ox1 > ox0 && oy1 > oy0) {
        const uint32_t ow = ox1 - ox0;
        const uint32_t oh = oy1 - oy0;
        for (uint32_t row = 0; row < oh; ++row) {
          const uint8_t* src = tile_pixels + ((oy0 - tile_y0 + row) * tile_w + (ox0 - tile_x0)) * 4u;
          uint8_t*       dst = out_pixels  + ((oy0 - ry      + row) * rw     + (ox0 - rx))      * 4u;
          memcpy(dst, src, ow * 4u);
        }
      }
      free(tile_pixels);
    }
  }

  // A3: 1px seam blending at internal JXTC tile boundaries using Q8 fixed-point.
  // Source buffer now calloc (no uninit garbage into blends). Bulk is memcpy; seams only.
  // Formula: (l*179 + r*77 + 128)>>8 per channel (8-bit). Vert then horiz for deterministic corners.
  // Lightweight — only touches O(perimeter) pixels.
  {
    // Vertical seams (between tx and tx+1)
    for (uint32_t txx = tx_min + 1; txx <= tx_max; ++txx) {
      const uint32_t abs_seam = txx * tile_size;
      if (abs_seam <= rx || abs_seam >= (rx + rw)) continue;
      const uint32_t localL = (abs_seam - 1) - rx; // right col of left tile
      const uint32_t localR = abs_seam - rx;       // left col of right tile
      if (localL >= rw || localR >= rw) continue;
      for (uint32_t yy = 0; yy < rh; ++yy) {
        uint8_t* pL = out_pixels + ((yy * rw + localL) * 4u);
        uint8_t* pR = out_pixels + ((yy * rw + localR) * 4u);
        for (int c = 0; c < 4; ++c) {
          int l = pL[c];
          int r = pR[c];
          int b = (l * 179 + r * 77 + 128) >> 8;
          pL[c] = static_cast<uint8_t>(b);
          pR[c] = static_cast<uint8_t>(b);
        }
      }
    }
    // Horizontal seams (between ty and ty+1)
    for (uint32_t tyy = ty_min + 1; tyy <= ty_max; ++tyy) {
      const uint32_t abs_seam = tyy * tile_size;
      if (abs_seam <= ry || abs_seam >= (ry + rh)) continue;
      const uint32_t localT = (abs_seam - 1) - ry;
      const uint32_t localB = abs_seam - ry;
      if (localT >= rh || localB >= rh) continue;
      for (uint32_t xx = 0; xx < rw; ++xx) {
        uint8_t* pT = out_pixels + ((localT * rw + xx) * 4u);
        uint8_t* pB = out_pixels + ((localB * rw + xx) * 4u);
        for (int c = 0; c < 4; ++c) {
          int t = pT[c];
          int b = pB[c];
          int blended = (t * 179 + b * 77 + 128) >> 8;
          pT[c] = static_cast<uint8_t>(blended);
          pB[c] = static_cast<uint8_t>(blended);
        }
      }
    }
  }

  return MakeBufferFromOwned(out_pixels, out_size, rw, rh, 8, 1);
}

// Encode a multi-frame JXL animation.
// frames points to a WasmAnimationFrame[] array; returns JxlWasmBuffer with encoded bitstream.
static JxlWasmBuffer* EncodeAnimation(
    const WasmAnimationFrame* frames, uint32_t num_frames,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    const WasmBoxOpts* box_opts,
    const WasmAnimationOpts* anim_opts) {
  if (frames == nullptr || num_frames == 0) return MakeError(200);

  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return MakeError(201);
  JXL_SETUP_ENC_RUNNER(enc, MakeError(57));
  if (ApplyContainerMode(enc, box_opts) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(202);
  }

  const uint32_t bits     = FormatToBits(fmt);
  const uint32_t exp_bits = FormatToExponentBits(fmt);
  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize                    = frames[0].width;
  info.ysize                    = frames[0].height;
  info.bits_per_sample          = bits;
  info.exponent_bits_per_sample = exp_bits;
  info.num_color_channels       = 3;
  info.num_extra_channels       = has_alpha ? 1u : 0u;
  info.alpha_bits               = has_alpha ? bits : 0u;
  info.alpha_exponent_bits      = has_alpha ? exp_bits : 0u;

  info.have_animation            = JXL_TRUE;
  info.animation.tps_numerator   = anim_opts ? anim_opts->ticks_per_second : 1000u;
  info.animation.tps_denominator = 1u;
  info.animation.num_loops       = anim_opts ? anim_opts->loop_count : 0u;
  info.animation.have_timecodes  = JXL_FALSE;

  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(203);
  }

  if (icc_profile != nullptr && icc_size > 0) {
    if (JxlEncoderSetICCProfile(enc, icc_profile, icc_size) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(204);
    }
  } else {
    JxlColorEncoding color;
    JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
    if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(205);
    }
  }

  JxlEncoderFrameSettings* frame_settings = JxlEncoderFrameSettingsCreate(enc, nullptr);
  JxlEncoderSetFrameDistance(frame_settings, distance);
  JxlEncoderFrameSettingsSetOption(frame_settings, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(effort));
  if (modular >= 0)         JxlEncoderFrameSettingsSetOption(frame_settings, JXL_ENC_FRAME_SETTING_MODULAR,        static_cast<int64_t>(modular));
  if (brotli_effort >= 0)   JxlEncoderFrameSettingsSetOption(frame_settings, JXL_ENC_FRAME_SETTING_BROTLI_EFFORT,  static_cast<int64_t>(brotli_effort));
  if (decoding_speed >= 0)  JxlEncoderFrameSettingsSetOption(frame_settings, JXL_ENC_FRAME_SETTING_DECODING_SPEED, static_cast<int64_t>(std::clamp(decoding_speed, 0, 4)));
  if (photon_noise_iso > 0) JxlEncoderFrameSettingsSetOption(frame_settings, JXL_ENC_FRAME_SETTING_PHOTON_NOISE,   static_cast<int64_t>(photon_noise_iso));
  const uint32_t norm_resamp = NormalizeResampling(resampling);
  if (norm_resamp > 1u)      JxlEncoderFrameSettingsSetOption(frame_settings, JXL_ENC_FRAME_SETTING_RESAMPLING,    static_cast<int64_t>(norm_resamp));

  const size_t bytes_per_channel = (fmt == 2u) ? 4u : (fmt == 1u) ? 2u : 1u;
  JxlPixelFormat pf = {has_alpha ? 4u : 3u, FormatToDataType(fmt), JXL_NATIVE_ENDIAN, 0};

  for (uint32_t fi = 0; fi < num_frames; ++fi) {
    const WasmAnimationFrame& wf = frames[fi];
    if (wf.pixels_ptr == 0 || wf.pixels_size == 0) { JxlEncoderDestroy(enc); return MakeError(206); }
    const uint8_t* pixels = reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(wf.pixels_ptr));

    JxlEncoderFrameSettings* fs = JxlEncoderFrameSettingsCreate(enc, frame_settings);
    {
      JxlFrameHeader fh;
      JxlEncoderInitFrameHeader(&fh);
      fh.duration = wf.duration;
      // CasaSneyers_Parity (Ch3/Ch9.3.2): per-frame blend mode (Replace/Add/Blend/MulAdd/Mul).
      // blend_mode field added at offset 28 of WasmAnimationFrame in this build.
      // Clamp to valid JxlBlendMode range (0-4); 0 = JXL_BLEND_REPLACE (default/safe).
      const uint32_t bm = std::min(wf.blend_mode, static_cast<uint32_t>(4));
      fh.layer_info.blend_info.blendmode = static_cast<JxlBlendMode>(bm);
      fh.layer_info.blend_info.source    = 0;
      fh.layer_info.blend_info.alpha     = 0;
      fh.layer_info.blend_info.clamp     = JXL_FALSE;
      if (JxlEncoderSetFrameHeader(fs, &fh) != JXL_ENC_SUCCESS) {
        JxlEncoderDestroy(enc); return MakeError(207);
      }
    }
    if (wf.name_ptr != 0 && wf.name_size > 0) {
      const char* name = reinterpret_cast<const char*>(static_cast<uintptr_t>(wf.name_ptr));
      std::vector<char> name_buf(wf.name_size + 1, '\0');
      memcpy(name_buf.data(), name, wf.name_size);
      if (JxlEncoderSetFrameName(fs, name_buf.data()) != JXL_ENC_SUCCESS) {
        JxlEncoderDestroy(enc); return MakeError(208);
      }
    }

    uint8_t* rgb_pixels = nullptr;
    const uint8_t* encode_src = pixels;
    size_t pixel_size;
    if (!has_alpha) {
      const size_t n_pixels   = static_cast<size_t>(wf.width) * wf.height;
      const size_t src_stride = 4u * bytes_per_channel;
      const size_t dst_stride = 3u * bytes_per_channel;
      pixel_size = n_pixels * dst_stride;
      rgb_pixels = static_cast<uint8_t*>(malloc(pixel_size));
      if (rgb_pixels == nullptr) { JxlEncoderDestroy(enc); return MakeError(209); }
      for (size_t i = 0; i < n_pixels; ++i)
        memcpy(rgb_pixels + i * dst_stride, pixels + i * src_stride, dst_stride);
      encode_src = rgb_pixels;
    } else {
      pixel_size = static_cast<size_t>(wf.width) * wf.height * 4u * bytes_per_channel;
    }

    const JxlEncoderStatus add_status = JxlEncoderAddImageFrame(fs, &pf, encode_src, pixel_size);
    free(rgb_pixels);
    if (add_status != JXL_ENC_SUCCESS) { JxlEncoderDestroy(enc); return MakeError(210); }
  }

  const JxlBool compress_flag = (box_opts && box_opts->compress_boxes) ? JXL_TRUE : JXL_FALSE;
  if (exif != nullptr && exif_size > 0) {
    if (JxlEncoderAddBox(enc, "Exif", exif, exif_size, compress_flag) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(211);
    }
  }
  if (xmp != nullptr && xmp_size > 0) {
    if (JxlEncoderAddBox(enc, "xml ", xmp, xmp_size, compress_flag) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(212);
    }
  }
  if (AddCustomBoxes(enc, box_opts) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(213);
  }
  JxlEncoderCloseInput(enc);

  const size_t initial_size = 65536u;
  uint8_t* outbuf = static_cast<uint8_t*>(malloc(initial_size));
  if (outbuf == nullptr) { JxlEncoderDestroy(enc); return MakeError(214); }
  size_t outbuf_cap = initial_size;
  uint8_t* next_out = outbuf;
  size_t avail_out = outbuf_cap;
  for (;;) {
    JxlEncoderStatus status = JxlEncoderProcessOutput(enc, &next_out, &avail_out);
    if (status == JXL_ENC_SUCCESS) {
      const size_t final_size = static_cast<size_t>(next_out - outbuf);
      JxlEncoderDestroy(enc);
      JxlWasmBuffer* result = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
      if (result == nullptr) { free(outbuf); return MakeError(215); }
      result->data           = outbuf;
      result->size           = final_size;
      result->width          = frames[0].width;
      result->height         = frames[0].height;
      result->bits_per_sample = bits;
      result->has_alpha      = has_alpha;
      return result;
    }
    if (status == JXL_ENC_NEED_MORE_OUTPUT) {
      const size_t offset = static_cast<size_t>(next_out - outbuf);
      if (outbuf_cap >= 128 * 1024 * 1024u) { JxlEncoderDestroy(enc); free(outbuf); return MakeError(216); }
      outbuf_cap *= 2;
      uint8_t* grown = static_cast<uint8_t*>(realloc(outbuf, outbuf_cap));
      if (grown == nullptr) { free(outbuf); JxlEncoderDestroy(enc); return MakeError(217); }
      outbuf = grown;
      next_out = outbuf + offset;
      avail_out = outbuf_cap - offset;
      continue;
    }
    free(outbuf); JxlEncoderDestroy(enc); return MakeError(218);
  }
}

extern "C" {

void jxl_wasm_bridge_anchor(void) {}

// Forward declaration for transcode used in encode_auto.
JxlWasmBuffer* jxl_wasm_transcode_jpeg_to_jxl(const uint8_t* jpeg, size_t jpeg_size);

// --- Stateful progressive decoder ---

static uint64_t HashProgressiveSample(const uint8_t* data, size_t size) {
  uint64_t h = 1469598103934665603ull;
  const size_t stride = 4096;
  for (size_t i = 0; i < size; i += stride) {
    h ^= data[i];
    h *= 1099511628211ull;
  }
  const size_t tail_start = size > 256 ? size - 256 : 0;
  for (size_t i = tail_start; i < size; ++i) {
    h ^= data[i];
    h *= 1099511628211ull;
  }
  return h ^ static_cast<uint64_t>(size);
}

static bool TryFlushProgressiveImage(JxlWasmDecState* s) {
  if (s == nullptr || s->dec == nullptr || !s->info_known || s->final_ready || s->pixels == nullptr) return false;
  if (s->pixels_size == 0) return false;

  // Don't swap libjxl's output buffer mid-decode. Prior implementation set the buffer to
  // s->flushed, called FlushImage, then restored to s->pixels — that buffer flip-flop
  // corrupted libjxl's internal write tracking, leaving the final FULL_IMAGE write
  // incomplete (most pixels untouched, surfacing as solid-red garbage to the consumer).
  //
  // libjxl writes partial decode INTO whatever buffer was set at NEED_IMAGE_OUT_BUFFER
  // (= s->pixels here, zeroed once on init so unfilled regions are transparent black).
  // FlushImage just commits any pending groups into that buffer. JS immediately copies a
  // borrowed snapshot from s->pixels before the next ProcessInput call. The main s->pixels
  // buffer keeps accumulating groups across subsequent FlushImage + ProcessInput calls,
  // with libjxl free to overwrite earlier-decoded pixels at higher quality per its contract.
  s->flush_attempts++;
  const double flush_t0 = emscripten_get_now();
  const JxlDecoderStatus flush_status = JxlDecoderFlushImage(s->dec);
  s->flush_image_ms += emscripten_get_now() - flush_t0;
  if (flush_status != JXL_DEC_SUCCESS) return false;

  // All-zero guard: skip after first successful flush — once real pixels have been emitted
  // the buffer cannot regress to all-zero. Avoids scanning 82+ MB per pass on every flush.
  if (s->flush_count == 0) {
    const uint64_t* w = reinterpret_cast<const uint64_t*>(s->pixels);
    const size_t nwords = s->pixels_size / sizeof(uint64_t);
    bool any_nonzero = false;
    for (size_t i = 0; i < nwords; ++i) {
      if (w[i] != 0) { any_nonzero = true; break; }
    }
    if (!any_nonzero) {
      for (size_t i = nwords * sizeof(uint64_t); i < s->pixels_size; ++i) {
        if (s->pixels[i] != 0) { any_nonzero = true; break; }
      }
    }
    if (!any_nonzero) {
      s->flush_zero_skips++;
      return false;
    }
  }

  if (s->suppress_duplicate_progress) {
    const uint64_t h = HashProgressiveSample(s->pixels, s->pixels_size);
    if (s->last_progress_hash_valid &&
        s->last_progress_size == s->pixels_size &&
        s->last_progress_hash == h) {
      s->flush_duplicate_skips++;
      return false;
    }
    s->last_progress_hash = h;
    s->last_progress_size = s->pixels_size;
    s->last_progress_hash_valid = true;
  }

  s->flushed_size = s->pixels_size;
  s->flushed_ready = true;
  s->flush_successes++;
  s->flush_count++;
  return true;
}

static JxlWasmDecState* DecCreateInternal(uint32_t format, uint32_t progressive_detail, uint32_t flags) {
  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (dec == nullptr) return nullptr;
  JXL_SETUP_DEC_RUNNER(dec, nullptr);

  int events = JXL_DEC_BASIC_INFO | JXL_DEC_FRAME | JXL_DEC_FULL_IMAGE | JXL_DEC_BOX;
  if (progressive_detail != 0) events |= JXL_DEC_FRAME_PROGRESSION;
  if (JxlDecoderSubscribeEvents(dec, events) != JXL_DEC_SUCCESS) {
    JxlDecoderDestroy(dec); return nullptr;
  }
  if (progressive_detail != 0) {
    JxlProgressiveDetail detail = kDC;
    switch (progressive_detail) {
      case 1: detail = kDC; break;
      case 2: detail = kLastPasses; break;
      case 3: detail = kPasses; break;
      case 4: detail = kDCProgressive; break;
      default:
        JxlDecoderDestroy(dec); return nullptr;
    }
    if (JxlDecoderSetProgressiveDetail(dec, detail) != JXL_DEC_SUCCESS) {
      JxlDecoderDestroy(dec); return nullptr;
    }
  }

  // DEC_FLAG_ALLOW_ALPHA_PROGRESSIVE (bit 1): permit progressive pausing for
  // VarDCT frames with alpha/extra channels (libjxl disables it by default).
  // TODO: JxlDecoderSetAllowAlphaProgressive not available in current libjxl
  // if (flags & 2u) {
  //   JxlDecoderSetAllowAlphaProgressive(dec, JXL_TRUE);
  // }

  JxlWasmDecState* s = static_cast<JxlWasmDecState*>(calloc(1, sizeof(JxlWasmDecState)));
  if (s == nullptr) { JxlDecoderDestroy(dec); return nullptr; }
  s->dec = dec;
  s->pixel_format = { 4, FormatToDataType(format), JXL_NATIVE_ENDIAN, 0 };
  s->suppress_duplicate_progress = (flags & 1u) != 0;
  return s;
}

JxlWasmDecState* jxl_wasm_dec_create(uint32_t format, uint32_t progressive_detail) {
  return DecCreateInternal(format, progressive_detail, 0);
}

JxlWasmDecState* jxl_wasm_dec_create_x(uint32_t format, uint32_t progressive_detail, uint32_t flags) {
  return DecCreateInternal(format, progressive_detail, flags);
}

// Sets the progressive AC paint target on a live decoder.
// TODO: JxlDecoderSetProgressivePaintTarget not available in current libjxl.
// Would need API mapping to JxlDecoderSetProgressiveDetail with proper enum conversion.
void jxl_wasm_dec_set_paint_target(JxlWasmDecState* s, uint32_t paints) {
  if (s != nullptr && s->dec != nullptr) {
    // JxlDecoderSetProgressivePaintTarget(s->dec, paints);
    // Placeholder: feature unavailable in current libjxl version
  }
}

// Enable C++-side ROI crop + nearest downsample on every subsequent take_flushed/take_final.
// Coords are full-res (pre-downsample); pass the original region (lower-clamped to >=0/>=1 by
// the caller) plus the resolved downsample factor. For a downsample-only decode (no ROI), pass
// the full frame as the region. Call once after the header is known, before the first take.
void jxl_wasm_dec_set_region(JxlWasmDecState* s, uint32_t x, uint32_t y, uint32_t w, uint32_t h, uint32_t downsample) {
  if (s == nullptr) return;
  s->roi_x = x;
  s->roi_y = y;
  s->roi_w = w;
  s->roi_h = h;
  s->roi_downsample = (downsample >= 1u) ? downsample : 1u;
  s->roi_active = true;
}

int jxl_wasm_dec_push(JxlWasmDecState* s, const uint8_t* data, size_t size) {
  if (s == nullptr || s->error_code != 0) return JXL_DEC_RESULT_ERROR;
  if (data != nullptr && size > 0) {
    size_t remaining = 0;
    if (s->input_set) {
      remaining = JxlDecoderReleaseInput(s->dec);
      if (remaining > s->input_size) remaining = 0;
      if (remaining > 0) {
        memmove(s->input_buf, s->input_buf + (s->input_size - remaining), remaining);
      }
      s->input_size = remaining;
      s->input_set = false;
    }

    const size_t needed = s->input_size + size;
    if (needed > s->input_capacity) {
      // Geometric growth eliminates O(n²) memcpy on every append (A1).
      // Track capacity separately; realloc only on overflow, then double.
      size_t new_cap = s->input_capacity ? s->input_capacity : 65536u;
      while (new_cap < needed) {
        size_t next = new_cap * 2;
        if (next <= new_cap) { next = needed; } // overflow guard
        new_cap = next;
      }
      uint8_t* grown = static_cast<uint8_t*>(realloc(s->input_buf, new_cap));
      if (grown == nullptr) { s->error_code = 15; return JXL_DEC_RESULT_ERROR; }
      s->input_buf = grown;
      s->input_capacity = new_cap;
    }
    memcpy(s->input_buf + s->input_size, data, size);
    s->input_size = needed;
    s->input_generation++;
    JxlDecoderSetInput(s->dec, s->input_buf, s->input_size);
    s->input_set = true;
  }

  JxlDecoderStatus status;
  while (true) {
    status = JxlDecoderProcessInput(s->dec);

    if (status == JXL_DEC_NEED_MORE_INPUT) {
      // DONOTCHANGE(progressive-checkpoints): Surface one snapshot per input
      // generation. libjxl may emit only one true FRAME_PROGRESSION event for
      // small/medium images; progressive UI needs this open-stream
      // opportunistic flush path. Removing it collapses Single Progressive back
      // to one non-final stage plus final.
      // Keep the generation gate so callers cannot drain the same snapshot forever.
      if (s->frame_started && !s->final_ready &&
          s->opportunistic_flush_generation != s->input_generation &&
          TryFlushProgressiveImage(s)) {
        s->opportunistic_flush_generation = s->input_generation;
        return JXL_DEC_RESULT_PROGRESS;
      }
      if (s->input_closed) {
        s->error_code = static_cast<int>(status);
        return JXL_DEC_RESULT_ERROR;
      }
      return JXL_DEC_RESULT_NEED_MORE;
    }
    if (status == JXL_DEC_SUCCESS) {
      s->final_ready = true;
      // Finalize gain map if a jhgm box was being read
      if (s->gm_reading && s->gm_buf != nullptr) {
        size_t remaining = JxlDecoderReleaseBoxBuffer(s->dec);
        s->gm_size = s->gm_capacity - remaining;
        s->gm_reading = false;
#if JXL_GAIN_MAP_SUPPORTED
        if (s->gm_size > 0) {
          JxlGainMapBundle bundle = {};
          size_t bytes_read = 0;
          if (JxlGainMapReadBundle(&bundle, s->gm_buf, s->gm_size, &bytes_read) == JXL_TRUE
              && bundle.gain_map != nullptr && bundle.gain_map_size > 0) {
            uint8_t* jxl = static_cast<uint8_t*>(malloc(bundle.gain_map_size));
            if (jxl != nullptr) {
              memcpy(jxl, bundle.gain_map, bundle.gain_map_size);
              s->gain_map_jxl      = jxl;
              s->gain_map_jxl_size = bundle.gain_map_size;
              s->gain_map_ready    = true;
            }
          }
        }
#endif
        free(s->gm_buf);
        s->gm_buf      = nullptr;
        s->gm_capacity = 0;
        s->gm_size     = 0;
      }
      return JXL_DEC_RESULT_DONE;
    }
    if (status == JXL_DEC_ERROR) { s->error_code = static_cast<int>(status); return JXL_DEC_RESULT_ERROR; }

    if (status == JXL_DEC_FRAME) {
      s->frame_started = true;
      JxlFrameHeader frame_header;
      memset(&frame_header, 0, sizeof(frame_header));
      if (JxlDecoderGetFrameHeader(s->dec, &frame_header) == JXL_DEC_SUCCESS) {
        s->frame_duration = frame_header.duration;
        s->is_last_frame  = frame_header.is_last ? 1u : 0u;
        s->frame_name[0]  = '\0';
        char name_buf[256];
        if (JxlDecoderGetFrameName(s->dec, name_buf, sizeof(name_buf)) == JXL_DEC_SUCCESS) {
          strncpy(s->frame_name, name_buf, sizeof(s->frame_name) - 1);
          s->frame_name[sizeof(s->frame_name) - 1] = '\0';
        }
      }
      continue;
    }
    if (status == JXL_DEC_BASIC_INFO) {
      if (JxlDecoderGetBasicInfo(s->dec, &s->info) == JXL_DEC_SUCCESS) {
        s->info_known = true;
        // Pre-allocate pixels buffer now that dimensions are known — avoids the first
        // malloc on NEED_IMAGE_OUT_BUFFER and lets realloc extend in-place later.
        const size_t bpc = (s->pixel_format.data_type == JXL_TYPE_FLOAT) ? 4u :
                           (s->pixel_format.data_type == JXL_TYPE_UINT16) ? 2u : 1u;
        const size_t expected = static_cast<size_t>(s->info.xsize) * s->info.ysize * 4u * bpc;
        if (expected > 0 && expected > s->pixels_size) {
          uint8_t* grown = static_cast<uint8_t*>(realloc(s->pixels, expected));
          if (grown != nullptr) { s->pixels = grown; s->pixels_size = expected; }
        }
        if (s->info.have_animation) {
          s->anim_ticks_per_second = s->info.animation.tps_denominator > 0
            ? (double)s->info.animation.tps_numerator / s->info.animation.tps_denominator
            : (double)s->info.animation.tps_numerator;
          s->anim_loop_count       = s->info.animation.num_loops;
        }
      }
      continue;
    }
    if (status == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      size_t buf_size = 0;
      if (JxlDecoderImageOutBufferSize(s->dec, &s->pixel_format, &buf_size) != JXL_DEC_SUCCESS) {
        s->error_code = 11; return JXL_DEC_RESULT_ERROR;
      }
      // Grow-only: realloc can extend in-place (no content copy needed since libjxl
      // overwrites the entire buffer); falls back to relocate when in-place not possible.
      if (buf_size > s->pixels_size) {
        uint8_t* grown = static_cast<uint8_t*>(realloc(s->pixels, buf_size));
        if (grown == nullptr) { s->error_code = 14; return JXL_DEC_RESULT_ERROR; }
        s->pixels = grown;
        s->pixels_size = buf_size;
      }
      // Zero the buffer so opportunistic FlushImage snapshots show transparent black for
      // groups libjxl hasn't decoded yet (instead of uninitialized realloc garbage that
      // surfaces as solid red — R-byte garbage with alpha-byte garbage at 255 — in the
      // consumer canvas).
      memset(s->pixels, 0, s->pixels_size);
      if (JxlDecoderSetImageOutBuffer(s->dec, &s->pixel_format, s->pixels, s->pixels_size) != JXL_DEC_SUCCESS) {
        s->error_code = 12; return JXL_DEC_RESULT_ERROR;
      }
      continue;
    }
    if (status == JXL_DEC_FRAME_PROGRESSION) {
      if (TryFlushProgressiveImage(s)) return JXL_DEC_RESULT_PROGRESS;
      continue;
    }
    if (status == JXL_DEC_FULL_IMAGE) {
      s->final_ready = true;
      s->frame_index++;
      continue;
    }
    if (status == JXL_DEC_BOX) {
      // Finalize any previously-read jhgm box
      if (s->gm_reading && s->gm_buf != nullptr) {
        size_t remaining = JxlDecoderReleaseBoxBuffer(s->dec);
        s->gm_size = s->gm_capacity - remaining;
        s->gm_reading = false;
#if JXL_GAIN_MAP_SUPPORTED
        if (s->gm_size > 0 && !s->gain_map_ready) {
          JxlGainMapBundle bundle = {};
          size_t bytes_read = 0;
          if (JxlGainMapReadBundle(&bundle, s->gm_buf, s->gm_size, &bytes_read) == JXL_TRUE
              && bundle.gain_map != nullptr && bundle.gain_map_size > 0) {
            uint8_t* jxl = static_cast<uint8_t*>(malloc(bundle.gain_map_size));
            if (jxl != nullptr) {
              memcpy(jxl, bundle.gain_map, bundle.gain_map_size);
              s->gain_map_jxl      = jxl;
              s->gain_map_jxl_size = bundle.gain_map_size;
              s->gain_map_ready    = true;
            }
          }
        }
#endif
        free(s->gm_buf);
        s->gm_buf      = nullptr;
        s->gm_capacity = 0;
        s->gm_size     = 0;
      }
      // Start reading a new jhgm box if not yet captured
      if (!s->gain_map_ready) {
        JxlBoxType box_type = {};
        if (JxlDecoderGetBoxType(s->dec, box_type, JXL_FALSE) == JXL_DEC_SUCCESS
            && memcmp(box_type, "jhgm", 4) == 0) {
          const size_t initial = 65536;
          uint8_t* buf = static_cast<uint8_t*>(malloc(initial));
          if (buf != nullptr) {
            s->gm_buf      = buf;
            s->gm_capacity = initial;
            s->gm_size     = 0;
            s->gm_reading  = true;
            JxlDecoderSetBoxBuffer(s->dec, s->gm_buf, s->gm_capacity);
          }
        }
      }
      continue;
    }
    if (status == JXL_DEC_BOX_NEED_MORE_OUTPUT) {
      if (!s->gm_reading || s->gm_buf == nullptr) { continue; }
      size_t remaining = JxlDecoderReleaseBoxBuffer(s->dec);
      const size_t written = s->gm_capacity - remaining;
      const size_t new_cap = s->gm_capacity * 2u;
      uint8_t* grown = static_cast<uint8_t*>(realloc(s->gm_buf, new_cap));
      if (grown == nullptr) {
        free(s->gm_buf);
        s->gm_buf = nullptr; s->gm_capacity = 0; s->gm_size = 0; s->gm_reading = false;
      } else {
        s->gm_buf      = grown;
        s->gm_capacity = new_cap;
        s->gm_size     = written;
        JxlDecoderSetBoxBuffer(s->dec, s->gm_buf + written, new_cap - written);
      }
      continue;
    }
  }
}

void jxl_wasm_dec_close_input(JxlWasmDecState* s) {
  if (s != nullptr && !s->input_closed) {
    JxlDecoderCloseInput(s->dec);
    s->input_closed = true;
  }
}

uint32_t jxl_wasm_dec_width(const JxlWasmDecState* s) {
  return (s != nullptr && s->info_known) ? s->info.xsize : 0;
}

uint32_t jxl_wasm_dec_height(const JxlWasmDecState* s) {
  return (s != nullptr && s->info_known) ? s->info.ysize : 0;
}

int jxl_wasm_dec_error(const JxlWasmDecState* s) {
  return s != nullptr ? s->error_code : -1;
}

uint32_t jxl_wasm_dec_flush_attempts(const JxlWasmDecState* s) {
  return s != nullptr ? s->flush_attempts : 0u;
}

uint32_t jxl_wasm_dec_flush_successes(const JxlWasmDecState* s) {
  return s != nullptr ? s->flush_successes : 0u;
}

uint32_t jxl_wasm_dec_flush_zero_skips(const JxlWasmDecState* s) {
  return s != nullptr ? s->flush_zero_skips : 0u;
}

uint32_t jxl_wasm_dec_flush_duplicate_skips(const JxlWasmDecState* s) {
  return s != nullptr ? s->flush_duplicate_skips : 0u;
}

double jxl_wasm_dec_flush_image_ms(const JxlWasmDecState* s) {
  return s != nullptr ? s->flush_image_ms : 0.0;
}

// Crop + nearest-downsample the full-frame s->pixels into s->roi_buf, byte-exact with the JS
// applyRegionAndDownsample fallback (normalizeRegion upper-clamp, ceil output dims, nearest
// top-left pick — NOT libjxl box downsample, which the streaming progressive decode can't do).
// Returns a borrowed buffer at cropped dims (JS copies it synchronously), or nullptr on OOM /
// unusable state (the caller then treats this paint as having no frame).
static JxlWasmBuffer* TakeRoiCrop(JxlWasmDecState* s) {
  if (s->pixels == nullptr || !s->info_known) return nullptr;
  const uint32_t width  = s->info.xsize;
  const uint32_t height = s->info.ysize;
  if (width == 0u || height == 0u) return nullptr;
  const uint32_t bits = (s->pixel_format.data_type == JXL_TYPE_UINT16) ? 16u : (s->pixel_format.data_type == JXL_TYPE_FLOAT) ? 32u : 8u;
  const uint32_t bps  = (bits == 32u) ? 4u : (bits == 16u) ? 2u : 1u;
  const uint32_t stride = 4u * bps;
  const uint32_t ds = (s->roi_downsample >= 1u) ? s->roi_downsample : 1u;

  // normalizeRegion(region, width, height): upper-clamp to image bounds. Lower bounds were
  // already applied by the caller (x,y >= 0; w,h >= 1).
  uint32_t rx = (s->roi_x > width  - 1u) ? width  - 1u : s->roi_x;
  uint32_t ry = (s->roi_y > height - 1u) ? height - 1u : s->roi_y;
  const uint32_t maxW = width  - rx;
  const uint32_t maxH = height - ry;
  uint32_t rw = (s->roi_w < 1u) ? 1u : s->roi_w; if (rw > maxW) rw = maxW;
  uint32_t rh = (s->roi_h < 1u) ? 1u : s->roi_h; if (rh > maxH) rh = maxH;

  uint32_t outW = (rw + ds - 1u) / ds; if (outW < 1u) outW = 1u;
  uint32_t outH = (rh + ds - 1u) / ds; if (outH < 1u) outH = 1u;
  const size_t out_size = static_cast<size_t>(outW) * outH * stride;

  if (s->roi_buf == nullptr || out_size > s->roi_cap) {
    uint8_t* grown = static_cast<uint8_t*>(realloc(s->roi_buf, out_size));
    if (grown == nullptr) return nullptr;
    s->roi_buf = grown;
    s->roi_cap = out_size;
  }

  const uint8_t* base       = s->pixels;
  const size_t   srcRowStep = static_cast<size_t>(width) * stride * ds;
  const size_t   srcPxStep  = static_cast<size_t>(stride) * ds;
  const size_t   srcStart   = (static_cast<size_t>(ry) * width + rx) * stride;
  for (uint32_t oy = 0; oy < outH; ++oy) {
    const uint8_t* sp = base + srcStart + static_cast<size_t>(oy) * srcRowStep;
    uint8_t* dp = s->roi_buf + static_cast<size_t>(oy) * outW * stride;
    for (uint32_t ox = 0; ox < outW; ++ox) {
      memcpy(dp, sp, stride);
      sp += srcPxStep;
      dp += stride;
    }
  }
  return MakeBufferBorrowed(s->roi_buf, out_size, outW, outH, bits, 1);
}

// Progress returns a borrowed pixels handle; final transfers pixel ownership.
JxlWasmBuffer* jxl_wasm_dec_take_flushed(JxlWasmDecState* s) {
  if (s == nullptr || !s->flushed_ready || !s->info_known || s->pixels == nullptr) return nullptr;
  s->flushed_ready = false;
  s->flushed_size = 0;
  if (s->roi_active) return TakeRoiCrop(s);
  const uint32_t bits = (s->pixel_format.data_type == JXL_TYPE_UINT16) ? 16u : (s->pixel_format.data_type == JXL_TYPE_FLOAT) ? 32u : 8u;
  return MakeBufferBorrowed(s->pixels, s->pixels_size, s->info.xsize, s->info.ysize, bits, 1);
}

JxlWasmBuffer* jxl_wasm_dec_take_final(JxlWasmDecState* s) {
  if (s == nullptr || !s->final_ready || s->pixels == nullptr || !s->info_known) return nullptr;
  s->final_ready = false;
  // ROI path: return a borrowed crop; s->pixels stays owned by the state (freed in dec_free).
  if (s->roi_active) return TakeRoiCrop(s);
  const uint32_t bits = (s->pixel_format.data_type == JXL_TYPE_UINT16) ? 16u : (s->pixel_format.data_type == JXL_TYPE_FLOAT) ? 32u : 8u;
  JxlWasmBuffer* buf = MakeBufferFromOwned(s->pixels, s->pixels_size, s->info.xsize, s->info.ysize, bits, 1);
  s->pixels = nullptr;
  s->pixels_size = 0;
  return buf;
}

void jxl_wasm_dec_free(JxlWasmDecState* s) {
  if (s == nullptr) return;
  if (s->dec != nullptr) JxlDecoderDestroy(s->dec);
  free(s->pixels);       // no-op if ownership was transferred via dec_take_final
  free(s->flushed);      // no-op if ownership was transferred via dec_take_flushed
  free(s->roi_buf);      // grow-only ROI crop scratch (always state-owned, borrowed out)
  free(s->input_buf);
  free(s->gm_buf);       // no-op if box was fully consumed or never started
  free(s->gain_map_jxl); // no-op if ownership was transferred via dec_take_gain_map
  free(s);
}

JxlWasmBuffer* jxl_wasm_decode_rgba8(const uint8_t* input, size_t input_size, uint32_t downsample) {
  return DecodeRgba(input, input_size, downsample, 0);
}
JxlWasmBuffer* jxl_wasm_decode_rgba16(const uint8_t* input, size_t input_size, uint32_t downsample) {
  return DecodeRgba(input, input_size, downsample, 1);
}
JxlWasmBuffer* jxl_wasm_decode_rgbaf32(const uint8_t* input, size_t input_size, uint32_t downsample) {
  return DecodeRgba(input, input_size, downsample, 2);
}

JxlWasmBuffer* jxl_wasm_encode_rgba8(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order, uint32_t resampling) {
  return EncodeRgba(pixels, width, height, distance, effort, 0, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, -1, -1, -1, 0, resampling);
}
// P2a: streaming chunked RGB8 encode (3-channel input, w*h*3 bytes). Byte-identical to the
// whole-frame encoder; exercises the JxlEncoderAddChunkedFrame path (O(super-tile) encoder peak).
// distance <= 0 => lossless. This is the browser primitive P2b/P2c feed band-by-band.
JxlWasmBuffer* jxl_wasm_encode_rgb8_chunked(const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort) {
  return EncodeRgbChunked(pixels, width, height, distance, effort);
}
// P2c (Approach A): streaming RGB8 encode with NO input buffer — the encoder pulls each band from
// JS (globalThis.__jxlP2cPull, set by the orchestration) which feeds the RAW-pipeline wasm module.
// Byte-identical to the whole-frame / chunked encoders. distance <= 0 => lossless.
JxlWasmBuffer* jxl_wasm_encode_rgb8_stream(uint32_t width, uint32_t height, float distance, uint32_t effort) {
  return EncodeRgbStream(width, height, distance, effort);
}
JxlWasmBuffer* jxl_wasm_encode_rgba16(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order, uint32_t resampling) {
  return EncodeRgba(pixels, width, height, distance, effort, 1, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, -1, -1, -1, 0, resampling);
}

// Planar zero-copy/lower-copy encode hook for RGB16 (u16 planes).
// Takes separate R/G/B planes (contiguous, from planar demosaic or SoA tone), interleaves in C++ to temp buffer (fast),
// then encodes. Avoids Rust/JS side allocating/copying full interleaved buffer when upstream is planar.
// For basic (no exif/boxes/metadata extra); use _x variant for advanced if needed.
JxlWasmBuffer* jxl_wasm_encode_rgb16_planar(const uint16_t* r_plane, const uint16_t* g_plane, const uint16_t* b_plane,
    uint32_t width, uint32_t height, float distance, uint32_t effort,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order, uint32_t resampling) {
  if (!r_plane || !g_plane || !b_plane || width == 0 || height == 0) return MakeError(99);
  size_t npix = (size_t)width * height;
  // Interleave to packed RGBA16, not RGB16: EncodeRgba(fmt=1, has_alpha=0) runs StripAlphaToRgb,
  // which reads a 4-channel (8 B/px) stride. Feeding it a 3-channel (6 B/px) buffer mis-reads
  // every pixel and over-reads the tail. So build a 4-channel buffer with opaque alpha; the
  // strip drops alpha and libjxl encodes a clean 3-channel RGB16 frame (no alpha plane in output).
  // (A future fmt==4 "rgb16 passthrough" mode in EncodeRgba would let us keep the 3-channel buffer
  // and skip the strip — deferred: it touches the shared encoder's channel math, needs a build to
  // validate. See docs/rejected optimizations.md.)
  size_t buf_bytes = npix * 8; // 4 * uint16 (RGBA; alpha stripped before encode)
  uint8_t* rgba_pixels = (uint8_t*)malloc(buf_bytes);
  if (!rgba_pixels) return MakeError(100);
  // Direct native-endian u16 stores (wasm is LE = JXL_NATIVE_ENDIAN); rgba_pixels is malloc'd
  // (≥2-byte aligned) so the aliased u16 writes are well-defined.
  uint16_t* out16 = reinterpret_cast<uint16_t*>(rgba_pixels);
  for (size_t i = 0; i < npix; ++i) {
    out16[i * 4 + 0] = r_plane[i];
    out16[i * 4 + 1] = g_plane[i];
    out16[i * 4 + 2] = b_plane[i];
    out16[i * 4 + 3] = 0xFFFFu; // opaque; dropped by the has_alpha=0 strip in EncodeRgba
  }
  JxlWasmBuffer* res = EncodeRgba(rgba_pixels, width, height, distance, effort, 1 /*16bit*/, 0 /*no alpha*/, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, -1, -1, -1, 0, resampling);
  free(rgba_pixels);
  return res;
}
JxlWasmBuffer* jxl_wasm_encode_rgbaf32(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order, uint32_t resampling) {
  return EncodeRgba(pixels, width, height, distance, effort, 2, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, -1, -1, -1, 0, resampling);
}

JxlWasmBuffer* jxl_wasm_encode_rgba8_x(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling) {
  return EncodeRgba(pixels, width, height, distance, effort, 0, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, modular, brotli_effort, decoding_speed, photon_noise_iso, resampling);
}
JxlWasmBuffer* jxl_wasm_encode_rgba16_x(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling) {
  return EncodeRgba(pixels, width, height, distance, effort, 1, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, modular, brotli_effort, decoding_speed, photon_noise_iso, resampling);
}
JxlWasmBuffer* jxl_wasm_encode_rgbaf32_x(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling) {
  return EncodeRgba(pixels, width, height, distance, effort, 2, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, modular, brotli_effort, decoding_speed, photon_noise_iso, resampling);
}

// fmt: 0=rgba8, 1=rgba16, 2=rgbaf32.  Matches the TypeScript facade type.
// Previously this function had no fmt param and hardcoded 0, which also
// shifted every subsequent argument by one slot in the WASM call frame.
JxlWasmBuffer* jxl_wasm_encode_rgba8_with_metadata(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size, const uint8_t* exif, size_t exif_size, const uint8_t* xmp, size_t xmp_size) {
  return EncodeRgbaWithMetadata(pixels, width, height, distance, effort, fmt, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, -1, -1, -1, 0, resampling, icc_profile, icc_size, exif, exif_size, xmp, xmp_size);
}

JxlWasmBuffer* jxl_wasm_encode_rgba8_with_metadata_x(const uint8_t* pixels, uint32_t width, uint32_t height, float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size, const uint8_t* exif, size_t exif_size, const uint8_t* xmp, size_t xmp_size) {
  return EncodeRgbaWithMetadata(pixels, width, height, distance, effort, fmt, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, modular, brotli_effort, decoding_speed, photon_noise_iso, resampling, icc_profile, icc_size, exif, exif_size, xmp, xmp_size);
}

// Extra-channel encode: per-channel distance + optional separate plane buffers.
// ec_ptr: WASM heap address of WasmExtraChannel[num_ec] (0 when num_ec == 0).
// alpha_distance < 0 -> libjxl default for alpha; ignored when has_alpha == 0.
JxlWasmBuffer* jxl_wasm_encode_rgba8_with_metadata_ec(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed,
    int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    float alpha_distance,
    const WasmExtraChannel* ec_ptr, uint32_t num_ec,
    int32_t ec_resampling) {
  const WasmExtraChannel* ec = (ec_ptr != nullptr && num_ec > 0u) ? ec_ptr : nullptr;
  const uint32_t n_ec = (ec != nullptr) ? num_ec : 0u;
  return EncodeRgbaWithExtraChannels(pixels, width, height, distance, effort, fmt, has_alpha,
      progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order,
      modular, brotli_effort, decoding_speed, photon_noise_iso, resampling,
      icc_profile, icc_size, exif, exif_size, xmp, xmp_size,
      alpha_distance, ec, n_ec, nullptr, 1u, ec_resampling);
}

// --- Box-options v2 encode ---
// Extends _x / _ec with WasmBoxOpts for container control, box compression, and custom boxes.
// box_opts: WASM heap ptr to WasmBoxOpts (nullptr = default behaviour).

JxlWasmBuffer* jxl_wasm_encode_rgba8_with_metadata_v2(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    const WasmBoxOpts* box_opts) {
  return EncodeRgbaWithMetadata(pixels, width, height, distance, effort, fmt, has_alpha,
      progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order,
      modular, brotli_effort, decoding_speed, photon_noise_iso, resampling,
      icc_profile, icc_size, exif, exif_size, xmp, xmp_size, box_opts);
}

// v3: v2 + EXIF orientation (1..8). Pixels stay sensor-native; rotation lives in JXL basic info.
JxlWasmBuffer* jxl_wasm_encode_rgba8_with_metadata_v3(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    const WasmBoxOpts* box_opts,
    uint32_t orientation) {
  return EncodeRgbaWithMetadata(pixels, width, height, distance, effort, fmt, has_alpha,
      progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order,
      modular, brotli_effort, decoding_speed, photon_noise_iso, resampling,
      icc_profile, icc_size, exif, exif_size, xmp, xmp_size, box_opts,
      -1, -1, -1, -1, orientation);
}

JxlWasmBuffer* jxl_wasm_encode_rgba8_with_metadata_ec_v2(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed,
    int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    float alpha_distance,
    const WasmExtraChannel* ec_ptr, uint32_t num_ec,
    const WasmBoxOpts* box_opts,
    int32_t ec_resampling) {
  const WasmExtraChannel* ec = (ec_ptr != nullptr && num_ec > 0u) ? ec_ptr : nullptr;
  const uint32_t n_ec = (ec != nullptr) ? num_ec : 0u;
  return EncodeRgbaWithExtraChannels(pixels, width, height, distance, effort, fmt, has_alpha,
      progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order,
      modular, brotli_effort, decoding_speed, photon_noise_iso, resampling,
      icc_profile, icc_size, exif, exif_size, xmp, xmp_size,
      alpha_distance, ec, n_ec, box_opts, 1u, ec_resampling);
}

// Gain map encode: same as _with_metadata_x but attaches a jhgm box (JXL gain map).
// gain_map_jxl: pre-encoded JXL codestream (the gain map image); 0 → no box added.
// When JXL_GAIN_MAP_SUPPORTED is 0 (old libjxl), encodes normally without the box.
JxlWasmBuffer* jxl_wasm_encode_with_gain_map(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    const uint8_t* icc_profile, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    const uint8_t* gain_map_jxl, size_t gain_map_jxl_size) {
  return EncodeRgbaWithGainMap(pixels, width, height, distance, effort, fmt, has_alpha,
      progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order,
      modular, brotli_effort, decoding_speed, photon_noise_iso, resampling,
      icc_profile, icc_size, exif, exif_size, xmp, xmp_size,
      gain_map_jxl, gain_map_jxl_size);
}

JxlWasmBuffer* jxl_wasm_encode_animation(
    uint32_t frames_ptr, uint32_t num_frames,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    uint32_t icc_ptr, uint32_t icc_size,
    uint32_t exif_ptr, uint32_t exif_size,
    uint32_t xmp_ptr, uint32_t xmp_size,
    uint32_t box_opts_ptr,
    uint32_t anim_opts_ptr) {
  const WasmAnimationFrame* frames = reinterpret_cast<const WasmAnimationFrame*>(static_cast<uintptr_t>(frames_ptr));
  const uint8_t* icc  = icc_ptr  ? reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(icc_ptr))  : nullptr;
  const uint8_t* exif = exif_ptr ? reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(exif_ptr)) : nullptr;
  const uint8_t* xmp  = xmp_ptr  ? reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(xmp_ptr))  : nullptr;
  const WasmBoxOpts*       box_opts  = box_opts_ptr  ? reinterpret_cast<const WasmBoxOpts*>      (static_cast<uintptr_t>(box_opts_ptr))  : nullptr;
  const WasmAnimationOpts* anim_opts = anim_opts_ptr ? reinterpret_cast<const WasmAnimationOpts*>(static_cast<uintptr_t>(anim_opts_ptr)) : nullptr;
  return EncodeAnimation(frames, num_frames, distance, effort, fmt, has_alpha,
      modular, brotli_effort, decoding_speed, photon_noise_iso, resampling,
      icc, icc_size, exif, exif_size, xmp, xmp_size,
      box_opts, anim_opts);
}

uint32_t jxl_wasm_dec_has_gain_map(const JxlWasmDecState* s) {
  return (s != nullptr && s->gain_map_ready) ? 1u : 0u;
}

// Ownership-transfer: returns a JxlWasmBuffer whose data/size fields hold the raw
// jhgm codestream bytes. Caller must free via jxl_wasm_buffer_free. Returns null
// when no gain map was decoded.
JxlWasmBuffer* jxl_wasm_dec_take_gain_map(JxlWasmDecState* s) {
  if (s == nullptr || !s->gain_map_ready || s->gain_map_jxl == nullptr) return nullptr;
  s->gain_map_ready = false;
  JxlWasmBuffer* buf = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
  if (buf == nullptr) {
    free(s->gain_map_jxl);
    s->gain_map_jxl      = nullptr;
    s->gain_map_jxl_size = 0;
    return nullptr;
  }
  buf->data = s->gain_map_jxl;
  buf->size = s->gain_map_jxl_size;
  s->gain_map_jxl      = nullptr;
  s->gain_map_jxl_size = 0;
  return buf;
}

uint32_t jxl_wasm_dec_frame_index(uint32_t state_ptr) {
  const JxlWasmDecState* s = reinterpret_cast<const JxlWasmDecState*>(static_cast<uintptr_t>(state_ptr));
  // frame_index is incremented on JXL_DEC_FULL_IMAGE (post-completion); subtract 1 for zero-based result.
  return s && s->frame_index > 0u ? s->frame_index - 1u : 0u;
}

uint32_t jxl_wasm_dec_frame_duration(uint32_t state_ptr) {
  const JxlWasmDecState* s = reinterpret_cast<const JxlWasmDecState*>(static_cast<uintptr_t>(state_ptr));
  return s ? s->frame_duration : 0u;
}

uint32_t jxl_wasm_dec_frame_name_ptr(uint32_t state_ptr) {
  const JxlWasmDecState* s = reinterpret_cast<const JxlWasmDecState*>(static_cast<uintptr_t>(state_ptr));
  if (s == nullptr || s->frame_name[0] == '\0') return 0u;
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(s->frame_name));
}

uint32_t jxl_wasm_dec_is_last_frame(uint32_t state_ptr) {
  const JxlWasmDecState* s = reinterpret_cast<const JxlWasmDecState*>(static_cast<uintptr_t>(state_ptr));
  return s ? s->is_last_frame : 0u;
}

double jxl_wasm_dec_anim_ticks_per_second(uint32_t state_ptr) {
  const JxlWasmDecState* s = reinterpret_cast<const JxlWasmDecState*>(static_cast<uintptr_t>(state_ptr));
  return s ? s->anim_ticks_per_second : 1000.0;
}

uint32_t jxl_wasm_dec_anim_loop_count(uint32_t state_ptr) {
  const JxlWasmDecState* s = reinterpret_cast<const JxlWasmDecState*>(static_cast<uintptr_t>(state_ptr));
  return s ? s->anim_loop_count : 0u;
}

// Forward-only seek: skip frames to reach target_frame (zero-based, as exposed by jxl_wasm_dec_frame_index).
// Returns 0 on success, -1 if target is at or before the current position (cannot seek backward).
int32_t jxl_wasm_dec_seek_to_frame(uint32_t state_ptr, uint32_t target_frame) {
  JxlWasmDecState* s = reinterpret_cast<JxlWasmDecState*>(static_cast<uintptr_t>(state_ptr));
  if (s == nullptr) return -1;
  // s->frame_index is post-increment (count of fully decoded frames); target_frame is zero-based.
  // target_frame < s->frame_index means we are already past it; == means it is the next to decode.
  if (target_frame < s->frame_index) return -1;
  uint32_t skip = target_frame - s->frame_index;
  JxlDecoderSkipFrames(s->dec, static_cast<size_t>(skip));
  return 0;
}

// Routes JPEG bytes to lossless transcode; otherwise encodes as RGBA pixels.
// For JPEG input, width/height/fmt/has_alpha are ignored.
JxlWasmBuffer* jxl_wasm_encode_auto(
    const uint8_t* data, size_t data_size,
    uint32_t width, uint32_t height,
    float distance, uint32_t effort,
    uint32_t fmt, uint32_t has_alpha) {
  if (data == nullptr || data_size == 0) return MakeError(50);
  if (LooksLikeJpeg(data, data_size)) {
    return jxl_wasm_transcode_jpeg_to_jxl(data, data_size);
  }
  return EncodeRgba(data, width, height, distance, effort, fmt, has_alpha, 0, 0, 0, 0, 0);
}

JxlWasmBuffer* jxl_wasm_encode_auto_x(
    const uint8_t* data, size_t data_size,
    uint32_t width, uint32_t height,
    float distance, uint32_t effort,
    uint32_t fmt, uint32_t has_alpha,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling) {
  if (data == nullptr || data_size == 0) return MakeError(50);
  if (LooksLikeJpeg(data, data_size)) {
    return jxl_wasm_transcode_jpeg_to_jxl(data, data_size);
  }
  return EncodeRgba(data, width, height, distance, effort, fmt, has_alpha, 0, 0, 0, 0, 0, modular, brotli_effort, decoding_speed, photon_noise_iso, resampling);
}

// Encode full image + N sidecar thumbnails in one call.
// Returns a `->next` linked list: sidecars smallest-first, full image last.
// sidecar_max_dims must be sorted ascending by the caller (JS does this).
// Caller walks and frees each node individually via jxl_wasm_buffer_free.
//
// Cascade: each thumbnail is derived from the next-larger thumbnail rather than
// the full image, so total downscale work scales with the number of output pixels
// rather than (num_sidecars × full-image pixels).
static JxlWasmBuffer* EncodeRgba8WithSidecars(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t has_alpha,
    const uint32_t* sidecar_max_dims, uint32_t num_sidecars,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling) {
  if (pixels == nullptr || width == 0 || height == 0) return MakeError(20);

  // Pass 1: collect valid (tw, th) pairs in ascending order.
  struct SidecarDim { uint32_t tw, th; };
  const uint32_t MAX_SC = 16u;
  SidecarDim sc_dims[MAX_SC];
  uint32_t sc_count = 0;

  for (uint32_t i = 0; i < num_sidecars && sc_count < MAX_SC; ++i) {
    const uint32_t max_dim = (sidecar_max_dims != nullptr) ? sidecar_max_dims[i] : 0u;
    const uint32_t longer  = (width >= height) ? width : height;
    if (max_dim == 0 || max_dim >= longer) continue;
    uint32_t tw, th;
    if (width >= height) {
      tw = max_dim;
      th = std::max(1u, (max_dim * height + width / 2u) / width);
    } else {
      th = max_dim;
      tw = std::max(1u, (max_dim * width + height / 2u) / height);
    }
    sc_dims[sc_count++] = { tw, th };
  }

  // Pass 2: cascade descending (largest first), prepend to chain.
  // Descending iteration + prepend = ascending output chain (smallest first).
  // Each thumbnail downscaled from previous (larger) thumbnail, not from full image.
  // If a malloc fails the cascade falls back to the nearest available larger source.
  JxlWasmBuffer* sc_chain    = nullptr;
  const uint8_t* cascade_src = pixels;
  uint32_t       cascade_sw  = width;
  uint32_t       cascade_sh  = height;
  uint8_t*       cascade_owned = nullptr;  // non-null when cascade_src is malloc'd

  for (int32_t i = static_cast<int32_t>(sc_count) - 1; i >= 0; --i) {
    const uint32_t tw = sc_dims[i].tw;
    const uint32_t th = sc_dims[i].th;

    uint8_t* thumb = static_cast<uint8_t*>(malloc(static_cast<size_t>(tw) * th * 4u));
    if (thumb == nullptr) continue;  // skip level; cascade_src unchanged for smaller levels

    BoxDownscaleRgba8(cascade_src, cascade_sw, cascade_sh, thumb, tw, th);

    // Previous cascade source no longer needed — free it before taking the new one.
    free(cascade_owned);
    cascade_owned = thumb;
    cascade_src   = thumb;
    cascade_sw    = tw;
    cascade_sh    = th;

    // Thumbnails tolerate more loss; cap effort at 5 to keep encode fast.
    JxlWasmBuffer* sidecar = EncodeRgba(thumb, tw, th,
        std::max(distance, 1.5f), std::min(effort, 5u), 0, 1u, 0, 0, 0, 0, 0,
        modular, brotli_effort, decoding_speed, photon_noise_iso);
    if (sidecar == nullptr || sidecar->error != 0) continue;  // aux sidecar tier failed (OOM or encode err); skip, do not link, do not fail container encode. Cascade already safe (no wild next ptrs).

    // Prepend: descending iteration + prepend = ascending chain.
    sidecar->next = sc_chain;
    sc_chain = sidecar;
  }
  free(cascade_owned);

  JxlWasmBuffer* full = EncodeRgba(pixels, width, height, distance, effort, 0, has_alpha, 0, 0, 0, 0, 0,
      modular, brotli_effort, decoding_speed, photon_noise_iso, resampling);
  if (full == nullptr || full->error != 0) {
    JxlWasmBuffer* cur = sc_chain;
    while (cur != nullptr) { JxlWasmBuffer* nxt = cur->next; FreeBufferNoChain(cur); cur = nxt; }
    if (full) FreeBufferNoChain(full);
    return MakeError(full && full->error ? full->error : 28);
  }
  if (sc_chain == nullptr) return full;

  // Walk sidecar chain to tail and append full image.
  JxlWasmBuffer* tail = sc_chain;
  while (tail->next != nullptr) tail = tail->next;
  tail->next = full;
  return sc_chain;
}

JxlWasmBuffer* jxl_wasm_encode_rgba8_with_sidecars(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t has_alpha,
    const uint32_t* sidecar_max_dims, uint32_t num_sidecars, uint32_t resampling) {
  return EncodeRgba8WithSidecars(pixels, width, height, distance, effort, has_alpha, sidecar_max_dims, num_sidecars, -1, -1, -1, 0, resampling);
}

JxlWasmBuffer* jxl_wasm_encode_rgba8_with_sidecars_x(
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t has_alpha,
    const uint32_t* sidecar_max_dims, uint32_t num_sidecars,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling) {
  return EncodeRgba8WithSidecars(pixels, width, height, distance, effort, has_alpha, sidecar_max_dims, num_sidecars, modular, brotli_effort, decoding_speed, photon_noise_iso, resampling);
}

uint8_t* jxl_wasm_buffer_data(JxlWasmBuffer* buffer) {
  return buffer == nullptr ? nullptr : buffer->data;
}

size_t jxl_wasm_buffer_size(JxlWasmBuffer* buffer) {
  return buffer == nullptr ? 0 : buffer->size;
}

uint32_t jxl_wasm_buffer_width(JxlWasmBuffer* buffer) {
  return buffer == nullptr ? 0 : buffer->width;
}

uint32_t jxl_wasm_buffer_height(JxlWasmBuffer* buffer) {
  return buffer == nullptr ? 0 : buffer->height;
}

uint32_t jxl_wasm_buffer_bits_per_sample(JxlWasmBuffer* buffer) {
  return buffer == nullptr ? 0 : buffer->bits_per_sample;
}

uint32_t jxl_wasm_buffer_has_alpha(JxlWasmBuffer* buffer) {
  return buffer == nullptr ? 0 : buffer->has_alpha;
}

int jxl_wasm_buffer_error(JxlWasmBuffer* buffer) {
  return buffer == nullptr ? -1 : buffer->error;
}

// Returns the `next` sidecar pointer for chain traversal (0 = last node).
JxlWasmBuffer* jxl_wasm_buffer_next(JxlWasmBuffer* buffer) {
  return (buffer == nullptr) ? nullptr : buffer->next;
}

// A6: runtime word-size query for TS load assert (defensive; static_assert above is primary).
uint32_t jxl_wasm_pointer_size(void) {
  return sizeof(void*);
}

void jxl_wasm_buffer_free(JxlWasmBuffer* buffer) {
  if (buffer == nullptr) return;
  // Inline data (MakeBuffer): lives in the same allocation — free once.
  // External data (MakeBufferFromOwned / encoder no-copy): separate allocation — free both.
  // Does NOT recurse through ->next; caller walks and frees the sidecar chain individually.
  if (buffer->owned_data && buffer->data != nullptr && buffer->data != reinterpret_cast<uint8_t*>(buffer + 1)) {
    free(buffer->data);
  }
  free(buffer);
}

// --- #10: Region decode exports ---

JxlWasmBuffer* jxl_wasm_decode_rgba8_region(const uint8_t* input, size_t input_size,
    uint32_t cx, uint32_t cy, uint32_t cw, uint32_t ch, uint32_t downsample) {
  return DecodeRgbaRegion(input, input_size, cx, cy, cw, ch, downsample, 0);
}
JxlWasmBuffer* jxl_wasm_decode_rgba16_region(const uint8_t* input, size_t input_size,
    uint32_t cx, uint32_t cy, uint32_t cw, uint32_t ch, uint32_t downsample) {
  return DecodeRgbaRegion(input, input_size, cx, cy, cw, ch, downsample, 1);
}
JxlWasmBuffer* jxl_wasm_decode_rgbaf32_region(const uint8_t* input, size_t input_size,
    uint32_t cx, uint32_t cy, uint32_t cw, uint32_t ch, uint32_t downsample) {
  return DecodeRgbaRegion(input, input_size, cx, cy, cw, ch, downsample, 2);
}

// --- #11: Streaming encoder ---

JxlWasmEncState* jxl_wasm_enc_create(void) {
  return static_cast<JxlWasmEncState*>(calloc(1, sizeof(JxlWasmEncState)));
}

int jxl_wasm_enc_push_pixels(JxlWasmEncState* s,
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order, uint32_t resampling) {
  if (s == nullptr) return -1;
  if (s->error_code != 0) return s->error_code;
  JxlWasmBuffer* buf = EncodeRgba(pixels, width, height, distance, effort, fmt, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, -1, -1, -1, 0, resampling);
  if (buf == nullptr) { s->error_code = 25; return s->error_code; }
  if (buf->error != 0) { int ec = buf->error; FreeBufferNoChain(buf); s->error_code = ec; return ec; }
  // EncodeRgba always uses a separate outbuf (not inline) — steal the pointer.
  s->outbuf      = buf->data;
  s->outbuf_size = buf->size;
  buf->data = nullptr;  // prevent FreeBufferNoChain double-free
  FreeBufferNoChain(buf);
  return 0;
}

int jxl_wasm_enc_push_pixels_x(JxlWasmEncState* s,
    const uint8_t* pixels, uint32_t width, uint32_t height,
    float distance, uint32_t effort, uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling) {
  if (s == nullptr) return -1;
  if (s->error_code != 0) return s->error_code;
  JxlWasmBuffer* buf = EncodeRgba(pixels, width, height, distance, effort, fmt, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, modular, brotli_effort, decoding_speed, photon_noise_iso, resampling);
  if (buf == nullptr) { s->error_code = 25; return s->error_code; }
  if (buf->error != 0) { int ec = buf->error; FreeBufferNoChain(buf); s->error_code = ec; return ec; }
  s->outbuf      = buf->data;
  s->outbuf_size = buf->size;
  buf->data = nullptr;
  FreeBufferNoChain(buf);
  return 0;
}

// Returns a JxlWasmBuffer* containing the next chunk of encoded output, or 0 when exhausted.
// 256 KB strikes a balance: 4× fewer FFI crossings than 64 KB without excessive peak JS heap.
JxlWasmBuffer* jxl_wasm_enc_take_chunk(JxlWasmEncState* s) {
  static const size_t CHUNK = 262144;
  if (s == nullptr || s->outbuf == nullptr || s->taken >= s->outbuf_size) return nullptr;
  const double tTake0 = emscripten_get_now();
  const size_t remaining = s->outbuf_size - s->taken;
  const size_t take = (remaining < CHUNK) ? remaining : CHUNK;
  // Layer 3: ByteIntervalCursor (from benchmark-core) on JS can drive aligned input chunks to enc_push_image; take here yields in CHUNK quanta for symmetric use in byte-cutoff encode tests. Positive for math unification. Support pc post JXL.
  // MakeBufferBorrowed: zero-copy handle into live outbuf (eliminates per-chunk C++ memcpy / performance-1).
  // JS takeBuffer + HEAPU8.slice materializes the owned copy for the yielded chunk.
  // outbuf must stay alive for all borrows; enc_free (after chunks() drain) does the free.
  JxlWasmBuffer* chunk = MakeBufferBorrowed(s->outbuf + s->taken, take, 0, 0, 8, 0);
  if (chunk != nullptr) {
    s->taken += take;
    // No early free / null here. Borrowed views into outbuf remain valid only while
    // the allocation lives; enc_free (post-drain in JS chunks() finally) releases it.
  }
  const double tTake1 = emscripten_get_now();
  if (take > 1024) EM_ASM({ console.log("[jxl-enc-bridge] take_chunk", $0, "bytes in", ($1).toFixed(2), "ms (zero-copy borrow)"); }, (int)take, tTake1 - tTake0);
  return chunk;
}

int jxl_wasm_enc_error(const JxlWasmEncState* s) {
  return s != nullptr ? s->error_code : -1;
}

// --- #16: Streaming input encoder ---

// Pre-allocate the full pixel buffer in WASM so JS never needs to accumulate pixels.
// Returns nullptr on invalid dimensions or malloc failure.
JxlWasmEncState* jxl_wasm_enc_create_image(
    uint32_t width, uint32_t height,
    float distance, uint32_t effort,
    uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order, uint32_t resampling) {
  if (width == 0 || height == 0) return nullptr;
  const size_t bpc        = (fmt == 2u) ? 4u : (fmt == 1u) ? 2u : 1u;
  const size_t channels   = (fmt == 3u) ? 3u : 4u;  // A3: rgb8 has no alpha plane
  const size_t pixel_size = static_cast<size_t>(width) * height * channels * bpc;

  JxlWasmEncState* s = static_cast<JxlWasmEncState*>(calloc(1, sizeof(JxlWasmEncState)));
  if (s == nullptr) return nullptr;
  s->pixels_buf = static_cast<uint8_t*>(malloc(pixel_size));
  if (s->pixels_buf == nullptr) { free(s); return nullptr; }

  s->pixels_size   = pixel_size;
  s->enc_width     = width;
  s->enc_height    = height;
  s->enc_distance  = distance;
  s->enc_effort    = effort;
  s->enc_fmt       = fmt;
  s->enc_has_alpha = has_alpha;
  s->enc_progressive_dc = progressive_dc;
  s->enc_progressive_ac = progressive_ac;
  s->enc_qprogressive_ac = qprogressive_ac;
  s->enc_buffering = buffering;
  s->enc_group_order = group_order;
  s->enc_modular = -1;
  s->enc_brotli_effort = -1;
  s->enc_decoding_speed = -1;
  s->enc_photon_noise_iso = 0;
  s->enc_resampling = NormalizeResampling(resampling);
  s->enc_ec_resampling = -1;
  s->enc_epf = -1;
  s->enc_gaborish = -1;
  s->enc_dots = -1;
  s->enc_color_transform = -1;
  s->enc_intrinsic_width = 0u;
  s->enc_intrinsic_height = 0u;
  s->enc_disable_perceptual = -1;
  s->enc_codestream_level = -1;
  s->enc_premultiply_alpha = -1;
  s->enc_orientation = 1u;
  return s;
}

JxlWasmEncState* jxl_wasm_enc_create_image_x(
    uint32_t width, uint32_t height,
    float distance, uint32_t effort,
    uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    int32_t jpeg_keep_exif, int32_t jpeg_keep_xmp, int32_t jpeg_keep_jumbf,
    int32_t already_downsampled, int32_t upsampling_mode, int32_t ec_resampling) {
  JxlWasmEncState* s = jxl_wasm_enc_create_image(width, height, distance, effort, fmt, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, resampling);
  if (s != nullptr) {
    (void)jpeg_keep_exif; (void)jpeg_keep_xmp; (void)jpeg_keep_jumbf; (void)already_downsampled; (void)upsampling_mode;
    s->enc_modular = modular;
    s->enc_brotli_effort = brotli_effort;
    s->enc_decoding_speed = decoding_speed;
    s->enc_photon_noise_iso = photon_noise_iso;
    s->enc_ec_resampling = NormalizeOptionalResampling(ec_resampling);
  }
  return s;
}

JxlWasmEncState* jxl_wasm_enc_create_image_y(
    uint32_t width, uint32_t height,
    float distance, uint32_t effort,
    uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    int32_t epf, int32_t gaborish, int32_t dots, int32_t patches, int32_t color_transform,
    int32_t center_x, int32_t center_y,
    int32_t jpeg_keep_exif, int32_t jpeg_keep_xmp, int32_t jpeg_keep_jumbf,
    int32_t already_downsampled, int32_t upsampling_mode, int32_t ec_resampling) {
  (void)patches; (void)center_x; (void)center_y;
  JxlWasmEncState* s = jxl_wasm_enc_create_image_x(width, height, distance, effort, fmt, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, modular, brotli_effort, decoding_speed, photon_noise_iso, resampling, jpeg_keep_exif, jpeg_keep_xmp, jpeg_keep_jumbf, already_downsampled, upsampling_mode, ec_resampling);
  if (s != nullptr) {
    s->enc_epf = epf;
    s->enc_gaborish = gaborish;
    s->enc_dots = dots;
    s->enc_color_transform = color_transform;
  }
  return s;
}

// _z variant: same as _y plus orientation (1..8, EXIF semantics). When >1, JXL
// records the rotation in basic info and pixels stay sensor-native — no CPU rotate.
JxlWasmEncState* jxl_wasm_enc_create_image_z(
    uint32_t width, uint32_t height,
    float distance, uint32_t effort,
    uint32_t fmt, uint32_t has_alpha,
    uint32_t progressive_dc, uint32_t progressive_ac, uint32_t qprogressive_ac, uint32_t buffering, uint32_t group_order,
    int32_t modular, int32_t brotli_effort, int32_t decoding_speed, int32_t photon_noise_iso, uint32_t resampling,
    int32_t epf, int32_t gaborish, int32_t dots, int32_t patches, int32_t color_transform,
    uint32_t orientation,
    int32_t center_x, int32_t center_y,
    int32_t jpeg_keep_exif, int32_t jpeg_keep_xmp, int32_t jpeg_keep_jumbf,
    int32_t already_downsampled, int32_t upsampling_mode, int32_t ec_resampling) {
  JxlWasmEncState* s = jxl_wasm_enc_create_image_y(width, height, distance, effort, fmt, has_alpha, progressive_dc, progressive_ac, qprogressive_ac, buffering, group_order, modular, brotli_effort, decoding_speed, photon_noise_iso, resampling, epf, gaborish, dots, patches, color_transform, center_x, center_y, jpeg_keep_exif, jpeg_keep_xmp, jpeg_keep_jumbf, already_downsampled, upsampling_mode, ec_resampling);
  if (s != nullptr) {
    s->enc_orientation = (orientation >= 1u && orientation <= 8u) ? orientation : 1u;
  }
  return s;
}

// Copy `size` bytes from `data` into the pixel buffer at the current write offset.
// Returns 0 on success, non-zero on error (overflow or bad state).
int jxl_wasm_enc_push_chunk(JxlWasmEncState* s, const uint8_t* data, size_t size) {
  if (s == nullptr || data == nullptr) return -1;
  if (s->error_code != 0) return s->error_code;
  if (s->pixels_buf == nullptr) { s->error_code = -2; return -2; }
  if (size == 0) return 0;
  if (s->pixels_written + size > s->pixels_size) { s->error_code = -3; return -3; }
  memcpy(s->pixels_buf + s->pixels_written, data, size);
  s->pixels_written += size;
  return 0;
}

// Direct-write fast path: JS writes straight into the pre-allocated pixel buffer.
// Returns null on overflow or bad state; caller must follow with enc_advance_written.
uint8_t* jxl_wasm_enc_pixels_ptr(JxlWasmEncState* s, size_t size) {
  if (s == nullptr || s->error_code != 0 || s->pixels_buf == nullptr) return nullptr;
  if (s->pixels_written + size > s->pixels_size) return nullptr;
  return s->pixels_buf + s->pixels_written;
}

int jxl_wasm_enc_advance_written(JxlWasmEncState* s, size_t size) {
  if (s == nullptr) return -1;
  if (s->error_code != 0) return s->error_code;
  if (s->pixels_buf == nullptr) { s->error_code = -2; return -2; }
  if (s->pixels_written + size > s->pixels_size) { s->error_code = -3; return -3; }
  s->pixels_written += size;
  return 0;
}

// Encode the accumulated pixel buffer. Frees pixels_buf on completion (success or error).
// Output becomes available via enc_take_chunk. Returns 0 on success, non-zero on error.
int jxl_wasm_enc_finish(JxlWasmEncState* s) {
  if (s == nullptr) return -1;
  if (s->error_code != 0) return s->error_code;
  if (s->pixels_buf == nullptr) { s->error_code = -2; return -2; }
  if (s->pixels_written != s->pixels_size) { s->error_code = -4; return -4; }

  const double tEnc0 = emscripten_get_now();
  // B3: use metadata path when ICC/EXIF/XMP were set via jxl_wasm_enc_set_metadata,
  // eliminating the buffered-encode malloc+copy that was forced when metadata was present.
  JxlWasmBuffer* buf = EncodeRgbaWithMetadata(
      s->pixels_buf, s->enc_width, s->enc_height,
      s->enc_distance, s->enc_effort, s->enc_fmt, s->enc_has_alpha,
      s->enc_progressive_dc, s->enc_progressive_ac, s->enc_qprogressive_ac, s->enc_buffering, s->enc_group_order,
      s->enc_modular, s->enc_brotli_effort, s->enc_decoding_speed, s->enc_photon_noise_iso, s->enc_resampling,
      s->enc_icc, s->enc_icc_size, s->enc_exif, s->enc_exif_size, s->enc_xmp, s->enc_xmp_size,
      nullptr, s->enc_epf, s->enc_gaborish, s->enc_dots, s->enc_color_transform,
      s->enc_orientation,
      s->enc_intrinsic_width, s->enc_intrinsic_height,
      s->enc_disable_perceptual,
      s->enc_codestream_level,
      s->enc_premultiply_alpha,
      s->enc_ec_resampling);

  // libjxl is done with the pixel data — free it now to reclaim memory.
  free(s->pixels_buf);
  s->pixels_buf    = nullptr;
  s->pixels_size   = 0;
  s->pixels_written = 0;

  if (buf == nullptr) { s->error_code = 25; return 25; }
  if (buf->error != 0) { int ec = buf->error; FreeBufferNoChain(buf); s->error_code = ec; return ec; }

  const double tEnc1 = emscripten_get_now();
  EM_ASM({ console.log("[jxl-enc-bridge] EncodeRgbaWithMetadata took", $0.toFixed(1), "ms"); }, tEnc1 - tEnc0);

  // Steal the output buffer pointer from JxlWasmBuffer — avoids a memcpy.
  s->outbuf      = buf->data;
  s->outbuf_size = buf->size;
  buf->data = nullptr;
  FreeBufferNoChain(buf);
  return 0;
}

void jxl_wasm_enc_free(JxlWasmEncState* s) {
  if (s == nullptr) return;
  free(s->pixels_buf);  // no-op after enc_finish (set to nullptr); safety net on cancel
  free(s->outbuf);
  free(s->enc_icc);
  free(s->enc_exif);
  free(s->enc_xmp);
  free(s);
}

// B3: Store ICC/EXIF/XMP for the streaming-input path. Must be called before enc_finish.
// Copies the data into WASM-owned buffers so JS can release its copies immediately.
// Returns 0 on success, -1 on malloc failure.
int jxl_wasm_enc_set_metadata(JxlWasmEncState* s,
    const uint8_t* icc, size_t icc_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size) {
  if (s == nullptr) return -1;
  free(s->enc_icc);  s->enc_icc = nullptr;  s->enc_icc_size = 0;
  free(s->enc_exif); s->enc_exif = nullptr; s->enc_exif_size = 0;
  free(s->enc_xmp);  s->enc_xmp = nullptr;  s->enc_xmp_size = 0;
  if (icc != nullptr && icc_size > 0) {
    s->enc_icc = static_cast<uint8_t*>(malloc(icc_size));
    if (s->enc_icc == nullptr) return -1;
    memcpy(s->enc_icc, icc, icc_size);
    s->enc_icc_size = icc_size;
  }
  if (exif != nullptr && exif_size > 0) {
    s->enc_exif = static_cast<uint8_t*>(malloc(exif_size));
    if (s->enc_exif == nullptr) return -1;
    memcpy(s->enc_exif, exif, exif_size);
    s->enc_exif_size = exif_size;
  }
  if (xmp != nullptr && xmp_size > 0) {
    s->enc_xmp = static_cast<uint8_t*>(malloc(xmp_size));
    if (s->enc_xmp == nullptr) return -1;
    memcpy(s->enc_xmp, xmp, xmp_size);
    s->enc_xmp_size = xmp_size;
  }
  return 0;
}

// CasaSneyers_Parity (Ch3): intrinsic_size setter — call before enc_finish.
// Sets the JXL display dimensions independently from the encoded pixel dimensions.
// w=0 or h=0 clears the override (no intrinsic_size in the output codestream).
void jxl_wasm_enc_set_intrinsic_size(JxlWasmEncState* s, uint32_t w, uint32_t h) {
  if (s == nullptr) return;
  s->enc_intrinsic_width  = w;
  s->enc_intrinsic_height = h;
}

// CasaSneyers_Parity (ID 39): frame flags setter — call before enc_finish.
// disable_perceptual=1 bypasses the butteraugli/XYB psychovisual model for fair benchmarking.
// disable_perceptual=0 or -1 restores default perceptual optimization.
void jxl_wasm_enc_set_frame_flags(JxlWasmEncState* s, int32_t disable_perceptual) {
  if (s == nullptr) return;
  s->enc_disable_perceptual = disable_perceptual;
}

// Force codestream level for workflows that need Level 10 (e.g. black/CMYK EC).
// level=-1/other leaves libjxl automatic; accepted explicit levels are 5 and 10.
void jxl_wasm_enc_set_codestream_level(JxlWasmEncState* s, int32_t level) {
  if (s == nullptr) return;
  s->enc_codestream_level = (level == 5 || level == 10) ? level : -1;
}

// Force alpha association signaling for the main alpha channel.
// This does not rewrite pixel values; callers must provide data matching the signal.
void jxl_wasm_enc_set_alpha_premultiply(JxlWasmEncState* s, int32_t premultiply) {
  if (s == nullptr) return;
  s->enc_premultiply_alpha = premultiply > 0 ? 1 : 0;
}

// --- #15: Lossless JPEG → JXL transcode ---

JxlWasmBuffer* jxl_wasm_transcode_jpeg_to_jxl(const uint8_t* jpeg, size_t jpeg_size) {
  if (jpeg == nullptr || jpeg_size == 0) return MakeError(40);

  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return MakeError(41);
  JXL_SETUP_ENC_RUNNER(enc, MakeError(57));

  if (JxlEncoderStoreJPEGMetadata(enc, JXL_TRUE) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(42);
  }

  JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
  if (frame == nullptr) { JxlEncoderDestroy(enc); return MakeError(43); }

  if (JxlEncoderAddJPEGFrame(frame, jpeg, jpeg_size) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(44);
  }
  JxlEncoderCloseInput(enc);

  const size_t initial_cap = std::max(size_t(65536), jpeg_size / 2);
  uint8_t* outbuf = static_cast<uint8_t*>(malloc(initial_cap));
  if (outbuf == nullptr) { JxlEncoderDestroy(enc); return MakeError(45); }
  size_t outbuf_cap = initial_cap;
  uint8_t* next_out = outbuf;
  size_t avail_out = outbuf_cap;

  for (;;) {
    JxlEncoderStatus status = JxlEncoderProcessOutput(enc, &next_out, &avail_out);
    if (status == JXL_ENC_SUCCESS) {
      const size_t final_size = static_cast<size_t>(next_out - outbuf);
      JxlEncoderDestroy(enc);
      JxlWasmBuffer* result = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
      if (result == nullptr) { free(outbuf); return MakeError(46); }
      result->data = outbuf;
      result->size = final_size;
      return result;
    }
    if (status == JXL_ENC_NEED_MORE_OUTPUT) {
      const size_t offset = static_cast<size_t>(next_out - outbuf);
      outbuf_cap *= 2;
      uint8_t* grown = static_cast<uint8_t*>(realloc(outbuf, outbuf_cap));
      if (grown == nullptr) { free(outbuf); JxlEncoderDestroy(enc); return MakeError(47); }
      outbuf = grown;
      next_out = outbuf + offset;
      avail_out = outbuf_cap - offset;
      continue;
    }
    free(outbuf);
    JxlEncoderDestroy(enc);
    return MakeError(static_cast<int>(status));
  }
}

// --- #15b: JPEG → JXL transcode with additional metadata boxes ---
// Adds EXIF/XMP injection, custom boxes, container control, and box compression on top of
// the lossless JPEG transcode. JPEG reconstruction box is implicit via JxlEncoderAddJPEGFrame.
JxlWasmBuffer* jxl_wasm_transcode_jpeg_to_jxl_v2(
    const uint8_t* jpeg, size_t jpeg_size,
    const uint8_t* exif, size_t exif_size,
    const uint8_t* xmp, size_t xmp_size,
    const WasmBoxOpts* box_opts) {
  if (jpeg == nullptr || jpeg_size == 0) return MakeError(40);

  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return MakeError(41);
  JXL_SETUP_ENC_RUNNER(enc, MakeError(57));

  if (JxlEncoderStoreJPEGMetadata(enc, JXL_TRUE) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(42);
  }
  if (ApplyContainerMode(enc, box_opts) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(160);
  }

  JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
  if (frame == nullptr) { JxlEncoderDestroy(enc); return MakeError(43); }

  if (JxlEncoderAddJPEGFrame(frame, jpeg, jpeg_size) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(44);
  }

  const JxlBool compress_flag = (box_opts && box_opts->compress_boxes) ? JXL_TRUE : JXL_FALSE;
  if (exif != nullptr && exif_size > 0) {
    if (JxlEncoderAddBox(enc, "Exif", exif, exif_size, compress_flag) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(161);
    }
  }
  if (xmp != nullptr && xmp_size > 0) {
    if (JxlEncoderAddBox(enc, "xml ", xmp, xmp_size, compress_flag) != JXL_ENC_SUCCESS) {
      JxlEncoderDestroy(enc); return MakeError(162);
    }
  }
  if (AddCustomBoxes(enc, box_opts) != JXL_ENC_SUCCESS) {
    JxlEncoderDestroy(enc); return MakeError(163);
  }

  JxlEncoderCloseInput(enc);

  const size_t initial_cap = std::max(size_t(65536), jpeg_size / 2);
  uint8_t* outbuf = static_cast<uint8_t*>(malloc(initial_cap));
  if (outbuf == nullptr) { JxlEncoderDestroy(enc); return MakeError(45); }
  size_t outbuf_cap = initial_cap;
  uint8_t* next_out = outbuf;
  size_t avail_out = outbuf_cap;
  for (;;) {
    JxlEncoderStatus status = JxlEncoderProcessOutput(enc, &next_out, &avail_out);
    if (status == JXL_ENC_SUCCESS) {
      const size_t final_size = static_cast<size_t>(next_out - outbuf);
      JxlEncoderDestroy(enc);
      JxlWasmBuffer* result = static_cast<JxlWasmBuffer*>(calloc(1, sizeof(JxlWasmBuffer)));
      if (result == nullptr) { free(outbuf); return MakeError(46); }
      result->data = outbuf;
      result->size = final_size;
      return result;
    }
    if (status == JXL_ENC_NEED_MORE_OUTPUT) {
      const size_t offset = static_cast<size_t>(next_out - outbuf);
      outbuf_cap *= 2;
      uint8_t* grown = static_cast<uint8_t*>(realloc(outbuf, outbuf_cap));
      if (grown == nullptr) { free(outbuf); JxlEncoderDestroy(enc); return MakeError(47); }
      outbuf = grown;
      next_out = outbuf + offset;
      avail_out = outbuf_cap - offset;
      continue;
    }
    free(outbuf);
    JxlEncoderDestroy(enc);
    return MakeError(static_cast<int>(status));
  }
}

// --- Tiled ROI exports ---

// Encode RGBA8 as a tiled multi-frame JXL. Each frame is one tile of
// tile_size × tile_size pixels (edges clipped) carrying layer_info.have_crop.
// Decode using jxl_wasm_decode_region_tiled_rgba8 below — the same tile_size
// must be passed back on decode.
JxlWasmBuffer* jxl_wasm_encode_tiled_rgba8(const uint8_t* pixels,
    uint32_t width, uint32_t height, uint32_t tile_size,
    float distance, uint32_t effort, uint32_t has_alpha) {
  return EncodeRgba8Tiled(pixels, width, height, tile_size, distance, effort, has_alpha);
}

// Decode only the tiles overlapping `[region_x, region_x+region_w) ×
// [region_y, region_y+region_h)`. Composites them into a tightly-packed
// RGBA8 buffer with width=clamped_w, height=clamped_h.
JxlWasmBuffer* jxl_wasm_decode_region_tiled_rgba8(const uint8_t* input, size_t input_size,
    uint32_t tile_size, uint32_t region_x, uint32_t region_y,
    uint32_t region_w, uint32_t region_h) {
  return DecodeRgba8RegionTiled(input, input_size, tile_size, region_x, region_y, region_w, region_h);
}

// --- JXTC tile container exports ---
//
// True ROI decode via per-tile independent JXL bitstreams + byte-offset index.
// Bypasses libjxl frame-walk overhead — each tile is a fresh decoder.
// Encode: jxl_wasm_encode_tile_container_rgba8(pixels, w, h, tile_size, distance, effort, has_alpha)
// Decode: jxl_wasm_decode_tile_container_region_rgba8(bytes, size, rx, ry, rw, rh)
JxlWasmBuffer* jxl_wasm_encode_tile_container_rgba8(const uint8_t* pixels,
    uint32_t width, uint32_t height, uint32_t tile_size,
    float distance, uint32_t effort, uint32_t has_alpha) {
  return EncodeRgba8TileContainer(pixels, width, height, tile_size, distance, effort, has_alpha);
}

JxlWasmBuffer* jxl_wasm_decode_tile_container_region_rgba8(const uint8_t* input, size_t input_size,
    uint32_t region_x, uint32_t region_y, uint32_t region_w, uint32_t region_h) {
  return DecodeRgba8TileContainerRegion(input, input_size, region_x, region_y, region_w, region_h);
}

// sRGB approximate gamma (2.2) decode LUT for u8 inputs. Replaces the per-pixel
// std::pow(v/255, 2.2f) in the butteraugli gamma-decode loops (3 call sites below):
// the input is always u8, so a 256-entry table is bit-identical to calling pow per
// pixel while removing ~width*height*3*2 transcendental calls per comparison.
// (Lens 11/19 + output-fidelity-safe: same values, no pixel drift.)
static const float* SrgbGamma22Lut() {
  static float lut[256];
  static bool initialized = false;
  if (!initialized) {
    for (int i = 0; i < 256; ++i) lut[i] = std::pow(i * (1.0f / 255.0f), 2.2f);
    initialized = true;
  }
  return lut;
}

// Butteraugli perceptual distance between two RGBA8 images.
// img1_data, img2_data: RGBA8 buffers, width*height*4 bytes each.
// Returns: float distance bits packed in int32 (0=identical, ~1.0=imperceptible,
//          >2.0=noticeable), or -1 on allocation/comparison failure.
// The caller in facade.ts reinterprets the int32 bits back to float via
// Int32Array/Float32Array view aliasing.
extern "C" int32_t jxl_wasm_butteraugli_compare(
    const uint8_t* img1_data, const uint8_t* img2_data,
    uint32_t width, uint32_t height) {
  // Use default malloc/free memory manager (nullptr fills in defaults via MemoryManagerInit)
  JxlMemoryManager mem;
  if (!jxl::MemoryManagerInit(&mem, nullptr)) return -1;

  // Build linear-light float Image3F (planar RGB, sRGB gamma decoded)
  const float* gamma_lut = SrgbGamma22Lut();
  auto build_image = [&](const uint8_t* data) -> jxl::StatusOr<jxl::Image3F> {
    JXL_ASSIGN_OR_RETURN(jxl::Image3F img,
                         jxl::Image3F::Create(&mem, width, height));
    for (size_t y = 0; y < height; ++y) {
      float* JXL_RESTRICT rr = img.PlaneRow(0, y);
      float* JXL_RESTRICT gr = img.PlaneRow(1, y);
      float* JXL_RESTRICT br = img.PlaneRow(2, y);
      const uint8_t* src = data + y * width * 4u;
      for (size_t x = 0; x < width; ++x) {
        // sRGB approximate gamma decode via LUT: linearise before butteraugli
        rr[x] = gamma_lut[src[x * 4u + 0u]];
        gr[x] = gamma_lut[src[x * 4u + 1u]];
        br[x] = gamma_lut[src[x * 4u + 2u]];
      }
    }
    return img;
  };

  auto img1_or = build_image(img1_data);
  if (!img1_or.ok()) return -1;
  auto img2_or = build_image(img2_data);
  if (!img2_or.ok()) return -1;
  auto diffmap_or = jxl::ImageF::Create(&mem, width, height);
  if (!diffmap_or.ok()) return -1;

  // Extract values — ok() already verified above; value_() is safe to call
  jxl::Image3F img1 = std::move(img1_or).value_();
  jxl::Image3F img2 = std::move(img2_or).value_();
  jxl::ImageF diffmap = std::move(diffmap_or).value_();

  jxl::ButteraugliParams params;
  double diffvalue = 0.0;
  if (!jxl::ButteraugliInterfaceInPlace(std::move(img1), std::move(img2),
                                        params, diffmap, diffvalue)) {
    return -1;
  }

  const float dist = static_cast<float>(diffvalue);
  int32_t bits;
  memcpy(&bits, &dist, 4);
  return bits;
}

}

// ============================================================================
// Ref-cached Butteraugli (B2): pre-build ref Image3F once; per-compare only builds test.
// For batch mode (same ref, N tests) saves N-1 ref gamma-decodes + planarizations vs
// single-shot jxl_wasm_butteraugli_compare. ButteraugliInterfaceInPlace moves both images,
// so we manually copy ref planes before each call.
// ============================================================================

struct JxlWasmButterRef {
  JxlMemoryManager mem;                                   // kept alive for the comparator's images
  std::unique_ptr<jxl::ButteraugliComparator> comp;       // reference pre-processed once
  jxl::ButteraugliParams params;
  uint32_t width;
  uint32_t height;
};

extern "C" JxlWasmButterRef* jxl_wasm_butteraugli_ref_create(
    const uint8_t* ref_data, uint32_t width, uint32_t height) {
  auto* s = new (std::nothrow) JxlWasmButterRef();
  if (!s) return nullptr;
  s->width = width;
  s->height = height;
  if (!jxl::MemoryManagerInit(&s->mem, nullptr)) { delete s; return nullptr; }

  auto img_or = jxl::Image3F::Create(&s->mem, width, height);
  if (!img_or.ok()) { delete s; return nullptr; }
  jxl::Image3F ref_img = std::move(img_or).value_();

  const float* gamma_lut = SrgbGamma22Lut();
  for (size_t y = 0; y < height; ++y) {
    float* JXL_RESTRICT rr = ref_img.PlaneRow(0, y);
    float* JXL_RESTRICT gr = ref_img.PlaneRow(1, y);
    float* JXL_RESTRICT br = ref_img.PlaneRow(2, y);
    const uint8_t* src = ref_data + y * (size_t)width * 4u;
    for (size_t x = 0; x < width; ++x) {
      rr[x] = gamma_lut[src[x * 4u + 0u]];
      gr[x] = gamma_lut[src[x * 4u + 1u]];
      br[x] = gamma_lut[src[x * 4u + 2u]];
    }
  }

  // Pre-process the reference ONCE into a ButteraugliComparator (opsin dynamics +
  // frequency separation). Each compare then only processes the test image and diffs
  // against this cached state — no per-compare deep-copy of the reference AND the ref's
  // opsin/frequency decomposition is computed once instead of every pass. This path uses
  // the exported HWY dispatches (OpsinDynamicsImage/SeparateFrequencies/MaltaDiffMap/...),
  // unlike the free-function ButteraugliInterface, which routes through a non-exported
  // ButteraugliDiffmap in this WASM build (only ButteraugliDiffmapInPlace is HWY_EXPORTed).
  auto comp_or = jxl::ButteraugliComparator::Make(ref_img, s->params);
  if (!comp_or.ok()) { delete s; return nullptr; }
  s->comp = std::move(comp_or).value_();
  return s;
}

extern "C" int32_t jxl_wasm_butteraugli_ref_compare(
    JxlWasmButterRef* s, const uint8_t* test_data) {
  if (!s || !s->comp) return -1;
  const uint32_t width = s->width, height = s->height;

  // Build test Image3F (gamma-decode) with the state's own memory manager.
  auto test_or = jxl::Image3F::Create(&s->mem, width, height);
  if (!test_or.ok()) return -1;
  jxl::Image3F test_img = std::move(test_or).value_();
  const float* gamma_lut = SrgbGamma22Lut();
  for (size_t y = 0; y < height; ++y) {
    float* JXL_RESTRICT rr = test_img.PlaneRow(0, y);
    float* JXL_RESTRICT gr = test_img.PlaneRow(1, y);
    float* JXL_RESTRICT br = test_img.PlaneRow(2, y);
    const uint8_t* src = test_data + y * (size_t)width * 4u;
    for (size_t x = 0; x < width; ++x) {
      rr[x] = gamma_lut[src[x * 4u + 0u]];
      gr[x] = gamma_lut[src[x * 4u + 1u]];
      br[x] = gamma_lut[src[x * 4u + 2u]];
    }
  }

  // Diff the test against the pre-processed cached reference — no reference copy or
  // re-decomposition per compare. Score via the same ButteraugliScoreFromDiffmap path
  // that ButteraugliInterfaceInPlace used, so the distance is unchanged.
  auto diffmap_or = jxl::ImageF::Create(&s->mem, width, height);
  if (!diffmap_or.ok()) return -1;
  jxl::ImageF diffmap = std::move(diffmap_or).value_();
  if (!s->comp->Diffmap(test_img, diffmap)) return -1;

  const double diffvalue = jxl::ButteraugliScoreFromDiffmap(diffmap, &s->params);
  const float dist = static_cast<float>(diffvalue);
  int32_t bits;
  memcpy(&bits, &dist, 4);
  return bits;
}

extern "C" void jxl_wasm_butteraugli_ref_free(JxlWasmButterRef* s) {
  delete s;
}

// ============================================================================
// PSNR (B3): sum squared diffs over RGB channels, result in dB as float bits.
// Identical images → +Inf. Skips alpha channel.
// ============================================================================
extern "C" int32_t jxl_wasm_psnr_compare(
    const uint8_t* img1, const uint8_t* img2, uint32_t width, uint32_t height) {
  const size_t npixels = (size_t)width * height;
  double sum = 0.0;
  for (size_t i = 0; i < npixels; ++i) {
    const size_t off = i * 4u;
    for (int c = 0; c < 3; ++c) {
      const double d = (double)img1[off + c] - (double)img2[off + c];
      sum += d * d;
    }
  }
  float result;
  if (sum == 0.0) {
    result = std::numeric_limits<float>::infinity();
  } else {
    const double mse = sum / (3.0 * (double)npixels);
    result = static_cast<float>(10.0 * std::log10(255.0 * 255.0 / mse));
  }
  int32_t bits;
  memcpy(&bits, &result, 4);
  return bits;
}

// ============================================================================
// SSIM (B4): 8×8 block-windowed SSIM, luminance-only (mean of RGB channels).
// Matches the approximation level of JS computeSsimVsFinal in jxl-progressive-quality.js.
// ============================================================================
static double ssim_block_luma(
    const uint8_t* a, const uint8_t* b,
    uint32_t width, uint32_t bx, uint32_t by, uint32_t bw, uint32_t bh) {
  const uint32_t n = bw * bh;
  double ma = 0.0, mb = 0.0;
  for (uint32_t y = by; y < by + bh; ++y) {
    for (uint32_t x = bx; x < bx + bw; ++x) {
      const size_t idx = ((size_t)y * width + x) * 4u;
      ma += ((double)a[idx] + a[idx + 1] + a[idx + 2]) * (1.0 / 3.0);
      mb += ((double)b[idx] + b[idx + 1] + b[idx + 2]) * (1.0 / 3.0);
    }
  }
  ma /= n; mb /= n;
  double va = 0.0, vb = 0.0, cov = 0.0;
  for (uint32_t y = by; y < by + bh; ++y) {
    for (uint32_t x = bx; x < bx + bw; ++x) {
      const size_t idx = ((size_t)y * width + x) * 4u;
      const double av = ((double)a[idx] + a[idx + 1] + a[idx + 2]) * (1.0 / 3.0) - ma;
      const double bv = ((double)b[idx] + b[idx + 1] + b[idx + 2]) * (1.0 / 3.0) - mb;
      va += av * av; vb += bv * bv; cov += av * bv;
    }
  }
  va /= n; vb /= n; cov /= n;
  const double C1 = 6.5025, C2 = 58.5225; // (0.01*255)^2, (0.03*255)^2
  return ((2.0 * ma * mb + C1) * (2.0 * cov + C2))
       / ((ma * ma + mb * mb + C1) * (va + vb + C2));
}

extern "C" int32_t jxl_wasm_ssim_compare(
    const uint8_t* img1, const uint8_t* img2, uint32_t width, uint32_t height) {
  const uint32_t BLOCK = 8u;
  double total = 0.0;
  uint32_t count = 0u;
  for (uint32_t y = 0; y + BLOCK <= height; y += BLOCK) {
    for (uint32_t x = 0; x + BLOCK <= width; x += BLOCK) {
      total += ssim_block_luma(img1, img2, width, x, y, BLOCK, BLOCK);
      ++count;
    }
  }
  const float result = count > 0u ? static_cast<float>(total / count) : 1.0f;
  int32_t bits;
  memcpy(&bits, &result, 4);
  return bits;
}

// ============================================================================
// Perceptual Constancy Mode (Lens17) — C++ optimal pathway
// Full framework implemented here for speed (SIMD-friendly, intrinsics, Emscripten -O3 + -mavx2).
// This is the optimal path vs pure scalar Rust (the Rust version in raw-pipeline is the portable baseline + spec).
// Relation to SIMD: C++ makes hand-tuned or auto-vectorized SIMD straightforward for the per-pixel transforms.
// Both compile to WASM for browser (Emscripten for this bridge; wasm-bindgen for the Rust side).
// Hook from JS/WASM: call the extern "C" wrappers (exported in the module).
// See docs/PerceptualConstancyMode.md and docs/hooks.md.
// The Rust apply_tone_math can FFI-call these when the bridge is present for optimal "new" path.
// ============================================================================

static const float SENSOR_SHARPEN_B[3][3] = {
  { 1.05f, -0.025f, -0.025f },
  { -0.025f,  1.05f, -0.025f },
  { -0.025f, -0.025f,  1.05f }
};

extern "C" {

void perceptual_to_log_euclidean(float r, float g, float b, float* out_lr, float* out_lg, float* out_lb) {
  const float eps = 1e-6f;
  float sr = SENSOR_SHARPEN_B[0][0]*r + SENSOR_SHARPEN_B[0][1]*g + SENSOR_SHARPEN_B[0][2]*b;
  float sg = SENSOR_SHARPEN_B[1][0]*r + SENSOR_SHARPEN_B[1][1]*g + SENSOR_SHARPEN_B[1][2]*b;
  float sb = SENSOR_SHARPEN_B[2][0]*r + SENSOR_SHARPEN_B[2][1]*g + SENSOR_SHARPEN_B[2][2]*b;
  *out_lr = logf(fmaxf(sr, eps));
  *out_lg = logf(fmaxf(sg, eps));
  *out_lb = logf(fmaxf(sb, eps));
}

void perceptual_from_log_euclidean(float lr, float lg, float lb, float* out_r, float* out_g, float* out_b) {
  const float eps = 1e-6f;
  *out_r = fmaxf(expf(lr) - eps, 0.0f);
  *out_g = fmaxf(expf(lg) - eps, 0.0f);
  *out_b = fmaxf(expf(lb) - eps, 0.0f);
}

void perceptual_molchanov_residuals_and_atensor(float luma_l, float lr, float lg, float lb, float base_scale,
                                                float* out_lr, float* out_lg, float* out_lb, float* out_mod_scale) {
  // Parallelogram residuals + A_tensor density (higher around gray/greens)
  float res_r = 0.02f * (lr - luma_l) * (lr - luma_l);
  float res_g = 0.02f * (lg - luma_l) * (lg - luma_l);
  float res_b = 0.02f * (lb - luma_l) * (lb - luma_l);

  float gray_dist = fminf(fabsf(lr - luma_l) + fabsf(lg - luma_l) + fabsf(lb - luma_l), 2.0f) / 2.0f;
  float a_mod = 1.0f + 0.3f * (1.0f - gray_dist);
  float green_boost = (lg > lr && lg > lb) ? 1.15f : 1.0f;
  float mod_scale = base_scale * a_mod * green_boost;

  *out_lr = luma_l + (lr - luma_l + res_r) * mod_scale;
  *out_lg = luma_l + (lg - luma_l + res_g) * mod_scale;
  *out_lb = luma_l + (lb - luma_l + res_b) * mod_scale;
  *out_mod_scale = mod_scale;
}

void perceptual_hybrid_spring_and_fc(float lr, float lg, float lb, float luma_l,
                                     float* out_lr, float* out_lg, float* out_lb) {
  float r = lr, g = lg, b = lb;

  // Hybrid spring to neutral (prevents gray drift)
  float dist = sqrtf((r - luma_l)*(r - luma_l) + (g - luma_l)*(g - luma_l) + (b - luma_l)*(b - luma_l));
  if (dist < 0.25f) {
    float spring = 0.7f * (0.25f - dist);
    r = r * (1.0f - spring) + luma_l * spring;
    g = g * (1.0f - spring) + luma_l * spring;
    b = b * (1.0f - spring) + luma_l * spring;
  }

  // f(c) diminishing returns (per-hue, stronger for greens example)
  float fc_r = fmaxf(1.0f - 0.08f * fminf(fabsf(r - luma_l), 0.6f), 0.6f);
  float fc_g = fmaxf(1.0f - 0.12f * fminf(fabsf(g - luma_l), 0.6f), 0.6f);
  float fc_b = fmaxf(1.0f - 0.08f * fminf(fabsf(b - luma_l), 0.6f), 0.6f);

  *out_lr = r * fc_r;
  *out_lg = g * fc_g;
  *out_lb = b * fc_b;
}

// Combined apply for the full new path (optimal C++ entry point for the lightbox hook).
// JS/WASM can call this directly on linear rgb for the constancy adjustments.
void perceptual_apply_full(float r, float g, float b, float sat, float vib, int vib_zero,
                           float* out_r, float* out_g, float* out_b) {
  const float eps = 1e-6f;
  float lr, lg, lb;
  perceptual_to_log_euclidean(r, g, b, &lr, &lg, &lb);
  float luma_l = (lr + lg + lb) / 3.0f;
  // Aligned to Rust outer scale logic for consistency (full per-pixel pixel_sat + vib_w).
  float base_scale;
  if (vib_zero) {
    base_scale = sat;
  } else {
    float raw_mx = fmaxf(fmaxf(r, g), b);
    float mx = fmaxf(raw_mx, 1.0f);
    float mn = fmaxf(fminf(fminf(r, g), b), 0.0f);
    float pixel_sat = (raw_mx > 0.0f) ? fminf(fmaxf((mx - mn) / mx, 0.0f), 1.0f) : 0.0f;
    float vib_w = 1.0f - pixel_sat;
    base_scale = sat * (1.0f + vib * vib_w * 0.6f);
  }
  float lr2, lg2, lb2, mod;
  perceptual_molchanov_residuals_and_atensor(luma_l, lr, lg, lb, base_scale, &lr2, &lg2, &lb2, &mod);
  float lr3, lg3, lb3;
  perceptual_hybrid_spring_and_fc(lr2, lg2, lb2, luma_l, &lr3, &lg3, &lb3);
  perceptual_from_log_euclidean(lr3, lg3, lb3, out_r, out_g, out_b);
}

} // extern "C"

// ============================================================================
// Hand-written AVX2 Intrinsics for Perceptual Constancy (optimal C++ pathway)
// These are the SIMD versions using hand-written intrinsics for the 4 core helpers
// + bulk apply. Lie in this file (bridge.cpp) as part of the JXL WASM bridge
// (Emscripten can target AVX2/SSE for native or WASM SIMD).
// The Rust side (raw-pipeline) has the portable reference.
// Flip-flop between scalar (previous C++ or Rust) and these intrinsics.
// For 8-wide f32 (AVX2). Remainder handled scalar in caller.
// Includes fast approx for log/exp using poly + fma (no external lib).
// ============================================================================

#include <immintrin.h>  // for __m256, _mm256_*

#ifdef __AVX2__

// avx2_apply_b removed (was partial/demo; bulk inlines clean SoA B application for 3 channels).

static inline __m256 avx2_fast_log(const __m256 x) {
  // Simple poly approx for log(1+y) , y=x-1 , for demo (degree 4).
  // For higher accuracy/speed in production use better minimax poly, range reduction (frexp/ilogb)
  // or platform log. Kept for intrinsics speedup on the critical path; cross-checked in C++ benches.
  __m256 one = _mm256_set1_ps(1.0f);
  __m256 y = _mm256_sub_ps(x, one);
  __m256 y2 = _mm256_mul_ps(y, y);
  __m256 res = y;
  res = _mm256_fnmadd_ps(y2, _mm256_set1_ps(0.5f), res);
  __m256 y3 = _mm256_mul_ps(y2, y);
  res = _mm256_fmadd_ps(y3, _mm256_set1_ps(0.333333f), res);
  __m256 y4 = _mm256_mul_ps(y2, y2);
  res = _mm256_fnmadd_ps(y4, _mm256_set1_ps(0.25f), res);
  return res;
}

static inline __m256 avx2_fast_exp(const __m256 x) {
  // Taylor for exp, unrolled for 8 terms, demo.
  // See log note: approximations prioritized for vector throughput. Accuracy validated in
  // perceptual_constancy_cpp_stability_bench.cpp (max err tracked vs scalar ref).
  __m256 one = _mm256_set1_ps(1.0f);
  __m256 res = one;
  __m256 term = one;
  __m256 x2 = _mm256_mul_ps(x, x);
  // unrolled
  term = _mm256_mul_ps(term, _mm256_div_ps(x, _mm256_set1_ps(1.0f)));
  res = _mm256_add_ps(res, term);
  term = _mm256_mul_ps(term, _mm256_div_ps(x, _mm256_set1_ps(2.0f)));
  res = _mm256_add_ps(res, term);
  term = _mm256_mul_ps(term, _mm256_div_ps(x, _mm256_set1_ps(3.0f)));
  res = _mm256_add_ps(res, term);
  term = _mm256_mul_ps(term, _mm256_div_ps(x, _mm256_set1_ps(4.0f)));
  res = _mm256_add_ps(res, term);
  term = _mm256_mul_ps(term, _mm256_div_ps(x, _mm256_set1_ps(5.0f)));
  res = _mm256_add_ps(res, term);
  term = _mm256_mul_ps(term, _mm256_div_ps(x, _mm256_set1_ps(6.0f)));
  res = _mm256_add_ps(res, term);
  term = _mm256_mul_ps(term, _mm256_div_ps(x, _mm256_set1_ps(7.0f)));
  res = _mm256_add_ps(res, term);
  return res;
}

static inline __m256 mm256_abs_ps(__m256 x) {
  // Portable abs for ps (sign bit clear). Avoids _mm256_abs_ps availability differences across clang/emcc headers.
  __m256 sign_mask = _mm256_set1_ps(-0.0f);
  return _mm256_andnot_ps(sign_mask, x);
}

static inline void avx2_molchanov(const __m256 luma, const __m256 lr, const __m256 lg, const __m256 lb,
                                  const __m256 base_scale,
                                  __m256* olr, __m256* olg, __m256* olb, __m256* oscale) {
  __m256 resr = _mm256_mul_ps(_mm256_set1_ps(0.02f), _mm256_mul_ps(_mm256_sub_ps(lr, luma), _mm256_sub_ps(lr, luma)));
  __m256 resg = _mm256_mul_ps(_mm256_set1_ps(0.02f), _mm256_mul_ps(_mm256_sub_ps(lg, luma), _mm256_sub_ps(lg, luma)));
  __m256 resb = _mm256_mul_ps(_mm256_set1_ps(0.02f), _mm256_mul_ps(_mm256_sub_ps(lb, luma), _mm256_sub_ps(lb, luma)));

  __m256 dist = _mm256_add_ps(mm256_abs_ps(_mm256_sub_ps(lr, luma)),
                 _mm256_add_ps(mm256_abs_ps(_mm256_sub_ps(lg, luma)),
                               mm256_abs_ps(_mm256_sub_ps(lb, luma))));
  dist = _mm256_min_ps(dist, _mm256_set1_ps(2.0f));
  dist = _mm256_div_ps(dist, _mm256_set1_ps(2.0f));
  __m256 amod = _mm256_fmadd_ps(_mm256_set1_ps(-0.3f), dist, _mm256_set1_ps(1.3f));  // 1 + 0.3*(1-d)
  __m256 gboost = _mm256_blendv_ps(_mm256_set1_ps(1.0f), _mm256_set1_ps(1.15f),
                                   _mm256_cmp_ps(lg, _mm256_max_ps(lr, lb), _CMP_GT_OQ));

  __m256 mscale = _mm256_mul_ps(base_scale, _mm256_mul_ps(amod, gboost));

  *olr = _mm256_fmadd_ps(_mm256_add_ps(_mm256_sub_ps(lr, luma), resr), mscale, luma);
  *olg = _mm256_fmadd_ps(_mm256_add_ps(_mm256_sub_ps(lg, luma), resg), mscale, luma);
  *olb = _mm256_fmadd_ps(_mm256_add_ps(_mm256_sub_ps(lb, luma), resb), mscale, luma);
  *oscale = mscale;
}

static inline void avx2_hybrid(const __m256 lr, const __m256 lg, const __m256 lb, const __m256 luma,
                               __m256* orr, __m256* ogg, __m256* obb) {
  __m256 dr = _mm256_sub_ps(lr, luma);
  __m256 dg = _mm256_sub_ps(lg, luma);
  __m256 db = _mm256_sub_ps(lb, luma);
  __m256 dist = _mm256_sqrt_ps(_mm256_add_ps(_mm256_mul_ps(dr, dr),
                              _mm256_add_ps(_mm256_mul_ps(dg, dg), _mm256_mul_ps(db, db))));
  __m256 mask = _mm256_cmp_ps(dist, _mm256_set1_ps(0.25f), _CMP_LT_OQ);
  __m256 spring = _mm256_mul_ps(_mm256_set1_ps(0.7f), _mm256_sub_ps(_mm256_set1_ps(0.25f), dist));
  __m256 nr = _mm256_blendv_ps(lr, _mm256_fmadd_ps(_mm256_sub_ps(_mm256_set1_ps(1.0f), spring), lr, _mm256_mul_ps(spring, luma)), mask);
  __m256 ng = _mm256_blendv_ps(lg, _mm256_fmadd_ps(_mm256_sub_ps(_mm256_set1_ps(1.0f), spring), lg, _mm256_mul_ps(spring, luma)), mask);
  __m256 nb = _mm256_blendv_ps(lb, _mm256_fmadd_ps(_mm256_sub_ps(_mm256_set1_ps(1.0f), spring), lb, _mm256_mul_ps(spring, luma)), mask);

  __m256 fcr = _mm256_max_ps(_mm256_sub_ps(_mm256_set1_ps(1.0f), _mm256_mul_ps(_mm256_set1_ps(0.08f), _mm256_min_ps(mm256_abs_ps(_mm256_sub_ps(nr, luma)), _mm256_set1_ps(0.6f)))), _mm256_set1_ps(0.6f));
  __m256 fcg = _mm256_max_ps(_mm256_sub_ps(_mm256_set1_ps(1.0f), _mm256_mul_ps(_mm256_set1_ps(0.12f), _mm256_min_ps(mm256_abs_ps(_mm256_sub_ps(ng, luma)), _mm256_set1_ps(0.6f)))), _mm256_set1_ps(0.6f));
  __m256 fcb = _mm256_max_ps(_mm256_sub_ps(_mm256_set1_ps(1.0f), _mm256_mul_ps(_mm256_set1_ps(0.08f), _mm256_min_ps(mm256_abs_ps(_mm256_sub_ps(nb, luma)), _mm256_set1_ps(0.6f)))), _mm256_set1_ps(0.6f));

  *orr = _mm256_mul_ps(nr, fcr);
  *ogg = _mm256_mul_ps(ng, fcg);
  *obb = _mm256_mul_ps(nb, fcb);
}

// Bulk AVX2 entry: processes n pixels (SoA r/g/b arrays), 8 at a time. Remainder scalar fallback inside or caller.
extern "C" void perceptual_apply_full_avx2(const float* in_r, const float* in_g, const float* in_b,
                                           float* out_r, float* out_g, float* out_b,
                                           int n, float sat, float vib, int vib_zero) {
  int i = 0;
  for(; i + 8 <= n; i += 8) {
    __m256 r = _mm256_loadu_ps(in_r + i);
    __m256 g = _mm256_loadu_ps(in_g + i);
    __m256 b = _mm256_loadu_ps(in_b + i);

    __m256 s_r = _mm256_fmadd_ps(_mm256_set1_ps(1.05f), r, _mm256_fmadd_ps(_mm256_set1_ps(-0.025f), g, _mm256_mul_ps(_mm256_set1_ps(-0.025f), b)));
    __m256 s_g = _mm256_fmadd_ps(_mm256_set1_ps(-0.025f), r, _mm256_fmadd_ps(_mm256_set1_ps(1.05f), g, _mm256_mul_ps(_mm256_set1_ps(-0.025f), b)));
    __m256 s_b = _mm256_fmadd_ps(_mm256_set1_ps(-0.025f), r, _mm256_fmadd_ps(_mm256_set1_ps(-0.025f), g, _mm256_mul_ps(_mm256_set1_ps(1.05f), b)));

    __m256 l_r = avx2_fast_log(s_r);
    __m256 l_g = avx2_fast_log(s_g);
    __m256 l_b = avx2_fast_log(s_b);

    __m256 luma = _mm256_mul_ps(_mm256_set1_ps(0.333333f), _mm256_add_ps(l_r, _mm256_add_ps(l_g, l_b)));

    // Full per-lane base_scale using pixel_sat + vib_w (matches Rust, vectorized intrinsics for correctness + quality).
    // Input r/g/b here are post-matrix (pre any scale).
    __m256 raw_mx = _mm256_max_ps(_mm256_max_ps(r, g), b);
    __m256 mx = _mm256_max_ps(raw_mx, _mm256_set1_ps(1.0f));
    __m256 mn = _mm256_max_ps(_mm256_min_ps(_mm256_min_ps(r, g), b), _mm256_set1_ps(0.0f));
    __m256 pixel_sat = _mm256_setzero_ps();
    __m256 pos_mask = _mm256_cmp_ps(raw_mx, _mm256_setzero_ps(), _CMP_GT_OQ);
    __m256 divv = _mm256_div_ps(_mm256_sub_ps(mx, mn), mx);
    __m256 clamped = _mm256_min_ps(_mm256_max_ps(divv, _mm256_setzero_ps()), _mm256_set1_ps(1.0f));
    pixel_sat = _mm256_and_ps(clamped, pos_mask);  // blendv equivalent via and for 0/1 mask
    __m256 vib_w = _mm256_sub_ps(_mm256_set1_ps(1.0f), pixel_sat);
    __m256 base_s;
    if (vib_zero) {
      base_s = _mm256_set1_ps(sat);
    } else {
      __m256 factor = _mm256_fmadd_ps(_mm256_set1_ps(vib), _mm256_mul_ps(vib_w, _mm256_set1_ps(0.6f)), _mm256_set1_ps(1.0f));
      base_s = _mm256_mul_ps(_mm256_set1_ps(sat), factor);
    }

    __m256 o_l_r, o_l_g, o_l_b, o_sc;
    avx2_molchanov(luma, l_r, l_g, l_b, base_s, &o_l_r, &o_l_g, &o_l_b, &o_sc);

    __m256 o_r, o_g, o_b;
    avx2_hybrid(o_l_r, o_l_g, o_l_b, luma, &o_r, &o_g, &o_b);

    __m256 f_r = avx2_fast_exp(o_r);
    __m256 f_g = avx2_fast_exp(o_g);
    __m256 f_b = avx2_fast_exp(o_b);

    _mm256_storeu_ps(out_r + i, f_r);
    _mm256_storeu_ps(out_g + i, f_g);
    _mm256_storeu_ps(out_b + i, f_b);
  }
  // remainder scalar (use the previous scalar impl)
  for(; i < n; i++) {
    float rr, gg, bb;
    // call scalar version or duplicate small
    perceptual_apply_full(in_r[i], in_g[i], in_b[i], sat, vib, vib_zero, &rr, &gg, &bb);
    out_r[i] = rr; out_g[i] = gg; out_b[i] = bb;
  }
}

#endif // __AVX2__

// Scalar fallback is the previous perceptual_apply_full (already added).

// Stub implementation for JxlGainMapReadBundle (and friends if needed) to allow
// linking of dec-only modules in the P3 split build when the gain map .o from
// libjxl is not included in the dec static libs, even though the header was
// visible at bridge compile time (pulling in the call site under
// JXL_GAIN_MAP_SUPPORTED).
#if JXL_GAIN_MAP_SUPPORTED
JXL_EXPORT JXL_BOOL JxlGainMapReadBundle(JxlGainMapBundle* map_bundle,
                                         const uint8_t* data,
                                         size_t size,
                                         size_t* bytes_read) {
  (void)map_bundle; (void)data; (void)size; (void)bytes_read;
  return 0;  // JXL_FALSE
}
JXL_EXPORT JXL_BOOL JxlGainMapGetBundleSize(const JxlGainMapBundle* map_bundle,
                                            size_t* bundle_size) {
  (void)map_bundle; (void)bundle_size;
  return 0;  // JXL_FALSE
}
JXL_EXPORT JXL_BOOL JxlGainMapWriteBundle(const JxlGainMapBundle* map_bundle,
                                          uint8_t* output_buffer,
                                          size_t output_buffer_size,
                                          size_t* bytes_written) {
  (void)map_bundle; (void)output_buffer; (void)output_buffer_size; (void)bytes_written;
  return 0;  // JXL_FALSE
}
#endif
