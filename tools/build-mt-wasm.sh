#!/usr/bin/env bash
# build-mt-wasm.sh — build the threaded (rayon/wasm-bindgen-rayon) RAW-pipeline wasm pkg.
#
# Produces pkg-mt/ : the parallel-wasm build whose tone path (LookRenderer.render →
# process_auto → rayon par_chunks) runs across web-worker threads via a shared
# WebAssembly.Memory. Measured 3.84× over single-thread at 24MP (tools/tone-mt-bench.mjs).
#
# Requires: nightly toolchain + rust-src, wasm32-unknown-unknown, wasm-bindgen-cli
# 0.2.121 (MATCH the wasm-bindgen crate version; install with the MSVC toolchain on
# Windows — the GNU toolchain lacks dlltool: `cargo +stable-x86_64-pc-windows-msvc
# install wasm-bindgen-cli --version 0.2.121`).
#
# The link-arg set is load-bearing — every flag was needed:
#   +atomics,+bulk-memory,+mutable-globals  → threads ABI (also keep +simd128 from
#                                             .cargo/config; env RUSTFLAGS REPLACES it)
#   --shared-memory --max-memory=2G         → shared heap for workers (atomics alone
#                                             produced NON-shared memory)
#   --import-memory                          → wasm-bindgen threads transform asserts
#                                             the memory is imported (main thread makes
#                                             the shared Memory, passes it to workers)
#   --export=__heap_base (+ tls symbols)     → release profile (debug=false,lto=fat)
#                                             strips the name section, so wasm-bindgen
#                                             can't find __heap_base by name — export it
#   -Z build-std=panic_abort,std            → std must be rebuilt with atomics
#
# NOTE: a plain `wasm-pack build` does NOT work here — it runs stable cargo so `-Z`
# is rejected; hence the manual cargo+nightly build + standalone wasm-bindgen.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-pkg-mt}"

# ── Developed-image decode-limit profile (Finding 59) ────────────────────────
# The shared-memory ceiling below is the SAME budget DecodeLimits::wasm() in
# crates/raw-pipeline/src/image_formats.rs is sized against, so keep them in
# lock-step. The wasm limit profile bounds an untrusted TIFF/EXR/JPEG decode to:
#   input  ≤ 256 MiB   (max_input_bytes)
#   output ≤ 512 MiB   (max_output_bytes, decoded RGBA)
# Peak working set (worst case = input + 2×output for the decoder intermediate),
# plus a 256 MiB allocator/worker-stack safety margin, must stay under the heap:
#   256 + 2·512 + 256 = 1536 MiB ≤ 2048 MiB (2 GiB). Verified by
#   `wasm_profile_output_plus_input_plus_scratch_fits_under_two_gib`
#   in crates/raw-pipeline/tests/decode_limits.rs.
WASM_INPUT_MIB=256
WASM_OUTPUT_MIB=512
WASM_SAFETY_MIB=256
WASM_HEAP_MIB=2048
PROJECTED_PEAK_MIB=$(( WASM_INPUT_MIB + 2 * WASM_OUTPUT_MIB + WASM_SAFETY_MIB ))
if (( PROJECTED_PEAK_MIB > WASM_HEAP_MIB )); then
  echo "FATAL: DecodeLimits::wasm() projected peak ${PROJECTED_PEAK_MIB} MiB exceeds" \
       "the ${WASM_HEAP_MIB} MiB shared-memory ceiling — tighten image_formats.rs" >&2
  exit 1
fi
MAXMEM=$(( WASM_HEAP_MIB * 1024 * 1024 ))  # 2 GiB shared-memory ceiling (matches DecodeLimits::wasm)

RUSTFLAGS="-C target-feature=+simd128,+atomics,+bulk-memory,+mutable-globals \
-C link-arg=--shared-memory -C link-arg=--max-memory=${MAXMEM} -C link-arg=--import-memory \
-C link-arg=--export=__heap_base -C link-arg=--export=__tls_base \
-C link-arg=--export=__tls_size -C link-arg=--export=__tls_align \
-C link-arg=--export=__wasm_init_tls" \
  cargo +nightly build --target wasm32-unknown-unknown --release \
    -Z build-std=panic_abort,std --features parallel-wasm --lib

WASM=target/wasm32-unknown-unknown/release/raw_converter_wasm.wasm
"$HOME/.cargo/bin/wasm-bindgen" "$WASM" --out-dir "$OUT" --target web

echo "built $OUT/ (threaded). verify shared memory:"
node -e 'const fs=require("fs");const b=fs.readFileSync("target/wasm32-unknown-unknown/release/raw_converter_wasm.wasm");let p=8;function leb(){let r=0,s=0,x;do{x=b[p++];r|=(x&0x7f)<<s;s+=7;}while(x&0x80);return r>>>0;}while(p<b.length){const id=b[p++];const sz=leb();const e=p+sz;if(id===5){const c=leb();for(let i=0;i<c;i++){const f=leb();const mn=leb();const mx=(f&1)?leb():null;console.log("shared="+!!(f&2)+" max_MB="+(mx?mx*64/1024:null));}}p=e;}'
echo "run: node tools/tone-mt-bench.mjs --mp 24"
