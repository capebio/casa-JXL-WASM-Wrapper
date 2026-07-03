// butter_time.cc — time libjxl ButteraugliInterface on RGBA8 binary dumps.
//
// Usage: butter_time.exe <width> <height> <ref.raw> <test.raw> [reps=7]
//   ref.raw / test.raw  : raw RGBA8 binary (width * height * 4 bytes, sRGB).
//
// Output (stdout): JSON with timing + score.
//
// Compile (from repo root, vcvars + LLVM in PATH):
//   clang-cl.exe /nologo -TP /O2 /Ob2 /std:c++17 -MT /EHsc /W0
//     -DFJXL_ENABLE_AVX512=0 -DJXL_INTERNAL_LIBRARY_BUILD -DJXL_STATIC_DEFINE
//     -D_CRT_SECURE_NO_WARNINGS -DWIN32 -D_WINDOWS
//     "-DHWY_DISABLED_TARGETS=(HWY_AVX3|HWY_AVX3_SPR|HWY_AVX3_ZEN4|HWY_RVV|HWY_SSSE3|HWY_SVE|HWY_SVE_256|HWY_SVE2|HWY_SVE2_128)"
//     -DJPEGXL_ENABLE_SKCMS=1 -DJPEGXL_ENABLE_TRANSCODE_JPEG=1 -DJPEGXL_ENABLE_BOXES=1
//     /I"external/libjxl-012"
//     /I"external/libjxl-012/third_party/highway"
//     /I"external/libjxl-012/third_party/brotli/c/include"
//     /I"bld-libjxl-static/lib/include"
//     bench/butter_time.cc /Fe:bench/butter_time.exe
//     /link "bld-libjxl-static/lib/jxl.lib"
//           "bld-libjxl-static/lib/jxl_cms.lib"
//           "bld-libjxl-static/lib/jxl_threads.lib"
//           "bld-libjxl-static/third_party/highway/hwy.lib"
//           "bld-libjxl-static/third_party/brotli/brotlicommon.lib"
//           "bld-libjxl-static/third_party/brotli/brotlidec.lib"
//           "bld-libjxl-static/third_party/brotli/brotlienc.lib"
//           /SUBSYSTEM:CONSOLE

#include <jxl/memory_manager.h>

#include <algorithm>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <vector>

#include "lib/jxl/base/status.h"
#include "lib/jxl/butteraugli/butteraugli.h"
#include "lib/jxl/image.h"

static void* jxl_alloc(void* /*opaque*/, size_t size) { return malloc(size); }
static void  jxl_free (void* /*opaque*/, void* addr)  { free(addr); }
static JxlMemoryManager g_mm = { nullptr, jxl_alloc, jxl_free };

// sRGB [0,255] → linear [0,1]
static inline float srgb_to_linear(uint8_t v) {
    float s = v * (1.0f / 255.0f);
    if (s <= 0.04045f) return s * (1.0f / 12.92f);
    return std::pow((s + 0.055f) * (1.0f / 1.055f), 2.4f);
}

static std::vector<uint8_t> read_file(const char* path) {
    std::ifstream f(path, std::ios::binary | std::ios::ate);
    if (!f) { fprintf(stderr, "cannot open %s\n", path); exit(1); }
    auto sz = static_cast<size_t>(f.tellg());
    f.seekg(0);
    std::vector<uint8_t> buf(sz);
    f.read(reinterpret_cast<char*>(buf.data()), static_cast<std::streamsize>(sz));
    return buf;
}

static jxl::Image3F rgba8_to_image3f(const uint8_t* src, size_t w, size_t h) {
    auto img_or = jxl::Image3F::Create(&g_mm, w, h);
    assert(img_or.ok());
    jxl::Image3F out = std::move(img_or).value_();
    for (size_t y = 0; y < h; y++) {
        float* JXL_RESTRICT rr = out.PlaneRow(0, y);
        float* JXL_RESTRICT gr = out.PlaneRow(1, y);
        float* JXL_RESTRICT br = out.PlaneRow(2, y);
        const uint8_t* row = src + y * w * 4;
        for (size_t x = 0; x < w; x++) {
            rr[x] = srgb_to_linear(row[x * 4 + 0]);
            gr[x] = srgb_to_linear(row[x * 4 + 1]);
            br[x] = srgb_to_linear(row[x * 4 + 2]);
        }
    }
    return std::move(out);
}

int main(int argc, char** argv) {
    if (argc < 5) {
        fprintf(stderr, "usage: butter_time <width> <height> <ref.raw> <test.raw> [reps]\n");
        return 1;
    }
    const size_t w    = static_cast<size_t>(atoi(argv[1]));
    const size_t h    = static_cast<size_t>(atoi(argv[2]));
    const char*  path0 = argv[3];
    const char*  path1 = argv[4];
    const int    reps  = (argc >= 6) ? atoi(argv[5]) : 7;

    const size_t expected = w * h * 4;
    auto raw0 = read_file(path0);
    auto raw1 = read_file(path1);
    if (raw0.size() != expected || raw1.size() != expected) {
        fprintf(stderr, "expected %zu bytes, got %zu / %zu\n",
                expected, raw0.size(), raw1.size());
        return 1;
    }

    // Build Image3F outside timed section.
    jxl::Image3F ref_img  = rgba8_to_image3f(raw0.data(), w, h);
    jxl::Image3F test_img = rgba8_to_image3f(raw1.data(), w, h);

    jxl::ButteraugliParams params;
    params.hf_asymmetry    = 1.0f;
    params.xmul            = 1.0f;
    params.intensity_target = 80.0f;  // sRGB

    // Warmup: one untimed run.
    {
        jxl::ImageF diffmap;
        double score = 0.0;
        // Need fresh copies since ButteraugliInterfaceInPlace moves them.
        jxl::Image3F r0 = rgba8_to_image3f(raw0.data(), w, h);
        jxl::Image3F r1 = rgba8_to_image3f(raw1.data(), w, h);
        jxl::ButteraugliInterfaceInPlace(std::move(r0), std::move(r1),
                                         params, diffmap, score);
    }

    // Timed reps.
    double last_score = 0.0;
    std::vector<double> times(static_cast<size_t>(reps));
    for (int i = 0; i < reps; i++) {
        jxl::Image3F r0 = rgba8_to_image3f(raw0.data(), w, h);
        jxl::Image3F r1 = rgba8_to_image3f(raw1.data(), w, h);
        jxl::ImageF diffmap;
        double score = 0.0;
        auto t0 = std::chrono::high_resolution_clock::now();
        jxl::ButteraugliInterfaceInPlace(std::move(r0), std::move(r1),
                                         params, diffmap, score);
        auto t1 = std::chrono::high_resolution_clock::now();
        times[static_cast<size_t>(i)] =
            std::chrono::duration<double, std::milli>(t1 - t0).count();
        last_score = score;
    }
    std::sort(times.begin(), times.end());
    double median_ms = times[static_cast<size_t>(reps) / 2];
    double min_ms    = times[0];

    printf("{\"w\":%zu,\"h\":%zu,\"butter_ms\":%.2f,\"butter_min_ms\":%.2f,"
           "\"butter_score\":%.6f,\"reps\":%d}\n",
           w, h, median_ms, min_ms, last_score, reps);
    return 0;
}
