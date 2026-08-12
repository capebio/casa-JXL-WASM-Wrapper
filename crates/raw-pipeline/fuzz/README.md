# Fuzzing raw-pipeline parsers

libFuzzer targets for every byte-level parser in `raw-pipeline`. These parsers
process untrusted input (camera RAW files, CASV/JXTC container data) and have
accumulated hand-patched overflow guards — exactly the bug class fuzzing
converts from hand-found to machine-found.

## Targets

Eleven targets cover all byte parsers:

| Target | Parser | Feature gate |
|--------|--------|--------------|
| `tiff_parse` | TIFF/ORF IFD walker (`tiff::parse`) | none (pure Rust) |
| `cr2_decode` | Canon CR2 full path (`cr2::decode_bytes`) | none (pure Rust) |
| `dng_decode` | DNG/TIFF IFD + tile/strip parser (`dng::decode_bytes`) | none (pure Rust) |
| `ljpeg_decode` | Lossless-JPEG marker + entropy decoder (`ljpeg`) | none (pure Rust) |
| `decompress` | Olympus ORF Huffman/bit-reader (`decompress::decompress`) | none (pure Rust) |
| `rw2_decode` | Panasonic RW2/Leica RWL DPCM (`panasonic::decode_rw2`) | none (pure Rust) |
| `nef_decode` | Nikon NEF/NRW layouts + 34713 Huffman (`panasonic::decode_nef`) | none (pure Rust) |
| `casv_header` | CASV container header (`casa_video::parse_casv_header`) | `codec` |
| `casv_footer` | CASV frame-index trailer (`casa_video::parse_casv_footer`) | `codec` |
| `casv_audio_box` | CSAU audio box (`casa_video::parse_casv_audio_box`) | `codec` |
| `jxtc_header` | JXTC tiled-container header (`jxl_casadecoder::parse_jxtc_header`) | `codec` |

The four `codec`-gated targets require libjxl (raw-pipeline's `jxl-codec` feature).
They compile to a no-op stub when that feature is absent so `cargo fuzz build`
stays libjxl-free in CI.

## Requirements

- **Linux only.** The MSVC sanitizer runtime on Windows does not support
  libFuzzer's AddressSanitizer/UndefinedBehaviorSanitizer. Do NOT run
  `cargo fuzz` on Windows — use the `fuzz_smoke` test instead (see below).
- Nightly Rust: `rustup toolchain install nightly`
- cargo-fuzz: `cargo install cargo-fuzz`

## Run locally (Linux)

```sh
cd crates/raw-pipeline

# Build the seven pure-Rust parser targets (no libjxl needed):
cargo +nightly fuzz build

# Quick smoke (60 s) to confirm the harness compiles and starts:
cargo +nightly fuzz run tiff_parse -- -max_total_time=60

# 1-hour campaign on all pure-Rust targets (parallelized, 4 libFuzzer jobs each):
for t in tiff_parse cr2_decode dng_decode ljpeg_decode decompress rw2_decode nef_decode; do
  cargo +nightly fuzz run "$t" -- -max_total_time=3600 -jobs=4
done

# Build + run CASV/JXTC targets (requires LIBJXL_SOURCE_DIR + libjxl build env):
cargo +nightly fuzz build --features codec
cargo +nightly fuzz run casv_header --features codec -- -max_total_time=3600
cargo +nightly fuzz run casv_footer --features codec -- -max_total_time=3600
cargo +nightly fuzz run casv_audio_box --features codec -- -max_total_time=3600
cargo +nightly fuzz run jxtc_header --features codec -- -max_total_time=3600
```

## Run via CI

The **verify** workflow (`.github/workflows/verify.yml`) has three fuzz-related jobs:

| Job | When | What |
|-----|------|------|
| `fuzz-build` | Every push to main + every PR | Builds all targets + 20 s smoke on the five pure-Rust targets |
| `fuzz` | Nightly (02:00 UTC) + `workflow_dispatch` | 24 h campaign on each of the five pure-Rust targets (parallelized across matrix runners) |

To trigger a campaign manually: GitHub Actions → verify → Run workflow.

The CASV/JXTC targets are covered by the `fuzz-build` 20 s smoke only (no long
campaign in CI — they require libjxl which is not available on standard runners).

## Reviewing crashes

Crash artifacts are uploaded to GitHub Actions on job failure, named
`fuzz-crashes-<target>-<run-id>`.

To reproduce a crash locally on Linux:

```sh
cd crates/raw-pipeline

# Reproduce a specific crash input:
cargo +nightly fuzz run tiff_parse fuzz/artifacts/tiff_parse/crash-<sha256>

# Or run the full artifact directory to replay all saved crashes:
cargo +nightly fuzz run tiff_parse fuzz/artifacts/tiff_parse/
```

A crash is a genuine parser bug (panic, arithmetic overflow, OOB read via ASan,
or UB via UBSan). File an issue with:
1. The crash input file (from the artifact).
2. The full `cargo fuzz run` output (includes the stack trace).
3. The target name and commit SHA.

## Windows workaround (no nightly sanitizer)

`tests/fuzz_smoke.rs` mirrors each target's harness body and runs the seed corpus
plus deterministic mutations (truncations, bit-flips, byte-sets, PRNG buffers) in
a regular `cargo test` run:

```powershell
# From repo root — runs in debug profile (overflow-trap on):
.\build-msvc.ps1 test --test fuzz_smoke
```

This exercises the same overflow-guard surface as the real libFuzzer targets,
without requiring a nightly sanitizer runtime. A panic here is a real bug.

## Corpus seeds

See `corpus/README.md` for the per-target seed inventory and instructions on
adding + minimizing real camera RAW files via `cargo fuzz cmin`.
