// Copyright (c) the JPEG XL Project Authors. All rights reserved.
//
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

// Compile-gated decode-path cycle accounting (JXL_DEC_TRANSFORM_STATS builds
// only; zero footprint otherwise). Scoped RDTSC accumulators over the entropy
// stack: histogram/table setup vs the per-pixel modular decode tracks. Dumps
// to stderr at process exit. Diagnostic tooling, never shipped enabled.

#ifndef LIB_JXL_CASA_PROF_H_
#define LIB_JXL_CASA_PROF_H_

#ifdef JXL_DEC_TRANSFORM_STATS

#include <atomic>
#include <cinttypes>
#include <cstdint>
#include <cstdio>

#if defined(_MSC_VER)
#include <intrin.h>
#else
#include <x86intrin.h>
#endif

namespace jxl {
namespace casa_prof {

enum Scope : int {
  kDecHistograms = 0,   // DecodeHistograms total (incl. everything below)
  kHuffReadStream,      // HuffmanDecodingData::ReadFromBitStream (incl. build)
  kHuffTableBuild,      // BuildJxlHuffmanTable proper
  kAnsReaderCreate,     // ANSSymbolReader::Create (alias tables)
  kMaansFastestFill,    // MAANS track: single-symbol fill
  kMaansFastZero,       // MAANS track: Zero predictor token loop
  kMaansGradRle,        // MAANS track: fjxl Gradient+RLE
  kMaansGradVeryFast,   // MAANS track: Gradient single-ctx
  kMaansGradLut,        // MAANS track: Gradient LUT
  kMaansWpLut,          // MAANS track: WP LUT
  kMaansSlow,           // MAANS track: generic no-WP tree
  kMaansSlowest,        // MAANS track: generic WP tree
  kNumScopes
};

inline const char* ScopeName(int i) {
  static const char* kNames[kNumScopes] = {
      "DecodeHistograms", "Huff.ReadFromBitStream", "Huff.BuildTable",
      "ANSReader.Create", "maans.fastest_fill", "maans.fast_zero",
      "maans.grad_rle_fjxl", "maans.grad_veryfast", "maans.grad_lut",
      "maans.wp_lut", "maans.slow", "maans.slowest"};
  return kNames[i];
}

struct Counters {
  std::atomic<uint64_t> cycles[kNumScopes];
  std::atomic<uint64_t> calls[kNumScopes];
  std::atomic<uint64_t> prefix_code_sets{0};  // DecodeHistograms w/ prefix
  std::atomic<uint64_t> ans_code_sets{0};     // DecodeHistograms w/ ANS
  std::atomic<uint64_t> maans_pixels{0};      // pixels decoded via MAANS

  ~Counters() {
    uint64_t total_calls = 0;
    for (int i = 0; i < kNumScopes; i++) total_calls += calls[i];
    if (total_calls == 0) return;
    fprintf(stderr, "\n==== casa_prof (cycles) ====\n");
    for (int i = 0; i < kNumScopes; i++) {
      uint64_t cy = cycles[i].load(), n = calls[i].load();
      if (!n) continue;
      fprintf(stderr, "  %-24s calls %8" PRIu64 "  cycles %14" PRIu64
                      "  (%.1f Mcyc, %.0f cyc/call)\n",
              ScopeName(i), n, cy, cy * 1e-6, n ? double(cy) / n : 0.0);
    }
    fprintf(stderr, "  histo sets: prefix %" PRIu64 "  ans %" PRIu64
                    " | maans pixels %" PRIu64 "\n",
            prefix_code_sets.load(), ans_code_sets.load(),
            maans_pixels.load());
    fprintf(stderr, "============================\n");
  }
};

inline Counters& G() {
  static Counters c;
  return c;
}

class ScopeTimer {
 public:
  explicit ScopeTimer(int scope) : scope_(scope), t0_(__rdtsc()) {}
  ~ScopeTimer() {
    G().cycles[scope_].fetch_add(__rdtsc() - t0_, std::memory_order_relaxed);
    G().calls[scope_].fetch_add(1, std::memory_order_relaxed);
  }

 private:
  int scope_;
  uint64_t t0_;
};

}  // namespace casa_prof
}  // namespace jxl

#define CASA_PROF_SCOPE(s) ::jxl::casa_prof::ScopeTimer casa_prof_scope_(s)
#define CASA_PROF_COUNT(field, n) \
  ::jxl::casa_prof::G().field.fetch_add((n), std::memory_order_relaxed)

#else  // !JXL_DEC_TRANSFORM_STATS

#define CASA_PROF_SCOPE(s) \
  do {                     \
  } while (0)
#define CASA_PROF_COUNT(field, n) \
  do {                            \
  } while (0)

#endif  // JXL_DEC_TRANSFORM_STATS

#endif  // LIB_JXL_CASA_PROF_H_
