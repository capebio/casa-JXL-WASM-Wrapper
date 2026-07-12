#include <node_api.h>

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <string>
#include <vector>
#include <algorithm>

#if __has_include(<jxl/decode.h>) && __has_include(<jxl/encode.h>)
#define CASABIO_HAVE_LIBJXL 1
#include <jxl/color_encoding.h>
#include <jxl/decode.h>
#include <jxl/encode.h>
#include <jxl/types.h>
#if __has_include(<jxl/thread_parallel_runner.h>)
#include <jxl/thread_parallel_runner.h>
#define CASABIO_HAVE_JXL_THREADS 1
#else
#define CASABIO_HAVE_JXL_THREADS 0
#endif
#else
#define CASABIO_HAVE_LIBJXL 0
#define CASABIO_HAVE_JXL_THREADS 0
#endif

namespace {

#if CASABIO_HAVE_JXL_THREADS
struct ThreadRunnerGuard {
  void* runner;
  ThreadRunnerGuard(void* r) : runner(r) {}
  ~ThreadRunnerGuard() {
    if (runner) {
      JxlThreadParallelRunnerDestroy(runner);
    }
  }
};
#endif

enum class PixelFormatKind { Rgba8, Rgba16, Rgbaf32 };

struct ImageInfo {
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t bits_per_sample = 8;
  bool has_alpha = true;
  bool has_animation = false;
  bool jpeg_reconstruction_available = false;

  // Task 5 decoder extra channels (descriptors only; additive)
  struct DecodedExtra {
    std::string type;
    uint32_t bits_per_sample = 8;
    uint32_t dim_shift = 0;
    std::string name;
    bool has_spot = false;
    float spot_r = 0, spot_g = 0, spot_b = 0, spot_solidity = 0;
  };
  std::vector<DecodedExtra> extra_channels;
};

struct Region {
  uint32_t x = 0;
  uint32_t y = 0;
  uint32_t w = 0;
  uint32_t h = 0;
};

// Forward-declared: holds the persistent libjxl decoder + all resumable loop
// state for the incremental (live) streaming path (Packet-3 Task 4 / finding 20).
struct LiveDecodeState;

struct DecoderData {
  std::vector<uint8_t> input;
  std::vector<napi_ref> events;
  bool closed = false;
  bool cancelled = false;

  // NV-14 zero-copy single-push fields (decoder side)
  napi_ref pinned_input = nullptr;
  void* pinned_data = nullptr;
  size_t pinned_size = 0;
  bool multi_push = false;

  // ---- Packet-3 Task 4: live/incremental streaming state ----
  // events[] is now a live FIFO. events_head is the drain cursor for the live
  // async iterator (events before events_head have been yielded; they stay as
  // strong refs until dispose/finalize so the JS values remain valid, matching
  // the previous snapshot-iterator retention). done marks that no further events
  // will be produced (close/cancel/error reached a terminal state).
  size_t events_head = 0;
  bool done = false;
  bool errored = false;               // a terminal "error" event was queued
  bool live = false;                  // incremental path engaged (opts allow it)
  std::string error_code;             // terminal error code (for close() rejection)
  std::string error_message;          // terminal error message (for close() rejection)

  // Single pending waiter for the live iterator: when a consumer calls next()
  // and no event is available yet, we park a napi_deferred here and resolve it
  // when the next event is queued or the stream ends. Only one in-flight next()
  // is expected per the AsyncIterable contract (sequential await).
  napi_deferred pending_next = nullptr;

  // Bounded-queue backpressure: when the number of *undrained* queued events
  // (events.size() - events_head) reaches this high-water mark, push() parks a
  // napi_deferred here instead of resolving immediately; it resolves once the
  // consumer drains below the mark. Bounds retained memory to
  // (HWM events) + (active decode buffers).
  napi_deferred backpressure = nullptr;

  LiveDecodeState* live_state = nullptr;
};

static void release_pinned_decoder(napi_env env, DecoderData* data) {
  if (data->pinned_input != nullptr) {
    napi_delete_reference(env, data->pinned_input);
    data->pinned_input = nullptr;
    data->pinned_data = nullptr;
    data->pinned_size = 0;
  }
}

#if CASABIO_HAVE_LIBJXL
// Defined later (uses libjxl types). Forward-declared here so the always-present
// ReleaseLiveState wrapper below can tear the persistent decoder down from the
// non-libjxl-gated decoder methods without duplicating #if guards at each site.
static void DestroyLiveState(napi_env env, LiveDecodeState* st);
#endif

// Always-available: release the persistent live decoder state (no-op when
// libjxl is absent, in which case live_state is never populated).
static void ReleaseLiveState(napi_env env, DecoderData* data) {
#if CASABIO_HAVE_LIBJXL
  if (data->live_state != nullptr) {
    DestroyLiveState(env, data->live_state);
    data->live_state = nullptr;
  }
#else
  (void)env;
  (void)data;
#endif
}

struct ExtraChannelDesc {
  std::string type;
  uint32_t bits_per_sample = 8;
  uint32_t dim_shift = 0;
  std::string name;
  double distance = -1.0;
  bool has_spot = false;
  float spot_r = 0.0f;
  float spot_g = 0.0f;
  float spot_b = 0.0f;
  float spot_solidity = 0.0f;
  std::vector<uint8_t> pixels;  // optional duck-typed plane data from JS 'pixels' prop (for AddExtraChannelBuffer)
};

struct EncoderData {
  std::vector<uint8_t> pixels;
  std::vector<napi_ref> chunks;
  PixelFormatKind format = PixelFormatKind::Rgba8;
  uint32_t width = 0;
  uint32_t height = 0;
  bool has_alpha = true;
  double distance = 1.0;
  uint32_t effort = 7;
  bool finished = false;
  bool cancelled = false;

  // N-17: metadata/ICC (populated in CreateEncoder; consumed in EncodeAll)
  std::vector<uint8_t> icc;
  std::vector<uint8_t> exif;
  std::vector<uint8_t> xmp;

  // N-18: progressive encode (enables decoder progression events on self-encoded codestreams)
  bool progressive = false;

  // Escape hatch support (advancedFrameSettings)
  std::vector<int32_t> advanced_setting_ids;
  std::vector<int32_t> advanced_setting_values;

  // Task 5: extra channels (additive; 0-EC path unchanged)
  std::vector<ExtraChannelDesc> extra_channels;

  // NV-3 / 3C alphaDistance
  double alpha_distance = -1.0;

  // NV-3 / 3E animation encode fields
  struct FrameDesc {
    std::vector<uint8_t> pixels;
    uint32_t duration = 0;
    std::string name;
  };
  std::vector<FrameDesc> frames;
  bool has_animation = false;
  uint32_t anim_tps_num = 0;
  uint32_t anim_tps_den = 1;
  int32_t anim_loops = 0;

  // NV-3 / 3F customBoxes fields
  struct CustomBoxDesc {
    std::string type;
    std::vector<uint8_t> data;
    bool compress = false;
  };
  std::vector<CustomBoxDesc> custom_boxes;

  // NV-14 zero-copy single-push fields
  napi_ref pinned_input = nullptr;
  void* pinned_data = nullptr;
  size_t pinned_size = 0;
  bool multi_push = false;
};

struct IteratorData {
  std::vector<napi_ref> values;
  size_t index = 0;
};

static napi_value Undefined(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

static napi_value Throw(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}

static napi_value ThrowCode(napi_env env, const char* code, const char* message) {
  napi_throw_error(env, code, message);
  return nullptr;
}

static napi_value MakeString(napi_env env, const char* value) {
  napi_value out;
  napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &out);
  return out;
}

static napi_value MakeBool(napi_env env, bool value) {
  napi_value out;
  napi_get_boolean(env, value, &out);
  return out;
}

static napi_value MakeUint32(napi_env env, uint32_t value) {
  napi_value out;
  napi_create_uint32(env, value, &out);
  return out;
}

static bool GetProp(napi_env env, napi_value object, const char* name, napi_value* out) {
  bool has = false;
  napi_has_named_property(env, object, name, &has);
  if (!has) return false;
  napi_get_named_property(env, object, name, out);
  return true;
}

static uint32_t GetUint32Prop(napi_env env, napi_value object, const char* name, uint32_t fallback) {
  napi_value value;
  if (!GetProp(env, object, name, &value)) return fallback;
  uint32_t out = fallback;
  napi_get_value_uint32(env, value, &out);
  return out;
}

static int32_t GetInt32Prop(napi_env env, napi_value object, const char* name, int32_t fallback) {
  napi_value value;
  if (!GetProp(env, object, name, &value)) return fallback;
  int32_t out = fallback;
  napi_get_value_int32(env, value, &out);
  return out;
}

static bool GetBoolProp(napi_env env, napi_value object, const char* name, bool fallback) {
  napi_value value;
  if (!GetProp(env, object, name, &value)) return fallback;
  bool out = fallback;
  napi_get_value_bool(env, value, &out);
  return out;
}

static double GetNullableNumberProp(napi_env env, napi_value object, const char* name, double fallback) {
  napi_value value;
  if (!GetProp(env, object, name, &value)) return fallback;
  napi_valuetype type;
  napi_typeof(env, value, &type);
  if (type == napi_null || type == napi_undefined) return fallback;
  double out = fallback;
  napi_get_value_double(env, value, &out);
  return out;
}

static std::string GetStringProp(napi_env env, napi_value object, const char* name, const char* fallback) {
  napi_value value;
  if (!GetProp(env, object, name, &value)) return fallback;
  size_t len = 0;
  napi_get_value_string_utf8(env, value, nullptr, 0, &len);
  std::vector<char> buffer(len + 1, '\0');
  napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &len);
  return std::string(buffer.data(), len);
}

static PixelFormatKind ParsePixelFormat(const std::string& value) {
  if (value == "rgba16") return PixelFormatKind::Rgba16;
  if (value == "rgbaf32") return PixelFormatKind::Rgbaf32;
  return PixelFormatKind::Rgba8;
}

static const char* PixelFormatName(PixelFormatKind format) {
  switch (format) {
    case PixelFormatKind::Rgba16: return "rgba16";
    case PixelFormatKind::Rgbaf32: return "rgbaf32";
    case PixelFormatKind::Rgba8:
    default: return "rgba8";
  }
}

static uint32_t BitsForFormat(PixelFormatKind format) {
  switch (format) {
    case PixelFormatKind::Rgba16: return 16;
    case PixelFormatKind::Rgbaf32: return 32;
    case PixelFormatKind::Rgba8:
    default: return 8;
  }
}

static size_t BytesPerChannel(PixelFormatKind format) {
  switch (format) {
    case PixelFormatKind::Rgba16: return 2;
    case PixelFormatKind::Rgbaf32: return 4;
    case PixelFormatKind::Rgba8:
    default: return 1;
  }
}

// N-18/N-22: parsed once at DecoderClose; avoids per-site strcmp
enum class ProgressionTarget { Header, Dc, Pass, Final };

static ProgressionTarget ParseProgressionTarget(const std::string& s) {
  if (s == "header") return ProgressionTarget::Header;
  if (s == "dc") return ProgressionTarget::Dc;
  if (s == "pass") return ProgressionTarget::Pass;
  return ProgressionTarget::Final;
}

#if CASABIO_HAVE_LIBJXL
static JxlDataType DataTypeForFormat(PixelFormatKind format) {
  switch (format) {
    case PixelFormatKind::Rgba16: return JXL_TYPE_UINT16;
    case PixelFormatKind::Rgbaf32: return JXL_TYPE_FLOAT;
    case PixelFormatKind::Rgba8:
    default: return JXL_TYPE_UINT8;
  }
}

static uint32_t ExponentBitsForFormat(PixelFormatKind format) {
  return format == PixelFormatKind::Rgbaf32 ? 8u : 0u;
}

static JxlExtraChannelType JxlExtraTypeFromString(const std::string& s) {
  if (s == "alpha") return JXL_CHANNEL_ALPHA;
  if (s == "depth") return JXL_CHANNEL_DEPTH;
  if (s == "spot") return JXL_CHANNEL_SPOT_COLOR;
  if (s == "selection") return JXL_CHANNEL_SELECTION_MASK;
  if (s == "thermal") return JXL_CHANNEL_THERMAL;
  // reserved + unknown map to UNKNOWN (libjxl will treat as custom/forward)
  return JXL_CHANNEL_UNKNOWN;
}

// N-22: single source of truth for extra channel type strings (decode descriptors + reservedN).
// Replaces duplicated if/else in DecodeAll and the previous const-char switch.
static std::string JxlExtraTypeName(JxlExtraChannelType t) {
  switch (t) {
    case JXL_CHANNEL_ALPHA: return "alpha";
    case JXL_CHANNEL_DEPTH: return "depth";
    case JXL_CHANNEL_SPOT_COLOR: return "spot";
    case JXL_CHANNEL_SELECTION_MASK: return "selection";
    case JXL_CHANNEL_THERMAL: return "thermal";
    default: {
      int v = static_cast<int>(t);
      if (v >= 7 && v <= 14) {
        char buf[16];
        snprintf(buf, sizeof(buf), "reserved%d", v - 7);
        return std::string(buf);
      }
      return "unknown";
    }
  }
}
#endif

static bool ReadBytes(napi_env env, napi_value value, std::vector<uint8_t>* out) {
  bool is_typedarray = false;
  napi_is_typedarray(env, value, &is_typedarray);
  if (is_typedarray) {
    napi_typedarray_type type;
    size_t length = 0;
    void* data = nullptr;
    napi_value arraybuffer;
    size_t byte_offset = 0;
    napi_get_typedarray_info(env, value, &type, &length, &data, &arraybuffer, &byte_offset);
    size_t bytes = length;
    if (type == napi_uint16_array || type == napi_int16_array) bytes *= 2;
    if (type == napi_uint32_array || type == napi_int32_array || type == napi_float32_array) bytes *= 4;
    if (type == napi_float64_array || type == napi_bigint64_array || type == napi_biguint64_array) bytes *= 8;
    const auto* begin = static_cast<const uint8_t*>(data);
    out->insert(out->end(), begin, begin + bytes);
    return true;
  }

  bool is_arraybuffer = false;
  napi_is_arraybuffer(env, value, &is_arraybuffer);
  if (is_arraybuffer) {
    void* data = nullptr;
    size_t bytes = 0;
    napi_get_arraybuffer_info(env, value, &data, &bytes);
    const auto* begin = static_cast<const uint8_t*>(data);
    out->insert(out->end(), begin, begin + bytes);
    return true;
  }

  return false;
}

static napi_value MakeArrayBuffer(napi_env env, const uint8_t* bytes, size_t size) {
  void* data = nullptr;
  napi_value out;
  napi_create_arraybuffer(env, size, &data, &out);
  if (size > 0 && bytes != nullptr) memcpy(data, bytes, size);
  return out;
}

static napi_value MakeExtraChannelObject(napi_env env, const ImageInfo::DecodedExtra& ec) {
  napi_value obj;
  napi_create_object(env, &obj);
  napi_set_named_property(env, obj, "type", MakeString(env, ec.type.c_str()));
  napi_set_named_property(env, obj, "bitsPerSample", MakeUint32(env, ec.bits_per_sample));
  if (ec.dim_shift != 0) {
    napi_set_named_property(env, obj, "dimShift", MakeUint32(env, ec.dim_shift));
  }
  if (!ec.name.empty()) {
    napi_set_named_property(env, obj, "name", MakeString(env, ec.name.c_str()));
  }
  if (ec.has_spot) {
    napi_value spot;
    napi_create_object(env, &spot);
    napi_value r; napi_create_double(env, ec.spot_r, &r);
    napi_set_named_property(env, spot, "red", r);
    napi_value g; napi_create_double(env, ec.spot_g, &g);
    napi_set_named_property(env, spot, "green", g);
    napi_value b; napi_create_double(env, ec.spot_b, &b);
    napi_set_named_property(env, spot, "blue", b);
    napi_value s; napi_create_double(env, ec.spot_solidity, &s);
    napi_set_named_property(env, spot, "solidity", s);
    napi_set_named_property(env, obj, "spotColor", spot);
  }
  return obj;
}

static napi_value MakeImageInfo(napi_env env, const ImageInfo& info) {
  napi_value object;
  napi_create_object(env, &object);
  napi_set_named_property(env, object, "width", MakeUint32(env, info.width));
  napi_set_named_property(env, object, "height", MakeUint32(env, info.height));
  napi_set_named_property(env, object, "bitsPerSample", MakeUint32(env, info.bits_per_sample));
  napi_set_named_property(env, object, "hasAlpha", MakeBool(env, info.has_alpha));
  napi_set_named_property(env, object, "hasAnimation", MakeBool(env, info.has_animation));
  napi_set_named_property(env, object, "jpegReconstructionAvailable", MakeBool(env, info.jpeg_reconstruction_available));
  if (!info.extra_channels.empty()) {
    napi_value arr;
    napi_create_array_with_length(env, info.extra_channels.size(), &arr);
    for (size_t i = 0; i < info.extra_channels.size(); ++i) {
      napi_value item = MakeExtraChannelObject(env, info.extra_channels[i]);
      napi_set_element(env, arr, static_cast<uint32_t>(i), item);
    }
    napi_set_named_property(env, object, "extraChannels", arr);
  }
  return object;
}

static napi_ref RefValue(napi_env env, napi_value value) {
  napi_ref ref;
  napi_create_reference(env, value, 1, &ref);
  return ref;
}

static napi_value MakeHeaderEvent(napi_env env, const ImageInfo& info) {
  napi_value event;
  napi_create_object(env, &event);
  napi_set_named_property(env, event, "type", MakeString(env, "header"));
  napi_value infoObj = MakeImageInfo(env, info);
  napi_set_named_property(env, event, "info", infoObj);
  if (!info.extra_channels.empty()) {
    // also expose at event top-level per native DecodeEvent declared shape (parity + compat)
    napi_value extras;
    napi_get_named_property(env, infoObj, "extraChannels", &extras);
    napi_set_named_property(env, event, "extraChannels", extras);
  }
  return event;
}

static napi_value MakeImageEvent(napi_env env, const char* evtType, const char* stage, const ImageInfo& info, PixelFormatKind format, const std::vector<uint8_t>& pixels) {
  napi_value event;
  napi_create_object(env, &event);
  napi_set_named_property(env, event, "type", MakeString(env, evtType));
  napi_set_named_property(env, event, "stage", MakeString(env, stage));
  napi_value infoObj = MakeImageInfo(env, info);
  napi_set_named_property(env, event, "info", infoObj);
  napi_set_named_property(env, event, "pixels", MakeArrayBuffer(env, pixels.data(), pixels.size()));
  napi_set_named_property(env, event, "format", MakeString(env, PixelFormatName(format)));
  napi_set_named_property(env, event, "pixelStride", MakeUint32(env, 4));
  if (!info.extra_channels.empty()) {
    napi_value extras;
    napi_get_named_property(env, infoObj, "extraChannels", &extras);
    napi_set_named_property(env, event, "extraChannels", extras);
  }
  return event;
}

// N-13: zero-copy path for progress/final when we let libjxl write (or flush) straight into a napi ArrayBuffer.
// Regular (non-external) ABs remain detachable for transferList downstream.
static napi_value MakeImageEventWithAB(napi_env env, const char* evtType, const char* stage, const ImageInfo& info, PixelFormatKind format, napi_value pixelsAb) {
  napi_value event;
  napi_create_object(env, &event);
  napi_set_named_property(env, event, "type", MakeString(env, evtType));
  napi_set_named_property(env, event, "stage", MakeString(env, stage));
  napi_value infoObj = MakeImageInfo(env, info);
  napi_set_named_property(env, event, "info", infoObj);
  napi_set_named_property(env, event, "pixels", pixelsAb);
  napi_set_named_property(env, event, "format", MakeString(env, PixelFormatName(format)));
  napi_set_named_property(env, event, "pixelStride", MakeUint32(env, 4));
  if (!info.extra_channels.empty()) {
    napi_value extras;
    napi_get_named_property(env, infoObj, "extraChannels", &extras);
    napi_set_named_property(env, event, "extraChannels", extras);
  }
  return event;
}

static napi_value MakeDoneResult(napi_env env) {
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "done", MakeBool(env, true));
  return result;
}

static napi_value MakeValueResult(napi_env env, napi_value value) {
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "value", value);
  napi_set_named_property(env, result, "done", MakeBool(env, false));
  return result;
}

static napi_value ResolveImmediate(napi_env env, napi_value value) {
  napi_deferred deferred;
  napi_value promise;
  napi_create_promise(env, &deferred, &promise);
  napi_resolve_deferred(env, deferred, value);
  return promise;
}

static napi_value IteratorNext(napi_env env, napi_callback_info info) {
  napi_value this_arg;
  void* raw = nullptr;
  napi_get_cb_info(env, info, nullptr, nullptr, &this_arg, &raw);
  auto* data = static_cast<IteratorData*>(raw);
  if (data == nullptr || data->index >= data->values.size()) {
    return ResolveImmediate(env, MakeDoneResult(env));
  }
  napi_value value;
  napi_get_reference_value(env, data->values[data->index++], &value);
  return ResolveImmediate(env, MakeValueResult(env, value));
}

static napi_value IteratorSelf(napi_env env, napi_callback_info info) {
  napi_value this_arg;
  napi_get_cb_info(env, info, nullptr, nullptr, &this_arg, nullptr);
  return this_arg;
}

static void IteratorFinalize(napi_env env, void* raw, void*) {
  auto* data = static_cast<IteratorData*>(raw);
  if (data == nullptr) return;
  for (napi_ref ref : data->values) napi_delete_reference(env, ref);
  delete data;
}

static napi_value MakeIterator(napi_env env, const std::vector<napi_ref>& refs) {
  auto* data = new IteratorData();
  for (napi_ref ref : refs) {
    napi_value value;
    napi_get_reference_value(env, ref, &value);
    data->values.push_back(RefValue(env, value));
  }

  napi_value iterator;
  napi_create_object(env, &iterator);
  napi_wrap(env, iterator, data, IteratorFinalize, nullptr, nullptr);

  napi_value next;
  napi_create_function(env, "next", NAPI_AUTO_LENGTH, IteratorNext, data, &next);
  napi_set_named_property(env, iterator, "next", next);

  napi_value global;
  napi_get_global(env, &global);
  napi_value symbol_ctor;
  napi_get_named_property(env, global, "Symbol", &symbol_ctor);
  napi_value async_iterator_symbol;
  napi_get_named_property(env, symbol_ctor, "asyncIterator", &async_iterator_symbol);
  napi_value self;
  napi_create_function(env, "[Symbol.asyncIterator]", NAPI_AUTO_LENGTH, IteratorSelf, nullptr, &self);
  napi_set_property(env, iterator, async_iterator_symbol, self);

  return iterator;
}

// ---- Packet-3 Task 4: live (incremental) decoder event iterator ----
//
// Unlike MakeIterator (a snapshot over a fully-materialized vector), the live
// iterator resolves against DecoderData::events as it grows. next() either:
//   (a) yields the event at events_head (advancing the cursor), or
//   (b) if done and drained, resolves {done:true}, or
//   (c) parks a napi_deferred in data->pending_next, resolved later by push()/
//       close()/cancel() when a new event arrives or the stream ends.
//
// Draining an event also relieves backpressure: if a push() promise is parked
// in data->backpressure and the undrained depth has fallen below the HWM, we
// resolve it here so the producer may accept more input.

static const size_t kLiveEventHwm = 8;  // bounded queue high-water mark

// Resolve the parked next() waiter (if any) with the given iterator result.
static void ResolvePendingNext(napi_env env, DecoderData* data, napi_value result) {
  if (data->pending_next == nullptr) return;
  napi_deferred d = data->pending_next;
  data->pending_next = nullptr;
  napi_resolve_deferred(env, d, result);
}

// Relieve backpressure if a producer push() promise is parked and depth dropped.
static void MaybeRelieveBackpressure(napi_env env, DecoderData* data) {
  if (data->backpressure == nullptr) return;
  size_t undrained = data->events.size() - data->events_head;
  if (undrained < kLiveEventHwm || data->done) {
    napi_deferred d = data->backpressure;
    data->backpressure = nullptr;
    napi_value undef;
    napi_get_undefined(env, &undef);
    napi_resolve_deferred(env, d, undef);
  }
}

// Queue an event ref and wake a parked next() waiter if present.
// The ref stays owned by DecoderData::events (released on dispose/finalize).
static void QueueLiveEvent(napi_env env, DecoderData* data, napi_value event) {
  napi_ref ref = RefValue(env, event);
  data->events.push_back(ref);
  if (data->pending_next != nullptr) {
    // Yield this event immediately to the waiter and advance the cursor.
    napi_value result = MakeValueResult(env, event);
    // Advance head past the just-queued event since we are handing it out now.
    // (Only valid because a parked waiter means the cursor was at the tail.)
    data->events_head = data->events.size();
    ResolvePendingNext(env, data, result);
  }
}

// Mark the stream terminated and wake any parked waiter with {done:true}.
static void FinishLiveStream(napi_env env, DecoderData* data) {
  data->done = true;
  if (data->pending_next != nullptr && data->events_head >= data->events.size()) {
    ResolvePendingNext(env, data, MakeDoneResult(env));
  }
  // Unblock any parked producer as well (nothing more will be consumed).
  MaybeRelieveBackpressure(env, data);
}

static napi_value LiveIteratorNext(napi_env env, napi_callback_info info) {
  void* raw = nullptr;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &raw);
  auto* data = static_cast<DecoderData*>(raw);
  if (data == nullptr) return ResolveImmediate(env, MakeDoneResult(env));

  // An event is already available at the cursor -> yield synchronously.
  if (data->events_head < data->events.size()) {
    napi_value value;
    napi_get_reference_value(env, data->events[data->events_head], &value);
    data->events_head++;
    MaybeRelieveBackpressure(env, data);
    return ResolveImmediate(env, MakeValueResult(env, value));
  }

  // Drained. If the stream is finished, we are done.
  if (data->done) {
    return ResolveImmediate(env, MakeDoneResult(env));
  }

  // Otherwise park a single waiter; push()/close() will resolve it.
  napi_deferred deferred;
  napi_value promise;
  napi_create_promise(env, &deferred, &promise);
  // If a previous waiter somehow lingers (should not per sequential contract),
  // resolve it as done to avoid a leak, then install the new one.
  if (data->pending_next != nullptr) {
    napi_deferred stale = data->pending_next;
    data->pending_next = nullptr;
    napi_resolve_deferred(env, stale, MakeDoneResult(env));
  }
  data->pending_next = deferred;
  return promise;
}

static napi_value MakeLiveIterator(napi_env env, DecoderData* data) {
  napi_value iterator;
  napi_create_object(env, &iterator);

  napi_value next;
  napi_create_function(env, "next", NAPI_AUTO_LENGTH, LiveIteratorNext, data, &next);
  napi_set_named_property(env, iterator, "next", next);

  napi_value global;
  napi_get_global(env, &global);
  napi_value symbol_ctor;
  napi_get_named_property(env, global, "Symbol", &symbol_ctor);
  napi_value async_iterator_symbol;
  napi_get_named_property(env, symbol_ctor, "asyncIterator", &async_iterator_symbol);
  napi_value self;
  napi_create_function(env, "[Symbol.asyncIterator]", NAPI_AUTO_LENGTH, IteratorSelf, nullptr, &self);
  napi_set_property(env, iterator, async_iterator_symbol, self);

  return iterator;
}

#if CASABIO_HAVE_LIBJXL
struct EffectiveRegion {
  uint32_t rx = 0;
  uint32_t ry = 0;
  uint32_t rw = 0;
  uint32_t rh = 0;
};

static bool fused_dims(const ImageInfo& info, const Region* region, uint32_t ds, uint32_t* dw, uint32_t* dh, EffectiveRegion* eff) {
  uint32_t rx = region ? region->x : 0;
  uint32_t ry = region ? region->y : 0;
  uint32_t rw = region ? region->w : info.width;
  uint32_t rh = region ? region->h : info.height;

  if (rx >= info.width || ry >= info.height || rw == 0 || rh == 0) {
    *dw = 0;
    *dh = 0;
    return false;
  }
  rw = std::min(rw, info.width - rx);
  rh = std::min(rh, info.height - ry);

  if (rw == 0 || rh == 0) {
    *dw = 0;
    *dh = 0;
    return false;
  }

  eff->rx = rx;
  eff->ry = ry;
  eff->rw = rw;
  eff->rh = rh;

  if (ds <= 1) {
    *dw = rw;
    *dh = rh;
  } else {
    *dw = std::max(1u, (rw + ds - 1u) / ds);
    *dh = std::max(1u, (rh + ds - 1u) / ds);
  }
  return true;
}

static void transform_fused_into(const uint8_t* src, ImageInfo& info, const EffectiveRegion& eff, uint32_t ds, PixelFormatKind fmt, uint8_t* dest) {
  const uint32_t bpc = BytesPerChannel(fmt);
  const uint32_t bpp = 4u * bpc;
  const uint32_t sw = info.width;

  if (ds <= 1) {
    const size_t src_row_bytes = static_cast<size_t>(sw) * bpp;
    const size_t dest_row_bytes = static_cast<size_t>(eff.rw) * bpp;
    for (uint32_t y = 0; y < eff.rh; ++y) {
      const uint8_t* src_row = src + (eff.ry + y) * src_row_bytes + eff.rx * bpp;
      uint8_t* dest_row = dest + y * dest_row_bytes;
      std::memcpy(dest_row, src_row, dest_row_bytes);
    }
    info.width = eff.rw;
    info.height = eff.rh;
    return;
  }

  const uint32_t dw = std::max(1u, (eff.rw + ds - 1u) / ds);
  const uint32_t dh = std::max(1u, (eff.rh + ds - 1u) / ds);

  const size_t src_row_bytes = static_cast<size_t>(sw) * bpp;
  const size_t dest_row_bytes = static_cast<size_t>(dw) * bpp;

  if (fmt == PixelFormatKind::Rgba8) {
    if (ds == 2) {
      uint32_t interior_h = eff.rh / 2;
      uint32_t interior_w = eff.rw / 2;

      for (uint32_t y = 0; y < interior_h; ++y) {
        uint32_t sy0 = eff.ry + y * 2;
        uint32_t sy1 = sy0 + 1;
        const uint8_t* row0 = src + sy0 * src_row_bytes;
        const uint8_t* row1 = src + sy1 * src_row_bytes;
        uint8_t* dest_row = dest + y * dest_row_bytes;

        for (uint32_t x = 0; x < interior_w; ++x) {
          uint32_t sx0 = eff.rx + x * 2;
          const uint8_t* p00 = row0 + sx0 * 4;
          const uint8_t* p01 = p00 + 4;
          const uint8_t* p10 = row1 + sx0 * 4;
          const uint8_t* p11 = p10 + 4;

          dest_row[x * 4 + 0] = (p00[0] + p01[0] + p10[0] + p11[0] + 2) >> 2;
          dest_row[x * 4 + 1] = (p00[1] + p01[1] + p10[1] + p11[1] + 2) >> 2;
          dest_row[x * 4 + 2] = (p00[2] + p01[2] + p10[2] + p11[2] + 2) >> 2;
          dest_row[x * 4 + 3] = (p00[3] + p01[3] + p10[3] + p11[3] + 2) >> 2;
        }

        if (interior_w < dw) {
          uint32_t x = interior_w;
          uint32_t sx0 = eff.rx + x * 2;
          const uint8_t* p00 = row0 + sx0 * 4;
          const uint8_t* p10 = row1 + sx0 * 4;
          dest_row[x * 4 + 0] = (p00[0] + p10[0] + 1) >> 1;
          dest_row[x * 4 + 1] = (p00[1] + p10[1] + 1) >> 1;
          dest_row[x * 4 + 2] = (p00[2] + p10[2] + 1) >> 1;
          dest_row[x * 4 + 3] = (p00[3] + p10[3] + 1) >> 1;
        }
      }

      if (interior_h < dh) {
        uint32_t y = interior_h;
        uint32_t sy0 = eff.ry + y * 2;
        const uint8_t* row0 = src + sy0 * src_row_bytes;
        uint8_t* dest_row = dest + y * dest_row_bytes;

        for (uint32_t x = 0; x < interior_w; ++x) {
          uint32_t sx0 = eff.rx + x * 2;
          const uint8_t* p00 = row0 + sx0 * 4;
          const uint8_t* p01 = p00 + 4;
          dest_row[x * 4 + 0] = (p00[0] + p01[0] + 1) >> 1;
          dest_row[x * 4 + 1] = (p00[1] + p01[1] + 1) >> 1;
          dest_row[x * 4 + 2] = (p00[2] + p01[2] + 1) >> 1;
          dest_row[x * 4 + 3] = (p00[3] + p01[3] + 1) >> 1;
        }

        if (interior_w < dw) {
          uint32_t x = interior_w;
          uint32_t sx0 = eff.rx + x * 2;
          const uint8_t* p00 = row0 + sx0 * 4;
          dest_row[x * 4 + 0] = p00[0];
          dest_row[x * 4 + 1] = p00[1];
          dest_row[x * 4 + 2] = p00[2];
          dest_row[x * 4 + 3] = p00[3];
        }
      }
    } else {
      // General downsample for Rgba8
      for (uint32_t y = 0; y < dh; ++y) {
        uint8_t* dest_row = dest + y * dest_row_bytes;
        for (uint32_t x = 0; x < dw; ++x) {
          uint32_t sum[4] = {0};
          uint32_t cnt = 0;
          for (uint32_t yy = 0; yy < ds; ++yy) {
            uint32_t sy = eff.ry + y * ds + yy;
            if (sy >= eff.ry + eff.rh) break;
            const uint8_t* src_row = src + sy * src_row_bytes;
            for (uint32_t xx = 0; xx < ds; ++xx) {
              uint32_t sx = eff.rx + x * ds + xx;
              if (sx >= eff.rx + eff.rw) break;
              const uint8_t* p = src_row + sx * 4;
              sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; sum[3] += p[3];
              cnt++;
            }
          }
          if (cnt > 0) {
            dest_row[x * 4 + 0] = (sum[0] + (cnt >> 1)) / cnt;
            dest_row[x * 4 + 1] = (sum[1] + (cnt >> 1)) / cnt;
            dest_row[x * 4 + 2] = (sum[2] + (cnt >> 1)) / cnt;
            dest_row[x * 4 + 3] = (sum[3] + (cnt >> 1)) / cnt;
          }
        }
      }
    }
  } else if (fmt == PixelFormatKind::Rgba16) {
    if (ds == 2) {
      uint32_t interior_h = eff.rh / 2;
      uint32_t interior_w = eff.rw / 2;

      for (uint32_t y = 0; y < interior_h; ++y) {
        uint32_t sy0 = eff.ry + y * 2;
        uint32_t sy1 = sy0 + 1;
        const uint16_t* row0 = reinterpret_cast<const uint16_t*>(src + sy0 * src_row_bytes);
        const uint16_t* row1 = reinterpret_cast<const uint16_t*>(src + sy1 * src_row_bytes);
        uint16_t* dest_row = reinterpret_cast<uint16_t*>(dest + y * dest_row_bytes);

        for (uint32_t x = 0; x < interior_w; ++x) {
          uint32_t sx0 = eff.rx + x * 2;
          const uint16_t* p00 = row0 + sx0 * 4;
          const uint16_t* p01 = p00 + 4;
          const uint16_t* p10 = row1 + sx0 * 4;
          const uint16_t* p11 = p10 + 4;

          dest_row[x * 4 + 0] = (p00[0] + p01[0] + p10[0] + p11[0] + 2) >> 2;
          dest_row[x * 4 + 1] = (p00[1] + p01[1] + p10[1] + p11[1] + 2) >> 2;
          dest_row[x * 4 + 2] = (p00[2] + p01[2] + p10[2] + p11[2] + 2) >> 2;
          dest_row[x * 4 + 3] = (p00[3] + p01[3] + p10[3] + p11[3] + 2) >> 2;
        }

        if (interior_w < dw) {
          uint32_t x = interior_w;
          uint32_t sx0 = eff.rx + x * 2;
          const uint16_t* p00 = row0 + sx0 * 4;
          const uint16_t* p10 = row1 + sx0 * 4;
          dest_row[x * 4 + 0] = (p00[0] + p10[0] + 1) >> 1;
          dest_row[x * 4 + 1] = (p00[1] + p10[1] + 1) >> 1;
          dest_row[x * 4 + 2] = (p00[2] + p10[2] + 1) >> 1;
          dest_row[x * 4 + 3] = (p00[3] + p10[3] + 1) >> 1;
        }
      }

      if (interior_h < dh) {
        uint32_t y = interior_h;
        uint32_t sy0 = eff.ry + y * 2;
        const uint16_t* row0 = reinterpret_cast<const uint16_t*>(src + sy0 * src_row_bytes);
        uint16_t* dest_row = reinterpret_cast<uint16_t*>(dest + y * dest_row_bytes);

        for (uint32_t x = 0; x < interior_w; ++x) {
          uint32_t sx0 = eff.rx + x * 2;
          const uint16_t* p00 = row0 + sx0 * 4;
          const uint16_t* p01 = p00 + 4;
          dest_row[x * 4 + 0] = (p00[0] + p01[0] + 1) >> 1;
          dest_row[x * 4 + 1] = (p00[1] + p01[1] + 1) >> 1;
          dest_row[x * 4 + 2] = (p00[2] + p01[2] + 1) >> 1;
          dest_row[x * 4 + 3] = (p00[3] + p01[3] + 1) >> 1;
        }

        if (interior_w < dw) {
          uint32_t x = interior_w;
          uint32_t sx0 = eff.rx + x * 2;
          const uint16_t* p00 = row0 + sx0 * 4;
          dest_row[x * 4 + 0] = p00[0];
          dest_row[x * 4 + 1] = p00[1];
          dest_row[x * 4 + 2] = p00[2];
          dest_row[x * 4 + 3] = p00[3];
        }
      }
    } else {
      for (uint32_t y = 0; y < dh; ++y) {
        uint16_t* dest_row = reinterpret_cast<uint16_t*>(dest + y * dest_row_bytes);
        for (uint32_t x = 0; x < dw; ++x) {
          uint32_t sum[4] = {0};
          uint32_t cnt = 0;
          for (uint32_t yy = 0; yy < ds; ++yy) {
            uint32_t sy = eff.ry + y * ds + yy;
            if (sy >= eff.ry + eff.rh) break;
            const uint16_t* src_row = reinterpret_cast<const uint16_t*>(src + sy * src_row_bytes);
            for (uint32_t xx = 0; xx < ds; ++xx) {
              uint32_t sx = eff.rx + x * ds + xx;
              if (sx >= eff.rx + eff.rw) break;
              const uint16_t* p = src_row + sx * 4;
              sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; sum[3] += p[3];
              cnt++;
            }
          }
          if (cnt > 0) {
            dest_row[x * 4 + 0] = (sum[0] + (cnt >> 1)) / cnt;
            dest_row[x * 4 + 1] = (sum[1] + (cnt >> 1)) / cnt;
            dest_row[x * 4 + 2] = (sum[2] + (cnt >> 1)) / cnt;
            dest_row[x * 4 + 3] = (sum[3] + (cnt >> 1)) / cnt;
          }
        }
      }
    }
  } else { // rgbaf32
    if (ds == 2) {
      uint32_t interior_h = eff.rh / 2;
      uint32_t interior_w = eff.rw / 2;

      for (uint32_t y = 0; y < interior_h; ++y) {
        uint32_t sy0 = eff.ry + y * 2;
        uint32_t sy1 = sy0 + 1;
        const float* row0 = reinterpret_cast<const float*>(src + sy0 * src_row_bytes);
        const float* row1 = reinterpret_cast<const float*>(src + sy1 * src_row_bytes);
        float* dest_row = reinterpret_cast<float*>(dest + y * dest_row_bytes);

        for (uint32_t x = 0; x < interior_w; ++x) {
          uint32_t sx0 = eff.rx + x * 2;
          const float* p00 = row0 + sx0 * 4;
          const float* p01 = p00 + 4;
          const float* p10 = row1 + sx0 * 4;
          const float* p11 = p10 + 4;

          dest_row[x * 4 + 0] = (p00[0] + p01[0] + p10[0] + p11[0]) * 0.25f;
          dest_row[x * 4 + 1] = (p00[1] + p01[1] + p10[1] + p11[1]) * 0.25f;
          dest_row[x * 4 + 2] = (p00[2] + p01[2] + p10[2] + p11[2]) * 0.25f;
          dest_row[x * 4 + 3] = (p00[3] + p01[3] + p10[3] + p11[3]) * 0.25f;
        }

        if (interior_w < dw) {
          uint32_t x = interior_w;
          uint32_t sx0 = eff.rx + x * 2;
          const float* p00 = row0 + sx0 * 4;
          const float* p10 = row1 + sx0 * 4;
          dest_row[x * 4 + 0] = (p00[0] + p10[0]) * 0.5f;
          dest_row[x * 4 + 1] = (p00[1] + p10[1]) * 0.5f;
          dest_row[x * 4 + 2] = (p00[2] + p10[2]) * 0.5f;
          dest_row[x * 4 + 3] = (p00[3] + p10[3]) * 0.5f;
        }
      }

      if (interior_h < dh) {
        uint32_t y = interior_h;
        uint32_t sy0 = eff.ry + y * 2;
        const float* row0 = reinterpret_cast<const float*>(src + sy0 * src_row_bytes);
        float* dest_row = reinterpret_cast<float*>(dest + y * dest_row_bytes);

        for (uint32_t x = 0; x < interior_w; ++x) {
          uint32_t sx0 = eff.rx + x * 2;
          const float* p00 = row0 + sx0 * 4;
          const float* p01 = p00 + 4;
          dest_row[x * 4 + 0] = (p00[0] + p01[0]) * 0.5f;
          dest_row[x * 4 + 1] = (p00[1] + p01[1]) * 0.5f;
          dest_row[x * 4 + 2] = (p00[2] + p01[2]) * 0.5f;
          dest_row[x * 4 + 3] = (p00[3] + p01[3]) * 0.5f;
        }

        if (interior_w < dw) {
          uint32_t x = interior_w;
          uint32_t sx0 = eff.rx + x * 2;
          const float* p00 = row0 + sx0 * 4;
          dest_row[x * 4 + 0] = p00[0];
          dest_row[x * 4 + 1] = p00[1];
          dest_row[x * 4 + 2] = p00[2];
          dest_row[x * 4 + 3] = p00[3];
        }
      }
    } else {
      for (uint32_t y = 0; y < dh; ++y) {
        float* dest_row = reinterpret_cast<float*>(dest + y * dest_row_bytes);
        for (uint32_t x = 0; x < dw; ++x) {
          float sum[4] = {0.f};
          uint32_t cnt = 0;
          for (uint32_t yy = 0; yy < ds; ++yy) {
            uint32_t sy = eff.ry + y * ds + yy;
            if (sy >= eff.ry + eff.rh) break;
            const float* src_row = reinterpret_cast<const float*>(src + sy * src_row_bytes);
            for (uint32_t xx = 0; xx < ds; ++xx) {
              uint32_t sx = eff.rx + x * ds + xx;
              if (sx >= eff.rx + eff.rw) break;
              const float* p = src_row + sx * 4;
              sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; sum[3] += p[3];
              cnt++;
            }
          }
          if (cnt > 0) {
            float f_cnt = static_cast<float>(cnt);
            dest_row[x * 4 + 0] = sum[0] / f_cnt;
            dest_row[x * 4 + 1] = sum[1] / f_cnt;
            dest_row[x * 4 + 2] = sum[2] / f_cnt;
            dest_row[x * 4 + 3] = sum[3] / f_cnt;
          }
        }
      }
    }
  }

  info.width = dw;
  info.height = dh;
}

// ============================================================================
// Packet-3 Task 4 (finding 20): live / incremental decode
// ============================================================================
//
// Previously DecodeAll ran the whole decode at close() and materialized every
// event before events() could yield anything. LiveDecodeState makes the decoder
// resumable: a persistent JxlDecoder consumes the accumulated input as far as it
// can on each push(), queueing events (header first, then progression/frames)
// into DecoderData::events via QueueLiveEvent — so a consumer draining events()
// sees the header/progress events BEFORE close(). The final full image still
// arrives once all input has been pushed (libjxl cannot produce it earlier),
// but it is emitted as soon as the last needed bytes arrive, which for a
// single-shot close() is the same moment as before.
//
// Output equality: the per-pixel transform (region/downsample/EC/animation) is
// the SAME code path as DecodeAll — factored into shared helpers used by both.
// The batch DecodeAll is retained as the reference/fallback (opts that the live
// path does not yet specialize fall back to it at close()).
//
// N-20 gate: extra-channel plane extraction stays behind opt-in so the common
// RGBA path pays zero.
// GAP NOTATION: extraPlanes attaches only to the non-animation final event; for
// animation the EC buffers are overwritten per frame and are not emitted.

struct LiveDecodeState {
  JxlDecoder* dec = nullptr;
#if CASABIO_HAVE_JXL_THREADS
  void* runner = nullptr;
#endif

  // Decode options captured at first push.
  PixelFormatKind format = PixelFormatKind::Rgba8;
  ProgressionTarget target = ProgressionTarget::Final;
  bool emit_every_pass = false;
  bool decode_extra_channels = false;
  std::string progressive_detail;
  Region region{};
  bool has_region = false;
  uint32_t downsample = 1;
  bool preserve_icc = false;
  uint64_t max_pixels = 0;

  // Accumulated, not-yet-consumed input. libjxl retains a pointer into this
  // buffer between ProcessInput calls, so we must keep the *unconsumed* suffix
  // stable. We compact consumed bytes off the front between pushes.
  std::vector<uint8_t> pending;
  bool input_set = false;   // JxlDecoderSetInput currently active on `pending`
  bool input_closed = false;

  // Resumable loop state (hoisted from DecodeAll locals).
  JxlBasicInfo basic{};
  ImageInfo info{};
  bool info_known = false;
  bool header_emitted = false;
  std::vector<uint8_t> icc_bytes;

  // The main image-out ArrayBuffer is allocated at NEED_IMAGE_OUT_BUFFER and may
  // be read back at FULL_IMAGE in a *later* push()/close() native call. napi_value
  // handles are only valid within the native call that created them, so we hold a
  // persistent napi_ref across calls and re-deref to a napi_value on use.
  // main_data (the raw backing pointer) stays stable for the AB's lifetime and is
  // safe to cache — libjxl writes into it directly.
  napi_ref main_ab_ref = nullptr;
  void* main_data = nullptr;
  size_t main_size = 0;
  bool have_main_ab = false;

  std::vector<std::vector<uint8_t>> ec_planes;

  uint32_t current_frame_index = 0;
  uint32_t current_frame_duration = 0;
  std::string current_frame_name;

  // Animation: we cannot know which FULL_IMAGE is the terminal frame until
  // SUCCESS, and the batch contract labels only the LAST frame "final" (with
  // animTicksPerSecond) while earlier frames are "progress". So we hold the most
  // recent animation frame back by one: when a new frame arrives, the previously
  // held one is flushed as "progress"; at SUCCESS the held frame becomes "final".
  bool has_held_frame = false;
  napi_ref held_frame_ref = nullptr;   // pins the held frame AB across calls
  ImageInfo held_info{};
  uint32_t held_index = 0;
  uint32_t held_duration = 0;
  std::string held_name;

  bool final_emitted = false;
};

static void DestroyLiveState(napi_env env, LiveDecodeState* st) {
  if (st == nullptr) return;
  if (st->held_frame_ref != nullptr) {
    napi_delete_reference(env, st->held_frame_ref);
    st->held_frame_ref = nullptr;
  }
  if (st->main_ab_ref != nullptr) {
    napi_delete_reference(env, st->main_ab_ref);
    st->main_ab_ref = nullptr;
  }
  if (st->dec != nullptr) {
    JxlDecoderDestroy(st->dec);
    st->dec = nullptr;
  }
#if CASABIO_HAVE_JXL_THREADS
  if (st->runner != nullptr) {
    JxlThreadParallelRunnerDestroy(st->runner);
    st->runner = nullptr;
  }
#endif
  delete st;
}

enum class StepResult { NeedMore, Done, Error };

// Emit the header event into the live queue exactly once.
static void LiveEmitHeader(napi_env env, DecoderData* data, LiveDecodeState* st) {
  if (st->header_emitted) return;
  napi_value header = MakeHeaderEvent(env, st->info);
  if (!st->icc_bytes.empty()) {
    napi_value icc_ab = MakeArrayBuffer(env, st->icc_bytes.data(), st->icc_bytes.size());
    napi_set_named_property(env, header, "iccProfile", icc_ab);
  }
  QueueLiveEvent(env, data, header);
  st->header_emitted = true;
}

static void LiveEmitError(napi_env env, DecoderData* data, const char* code, const char* message) {
  // Only the FIRST terminal error is recorded/queued; later ones are ignored so
  // close() rejects with the true root cause (e.g. "image exceeds maxPixels"
  // rather than a downstream generic failure).
  if (data->errored) return;
  napi_value ev;
  napi_create_object(env, &ev);
  napi_set_named_property(env, ev, "type", MakeString(env, "error"));
  napi_set_named_property(env, ev, "code", MakeString(env, code));
  napi_set_named_property(env, ev, "message", MakeString(env, message));
  QueueLiveEvent(env, data, ev);
  data->errored = true;
  data->error_code = code;
  data->error_message = message;
}

// Build a rejected promise carrying the recorded terminal error's message + code,
// so close()'s rejection matches the batch behaviour (e.g. the exact
// "image exceeds maxPixels" / "libjxl decode truncated ..." text).
static napi_value RejectWithLiveError(napi_env env, DecoderData* data) {
  napi_deferred deferred;
  napi_value promise;
  napi_create_promise(env, &deferred, &promise);
  const char* msg = data->error_message.empty() ? "libjxl decode failed" : data->error_message.c_str();
  napi_value msgv;
  napi_create_string_utf8(env, msg, NAPI_AUTO_LENGTH, &msgv);
  napi_value err;
  napi_create_error(env, nullptr, msgv, &err);
  if (!data->error_code.empty()) {
    napi_set_named_property(env, err, "code", MakeString(env, data->error_code.c_str()));
  }
  napi_reject_deferred(env, deferred, err);
  return promise;
}

// Attach region echo (NV-21) to an image event.
static void AttachRegionEcho(napi_env env, napi_value ev, const Region* region, const ImageInfo& info) {
  napi_value rgn;
  napi_create_object(env, &rgn);
  napi_set_named_property(env, rgn, "x", MakeUint32(env, region->x));
  napi_set_named_property(env, rgn, "y", MakeUint32(env, region->y));
  napi_set_named_property(env, rgn, "w", MakeUint32(env, info.width));
  napi_set_named_property(env, rgn, "h", MakeUint32(env, info.height));
  napi_set_named_property(env, ev, "region", rgn);
}

// Flush the held-back animation frame (if any) as a "progress" event. Used when
// a new frame arrives (the previous one is now known not to be terminal).
static void FlushHeldFrameAsProgress(napi_env env, DecoderData* data, LiveDecodeState* st) {
  if (!st->has_held_frame) return;
  napi_value pixels_ab;
  napi_get_reference_value(env, st->held_frame_ref, &pixels_ab);
  napi_value ev = MakeImageEventWithAB(env, "progress", "progress", st->held_info, st->format, pixels_ab);
  napi_set_named_property(env, ev, "frameIndex", MakeUint32(env, st->held_index));
  napi_set_named_property(env, ev, "frameDuration", MakeUint32(env, st->held_duration));
  if (!st->held_name.empty()) {
    napi_set_named_property(env, ev, "frameName", MakeString(env, st->held_name.c_str()));
  }
  if (st->has_region) AttachRegionEcho(env, ev, st->has_region ? &st->region : nullptr, st->held_info);
  QueueLiveEvent(env, data, ev);
  napi_delete_reference(env, st->held_frame_ref);
  st->held_frame_ref = nullptr;
  st->has_held_frame = false;
}

// Promote the held-back animation frame to the terminal "final" event.
static void EmitHeldFrameAsFinal(napi_env env, DecoderData* data, LiveDecodeState* st) {
  if (!st->has_held_frame) return;
  napi_value pixels_ab;
  napi_get_reference_value(env, st->held_frame_ref, &pixels_ab);
  napi_value ev = MakeImageEventWithAB(env, "final", "final", st->held_info, st->format, pixels_ab);
  napi_set_named_property(env, ev, "frameIndex", MakeUint32(env, st->held_index));
  napi_set_named_property(env, ev, "frameDuration", MakeUint32(env, st->held_duration));
  if (!st->held_name.empty()) {
    napi_set_named_property(env, ev, "frameName", MakeString(env, st->held_name.c_str()));
  }
  double tps_den = st->basic.animation.tps_denominator > 0
      ? static_cast<double>(st->basic.animation.tps_denominator) : 1.0;
  double tps = static_cast<double>(st->basic.animation.tps_numerator) / tps_den;
  if (tps <= 0.0) tps = 1.0;
  napi_value tps_val;
  napi_create_double(env, tps, &tps_val);
  napi_set_named_property(env, ev, "animTicksPerSecond", tps_val);
  if (st->has_region) AttachRegionEcho(env, ev, st->has_region ? &st->region : nullptr, st->held_info);
  QueueLiveEvent(env, data, ev);
  napi_delete_reference(env, st->held_frame_ref);
  st->held_frame_ref = nullptr;
  st->has_held_frame = false;
  st->final_emitted = true;
}

// Feed the currently-accumulated `pending` bytes to libjxl and process as far
// as possible. Queues header/progress/frame/final events as they are produced.
// Returns NeedMore (waiting for more input), Done (final produced / SUCCESS), or
// Error (a terminal error was queued). Never blocks.
static StepResult ProcessDecodeAvailable(napi_env env, DecoderData* data, LiveDecodeState* st) {
  JxlDecoder* dec = st->dec;
  JxlPixelFormat pf = {4, DataTypeForFormat(st->format), JXL_NATIVE_ENDIAN, 0};
  const Region* region = st->has_region ? &st->region : nullptr;
  uint32_t ds = (st->downsample >= 1 && st->downsample <= 8) ? st->downsample : 1u;
  bool needs_xform = st->has_region || (ds > 1u);

  // (Re)establish libjxl's input pointer against the current pending buffer.
  if (!st->input_set) {
    JxlDecoderSetInput(dec, st->pending.data(), st->pending.size());
    st->input_set = true;
    if (st->input_closed) {
      JxlDecoderCloseInput(dec);
    }
  }

  for (;;) {
    JxlDecoderStatus status = JxlDecoderProcessInput(dec);

    if (status == JXL_DEC_ERROR) {
      LiveEmitError(env, data, "InvalidJXL", "libjxl decode error (DEC_ERROR)");
      return StepResult::Error;
    }

    if (status == JXL_DEC_NEED_MORE_INPUT) {
      // Release consumed bytes and compact the unconsumed suffix to the front so
      // the next push appends contiguously and libjxl's retained pointer stays valid.
      size_t remaining = JxlDecoderReleaseInput(dec);
      st->input_set = false;
      if (remaining < st->pending.size()) {
        st->pending.erase(st->pending.begin(),
                          st->pending.begin() + (st->pending.size() - remaining));
      }
      if (st->input_closed) {
        // Input already closed but libjxl wants more -> truncated stream.
        LiveEmitError(env, data, "TruncatedInput",
                      "libjxl decode truncated (NEED_MORE_INPUT after close)");
        return StepResult::Error;
      }
      return StepResult::NeedMore;
    }

    if (status == JXL_DEC_SUCCESS) {
      // Promote the last held animation frame to the terminal "final".
      if (st->basic.have_animation) {
        EmitHeldFrameAsFinal(env, data, st);
      }
      return StepResult::Done;
    }

    if (status == JXL_DEC_BASIC_INFO) {
      if (JxlDecoderGetBasicInfo(dec, &st->basic) != JXL_DEC_SUCCESS) {
        LiveEmitError(env, data, "DecodeFailed", "JxlDecoderGetBasicInfo failed");
        return StepResult::Error;
      }
      uint64_t px = static_cast<uint64_t>(st->basic.xsize) * st->basic.ysize;
      if (px > st->max_pixels) {
        LiveEmitError(env, data, "ImageTooLarge", "image exceeds maxPixels");
        return StepResult::Error;
      }
      st->info.width = st->basic.xsize;
      st->info.height = st->basic.ysize;
      st->info.bits_per_sample = BitsForFormat(st->format);
      st->info.has_alpha = st->basic.alpha_bits > 0;
      st->info.has_animation = st->basic.have_animation;
      st->info.jpeg_reconstruction_available = false;

      uint32_t n_ec = st->basic.num_extra_channels;
      for (uint32_t i = 0; i < n_ec; ++i) {
        JxlExtraChannelInfo ei{};
        if (JxlDecoderGetExtraChannelInfo(dec, i, &ei) == JXL_DEC_SUCCESS) {
          ImageInfo::DecodedExtra d{};
          d.type = JxlExtraTypeName(ei.type);
          d.bits_per_sample = ei.bits_per_sample;
          d.dim_shift = ei.dim_shift;
          if (ei.type == JXL_CHANNEL_SPOT_COLOR) {
            d.has_spot = true;
            d.spot_r = ei.spot_color[0];
            d.spot_g = ei.spot_color[1];
            d.spot_b = ei.spot_color[2];
            d.spot_solidity = ei.spot_color[3];
          }
          if (ei.name_length > 0) {
            std::vector<char> nm(ei.name_length + 1, '\0');
            if (JxlDecoderGetExtraChannelName(dec, i, nm.data(), nm.size()) == JXL_DEC_SUCCESS) {
              d.name.assign(nm.data(), ei.name_length);
            }
          }
          st->info.extra_channels.push_back(d);
        }
      }
      if (st->decode_extra_channels && n_ec > 0) {
        st->ec_planes.assign(n_ec, std::vector<uint8_t>());
      }
      st->info_known = true;
      if (!st->preserve_icc) {
        LiveEmitHeader(env, data, st);
        if (st->target == ProgressionTarget::Header) return StepResult::Done;
      }
      continue;
    }

    if (status == JXL_DEC_COLOR_ENCODING) {
      size_t icc_size = 0;
      if (JxlDecoderGetICCProfileSize(dec, JXL_COLOR_PROFILE_TARGET_DATA, &icc_size) == JXL_DEC_SUCCESS && icc_size > 0) {
        st->icc_bytes.resize(icc_size);
        if (JxlDecoderGetColorAsICCProfile(dec, JXL_COLOR_PROFILE_TARGET_DATA, st->icc_bytes.data(), icc_size) != JXL_DEC_SUCCESS) {
          st->icc_bytes.clear();
        }
      }
      LiveEmitHeader(env, data, st);
      if (st->target == ProgressionTarget::Header) return StepResult::Done;
      continue;
    }

    if (status == JXL_DEC_FRAME) {
      if (st->basic.have_animation) {
        JxlFrameHeader fh;
        if (JxlDecoderGetFrameHeader(dec, &fh) == JXL_DEC_SUCCESS) {
          st->current_frame_duration = fh.duration;
          st->current_frame_name.clear();
          if (fh.name_length > 0) {
            std::vector<char> fnm(fh.name_length + 1, '\0');
            if (JxlDecoderGetFrameName(dec, fnm.data(), fnm.size()) == JXL_DEC_SUCCESS) {
              st->current_frame_name.assign(fnm.data(), fh.name_length);
            }
          }
        }
      }
      continue;
    }

    if (status == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      LiveEmitHeader(env, data, st);
      size_t buffer_size = 0;
      if (JxlDecoderImageOutBufferSize(dec, &pf, &buffer_size) != JXL_DEC_SUCCESS) {
        LiveEmitError(env, data, "DecodeFailed", "JxlDecoderImageOutBufferSize failed");
        return StepResult::Error;
      }
      // Allocate the image-out AB and pin it with a strong ref so it survives to
      // the FULL_IMAGE handler, which may run in a later native call. For
      // animation a fresh AB is allocated per frame (NEED_IMAGE_OUT_BUFFER fires
      // per frame); release the previous frame's pin first.
      if (st->main_ab_ref != nullptr) {
        napi_delete_reference(env, st->main_ab_ref);
        st->main_ab_ref = nullptr;
      }
      napi_value main_ab_local = nullptr;
      napi_create_arraybuffer(env, buffer_size, &st->main_data, &main_ab_local);
      napi_create_reference(env, main_ab_local, 1, &st->main_ab_ref);
      st->have_main_ab = true;
      st->main_size = buffer_size;
      if (JxlDecoderSetImageOutBuffer(dec, &pf, st->main_data, st->main_size) != JXL_DEC_SUCCESS) {
        LiveEmitError(env, data, "DecodeFailed", "JxlDecoderSetImageOutBuffer failed");
        return StepResult::Error;
      }
      if (st->decode_extra_channels && !st->ec_planes.empty()) {
        for (uint32_t i = 0; i < st->ec_planes.size(); ++i) {
          uint32_t bps = (i < st->info.extra_channels.size() && st->info.extra_channels[i].bits_per_sample)
                             ? st->info.extra_channels[i].bits_per_sample : 8u;
          JxlDataType dt = (bps == 16) ? JXL_TYPE_UINT16 : (bps > 16 ? JXL_TYPE_FLOAT : JXL_TYPE_UINT8);
          JxlPixelFormat pf_ec = {1, dt, JXL_NATIVE_ENDIAN, 0};
          size_t ec_size = 0;
          if (JxlDecoderExtraChannelBufferSize(dec, &pf_ec, &ec_size, i) == JXL_DEC_SUCCESS && ec_size > 0) {
            st->ec_planes[i].resize(ec_size);
            JxlDecoderSetExtraChannelBuffer(dec, &pf_ec, st->ec_planes[i].data(), ec_size, i);
          }
        }
      }
      continue;
    }

    if (status == JXL_DEC_FRAME_PROGRESSION && st->info_known && st->have_main_ab) {
      LiveEmitHeader(env, data, st);
      const char* prog_stage = (st->target == ProgressionTarget::Dc) ? "dc" : "pass";
      napi_value prog_ev_ab = nullptr;
      ImageInfo ev_info = st->info;
      if (needs_xform) {
        void* snap = nullptr;
        napi_value snap_ab;
        napi_create_arraybuffer(env, st->main_size, &snap, &snap_ab);
        bool flushed = JxlDecoderSetImageOutBuffer(dec, &pf, snap, st->main_size) == JXL_DEC_SUCCESS &&
                       JxlDecoderFlushImage(dec) == JXL_DEC_SUCCESS;
        JxlDecoderSetImageOutBuffer(dec, &pf, st->main_data, st->main_size);
        if (flushed) {
          uint32_t dw = 0, dh = 0;
          EffectiveRegion eff;
          if (fused_dims(ev_info, region, ds, &dw, &dh, &eff)) {
            void* outd = nullptr;
            napi_value out_ab;
            napi_create_arraybuffer(env, static_cast<size_t>(dw) * dh * 4u * BytesPerChannel(st->format), &outd, &out_ab);
            if (outd) {
              transform_fused_into(static_cast<const uint8_t*>(snap), ev_info, eff, ds, st->format, static_cast<uint8_t*>(outd));
            }
            prog_ev_ab = out_ab;
          }
        }
      } else {
        void* snap = nullptr;
        napi_value snap_ab;
        napi_create_arraybuffer(env, st->main_size, &snap, &snap_ab);
        bool flushed = JxlDecoderSetImageOutBuffer(dec, &pf, snap, st->main_size) == JXL_DEC_SUCCESS &&
                       JxlDecoderFlushImage(dec) == JXL_DEC_SUCCESS;
        JxlDecoderSetImageOutBuffer(dec, &pf, st->main_data, st->main_size);
        if (flushed) prog_ev_ab = snap_ab;
      }
      if (prog_ev_ab != nullptr) {
        napi_value progress = MakeImageEventWithAB(env, "progress", prog_stage, ev_info, st->format, prog_ev_ab);
        if (st->has_region) AttachRegionEcho(env, progress, region, ev_info);
        if (st->basic.have_animation) {
          napi_set_named_property(env, progress, "frameIndex", MakeUint32(env, st->current_frame_index));
        }
        QueueLiveEvent(env, data, progress);
      }
      if (!st->emit_every_pass && st->target != ProgressionTarget::Final) {
        return StepResult::Done;
      }
      continue;
    }

    if (status == JXL_DEC_FULL_IMAGE) {
      ImageInfo ev_info = st->info;
      napi_value pixels_ab = nullptr;
      napi_get_reference_value(env, st->main_ab_ref, &pixels_ab);
      if (needs_xform) {
        uint32_t dw = 0, dh = 0;
        EffectiveRegion eff;
        if (fused_dims(ev_info, region, ds, &dw, &dh, &eff)) {
          void* outd = nullptr;
          napi_value out_ab;
          napi_create_arraybuffer(env, static_cast<size_t>(dw) * dh * 4u * BytesPerChannel(st->format), &outd, &out_ab);
          if (outd) {
            transform_fused_into(static_cast<const uint8_t*>(st->main_data), ev_info, eff, ds, st->format, static_cast<uint8_t*>(outd));
          }
          pixels_ab = out_ab;
        }
      }

      if (st->basic.have_animation) {
        // Hold this frame back by one. Any previously held frame is now known to
        // be non-terminal -> flush it as "progress". The held frame becomes the
        // terminal "final" at SUCCESS (matching the batch labelling exactly).
        FlushHeldFrameAsProgress(env, data, st);
        napi_create_reference(env, pixels_ab, 1, &st->held_frame_ref);
        st->held_info = ev_info;
        st->held_index = st->current_frame_index;
        st->held_duration = st->current_frame_duration;
        st->held_name = st->current_frame_name;
        st->has_held_frame = true;
        st->current_frame_index++;
        continue;
      }

      // Still image: this FULL_IMAGE is the final.
      napi_value final = MakeImageEventWithAB(env, "final", "final", ev_info, st->format, pixels_ab);
      if (st->has_region) AttachRegionEcho(env, final, region, ev_info);
      if (st->decode_extra_channels && !st->ec_planes.empty()) {
        napi_value arr;
        napi_create_array_with_length(env, st->ec_planes.size(), &arr);
        for (size_t i = 0; i < st->ec_planes.size(); ++i) {
          napi_value ab = MakeArrayBuffer(env, st->ec_planes[i].data(), st->ec_planes[i].size());
          napi_set_element(env, arr, static_cast<uint32_t>(i), ab);
        }
        napi_set_named_property(env, final, "extraPlanes", arr);
      }
      QueueLiveEvent(env, data, final);
      st->final_emitted = true;
      continue;
    }
  }
}

// N-20: gate extra channel plane extraction behind opt-in so common RGBA path pays zero.
// Batch reference path (retained). Used as fallback and as the output-equality
// oracle for the live path.
static bool DecodeAll(napi_env env, DecoderData* data, PixelFormatKind format, ProgressionTarget target, bool emit_every_pass, bool decode_extra_channels, const std::string& progressive_detail, const Region* region, uint32_t downsample, bool preserve_icc, uint64_t max_pixels) {
  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (dec == nullptr) return false;

  struct DecGuard {
    JxlDecoder* d;
    ~DecGuard() { if (d) JxlDecoderDestroy(d); }
  };
  DecGuard dec_guard{dec};

#if CASABIO_HAVE_JXL_THREADS
  void* runner = JxlThreadParallelRunnerCreate(nullptr, JxlThreadParallelRunnerDefaultNumWorkerThreads());
  ThreadRunnerGuard runner_guard(runner);
  if (runner) {
    if (JxlDecoderSetParallelRunner(dec, JxlThreadParallelRunner, runner) != JXL_DEC_SUCCESS) {
      // handled
    }
  }
#endif

  int events = JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE | JXL_DEC_FRAME;
  if (preserve_icc) {
    events |= JXL_DEC_COLOR_ENCODING;
  }
  if (emit_every_pass || target == ProgressionTarget::Dc || target == ProgressionTarget::Pass) {
    events |= JXL_DEC_FRAME_PROGRESSION;
  }
  if (JxlDecoderSubscribeEvents(dec, events) != JXL_DEC_SUCCESS) {
    return false;
  }

  // N-11: map progressiveDetail (or fallback from emit/target) to the correct JxlProgressiveDetail.
  JxlProgressiveDetail jd = kDC;
  if (progressive_detail == "lastPasses") jd = kLastPasses;
  else if (progressive_detail == "passes") jd = kPasses;
  else if (progressive_detail == "dcProgressive") jd = kDCProgressive;
  else if (emit_every_pass || target == ProgressionTarget::Pass) jd = kLastPasses;
  if (events & JXL_DEC_FRAME_PROGRESSION) {
    JxlDecoderSetProgressiveDetail(dec, jd);
  }

  if (data->pinned_input != nullptr) {
    JxlDecoderSetInput(dec, static_cast<const uint8_t*>(data->pinned_data), data->pinned_size);
  } else {
    JxlDecoderSetInput(dec, data->input.data(), data->input.size());
  }
  JxlDecoderCloseInput(dec);

  JxlBasicInfo basic;
  memset(&basic, 0, sizeof(basic));
  ImageInfo info;
  bool info_known = false;
  JxlPixelFormat pf = {4, DataTypeForFormat(format), JXL_NATIVE_ENDIAN, 0};

  // N-20: per-EC plane storage (populated at NEED_IMAGE_OUT_BUFFER when gated)
  std::vector<std::vector<uint8_t>> ec_planes;

  // N-12/N-13: main decode target as napi AB (direct write for final when no xform)
  napi_value main_ab = nullptr;
  void* main_data = nullptr;
  size_t main_size = 0;
  bool had_region = (region != nullptr);
  uint32_t ds = (downsample >= 1 && downsample <= 8) ? downsample : 1u;
  uint32_t bytes_per_pixel = 4u * BytesPerChannel(format);

  bool header_emitted = false;
  std::vector<uint8_t> icc_bytes;

  auto emit_header = [&]() {
    if (header_emitted) return;
    napi_value header = MakeHeaderEvent(env, info);
    if (!icc_bytes.empty()) {
      napi_value icc_ab = MakeArrayBuffer(env, icc_bytes.data(), icc_bytes.size());
      napi_set_named_property(env, header, "iccProfile", icc_ab);
    }
    data->events.push_back(RefValue(env, header));
    header_emitted = true;
  };

  struct DecodedFrame {
    napi_value pixels_ab;
    ImageInfo info;
    uint32_t duration = 0;
    std::string name;
    uint32_t index = 0;
  };
  std::vector<DecodedFrame> decoded_frames;
  uint32_t current_frame_index = 0;
  uint32_t current_frame_duration = 0;
  std::string current_frame_name;

  for (;;) {
    JxlDecoderStatus status = JxlDecoderProcessInput(dec);
    if (status == JXL_DEC_ERROR) {
      ThrowCode(env, "InvalidJXL", "libjxl decode error (DEC_ERROR)");
      return false;
    }
    if (status == JXL_DEC_NEED_MORE_INPUT) {
      // After CloseInput this means truncated input (N-19)
      ThrowCode(env, "TruncatedInput", "libjxl decode truncated (NEED_MORE_INPUT after close)");
      return false;
    }
    if (status == JXL_DEC_SUCCESS) break;
    
    if (status == JXL_DEC_BASIC_INFO) {
      if (JxlDecoderGetBasicInfo(dec, &basic) != JXL_DEC_SUCCESS) {
        return false;
      }

      // 1.6 Decompression-bomb guard
      uint64_t px = static_cast<uint64_t>(basic.xsize) * basic.ysize;
      if (px > max_pixels) {
        ThrowCode(env, "ImageTooLarge", "image exceeds maxPixels");
        return false;
      }

      info.width = basic.xsize;
      info.height = basic.ysize;
      info.bits_per_sample = BitsForFormat(format);
      info.has_alpha = basic.alpha_bits > 0;
      info.has_animation = basic.have_animation;
      info.jpeg_reconstruction_available = false;

      uint32_t n_ec = basic.num_extra_channels;
      for (uint32_t i = 0; i < n_ec; ++i) {
        JxlExtraChannelInfo ei{};
        if (JxlDecoderGetExtraChannelInfo(dec, i, &ei) == JXL_DEC_SUCCESS) {
          ImageInfo::DecodedExtra d{};
          d.type = JxlExtraTypeName(ei.type);
          d.bits_per_sample = ei.bits_per_sample;
          d.dim_shift = ei.dim_shift;
          if (ei.type == JXL_CHANNEL_SPOT_COLOR) {
            d.has_spot = true;
            d.spot_r = ei.spot_color[0];
            d.spot_g = ei.spot_color[1];
            d.spot_b = ei.spot_color[2];
            d.spot_solidity = ei.spot_color[3];
          }
          if (ei.name_length > 0) {
            std::vector<char> nm(ei.name_length + 1, '\0');
            if (JxlDecoderGetExtraChannelName(dec, i, nm.data(), nm.size()) == JXL_DEC_SUCCESS) {
              d.name.assign(nm.data(), ei.name_length);
            }
          }
          info.extra_channels.push_back(d);
        }
      }

      if (decode_extra_channels && n_ec > 0) {
        ec_planes.assign(n_ec, std::vector<uint8_t>());
      }

      info_known = true;
      if (!preserve_icc) {
        emit_header();
        if (target == ProgressionTarget::Header) {
          return true;
        }
      }
      continue;
    }

    if (status == JXL_DEC_COLOR_ENCODING) {
      size_t icc_size = 0;
      if (JxlDecoderGetICCProfileSize(dec, JXL_COLOR_PROFILE_TARGET_DATA, &icc_size) == JXL_DEC_SUCCESS && icc_size > 0) {
        icc_bytes.resize(icc_size);
        if (JxlDecoderGetColorAsICCProfile(dec, JXL_COLOR_PROFILE_TARGET_DATA, icc_bytes.data(), icc_size) != JXL_DEC_SUCCESS) {
          icc_bytes.clear();
        }
      }
      emit_header();
      if (target == ProgressionTarget::Header) {
        return true;
      }
      continue;
    }

    if (status == JXL_DEC_FRAME) {
      if (basic.have_animation) {
        JxlFrameHeader fh;
        if (JxlDecoderGetFrameHeader(dec, &fh) == JXL_DEC_SUCCESS) {
          current_frame_duration = fh.duration;
          current_frame_name.clear();
          if (fh.name_length > 0) {
            std::vector<char> fnm(fh.name_length + 1, '\0');
            if (JxlDecoderGetFrameName(dec, fnm.data(), fnm.size()) == JXL_DEC_SUCCESS) {
              current_frame_name.assign(fnm.data(), fh.name_length);
            }
          }
        }
      }
      continue;
    }

    if (status == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      emit_header();
      size_t buffer_size = 0;
      if (JxlDecoderImageOutBufferSize(dec, &pf, &buffer_size) != JXL_DEC_SUCCESS) {
        return false;
      }
      napi_create_arraybuffer(env, buffer_size, &main_data, &main_ab);
      main_size = buffer_size;
      if (JxlDecoderSetImageOutBuffer(dec, &pf, main_data, main_size) != JXL_DEC_SUCCESS) {
        return false;
      }
      if (decode_extra_channels && !ec_planes.empty()) {
        for (uint32_t i = 0; i < ec_planes.size(); ++i) {
          uint32_t bps = (i < info.extra_channels.size() && info.extra_channels[i].bits_per_sample)
                             ? info.extra_channels[i].bits_per_sample : 8u;
          JxlDataType dt = (bps == 16) ? JXL_TYPE_UINT16 : (bps > 16 ? JXL_TYPE_FLOAT : JXL_TYPE_UINT8);
          JxlPixelFormat pf_ec = {1, dt, JXL_NATIVE_ENDIAN, 0};
          size_t ec_size = 0;
          if (JxlDecoderExtraChannelBufferSize(dec, &pf_ec, &ec_size, i) == JXL_DEC_SUCCESS && ec_size > 0) {
            ec_planes[i].resize(ec_size);
            JxlDecoderSetExtraChannelBuffer(dec, &pf_ec, ec_planes[i].data(), ec_size, i);
          }
        }
      }
      continue;
    }

    if (status == JXL_DEC_FRAME_PROGRESSION && info_known && main_ab != nullptr) {
      emit_header();
      const char* prog_stage = (target == ProgressionTarget::Dc) ? "dc" : "pass";
      napi_value prog_ev_ab = nullptr;
      ImageInfo ev_info = info;
      bool needs_xform = had_region || (ds > 1u);
      if (needs_xform) {
        void* snap = nullptr;
        napi_value snap_ab;
        napi_create_arraybuffer(env, main_size, &snap, &snap_ab);
        bool flushed = JxlDecoderSetImageOutBuffer(dec, &pf, snap, main_size) == JXL_DEC_SUCCESS &&
                       JxlDecoderFlushImage(dec) == JXL_DEC_SUCCESS;
        JxlDecoderSetImageOutBuffer(dec, &pf, main_data, main_size);
        if (flushed) {
          uint32_t dw = 0, dh = 0;
          EffectiveRegion eff;
          if (fused_dims(ev_info, region, ds, &dw, &dh, &eff)) {
            void* outd = nullptr;
            napi_value out_ab;
            napi_create_arraybuffer(env, static_cast<size_t>(dw) * dh * 4u * BytesPerChannel(format), &outd, &out_ab);
            if (outd) {
              transform_fused_into(static_cast<const uint8_t*>(snap), ev_info, eff, ds, format, static_cast<uint8_t*>(outd));
            }
            prog_ev_ab = out_ab;
          }
        }
      } else {
        void* snap = nullptr;
        napi_value snap_ab;
        napi_create_arraybuffer(env, main_size, &snap, &snap_ab);
        bool flushed = JxlDecoderSetImageOutBuffer(dec, &pf, snap, main_size) == JXL_DEC_SUCCESS &&
                       JxlDecoderFlushImage(dec) == JXL_DEC_SUCCESS;
        JxlDecoderSetImageOutBuffer(dec, &pf, main_data, main_size);
        if (flushed) {
          prog_ev_ab = snap_ab;
        }
      }
      if (prog_ev_ab != nullptr) {
        napi_value progress = MakeImageEventWithAB(env, "progress", prog_stage, ev_info, format, prog_ev_ab);
        if (had_region) {
          napi_value rgn;
          napi_create_object(env, &rgn);
          // NV-21 Region echo
          napi_set_named_property(env, rgn, "x", MakeUint32(env, region->x));
          napi_set_named_property(env, rgn, "y", MakeUint32(env, region->y));
          napi_set_named_property(env, rgn, "w", MakeUint32(env, ev_info.width));
          napi_set_named_property(env, rgn, "h", MakeUint32(env, ev_info.height));
          napi_set_named_property(env, progress, "region", rgn);
        }
        if (basic.have_animation) {
          // Progression events during animation carry no frameIndex; stage is labeled "pass" even under progressiveDetail: "dcProgressive".
          // Leave stage labeling as-is with this comment.
          napi_set_named_property(env, progress, "frameIndex", MakeUint32(env, current_frame_index));
        }
        data->events.push_back(RefValue(env, progress));
      }
      if (!emit_every_pass && target != ProgressionTarget::Final) {
        return true;
      }
      continue;
    }

    if (status == JXL_DEC_FULL_IMAGE) {
      if (basic.have_animation) {
        ImageInfo ev_info = info;
        napi_value frame_pixels_ab = main_ab;
        bool needs_xform = had_region || (ds > 1u);
        if (needs_xform) {
          uint32_t dw = 0, dh = 0;
          EffectiveRegion eff;
          if (fused_dims(ev_info, region, ds, &dw, &dh, &eff)) {
            void* outd = nullptr;
            napi_value out_ab;
            napi_create_arraybuffer(env, static_cast<size_t>(dw) * dh * 4u * BytesPerChannel(format), &outd, &out_ab);
            if (outd) {
              transform_fused_into(static_cast<const uint8_t*>(main_data), ev_info, eff, ds, format, static_cast<uint8_t*>(outd));
            }
            frame_pixels_ab = out_ab;
          }
        } else {
          // 1.1: Eliminate redundant per-frame copy in animation path
          // main_ab is already a unique per-frame AB (NEED_IMAGE_OUT_BUFFER reallocates each frame).
          frame_pixels_ab = main_ab;
        }

        DecodedFrame df;
        df.pixels_ab = frame_pixels_ab;
        df.info = ev_info;
        df.duration = current_frame_duration;
        df.name = current_frame_name;
        df.index = current_frame_index;
        decoded_frames.push_back(df);

        current_frame_index++;
      }
      continue;
    }
  }

  emit_header();

  if (basic.have_animation) {
    if (decoded_frames.empty()) return false;
    for (size_t i = 0; i < decoded_frames.size() - 1; ++i) {
      const auto& df = decoded_frames[i];
      napi_value ev = MakeImageEventWithAB(env, "progress", "progress", df.info, format, df.pixels_ab);
      napi_set_named_property(env, ev, "frameIndex", MakeUint32(env, df.index));
      napi_set_named_property(env, ev, "frameDuration", MakeUint32(env, df.duration));
      if (!df.name.empty()) {
        napi_set_named_property(env, ev, "frameName", MakeString(env, df.name.c_str()));
      }
      if (had_region) {
        napi_value rgn;
        napi_create_object(env, &rgn);
        napi_set_named_property(env, rgn, "x", MakeUint32(env, region->x));
        napi_set_named_property(env, rgn, "y", MakeUint32(env, region->y));
        napi_set_named_property(env, rgn, "w", MakeUint32(env, df.info.width));
        napi_set_named_property(env, rgn, "h", MakeUint32(env, df.info.height));
        napi_set_named_property(env, ev, "region", rgn);
      }
      data->events.push_back(RefValue(env, ev));
    }
    const auto& df = decoded_frames.back();
    napi_value ev = MakeImageEventWithAB(env, "final", "final", df.info, format, df.pixels_ab);
    napi_set_named_property(env, ev, "frameIndex", MakeUint32(env, df.index));
    napi_set_named_property(env, ev, "frameDuration", MakeUint32(env, df.duration));
    if (!df.name.empty()) {
      napi_set_named_property(env, ev, "frameName", MakeString(env, df.name.c_str()));
    }
    double tps_den = basic.animation.tps_denominator > 0 ? static_cast<double>(basic.animation.tps_denominator) : 1.0;
    double tps = static_cast<double>(basic.animation.tps_numerator) / tps_den;
    if (tps <= 0.0) tps = 1.0;
    napi_value tps_val;
    napi_create_double(env, tps, &tps_val);
    napi_set_named_property(env, ev, "animTicksPerSecond", tps_val);
    if (had_region) {
      napi_value rgn;
      napi_create_object(env, &rgn);
      napi_set_named_property(env, rgn, "x", MakeUint32(env, region->x));
      napi_set_named_property(env, rgn, "y", MakeUint32(env, region->y));
      napi_set_named_property(env, rgn, "w", MakeUint32(env, df.info.width));
      napi_set_named_property(env, rgn, "h", MakeUint32(env, df.info.height));
      napi_set_named_property(env, ev, "region", rgn);
    }
    data->events.push_back(RefValue(env, ev));
    return true;
  }

  if (main_ab == nullptr) return false;

  ImageInfo ev_info = info;
  napi_value final_pixels_ab = main_ab;
  bool needs_xform = had_region || (ds > 1u);
  if (needs_xform) {
    uint32_t dw = 0, dh = 0;
    EffectiveRegion eff;
    if (fused_dims(ev_info, region, ds, &dw, &dh, &eff)) {
      void* outd = nullptr;
      napi_value out_ab;
      napi_create_arraybuffer(env, static_cast<size_t>(dw) * dh * 4u * BytesPerChannel(format), &outd, &out_ab);
      if (outd) {
        transform_fused_into(static_cast<const uint8_t*>(main_data), ev_info, eff, ds, format, static_cast<uint8_t*>(outd));
      }
      final_pixels_ab = out_ab;
    }
  }
  napi_value final = MakeImageEventWithAB(env, "final", "final", ev_info, format, final_pixels_ab);
  if (had_region) {
    napi_value rgn;
    napi_create_object(env, &rgn);
    napi_set_named_property(env, rgn, "x", MakeUint32(env, region->x));
    napi_set_named_property(env, rgn, "y", MakeUint32(env, region->y));
    napi_set_named_property(env, rgn, "w", MakeUint32(env, ev_info.width));
    napi_set_named_property(env, rgn, "h", MakeUint32(env, ev_info.height));
    napi_set_named_property(env, final, "region", rgn);
  }
  if (decode_extra_channels && !ec_planes.empty()) {
    napi_value arr;
    napi_create_array_with_length(env, ec_planes.size(), &arr);
    for (size_t i = 0; i < ec_planes.size(); ++i) {
      napi_value ab = MakeArrayBuffer(env, ec_planes[i].data(), ec_planes[i].size());
      napi_set_element(env, arr, static_cast<uint32_t>(i), ab);
    }
    napi_set_named_property(env, final, "extraPlanes", arr);
  }
  data->events.push_back(RefValue(env, final));
  return true;
}

static bool EncodeAll(napi_env env, EncoderData* data, std::vector<uint8_t>* out) {
  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (enc == nullptr) return false;

  struct EncGuard {
    JxlEncoder* e;
    ~EncGuard() { if (e) JxlEncoderDestroy(e); }
  };
  EncGuard enc_guard{enc};

#if CASABIO_HAVE_JXL_THREADS
  void* runner = JxlThreadParallelRunnerCreate(nullptr, JxlThreadParallelRunnerDefaultNumWorkerThreads());
  ThreadRunnerGuard runner_guard(runner);
  if (runner) {
    if (JxlEncoderSetParallelRunner(enc, JxlThreadParallelRunner, runner) != JXL_ENC_SUCCESS) {
      // ignore
    }
  }
#endif

  const uint32_t bits = BitsForFormat(data->format);
  const uint32_t exp_bits = ExponentBitsForFormat(data->format);
  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize = data->width;
  info.ysize = data->height;
  info.bits_per_sample = bits;
  info.exponent_bits_per_sample = exp_bits;
  info.num_color_channels = 3;
  const uint32_t alpha_ec_count = data->has_alpha ? 1u : 0u;
  const uint32_t extra_ec_count = static_cast<uint32_t>(data->extra_channels.size());
  info.num_extra_channels = alpha_ec_count + extra_ec_count;
  info.alpha_bits = data->has_alpha ? bits : 0;
  info.alpha_exponent_bits = data->has_alpha ? exp_bits : 0;
  
  // NV-12 / 3D uses_original_profile check
  if (data->distance == 0.0 || !data->icc.empty() || !data->exif.empty() || !data->xmp.empty() || !data->custom_boxes.empty()) {
    info.uses_original_profile = JXL_TRUE;
  }

  if (data->has_animation && !data->frames.empty()) {
    info.have_animation = JXL_TRUE;
    info.animation.tps_numerator = data->anim_tps_num;
    info.animation.tps_denominator = data->anim_tps_den;
    info.animation.num_loops = data->anim_loops;
  }

  if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) {
    return false;
  }

  // N-17: ICC profile if supplied (wide-gamut masters); else sRGB. Prerequisite for perceptual colour / herbarium fidelity.
  if (!data->icc.empty()) {
    if (JxlEncoderSetICCProfile(enc, data->icc.data(), data->icc.size()) != JXL_ENC_SUCCESS) {
      return false;
    }
  } else {
    JxlColorEncoding color;
    JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
    if (JxlEncoderSetColorEncoding(enc, &color) != JXL_ENC_SUCCESS) {
      return false;
    }
  }

  JxlEncoderFrameSettings* frame = JxlEncoderFrameSettingsCreate(enc, nullptr);
  if (data->distance == 0.0) {
    JxlEncoderSetFrameLossless(frame, JXL_TRUE);
  }
  JxlEncoderSetFrameDistance(frame, static_cast<float>(data->distance));
  if (JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EFFORT, static_cast<int64_t>(data->effort)) != JXL_ENC_SUCCESS) {
    return false;
  }

  // N-18: map progressive:true to frame settings so that decoder can emit progression events for our own encodes.
  if (data->progressive) {
    JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PROGRESSIVE_AC, 1);
    JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_QPROGRESSIVE_AC, 1);
    JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_PROGRESSIVE_DC, 1);
  }
  // previewFirst / chunked remain unimplemented (one-line comments per N-18; silent ignore is the documented gap, not a drop)

  // Escape hatch for advancedFrameSettings (patches etc.)
  if (!data->advanced_setting_ids.empty() &&
      data->advanced_setting_ids.size() == data->advanced_setting_values.size()) {
    for (size_t i = 0; i < data->advanced_setting_ids.size(); ++i) {
      if (JxlEncoderFrameSettingsSetOption(
            frame,
            static_cast<JxlEncoderFrameSettingId>(data->advanced_setting_ids[i]),
            static_cast<int64_t>(data->advanced_setting_values[i])) != JXL_ENC_SUCCESS) {
        return false;
      }
    }
  }

  // Task 5: extra channel setup (info, name, spot, distance) - mirrors bridge.cpp exactly; additive only
  for (uint32_t i = 0; i < extra_ec_count; ++i) {
    const ExtraChannelDesc& ec = data->extra_channels[i];
    uint32_t ec_idx = alpha_ec_count + i;

    // N-22: hoist type lookup (was called twice per EC for spot check)
    JxlExtraChannelType ec_type = JxlExtraTypeFromString(ec.type);
    JxlExtraChannelInfo ec_info;
    JxlEncoderInitExtraChannelInfo(ec_type, &ec_info);
    ec_info.bits_per_sample = ec.bits_per_sample;
    ec_info.exponent_bits_per_sample = (ec.bits_per_sample > 16) ? 8u : 0u;
    ec_info.dim_shift = ec.dim_shift;

    if (ec.has_spot && ec_type == JXL_CHANNEL_SPOT_COLOR) {
      ec_info.spot_color[0] = ec.spot_r;
      ec_info.spot_color[1] = ec.spot_g;
      ec_info.spot_color[2] = ec.spot_b;
      ec_info.spot_color[3] = ec.spot_solidity;
    }

    if (JxlEncoderSetExtraChannelInfo(enc, ec_idx, &ec_info) != JXL_ENC_SUCCESS) {
      return false;
    }

    if (!ec.name.empty()) {
      JxlEncoderSetExtraChannelName(enc, ec_idx, ec.name.c_str(), ec.name.size());
    }

    // NV-8 extra channel distance check (clamped to [0.0, 25.0], fall back to main distance if absent/negative)
    float ch_dist = (ec.distance >= 0.0) ? static_cast<float>(ec.distance) : static_cast<float>(data->distance);
    if (ch_dist < 0.0f) ch_dist = 0.0f;
    if (ch_dist > 25.0f) ch_dist = 25.0f;
    JxlEncoderSetExtraChannelDistance(frame, ec_idx, ch_dist);
  }

  // NV-3 / 3C alpha extra channel distance setup (fall back to main distance if absent/negative)
  if (data->has_alpha) {
    float alpha_dist = (data->alpha_distance >= 0.0) ? static_cast<float>(data->alpha_distance) : static_cast<float>(data->distance);
    if (alpha_dist < 0.0f) alpha_dist = 0.0f;
    if (alpha_dist > 25.0f) alpha_dist = 25.0f;
    JxlEncoderSetExtraChannelDistance(frame, 0, alpha_dist);
  }

  const uint32_t color_channels = 3u + (data->has_alpha ? 1u : 0u);
  JxlPixelFormat pf = {color_channels, DataTypeForFormat(data->format), JXL_NATIVE_ENDIAN, 0};

  // NV-3 / 3E animation encoding support
  if (data->has_animation && !data->frames.empty()) {
    const size_t bpc = BytesPerChannel(data->format);
    const size_t frame_expected = static_cast<size_t>(data->width) * data->height * color_channels * bpc;

    for (size_t fi = 0; fi < data->frames.size(); ++fi) {
      JxlFrameHeader fh;
      JxlEncoderInitFrameHeader(&fh);
      fh.duration = data->frames[fi].duration;
      fh.is_last = (fi + 1 == data->frames.size());
      JxlEncoderSetFrameHeader(frame, &fh);
      if (!data->frames[fi].name.empty()) {
        JxlEncoderSetFrameName(frame, data->frames[fi].name.c_str());
      }
      if (JxlEncoderAddImageFrame(frame, &pf, data->frames[fi].pixels.data(), frame_expected) != JXL_ENC_SUCCESS) {
        return false;
      }
    }
  } else {
    const size_t expected = static_cast<size_t>(data->width) * data->height * color_channels * BytesPerChannel(data->format);
    // NV-14 zero-copy push check
    const uint8_t* pixels_ptr = data->pinned_input ? static_cast<const uint8_t*>(data->pinned_data) : data->pixels.data();
    const size_t pixels_size = data->pinned_input ? data->pinned_size : data->pixels.size();

    if (pixels_size != expected ||
        JxlEncoderAddImageFrame(frame, &pf, pixels_ptr, expected) != JXL_ENC_SUCCESS) {
      return false;
    }
  }

  // Supply extra channel plane buffers (1ch each) if caller provided 'pixels' data via duck-type
  for (uint32_t i = 0; i < extra_ec_count; ++i) {
    const ExtraChannelDesc& ec = data->extra_channels[i];
    if (ec.pixels.empty()) continue;
    uint32_t ec_idx = alpha_ec_count + i;

    JxlDataType dt = (ec.bits_per_sample == 16) ? JXL_TYPE_UINT16 : (ec.bits_per_sample == 32) ? JXL_TYPE_FLOAT : JXL_TYPE_UINT8;
    JxlPixelFormat pf_ec = {1, dt, JXL_NATIVE_ENDIAN, 0};

    if (JxlEncoderSetExtraChannelBuffer(frame, &pf_ec, ec.pixels.data(), ec.pixels.size(), ec_idx) != JXL_ENC_SUCCESS) {
      return false;
    }
  }

  // EXIF + XMP + customBoxes (NV-3 / 3F)
  if (!data->exif.empty() || !data->xmp.empty() || !data->custom_boxes.empty()) {
    JxlEncoderUseBoxes(enc);
    if (!data->exif.empty()) {
      const auto& e = data->exif;
      bool has_prefix = (e.size() >= 4 && e[0] == 0 && e[1] == 0 && e[2] == 0 && e[3] == 0);
      if (has_prefix) {
        JxlEncoderAddBox(enc, "Exif", e.data(), e.size(), JXL_FALSE);
      } else {
        std::vector<uint8_t> prefixed(4 + e.size());
        prefixed[0] = prefixed[1] = prefixed[2] = prefixed[3] = 0;
        if (!e.empty()) memcpy(prefixed.data() + 4, e.data(), e.size());
        JxlEncoderAddBox(enc, "Exif", prefixed.data(), prefixed.size(), JXL_FALSE);
      }
    }
    if (!data->xmp.empty()) {
      JxlEncoderAddBox(enc, "xml ", data->xmp.data(), data->xmp.size(), JXL_FALSE);
    }
    for (const auto& b : data->custom_boxes) {
      JxlEncoderAddBox(enc, b.type.c_str(), b.data.data(), b.data.size(),
                       b.compress ? JXL_TRUE : JXL_FALSE);
    }
    JxlEncoderCloseBoxes(enc);
  }

  JxlEncoderCloseInput(enc);

  // N-21: seed output buffer from heuristic (pixels/10, >=64KiB) to skip most doublings on large encodes.
  // Final MakeArrayBuffer still copies once; chunk-list avoided for simplicity (crosses port once).
  {
    size_t seed = 65536;
    const size_t pixel_bytes = static_cast<size_t>(data->width) * data->height * 4 * BytesPerChannel(data->format);
    if (pixel_bytes > 0) {
      size_t h = pixel_bytes / 10;
      if (h < 65536) h = 65536;
      seed = h;
    }
    out->assign(seed, 0);
  }
  uint8_t* next_out = out->data();
  size_t avail_out = out->size();
  for (;;) {
    JxlEncoderStatus status = JxlEncoderProcessOutput(enc, &next_out, &avail_out);
    if (status == JXL_ENC_SUCCESS) {
      out->resize(static_cast<size_t>(next_out - out->data()));
      return true;
    }
    if (status == JXL_ENC_NEED_MORE_OUTPUT) {
      size_t offset = static_cast<size_t>(next_out - out->data());
      out->resize(out->size() * 2);
      next_out = out->data() + offset;
      avail_out = out->size() - offset;
      continue;
    }
    return false;
  }
}
#endif

#if CASABIO_HAVE_LIBJXL
// Read the decoder options object (_options on the wrapper) into a LiveDecodeState.
static void ReadLiveDecoderOptions(napi_env env, napi_value this_arg, LiveDecodeState* st) {
  napi_value options;
  napi_get_named_property(env, this_arg, "_options", &options);
  st->format = ParsePixelFormat(GetStringProp(env, options, "format", "rgba8"));
  std::string target_str = GetStringProp(env, options, "progressionTarget", "final");
  st->target = ParseProgressionTarget(target_str);
  st->emit_every_pass = GetBoolProp(env, options, "emitEveryPass", false);
  st->decode_extra_channels = GetBoolProp(env, options, "decodeExtraChannels", true);
  st->progressive_detail = GetStringProp(env, options, "progressiveDetail", "");
  st->preserve_icc = GetBoolProp(env, options, "preserveIcc", false);
  st->max_pixels = static_cast<uint64_t>(GetNullableNumberProp(env, options, "maxPixels", static_cast<double>(1u << 28)));

  napi_value regv;
  if (GetProp(env, options, "region", &regv)) {
    napi_valuetype rt;
    napi_typeof(env, regv, &rt);
    if (rt == napi_object) {
      uint32_t x = GetUint32Prop(env, regv, "x", 0);
      uint32_t y = GetUint32Prop(env, regv, "y", 0);
      uint32_t w = GetUint32Prop(env, regv, "w", 0);
      uint32_t h = GetUint32Prop(env, regv, "h", 0);
      if (w > 0 && h > 0) {
        st->region = Region{x, y, w, h};
        st->has_region = true;
      }
    }
  }
  uint32_t downsample = GetUint32Prop(env, options, "downsample", 1);
  if (downsample != 1 && downsample != 2 && downsample != 4 && downsample != 8) downsample = 1;
  st->downsample = downsample;
}

// Create the persistent decoder + parallel runner and subscribe to events.
// Returns false (and queues an error) on failure.
static bool EngageLiveDecoder(napi_env env, DecoderData* data, napi_value this_arg) {
  auto* st = new LiveDecodeState();
  ReadLiveDecoderOptions(env, this_arg, st);

  st->dec = JxlDecoderCreate(nullptr);
  if (st->dec == nullptr) {
    DestroyLiveState(env, st);
    LiveEmitError(env, data, "DecodeFailed", "JxlDecoderCreate failed");
    return false;
  }
#if CASABIO_HAVE_JXL_THREADS
  st->runner = JxlThreadParallelRunnerCreate(nullptr, JxlThreadParallelRunnerDefaultNumWorkerThreads());
  if (st->runner) {
    JxlDecoderSetParallelRunner(st->dec, JxlThreadParallelRunner, st->runner);
  }
#endif

  int events = JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE | JXL_DEC_FRAME;
  if (st->preserve_icc) events |= JXL_DEC_COLOR_ENCODING;
  if (st->emit_every_pass || st->target == ProgressionTarget::Dc || st->target == ProgressionTarget::Pass) {
    events |= JXL_DEC_FRAME_PROGRESSION;
  }
  if (JxlDecoderSubscribeEvents(st->dec, events) != JXL_DEC_SUCCESS) {
    DestroyLiveState(env, st);
    LiveEmitError(env, data, "DecodeFailed", "JxlDecoderSubscribeEvents failed");
    return false;
  }
  JxlProgressiveDetail jd = kDC;
  if (st->progressive_detail == "lastPasses") jd = kLastPasses;
  else if (st->progressive_detail == "passes") jd = kPasses;
  else if (st->progressive_detail == "dcProgressive") jd = kDCProgressive;
  else if (st->emit_every_pass || st->target == ProgressionTarget::Pass) jd = kLastPasses;
  if (events & JXL_DEC_FRAME_PROGRESSION) {
    JxlDecoderSetProgressiveDetail(st->dec, jd);
  }

  data->live_state = st;
  data->live = true;
  return true;
}
#endif  // CASABIO_HAVE_LIBJXL

// push(bytes): append input, process as far as possible (emitting events), and
// return a Promise. The Promise resolves immediately unless the bounded event
// queue is full and no consumer is draining, in which case it parks until the
// consumer drains (backpressure — the producer STOPS accepting more work).
static napi_value DecoderPush(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_value this_arg = nullptr;
  void* raw = nullptr;
  napi_get_cb_info(env, info, &argc, args, &this_arg, &raw);
  auto* data = static_cast<DecoderData*>(raw);
  if (data == nullptr || argc < 1) return Throw(env, "decoder.push requires bytes");
  if (data->closed) return Throw(env, "decoder is already closed");
  if (data->cancelled) return Throw(env, "decoder is cancelled");

#if CASABIO_HAVE_LIBJXL
  if (!data->live && data->live_state == nullptr) {
    if (!EngageLiveDecoder(env, data, this_arg)) {
      // Error already queued + stream not yet terminal; mark done so consumers
      // draining events() see the error then completion.
      FinishLiveStream(env, data);
      return ResolveImmediate(env, Undefined(env));
    }
  }
  LiveDecodeState* st = data->live_state;

  // Append the pushed bytes to the pending buffer. We copy here (bytes may be a
  // transient view); the pending buffer owns the unconsumed suffix that libjxl
  // retains between ProcessInput calls.
  if (st->input_set) {
    // libjxl still holds a pointer into `pending`; release it before mutating.
    size_t remaining = JxlDecoderReleaseInput(st->dec);
    st->input_set = false;
    if (remaining < st->pending.size()) {
      st->pending.erase(st->pending.begin(),
                        st->pending.begin() + (st->pending.size() - remaining));
    }
  }
  size_t before = st->pending.size();
  if (!ReadBytes(env, args[0], &st->pending)) {
    return Throw(env, "decoder.push expects ArrayBuffer or Uint8Array");
  }
  (void)before;

  // Process as far as possible. This may queue header/progress/final events.
  if (!data->done && !data->errored) {
    StepResult r = ProcessDecodeAvailable(env, data, st);
    if (r == StepResult::Error || r == StepResult::Done) {
      FinishLiveStream(env, data);
    }
  }

  // Backpressure: if the undrained queue depth is at/over the HWM and no waiter
  // is currently draining, park the push() promise until the consumer drains.
  size_t undrained = data->events.size() - data->events_head;
  if (!data->done && undrained >= kLiveEventHwm) {
    napi_deferred deferred;
    napi_value promise;
    napi_create_promise(env, &deferred, &promise);
    // Only one producer promise parked at a time; resolve any stale one.
    if (data->backpressure != nullptr) {
      napi_deferred stale = data->backpressure;
      data->backpressure = nullptr;
      napi_value undef; napi_get_undefined(env, &undef);
      napi_resolve_deferred(env, stale, undef);
    }
    data->backpressure = deferred;
    return promise;
  }
  return ResolveImmediate(env, Undefined(env));
#else
  return Throw(env, "jxl-native was built without libjxl headers");
#endif
}

static napi_value DecoderClose(napi_env env, napi_callback_info info) {
  void* raw = nullptr;
  napi_value this_arg;
  napi_get_cb_info(env, info, nullptr, nullptr, &this_arg, &raw);
  auto* data = static_cast<DecoderData*>(raw);
  if (data == nullptr) return Throw(env, "decoder is invalid");
  if (data->closed) return ResolveImmediate(env, Undefined(env));
  data->closed = true;

  // NV-11: Honor cancel at close.
  if (data->cancelled) {
    std::vector<uint8_t>().swap(data->input);
    release_pinned_decoder(env, data);
    ReleaseLiveState(env, data);
    FinishLiveStream(env, data);
    return ResolveImmediate(env, Undefined(env));
  }

#if CASABIO_HAVE_LIBJXL
  // If no bytes were ever pushed, engage now so we can surface a clean error.
  if (!data->live && data->live_state == nullptr) {
    if (!EngageLiveDecoder(env, data, this_arg)) {
      FinishLiveStream(env, data);
      release_pinned_decoder(env, data);
      return ThrowCode(env, "DecodeFailed", "libjxl decode failed (internal)");
    }
  }
  LiveDecodeState* st = data->live_state;

  // Close libjxl input and process to completion.
  if (!data->done && !data->errored) {
    st->input_closed = true;
    if (st->input_set) {
      // Input pointer already active on `pending` -> close in place.
      JxlDecoderCloseInput(st->dec);
    }
    // If input_set is false, ProcessDecodeAvailable re-runs SetInput and then
    // applies CloseInput because input_closed is now true.
    StepResult r = ProcessDecodeAvailable(env, data, st);
    // If we still need more input after CloseInput, that is a truncated stream;
    // ProcessDecodeAvailable already queued a TruncatedInput error in that case.
    FinishLiveStream(env, data);

    // N-14: input bytes are no longer needed once decoding is finalized.
    std::vector<uint8_t>().swap(st->pending);

    if (r == StepResult::Error || data->errored) {
      // Surface the terminal error to the close() promise as a rejection, while
      // the error event also remains observable via events(). Carry the true
      // code+message (e.g. "image exceeds maxPixels", "TruncatedInput").
      release_pinned_decoder(env, data);
      return RejectWithLiveError(env, data);
    }
  } else if (data->errored) {
    // Already errored during push; reject close() too for symmetry.
    release_pinned_decoder(env, data);
    return RejectWithLiveError(env, data);
  }

  release_pinned_decoder(env, data);
  return ResolveImmediate(env, Undefined(env));
#else
  FinishLiveStream(env, data);
  return Throw(env, "jxl-native was built without libjxl headers");
#endif
}

static napi_value DecoderEvents(napi_env env, napi_callback_info info) {
  void* raw = nullptr;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &raw);
  auto* data = static_cast<DecoderData*>(raw);
  if (data == nullptr) return Throw(env, "decoder is invalid");
  // Live iterator drains DecoderData::events as it grows (incremental).
  return MakeLiveIterator(env, data);
}

static napi_value DecoderCancel(napi_env env, napi_callback_info info) {
  void* raw = nullptr;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &raw);
  auto* data = static_cast<DecoderData*>(raw);
  if (data != nullptr) {
    data->cancelled = true;
    // Tear down the persistent decoder promptly; no further events will be
    // produced. Already-queued events remain observable, then the iterator ends.
    ReleaseLiveState(env, data);
    std::vector<uint8_t>().swap(data->input);
    release_pinned_decoder(env, data);
    FinishLiveStream(env, data);
  }
  return ResolveImmediate(env, Undefined(env));
}

static napi_value DecoderDispose(napi_env env, napi_callback_info info) {
  void* raw = nullptr;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &raw);
  auto* data = static_cast<DecoderData*>(raw);
  if (data != nullptr) {
    // Release every strong event ref (queued but undrained AND already drained).
    for (napi_ref ref : data->events) napi_delete_reference(env, ref);
    data->events.clear();
    data->events_head = 0;
    // Resolve any parked promises so awaiting JS does not hang after dispose.
    if (data->pending_next != nullptr) {
      napi_deferred d = data->pending_next; data->pending_next = nullptr;
      napi_resolve_deferred(env, d, MakeDoneResult(env));
    }
    if (data->backpressure != nullptr) {
      napi_deferred d = data->backpressure; data->backpressure = nullptr;
      napi_value undef; napi_get_undefined(env, &undef);
      napi_resolve_deferred(env, d, undef);
    }
    data->done = true;
    ReleaseLiveState(env, data);
    std::vector<uint8_t>().swap(data->input); // NV-9 real release
    release_pinned_decoder(env, data);
  }
  return ResolveImmediate(env, Undefined(env));
}

static void release_pinned(napi_env env, EncoderData* data) {
  if (data->pinned_input != nullptr) {
    napi_delete_reference(env, data->pinned_input);
    data->pinned_input = nullptr;
    data->pinned_data = nullptr;
    data->pinned_size = 0;
  }
}

static napi_value EncoderPushPixels(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  void* raw = nullptr;
  napi_get_cb_info(env, info, &argc, args, nullptr, &raw);
  auto* data = static_cast<EncoderData*>(raw);
  if (data == nullptr || argc < 1) return Throw(env, "encoder.pushPixels requires bytes");
  if (data->finished) return Throw(env, "encoder is already finished");
  if (data->cancelled) return Throw(env, "encoder is cancelled");

  // NV-14: zero-copy single-push fast path
  if (!data->multi_push && data->pinned_input == nullptr) {
    void* input_buf_ptr = nullptr;
    size_t input_buf_len = 0;
    bool parsed = false;
    bool is_ta = false;
    napi_is_typedarray(env, args[0], &is_ta);
    if (is_ta) {
      napi_value ab;
      size_t offset = 0;
      size_t length = 0;
      napi_typedarray_type type;
      if (napi_get_typedarray_info(env, args[0], &type, &length, &input_buf_ptr, &ab, &offset) == napi_ok) {
        size_t el_size = 1;
        if (type == napi_int16_array || type == napi_uint16_array) el_size = 2;
        else if (type == napi_int32_array || type == napi_uint32_array || type == napi_float32_array) el_size = 4;
        else if (type == napi_float64_array) el_size = 8;
        input_buf_len = length * el_size;
        parsed = true;
      }
    } else {
      if (napi_get_arraybuffer_info(env, args[0], &input_buf_ptr, &input_buf_len) == napi_ok) {
        parsed = true;
      }
    }
    
    if (parsed && input_buf_ptr != nullptr && input_buf_len > 0) {
      napi_create_reference(env, args[0], 1, &data->pinned_input);
      data->pinned_data = input_buf_ptr;
      data->pinned_size = input_buf_len;
      return Undefined(env);
    }
  }

  // Fallback or second push:
  data->multi_push = true;
  if (data->pinned_input != nullptr) {
    data->pixels.assign(static_cast<uint8_t*>(data->pinned_data), static_cast<uint8_t*>(data->pinned_data) + data->pinned_size);
    napi_delete_reference(env, data->pinned_input);
    data->pinned_input = nullptr;
    data->pinned_data = nullptr;
    data->pinned_size = 0;
  }

  if (!ReadBytes(env, args[0], &data->pixels)) return Throw(env, "encoder.pushPixels expects ArrayBuffer or Uint8Array");
  return Undefined(env);
}

static napi_value EncoderFinish(napi_env env, napi_callback_info info) {
  void* raw = nullptr;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &raw);
  auto* data = static_cast<EncoderData*>(raw);
  if (data == nullptr) return Throw(env, "encoder is invalid");
  if (data->finished) return Undefined(env);
  data->finished = true;

  // NV-11: Honor cancel at finish
  if (data->cancelled) {
    release_pinned(env, data);
    std::vector<uint8_t>().swap(data->pixels);
    return ThrowCode(env, "Cancelled", "encoder is cancelled");
  }

#if CASABIO_HAVE_LIBJXL
  // NV-5 / 3A: Pixel size strict check + RGBA strip fast path
  const size_t bpc = BytesPerChannel(data->format);
  const uint32_t ch = 3u + (data->has_alpha ? 1u : 0u);
  const size_t expected = (size_t)data->width * data->height * ch * bpc;

  if (data->has_animation) {
    for (size_t i = 0; i < data->frames.size(); ++i) {
      auto& f = data->frames[i];
      if (f.pixels.size() != expected) {
        const size_t rgba_size = (size_t)data->width * data->height * 4u * bpc;
        if (!data->has_alpha && f.pixels.size() == rgba_size) {
          uint8_t* p = f.pixels.data();
          const size_t px = (size_t)data->width * data->height;
          for (size_t j = 0; j < px; ++j) {
            std::memmove(p + j * 3 * bpc, p + j * 4 * bpc, 3 * bpc);
          }
          f.pixels.resize(expected);
        } else {
          release_pinned(env, data);
          return ThrowCode(env, "PixelSizeMismatch", "Frame pushPixels byte length does not match width*height*channels*bpc");
        }
      }
    }
  } else {
    const size_t actual_size = data->pinned_input ? data->pinned_size : data->pixels.size();
    if (actual_size != expected) {
      const size_t rgba_size = (size_t)data->width * data->height * 4u * bpc;
      if (!data->has_alpha && actual_size == rgba_size) {
        // Fallback from zero copy to copy path so we can strip safely in our own buffer
        if (data->pinned_input) {
          data->pixels.assign(static_cast<uint8_t*>(data->pinned_data), static_cast<uint8_t*>(data->pinned_data) + data->pinned_size);
          napi_delete_reference(env, data->pinned_input);
          data->pinned_input = nullptr;
          data->pinned_data = nullptr;
          data->pinned_size = 0;
        }
        uint8_t* p = data->pixels.data();
        const size_t px = (size_t)data->width * data->height;
        for (size_t i = 0; i < px; ++i) {
          std::memmove(p + i * 3 * bpc, p + i * 4 * bpc, 3 * bpc);
        }
        data->pixels.resize(expected);
      } else {
        release_pinned(env, data);
        return ThrowCode(env, "PixelSizeMismatch", "pushPixels byte length does not match width*height*channels*bpc");
      }
    }
  }

  std::vector<uint8_t> out;
  bool ok = EncodeAll(env, data, &out);
  release_pinned(env, data); // release ref immediately
  if (!ok) return ThrowCode(env, "EncodeFailed", "libjxl encode failed");

  napi_value chunk = MakeArrayBuffer(env, out.data(), out.size());
  data->chunks.push_back(RefValue(env, chunk));
  return Undefined(env);
#else
  return Throw(env, "jxl-native was built without libjxl headers");
#endif
}

static napi_value EncoderChunks(napi_env env, napi_callback_info info) {
  void* raw = nullptr;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &raw);
  auto* data = static_cast<EncoderData*>(raw);
  if (data == nullptr) return Throw(env, "encoder is invalid");
  return MakeIterator(env, data->chunks);
}

static napi_value EncoderCancel(napi_env env, napi_callback_info info) {
  void* raw = nullptr;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &raw);
  auto* data = static_cast<EncoderData*>(raw);
  if (data != nullptr) data->cancelled = true;
  return Undefined(env);
}

static napi_value EncoderDispose(napi_env env, napi_callback_info info) {
  void* raw = nullptr;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &raw);
  auto* data = static_cast<EncoderData*>(raw);
  if (data != nullptr) {
    for (napi_ref ref : data->chunks) napi_delete_reference(env, ref);
    data->chunks.clear();
    release_pinned(env, data);
    // NV-9: release capacities with swap
    std::vector<uint8_t>().swap(data->pixels);
    std::vector<uint8_t>().swap(data->icc);
    std::vector<uint8_t>().swap(data->exif);
    std::vector<uint8_t>().swap(data->xmp);
    std::vector<ExtraChannelDesc>().swap(data->extra_channels);
    std::vector<EncoderData::CustomBoxDesc>().swap(data->custom_boxes);
    std::vector<EncoderData::FrameDesc>().swap(data->frames);
  }
  return Undefined(env);
}

static void DecoderFinalize(napi_env env, void* raw, void*) {
  auto* data = static_cast<DecoderData*>(raw);
  if (data == nullptr) return;
  // GC/teardown path. Release all event refs (drained + undrained), the
  // persistent live decoder, and any pinned input. We deliberately do NOT
  // resolve parked napi_deferred here: the object is only finalized once it is
  // unreachable from JS, so no awaiting consumer can still be observing those
  // promises, and resolving a deferred during env teardown is unsafe. Normal
  // teardown goes through dispose()/close()/cancel(), which resolve them.
  for (napi_ref ref : data->events) napi_delete_reference(env, ref);
  data->events.clear();
  ReleaseLiveState(env, data);
  if (data->pinned_input != nullptr) {
    napi_delete_reference(env, data->pinned_input);
    data->pinned_input = nullptr;
  }
  delete data;
}

static void EncoderFinalize(napi_env env, void* raw, void*) {
  auto* data = static_cast<EncoderData*>(raw);
  if (data == nullptr) return;
  for (napi_ref ref : data->chunks) napi_delete_reference(env, ref);
  if (data->pinned_input != nullptr) {
    napi_delete_reference(env, data->pinned_input);
  }
  delete data;
}

static void SetMethod(napi_env env, napi_value object, const char* name, napi_callback cb, void* data) {
  napi_value fn;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, data, &fn);
  napi_set_named_property(env, object, name, fn);
}

static napi_value Version(napi_env env, napi_callback_info) {
  // N-16: append runtime libjxl version (maj*1e6 + min*1e3 + patch) for diagnosability.
  // Static prefix kept for semver of the binding itself.
#if CASABIO_HAVE_LIBJXL
  uint32_t v = JxlDecoderVersion();
  char buf[64];
  // snprintf is available; keep simple.
  int n = snprintf(buf, sizeof(buf), "0.1.0-libjxl+%u.%u.%u", v / 1000000u, (v / 1000u) % 1000u, v % 1000u);
  if (n > 0 && n < (int)sizeof(buf)) return MakeString(env, buf);
#endif
  return MakeString(env, "0.1.0-libjxl");
}

static napi_value Probe(napi_env env, napi_callback_info) {
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "loaded", MakeBool(env, CASABIO_HAVE_LIBJXL == 1));
  // N-16: return a path-like identifier (not the literal phrase) so upper layers see a module-ish "path".
  // Real fs path to the .node is resolved in index.ts loadNativeBinding (candidate that succeeded).
  napi_set_named_property(env, result, "path", MakeString(env, CASABIO_HAVE_LIBJXL ? "jxl-native.node" : "libjxl unavailable"));
  return result;
}

static napi_value CreateDecoder(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) return Throw(env, "createDecoder requires options");
  auto* data = new DecoderData();
  napi_value object;
  napi_create_object(env, &object);
  napi_wrap(env, object, data, DecoderFinalize, nullptr, nullptr);
  napi_set_named_property(env, object, "_options", args[0]);
  SetMethod(env, object, "push", DecoderPush, data);
  SetMethod(env, object, "close", DecoderClose, data);
  SetMethod(env, object, "events", DecoderEvents, data);
  SetMethod(env, object, "cancel", DecoderCancel, data);
  SetMethod(env, object, "dispose", DecoderDispose, data);
  return object;
}

static napi_value CreateEncoder(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1) return Throw(env, "createEncoder requires options");

  auto* data = new EncoderData();
  data->format = ParsePixelFormat(GetStringProp(env, args[0], "format", "rgba8"));
  data->width = GetUint32Prop(env, args[0], "width", 0);
  data->height = GetUint32Prop(env, args[0], "height", 0);
  data->has_alpha = GetBoolProp(env, args[0], "hasAlpha", true);
  double quality = GetNullableNumberProp(env, args[0], "quality", -1.0);
#if CASABIO_HAVE_LIBJXL
  double default_distance = (quality < 0.0) ? 1.0
      : static_cast<double>(JxlEncoderDistanceFromQuality(static_cast<float>(quality)));
#else
  double default_distance = (quality >= 100.0) ? 0.0 : 1.0;
#endif
  
  // NV-20 distance clamp [0.0, 25.0]
  data->distance = GetNullableNumberProp(env, args[0], "distance", default_distance);
  if (data->distance < 0.0) data->distance = 0.0;
  if (data->distance > 25.0) data->distance = 25.0;

  // NV-20 effort clamp [1, 9]
  data->effort = GetUint32Prop(env, args[0], "effort", 7);
  if (data->effort < 1) data->effort = 1;
  if (data->effort > 9) data->effort = 9;

  // N-17: read declared metadata/ICC buffers (nulls mean absent). Use GetProp to avoid MakeString temps (N-22).
  napi_value iccv, exifv, xmpv;
  if (GetProp(env, args[0], "iccProfile", &iccv)) {
    napi_valuetype t; napi_typeof(env, iccv, &t);
    if (t != napi_null && t != napi_undefined) {
      std::vector<uint8_t> buf;
      if (ReadBytes(env, iccv, &buf)) data->icc = std::move(buf);
    }
  }
  if (GetProp(env, args[0], "exif", &exifv)) {
    napi_valuetype t; napi_typeof(env, exifv, &t);
    if (t != napi_null && t != napi_undefined) {
      std::vector<uint8_t> buf;
      if (ReadBytes(env, exifv, &buf)) data->exif = std::move(buf);
    }
  }
  if (GetProp(env, args[0], "xmp", &xmpv)) {
    napi_valuetype t; napi_typeof(env, xmpv, &t);
    if (t != napi_null && t != napi_undefined) {
      std::vector<uint8_t> buf;
      if (ReadBytes(env, xmpv, &buf)) data->xmp = std::move(buf);
    }
  }

  data->progressive = GetBoolProp(env, args[0], "progressive", false);

  // Parse advancedFrameSettings escape hatch (array of {id, value})
  napi_value adv;
  if (GetProp(env, args[0], "advancedFrameSettings", &adv)) {
    bool is_array = false;
    napi_is_array(env, adv, &is_array);
    if (is_array) {
      uint32_t len = 0;
      napi_get_array_length(env, adv, &len);
      if (len > 0) {
        std::vector<int32_t> ids(len);
        std::vector<int32_t> values(len);
        for (uint32_t i = 0; i < len; ++i) {
          napi_value item;
          napi_get_element(env, adv, i, &item);
          ids[i] = GetInt32Prop(env, item, "id", 0);
          values[i] = GetInt32Prop(env, item, "value", 0);
        }
        data->advanced_setting_ids = std::move(ids);
        data->advanced_setting_values = std::move(values);
      }
    }
  }

  // Task 5: parse extraChannels array (additive, 0-EC unchanged). Supports descriptors + optional 'pixels' for plane data (duck-type for native higher-level, preserves ExtraChannel TS shape for parity).
  napi_value ec_arr;
  if (GetProp(env, args[0], "extraChannels", &ec_arr)) {
    bool is_array = false;
    napi_is_array(env, ec_arr, &is_array);
    if (is_array) {
      uint32_t len = 0;
      napi_get_array_length(env, ec_arr, &len);
      data->extra_channels.reserve(len);
      for (uint32_t i = 0; i < len; ++i) {
        napi_value item;
        napi_get_element(env, ec_arr, i, &item);
        ExtraChannelDesc d;
        d.type = GetStringProp(env, item, "type", "unknown");
        d.bits_per_sample = GetUint32Prop(env, item, "bitsPerSample", 8);
        d.dim_shift = GetUint32Prop(env, item, "dimShift", 0);
        d.name = GetStringProp(env, item, "name", "");
        d.distance = GetNullableNumberProp(env, item, "distance", -1.0);

        napi_value spotv;
        if (GetProp(env, item, "spotColor", &spotv)) {
          napi_valuetype st;
          napi_typeof(env, spotv, &st);
          if (st == napi_object) {
            d.has_spot = true;
            d.spot_r = static_cast<float>(GetNullableNumberProp(env, spotv, "red", 0.0));
            d.spot_g = static_cast<float>(GetNullableNumberProp(env, spotv, "green", 0.0));
            d.spot_b = static_cast<float>(GetNullableNumberProp(env, spotv, "blue", 0.0));
            d.spot_solidity = static_cast<float>(GetNullableNumberProp(env, spotv, "solidity", 0.0));
          }
        }

        napi_value datav;
        if (GetProp(env, item, "pixels", &datav) || GetProp(env, item, "data", &datav)) {
          napi_valuetype dt;
          napi_typeof(env, datav, &dt);
          if (dt != napi_null && dt != napi_undefined) {
            std::vector<uint8_t> plane;
            if (ReadBytes(env, datav, &plane)) {
              d.pixels = std::move(plane);
            }
          }
        }

        data->extra_channels.push_back(std::move(d));
      }
    }
  }

  // NV-3 / 3C alphaDistance
  data->alpha_distance = GetNullableNumberProp(env, args[0], "alphaDistance", -1.0);
  if (data->alpha_distance >= 0.0) {
    if (data->alpha_distance > 25.0) data->alpha_distance = 25.0;
  }

  // NV-3 / 3E animation encode options
  napi_value anim;
  if (GetProp(env, args[0], "animation", &anim)) {
    napi_valuetype t;
    napi_typeof(env, anim, &t);
    if (t == napi_object) {
      data->has_animation = true;
      double tps = GetNullableNumberProp(env, anim, "ticksPerSecond", 1.0);
      if (tps <= 0.0) tps = 1.0;
      data->anim_tps_num = static_cast<uint32_t>(tps * 1000.0 + 0.5);
      data->anim_tps_den = 1000;
      int32_t loops = static_cast<int32_t>(GetNullableNumberProp(env, anim, "loopCount", 0.0));
      if (loops < 0) loops = 0;
      if (loops > 65535) loops = 65535;
      data->anim_loops = loops;
    }
  }

  napi_value frames_arr;
  if (GetProp(env, args[0], "frames", &frames_arr)) {
    bool is_array = false;
    napi_is_array(env, frames_arr, &is_array);
    if (is_array) {
      data->has_animation = true;
      uint32_t len = 0;
      napi_get_array_length(env, frames_arr, &len);
      data->frames.reserve(len);
      for (uint32_t i = 0; i < len; ++i) {
        napi_value item;
        napi_get_element(env, frames_arr, i, &item);
        EncoderData::FrameDesc fd;
        int32_t dur = static_cast<int32_t>(GetNullableNumberProp(env, item, "duration", 1.0));
        if (dur <= 0) dur = 1;
        fd.duration = static_cast<uint32_t>(dur);
        fd.name = GetStringProp(env, item, "name", "");
        napi_value fdatav;
        if (GetProp(env, item, "data", &fdatav)) {
          ReadBytes(env, fdatav, &fd.pixels);
        }
        data->frames.push_back(std::move(fd));
      }
    }
  }

  // NV-3 / 3F customBoxes
  napi_value cb_arr;
  if (GetProp(env, args[0], "customBoxes", &cb_arr)) {
    bool is_array = false;
    napi_is_array(env, cb_arr, &is_array);
    if (is_array) {
      uint32_t len = 0;
      napi_get_array_length(env, cb_arr, &len);
      data->custom_boxes.reserve(len);
      for (uint32_t i = 0; i < len; ++i) {
        napi_value item;
        napi_get_element(env, cb_arr, i, &item);
        EncoderData::CustomBoxDesc cb;
        cb.type = GetStringProp(env, item, "type", "");
        if (cb.type.size() != 4) {
          release_pinned(env, data);
          delete data;
          return ThrowCode(env, "InvalidBoxType", "custom box type must be exactly 4 characters");
        }
        cb.compress = GetBoolProp(env, item, "compress", false);
        napi_value bdatav;
        if (GetProp(env, item, "data", &bdatav)) {
          ReadBytes(env, bdatav, &cb.data);
        }
        data->custom_boxes.push_back(std::move(cb));
      }
    }
  }

  napi_value object;
  napi_create_object(env, &object);
  napi_wrap(env, object, data, EncoderFinalize, nullptr, nullptr);
  SetMethod(env, object, "pushPixels", EncoderPushPixels, data);
  SetMethod(env, object, "finish", EncoderFinish, data);
  SetMethod(env, object, "chunks", EncoderChunks, data);
  SetMethod(env, object, "cancel", EncoderCancel, data);
  SetMethod(env, object, "dispose", EncoderDispose, data);
  return object;
}

static napi_value Init(napi_env env, napi_value exports) {
  SetMethod(env, exports, "version", Version, nullptr);
  SetMethod(env, exports, "probe", Probe, nullptr);
  SetMethod(env, exports, "createDecoder", CreateDecoder, nullptr);
  SetMethod(env, exports, "createEncoder", CreateEncoder, nullptr);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
