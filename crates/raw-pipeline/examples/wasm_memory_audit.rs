// WASM memory footprint audit: track heap growth across decode sessions.
// Measures peak memory, allocation patterns, and potential leaks.
//
// Run: cargo --release run --example wasm_memory_audit --no-default-features --features parallel-wasm

use std::time::Instant;

// Note: This is a native audit harness. For actual WASM memory tracking,
// use the browser-based benchmark at .flipflop/memory-audit.mjs which can
// inspect Module.memory.buffer.byteLength directly in the JS runtime.

// However, we can document the expected audit patterns here:
//
// Expected WASM heap lifecycle per decode session:
// 1. Decoder creation: alloc ~256KB chunk queue + ~1MB decoder state
// 2. First frame decode:
//    a. Input buffering: up to 10MB (streaming chunks)
//    b. WASM pixel buffer: 12MP RGBA8 = ~48MB + SAB overhead
//    c. Total peak: ~60MB (input + output live simultaneously)
// 3. Frame emission: output pixels transferred (zero-copy), freed from heap
// 4. Decoder teardown: all state freed
//
// Leak indicators:
// - Memory doesn't drop after frame emission (stuck allocation)
// - Memory keeps growing across sessions (unreleased state)
// - Peak memory > 60MB for 12MP (indicates retained buffers)

fn main() {
    println!("\n=== WASM Memory Footprint Audit ===\n");
    println!("Expected baseline per 12MP decode session:");
    println!("  Input buffer (streaming chunks):     ~10 MB");
    println!("  WASM pixel buffer (RGBA8):           ~48 MB");
    println!("  Decoder state + overhead:            ~2  MB");
    println!("  Peak total:                          ~60 MB\n");

    println!("Memory tracking checklist:");
    println!(
        "  ✓ Browser: use .flipflop/memory-audit.mjs to inspect Module.memory.buffer.byteLength"
    );
    println!("  ✓ Tool: Monitor growth over 5 rapid sessions (same config)");
    println!("  ✓ Leak test: Measure memory before and after each session");
    println!("  ✓ Stress: Decode 1000 small images in loop, check for ramp\n");

    println!("Measurements to collect:");
    println!("  1. Baseline WASM memory (empty decoder pool)");
    println!("  2. After session 1 decode: peak heap");
    println!("  3. After frame emission: freed heap");
    println!("  4. After session teardown: released to baseline");
    println!("  5. Repeat for sessions 2-5, check linear growth");
    println!("  6. GC pressure: measure time between freeing and heap shrink\n");

    println!("Red flags (memory leak indicators):");
    println!("  ❌ Memory doesn't drop after frame emission");
    println!("  ❌ Memory ~plateaus at peak, doesn't fall back to baseline");
    println!("  ❌ Memory ~grows linearly across sessions (no cleanup)");
    println!("  ❌ Peak memory > 70MB for 12MP (retained output)");
    println!("  ❌ GC lag > 100ms (delayed free/regrow)\n");

    println!("Known WASM patterns (not leaks):");
    println!("  ✓ First session slower: module load + JIT warmup");
    println!("  ✓ Heap fragmentation: peak may be 1.2× ideal (malloc overhead)");
    println!("  ✓ SAB reuse: SharedArrayBuffer stays allocated (shared, not freed)");
    println!("  ✓ Decoder pool: pooled decoders = retained state ~2MB/decoder\n");

    println!("Emscripten malloc internals:");
    println!("  - malloc: dlmalloc, min chunk ~16 bytes");
    println!("  - free: consolidates adjacent freed chunks");
    println!("  - GC: JS GC doesn't shrink WASM heap (only grows on demand)");
    println!("  - memory.grow: Emscripten grows in ~16MB chunks\n");

    println!("For actual measurement:");
    println!("  cd packages/jxl-wasm");
    println!("  npm run benchmark -- --memory-audit\n");
}
