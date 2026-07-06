#![no_main]
//! Fuzz the lossless-JPEG decoder. `probe_tile` parses markers up to SOF (the
//! segment-length overflow surface); if it yields sane, bounded dimensions we
//! then run the entropy decoder via `decode_tile_compact`. Dims are clamped so
//! the target fuzzes the decoder, not the allocator (cargo-fuzz's rss_limit
//! would otherwise flag an attacker-chosen huge SOF as a false "crash").
use libfuzzer_sys::fuzz_target;
use raw_pipeline::ljpeg;

fuzz_target!(|data: &[u8]| {
    let info = match ljpeg::probe_tile(data) {
        Ok(i) => i,
        Err(_) => return,
    };
    let w = info.width as usize;
    let h = info.height as usize;
    let c = info.components.max(1) as usize;
    let px = w.saturating_mul(h).saturating_mul(c);
    // Bound the output buffer: we exercise the entropy decoder, not OOM behaviour.
    if w == 0 || h == 0 || px == 0 || px > (1 << 22) {
        return;
    }
    let mut out = vec![0u16; px];
    // Wrong-sized buffers are rejected internally (Err), never UB — safe to call.
    let _ = ljpeg::decode_tile_compact(data, &mut out, w, h);
});
